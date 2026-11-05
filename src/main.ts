import {
  FilterSettings,
  getDefaultFilterSettings,
  GridMode,
  InstrumentId,
  InstrumentSpec,
  ReferencePitch,
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
  // isPaused === false means actively recording live microphone input
  private isPaused = false;
  private scrubbedSessionTime = 0;
  private sessionClockSeconds = 0;
  private lastRafTime = performance.now();
  private rafId: number | null = null;

  // DSP Filter Drawer state
  private isFiltersDrawerOpen = false;
  private filterSettings: FilterSettings;

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
    this.filterSettings = getDefaultFilterSettings(this.selectedInstrument.id);
    this.audioEngine.setFilterSettings(this.filterSettings);

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
    this.isPaused = false;
    this.audioEngine.isRecordingBuffer = true;
    this.sessionClockSeconds = 0;
    this.scrubbedSessionTime = 0;

    this.audioEngine.setConfiguration(this.selectedInstrument, this.refA4);
    await this.audioEngine.ensureContext();
    await this.audioEngine.enableMicrophone();

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

          <!-- RIGHT GROUP: CONTROLS & MICROPHONE -->
          <div class="top-bar-group top-right-controls">
            <button
              type="button"
              id="btn-filter-toggle"
              class="btn-ui btn-icon-with-text ${this.isFiltersDrawerOpen ? 'active' : ''}"
              title="Фильтры звука и шумоподавление микрофона"
              aria-label="Фильтры"
            >
              <span>🎛️</span>
              <span class="btn-text-label">Фильтры</span>
            </button>
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

        <!-- DSP FILTERS DRAWER -->
        <aside
          class="sim-drawer ${this.isFiltersDrawerOpen ? '' : 'drawer-collapsed'}"
          id="sim-drawer"
          aria-label="Фильтры звука"
        >
          <div class="sim-drawer-header">
            <span class="drawer-header-title" style="font-weight:700; font-size:14px; color:#F8FAFC; display:flex; align-items:center; gap:6px;">
              <span>🎛️</span>
              <span>Фильтры микрофона</span>
            </span>

            <div class="sim-header-actions">
              <button
                type="button"
                id="btn-drawer-close"
                class="sim-icon-btn"
                title="Закрыть панель фильтров"
                aria-label="Закрыть панель фильтров"
              >
                ✕
              </button>
            </div>
          </div>

          <div
            id="sim-drawer-body"
            class="sim-drawer-body ${this.isFiltersDrawerOpen ? '' : 'is-collapsed'}"
            ${this.isFiltersDrawerOpen ? '' : 'hidden'}
          >
            <div class="sim-drawer-inner" id="drawer-inner-content">
              ${this.getFiltersTabHtml()}
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

  private getFiltersTabHtml(): string {
    const s = this.filterSettings;
    const gateRmsPct = Math.min(100, Math.max(0, (s.noiseGateRms / 0.08) * 100));
    const clarityPct = Math.min(100, Math.max(0, s.clarityThreshold * 100));

    return `
      <!-- LIVE SIGNAL METERS -->
      <div class="filter-meter-card">
        <div class="meter-header">
          <span>Громкость микрофона (RMS):</span>
          <span class="meter-val" id="meter-rms-val">${this.audioEngine.latestRawRms.toFixed(3)}</span>
        </div>
        <div class="meter-bar-track">
          <div class="meter-bar-fill" id="meter-rms-fill" style="width:0%;"></div>
          <div class="meter-threshold-line" id="meter-rms-thresh-line" style="left:${gateRmsPct.toFixed(1)}%;" title="Порог Noise Gate"></div>
        </div>
        <div class="meter-subtext">
          <span id="meter-status-badge" class="badge-status-silent">⚪ Ниже порога (тишина)</span>
        </div>
      </div>

      <div class="filter-meter-card">
        <div class="meter-header">
          <span>Чистота тона (Clarity):</span>
          <span class="meter-val" id="meter-clarity-val">${Math.round(this.audioEngine.latestRawClarity * 100)}%</span>
        </div>
        <div class="meter-bar-track">
          <div class="meter-bar-fill meter-clarity-fill" id="meter-clarity-fill" style="width:0%;"></div>
          <div class="meter-threshold-line" id="meter-clarity-thresh-line" style="left:${clarityPct.toFixed(1)}%;" title="Порог уверенности"></div>
        </div>
      </div>

      <!-- 1. NOISE GATE -->
      <div class="filter-section-title">1. Отсечение шума</div>
      <div class="sim-row">
        <div class="sim-row-header">
          <label class="toggle-label">
            <input type="checkbox" id="chk-noise-gate" ${s.noiseGateEnabled ? 'checked' : ''} />
            <span>Noise Gate (порог RMS):</span>
          </label>
          <span class="sim-row-val" id="val-noise-gate">${s.noiseGateRms.toFixed(3)}</span>
        </div>
        <input
          type="range"
          id="slider-noise-gate"
          class="sim-slider"
          min="0.005"
          max="0.080"
          step="0.002"
          value="${s.noiseGateRms}"
        />
      </div>

      <div class="sim-row">
        <div class="sim-row-header">
          <label for="slider-clarity">Порог чистоты (Clarity):</label>
          <span class="sim-row-val" id="val-clarity">${Math.round(s.clarityThreshold * 100)}%</span>
        </div>
        <input
          type="range"
          id="slider-clarity"
          class="sim-slider"
          min="0.30"
          max="0.85"
          step="0.02"
          value="${s.clarityThreshold}"
        />
      </div>

      <!-- 2. BANDPASS FREQUENCY CUTOFFS -->
      <div class="filter-section-title">2. Срез частот инструмента</div>
      <div class="sim-row">
        <div class="sim-row-header">
          <label class="toggle-label">
            <input type="checkbox" id="chk-highpass" ${s.highPassEnabled ? 'checked' : ''} />
            <span>High-Pass (срез гула/речи):</span>
          </label>
          <span class="sim-row-val" id="val-highpass">${s.highPassFreq} Гц</span>
        </div>
        <input
          type="range"
          id="slider-highpass"
          class="sim-slider"
          min="30"
          max="350"
          step="5"
          value="${s.highPassFreq}"
        />
      </div>

      <div class="sim-row">
        <div class="sim-row-header">
          <label class="toggle-label">
            <input type="checkbox" id="chk-lowpass" ${s.lowPassEnabled ? 'checked' : ''} />
            <span>Low-Pass (срез шипения):</span>
          </label>
          <span class="sim-row-val" id="val-lowpass">${s.lowPassFreq} Гц</span>
        </div>
        <input
          type="range"
          id="slider-lowpass"
          class="sim-slider"
          min="1500"
          max="8000"
          step="100"
          value="${s.lowPassFreq}"
        />
      </div>

      <!-- 3. OCTAVE REJECTION & STABILITY -->
      <div class="filter-section-title">3. Защита от скачков & Стабильность</div>
      <div class="sim-row">
        <label class="toggle-label">
          <input type="checkbox" id="chk-octave-rejection" ${s.octaveJumpRejection ? 'checked' : ''} />
          <span>Подавление октавных удвоений</span>
        </label>
      </div>

      <div class="sim-row">
        <div class="sim-row-header">
          <label>Медианный фильтр:</label>
          <div class="sim-controls-inline">
            <button type="button" class="sim-preset-btn ${s.medianFilterFrames === 1 ? 'active' : ''}" data-median="1">Выкл</button>
            <button type="button" class="sim-preset-btn ${s.medianFilterFrames === 3 ? 'active' : ''}" data-median="3">3 кадра</button>
            <button type="button" class="sim-preset-btn ${s.medianFilterFrames === 5 ? 'active' : ''}" data-median="5">5 кадров</button>
          </div>
        </div>
      </div>

      <div class="sim-row">
        <label class="toggle-label">
          <input type="checkbox" id="chk-break-leap" ${s.breakLineOnLeap ? 'checked' : ''} />
          <span>Разрыв линий при скачках (без полос)</span>
        </label>
      </div>

      <div class="sim-row">
        <label class="toggle-label">
          <input type="checkbox" id="chk-camera-damping" ${s.cameraDampingEnabled ? 'checked' : ''} />
          <span>Плавность камеры (без рывков)</span>
        </label>
      </div>

      <!-- 4. QUICK PRESETS -->
      <div class="filter-section-title">4. Готовые пресеты</div>
      <div class="sim-controls-inline" style="margin-top:2px;">
        <button type="button" class="sim-preset-btn" id="btn-preset-default">Базовый</button>
        <button type="button" class="sim-preset-btn" id="btn-preset-quiet">Тихая игра</button>
        <button type="button" class="sim-preset-btn" id="btn-preset-noisy">Шумная комната</button>
        <button type="button" class="sim-preset-btn" id="btn-preset-raw">Без фильтров</button>
      </div>
    `;
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

    // 3. Icon-Only Microphone Toggle
    const micBtn = this.root.querySelector<HTMLButtonElement>('#btn-mic-toggle');
    micBtn?.addEventListener('click', async () => {
      if (this.audioEngine.micActive) {
        this.audioEngine.disableMicrophone();
        micBtn.classList.remove('active-mic', 'error-mic');
        micBtn.title = 'Включить микрофон';
      } else {
        const ok = await this.audioEngine.enableMicrophone();
        if (ok) {
          micBtn.classList.remove('error-mic');
          micBtn.classList.add('active-mic');
          micBtn.title = 'Микрофон включён (нажмите, чтобы выключить)';
          if (this.isPaused) {
            this.startRecording();
          }
        } else {
          micBtn.classList.add('error-mic');
          micBtn.title = this.audioEngine.micError ?? 'Нет доступа к микрофону';
        }
      }
    });

    // 4. Filter Drawer Toggle & Close
    const filterToggleBtn = this.root.querySelector<HTMLButtonElement>('#btn-filter-toggle');
    filterToggleBtn?.addEventListener('click', () => {
      this.toggleFiltersDrawer();
    });

    const drawerCloseBtn = this.root.querySelector<HTMLButtonElement>('#btn-drawer-close');
    drawerCloseBtn?.addEventListener('click', () => {
      this.setDrawerOpen(false);
    });

    const simDrawerBody = this.root.querySelector<HTMLElement>('#sim-drawer-body');
    simDrawerBody?.addEventListener('transitionend', (e: TransitionEvent) => {
      if (e.propertyName === 'block-size' && simDrawerBody.classList.contains('is-collapsed')) {
        simDrawerBody.hidden = true;
      }
    });

    this.bindFilterTabEvents();

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

      // Always allow vertical dragging to pan camera pitch smoothly
      const midiDelta = (dy / canvas.clientHeight) * 14;
      this.renderer.cameraCenterMidi = Math.max(
        24,
        Math.min(96, this.dragStartCameraMidi + midiDelta)
      );

      // If user drags horizontally while recording live, stop live recording and enter scrubber mode
      if (Math.abs(dx) > 16 && !this.isPaused && Math.abs(dx) > Math.abs(dy)) {
        this.isPaused = true;
        this.audioEngine.isRecordingBuffer = false;
      }

      if (this.isPaused) {
        // If replaying recorded audio, only stop playback on an intentional horizontal scrub
        // (Touching or scrolling vertically must NEVER stop replay!)
        const isHorizontalScrubIntent = Math.abs(dx) > 20 && Math.abs(dx) > Math.abs(dy) * 1.5;

        if (this.audioEngine.isReplaying) {
          if (isHorizontalScrubIntent) {
            this.audioEngine.stopRecordedPlayback();
            const headX = canvas.clientWidth * 0.75;
            const pixelsPerSec = headX / this.renderer.getHistoryWindowSeconds();
            const timeDelta = -dx / pixelsPerSec;
            const bounds = this.audioEngine.getHistoryBounds();
            this.scrubbedSessionTime = Math.max(
              bounds.minTime,
              Math.min(bounds.maxTime, this.dragStartSessionTime + timeDelta)
            );
            this.syncTransportUI();
          }
        } else {
          // Paused, not replaying: normal time scrubbing
          const headX = canvas.clientWidth * 0.75;
          const pixelsPerSec = headX / this.renderer.getHistoryWindowSeconds();
          const timeDelta = -dx / pixelsPerSec;
          const bounds = this.audioEngine.getHistoryBounds();
          this.scrubbedSessionTime = Math.max(
            bounds.minTime,
            Math.min(bounds.maxTime, this.dragStartSessionTime + timeDelta)
          );
          this.syncTransportUI();
        }
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

  private toggleFiltersDrawer(): void {
    this.setDrawerOpen(!this.isFiltersDrawerOpen);
  }

  private setDrawerOpen(open: boolean): void {
    this.isFiltersDrawerOpen = open;
    const simDrawer = this.root.querySelector<HTMLElement>('#sim-drawer');
    const simDrawerBody = this.root.querySelector<HTMLElement>('#sim-drawer-body');
    const filterBtn = this.root.querySelector<HTMLButtonElement>('#btn-filter-toggle');

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
    filterBtn?.classList.toggle('active', open);
  }

  private bindFilterTabEvents(): void {
    const chkGate = this.root.querySelector<HTMLInputElement>('#chk-noise-gate');
    const sliderGate = this.root.querySelector<HTMLInputElement>('#slider-noise-gate');
    const valGate = this.root.querySelector<HTMLElement>('#val-noise-gate');
    const threshLine = this.root.querySelector<HTMLElement>('#meter-rms-thresh-line');

    chkGate?.addEventListener('change', () => {
      this.filterSettings.noiseGateEnabled = chkGate.checked;
      this.audioEngine.setFilterSettings(this.filterSettings);
    });

    sliderGate?.addEventListener('input', () => {
      const v = Number(sliderGate.value);
      this.filterSettings.noiseGateRms = v;
      if (valGate) valGate.textContent = v.toFixed(3);
      if (threshLine) threshLine.style.left = `${Math.min(100, (v / 0.08) * 100).toFixed(1)}%`;
      this.audioEngine.setFilterSettings(this.filterSettings);
    });

    const sliderClarity = this.root.querySelector<HTMLInputElement>('#slider-clarity');
    const valClarity = this.root.querySelector<HTMLElement>('#val-clarity');
    const clarityThreshLine = this.root.querySelector<HTMLElement>('#meter-clarity-thresh-line');

    sliderClarity?.addEventListener('input', () => {
      const v = Number(sliderClarity.value);
      this.filterSettings.clarityThreshold = v;
      if (valClarity) valClarity.textContent = `${Math.round(v * 100)}%`;
      if (clarityThreshLine) clarityThreshLine.style.left = `${Math.min(100, v * 100).toFixed(1)}%`;
      this.audioEngine.setFilterSettings(this.filterSettings);
    });

    const chkHighPass = this.root.querySelector<HTMLInputElement>('#chk-highpass');
    const sliderHighPass = this.root.querySelector<HTMLInputElement>('#slider-highpass');
    const valHighPass = this.root.querySelector<HTMLElement>('#val-highpass');

    chkHighPass?.addEventListener('change', () => {
      this.filterSettings.highPassEnabled = chkHighPass.checked;
      this.audioEngine.setFilterSettings(this.filterSettings);
    });

    sliderHighPass?.addEventListener('input', () => {
      const v = Number(sliderHighPass.value);
      this.filterSettings.highPassFreq = v;
      if (valHighPass) valHighPass.textContent = `${v} Гц`;
      this.audioEngine.setFilterSettings(this.filterSettings);
    });

    const chkLowPass = this.root.querySelector<HTMLInputElement>('#chk-lowpass');
    const sliderLowPass = this.root.querySelector<HTMLInputElement>('#slider-lowpass');
    const valLowPass = this.root.querySelector<HTMLElement>('#val-lowpass');

    chkLowPass?.addEventListener('change', () => {
      this.filterSettings.lowPassEnabled = chkLowPass.checked;
      this.audioEngine.setFilterSettings(this.filterSettings);
    });

    sliderLowPass?.addEventListener('input', () => {
      const v = Number(sliderLowPass.value);
      this.filterSettings.lowPassFreq = v;
      if (valLowPass) valLowPass.textContent = `${v} Гц`;
      this.audioEngine.setFilterSettings(this.filterSettings);
    });

    const chkOctave = this.root.querySelector<HTMLInputElement>('#chk-octave-rejection');
    chkOctave?.addEventListener('change', () => {
      this.filterSettings.octaveJumpRejection = chkOctave.checked;
      this.audioEngine.setFilterSettings(this.filterSettings);
    });

    this.root.querySelectorAll<HTMLButtonElement>('[data-median]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const frames = Number(btn.dataset.median) as 1 | 3 | 5;
        this.filterSettings.medianFilterFrames = frames;
        this.root.querySelectorAll<HTMLButtonElement>('[data-median]').forEach((b) => {
          b.classList.toggle('active', b.dataset.median === String(frames));
        });
        this.audioEngine.setFilterSettings(this.filterSettings);
      });
    });

    const chkBreakLeap = this.root.querySelector<HTMLInputElement>('#chk-break-leap');
    chkBreakLeap?.addEventListener('change', () => {
      this.filterSettings.breakLineOnLeap = chkBreakLeap.checked;
      this.audioEngine.setFilterSettings(this.filterSettings);
    });

    const chkCameraDamping = this.root.querySelector<HTMLInputElement>('#chk-camera-damping');
    chkCameraDamping?.addEventListener('change', () => {
      this.filterSettings.cameraDampingEnabled = chkCameraDamping.checked;
      if (this.renderer) {
        this.renderer.cameraDampingEnabled = chkCameraDamping.checked;
      }
      this.audioEngine.setFilterSettings(this.filterSettings);
    });

    // Presets
    const btnDefault = this.root.querySelector<HTMLButtonElement>('#btn-preset-default');
    btnDefault?.addEventListener('click', () => {
      this.filterSettings = getDefaultFilterSettings(this.selectedInstrument.id);
      this.applyFilterPreset();
    });

    const btnQuiet = this.root.querySelector<HTMLButtonElement>('#btn-preset-quiet');
    btnQuiet?.addEventListener('click', () => {
      this.filterSettings = {
        ...getDefaultFilterSettings(this.selectedInstrument.id),
        noiseGateRms: 0.012,
        clarityThreshold: 0.48,
        medianFilterFrames: 3,
      };
      this.applyFilterPreset();
    });

    const btnNoisy = this.root.querySelector<HTMLButtonElement>('#btn-preset-noisy');
    btnNoisy?.addEventListener('click', () => {
      this.filterSettings = {
        ...getDefaultFilterSettings(this.selectedInstrument.id),
        noiseGateRms: 0.036,
        clarityThreshold: 0.68,
        medianFilterFrames: 5,
      };
      this.applyFilterPreset();
    });

    const btnRaw = this.root.querySelector<HTMLButtonElement>('#btn-preset-raw');
    btnRaw?.addEventListener('click', () => {
      this.filterSettings = {
        ...this.filterSettings,
        noiseGateEnabled: false,
        highPassEnabled: false,
        lowPassEnabled: false,
        octaveJumpRejection: false,
        medianFilterFrames: 1,
        breakLineOnLeap: false,
        cameraDampingEnabled: false,
      };
      this.applyFilterPreset();
    });
  }

  private applyFilterPreset(): void {
    this.audioEngine.setFilterSettings(this.filterSettings);
    if (this.renderer) {
      this.renderer.cameraDampingEnabled = this.filterSettings.cameraDampingEnabled;
    }
    const contentEl = this.root.querySelector<HTMLElement>('#drawer-inner-content');
    if (contentEl) {
      contentEl.innerHTML = this.getFiltersTabHtml();
      this.bindFilterTabEvents();
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

  private tick(nowMs: number): void {
    const dt = Math.min(0.1, Math.max(0.001, (nowMs - this.lastRafTime) / 1000));
    this.lastRafTime = nowMs;

    if (!this.isPaused) {
      this.sessionClockSeconds += dt;
      const latestFrame = this.audioEngine.sampleLiveFrame(this.sessionClockSeconds);
      this.scrubbedSessionTime = this.sessionClockSeconds;
      this.renderer?.updateCameraPhysics(latestFrame, dt, !this.isDraggingCanvas);
      this.updateTopReadout(latestFrame);
      this.updateFilterMetersUI();
      this.syncTransportUI();
    } else {
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
        if (this.audioEngine.isReplaying) {
          this.renderer?.updateCameraPhysics(inspectedFrame, dt, !this.isDraggingCanvas);
        }
      }
      this.updateFilterMetersUI();
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

  private updateFilterMetersUI(): void {
    if (!this.isFiltersDrawerOpen) return;

    const rmsFill = this.root.querySelector<HTMLElement>('#meter-rms-fill');
    const rmsVal = this.root.querySelector<HTMLElement>('#meter-rms-val');
    const clarityFill = this.root.querySelector<HTMLElement>('#meter-clarity-fill');
    const clarityVal = this.root.querySelector<HTMLElement>('#meter-clarity-val');
    const statusBadge = this.root.querySelector<HTMLElement>('#meter-status-badge');

    if (!rmsFill || !rmsVal) return;

    const curRms = this.audioEngine.latestRawRms;
    const curClarity = this.audioEngine.latestRawClarity;
    const rmsPct = Math.min(100, Math.max(0, (curRms / 0.08) * 100));
    const clarityPct = Math.min(100, Math.max(0, curClarity * 100));

    rmsFill.style.width = `${rmsPct.toFixed(1)}%`;
    rmsVal.textContent = curRms.toFixed(3);

    if (clarityFill && clarityVal) {
      clarityFill.style.width = `${clarityPct.toFixed(1)}%`;
      clarityVal.textContent = `${Math.round(clarityPct)}%`;
    }

    const isGated =
      this.filterSettings.noiseGateEnabled && curRms < this.filterSettings.noiseGateRms;
    const isUnclear = curClarity < this.filterSettings.clarityThreshold;

    if (isGated) {
      rmsFill.classList.add('gated');
      if (statusBadge) {
        statusBadge.className = 'badge-status-silent';
        statusBadge.textContent = '⚪ Ниже порога (тишина)';
      }
    } else if (isUnclear) {
      rmsFill.classList.remove('gated');
      if (statusBadge) {
        statusBadge.className = 'badge-status-silent';
        statusBadge.textContent = '🟡 Шум / Голос (нечистый тон)';
      }
    } else {
      rmsFill.classList.remove('gated');
      if (statusBadge) {
        statusBadge.className = 'badge-status-active';
        statusBadge.textContent = '🟢 Звучит чистая нота';
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
