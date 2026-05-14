'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
const TEMPLATE_KEY    = 'liveness_face_template';
const IDENTITY_THRESH = 0.88; // cosine similarity required to match

// ── State ─────────────────────────────────────────────────────────────────────
let cameraStream    = null;
let imageCapture    = null;   // ImageCapture API for precise frame grabs
let wakeLock        = null;
let scanMode        = 'verify';   // 'register' | 'verify'
let storedTemplate  = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const screenRegister = document.getElementById('screen-register');
const screenStart    = document.getElementById('screen-start');
const screenScan     = document.getElementById('screen-scan');
const screenResult   = document.getElementById('screen-result');

const videoEl       = document.getElementById('camera-feed');
const captureCanvas = document.getElementById('capture-canvas');
const flashBg       = document.getElementById('flash-bg');
const progressBar   = document.getElementById('progress-bar');
const stepLabel     = document.getElementById('step-label');
const stepCounter   = document.getElementById('step-counter');
const faceGuide     = document.getElementById('face-guide');
const pipContainer  = document.getElementById('pip-container');

// ── Template persistence ──────────────────────────────────────────────────────
function loadTemplate() {
  try {
    const raw = localStorage.getItem(TEMPLATE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveTemplate(template) {
  localStorage.setItem(TEMPLATE_KEY, JSON.stringify(template));
}

function clearTemplate() {
  localStorage.removeItem(TEMPLATE_KEY);
}

// ── Screen routing ────────────────────────────────────────────────────────────
function showScreen(name) {
  [screenRegister, screenStart, screenScan, screenResult]
    .forEach(s => s.classList.remove('active'));
  const map = { register: screenRegister, start: screenStart,
                scan: screenScan,         result: screenResult };
  if (map[name]) map[name].classList.add('active');
}

// ── Utilities ─────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator)
      wakeLock = await navigator.wakeLock.request('screen');
  } catch (_) {}
}

function releaseWakeLock() {
  if (wakeLock) { wakeLock.release(); wakeLock = null; }
}

// ── Brightness control ────────────────────────────────────────────────────────
// Uses our custom BrightnessPlugin (Java) via Capacitor bridge.
// Only affects this app's window — no system permission needed.
async function setMaxBrightness() {
  try {
    await Capacitor.Plugins.Brightness.setBrightness({ brightness: 1.0 });
  } catch (_) {}
}

async function restoreBrightness() {
  try {
    await Capacitor.Plugins.Brightness.resetBrightness();
  } catch (_) {}
}

// ── Camera ────────────────────────────────────────────────────────────────────
async function startCamera() {
  cameraStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  videoEl.srcObject = cameraStream;
  await new Promise((res, rej) => {
    videoEl.onloadedmetadata = res;
    videoEl.onerror = rej;
  });
  await videoEl.play();

  // Set up ImageCapture for precise single-frame grabs if available
  const videoTrack = cameraStream.getVideoTracks()[0];
  if ('ImageCapture' in window) {
    try { imageCapture = new ImageCapture(videoTrack); } catch (_) {}
  }

  // Wait for camera AE/AWB to settle on the initial scene
  await sleep(600);
}

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  imageCapture = null;
}

// ── Frame capture ─────────────────────────────────────────────────────────────
function extractFaceData(imgData, w, h) {
  const x1 = Math.floor(w * 0.30), x2 = Math.floor(w * 0.70);
  const y1 = Math.floor(h * 0.20), y2 = Math.floor(h * 0.68);
  let tR = 0, tG = 0, tB = 0, cnt = 0;
  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) {
      const i = (y * w + x) * 4;
      tR += imgData.data[i];
      tG += imgData.data[i + 1];
      tB += imgData.data[i + 2];
      cnt++;
    }
  }
  const r = tR / cnt, g = tG / cnt, b = tB / cnt;
  return { r, g, b, brightness: (r + g + b) / 3 };
}

