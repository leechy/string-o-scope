import {
  InstrumentSpec,
  ReferencePitch,
  SimulatorState,
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

  // Microphone nodes
  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  public micActive = false;
  public micError: string | null = null;

  // Simulator nodes
  private simMasterGain: GainNode | null = null;
  private simPrimaryOsc: OscillatorNode | null = null;
  private simPrimaryFilter: BiquadFilterNode | null = null;
  private simPrimaryGain: GainNode | null = null;
  private simVibratoOsc: OscillatorNode | null = null;
  private simVibratoGain: GainNode | null = null;

  private simNoiseSource: AudioBufferSourceNode | null = null;
  private simNoiseFilter: BiquadFilterNode | null = null;
  private simNoiseGain: GainNode | null = null;

  private simSecondaryOsc: OscillatorNode | null = null;
  private simSecondaryFilter: BiquadFilterNode | null = null;
  private simSecondaryGain: GainNode | null = null;

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
    this.lastConfidentMidi = instrument.strings[1].midi;
    this.smoothedMidi = this.lastConfidentMidi;
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
      this.frames = [];
      this.pcmWriteIndex = 0;
      this.pcmTotalSamplesWritten = 0;
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

      this.setupSimulatorNodes(this.ctx);
    }

    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }

    return this.ctx;
  }

  private setupSimulatorNodes(ctx: AudioContext): void {
    if (!this.inputBus) return;

    this.simMasterGain = ctx.createGain();
    this.simMasterGain.gain.value = 0;

    this.monitorGain = ctx.createGain();
    this.monitorGain.gain.value = 0.18;

    this.simMasterGain.connect(this.inputBus);
    this.simMasterGain.connect(this.monitorGain);
    this.monitorGain.connect(ctx.destination);

    // 1. Primary bowed string synth
    this.simPrimaryOsc = ctx.createOscillator();
    this.simPrimaryOsc.type = 'sawtooth';
    this.simPrimaryOsc.frequency.value = midiToFreq(this.instrument.strings[2].midi, this.refA4);

    this.simVibratoOsc = ctx.createOscillator();
    this.simVibratoOsc.type = 'sine';
    this.simVibratoOsc.frequency.value = 5.6;

    this.simVibratoGain = ctx.createGain();
    this.simVibratoGain.gain.value = 0;
    this.simVibratoOsc.connect(this.simVibratoGain);
    this.simVibratoGain.connect(this.simPrimaryOsc.frequency);

    this.simPrimaryFilter = ctx.createBiquadFilter();
    this.simPrimaryFilter.type = 'lowpass';
    this.simPrimaryFilter.frequency.value = 3600;
    this.simPrimaryFilter.Q.value = 1.2;

    this.simPrimaryGain = ctx.createGain();
    this.simPrimaryGain.gain.value = 0.35;

    this.simPrimaryOsc.connect(this.simPrimaryFilter);
    this.simPrimaryFilter.connect(this.simPrimaryGain);
    this.simPrimaryGain.connect(this.simMasterGain);

    // 2. Bow noise / rosin scratch generator
    const noiseLen = ctx.sampleRate * 3;
    const noiseBuffer = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
    const noiseData = noiseBuffer.getChannelData(0);
    for (let i = 0; i < noiseLen; i++) {
      const mod = 0.75 + 0.25 * Math.sin(i * 0.013) * Math.cos(i * 0.0037);
      noiseData[i] = (Math.random() * 2 - 1) * mod;
    }

    this.simNoiseSource = ctx.createBufferSource();
    this.simNoiseSource.buffer = noiseBuffer;
    this.simNoiseSource.loop = true;

    this.simNoiseFilter = ctx.createBiquadFilter();
    this.simNoiseFilter.type = 'bandpass';
    this.simNoiseFilter.frequency.value = 2100;
    this.simNoiseFilter.Q.value = 0.55;

    this.simNoiseGain = ctx.createGain();
    this.simNoiseGain.gain.value = 0;

    this.simNoiseSource.connect(this.simNoiseFilter);
    this.simNoiseFilter.connect(this.simNoiseGain);
    this.simNoiseGain.connect(this.simMasterGain);

    // 3. Secondary open-string leak oscillator
    this.simSecondaryOsc = ctx.createOscillator();
    this.simSecondaryOsc.type = 'sawtooth';
    this.simSecondaryOsc.frequency.value = midiToFreq(this.instrument.strings[1].midi, this.refA4);

    this.simSecondaryFilter = ctx.createBiquadFilter();
    this.simSecondaryFilter.type = 'lowpass';
    this.simSecondaryFilter.frequency.value = 2800;

    this.simSecondaryGain = ctx.createGain();
    this.simSecondaryGain.gain.value = 0;

    this.simSecondaryOsc.connect(this.simSecondaryFilter);
    this.simSecondaryFilter.connect(this.simSecondaryGain);
    this.simSecondaryGain.connect(this.simMasterGain);

    this.simPrimaryOsc.start();
    this.simVibratoOsc.start();
    this.simNoiseSource.start();
    this.simSecondaryOsc.start();
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
        this.micSource.connect(this.inputBus);
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
    if (this.micStream) {
      for (const track of this.micStream.getTracks()) {
        track.stop();
      }
      this.micStream = null;
    }
    this.micActive = false;
  }

  public updateSimulatorAudio(sim: SimulatorState): void {
    if (!this.ctx || !this.simMasterGain) return;
    const now = this.ctx.currentTime;

    const shouldPlay = sim.enabled && sim.playing && this.isRecordingBuffer && !this.isReplaying;
    this.simMasterGain.gain.setTargetAtTime(shouldPlay ? 1.0 : 0.0, now, 0.015);

    if (this.monitorGain) {
      const vol = sim.monitorAudible ? (sim.monitorVolume / 100) * 0.25 : 0;
      this.monitorGain.gain.setTargetAtTime(vol, now, 0.02);
    }

    if (!sim.enabled) return;

    const exactMidi = sim.targetMidi + sim.centsOffset / 100;
    const primaryFreq = midiToFreq(exactMidi, this.refA4);

    if (this.simPrimaryOsc) {
      const scratchJitter =
        sim.bowNoise > 35
          ? (Math.random() - 0.5) * ((sim.bowNoise - 35) / 65) * (primaryFreq * 0.004)
          : 0;
      this.simPrimaryOsc.frequency.setTargetAtTime(
        Math.max(25, primaryFreq + scratchJitter),
        now,
        0.012
      );
    }

    if (this.simVibratoGain) {
      const vibHz = primaryFreq * (Math.pow(2, sim.vibrato / 1200) - 1);
      this.simVibratoGain.gain.setTargetAtTime(vibHz, now, 0.02);
    }

    if (this.simNoiseGain && this.simPrimaryFilter) {
      const noiseNorm = Math.max(0, Math.min(1, sim.bowNoise / 100));
      const noiseGainVal = Math.pow(noiseNorm, 1.25) * 0.48;
      this.simNoiseGain.gain.setTargetAtTime(noiseGainVal, now, 0.015);

      const cutoff = 3200 + noiseNorm * 4500;
      this.simPrimaryFilter.frequency.setTargetAtTime(cutoff, now, 0.02);
    }

    if (this.simSecondaryOsc && this.simSecondaryGain) {
      const leakNorm = Math.max(0, Math.min(1, sim.secondStringLeak / 100));
      const secStringIdx =
        sim.secondStringIndex >= 0 && sim.secondStringIndex < 4
          ? sim.secondStringIndex
          : getAdjacentOpenStringIndex(this.instrument, sim.targetMidi);
      const secString = this.instrument.strings[secStringIdx];
      const secFreq = midiToFreq(secString.midi, this.refA4);

      this.simSecondaryOsc.frequency.setTargetAtTime(secFreq, now, 0.015);
      this.simSecondaryGain.gain.setTargetAtTime(leakNorm * 0.3, now, 0.015);
    }
  }

  public sampleLiveFrame(sessionTime: number, sim: SimulatorState): TelemetryFrame {
    this.latestSessionTime = sessionTime;

    if (!this.ctx || !this.analyser) {
      return this.createSilentFrame(sessionTime);
    }

    this.analyser.getFloatTimeDomainData(this.timeDomainBuf);
    this.analyser.getFloatFrequencyData(this.freqDbBuf);

    const minFreq = midiToFreq(this.instrument.minMidi, this.refA4);
    const maxFreq = midiToFreq(this.instrument.maxMidi, this.refA4);

    const windowSize = this.instrument.fftSize;
    const pitchRes = detectPitchMPM(
      this.timeDomainBuf,
      this.ctx.sampleRate,
      minFreq,
      maxFreq,
      this.refA4,
      windowSize
    );

    const specRes = analyzeSpectrumAndPolyphony(
      this.freqDbBuf,
      this.ctx.sampleRate,
      this.analyser.fftSize,
      pitchRes.frequency,
      pitchRes.clarity,
      this.instrument,
      this.refA4
    );

    const isConfident =
      pitchRes.midi !== null &&
      pitchRes.rms >= 0.009 &&
      pitchRes.clarity >= 0.45 &&
      pitchRes.midi >= this.instrument.minMidi - 2 &&
      pitchRes.midi <= this.instrument.maxMidi + 2;

    if (isConfident && pitchRes.midi !== null) {
      if (this.confidentHoldCounter === 0) {
        this.smoothedMidi = pitchRes.midi;
      } else {
        const diff = pitchRes.midi - this.smoothedMidi;
        if (Math.abs(diff) > 1.5) {
          this.smoothedMidi = pitchRes.midi;
        } else {
          this.smoothedMidi += diff * 0.48;
        }
      }
      this.confidentHoldCounter++;
      if (this.confidentHoldCounter >= 2) {
        this.lastConfidentMidi = this.smoothedMidi;
      }

      this.smoothedOpacity += (1.0 - this.smoothedOpacity) * 0.35;
    } else {
      this.confidentHoldCounter = 0;
      this.smoothedOpacity += (0.08 - this.smoothedOpacity) * 0.22;
    }

    const isSilent = this.confidentHoldCounter === 0;
    const activeMidi = isSilent ? this.lastConfidentMidi : this.smoothedMidi;

    let targetNoisiness = specRes.noisiness;
    if (sim.enabled && !isSilent) {
      const simNoise = sim.bowNoise / 100;
      targetNoisiness = specRes.noisiness * 0.45 + simNoise * 0.55;
    }
    this.smoothedNoisiness += (targetNoisiness - this.smoothedNoisiness) * 0.3;

    let secondaryMidi = isSilent ? null : specRes.secondaryMidi;
    let secondaryRms = isSilent ? 0 : specRes.secondaryRms;
    let secondaryStringIndex = isSilent ? null : specRes.secondaryStringIndex;

    if (sim.enabled && !isSilent && sim.secondStringLeak > 4) {
      const idx =
        sim.secondStringIndex >= 0 && sim.secondStringIndex < 4
          ? sim.secondStringIndex
          : getAdjacentOpenStringIndex(this.instrument, Math.round(activeMidi));
      const str = this.instrument.strings[idx];
      if (Math.abs(activeMidi - str.midi) > 0.8) {
        secondaryMidi = str.midi;
        secondaryRms = Math.max(secondaryRms, sim.secondStringLeak / 100);
        secondaryStringIndex = idx;
      }
    }

    const nearestMidi = Math.round(activeMidi);
    const centsOffset = (activeMidi - nearestMidi) * 100;

    const frame: TelemetryFrame = {
      time: sessionTime,
      primaryMidi: activeMidi,
      frozenMidi: this.lastConfidentMidi,
      isSilent,
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
