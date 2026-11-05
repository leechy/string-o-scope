export type InstrumentId = 'violin' | 'viola' | 'cello' | 'bass';

export type ReferencePitch = 440 | 442 | 443;

export type GridMode =
  | 'natural-dashed'
  | 'G-major'
  | 'D-major'
  | 'A-major'
  | 'F-major'
  | 'Bb-major';

export interface StringSpec {
  index: number; // 0 = IV (lowest), 3 = I (highest)
  roman: 'IV' | 'III' | 'II' | 'I';
  nameRu: string; // e.g., "Соль"
  noteEn: string; // e.g., "G3"
  midi: number;
  color: string;
  glowColor: string;
}

export interface InstrumentSpec {
  id: InstrumentId;
  nameRu: string;
  nameEn: string;
  rangeLabel: string;
  descriptionRu: string;
  fftSize: 4096 | 8192;
  minMidi: number;
  maxMidi: number;
  defaultCenterMidi: number;
  strings: [StringSpec, StringSpec, StringSpec, StringSpec];
}

export interface TelemetryFrame {
  time: number; // monotonic session time in seconds
  primaryMidi: number; // continuous MIDI note (float)
  frozenMidi: number; // last confident MIDI pitch held during silence
  isSilent: boolean; // true when below noise gate
  isDiscontinuous?: boolean; // true when pitch leaped abruptly or resumed from silence
  opacity: number; // 0.05..0.10 during silence ("Ghost Thread"), 1.0 when active
  clarity: number; // 0..1 pitch confidence from MPM/autocorrelation
  noisiness: number; // 0..1 bow noise (spectral flatness + harmonic residual)
  rms: number; // signal RMS level
  centsOffset: number; // -50..+50 cents from nearest target pitch
  nearestMidi: number; // nearest integer MIDI note
  secondaryMidi: number | null; // simultaneous 2nd string MIDI pitch
  secondaryRms: number; // relative amplitude of 2nd string (0..1)
  secondaryStringIndex: number | null; // 0..3 index of closest open string
}

export interface FilterSettings {
  panelOpen: boolean;
  // Bandpass filters
  highPassEnabled: boolean;
  highPassFreq: number; // Hz (e.g. 185 Hz for violin)
  lowPassEnabled: boolean;
  lowPassFreq: number; // Hz (e.g. 4500 Hz)

  // Noise gate
  noiseGateEnabled: boolean;
  noiseGateRms: number; // 0.005..0.080

  // Pitch confidence threshold
  clarityThreshold: number; // 0.35..0.90

  // Octave jump rejection
  octaveJumpRejection: boolean;

  // Median filtering
  medianFilterFrames: 1 | 3 | 5;

  // Discontinuity line breaking
  breakLineOnLeap: boolean;
  maxContinuousLeapMidi: number; // semitones (e.g. 8)

  // Camera damping
  cameraDampingEnabled: boolean;
}

export function getDefaultFilterSettings(instrumentId: InstrumentId): FilterSettings {
  let highPassFreq = 185;
  let lowPassFreq = 4800;
  if (instrumentId === 'viola') {
    highPassFreq = 120;
    lowPassFreq = 4200;
  } else if (instrumentId === 'cello') {
    highPassFreq = 60;
    lowPassFreq = 3400;
  } else if (instrumentId === 'bass') {
    highPassFreq = 36;
    lowPassFreq = 2400;
  }

  return {
    panelOpen: false,
    highPassEnabled: true,
    highPassFreq,
    lowPassEnabled: true,
    lowPassFreq,
    noiseGateEnabled: true,
    noiseGateRms: 0.020,
    clarityThreshold: 0.58,
    octaveJumpRejection: true,
    medianFilterFrames: 3,
    breakLineOnLeap: true,
    maxContinuousLeapMidi: 8,
    cameraDampingEnabled: true,
  };
}

export interface SimulatorState {
  enabled: boolean;
  drawerOpen: boolean;
  playing: boolean; // Play / Silence toggle (tests 90-95% transparent ghost thread)
  targetMidi: number; // integer MIDI note
  centsOffset: number; // -50 to +50 cents
  bowNoise: number; // 0 to 100%
  secondStringLeak: number; // 0 to 100%
  secondStringIndex: number; // -1 = auto adjacent open string, 0..3 = specific open string
  vibrato: number; // 0 to 25 cents
  autoMode: 'manual' | 'scale' | 'open-strings' | 'etude';
  monitorAudible: boolean; // whether to play simulator audio to speakers (analyzer always receives it)
  monitorVolume: number; // 0..100
}
