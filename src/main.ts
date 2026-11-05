import {
  GridMode,
  InstrumentId,
  InstrumentSpec,
  ReferencePitch,
  SimulatorState,
  TelemetryFrame,
} from './types';
import {
  formatMidiNoteRu,
  getIntonationColor,
  INSTRUMENTS,
  KEY_SIGNATURES,
  midiToFreq,
  STRING_COLORS,
} from './music';
import { AudioEngine } from './audioEngine';
import { SoundCanvasRenderer } from './canvasRenderer';

const MIC_SVG_ICON = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path>
    <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
    <line x1="12" x2="12" y1="19" y2="22"></line>
  </svg>
`;

const PLAY_SVG_ICON = `
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <polygon points="6 4 20 12 6 20 6 4"></polygon>
  </svg>
`;

const PAUSE_SVG_ICON = `
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <rect x="6" y="4" width="4" height="16" rx="1"></rect>
    <rect x="14" y="4" width="4" height="16" rx="1"></rect>
  </svg>
`;

class StringsVisualCoachApp {
  private root: HTMLElement;
  private currentScreen: 'setup' | 'live' = 'setup';
  private selectedInstrument: InstrumentSpec = INSTRUMENTS.violin;
  private refA4: ReferencePitch = 442;
  private gridMode: GridMode = 'natural-dashed';

  private audioEngine: AudioEngine;
  private renderer: SoundCanvasRenderer | null = null;

  // Recording / Replay state
  // isPaused === false means actively recording live input/simulator
  private isPaused = false;
  private scrubbedSessionTime = 0;
  private sessionClockSeconds = 0;
  private lastRafTime = performance.now();
  private rafId: number | null = null;

  // Built-in Interactive Simulator state
  private simulator: SimulatorState = {
    enabled: true,
    drawerOpen: true,
    playing: true,
    targetMidi: 69, // A4 (Ля4)
    centsOffset: 0,
    bowNoise: 6,
    secondStringLeak: 0,
    secondStringIndex: -1,
    vibrato: 5,
    autoMode: 'etude',
    monitorAudible: false,
    monitorVolume: 65,
  };

  private autoPhaseTime = 0;

  // Canvas drag-to-scrub state
  private isDraggingCanvas = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragStartSessionTime = 0;
  private dragStartCameraMidi = 65;

  // Screen Wake Lock to prevent tablet/phone screen from sleeping during practice
  private wakeLockSentinel: WakeLockSentinel | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.audioEngine = new AudioEngine(this.selectedInstrument, this.refA4);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        void this.syncWakeLock();
      }
    });

    // Re-ensure wake lock on user gesture if browser required interaction first
    document.addEventListener(
      'pointerdown',
      () => {
        if (this.currentScreen === 'live' && (!this.isPaused || this.audioEngine.isReplaying)) {
          void this.syncWakeLock();
        }
      },
      { passive: true }
    );

    this.renderCurrentScreen();
  }

  private async syncWakeLock(): Promise<void> {
    const shouldKeepAwake =
      this.currentScreen === 'live' &&
      (!this.isPaused || this.audioEngine.isReplaying) &&
      document.visibilityState === 'visible';

    if (shouldKeepAwake) {
      if (this.wakeLockSentinel && !this.wakeLockSentinel.released) {
        return;
      }
      if ('wakeLock' in navigator && navigator.wakeLock) {
        try {
          this.wakeLockSentinel = await navigator.wakeLock.request('screen');
          this.wakeLockSentinel.addEventListener('release', () => {
            this.wakeLockSentinel = null;
          });
        } catch {
          // Ignore if browser blocks wakeLock (e.g., low battery mode)
        }
      }
    } else if (this.wakeLockSentinel) {
      try {
        await this.wakeLockSentinel.release();
      } catch {
        // ignore
      }
      this.wakeLockSentinel = null;
    }
  }

  private renderCurrentScreen(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.audioEngine.stopRecordedPlayback();
    void this.syncWakeLock();

    if (this.currentScreen === 'setup') {
      this.renderSetupScreen();
    } else {
      this.renderLiveScreen();
    }
  }

  /* ==========================================================================
     SCREEN 1: INSTRUMENT SELECTION & SETUP
     ========================================================================== */
  private renderSetupScreen(): void {
    const instrumentOrder: InstrumentId[] = ['violin', 'viola', 'cello', 'bass'];

    const cardsHtml = instrumentOrder
      .map((id) => {
        const inst = INSTRUMENTS[id];
        const stringsHtml = inst.strings
          .map(
            (s) => `
            <div class="string-chip" style="--chip-color: ${s.color}">
              <span class="string-chip-roman">Струна ${s.roman}</span>
              <span class="string-chip-solfege">${s.nameRu}</span>
              <span class="string-chip-en">${s.noteEn} • ${midiToFreq(s.midi, this.refA4).toFixed(1)} Гц</span>
            </div>
          `
          )
          .join('');

        return `
          <button type="button" class="instrument-card" data-instrument="${inst.id}">
            <div class="instrument-card-top">
              <div class="instrument-title-block">
                <h2>${inst.nameRu} <span>${inst.nameEn}</span></h2>
                <p class="instrument-desc">${inst.descriptionRu}</p>
              </div>
              <span class="instrument-range-pill">${inst.rangeLabel}</span>
            </div>
            <div class="strings-row">
              ${stringsHtml}
            </div>
          </button>
        `;
      })
      .join('');

    this.root.innerHTML = `
      <main class="setup-screen">
        <div class="setup-container">
          <header class="setup-header">
            <div class="brand-title-group">
              <span class="brand-badge">● Strings Visual Coach • MVP</span>
              <h1>Выберите ваш инструмент</h1>
              <p>Визуальный тренер интонации, чистоты штриха и контроля открытых струн</p>
            </div>
            <div class="pitch-selector-box" role="group" aria-label="Камертон Ля первой октавы">
              <span class="pitch-selector-label">A4:</span>
              <div class="pitch-segment-group">
                ${([440, 442, 443] as ReferencePitch[])
                  .map(
                    (hz) => `
                  <button
                    type="button"
                    class="pitch-btn ${this.refA4 === hz ? 'active' : ''}"
                    data-ref-hz="${hz}"
                  >${hz} Гц</button>
                `
                  )
                  .join('')}
              </div>
            </div>
          </header>

          <section class="instrument-grid" aria-label="Карточки струнных инструментов">
            ${cardsHtml}
          </section>

          <footer class="setup-footer">
            <span>Цвета открытых струн:</span>
            <div class="string-legend-items">
              <span class="legend-dot-item"><i class="color-dot" style="background:${STRING_COLORS.IV.color}"></i> IV — Синий</span>
              <span class="legend-dot-item"><i class="color-dot" style="background:${STRING_COLORS.III.color}"></i> III — Янтарный</span>
              <span class="legend-dot-item"><i class="color-dot" style="background:${STRING_COLORS.II.color}"></i> II — Изумрудный</span>
              <span class="legend-dot-item"><i class="color-dot" style="background:${STRING_COLORS.I.color}"></i> I — Коралловый</span>
            </div>
          </footer>
        </div>
      </main>
    `;

    this.root.querySelectorAll<HTMLButtonElement>('[data-ref-hz]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const hz = Number(btn.dataset.refHz) as ReferencePitch;
        this.refA4 = hz;
        this.audioEngine.setConfiguration(this.selectedInstrument, this.refA4);
        this.renderSetupScreen();
      });
    });

    this.root.querySelectorAll<HTMLButtonElement>('[data-instrument]').forEach((card) => {
      card.addEventListener('click', async () => {
        const id = card.dataset.instrument as InstrumentId;
        await this.selectInstrumentAndLaunch(id);
      });
    });
  }

  public async selectInstrumentAndLaunch(id: InstrumentId): Promise<void> {
    this.selectedInstrument = INSTRUMENTS[id];
    this.simulator.targetMidi = this.selectedInstrument.strings[2].midi;
    this.simulator.centsOffset = 0;
    this.isPaused = false;
    this.audioEngine.isRecordingBuffer = true;
    this.sessionClockSeconds = 0;
    this.scrubbedSessionTime = 0;
    this.autoPhaseTime = 0;

    this.audioEngine.setConfiguration(this.selectedInstrument, this.refA4);
    await this.audioEngine.ensureContext();

    this.currentScreen = 'live';
    this.renderCurrentScreen();
  }

  /* ==========================================================================
     SCREEN 2: THE LIVE SOUND CANVAS
     ========================================================================== */
  private renderLiveScreen(): void {
    const inst = this.selectedInstrument;
    const stringDotsHtml = inst.strings
      .map((s) => `<span style="background:${s.color}" title="Струна ${s.roman}: ${s.nameRu} (${s.noteEn})"></span>`)
      .join('');

    const gridOptionsHtml = (Object.keys(KEY_SIGNATURES) as GridMode[])
      .map(
        (mode) =>
          `<option value="${mode}" ${this.gridMode === mode ? 'selected' : ''}>${KEY_SIGNATURES[mode].labelRu}</option>`
      )
      .join('');

    const noteOptionsHtml: string[] = [];
    for (let m = inst.strings[0].midi - 2; m <= inst.strings[3].midi + 7; m++) {
      const openStr = inst.strings.find((s) => s.midi === m);
      const label = openStr
        ? `★ ${formatMidiNoteRu(m, this.gridMode)} (${openStr.noteEn} • ${openStr.roman})`
        : `${formatMidiNoteRu(m, this.gridMode)} (${midiToFreq(m, this.refA4).toFixed(1)} Гц)`;
      noteOptionsHtml.push(
        `<option value="${m}" ${this.simulator.targetMidi === m ? 'selected' : ''}>${label}</option>`
      );
    }

    const bufferDurations = [30, 60, 120, 180];

    this.root.innerHTML = `
      <div class="live-screen">
        <canvas id="sound-canvas" class="sound-canvas"></canvas>

        <!-- TOP FLOATING BAR -->
        <header class="top-floating-bar">
          <div class="top-bar-group top-left-controls">
            <button type="button" id="btn-back-setup" class="btn-ui" title="Сменить инструмент или строй A4">
              <span>← ${inst.nameRu}</span>
              <span class="string-dots-mini">${stringDotsHtml}</span>
            </button>

            <label for="select-grid-mode" style="display:none;">Строй сетки</label>
            <select id="select-grid-mode" class="select-ui" aria-label="Сетка нот и тональность">
              ${gridOptionsHtml}
            </select>
          </div>

          <!-- LIVE TELEMETRY READOUT (Drops to 2nd row automatically on narrow screens) -->
          <div class="top-bar-group telemetry-readout" id="live-readout">
            <span class="readout-note" id="readout-note">Ля4</span>
            <span class="readout-cents" id="readout-cents">0¢</span>
            <span class="readout-noise-badge" id="readout-status">Шум: 5%</span>
          </div>

          <!-- RIGHT GROUP: ICON-ONLY MICROPHONE BUTTON (Always visible) -->
          <div class="top-bar-group top-right-controls">
            <button
              type="button"
              id="btn-mic-toggle"
              class="btn-ui btn-mic-icon ${this.audioEngine.micActive ? 'active-mic' : ''}"
              title="${this.audioEngine.micActive ? 'Микрофон включён (нажмите, чтобы выключить)' : 'Включить микрофон'}"
              aria-label="Микрофон"
            >
              ${MIC_SVG_ICON}
            </button>
          </div>
        </header>

        <!-- DSP SIMULATOR DRAWER -->
        <aside
          class="sim-drawer ${this.simulator.drawerOpen ? '' : 'drawer-collapsed'}"
          id="sim-drawer"
          aria-label="DSP-Симулятор"
        >
          <div class="sim-drawer-header">
            <button
              type="button"
              id="btn-sim-collapse"
              class="sim-collapse-trigger"
              aria-expanded="${this.simulator.drawerOpen ? 'true' : 'false'}"
              aria-controls="sim-drawer-body"
              title="Свернуть / развернуть DSP-Симулятор"
            >
              <span class="sim-collapse-arrow" id="sim-collapse-arrow">${this.simulator.drawerOpen ? '▾' : '▸'}</span>
              <span>DSP-Симулятор</span>
            </button>

            <div class="sim-header-actions">
              <button
                type="button"
                id="btn-sim-play-silence"
                class="sim-icon-btn ${this.simulator.playing && this.simulator.enabled ? 'playing' : 'paused'}"
                title="Play / Pause симулятора (проверка призрачной нити)"
                aria-label="Play / Pause симулятора"
              >
                ${this.simulator.playing && this.simulator.enabled ? PAUSE_SVG_ICON : PLAY_SVG_ICON}
              </button>
              <button
                type="button"
                id="btn-sim-speaker"
                class="sim-icon-btn ${this.simulator.monitorAudible ? 'speaker-on' : ''}"
                title="Звук симулятора в динамики Вкл / Выкл"
                aria-label="Звук симулятора в динамики"
              >
                ${this.simulator.monitorAudible ? '🔊' : '🔇'}
              </button>
            </div>
          </div>

          <div
            id="sim-drawer-body"
            class="sim-drawer-body ${this.simulator.drawerOpen ? '' : 'is-collapsed'}"
            ${this.simulator.drawerOpen ? '' : 'hidden'}
          >
            <div class="sim-drawer-inner">
              <!-- Compact Mode Buttons (no redundant headers or labels) -->
              <div class="sim-controls-inline">
                <button type="button" class="sim-preset-btn ${this.simulator.autoMode === 'etude' ? 'active' : ''}" data-sim-mode="etude">Авто-этюд</button>
                <button type="button" class="sim-preset-btn ${this.simulator.autoMode === 'scale' ? 'active' : ''}" data-sim-mode="scale">Гамма</button>
                <button type="button" class="sim-preset-btn ${this.simulator.autoMode === 'open-strings' ? 'active' : ''}" data-sim-mode="open-strings">Струны</button>
                <button type="button" class="sim-preset-btn ${this.simulator.autoMode === 'manual' ? 'active' : ''}" data-sim-mode="manual">Ручной</button>
              </div>

              <!-- Target Note & Open String Quick Buttons -->
              <div class="sim-row">
                <div class="sim-row-header">
                  <label for="sim-target-note">Нота:</label>
                  <div class="sim-controls-inline">
                    ${inst.strings
                      .map(
                        (s) => `
                      <button
                        type="button"
                        class="sim-preset-btn"
                        data-quick-midi="${s.midi}"
                        style="border-color:${s.color};color:#F8FAFC;"
                      >${s.roman}:${s.nameRu}</button>
                    `
                      )
                      .join('')}
                  </div>
                </div>
                <select id="sim-target-note" class="select-ui" style="max-width:100%;">
                  ${noteOptionsHtml.join('')}
                </select>
              </div>

              <!-- Cents Offset Slider (-50 to +50) -->
              <div class="sim-row">
                <div class="sim-row-header">
                  <label for="sim-cents-slider">Интонация (Cents):</label>
                  <span class="sim-row-val" id="sim-cents-val">${this.formatCents(this.simulator.centsOffset)}</span>
                </div>
                <input
                  type="range"
                  id="sim-cents-slider"
                  class="sim-slider"
                  min="-50"
                  max="50"
                  step="1"
                  value="${this.simulator.centsOffset}"
                />
              </div>

              <!-- Bow Noise / Scratch Slider (0% to 100%) -->
              <div class="sim-row">
                <div class="sim-row-header">
                  <label for="sim-noise-slider">Шум смычка (Blur):</label>
                  <span class="sim-row-val" id="sim-noise-val">${Math.round(this.simulator.bowNoise)}%</span>
                </div>
                <input
                  type="range"
                  id="sim-noise-slider"
                  class="sim-slider"
                  min="0"
                  max="100"
                  step="1"
                  value="${Math.round(this.simulator.bowNoise)}"
                />
              </div>

              <!-- Adjacent Open String Leak Slider (0% to 100%) -->
              <div class="sim-row">
                <div class="sim-row-header">
                  <label for="sim-leak-slider">2-я открытая струна:</label>
                  <span class="sim-row-val" id="sim-leak-val">${Math.round(this.simulator.secondStringLeak)}%</span>
                </div>
                <input
                  type="range"
                  id="sim-leak-slider"
                  class="sim-slider"
                  min="0"
                  max="100"
                  step="1"
                  value="${Math.round(this.simulator.secondStringLeak)}"
                />
              </div>
            </div>
          </div>
        </aside>

        <!-- BOTTOM TRANSPORT & REPLAY BAR -->
        <footer class="bottom-transport-bar">
          <!-- Main Large Record / Stop Icon Button -->
          <button
            type="button"
            id="btn-record-stop"
            class="btn-record-main ${this.isPaused ? '' : 'is-recording'}"
            title="${this.isPaused ? 'Начать запись в реальном времени' : 'Остановить запись'}"
            aria-label="${this.isPaused ? 'Начать запись' : 'Остановить запись'}"
          >
            <span class="${this.isPaused ? 'record-icon-circle' : 'record-icon-stop'}"></span>
          </button>

          <!-- Play / Pause Recorded Buffer Icon Button -->
          <button
            type="button"
            id="btn-replay-audio"
            class="btn-replay-icon ${this.audioEngine.isReplaying ? 'is-playing' : ''}"
            title="Воспроизвести / Пауза записи"
            aria-label="Воспроизвести или поставить на паузу запись"
          >
            ${this.audioEngine.isReplaying ? PAUSE_SVG_ICON : PLAY_SVG_ICON}
          </button>

          <!-- Timeline Scrubber & Compact Position / Buffer Fill Readouts -->
          <div class="scrubber-container">
            <div class="scrubber-labels">
              <span id="scrubber-left-label">0.0 с</span>
              <span class="scrubber-buffer-right">
                <span id="scrubber-fill-val">0.0</span>
                <span>/</span>
                <select
                  id="select-buffer-max"
                  class="select-buffer-duration"
                  aria-label="Длительность буфера записи"
                  title="Максимальная длительность буфера записи"
                >
                  ${bufferDurations
                    .map(
                      (sec) =>
                        `<option value="${sec}" ${this.audioEngine.maxHistorySeconds === sec ? 'selected' : ''}>${sec} сек</option>`
                    )
                    .join('')}
                </select>
              </span>
            </div>
            <input
              type="range"
              id="timeline-scrubber"
              class="timeline-scrubber"
              min="0"
              max="1"
              step="0.02"
              value="0"
              aria-label="Позиция в буфере записи"
            />
          </div>
        </footer>
      </div>
    `;

    const canvas = this.root.querySelector<HTMLCanvasElement>('#sound-canvas')!;
    this.renderer = new SoundCanvasRenderer(canvas, this.selectedInstrument);

    this.bindLiveScreenEvents(canvas);
    this.setupRangeFallbackProgress();

    this.lastRafTime = performance.now();
    this.rafId = requestAnimationFrame((ts) => this.tick(ts));
  }

  private formatCents(c: number): string {
    const r = Math.round(c);
    return r > 0 ? `+${r}¢` : `${r}¢`;
  }

  private bindLiveScreenEvents(canvas: HTMLCanvasElement): void {
    // 1. Back to Instrument Selection (Screen 1)
    const backBtn = this.root.querySelector<HTMLButtonElement>('#btn-back-setup');
    backBtn?.addEventListener('click', () => {
      this.currentScreen = 'setup';
      this.renderCurrentScreen();
    });

    // 2. Grid Mode / Key Signature selector
    const gridSelect = this.root.querySelector<HTMLSelectElement>('#select-grid-mode');
    gridSelect?.addEventListener('change', () => {
      this.gridMode = gridSelect.value as GridMode;
    });

    // 3. Icon-Only Microphone Toggle (Always accessible on phones/tablets)
    const micBtn = this.root.querySelector<HTMLButtonElement>('#btn-mic-toggle');
    micBtn?.addEventListener('click', async () => {
      if (this.audioEngine.micActive) {
        this.audioEngine.disableMicrophone();
        micBtn.classList.remove('active-mic', 'error-mic');
        micBtn.title = 'Включить микрофон';
      } else {
        // Pause simulator synthesis so microphone input is clean, and collapse simulator drawer on mobile
        this.simulator.enabled = false;
        this.simulator.playing = false;
        const ok = await this.audioEngine.enableMicrophone();
        if (ok) {
          micBtn.classList.remove('error-mic');
          micBtn.classList.add('active-mic');
          micBtn.title = 'Микрофон включён (нажмите, чтобы выключить)';
          if (window.innerWidth < 780) {
            this.setDrawerOpen(false);
          }
          // Ensure recording is active when user turns on microphone
          if (this.isPaused) {
            this.startRecording();
          }
          this.syncSimulatorUI();
        } else {
          micBtn.classList.add('error-mic');
          micBtn.title = this.audioEngine.micError ?? 'Нет доступа к микрофону';
        }
      }
    });

    // 4. Simulator Drawer Collapse Toggle (Arrow at start of header)
    const simCollapseBtn = this.root.querySelector<HTMLButtonElement>('#btn-sim-collapse');
    const simDrawerBody = this.root.querySelector<HTMLElement>('#sim-drawer-body');

    simDrawerBody?.addEventListener('transitionend', (e: TransitionEvent) => {
      if (e.propertyName === 'block-size' && simDrawerBody.classList.contains('is-collapsed')) {
        simDrawerBody.hidden = true;
      }
    });

    simCollapseBtn?.addEventListener('click', () => {
      this.setDrawerOpen(!this.simulator.drawerOpen);
    });

    // 5. Simulator Speaker Monitor Toggle
    const speakerBtn = this.root.querySelector<HTMLButtonElement>('#btn-sim-speaker');
    speakerBtn?.addEventListener('click', async () => {
      await this.audioEngine.ensureContext();
      this.simulator.monitorAudible = !this.simulator.monitorAudible;
      this.syncSimulatorUI();
    });

    // 6. Simulator Play / Pause Icon Button
    const playSilenceBtn = this.root.querySelector<HTMLButtonElement>('#btn-sim-play-silence');
    playSilenceBtn?.addEventListener('click', async () => {
      await this.audioEngine.ensureContext();
      if (!this.simulator.enabled) {
        this.simulator.enabled = true;
        this.simulator.playing = true;
      } else {
        this.simulator.playing = !this.simulator.playing;
      }
      if (!this.simulator.playing) {
        this.simulator.autoMode = 'manual';
      }
      this.syncSimulatorUI();
    });

    // 7. Simulator Mode Preset Buttons
    this.root.querySelectorAll<HTMLButtonElement>('[data-sim-mode]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await this.audioEngine.ensureContext();
        const mode = btn.dataset.simMode as SimulatorState['autoMode'];
        this.simulator.enabled = true;
        this.simulator.autoMode = mode;
        this.simulator.playing = true;
        this.autoPhaseTime = 0;
        this.syncSimulatorUI();
      });
    });

    // 8. Quick Open String Buttons
    this.root.querySelectorAll<HTMLButtonElement>('[data-quick-midi]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await this.audioEngine.ensureContext();
        this.simulator.enabled = true;
        this.simulator.autoMode = 'manual';
        this.simulator.playing = true;
        this.simulator.targetMidi = Number(btn.dataset.quickMidi);
        this.simulator.centsOffset = 0;
        this.syncSimulatorUI();
      });
    });

    // 9. Target Note Select
    const targetNoteSelect = this.root.querySelector<HTMLSelectElement>('#sim-target-note');
    targetNoteSelect?.addEventListener('change', async () => {
      await this.audioEngine.ensureContext();
      this.simulator.enabled = true;
      this.simulator.autoMode = 'manual';
      this.simulator.targetMidi = Number(targetNoteSelect.value);
      this.syncSimulatorUI();
    });

    // 10. Simulator Sliders
    const centsSlider = this.root.querySelector<HTMLInputElement>('#sim-cents-slider');
    centsSlider?.addEventListener('input', () => {
      this.simulator.enabled = true;
      this.simulator.autoMode = 'manual';
      this.simulator.centsOffset = Number(centsSlider.value);
      this.syncSimulatorUI();
    });

    const noiseSlider = this.root.querySelector<HTMLInputElement>('#sim-noise-slider');
    noiseSlider?.addEventListener('input', () => {
      this.simulator.enabled = true;
      this.simulator.autoMode = 'manual';
      this.simulator.bowNoise = Number(noiseSlider.value);
      this.syncSimulatorUI();
    });

    const leakSlider = this.root.querySelector<HTMLInputElement>('#sim-leak-slider');
    leakSlider?.addEventListener('input', () => {
      this.simulator.enabled = true;
      this.simulator.autoMode = 'manual';
      this.simulator.secondStringLeak = Number(leakSlider.value);
      this.syncSimulatorUI();
    });

    // 11. Bottom Bar: Main Record / Stop Button
    const recordStopBtn = this.root.querySelector<HTMLButtonElement>('#btn-record-stop');
    recordStopBtn?.addEventListener('click', () => {
      if (this.isPaused) {
        this.startRecording();
      } else {
        this.stopRecordingAtEnd();
      }
    });

    // 12. Bottom Bar: Play / Pause Replay Button
    // - If clicked while recording: stops recording, jumps scrubber to start of buffer, and plays from start!
    // - If clicked while stopped: toggles Play / Pause from the current scrubber position without resetting!
    const replayBtn = this.root.querySelector<HTMLButtonElement>('#btn-replay-audio');
    replayBtn?.addEventListener('click', async () => {
      const bounds = this.audioEngine.getHistoryBounds();
      if (bounds.duration < 0.1) return;

      if (!this.isPaused) {
        // Recording was running -> stop recording, jump to start of available buffer, and play!
        this.isPaused = true;
        this.audioEngine.isRecordingBuffer = false;
        this.scrubbedSessionTime = bounds.minTime;
        await this.audioEngine.startRecordedPlayback(this.scrubbedSessionTime, () => {
          this.scrubbedSessionTime = this.audioEngine.getHistoryBounds().maxTime;
          this.syncTransportUI();
        });
        this.syncTransportUI();
        return;
      }

      // Already stopped recording -> toggle Play / Pause without resetting position
      if (this.audioEngine.isReplaying) {
        const pausedAt = this.audioEngine.stopRecordedPlayback();
        if (pausedAt !== null) {
          this.scrubbedSessionTime = pausedAt;
        }
        this.syncTransportUI();
      } else {
        // If scrubber is at the very end of the buffer, start from beginning of buffer; otherwise continue from current position
        if (this.scrubbedSessionTime >= bounds.maxTime - 0.12) {
          this.scrubbedSessionTime = bounds.minTime;
        }
        await this.audioEngine.startRecordedPlayback(this.scrubbedSessionTime, () => {
          this.scrubbedSessionTime = this.audioEngine.getHistoryBounds().maxTime;
          this.syncTransportUI();
        });
        this.syncTransportUI();
      }
    });

    // 13. Bottom Bar: Buffer Duration Selector (30 / 60 / 120 / 180 sec)
    const bufferMaxSelect = this.root.querySelector<HTMLSelectElement>('#select-buffer-max');
    bufferMaxSelect?.addEventListener('change', () => {
      const sec = Number(bufferMaxSelect.value);
      this.audioEngine.setMaxHistorySeconds(sec);
      this.syncTransportUI();
    });

    // 14. Bottom Bar: Timeline Scrubber (0 .. maxHistorySeconds scale)
    const scrubber = this.root.querySelector<HTMLInputElement>('#timeline-scrubber');
    scrubber?.addEventListener('input', () => {
      const bounds = this.audioEngine.getHistoryBounds();
      const maxBuf = this.audioEngine.maxHistorySeconds;
      const filledSec = Math.min(maxBuf, bounds.duration);

      if (!this.isPaused) {
        this.isPaused = true;
        this.audioEngine.isRecordingBuffer = false;
      }
      if (this.audioEngine.isReplaying) {
        this.audioEngine.stopRecordedPlayback();
      }

      const clampedPos = Math.max(0, Math.min(filledSec, Number(scrubber.value)));
      scrubber.value = clampedPos.toFixed(2);
      this.scrubbedSessionTime = bounds.minTime + clampedPos;
      this.syncTransportUI();
    });

    // 15. Canvas Dragging (horizontal time scrub + vertical pitch pan)
    canvas.addEventListener('pointerdown', (ev: PointerEvent) => {
      this.isDraggingCanvas = true;
      this.dragStartX = ev.clientX;
      this.dragStartY = ev.clientY;
      const bounds = this.audioEngine.getHistoryBounds();
      this.dragStartSessionTime = this.isPaused ? this.scrubbedSessionTime : bounds.maxTime;
      this.dragStartCameraMidi =
        this.renderer?.cameraCenterMidi ?? this.selectedInstrument.defaultCenterMidi;
      canvas.setPointerCapture(ev.pointerId);
    });

    canvas.addEventListener('pointermove', (ev: PointerEvent) => {
      if (!this.isDraggingCanvas || !this.renderer) return;
      const dx = ev.clientX - this.dragStartX;
      const dy = ev.clientY - this.dragStartY;

      if (Math.abs(dx) > 6 && !this.isPaused) {
        this.isPaused = true;
        this.audioEngine.isRecordingBuffer = false;
      }

      if (this.isPaused) {
        if (this.audioEngine.isReplaying && Math.abs(dx) > 4) {
          this.audioEngine.stopRecordedPlayback();
        }
        const headX = canvas.clientWidth * 0.75;
        const pixelsPerSec = headX / this.renderer.getHistoryWindowSeconds();
        const timeDelta = -dx / pixelsPerSec;
        const bounds = this.audioEngine.getHistoryBounds();
        this.scrubbedSessionTime = Math.max(
          bounds.minTime,
          Math.min(bounds.maxTime, this.dragStartSessionTime + timeDelta)
        );

        const midiDelta = (dy / canvas.clientHeight) * 14;
        this.renderer.cameraCenterMidi = Math.max(
          24,
          Math.min(96, this.dragStartCameraMidi + midiDelta)
        );
        this.syncTransportUI();
      }
    });

    const endDrag = () => {
      this.isDraggingCanvas = false;
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    window.addEventListener('resize', () => {
      this.renderer?.resize();
    });
  }

  private setDrawerOpen(open: boolean): void {
    this.simulator.drawerOpen = open;
    const simDrawer = this.root.querySelector<HTMLElement>('#sim-drawer');
    const simDrawerBody = this.root.querySelector<HTMLElement>('#sim-drawer-body');
    const simCollapseBtn = this.root.querySelector<HTMLButtonElement>('#btn-sim-collapse');
    const arrowEl = this.root.querySelector<HTMLElement>('#sim-collapse-arrow');

    simDrawer?.classList.toggle('drawer-collapsed', !open);
    if (simDrawerBody) {
      if (open) {
        simDrawerBody.hidden = false;
        void simDrawerBody.offsetHeight;
        simDrawerBody.classList.remove('is-collapsed');
      } else {
        simDrawerBody.classList.add('is-collapsed');
      }
    }
    simCollapseBtn?.setAttribute('aria-expanded', String(open));
    if (arrowEl) {
      arrowEl.textContent = open ? '▾' : '▸';
    }
  }

  private startRecording(): void {
    this.audioEngine.stopRecordedPlayback();
    this.isPaused = false;
    this.audioEngine.isRecordingBuffer = true;
    const bounds = this.audioEngine.getHistoryBounds();
    this.scrubbedSessionTime = bounds.maxTime;
    this.syncTransportUI();
  }

  private stopRecordingAtEnd(): void {
    this.audioEngine.stopRecordedPlayback();
    this.isPaused = true;
    this.audioEngine.isRecordingBuffer = false;
    const bounds = this.audioEngine.getHistoryBounds();
    this.scrubbedSessionTime = bounds.maxTime;
    this.syncTransportUI();
  }

  private syncSimulatorUI(): void {
    const speakerBtn = this.root.querySelector<HTMLButtonElement>('#btn-sim-speaker');
    if (speakerBtn) {
      const spkState = this.simulator.monitorAudible ? 'on' : 'off';
      if (speakerBtn.dataset.iconState !== spkState) {
        speakerBtn.dataset.iconState = spkState;
        speakerBtn.classList.toggle('speaker-on', this.simulator.monitorAudible);
        speakerBtn.textContent = this.simulator.monitorAudible ? '🔊' : '🔇';
      }
    }

    const playSilenceBtn = this.root.querySelector<HTMLButtonElement>('#btn-sim-play-silence');
    if (playSilenceBtn) {
      const isSimPlaying = this.simulator.playing && this.simulator.enabled;
      const simPlayState = isSimPlaying ? 'playing' : 'paused';
      if (playSilenceBtn.dataset.iconState !== simPlayState) {
        playSilenceBtn.dataset.iconState = simPlayState;
        playSilenceBtn.className = `sim-icon-btn ${simPlayState}`;
        playSilenceBtn.innerHTML = isSimPlaying ? PAUSE_SVG_ICON : PLAY_SVG_ICON;
      }
    }

    this.root.querySelectorAll<HTMLButtonElement>('[data-sim-mode]').forEach((btn) => {
      btn.classList.toggle(
        'active',
        this.simulator.enabled && btn.dataset.simMode === this.simulator.autoMode
      );
    });

    const targetSelect = this.root.querySelector<HTMLSelectElement>('#sim-target-note');
    if (targetSelect && Number(targetSelect.value) !== this.simulator.targetMidi) {
      targetSelect.value = String(this.simulator.targetMidi);
    }

    const centsSlider = this.root.querySelector<HTMLInputElement>('#sim-cents-slider');
    const centsVal = this.root.querySelector<HTMLElement>('#sim-cents-val');
    if (centsSlider && !centsSlider.matches(':active')) {
      centsSlider.value = String(Math.round(this.simulator.centsOffset));
    }
    if (centsVal) {
      centsVal.textContent = this.formatCents(this.simulator.centsOffset);
    }

    const noiseSlider = this.root.querySelector<HTMLInputElement>('#sim-noise-slider');
    const noiseVal = this.root.querySelector<HTMLElement>('#sim-noise-val');
    if (noiseSlider && !noiseSlider.matches(':active')) {
      noiseSlider.value = String(Math.round(this.simulator.bowNoise));
    }
    if (noiseVal) {
      noiseVal.textContent = `${Math.round(this.simulator.bowNoise)}%`;
    }

    const leakSlider = this.root.querySelector<HTMLInputElement>('#sim-leak-slider');
    const leakVal = this.root.querySelector<HTMLElement>('#sim-leak-val');
    if (leakSlider && !leakSlider.matches(':active')) {
      leakSlider.value = String(Math.round(this.simulator.secondStringLeak));
    }
    if (leakVal) {
      leakVal.textContent = `${Math.round(this.simulator.secondStringLeak)}%`;
    }
  }

  private syncTransportUI(): void {
    const recordStopBtn = this.root.querySelector<HTMLButtonElement>('#btn-record-stop');
    const replayBtn = this.root.querySelector<HTMLButtonElement>('#btn-replay-audio');
    const scrubber = this.root.querySelector<HTMLInputElement>('#timeline-scrubber');
    const leftLabel = this.root.querySelector<HTMLElement>('#scrubber-left-label');
    const fillVal = this.root.querySelector<HTMLElement>('#scrubber-fill-val');

    const bounds = this.audioEngine.getHistoryBounds();
    const maxBuf = this.audioEngine.maxHistorySeconds;
    const filledSec = Math.min(maxBuf, bounds.duration);

    if (recordStopBtn) {
      const recState = this.isPaused ? 'stopped' : 'recording';
      if (recordStopBtn.dataset.iconState !== recState) {
        recordStopBtn.dataset.iconState = recState;
        recordStopBtn.classList.toggle('is-recording', !this.isPaused);
        recordStopBtn.title = this.isPaused
          ? 'Начать запись в реальном времени'
          : 'Остановить запись';
        recordStopBtn.innerHTML = `<span class="${this.isPaused ? 'record-icon-circle' : 'record-icon-stop'}"></span>`;
        void this.syncWakeLock();
      }
    }

    if (replayBtn) {
      replayBtn.disabled = filledSec < 0.1;
      const playState = this.audioEngine.isReplaying ? 'playing' : 'paused';
      if (replayBtn.dataset.iconState !== playState) {
        replayBtn.dataset.iconState = playState;
        replayBtn.classList.toggle('is-playing', this.audioEngine.isReplaying);
        replayBtn.innerHTML = this.audioEngine.isReplaying ? PAUSE_SVG_ICON : PLAY_SVG_ICON;
        void this.syncWakeLock();
      }
    }

    const currentPosTime = this.isPaused ? this.scrubbedSessionTime : bounds.maxTime;
    const posInBuffer =
      filledSec < 0.05
        ? 0
        : Math.max(0, Math.min(filledSec, currentPosTime - bounds.minTime));
    const offsetFromEnd = filledSec < 0.05 ? 0 : currentPosTime - bounds.maxTime;

    if (scrubber) {
      scrubber.min = '0';
      scrubber.max = String(maxBuf);
      if (!scrubber.matches(':active')) {
        scrubber.value = posInBuffer.toFixed(2);
      }

      const posPct = Math.max(0, Math.min(100, (posInBuffer / maxBuf) * 100));
      const fillPct = Math.max(posPct, Math.min(100, (filledSec / maxBuf) * 100));
      scrubber.style.setProperty('--pos-pct', `${posPct.toFixed(2)}%`);
      scrubber.style.setProperty('--fill-pct', `${fillPct.toFixed(2)}%`);
      scrubber.style.setProperty(
        '--scrubber-active-color',
        this.audioEngine.isReplaying ? '#F59E0B' : '#10B981'
      );
    }

    if (leftLabel) {
      if (Math.abs(offsetFromEnd) < 0.08) {
        leftLabel.textContent = '0.0 с';
      } else {
        leftLabel.textContent = `-${Math.abs(offsetFromEnd).toFixed(1)} с`;
      }
    }

    if (fillVal) {
      fillVal.textContent = filledSec.toFixed(1);
    }
  }

  private stepSimulatorAutoSequence(dt: number): void {
    if (!this.simulator.enabled || !this.simulator.playing || this.simulator.autoMode === 'manual') {
      return;
    }

    this.autoPhaseTime += dt;
    const t = this.autoPhaseTime;
    const s = this.selectedInstrument.strings;
    const baseMidi = s[1].midi;

    if (this.simulator.autoMode === 'open-strings') {
      const idx = Math.floor(t / 2.2) % 4;
      this.simulator.targetMidi = s[idx].midi;
      this.simulator.centsOffset = Math.sin(t * 2.1) * 4;
      this.simulator.bowNoise = 6;
      this.simulator.secondStringLeak = 0;
      this.syncSimulatorUI();
      return;
    }

    if (this.simulator.autoMode === 'scale') {
      const scaleSteps = [0, 2, 4, 6, 7, 9, 11, 12, 11, 9, 7, 6, 4, 2];
      const stepIdx = Math.floor(t / 1.45) % scaleSteps.length;
      this.simulator.targetMidi = baseMidi + scaleSteps[stepIdx];
      this.simulator.centsOffset = Math.sin(t * 3.0) * 5;
      this.simulator.bowNoise = 7;
      this.simulator.secondStringLeak = 0;
      this.syncSimulatorUI();
      return;
    }

    // Default 'etude' mode
    const cycle = t % 16.0;

    if (cycle < 3.0) {
      this.simulator.targetMidi = cycle < 1.5 ? baseMidi : baseMidi + 2;
      this.simulator.centsOffset = Math.sin(t * 4) * 3;
      this.simulator.bowNoise = 5;
      this.simulator.secondStringLeak = 0;
    } else if (cycle < 5.5) {
      // Sustained Semitone (Фа♯ / Соль♭) -> illuminates semitone badge
      this.simulator.targetMidi = baseMidi + 4;
      this.simulator.centsOffset = Math.sin(t * 2.5) * 4;
      this.simulator.bowNoise = 6;
      this.simulator.secondStringLeak = 0;
    } else if (cycle < 8.5) {
      // Intonation drift + Scratchy Bow Noise Aura
      this.simulator.targetMidi = baseMidi + 5;
      this.simulator.centsOffset = Math.sin((cycle - 5.5) * 2.3) * 36;
      this.simulator.bowNoise = 68;
      this.simulator.secondStringLeak = 0;
    } else if (cycle < 12.0) {
      // Accidental 2nd Open String Leak
      this.simulator.targetMidi = baseMidi + 2;
      this.simulator.centsOffset = 2;
      this.simulator.bowNoise = 10;
      this.simulator.secondStringLeak = 62;
    } else {
      // High register climb -> Top 25% Boundary Push & Spring Recentering
      const climbIdx = Math.min(4, Math.floor((cycle - 12.0) / 0.8));
      const climbOffsets = [7, 9, 11, 12, 12];
      this.simulator.targetMidi = baseMidi + climbOffsets[climbIdx];
      this.simulator.centsOffset = 0;
      this.simulator.bowNoise = 7;
      this.simulator.secondStringLeak = 0;
    }

    this.syncSimulatorUI();
  }

  private tick(nowMs: number): void {
    const dt = Math.min(0.1, Math.max(0.001, (nowMs - this.lastRafTime) / 1000));
    this.lastRafTime = nowMs;

    if (!this.isPaused) {
      this.sessionClockSeconds += dt;
      this.stepSimulatorAutoSequence(dt);
      this.audioEngine.updateSimulatorAudio(this.simulator);

      const latestFrame = this.audioEngine.sampleLiveFrame(this.sessionClockSeconds, this.simulator);
      this.scrubbedSessionTime = this.sessionClockSeconds;
      this.renderer?.updateCameraPhysics(latestFrame, dt, false);
      this.updateTopReadout(latestFrame);
      this.syncTransportUI();
    } else {
      this.audioEngine.updateSimulatorAudio({ ...this.simulator, playing: false });
      const replayTime = this.audioEngine.getCurrentReplaySessionTime();
      if (replayTime !== null) {
        this.scrubbedSessionTime = replayTime;
      }
      const inspectedFrame = this.renderer?.findFrameAtTime(
        this.audioEngine.frames,
        this.scrubbedSessionTime
      );
      if (inspectedFrame) {
        this.updateTopReadout(inspectedFrame);
      }
      this.syncTransportUI();
    }

    const bounds = this.audioEngine.getHistoryBounds();
    const viewRightTime = this.isPaused ? this.scrubbedSessionTime : bounds.maxTime;
    const replayCursorTime = this.audioEngine.getCurrentReplaySessionTime();

    this.renderer?.render({
      frames: this.audioEngine.frames,
      instrument: this.selectedInstrument,
      refA4: this.refA4,
      gridMode: this.gridMode,
      viewRightTime,
      replayCursorTime,
      isPaused: this.isPaused,
    });

    this.rafId = requestAnimationFrame((ts) => this.tick(ts));
  }

  private updateTopReadout(frame: TelemetryFrame): void {
    const noteEl = this.root.querySelector<HTMLElement>('#readout-note');
    const centsEl = this.root.querySelector<HTMLElement>('#readout-cents');
    const statusEl = this.root.querySelector<HTMLElement>('#readout-status');

    if (!noteEl || !centsEl || !statusEl) return;

    const noteName = formatMidiNoteRu(frame.nearestMidi, this.gridMode);
    noteEl.textContent = noteName;

    if (frame.isSilent) {
      noteEl.style.color = '#64748B';
      centsEl.textContent = '—';
      centsEl.style.color = '#94A3B8';
      statusEl.textContent = 'Пауза (нить 8%)';
    } else {
      const color = getIntonationColor(frame.centsOffset, 1);
      noteEl.style.color = color;
      centsEl.textContent = this.formatCents(frame.centsOffset);
      centsEl.style.color = color;

      const noisePct = Math.round(frame.noisiness * 100);
      if (frame.secondaryMidi !== null && frame.secondaryRms > 0.08) {
        const secStr =
          frame.secondaryStringIndex !== null
            ? this.selectedInstrument.strings[frame.secondaryStringIndex]
            : null;
        statusEl.textContent = `2-я: ${secStr ? secStr.nameRu : ''} • Шум ${noisePct}%`;
      } else {
        statusEl.textContent = `Шум: ${noisePct}%`;
      }
    }
  }

  private setupRangeFallbackProgress(): void {
    if (typeof CSS !== 'undefined' && !CSS.supports('accent-color', '#10B981')) {
      this.root.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach((slider) => {
        const updateProgress = () => {
          const min = Number(slider.min) || 0;
          const max = Number(slider.max) || 100;
          const val = Number(slider.value) || 0;
          const pct = ((val - min) / Math.max(1, max - min)) * 100;
          slider.style.setProperty('--progress', `${pct}%`);
        };
        updateProgress();
        slider.addEventListener('input', updateProgress);
      });
    }
  }
}

const appRoot = document.getElementById('app');
if (appRoot) {
  new StringsVisualCoachApp(appRoot);
}
