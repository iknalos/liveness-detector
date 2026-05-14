# LivenessCheck

An Android app that detects whether a face is a **real live person** or a spoof (photo, screen replay, printed image) using multispectral illumination analysis — no ML model required.

---

## How It Works

The app flashes the phone screen through **24 colors spanning the full visible spectrum (400–745 nm)** while the front camera simultaneously captures the face under each illumination.

| Step | What happens |
|------|-------------|
| 1 | Screen flashes a spectral color (e.g. 540 nm green) |
| 2 | Camera captures the face lit by that color |
| 3 | Repeat for all 24 steps (~8 seconds total) |
| 4 | Spectral response curve is analyzed |
| 5 | Pass or fail based on skin signature |

### Why it works

Human skin has a unique spectral reflectance curve — it absorbs blue/violet light heavily, shows a hemoglobin absorption dip around 540–575 nm, and reflects red/near-IR strongly. A real face **tracks** the illumination color. A phone screen showing a face emits its own fixed RGB and doesn't track. A printed photo reflects all wavelengths more uniformly.

### Detection checks

| Check | What it catches |
|-------|----------------|
| Illumination tracking (Pearson r) | Screen replay attacks |
| Spectral variance | Flat/non-responsive surfaces |
| Red > blue reflectance ratio | Printed photos, masks |
| Warm spectral bias | Non-skin materials |
| Hemoglobin absorption dip | High-quality fakes |

---

## Spectral Color Sequence

```
400 nm  Violet        →  415 nm  Blue-Violet   →  430 nm  Deep Blue
445 nm  Royal Blue    →  460 nm  Blue          →  475 nm  Cerulean
490 nm  Sky Cyan      →  505 nm  Cyan          →  520 nm  Seafoam
535 nm  Green         →  550 nm  Lime          →  565 nm  Yellow-Green
580 nm  Yellow        →  595 nm  Amber         →  610 nm  Orange
625 nm  Red-Orange    →  640 nm  Scarlet       →  655 nm  Red
670 nm  Deep Red      →  685 nm  Dark Red      →  700 nm  Near-IR 1
715 nm  Near-IR 2     →  730 nm  Near-IR 3     →  745 nm  Near-IR 4
```

---

## Tech Stack

- **Capacitor 6** — wraps web tech as a native Android APK
- **Vanilla JS + HTML5 Canvas** — camera capture and pixel analysis
- **getUserMedia API** — front camera stream
- **Screen Wake Lock API** — keeps screen on during scan
- No external ML libraries — pure signal processing

---

## Building the APK

### Option A — GitHub Actions (recommended, no setup needed)

Every push to `main` triggers an automatic build.

1. Go to the **Actions** tab
2. Click the latest **Build APK** run
3. Scroll to **Artifacts** → download `LivenessCheck-debug-apk`
4. Transfer the `.apk` to your Android phone
5. Enable **Install from unknown sources** → install

### Option B — Local build

Requirements: Java 17+, Android SDK (API 34), Node.js

```bash
npm install
npx cap sync android
cd android
./gradlew assembleDebug
# APK at: android/app/build/outputs/apk/debug/app-debug.apk
```

---

## Usage

1. Open the app
2. Grant camera permission when prompted
3. Hold the phone at face level in a **dimly lit room**
4. Tap **Start Scan** and keep still
5. The screen flashes 24 colors over ~8 seconds
6. Result shows with a confidence score (0–100), pass threshold is 58

---

## Project Structure

```
www/
  index.html          # 3-screen UI (Start → Scan → Result)
  css/style.css       # Dark theme, PiP camera, animations
  js/colors.js        # 24 spectral steps with RGB values
  js/analyzer.js      # Pearson correlation + skin signature checks
  js/main.js          # Camera, flash loop, capture, state machine
android/              # Capacitor-generated Android project
.github/workflows/    # GitHub Actions APK build pipeline
```

---

## Limitations

- Best in dim ambient light (bright rooms reduce flash contrast)
- High-quality 3D silicone masks are not reliably detected
- Phone screen auto-exposure/white-balance may slightly reduce accuracy
- Not a replacement for full biometric authentication systems
