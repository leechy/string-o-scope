import {
  FilterSettings,
  getDefaultFilterSettings,
  InstrumentSpec,
  ReferencePitch,
  TelemetryFrame,
} from './types';
import {
  analyzeSpectrumAndPolyphony,
  detectPitchMPM,
  getAdjacentOpenStringIndex,
} from './dsp';
import { midiToFreq } from './music';

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private inputBus: GainNode | null = null;
  private monitorGain: GainNode | null = null;
  private recorderNode: ScriptProcessorNode | null = null;
  private silentSink: GainNode | null = null;

  // Configurable ring buffer duration in seconds (default 60s)
  public maxHistorySeconds = 60;

  // Microphone nodes & Biquad filters
  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micHighPass: BiquadFilterNode | null = null;
  private micLowPass: BiquadFilterNode | null = null;
  public micActive = false;
  public micError: string | null = null;

  // Real-time meters for UI tuning
  public latestRawRms = 0;
  public latestRawClarity = 0;
  public filterSettings: FilterSettings;

  // Median filter & jump suppression buffers
  private medianHistory: number[] = [];
  private octaveJumpCandidateFrames = 0;
  private wasPreviouslySilent = true;
  private prevEmittedMidi = 60;

  // Analysis buffers
  private timeDomainBuf: Float32Array<ArrayBuffer> = new Float32Array(4096);
  private freqDbBuf: Float32Array<ArrayBuffer> = new Float32Array(2048);

  // PCM Audio Ring Buffer
  private pcmRingBuffer: Float32Array | null = null;
  private pcmWriteIndex = 0;
  private pcmTotalSamplesWritten = 0;
  private latestSessionTime = 0;
  public isRecordingBuffer = true;

  // Replay state
  private replaySource: AudioBufferSourceNode | null = null;
  public isReplaying = false;
  private replayAudioStartCtxTime = 0;
  private replayStartSessionTime = 0;
  private replayDuration = 0;
  private onReplayEndedCallback: (() => void) | null = null;

  // Telemetry state & smoothing
  public frames: TelemetryFrame[] = [];
  private lastConfidentMidi: number;
  private smoothedMidi: number;
  private smoothedNoisiness = 0.04;
  private smoothedOpacity = 0.08;
  private confidentHoldCounter = 0;

  private instrument: InstrumentSpec;
  private refA4: ReferencePitch;

  constructor(instrument: InstrumentSpec, refA4: ReferencePitch) {
    this.instrument = instrument;
    this.refA4 = refA4;
    this.filterSettings = getDefaultFilterSettings(instrument.id);
    this.lastConfidentMidi = instrument.strings[1].midi;
    this.smoothedMidi = this.lastConfidentMidi;
    this.prevEmittedMidi = this.lastConfidentMidi;
  }

  public setFilterSettings(settings: FilterSettings): void {
    this.filterSettings = { ...settings };
    this.updateHardwareFilters();
  }

  public updateHardwareFilters(): void {
    if (!this.ctx || !this.micHighPass || !this.micLowPass) return;
    const now = this.ctx.currentTime;
    const hpFreq = this.filterSettings.highPassEnabled ? this.filterSettings.highPassFreq : 10;
    const lpFreq = this.filterSettings.lowPassEnabled ? this.filterSettings.lowPassFreq : 22000;
    this.micHighPass.frequency.setTargetAtTime(Math.max(10, hpFreq), now, 0.015);
    this.micLowPass.frequency.setTargetAtTime(Math.min(22000, lpFreq), now, 0.015);
  }

  public setMaxHistorySeconds(seconds: number): void {
    const clamped = Math.max(10, Math.min(300, seconds));
    if (clamped === this.maxHistorySeconds) return;
    this.maxHistorySeconds = clamped;

    if (this.ctx) {
      const newTotalSamples = Math.ceil(this.ctx.sampleRate * this.maxHistorySeconds);
      const newRing = new Float32Array(newTotalSamples);

      if (this.pcmRingBuffer && this.pcmTotalSamplesWritten > 0) {
        const oldRing = this.pcmRingBuffer;
        const oldLen = oldRing.length;
        const available = Math.min(this.pcmTotalSamplesWritten, oldLen, newTotalSamples);
        let readIdx = (this.pcmWriteIndex - available + oldLen) % oldLen;
        for (let i = 0; i < available; i++) {
          newRing[i] = oldRing[readIdx];
          readIdx = (readIdx + 1) % oldLen;
        }
        this.pcmWriteIndex = available % newTotalSamples;
        this.pcmTotalSamplesWritten = available;
      } else {
        this.pcmWriteIndex = 0;
        this.pcmTotalSamplesWritten = 0;
      }

      this.pcmRingBuffer = newRing;
    }
  }

  public setConfiguration(instrument: InstrumentSpec, refA4: ReferencePitch): void {
    const instrumentChanged = this.instrument.id !== instrument.id;
    this.instrument = instrument;
    this.refA4 = refA4;

    if (instrumentChanged) {
      this.lastConfidentMidi = instrument.strings[1].midi;
      this.smoothedMidi = this.lastConfidentMidi;
      this.prevEmittedMidi = this.lastConfidentMidi;
      this.filterSettings = getDefaultFilterSettings(instrument.id);
      this.updateHardwareFilters();
      this.frames = [];
      this.pcmWriteIndex = 0;
      this.pcmTotalSamplesWritten = 0;
      this.medianHistory = [];
      this.octaveJumpCandidateFrames = 0;
    }

    if (this.analyser) {
      this.analyser.fftSize = instrument.fftSize;
      this.timeDomainBuf = new Float32Array(this.analyser.fftSize);
      this.freqDbBuf = new Float32Array(this.analyser.frequencyBinCount);
    }
  }

  public async ensureContext(): Promise<AudioContext> {
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx({ latencyHint: 'interactive' });

      this.inputBus = this.ctx.createGain();
      this.inputBus.gain.value = 1.0;

      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = this.instrument.fftSize;
      this.analyser.smoothingTimeConstant = 0.15;

      this.timeDomainBuf = new Float32Array(this.analyser.fftSize);
      this.freqDbBuf = new Float32Array(this.analyser.frequencyBinCount);

      this.inputBus.connect(this.analyser);

      // Setup PCM ring buffer
      const totalSamples = Math.ceil(this.ctx.sampleRate * this.maxHistorySeconds);
      this.pcmRingBuffer = new Float32Array(totalSamples);

      // ScriptProcessorNode (2048 buffer) for continuous PCM recording while isRecordingBuffer is true
      this.recorderNode = this.ctx.createScriptProcessor(2048, 1, 1);
      this.silentSink = this.ctx.createGain();
      this.silentSink.gain.value = 0;

      this.recorderNode.onaudioprocess = (ev: AudioProcessingEvent) => {
        if (!this.pcmRingBuffer || !this.isRecordingBuffer) return;
        const input = ev.inputBuffer.getChannelData(0);
        const ringLen = this.pcmRingBuffer.length;
        for (let i = 0; i < input.length; i++) {
          this.pcmRingBuffer[this.pcmWriteIndex] = input[i];
          this.pcmWriteIndex = (this.pcmWriteIndex + 1) % ringLen;
        }
        this.pcmTotalSamplesWritten += input.length;
      };

      this.inputBus.connect(this.recorderNode);
      this.recorderNode.connect(this.silentSink);
      this.silentSink.connect(this.ctx.destination);
    }

    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }

    return this.ctx;
  }

  public async enableMicrophone(): Promise<boolean> {
    try {
      await this.ensureContext();
      if (this.micActive && this.micStream) return true;

      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });

      if (this.ctx && this.inputBus) {
        this.micSource = this.ctx.createMediaStreamSource(this.micStream);

        this.micHighPass = this.ctx.createBiquadFilter();
        this.micHighPass.type = 'highpass';
        this.micHighPass.Q.value = 0.707;

        this.micLowPass = this.ctx.createBiquadFilter();
        this.micLowPass.type = 'lowpass';
        this.micLowPass.Q.value = 0.707;

        this.updateHardwareFilters();

        this.micSource.connect(this.micHighPass);
        this.micHighPass.connect(this.micLowPass);
        this.micLowPass.connect(this.inputBus);

        this.micActive = true;
        this.micError = null;
        return true;
      }
      return false;
    } catch (err) {
      this.micActive = false;
      this.micError = err instanceof Error ? err.message : 'Нет доступа к микрофону';
      return false;
    }
  }

  public disableMicrophone(): void {
    if (this.micSource) {
      try {
        this.micSource.disconnect();
      } catch {
        // ignore
      }
      this.micSource = null;
    }
    if (this.micHighPass) {
      try {
        this.micHighPass.disconnect();
      } catch {
        // ignore
      }
      this.micHighPass = null;
    }
    if (this.micLowPass) {
      try {
        this.micLowPass.disconnect();
      } catch {
        // ignore
      }
      this.micLowPass = null;
    }
    if (this.micStream) {
      for (const track of this.micStream.getTracks()) {
        track.stop();
      }
      this.micStream = null;
    }
    this.micActive = false;
  }

  public sampleLiveFrame(sessionTime: number): TelemetryFrame {
    this.latestSessionTime = sessionTime;

    if (!this.ctx || !this.analyser) {
      return this.createSilentFrame(sessionTime);
    }

    this.analyser.getFloatTimeDomainData(this.timeDomainBuf);
    this.analyser.getFloatFrequencyData(this.freqDbBuf);

    const minFreq = midiToFreq(this.instrument.minMidi, this.refA4);
    const maxFreq = midiToFreq(this.instrument.maxMidi, this.refA4);

    const windowSize = this.instrument.fftSize;
    const rmsGate = this.filterSettings.noiseGateEnabled ? this.filterSettings.noiseGateRms * 0.7 : 0.005;
    const minClarity = Math.max(0.2, this.filterSettings.clarityThreshold * 0.65);

    const pitchRes = detectPitchMPM(
      this.timeDomainBuf,
      this.ctx.sampleRate,
      minFreq,
      maxFreq,
      this.refA4,
      windowSize,
      rmsGate,
      minClarity
    );

    this.latestRawRms = pitchRes.rms;
    this.latestRawClarity = pitchRes.clarity;

    const specRes = analyzeSpectrumAndPolyphony(
      this.freqDbBuf,
      this.ctx.sampleRate,
      this.analyser.fftSize,
      pitchRes.frequency,
      pitchRes.clarity,
      this.instrument,
      this.refA4
    );

    const reqRms = this.filterSettings.noiseGateEnabled ? this.filterSettings.noiseGateRms : 0.005;
    const reqClarity = this.filterSettings.clarityThreshold;

    const inRange =
      pitchRes.midi !== null &&
      pitchRes.midi >= this.instrument.minMidi - 1.5 &&
      pitchRes.midi <= this.instrument.maxMidi + 2;

    const isConfident =
      pitchRes.midi !== null &&
      inRange &&
      pitchRes.rms >= reqRms &&
      pitchRes.clarity >= reqClarity;

    let candidateMidi = pitchRes.midi;

    if (isConfident && candidateMidi !== null) {
      // 1. Octave Jump Rejection
      if (this.filterSettings.octaveJumpRejection && this.confidentHoldCounter >= 2) {
        const diffFromCurrent = candidateMidi - this.smoothedMidi;
        const absDiff = Math.abs(diffFromCurrent);
        const isOctaveOrFifth =
          Math.abs(absDiff - 12) < 0.45 ||
          Math.abs(absDiff - 24) < 0.45 ||
          Math.abs(absDiff - 19) < 0.45;

        if (isOctaveOrFifth) {
          this.octaveJumpCandidateFrames++;
          // Require at least 4 consecutive frames before accepting an octave leap
          if (this.octaveJumpCandidateFrames < 4) {
            candidateMidi = this.smoothedMidi;
          } else {
            this.octaveJumpCandidateFrames = 0;
          }
        } else {
          this.octaveJumpCandidateFrames = 0;
        }
      } else {
        this.octaveJumpCandidateFrames = 0;
      }

      // 2. Median Filter
      if (this.filterSettings.medianFilterFrames > 1) {
        this.medianHistory.push(candidateMidi);
        if (this.medianHistory.length > this.filterSettings.medianFilterFrames) {
          this.medianHistory.shift();
        }
        if (this.medianHistory.length >= 3) {
          const sorted = [...this.medianHistory].sort((a, b) => a - b);
          candidateMidi = sorted[Math.floor(sorted.length / 2)];
        }
      } else {
        this.medianHistory = [];
      }

      // 3. Temporal Smoothing
      if (this.confidentHoldCounter === 0) {
        this.smoothedMidi = candidateMidi;
      } else {
        const diff = candidateMidi - this.smoothedMidi;
        if (Math.abs(diff) > 2.0) {
          this.smoothedMidi = candidateMidi;
        } else {
          this.smoothedMidi += diff * 0.46;
        }
      }
      this.confidentHoldCounter++;
      if (this.confidentHoldCounter >= 2) {
        this.lastConfidentMidi = this.smoothedMidi;
      }

      this.smoothedOpacity += (1.0 - this.smoothedOpacity) * 0.35;
    } else {
      this.confidentHoldCounter = 0;
      this.medianHistory = [];
      this.octaveJumpCandidateFrames = 0;
      this.smoothedOpacity += (0.08 - this.smoothedOpacity) * 0.22;
    }

    const isSilent = this.confidentHoldCounter === 0;
    const activeMidi = isSilent ? this.lastConfidentMidi : this.smoothedMidi;

    // Discontinuity detection for avoiding diagonal streaks across the screen
    let isDiscontinuous = false;
    if (this.filterSettings.breakLineOnLeap) {
      if (this.wasPreviouslySilent && !isSilent) {
        isDiscontinuous = true;
      } else if (
        !isSilent &&
        Math.abs(activeMidi - this.prevEmittedMidi) > this.filterSettings.maxContinuousLeapMidi
      ) {
        isDiscontinuous = true;
      }
    }
    this.wasPreviouslySilent = isSilent;
    this.prevEmittedMidi = activeMidi;

    const targetNoisiness = specRes.noisiness;
    this.smoothedNoisiness += (targetNoisiness - this.smoothedNoisiness) * 0.3;

    const secondaryMidi = isSilent ? null : specRes.secondaryMidi;
    const secondaryRms = isSilent ? 0 : specRes.secondaryRms;
    const secondaryStringIndex = isSilent ? null : specRes.secondaryStringIndex;

    const nearestMidi = Math.round(activeMidi);
    const centsOffset = (activeMidi - nearestMidi) * 100;

    const frame: TelemetryFrame = {
      time: sessionTime,
      primaryMidi: activeMidi,
      frozenMidi: this.lastConfidentMidi,
      isSilent,
      isDiscontinuous,
      opacity: Math.max(0.07, Math.min(1.0, this.smoothedOpacity)),
      clarity: isSilent ? 0 : pitchRes.clarity,
      noisiness: isSilent ? 0 : Math.max(0, Math.min(1, this.smoothedNoisiness)),
      rms: pitchRes.rms,
      centsOffset,
      nearestMidi,
      secondaryMidi,
      secondaryRms,
      secondaryStringIndex,
    };

    this.pushFrame(frame);
    return frame;
  }

  private createSilentFrame(sessionTime: number): TelemetryFrame {
    this.smoothedOpacity += (0.08 - this.smoothedOpacity) * 0.22;
    const nearestMidi = Math.round(this.lastConfidentMidi);
    const frame: TelemetryFrame = {
      time: sessionTime,
      primaryMidi: this.lastConfidentMidi,
      frozenMidi: this.lastConfidentMidi,
      isSilent: true,
      opacity: Math.max(0.07, Math.min(1.0, this.smoothedOpacity)),
      clarity: 0,
      noisiness: 0,
      rms: 0,
      centsOffset: (this.lastConfidentMidi - nearestMidi) * 100,
      nearestMidi,
      secondaryMidi: null,
      secondaryRms: 0,
      secondaryStringIndex: null,
    };
    this.pushFrame(frame);
    return frame;
  }

  private pushFrame(frame: TelemetryFrame): void {
    this.frames.push(frame);
    const minKeepTime = frame.time - this.maxHistorySeconds - 2;
    const maxFrames = Math.ceil(this.maxHistorySeconds * 65);
    while (
      this.frames.length > maxFrames ||
      (this.frames.length > 0 && this.frames[0].time < minKeepTime)
    ) {
      this.frames.shift();
    }
  }

  public getHistoryBounds(): { minTime: number; maxTime: number; duration: number } {
    if (this.frames.length === 0) {
      return { minTime: 0, maxTime: 0, duration: 0 };
    }
    const maxTime = this.frames[this.frames.length - 1].time;
    const minTime = Math.max(this.frames[0].time, maxTime - this.maxHistorySeconds);
    return { minTime, maxTime, duration: Math.max(0, maxTime - minTime) };
  }

  /**
   * Starts recorded PCM audio playback from `startSessionTime` up to the latest recorded time.
   */
  public async startRecordedPlayback(
    startSessionTime: number,
    onEnded?: () => void
  ): Promise<boolean> {
    this.stopRecordedPlayback();
    await this.ensureContext();
    if (!this.ctx || !this.pcmRingBuffer || this.pcmTotalSamplesWritten === 0) {
      return false;
    }

    const sr = this.ctx.sampleRate;
    const ringLen = this.pcmRingBuffer.length;
    const availableDuration = Math.min(
      this.maxHistorySeconds,
      this.pcmTotalSamplesWritten / sr
    );
    const earliestAvailableTime = this.latestSessionTime - availableDuration;

    const clampedStart = Math.max(
      earliestAvailableTime,
      Math.min(this.latestSessionTime - 0.08, startSessionTime)
    );
    const playDuration = this.latestSessionTime - clampedStart;
    if (playDuration <= 0.05) return false;

    const numSamplesToPlay = Math.min(ringLen, Math.floor(playDuration * sr));
    const samplesAgo = Math.min(ringLen, Math.floor((this.latestSessionTime - clampedStart) * sr));

    const playBuffer = this.ctx.createBuffer(1, numSamplesToPlay, sr);
    const outChan = playBuffer.getChannelData(0);

    let readIndex = (this.pcmWriteIndex - samplesAgo + ringLen) % ringLen;
    for (let i = 0; i < numSamplesToPlay; i++) {
      outChan[i] = this.pcmRingBuffer[readIndex];
      readIndex = (readIndex + 1) % ringLen;
    }

    const fadeSamples = Math.min(Math.floor(sr * 0.012), Math.floor(numSamplesToPlay / 4));
    for (let i = 0; i < fadeSamples; i++) {
      const g = i / fadeSamples;
      outChan[i] *= g;
      outChan[numSamplesToPlay - 1 - i] *= g;
    }

    const source = this.ctx.createBufferSource();
    source.buffer = playBuffer;

    const replayGain = this.ctx.createGain();
    replayGain.gain.value = 0.9;
    source.connect(replayGain);
    replayGain.connect(this.ctx.destination);

    this.replaySource = source;
    this.isReplaying = true;
    this.replayAudioStartCtxTime = this.ctx.currentTime;
    this.replayStartSessionTime = clampedStart;
    this.replayDuration = playDuration;
    this.onReplayEndedCallback = onEnded ?? null;

    source.onended = () => {
      if (this.replaySource === source) {
        this.isReplaying = false;
        this.replaySource = null;
        if (this.onReplayEndedCallback) {
          this.onReplayEndedCallback();
        }
      }
    };

    source.start();
    return true;
  }

  /**
   * Stops playback and returns the exact session time where playback stopped (for pause without reset).
   */
  public stopRecordedPlayback(): number | null {
    const pausedAt = this.getCurrentReplaySessionTime();
    if (this.replaySource) {
      try {
        this.replaySource.onended = null;
        this.replaySource.stop();
        this.replaySource.disconnect();
      } catch {
        // ignore
      }
      this.replaySource = null;
    }
    this.isReplaying = false;
    return pausedAt;
  }

  public getCurrentReplaySessionTime(): number | null {
    if (!this.isReplaying || !this.ctx) return null;
    const elapsed = this.ctx.currentTime - this.replayAudioStartCtxTime;
    return Math.min(
      this.replayStartSessionTime + this.replayDuration,
      this.replayStartSessionTime + elapsed
    );
  }
}
