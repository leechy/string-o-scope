import { InstrumentSpec, ReferencePitch } from './types';
import { findClosestString, freqToMidi, midiToFreq } from './music';

export interface PitchDetectionResult {
  frequency: number | null;
  midi: number | null;
  clarity: number;
  rms: number;
}

export interface SpectralAnalysisResult {
  noisiness: number;
  secondaryMidi: number | null;
  secondaryRms: number;
  secondaryStringIndex: number | null;
}

/**
 * McLeod Pitch Method (MPM) with Normalized Square Difference Function (NSDF)
 * and parabolic interpolation for sub-cent precision.
 */
export function detectPitchMPM(
  buffer: Float32Array,
  sampleRate: number,
  minFreq: number,
  maxFreq: number,
  refA4: ReferencePitch,
  analysisWindowSize?: number,
  rmsThreshold = 0.008,
  minClarity = 0.35
): PitchDetectionResult {
  const N = analysisWindowSize ? Math.min(buffer.length, analysisWindowSize) : buffer.length;
  const startOffset = buffer.length - N;

  // 1. Compute RMS & DC offset
  let sumSq = 0;
  let mean = 0;
  for (let i = startOffset; i < buffer.length; i++) {
    const v = buffer[i];
    mean += v;
    sumSq += v * v;
  }
  mean /= N;
  const rms = Math.sqrt(sumSq / N);

  // Noise gate threshold
  if (rms < rmsThreshold) {
    return { frequency: null, midi: null, clarity: 0, rms };
  }

  const minTau = Math.max(2, Math.floor(sampleRate / (maxFreq * 1.08)));
  const maxTau = Math.min(Math.floor(N * 0.55), Math.ceil(sampleRate / (minFreq * 0.92)));

  if (maxTau <= minTau + 2) {
    return { frequency: null, midi: null, clarity: 0, rms };
  }

  // Downsample factor for ultra-fast correlation on 8192 buffers while preserving exact lag refinement
  const stride = N >= 8192 ? 2 : 1;
  const nsdf = new Float32Array(maxTau + 2);

  for (let tau = minTau - 1; tau <= maxTau + 1; tau++) {
    let acf = 0;
    let m = 0;
    const limit = N - tau;
    for (let i = 0; i < limit; i += stride) {
      const x0 = buffer[startOffset + i] - mean;
      const x1 = buffer[startOffset + i + tau] - mean;
      acf += x0 * x1;
      m += x0 * x0 + x1 * x1;
    }
    nsdf[tau] = m > 1e-12 ? (2 * acf) / m : 0;
  }

  // Find positive-going zero crossings and peak maxima in NSDF (McLeod key maxima)
  const peaks: { tau: number; val: number }[] = [];
  let inPositiveRegion = true; // allow peak even if minTau starts inside first positive lobe
  let currentMaxTau = -1;
  let currentMaxVal = -Infinity;

  for (let tau = minTau; tau <= maxTau; tau++) {
    const val = nsdf[tau];
    if (val > 0) {
      if (!inPositiveRegion) {
        inPositiveRegion = true;
        currentMaxTau = tau;
        currentMaxVal = val;
      } else if (val > currentMaxVal) {
        currentMaxTau = tau;
        currentMaxVal = val;
      }
    } else if (inPositiveRegion) {
      if (currentMaxVal > 0.25 && currentMaxTau > minTau && currentMaxTau < maxTau) {
        peaks.push({ tau: currentMaxTau, val: currentMaxVal });
      }
      inPositiveRegion = false;
      currentMaxVal = -Infinity;
    }
  }
  if (inPositiveRegion && currentMaxVal > 0.25 && currentMaxTau > minTau && currentMaxTau < maxTau) {
    peaks.push({ tau: currentMaxTau, val: currentMaxVal });
  }

  if (peaks.length === 0) {
    return { frequency: null, midi: null, clarity: 0, rms };
  }

  // Global maximum among candidate peaks
  let highestPeakVal = 0;
  for (const p of peaks) {
    if (p.val > highestPeakVal) highestPeakVal = p.val;
  }

  // MPM threshold k = 0.84 selects the first major peak (fundamental period)
  const threshold = highestPeakVal * 0.84;
  let chosenPeak = peaks[0];
  for (const p of peaks) {
    if (p.val >= threshold) {
      chosenPeak = p;
      break;
    }
  }

  if (chosenPeak.val < minClarity) {
    return { frequency: null, midi: null, clarity: chosenPeak.val, rms };
  }

  // Parabolic interpolation around chosenPeak.tau
  const tau0 = chosenPeak.tau;
  const y1 = nsdf[tau0 - 1];
  const y2 = nsdf[tau0];
  const y3 = nsdf[tau0 + 1];
  const denom = y1 - 2 * y2 + y3;
  let delta = 0;
  if (Math.abs(denom) > 1e-9) {
    delta = (0.5 * (y1 - y3)) / denom;
    if (delta < -1) delta = -1;
    if (delta > 1) delta = 1;
  }

  const refinedTau = tau0 + delta;
  const frequency = sampleRate / refinedTau;

  if (frequency < minFreq * 0.9 || frequency > maxFreq * 1.1) {
    return { frequency: null, midi: null, clarity: 0, rms };
  }

  const midi = freqToMidi(frequency, refA4);
  const clarity = Math.min(1, Math.max(0, chosenPeak.val));

  return { frequency, midi, clarity, rms };
}

