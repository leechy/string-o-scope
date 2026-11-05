import {
  GridMode,
  InstrumentSpec,
  ReferencePitch,
  TelemetryFrame,
} from './types';
import {
  findClosestString,
  findOpenString,
  getIntonationColor,
  getOctaveNumber,
  getPitchClassInfo,
  isMainScaleNote,
  KEY_SIGNATURES,
} from './music';

const VISIBLE_SEMITONES = 14; // ~1.15 octaves (Spec 3.B: 12 to 15 semitones)
const PLAYHEAD_X_RATIO = 0.75; // Spec 3.A: Horizontal Playhead at 75% Width

export class SoundCanvasRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  // Camera state (Spec 3.C: Vertical Camera Deadzone & Spring Recentering)
  public cameraCenterMidi: number;
  public cameraDampingEnabled = true;
  private cameraVelocity = 0;
  private pitchStableTimer = 0;
  private lastTrackedMidi = 60;

  // Semitone sustain illumination timers (Spec 3.B: >150ms illuminates badge)
  private semitoneSustainMs: Map<number, number> = new Map();

  // Dimensions
  private width = 1280;
  private height = 720;
  private dpr = 1;

  constructor(canvas: HTMLCanvasElement, initialInstrument: InstrumentSpec) {
    this.canvas = canvas;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) {
      throw new Error('Could not initialize 2D canvas context');
    }
    this.ctx = context;
    this.cameraCenterMidi = initialInstrument.defaultCenterMidi;
    this.lastTrackedMidi = this.cameraCenterMidi;
    this.resize();
  }

  public setInstrumentCenter(instrument: InstrumentSpec): void {
    this.cameraCenterMidi = instrument.defaultCenterMidi;
    this.cameraVelocity = 0;
    this.pitchStableTimer = 0;
    this.lastTrackedMidi = this.cameraCenterMidi;
    this.semitoneSustainMs.clear();
  }

  public resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.width = Math.max(320, rect.width);
    this.height = Math.max(240, rect.height);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
  }

  public getHistoryWindowSeconds(): number {
    // Landscape shows ~7 seconds of history from 75% head to 0% left edge; portrait shows ~4.5s
    return this.width >= this.height ? 7.0 : 4.5;
  }

  /**
   * Updates camera physics according to Spec 3.C:
   * - Central 50% Zone (25% top to 75% bottom): Pitch grid stays stationary.
   * - Top/Bottom 25% Boundary Push: Immediate scroll when pitch reaches top 25% or bottom 25%.
   * - Smooth Recentering: Critically damped spring gently eases stabilized pitch toward 50% center.
   */
  public updateCameraPhysics(latestFrame: TelemetryFrame | null, dtSeconds: number, followPitch = true): void {
    if (!followPitch || !latestFrame) return;

    const dt = Math.min(0.1, Math.max(0.001, dtSeconds));
    const activeMidi = latestFrame.primaryMidi;

    // Deadzone half-span: 25% of visible semitones on each side of center = 50% central zone
    const deadzoneHalfSpan = VISIBLE_SEMITONES * 0.25; // 3.5 semitones
    const upperBound = this.cameraCenterMidi + deadzoneHalfSpan;
    const lowerBound = this.cameraCenterMidi - deadzoneHalfSpan;

    // 1. Top / Bottom 25% Boundary Push
    if (activeMidi > upperBound) {
      const targetCenter = activeMidi - deadzoneHalfSpan;
      if (this.cameraDampingEnabled) {
        this.cameraCenterMidi += (targetCenter - this.cameraCenterMidi) * Math.min(1, dt * 8.5);
      } else {
        this.cameraCenterMidi = targetCenter;
      }
      this.cameraVelocity = 0;
      this.pitchStableTimer = 0;
    } else if (activeMidi < lowerBound) {
      const targetCenter = activeMidi + deadzoneHalfSpan;
      if (this.cameraDampingEnabled) {
        this.cameraCenterMidi += (targetCenter - this.cameraCenterMidi) * Math.min(1, dt * 8.5);
      } else {
        this.cameraCenterMidi = targetCenter;
      }
      this.cameraVelocity = 0;
      this.pitchStableTimer = 0;
    } else {
      // Inside the central 50% deadzone: check if pitch has stabilized or is in a bow pause
      const midiDeltaRate = Math.abs(activeMidi - this.lastTrackedMidi) / dt;
      if (midiDeltaRate < 0.85 || latestFrame.isSilent) {
        this.pitchStableTimer += dt;
      } else {
        this.pitchStableTimer = 0;
        this.cameraVelocity *= 0.8;
      }

      // Once stabilized for >0.55s, gently recenter using a slow critically damped spring
      // so the player is never tricked into thinking their pitch is drifting
      if (this.pitchStableTimer > 0.55) {
        const distFromCenter = activeMidi - this.cameraCenterMidi;
        if (Math.abs(distFromCenter) > 0.15) {
          const omega = 0.72; // gentle natural frequency (rad/s)
          const springAccel = omega * omega * distFromCenter - 2 * omega * this.cameraVelocity;
          this.cameraVelocity += springAccel * dt;
          // Cap max recentering speed to 0.65 semitones/sec
          const maxVel = 0.65;
          this.cameraVelocity = Math.max(-maxVel, Math.min(maxVel, this.cameraVelocity));
          this.cameraCenterMidi += this.cameraVelocity * dt;
        } else {
          this.cameraVelocity = 0;
        }
      }
    }

    this.lastTrackedMidi = activeMidi;

    // Update Semitone sustain illumination (>150ms near a semitone line)
    const dtMs = dt * 1000;
    const nearestMidi = Math.round(activeMidi);
    const centsDist = Math.abs((activeMidi - nearestMidi) * 100);

    // Decay all semitone timers first
    for (const [midiKey, val] of this.semitoneSustainMs.entries()) {
      if (midiKey !== nearestMidi || latestFrame.isSilent || centsDist > 36) {
        const nextVal = val - dtMs * 1.8;
        if (nextVal <= 0) {
          this.semitoneSustainMs.delete(midiKey);
        } else {
          this.semitoneSustainMs.set(midiKey, nextVal);
        }
      }
    }

    if (!latestFrame.isSilent && centsDist <= 36) {
      const prev = this.semitoneSustainMs.get(nearestMidi) ?? 0;
      this.semitoneSustainMs.set(nearestMidi, Math.min(450, prev + dtMs));
    }
  }

  public midiToY(midi: number): number {
    const semitonesFromCenter = midi - this.cameraCenterMidi;
    const norm = 0.5 - semitonesFromCenter / VISIBLE_SEMITONES;
    return norm * this.height;
  }

  public yToMidi(y: number): number {
    const norm = y / this.height;
    return this.cameraCenterMidi + (0.5 - norm) * VISIBLE_SEMITONES;
  }

  public render(params: {
    frames: TelemetryFrame[];
    instrument: InstrumentSpec;
    refA4: ReferencePitch;
    gridMode: GridMode;
    viewRightTime: number; // time at the 75% head
    replayCursorTime: number | null; // active audio replay cursor when playing recorded audio
    isPaused: boolean;
  }): void {
    const {
      frames,
      instrument,
      gridMode,
      viewRightTime,
      replayCursorTime,
      isPaused,
    } = params;

    const ctx = this.ctx;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);

    const W = this.width;
    const H = this.height;
    const headX = W * PLAYHEAD_X_RATIO;
    const historySeconds = this.getHistoryWindowSeconds();
    const pixelsPerSecond = headX / historySeconds;

    // 1. Full-screen dark background (#0B0F19 per Spec 2.2)
    ctx.fillStyle = '#0B0F19';
    ctx.fillRect(0, 0, W, H);

    // Subtle ambient radial glow around the 75% live head zone
    const latestVisibleFrame = this.findFrameAtTime(frames, viewRightTime);
    if (latestVisibleFrame && !latestVisibleFrame.isSilent) {
      const headY = this.midiToY(latestVisibleFrame.primaryMidi);
      const ambientGrad = ctx.createRadialGradient(headX, headY, 8, headX, headY, 260);
      ambientGrad.addColorStop(0, getIntonationColor(latestVisibleFrame.centsOffset, 0.11));
      ambientGrad.addColorStop(1, 'rgba(11, 15, 25, 0)');
      ctx.fillStyle = ambientGrad;
      ctx.fillRect(0, 0, W, H);
    }

    // Future zone (right 25% from 75% to 100%) subtle tint
    ctx.fillStyle = 'rgba(15, 23, 42, 0.42)';
    ctx.fillRect(headX, 0, W - headX, H);

    // 2. Vertical time grid lines (every 1 second)
    this.drawTimeGrid(ctx, W, H, headX, viewRightTime, pixelsPerSecond);

    // 3. Central 50% Deadzone boundary markers (25% top and 75% bottom)
    this.drawDeadzoneIndicators(ctx, W, H, headX);

    // 4. Horizontal Pitch Grid & European Solfège Labels + Open String Highlighting
    this.drawPitchGrid(ctx, W, H, headX, instrument, gridMode, latestVisibleFrame);

    // 5. Render Sound Lines (Ghost Thread, Secondary 2nd String Line, and Primary Pitch + Bow Noise Aura)
    this.drawSoundTraces(ctx, frames, instrument, headX, viewRightTime, historySeconds, pixelsPerSecond);

    // 6. Render 75% Live Playhead vertical guide & Live Head Orb
    this.drawLivePlayhead(ctx, H, headX, instrument, gridMode, latestVisibleFrame, isPaused);

    // 7. Render Recorded Audio Playback Cursor (when replaying recorded audio in Pause mode)
    if (replayCursorTime !== null) {
      this.drawReplayPlayhead(ctx, frames, H, headX, viewRightTime, pixelsPerSecond, replayCursorTime, gridMode);
    }

    ctx.restore();
  }

  private drawTimeGrid(
    ctx: CanvasRenderingContext2D,
    W: number,
    H: number,
    headX: number,
    viewRightTime: number,
    pixelsPerSecond: number
  ): void {
    const startSec = Math.floor(viewRightTime - headX / pixelsPerSecond);
    const endSec = Math.ceil(viewRightTime + (W - headX) / pixelsPerSecond);

    ctx.lineWidth = 1;
    ctx.font = '500 11px "Inter", -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';

    for (let s = startSec; s <= endSec; s++) {
      if (s < 0) continue;
      const x = headX - (viewRightTime - s) * pixelsPerSecond;
      if (x < 0 || x > W) continue;

      ctx.strokeStyle = s % 5 === 0 ? 'rgba(148, 163, 184, 0.08)' : 'rgba(148, 163, 184, 0.035)';
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();

      // Time offset label at bottom above transport bar
      const relSec = Math.round(s - viewRightTime);
      if (relSec <= 0 && relSec % 2 === 0 && x > 40 && x < headX - 25) {
        ctx.fillStyle = 'rgba(148, 163, 184, 0.35)';
        ctx.fillText(`${relSec}с`, x, H - 76);
      }
    }
  }

  private drawDeadzoneIndicators(
    ctx: CanvasRenderingContext2D,
    W: number,
    H: number,
    headX: number
  ): void {
    const top25Y = H * 0.25;
    const bottom75Y = H * 0.75;

    ctx.save();
    ctx.strokeStyle = 'rgba(99, 102, 241, 0.14)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 6]);

    // Subtle ticks in the right 25% zone showing the 25% / 75% camera deadzone boundaries
    ctx.beginPath();
    ctx.moveTo(headX, top25Y);
    ctx.lineTo(W, top25Y);
    ctx.moveTo(headX, bottom75Y);
    ctx.lineTo(W, bottom75Y);
    ctx.stroke();
    ctx.restore();
  }

  private drawPitchGrid(
    ctx: CanvasRenderingContext2D,
    W: number,
    H: number,
    headX: number,
    instrument: InstrumentSpec,
    gridMode: GridMode,
    latestFrame: TelemetryFrame | null
  ): void {
    const minVisibleMidi = Math.floor(this.cameraCenterMidi - VISIBLE_SEMITONES * 0.55);
    const maxVisibleMidi = Math.ceil(this.cameraCenterMidi + VISIBLE_SEMITONES * 0.55);

    const activeRoundedMidi =
      latestFrame && !latestFrame.isSilent ? Math.round(latestFrame.primaryMidi) : null;
    const activeCents =
      latestFrame && !latestFrame.isSilent
        ? (latestFrame.primaryMidi - Math.round(latestFrame.primaryMidi)) * 100
        : 0;

    for (let midi = minVisibleMidi; midi <= maxVisibleMidi; midi++) {
      const y = this.midiToY(midi);
      if (y < -20 || y > H + 20) continue;

      const pcInfo = getPitchClassInfo(midi);
      const octave = getOctaveNumber(midi);
      const openString = findOpenString(instrument, midi);
      const isScaleNote = isMainScaleNote(midi, gridMode);
      const isCurrentlySustained = activeRoundedMidi === midi;
      const sustainMs = this.semitoneSustainMs.get(midi) ?? 0;
      const semitoneIlluminated = !isScaleNote && sustainMs >= 150;

      ctx.save();

      if (openString) {
        // Spec 3.B: Open String Highlighting with signature string color & pill badge
        ctx.strokeStyle = openString.color;
        ctx.globalAlpha = isCurrentlySustained ? 0.98 : 0.80;
        ctx.lineWidth = isCurrentlySustained ? 2.6 : 2.0;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();

        // Subtle glow along open string line
        ctx.strokeStyle = openString.glowColor;
        ctx.lineWidth = 6;
        ctx.globalAlpha = isCurrentlySustained ? 0.42 : 0.20;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
      } else if (isScaleNote) {
        // Spec 3.B: Natural / Diatonic Notes rendered as solid, clear horizontal guide lines
        const isTonicC = pcInfo.pc === 0;
        ctx.strokeStyle = isCurrentlySustained
          ? 'rgba(248, 250, 252, 0.88)'
          : isTonicC
          ? 'rgba(241, 245, 249, 0.64)'
          : 'rgba(203, 213, 225, 0.46)';
        ctx.lineWidth = isCurrentlySustained ? 1.85 : isTonicC ? 1.5 : 1.2;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
      } else {
        // Spec 3.B: Semitones sit halfway between whole tones as dashed lines (brighter for tablet/phone stand visibility)
        const illumAlpha = Math.min(1, Math.max(0, (sustainMs - 80) / 140));
        ctx.strokeStyle =
          illumAlpha > 0.05
            ? `rgba(56, 189, 248, ${(0.42 + illumAlpha * 0.48).toFixed(2)})`
            : 'rgba(148, 163, 184, 0.38)';
        ctx.lineWidth = illumAlpha > 0.2 ? 1.7 : 1.25;
        ctx.setLineDash([6, 6]);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
      }

      // Draw Note Labels & Open String Pill Badges in the Right 25% Zone (and subtle left reference)
      const rightLabelX = headX + 18;
      const customKeyLabel = KEY_SIGNATURES[gridMode].customLabels?.[pcInfo.pc];

      if (openString) {
        // Open String Pill Badge (e.g., "Струна Ля • II (A4)")
        const badgeText = `Струна ${openString.nameRu} (${openString.roman} • ${openString.noteEn})`;
        ctx.font = '700 12.5px "Inter", -apple-system, BlinkMacSystemFont, sans-serif';
        const textWidth = ctx.measureText(badgeText).width;
        const padX = 10;
        const badgeW = textWidth + padX * 2 + 12;
        const badgeH = 24;
        const badgeY = y - badgeH / 2;

        ctx.globalAlpha = 1;
        ctx.fillStyle = 'rgba(11, 15, 25, 0.92)';
        this.roundRect(ctx, rightLabelX, badgeY, badgeW, badgeH, 12);
        ctx.fill();

        ctx.strokeStyle = openString.color;
        ctx.lineWidth = isCurrentlySustained ? 2.2 : 1.6;
        ctx.setLineDash([]);
        this.roundRect(ctx, rightLabelX, badgeY, badgeW, badgeH, 12);
        ctx.stroke();

        // Colored dot inside pill
        ctx.fillStyle = openString.color;
        ctx.beginPath();
        ctx.arc(rightLabelX + 11, y, 4.2, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#F8FAFC';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(badgeText, rightLabelX + 20, y + 0.5);
      } else if (isScaleNote) {
        const noteLabel = customKeyLabel ?? pcInfo.solfege;
        const fullLabel = `${noteLabel}${octave}`;
        ctx.globalAlpha = 1;
        ctx.font = isCurrentlySustained
          ? '700 13.5px "Inter", -apple-system, BlinkMacSystemFont, sans-serif'
          : '600 12.5px "Inter", -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';

        if (isCurrentlySustained) {
          const tw = ctx.measureText(fullLabel).width;
          ctx.fillStyle = 'rgba(16, 185, 129, 0.22)';
          this.roundRect(ctx, rightLabelX - 4, y - 11, tw + 16, 22, 6);
          ctx.fill();
          ctx.fillStyle = getIntonationColor(activeCents, 1);
        } else {
          ctx.fillStyle = pcInfo.pc === 0 ? '#F8FAFC' : 'rgba(226, 232, 240, 0.92)';
        }

        ctx.fillText(fullLabel, rightLabelX + 4, y);
      } else {
        // Semitone badge: Clearly legible when inactive, illuminates brightly when sustained > 150ms (Spec 3.B)
        const illumAlpha = Math.min(1, Math.max(0, (sustainMs - 80) / 120));
        const badgeText = pcInfo.semitoneBadge;
        ctx.font = semitoneIlluminated
          ? '600 12px "Inter", -apple-system, BlinkMacSystemFont, sans-serif'
          : '500 11.5px "Inter", -apple-system, BlinkMacSystemFont, sans-serif';
        const tw = ctx.measureText(badgeText).width;

        if (illumAlpha > 0.05) {
          ctx.globalAlpha = 1;
          ctx.fillStyle = `rgba(14, 116, 144, ${(0.32 + illumAlpha * 0.48).toFixed(2)})`;
          this.roundRect(ctx, rightLabelX, y - 10, tw + 14, 20, 10);
          ctx.fill();

          ctx.strokeStyle = `rgba(56, 189, 248, ${(0.45 + illumAlpha * 0.55).toFixed(2)})`;
          ctx.lineWidth = 1.4;
          ctx.setLineDash([]);
          this.roundRect(ctx, rightLabelX, y - 10, tw + 14, 20, 10);
          ctx.stroke();

          ctx.fillStyle = `rgba(224, 242, 254, ${(0.7 + illumAlpha * 0.3).toFixed(2)})`;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(badgeText, rightLabelX + 7, y + 0.5);
        } else {
          ctx.globalAlpha = 0.72;
          ctx.fillStyle = '#CBD5E1';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(badgeText, rightLabelX + 6, y);
        }
      }

      ctx.restore();
    }
  }

  private drawSoundTraces(
    ctx: CanvasRenderingContext2D,
    frames: TelemetryFrame[],
    instrument: InstrumentSpec,
    headX: number,
    viewRightTime: number,
    historySeconds: number,
    pixelsPerSecond: number
  ): void {
    if (frames.length < 2) return;

    const minTime = viewRightTime - historySeconds - 0.25;
    const maxTime = viewRightTime + 0.05;

    // Collect visible frames
    const visible: { frame: TelemetryFrame; x: number; y: number }[] = [];
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      if (f.time < minTime) continue;
      if (f.time > maxTime) break;
      const x = headX - (viewRightTime - f.time) * pixelsPerSecond;
      const y = this.midiToY(f.primaryMidi);
      visible.push({ frame: f, x, y });
    }

    if (visible.length < 2) return;

    ctx.save();
    // Clip sound traces strictly to the history region [0, headX]
    ctx.beginPath();
    ctx.rect(0, 0, headX + 2, this.height);
    ctx.clip();

    // 1. Accidental 2nd String / Double Stops Line (Spec 3.E.3)
    for (let i = 1; i < visible.length; i++) {
      const prev = visible[i - 1];
      const curr = visible[i];
      const f0 = prev.frame;
      const f1 = curr.frame;

      if (
        !f0.isSilent &&
        !f1.isSilent &&
        f0.secondaryMidi !== null &&
        f1.secondaryMidi !== null &&
        f1.secondaryRms > 0.05 &&
        curr.x - prev.x < 80
      ) {
        const y0 = this.midiToY(f0.secondaryMidi);
        const y1 = this.midiToY(f1.secondaryMidi);
        const strSpec =
          f1.secondaryStringIndex !== null
            ? instrument.strings[f1.secondaryStringIndex]
            : findClosestString(instrument, f1.secondaryMidi);

        const amp = Math.min(1, Math.max(0.15, f1.secondaryRms));
        ctx.save();
        ctx.strokeStyle = strSpec.color;
        ctx.globalAlpha = 0.28 + amp * 0.65;
        ctx.lineWidth = 1.6 + amp * 3.8;
        ctx.lineCap = 'round';
        ctx.shadowColor = strSpec.color;
        ctx.shadowBlur = 6 + amp * 10;
        ctx.beginPath();
        ctx.moveTo(prev.x, y0);
        ctx.lineTo(curr.x, y1);
        ctx.stroke();
        ctx.restore();
      }
    }

    // 2. Primary Pitch Line + Bow Noise Aura + "Ghost Thread" Silence Behavior (Spec 3.D & 3.E)
    for (let i = 1; i < visible.length; i++) {
      const prev = visible[i - 1];
      const curr = visible[i];
      if (curr.x - prev.x > 80) continue;

      const f = curr.frame;
      if (f.isDiscontinuous || Math.abs(curr.y - prev.y) > this.height * 0.45) continue;

      const isGhost = f.isSilent;

      if (isGhost) {
        // Spec 3.D: Ghost Thread at frozen pitch with 5%-10% opacity (90-95% transparent)
        ctx.save();
        ctx.strokeStyle = `rgba(148, 163, 184, ${f.opacity.toFixed(3)})`;
        ctx.lineWidth = 2.0;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(prev.x, prev.y);
        ctx.lineTo(curr.x, curr.y);
        ctx.stroke();
        ctx.restore();
        continue;
      }

      const noise = f.noisiness;
      const baseColor = getIntonationColor(f.centsOffset, f.opacity);

      // Spec 3.E.2: Scratchy bow / rosin noise (noisiness > 0.18) renders wide blurred aura + translucent ribbon + subtle jitter particles
      if (noise > 0.16) {
        const scratchIntensity = Math.min(1, (noise - 0.15) / 0.75);
        const auraWidth = 6 + scratchIntensity * 26;

        ctx.save();
        ctx.strokeStyle = getIntonationColor(f.centsOffset, (0.12 + scratchIntensity * 0.24) * f.opacity);
        ctx.lineWidth = auraWidth;
        ctx.lineCap = 'round';
        ctx.shadowColor = getIntonationColor(f.centsOffset, 0.55);
        ctx.shadowBlur = 10 + scratchIntensity * 24;

        // Deterministic jitter offset from frame timestamp so historical scratch looks organic and stays stable when scrubbed
        const seed = Math.sin(f.time * 173.7) * 43758.5453;
        const jitter = (seed - Math.floor(seed) - 0.5) * scratchIntensity * 9.5;

        ctx.beginPath();
        ctx.moveTo(prev.x, prev.y - jitter * 0.6);
        ctx.lineTo(curr.x, curr.y + jitter);
        ctx.stroke();

        // Subtle rosin dust / scratch particles around high-noise segments
        if (scratchIntensity > 0.28 && i % 2 === 0) {
          const pSeed = Math.cos(f.time * 289.3) * 19341.2;
          const pOffset = (pSeed - Math.floor(pSeed) - 0.5) * (14 + scratchIntensity * 28);
          ctx.fillStyle = getIntonationColor(f.centsOffset, 0.35 * scratchIntensity);
          ctx.beginPath();
          ctx.arc(curr.x, curr.y + pOffset, 1.2 + scratchIntensity * 1.6, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }

      // Core Laser Line (2.5px-3.5px when clean, slightly wider and softer when noisy)
      ctx.save();
      const coreWidth = noise < 0.15 ? 3.0 : 3.2 + noise * 3.0;
      ctx.strokeStyle = baseColor;
      ctx.lineWidth = coreWidth;
      ctx.lineCap = 'round';
      ctx.shadowColor = baseColor;
      ctx.shadowBlur = noise < 0.15 ? 8 : 4;
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(curr.x, curr.y);
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();
  }

  private drawLivePlayhead(
    ctx: CanvasRenderingContext2D,
    H: number,
    headX: number,
    instrument: InstrumentSpec,
    gridMode: GridMode,
    latestFrame: TelemetryFrame | null,
    isPaused: boolean
  ): void {
    ctx.save();

    // Vertical Playhead Line at 75% Width (Spec 3.A)
    const grad = ctx.createLinearGradient(headX, 0, headX, H);
    grad.addColorStop(0, 'rgba(56, 189, 248, 0.05)');
    grad.addColorStop(0.25, 'rgba(56, 189, 248, 0.38)');
    grad.addColorStop(0.5, 'rgba(56, 189, 248, 0.55)');
    grad.addColorStop(0.75, 'rgba(56, 189, 248, 0.38)');
    grad.addColorStop(1, 'rgba(56, 189, 248, 0.05)');

    ctx.strokeStyle = grad;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(headX, 0);
    ctx.lineTo(headX, H);
    ctx.stroke();

    if (!latestFrame) {
      ctx.restore();
      return;
    }

    const headY = this.midiToY(latestFrame.primaryMidi);

    // Secondary 2nd String Live Indicator at 75% head
    if (
      !latestFrame.isSilent &&
      latestFrame.secondaryMidi !== null &&
      latestFrame.secondaryRms > 0.06
    ) {
      const secY = this.midiToY(latestFrame.secondaryMidi);
      const secString =
        latestFrame.secondaryStringIndex !== null
          ? instrument.strings[latestFrame.secondaryStringIndex]
          : findClosestString(instrument, latestFrame.secondaryMidi);

      ctx.save();
      ctx.fillStyle = secString.color;
      ctx.shadowColor = secString.color;
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(headX, secY, 5 + latestFrame.secondaryRms * 3, 0, Math.PI * 2);
      ctx.fill();

      // Warning pill left of headX
      const warnText = `2-я струна: ${secString.nameRu} (${Math.round(latestFrame.secondaryRms * 100)}%)`;
      ctx.font = '600 11px "Inter", -apple-system, BlinkMacSystemFont, sans-serif';
      const tw = ctx.measureText(warnText).width;
      const bx = headX - tw - 26;
      const by = secY - 11;

      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
      this.roundRect(ctx, bx, by, tw + 16, 22, 6);
      ctx.fill();
      ctx.strokeStyle = secString.color;
      ctx.lineWidth = 1.2;
      this.roundRect(ctx, bx, by, tw + 16, 22, 6);
      ctx.stroke();

      ctx.fillStyle = '#F8FAFC';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(warnText, bx + 8, secY);
      ctx.restore();
    }

    // Primary Live Head Orb
    if (latestFrame.isSilent) {
      // Ghost Thread Head (subtle hollow ring)
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.32)';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(headX, headY, 5.5, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      const color = getIntonationColor(latestFrame.centsOffset, 1);
      const noise = latestFrame.noisiness;

      // Outer aura ring proportional to bow noise
      ctx.fillStyle = getIntonationColor(latestFrame.centsOffset, 0.25);
      ctx.beginPath();
      ctx.arc(headX, headY, 9 + noise * 14, 0, Math.PI * 2);
      ctx.fill();

      // Crisp glowing core
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 14;
      ctx.beginPath();
      ctx.arc(headX, headY, 5.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#FFFFFF';
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.arc(headX, headY, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Top marker label for 75% head
    ctx.fillStyle = isPaused ? 'rgba(245, 158, 11, 0.85)' : 'rgba(56, 189, 248, 0.75)';
    ctx.font = '600 10.5px "Inter", -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(isPaused ? 'ТОЧКА ОСМОТРА (75%)' : 'СЕЙЧАС (75%)', headX, 68);

    ctx.restore();
  }

  private drawReplayPlayhead(
    ctx: CanvasRenderingContext2D,
    frames: TelemetryFrame[],
    H: number,
    headX: number,
    viewRightTime: number,
    pixelsPerSecond: number,
    replayTime: number,
    gridMode: GridMode
  ): void {
    const x = headX - (viewRightTime - replayTime) * pixelsPerSecond;
    if (x < 0 || x > this.width) return;

    ctx.save();
    ctx.strokeStyle = '#F59E0B';
    ctx.lineWidth = 2.2;
    ctx.shadowColor = 'rgba(245, 158, 11, 0.6)';
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.moveTo(x, 56);
    ctx.lineTo(x, H - 64);
    ctx.stroke();

    const frame = this.findFrameAtTime(frames, replayTime);
    if (frame) {
      const y = this.midiToY(frame.primaryMidi);
      ctx.fillStyle = '#F59E0B';
      ctx.beginPath();
      ctx.arc(x, y, 6.5, 0, Math.PI * 2);
      ctx.fill();

      const pc = getPitchClassInfo(frame.nearestMidi);
      const custom = KEY_SIGNATURES[gridMode].customLabels?.[pc.pc] ?? pc.solfege;
      const centsStr =
        frame.centsOffset >= 0
          ? `+${Math.round(frame.centsOffset)}¢`
          : `${Math.round(frame.centsOffset)}¢`;
      const label = `▶ ${custom}${getOctaveNumber(frame.nearestMidi)} (${centsStr})`;

      ctx.shadowBlur = 0;
      ctx.font = '700 11.5px "Inter", -apple-system, BlinkMacSystemFont, sans-serif';
      const tw = ctx.measureText(label).width;
      const bx = Math.max(8, Math.min(this.width - tw - 20, x - tw / 2 - 8));
      const by = Math.max(66, y - 34);

      ctx.fillStyle = 'rgba(245, 158, 11, 0.95)';
      this.roundRect(ctx, bx, by, tw + 16, 22, 6);
      ctx.fill();

      ctx.fillStyle = '#0B0F19';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, bx + 8, by + 11);
    }

    ctx.restore();
  }

  public findFrameAtTime(frames: TelemetryFrame[], targetTime: number): TelemetryFrame | null {
    if (frames.length === 0) return null;
    let lo = 0;
    let hi = frames.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (frames[mid].time < targetTime) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return frames[lo] ?? frames[frames.length - 1];
  }

  private roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number
  ): void {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  }
}
