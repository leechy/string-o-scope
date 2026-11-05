import { GridMode, InstrumentId, InstrumentSpec, ReferencePitch, StringSpec } from './types';

export const STRING_COLORS = {
  IV: { color: '#3B82F6', glow: 'rgba(59, 130, 246, 0.45)' }, // Blue (Lowest)
  III: { color: '#F59E0B', glow: 'rgba(245, 158, 11, 0.45)' }, // Yellow/Amber
  II: { color: '#10B981', glow: 'rgba(16, 185, 129, 0.45)' }, // Green
  I: { color: '#EF4444', glow: 'rgba(239, 68, 68, 0.45)' }, // Red/Coral (Highest)
} as const;

export const INSTRUMENTS: Record<InstrumentId, InstrumentSpec> = {
  violin: {
    id: 'violin',
    nameRu: 'Скрипка',
    nameEn: 'Violin',
    rangeLabel: 'G3 — E6',
    descriptionRu: 'Высокий регистр, мгновенный отклик (буфер 4096)',
    fftSize: 4096,
    minMidi: 53, // F3
    maxMidi: 93, // A6
    defaultCenterMidi: 65.5, // Centered comfortably around D4-A4
    strings: [
      {
        index: 0,
        roman: 'IV',
        nameRu: 'Соль',
        noteEn: 'G3',
        midi: 55,
        color: STRING_COLORS.IV.color,
        glowColor: STRING_COLORS.IV.glow,
      },
      {
        index: 1,
        roman: 'III',
        nameRu: 'Ре',
        noteEn: 'D4',
        midi: 62,
        color: STRING_COLORS.III.color,
        glowColor: STRING_COLORS.III.glow,
      },
      {
        index: 2,
        roman: 'II',
        nameRu: 'Ля',
        noteEn: 'A4',
        midi: 69,
        color: STRING_COLORS.II.color,
        glowColor: STRING_COLORS.II.glow,
      },
      {
        index: 3,
        roman: 'I',
        nameRu: 'Ми',
        noteEn: 'E5',
        midi: 76,
        color: STRING_COLORS.I.color,
        glowColor: STRING_COLORS.I.glow,
      },
    ],
  },
  viola: {
    id: 'viola',
    nameRu: 'Альт',
    nameEn: 'Viola',
    rangeLabel: 'C3 — A5',
    descriptionRu: 'Бархатный средний регистр (буфер 4096)',
    fftSize: 4096,
    minMidi: 46, // Bb2
    maxMidi: 86, // D6
    defaultCenterMidi: 58.5, // Centered around G3-D4
    strings: [
      {
        index: 0,
        roman: 'IV',
        nameRu: 'До',
        noteEn: 'C3',
        midi: 48,
        color: STRING_COLORS.IV.color,
        glowColor: STRING_COLORS.IV.glow,
      },
      {
        index: 1,
        roman: 'III',
        nameRu: 'Соль',
        noteEn: 'G3',
        midi: 55,
        color: STRING_COLORS.III.color,
        glowColor: STRING_COLORS.III.glow,
      },
      {
        index: 2,
        roman: 'II',
        nameRu: 'Ре',
        noteEn: 'D4',
        midi: 62,
        color: STRING_COLORS.II.color,
        glowColor: STRING_COLORS.II.glow,
      },
      {
        index: 3,
        roman: 'I',
        nameRu: 'Ля',
        noteEn: 'A4',
        midi: 69,
        color: STRING_COLORS.I.color,
        glowColor: STRING_COLORS.I.glow,
      },
    ],
  },
  cello: {
    id: 'cello',
    nameRu: 'Виолончель',
    nameEn: 'Cello',
    rangeLabel: 'C2 — A4',
    descriptionRu: 'Глубокий певучий бас и тенор (буфер 8192)',
    fftSize: 8192,
    minMidi: 34, // Bb1
    maxMidi: 76, // E5
    defaultCenterMidi: 46.5, // Centered around G2-D3
    strings: [
      {
        index: 0,
        roman: 'IV',
        nameRu: 'До',
        noteEn: 'C2',
        midi: 36,
        color: STRING_COLORS.IV.color,
        glowColor: STRING_COLORS.IV.glow,
      },
      {
        index: 1,
        roman: 'III',
        nameRu: 'Соль',
        noteEn: 'G2',
        midi: 43,
        color: STRING_COLORS.III.color,
        glowColor: STRING_COLORS.III.glow,
      },
      {
        index: 2,
        roman: 'II',
        nameRu: 'Ре',
        noteEn: 'D3',
        midi: 50,
        color: STRING_COLORS.II.color,
        glowColor: STRING_COLORS.II.glow,
      },
      {
        index: 3,
        roman: 'I',
        nameRu: 'Ля',
        noteEn: 'A3',
        midi: 57,
        color: STRING_COLORS.I.color,
        glowColor: STRING_COLORS.I.glow,
      },
    ],
  },
  bass: {
    id: 'bass',
    nameRu: 'Контрабас',
    nameEn: 'Double Bass',
    rangeLabel: 'E1 — G3',
    descriptionRu: 'Субконтроктава от 41.2 Гц (буфер 8192)',
    fftSize: 8192,
    minMidi: 26, // D1
    maxMidi: 64, // E4
    defaultCenterMidi: 35.5, // Centered around A1-D2
    strings: [
      {
        index: 0,
        roman: 'IV',
        nameRu: 'Ми',
        noteEn: 'E1',
        midi: 28,
        color: STRING_COLORS.IV.color,
        glowColor: STRING_COLORS.IV.glow,
      },
      {
        index: 1,
        roman: 'III',
        nameRu: 'Ля',
        noteEn: 'A1',
        midi: 33,
        color: STRING_COLORS.III.color,
        glowColor: STRING_COLORS.III.glow,
      },
      {
        index: 2,
        roman: 'II',
        nameRu: 'Ре',
        noteEn: 'D2',
        midi: 38,
        color: STRING_COLORS.II.color,
        glowColor: STRING_COLORS.II.glow,
      },
      {
        index: 3,
        roman: 'I',
        nameRu: 'Соль',
        noteEn: 'G2',
        midi: 43,
        color: STRING_COLORS.I.color,
        glowColor: STRING_COLORS.I.glow,
      },
    ],
  },
};