/**
 * Computes:
 * 1) Noisiness Metric: Spectral Flatness in 400 Hz – 5000 Hz + Non-Harmonic Residual ratio
 * 2) Secondary Pitch Detection: Subtracts/attenuates harmonics of primary pitch (k * f0)
 *    from magnitude spectrum and evaluates harmonic sums around the instrument's other strings.
 */
export function analyzeSpectrumAndPolyphony(
  freqDbBuffer: Float32Array,
  sampleRate: number,
  fftSize: number,
  primaryFreq: number | null,
  clarity: number,
  instrument: InstrumentSpec,
  refA4: ReferencePitch
): SpectralAnalysisResult {
  const numBins = freqDbBuffer.length;
  const binHz = sampleRate / fftSize;

  // Convert dB spectrum to linear magnitude & power
  const mag = new Float32Array(numBins);
  for (let i = 0; i < numBins; i++) {
    const db = freqDbBuffer[i];
    mag[i] = db > -115 ? Math.pow(10, db / 20) : 0;
  }

  // 1. Spectral Flatness in 400 Hz – 5000 Hz band
  const bin400 = Math.max(1, Math.floor(400 / binHz));
  const bin5000 = Math.min(numBins - 1, Math.ceil(5000 / binHz));
  const bandCount = Math.max(1, bin5000 - bin400 + 1);

  let sumLogPower = 0;
  let sumPower = 0;
  const eps = 1e-12;

  for (let i = bin400; i <= bin5000; i++) {
    const p = mag[i] * mag[i] + eps;
    sumLogPower += Math.log(p);
    sumPower += p;
  }

  const geomMean = Math.exp(sumLogPower / bandCount);
  const arithMean = sumPower / bandCount;
  const spectralFlatness = arithMean > eps ? Math.min(1, geomMean / arithMean) : 0;

  if (!primaryFreq || primaryFreq <= 0) {
    return {
      noisiness: Math.min(1, spectralFlatness * 2.2),
      secondaryMidi: null,
      secondaryRms: 0,
      secondaryStringIndex: null,
    };
  }

  // 2. Subtract/attenuate harmonics of primary pitch (k * f0) from magnitude spectrum
  const residualMag = new Float32Array(mag);
  let primaryHarmonicEnergy = 0;

  for (let k = 1; k <= 18; k++) {
    const harmFreq = primaryFreq * k;
    if (harmFreq >= sampleRate * 0.48) break;
    const centerBin = Math.round(harmFreq / binHz);
    // Width of harmonic peak: ~3.2% of harmonic frequency or at least 2 bins
    const halfWidth = Math.max(2, Math.ceil((harmFreq * 0.032) / binHz));
    const lowBin = Math.max(1, centerBin - halfWidth);
    const highBin = Math.min(numBins - 1, centerBin + halfWidth);

    for (let b = lowBin; b <= highBin; b++) {
      const m = mag[b];
      primaryHarmonicEnergy += m * m;
      // Attenuate primary harmonic to 4%
      residualMag[b] *= 0.04;
    }
  }

  // 3. Evaluate Secondary Pitch Detection around the instrument's open strings
  const primaryMidi = freqToMidi(primaryFreq, refA4);
  let bestStringIdx: number | null = null;
  let bestStringScore = 0;
  let bestStringMidi: number | null = null;

  for (let sIdx = 0; sIdx < instrument.strings.length; sIdx++) {
    const str = instrument.strings[sIdx];
    // Skip if primary pitch is already playing this very open string (within 1.3 semitones)
    if (Math.abs(primaryMidi - str.midi) < 1.35) continue;

    const strFreq = midiToFreq(str.midi, refA4);
    let harmSum = 0;
    let validHarms = 0;

    for (let m = 1; m <= 6; m++) {
      const targetHz = strFreq * m;
      if (targetHz >= sampleRate * 0.45) break;

      // Skip if this harmonic coincides closely with a harmonic of the primary pitch
      const nearestK = Math.round(targetHz / primaryFreq);
      if (nearestK >= 1 && Math.abs(targetHz - nearestK * primaryFreq) / targetHz < 0.032) {
        continue;
      }

      const cBin = Math.round(targetHz / binHz);
      const radius = Math.max(1, Math.ceil((targetHz * 0.02) / binHz));
      let localPeak = 0;
      for (let b = Math.max(1, cBin - radius); b <= Math.min(numBins - 1, cBin + radius); b++) {
        if (residualMag[b] > localPeak) localPeak = residualMag[b];
      }

      // Weight lower harmonics higher
      const weight = 1 / Math.pow(m, 0.55);
      harmSum += localPeak * weight;
      validHarms += weight;
    }

    const normalizedScore = validHarms > 0 ? harmSum / validHarms : 0;
    if (normalizedScore > bestStringScore) {
      bestStringScore = normalizedScore;
      bestStringIdx = sIdx;
      bestStringMidi = str.midi;
    }
  }

  // Compare secondary harmonic score against primary fundamental amplitude
  const primaryRefAmp = Math.sqrt(Math.max(eps, primaryHarmonicEnergy));
  const relativeSecondary = Math.min(1, (bestStringScore * 3.8) / (primaryRefAmp + 1e-5));

  let secondaryMidi: number | null = null;
  let secondaryRms = 0;
  let secondaryStringIndex: number | null = null;

  // Threshold to trigger secondary string line
  if (bestStringIdx !== null && bestStringMidi !== null && relativeSecondary > 0.11 && bestStringScore > 0.0012) {
    secondaryMidi = bestStringMidi;
    secondaryRms = Math.min(1, (relativeSecondary - 0.08) * 1.45);
    secondaryStringIndex = bestStringIdx;

    // Also remove secondary string harmonics from residualMag so double stops don't falsely inflate bow noise!
    const secFreq = midiToFreq(secondaryMidi, refA4);
    for (let k = 1; k <= 10; k++) {
      const hFreq = secFreq * k;
      if (hFreq >= sampleRate * 0.48) break;
      const cBin = Math.round(hFreq / binHz);
      const hw = Math.max(2, Math.ceil((hFreq * 0.03) / binHz));
      for (let b = Math.max(1, cBin - hw); b <= Math.min(numBins - 1, cBin + hw); b++) {
        residualMag[b] *= 0.1;
      }
    }
  }

  // 4. Non-harmonic residual ratio in 400 Hz – 5000 Hz
  let residualBandEnergy = 0;
  let totalBandEnergy = 0;
  for (let i = bin400; i <= bin5000; i++) {
    totalBandEnergy += mag[i] * mag[i];
    residualBandEnergy += residualMag[i] * residualMag[i];
  }

  const nonHarmonicRatio =
    totalBandEnergy > eps ? Math.min(1, residualBandEnergy / totalBandEnergy) : 0;

  // Combine Spectral Flatness + Non-Harmonic Residual + (1 - clarity)
  const rawNoise =
    spectralFlatness * 1.65 +
    Math.max(0, nonHarmonicRatio - 0.12) * 0.65 +
    Math.max(0, 0.96 - clarity) * 0.85;

  const noisiness = Math.max(0, Math.min(1, rawNoise));

  return {
    noisiness,
    secondaryMidi,
    secondaryRms,
    secondaryStringIndex,
  };
}

/**
 * Helper to find the adjacent open string for the simulator when in "Auto Adjacent" mode
 */
export function getAdjacentOpenStringIndex(instrument: InstrumentSpec, targetMidi: number): number {
  const closest = findClosestString(instrument, targetMidi);
  if (closest.index < 3) return closest.index + 1;
  return closest.index - 1;
}
