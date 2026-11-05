# Project Specification: Strings Visual Coach (MVP Foundation)

## 1. Product Overview
A real-time visual pitch, tone-quality, and polyphony coach for children playing bowed string instruments (**Violin, Viola, Cello, Double Bass**).
Built with **TypeScript, Vite, HTML5 Canvas 2D, and Web Audio API**.
Primary orientation: **Landscape** (maximizing time-history visibility while glancing between sheet music and screen), while remaining fully responsive in **Portrait**.

---

## 2. Screen Flow & Navigation (2-Screen Foundation)

### Screen 1: Instrument Selection & Setup
- **4 Instrument Cards:**
  1. **Скрипка (Violin):** Open strings `G3 (Соль)`, `D4 (Ре)`, `A4 (Ля)`, `E5 (Ми)`
  2. **Альт (Viola):** Open strings `C3 (До)`, `G3 (Соль)`, `D4 (Ре)`, `A4 (Ля)`
  3. **Виолончель (Cello):** Open strings `C2 (До)`, `G2 (Соль)`, `D3 (Ре)`, `A3 (Ля)`
  4. **Контрабас (Double Bass):** Open strings `E1 (Ми)`, `A1 (Ля)`, `D2 (Ре)`, `G2 (Соль)` (sounding pitch)
- **String Color Coding (Consistent across the app & future fingerboard view):**
  - Each open string of the selected instrument gets a distinct signature color:
    - String IV (Lowest): **Blue (`#3B82F6`)**
    - String III: **Yellow/Amber (`#F59E0B`)**
    - String II: **Green (`#10B981`)**
    - String I (Highest): **Red/Coral (`#EF4444`)**
- **Reference Pitch Selector:** `A4 = 440 Hz` / `442 Hz` / `443 Hz` (default `442 Hz` for European music schools).
- Selecting an instrument configures the DSP frequency bounds, buffer sizes, and open-string markers, then transitions to **Screen 2**.

### Screen 2: The Live Sound Canvas
- **Full-screen dark UI** (`#0B0F19` background) optimized for music stand distance.
- **Top Floating Minimal Bar:**
  - Back/Switch Instrument button (shows current instrument badge + open string color dots).
  - Key / Semitone Grid toggle: `Чистые ноты (До, Ре, Ми + пунктир полутонов)` or Key Signature selector.
  - `Demo / Simulator` toggle button (for testing without a physical instrument).
- **Bottom Transport & Replay Bar:**
  - `Live / Pause` toggle button.
  - Interactive timeline scrubber covering the **last 60 seconds** of recorded audio + visual frames.
  - When paused, the user can drag/swipe the canvas horizontally to inspect past mistakes and press **Play Recorded Audio** to hear the exact recorded microphone audio synchronized with a vertical playback playhead on the graph.

---

## 3. Visual Mechanics & Camera Physics (Crucial UX Rules)

### A. Horizontal Playhead at 75% Width
- The sound line moves horizontally across the screen, with the **"Live Head" (current moment) positioned at 75% of the screen width from the left** (leaving 25% of space on the right for future incoming target notes and note labels).
- Past history scrolls smoothly from the 75% head toward the left edge (`0%`), showing ~6–8 seconds of history in landscape mode.

### B. Background Pitch Grid & Note Labels
- Vertical Y-axis represents logarithmic pitch (MIDI note number / cents). Visible vertical span is approximately **12 to 15 semitones (~1 octave)** at a time.
- **European Solfège Labels:** `До, Ре, Ми, Фа, Соль, Ля, Си` (with octave indicators or clear visual hierarchy).
- **Natural Notes vs. Semitones:**
  - Natural notes (`До, Ре, Ми, Фа, Соль, Ля, Си`) are rendered as solid, clear horizontal guide lines. Note that `Ми–Фа` and `Си–До` are 1 semitone apart, while `До–Ре`, `Ре–Ми`, `Фа–Соль`, `Соль–Ля`, `Ля–Си` are 2 semitones apart.
  - Semitones (sharps/flats like `Фа♯ / Соль♭`) sit halfway between whole tones as **subtle dashed lines**. When the player sustains a pitch near a semitone line for >150ms, its label badge (`Фа♯ / Соль♭`) gently illuminates.
- **Open String Highlighting:**
  - Guide lines corresponding to the selected instrument's **4 open strings** are highlighted with their signature string colors (Blue, Amber, Green, Red) and labeled with a pill badge (e.g., `Струна Ля`).