export interface PitchClassInfo {
  pc: number;
  isNatural: boolean;
  solfege: string;
  semitoneBadge: string;
  letter: string;
}

export const PITCH_CLASSES: readonly PitchClassInfo[] = [
  { pc: 0, isNatural: true, solfege: 'До', semitoneBadge: 'До', letter: 'C' },
  { pc: 1, isNatural: false, solfege: 'До♯ / Ре♭', semitoneBadge: 'До♯ / Ре♭', letter: 'C♯/D♭' },
  { pc: 2, isNatural: true, solfege: 'Ре', semitoneBadge: 'Ре', letter: 'D' },
  { pc: 3, isNatural: false, solfege: 'Ре♯ / Ми♭', semitoneBadge: 'Ре♯ / Ми♭', letter: 'D♯/E♭' },
  { pc: 4, isNatural: true, solfege: 'Ми', semitoneBadge: 'Ми', letter: 'E' },
  { pc: 5, isNatural: true, solfege: 'Фа', semitoneBadge: 'Фа', letter: 'F' },
  { pc: 6, isNatural: false, solfege: 'Фа♯ / Соль♭', semitoneBadge: 'Фа♯ / Соль♭', letter: 'F♯/G♭' },
  { pc: 7, isNatural: true, solfege: 'Соль', semitoneBadge: 'Соль', letter: 'G' },
  { pc: 8, isNatural: false, solfege: 'Соль♯ / Ля♭', semitoneBadge: 'Соль♯ / Ля♭', letter: 'G♯/A♭' },
  { pc: 9, isNatural: true, solfege: 'Ля', semitoneBadge: 'Ля', letter: 'A' },
  { pc: 10, isNatural: false, solfege: 'Ля♯ / Си♭', semitoneBadge: 'Ля♯ / Си♭', letter: 'A♯/B♭' },
  { pc: 11, isNatural: true, solfege: 'Си', semitoneBadge: 'Си', letter: 'B' },
] as const;

export const KEY_SIGNATURES: Record<
  GridMode,
  {
    labelRu: string;
    activePitchClasses: Set<number>;
    customLabels?: Partial<Record<number, string>>;
  }