function drawToCanvas(source) {
  const w = videoEl.videoWidth  || 640;
  const h = videoEl.videoHeight || 480;
  captureCanvas.width  = w;
  captureCanvas.height = h;
  const ctx = captureCanvas.getContext('2d');
  ctx.save();
  ctx.translate(w, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(source, 0, 0, w, h);
  ctx.restore();
  return { ctx, w, h };
}

async function captureFrame(step) {
  let ctx, w, h;

  if (imageCapture) {
    try {
      // grabFrame() pulls the freshest frame directly from the camera pipeline
      const bitmap = await imageCapture.grabFrame();
      ({ ctx, w, h } = drawToCanvas(bitmap));
      bitmap.close();
    } catch (_) {
      ({ ctx, w, h } = drawToCanvas(videoEl));
    }
  } else {
    ({ ctx, w, h } = drawToCanvas(videoEl));
  }

  return { step, data: extractFaceData(ctx.getImageData(0, 0, w, h), w, h) };
}

// Sync a screen-color change to the display's refresh cycle.
// Two nested RAFs: first queues the paint, second confirms it rendered.
function setFlashColor(hex) {
  return new Promise(resolve => {
    requestAnimationFrame(() => {
      flashBg.style.backgroundColor = hex;
      flashBg.style.opacity = '1';
      requestAnimationFrame(resolve);
    });
  });
}

// ── Scan loop (shared by both register and verify) ────────────────────────────
// Registration: 24 steps × 340ms  ≈ 9 seconds  (high quality template)
// Verification: 12 steps × 240ms  ≈ 3-4 seconds (fast daily check)
async function runScan() {
  const frames    = [];
  const isReg     = scanMode === 'register';
  const colors    = isReg ? SPECTRAL_COLORS : VERIFY_COLORS;
  const flashMs   = isReg ? 280 : 200;   // ms screen stays on per step
  const gapMs     = isReg ?  60 :  40;   // ms dark gap between steps
  const modeLabel = isReg ? 'Registering' : 'Verifying';

  await setMaxBrightness();   // max screen brightness for strongest illumination

  videoEl.classList.add('pip');
  pipContainer.style.display = 'block';
  faceGuide.style.opacity    = '1';
  stepLabel.textContent      = 'Hold still…';
  stepCounter.textContent    = `0 / ${colors.length}`;
  progressBar.style.width    = '0%';

  for (let i = 0; i < colors.length; i++) {
    const step = colors[i];

    // ① Sync color to display refresh — guarantees the screen is actually
    //   showing the new color before we start the AE-settle timer.
    await setFlashColor(step.hex);

    // Update status text after the flash is live
    stepLabel.textContent   = `${modeLabel} · ${step.name} ${step.nm} nm`;
    stepCounter.textContent = `${i + 1} / ${colors.length}`;
    progressBar.style.width = `${((i + 1) / colors.length) * 100}%`;

    // ② Wait for camera auto-exposure to settle on the new illumination
    await sleep(flashMs);

    // ③ Grab the freshest frame (ImageCapture API when available)
    frames.push(await captureFrame(step));

    // ④ Dark gap — prevents colour from the current step bleeding into the next
    flashBg.style.opacity = '0';
    await sleep(gapMs);
  }

  stepLabel.textContent = isReg
    ? 'Building your spectral template…'
    : 'Analysing identity…';
  await sleep(300);

  flashBg.style.opacity = '0';
  await restoreBrightness();  // back to user's normal brightness
  return frames;
}

// ── Result display ────────────────────────────────────────────────────────────
function showResult(result) {
  stopCamera();
  releaseWakeLock();
  showScreen('result');

  const iconEl       = document.getElementById('result-icon');
  const titleEl      = document.getElementById('result-title');
  const livenessBar  = document.getElementById('result-score-bar');
  const livenessVal  = document.getElementById('result-score-value');
  const detailsEl    = document.getElementById('result-details');
  const idBlock      = document.getElementById('identity-block');
  const idBar        = document.getElementById('identity-score-bar');
  const idVal        = document.getElementById('identity-score-value');
  const retryBtn     = document.getElementById('btn-retry');

  // ── Registration result ────────────────────────────────────────────────────
  if (scanMode === 'register') {
    if (result.isLive) {
      const template = buildTemplate(window._lastFrames);
      if (template) {
        saveTemplate(template);
        storedTemplate = template;
      }
      iconEl.textContent   = '✅';
      titleEl.textContent  = 'Face Registered!';
      titleEl.style.color  = '#22c55e';
      livenessBar.style.background = 'linear-gradient(90deg,#22c55e,#86efac)';
      retryBtn.textContent = 'Continue to Verify';
    } else {
      iconEl.textContent   = '❌';
      titleEl.textContent  = 'Registration Failed';
      titleEl.style.color  = '#ef4444';
      livenessBar.style.background = 'linear-gradient(90deg,#ef4444,#fca5a5)';
      retryBtn.textContent = 'Try Again';
    }
    idBlock.style.display = 'none';

  // ── Verification result ────────────────────────────────────────────────────
  } else {
    if (result.passed) {
      iconEl.textContent  = '✅';
      titleEl.textContent = 'Identity Verified';
      titleEl.style.color = '#22c55e';
    } else if (!result.isLive) {
      iconEl.textContent  = '❌';
      titleEl.textContent = 'Liveness Check Failed';
      titleEl.style.color = '#ef4444';
    } else {
      iconEl.textContent  = '❌';
      titleEl.textContent = 'Identity Mismatch';
      titleEl.style.color = '#f97316';
    }

    livenessBar.style.background = result.isLive
      ? 'linear-gradient(90deg,#22c55e,#86efac)'
      : 'linear-gradient(90deg,#ef4444,#fca5a5)';

    // Identity block
    idBlock.style.display = 'flex';
    if (result.identity) {
      idBar.style.background = result.identity.isMatch
        ? 'linear-gradient(90deg,#3b82f6,#93c5fd)'
        : 'linear-gradient(90deg,#f97316,#fdba74)';
      requestAnimationFrame(() => requestAnimationFrame(() => {
        idBar.style.width  = `${result.identity.score}%`;
        idVal.textContent  = `${result.identity.score} / 100`;
      }));
    }
    retryBtn.textContent = 'Try Again';
  }

  // Animate liveness bar
  requestAnimationFrame(() => requestAnimationFrame(() => {
    livenessBar.style.width = `${result.score}%`;
    livenessVal.textContent = `${result.score} / 100`;
  }));

  detailsEl.innerHTML = result.reasons
    .map(r => `<div class="reason-row">${r}</div>`).join('');
}

// ── Button handlers ───────────────────────────────────────────────────────────

// Register screen → start registration scan
document.getElementById('btn-register').addEventListener('click', async () => {
  scanMode = 'register';
  showScreen('scan');
  try {
    await acquireWakeLock();
    await startCamera();
    const frames = await runScan();
    window._lastFrames = frames;
    const result = analyzeLiveness(frames);
    showResult(result);
  } catch (err) {
    stopCamera(); releaseWakeLock(); restoreBrightness();
    alert('Camera error: ' + err.message);
    showScreen('register');
  }
});

// Start/verify screen → start verification scan
document.getElementById('btn-verify').addEventListener('click', async () => {
  scanMode = 'verify';
  showScreen('scan');
  try {
    await acquireWakeLock();
    await startCamera();
    const frames = await runScan();
    window._lastFrames = frames;
    const result = analyzeLiveness(frames, storedTemplate);
    showResult(result);
  } catch (err) {
    stopCamera(); releaseWakeLock(); restoreBrightness();
    alert('Camera error: ' + err.message);
    showScreen('start');
  }
});

// Re-register link
document.getElementById('btn-reregister').addEventListener('click', () => {
  clearTemplate();
  storedTemplate = null;
  showScreen('register');
});

// Result screen retry / continue
document.getElementById('btn-retry').addEventListener('click', () => {
  // Reset bars
  document.getElementById('result-score-bar').style.width    = '0%';
  document.getElementById('identity-score-bar').style.width  = '0%';
  videoEl.classList.remove('pip');
  pipContainer.style.display = 'none';

  if (scanMode === 'register' && !storedTemplate) {
    showScreen('register');
  } else if (scanMode === 'register' && storedTemplate) {
    showScreen('start');  // registration succeeded → go to verify
  } else {
    showScreen('start');
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
storedTemplate = loadTemplate();
showScreen(storedTemplate ? 'start' : 'register');