### C. Vertical Camera Deadzone & Spring Recentering
- **Central 50% Zone (from 25% top to 75% bottom):** The background pitch grid stays **completely stationary** while the sound line moves within the central 50% of the vertical screen.
- **Top/Bottom 25% Boundary Push:** When the pitch rises and reaches the top 25% boundary (or drops to the bottom 25% boundary), the live head stops moving further toward the screen edge, and instead the **background pitch grid + historical tail scroll vertically** to follow the pitch.
- **Smooth Recentering:** Once the pitch stops climbing/falling and stabilizes (or during a brief bow pause), the camera very gently eases the active pitch back toward the vertical center (`50%`) using critically damped spring interpolation, slow enough not to trick the player into thinking their pitch is drifting.

### D. Silence / Pause Behavior ("Ghost Thread")
- When the player stops bowing or volume drops below the noise gate threshold:
  - Freeze the pitch value at the **last confident detected frequency** (ignoring final string release transients).
  - Continue drawing the horizontal line at that exact pitch level, but fade its opacity to **5%–10% (90–95% transparent)**.
  - As soon as bowing resumes, the line smoothly lights back up to 100% brightness from the new detected pitch.

### E. Line Rendering: Pitch, Bow Noise (Blur), and 2nd String
1. **Primary Pitch Line:**
   - **Color by Intonation Accuracy:** Bright emerald/cyan when within `±10 cents` of a valid scale/semitone line; smoothly shifts toward yellow/orange when flat or sharp (`±15 to ±50 cents`).
2. **Bow Noise / Tone Impurity (Blur & Width):**
   - Driven by real-time `noisiness` metric (Spectral Flatness + Harmonic-to-Noise ratio).
   - **Clean tone (`noisiness < 0.15`):** Crisp, tight, glowing laser line (`2.5px–3.5px` core).
   - **Scratchy bow / rosin noise (`noisiness > 0.2`):** The core line widens, becomes diffuse/fuzzy, and renders a wide blurred aura (`shadowBlur` + multi-pass translucent ribbon + subtle jitter particles) proportional to the noise level.
3. **Accidental 2nd String / Double Stops:**
   - If a secondary string is sounding simultaneously (e.g., accidentally brushing an adjacent open string), render a **second simultaneous line** at the secondary pitch.
   - Color the secondary line using the **signature color of the string closest to that frequency**, with opacity and thickness proportional to the secondary string's relative amplitude.

---

## 4. Audio DSP & Recording Architecture

1. **Raw Microphone Input:**
   - Request `getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })`.
2. **Instrument-Adapted Analysis:**
   - Double Bass & Cello use an 8192-sample FFT/correlation ring buffer (to accurately resolve down to `E1 = 41.2 Hz`); Viola & Violin use 4096 samples with a 512-sample hop for ultra-low latency at 60 FPS.
   - **Primary Pitch:** McLeod Pitch Method (MPM) or YIN with parabolic interpolation.
   - **Secondary Pitch Detection:** Subtract/attenuate harmonics of the primary pitch ($k \cdot f_0$) from the magnitude spectrum and evaluate harmonic sums around the instrument's other strings to detect accidental open-string leaks or double stops.
   - **Noisiness Metric:** Compute Spectral Flatness in the `400 Hz – 5000 Hz` band + non-harmonic residual ratio.
3. **60-Second Ring Buffer (Audio + Telemetry):**
   - Simultaneously record raw audio chunks (via `MediaRecorder` or PCM ring buffer in `AudioWorklet`/processor) and visual telemetry frames (`60 FPS` array of `{ time, primaryMidi, clarity, noisiness, rms, secondaryMidi, secondaryRms }`) for the last 60 seconds.
   - When the user pauses and scrubs backward, play the corresponding slice of the PCM audio buffer through `AudioContext` while moving the visual cursor across the recorded telemetry.
4. **Built-in Interactive Simulator (Demo Mode):**
   - Provide an on-screen collapsible drawer with sliders:
     - `Target Note & Cents Offset (-50 to +50)`
     - `Bow Noise / Scratch (0% to 100%)`
     - `Adjacent Open String Leak (0% to 100%)`
     - `Play / Silence Toggle` (to test the 90–95% transparent ghost line)
   - Route synthesized sawtooth + filtered noise + secondary string oscillator directly into the same analyzer node so both the audio playback and visual graph can be tested end-to-end without a microphone.