> = {
  'natural-dashed': {
    labelRu: 'Чистые ноты + ♯/♭',
    activePitchClasses: new Set([0, 2, 4, 5, 7, 9, 11]),
  },
  'G-major': {
    labelRu: 'Соль мажор (1♯)',
    activePitchClasses: new Set([0, 2, 4, 6, 7, 9, 11]),
    customLabels: { 6: 'Фа♯' },
  },
  'D-major': {
    labelRu: 'Ре мажор (2♯)',
    activePitchClasses: new Set([1, 2, 4, 6, 7, 9, 11]),
    customLabels: { 1: 'До♯', 6: 'Фа♯' },
  },
  'A-major': {
    labelRu: 'Ля мажор (3♯)',
    activePitchClasses: new Set([1, 2, 4, 6, 8, 9, 11]),
    customLabels: { 1: 'До♯', 6: 'Фа♯', 8: 'Соль♯' },
  },
  'F-major': {
    labelRu: 'Фа мажор (1♭)',
    activePitchClasses: new Set([0, 2, 4, 5, 7, 9, 10]),
    customLabels: { 10: 'Си♭' },
  },
  'Bb-major': {
    labelRu: 'Си♭ мажор (2♭)',
    activePitchClasses: new Set([0, 2, 3, 5, 7, 9, 10]),
    customLabels: { 3: 'Ми♭', 10: 'Си♭' },
  },
};

export function midiToFreq(midi: number, refA4: ReferencePitch = 442): number {
  return refA4 * Math.pow(2, (midi - 69) / 12);
}

export function freqToMidi(freq: number, refA4: ReferencePitch = 442): number {
  return 69 + 12 * Math.log2(freq / refA4);
}

export function getPitchClassInfo(midiInt: number): PitchClassInfo {
  const pc = ((Math.round(midiInt) % 12) + 12) % 12;
  return PITCH_CLASSES[pc];
}

export function getOctaveNumber(midiInt: number): number {
  return Math.floor(Math.round(midiInt) / 12) - 1;
}

export function formatMidiNoteRu(midiInt: number, gridMode: GridMode = 'natural-dashed'): string {
  const rounded = Math.round(midiInt);
  const pc = ((rounded % 12) + 12) % 12;
  const octave = getOctaveNumber(rounded);
  const keySpec = KEY_SIGNATURES[gridMode];
  const custom = keySpec.customLabels?.[pc];
  const baseName = custom ?? PITCH_CLASSES[pc].solfege;
  return `${baseName}${octave}`;
}

export function isMainScaleNote(midiInt: number, gridMode: GridMode): boolean {
  const pc = ((Math.round(midiInt) % 12) + 12) % 12;
  return KEY_SIGNATURES[gridMode].activePitchClasses.has(pc);
}

export function findOpenString(instrument: InstrumentSpec, midiInt: number): StringSpec | null {
  const rounded = Math.round(midiInt);
  for (const s of instrument.strings) {
    if (s.midi === rounded) return s;
  }
  return null;
}

export function findClosestString(instrument: InstrumentSpec, midiFloat: number): StringSpec {
  let best = instrument.strings[0];
  let bestDist = Math.abs(midiFloat - best.midi);
  for (let i = 1; i < instrument.strings.length; i++) {
    const s = instrument.strings[i];
    const dist = Math.abs(midiFloat - s.midi);
    if (dist < bestDist) {
      bestDist = dist;
      best = s;
    }
  }
  return best;
}

/**
 * Color by Intonation Accuracy (Spec 3.E.1):
 * Bright emerald/cyan when within ±10 cents of a valid scale/semitone line;
 * Smoothly shifts toward yellow/orange when flat or sharp (±15 to ±50 cents).
 */
export function getIntonationColor(centsOffset: number, alpha = 1): string {
  const absCents = Math.min(50, Math.abs(centsOffset));
  let r: number;
  let g: number;
  let b: number;

  if (absCents <= 10) {
    // Bright emerald/cyan (#10F5B8 -> #10B981)
    const t = absCents / 10;
    r = Math.round(16 + t * 14);
    g = Math.round(240 - t * 30);
    b = Math.round(190 - t * 45);
  } else if (absCents <= 25) {
    // Interpolate from emerald (#1ED291) to warm yellow (#FACC15)
    const t = (absCents - 10) / 15;
    r = Math.round(30 + t * (250 - 30));
    g = Math.round(210 - t * (210 - 204));
    b = Math.round(145 - t * (145 - 21));
  } else {
    // Interpolate from yellow (#FACC15) to vivid orange-red (#F97316 -> #EF4444)
    const t = (absCents - 25) / 25;
    r = Math.round(250 - t * 6);
    g = Math.round(204 - t * (204 - 95));
    b = Math.round(21 + t * 15);
  }

  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
}
