'use strict';

// ── State ────────────────────────────────────────────────────────────────────
let cameraStream = null;
let wakeLock     = null;

// ── DOM refs ─────────────────────────────────────────────────────────────────
const screenStart  = document.getElementById('screen-start');
const screenScan   = document.getElementById('screen-scan');
const screenResult = document.getElementById('screen-result');

const videoEl        = document.getElementById('camera-feed');
const captureCanvas  = document.getElementById('capture-canvas');
const flashBg        = document.getElementById('flash-bg');
const progressBar    = document.getElementById('progress-bar');
const stepLabel      = document.getElementById('step-label');
const stepCounter    = document.getElementById('step-counter');
const faceGuide      = document.getElementById('face-guide');
const pipContainer   = document.getElementById('pip-container');

// ── Helpers ──────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function showScreen(name) {
  [screenStart, screenScan, screenResult].forEach(s => s.classList.remove('active'));
  if (name === 'start')  screenStart .classList.add('active');
  if (name === 'scan')   screenScan  .classList.add('active');
  if (name === 'result') screenResult.classList.add('active');
}

async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (_) { /* unsupported — ignore */ }
}

function releaseWakeLock() {
  if (wakeLock) { wakeLock.release(); wakeLock = null; }
}

// ── Camera ───────────────────────────────────────────────────────────────────
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
  // Extra frame buffer to let AE/AWB settle a bit
  await sleep(600);
}

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
}

// ── Frame capture ─────────────────────────────────────────────────────────────
function extractFaceData(imgData, w, h) {
  // Center crop — in selfie mode the face occupies roughly the inner 40%×48%
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

function captureFrame(step) {
  const w = videoEl.videoWidth  || 640;
  const h = videoEl.videoHeight || 480;
  captureCanvas.width  = w;
  captureCanvas.height = h;
  const ctx = captureCanvas.getContext('2d');
  // Mirror to align with how the video is displayed
  ctx.save();
  ctx.translate(w, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(videoEl, 0, 0);
  ctx.restore();
  const imgData = ctx.getImageData(0, 0, w, h);
  return { step, data: extractFaceData(imgData, w, h) };
}

// ── Main scan loop ────────────────────────────────────────────────────────────
async function runScan() {
  const frames = [];
  const total  = SPECTRAL_COLORS.length;

  // Switch to PiP camera view + show flash background
  videoEl.classList.add('pip');
  pipContainer.style.display = 'block';
  faceGuide.style.opacity = '1';
  stepLabel.textContent   = 'Hold still — scanning...';
  progressBar.style.width = '0%';

  for (let i = 0; i < total; i++) {
    const step = SPECTRAL_COLORS[i];

    // ① Flash the screen with this spectral color
    flashBg.style.backgroundColor = step.hex;
    flashBg.style.opacity          = '1';

    // ② Update status UI
    stepLabel.textContent  = `${step.name}  ${step.nm} nm`;
    stepCounter.textContent = `${i + 1} / ${total}`;
    progressBar.style.width = `${((i + 1) / total) * 100}%`;

    // ③ Wait: screen renders → camera adjusts exposure → stable frame
    await sleep(300);

    // ④ Capture frame
    frames.push(captureFrame(step));

    // ⑤ Brief dark gap to avoid color bleeding into next step
    flashBg.style.opacity = '0';
    await sleep(70);
  }

  stepLabel.textContent = 'Analysing spectral signature…';
  await sleep(400);

  flashBg.style.opacity = '0';
  return frames;
}

// ── Result display ────────────────────────────────────────────────────────────
function showResult(result) {
  stopCamera();
  releaseWakeLock();
  showScreen('result');

  document.getElementById('result-icon').textContent =
    result.isLive ? '✅' : '❌';

  const titleEl = document.getElementById('result-title');
  titleEl.textContent  = result.isLive ? 'Live Person Confirmed' : 'Liveness Check Failed';
  titleEl.style.color  = result.isLive ? '#22c55e' : '#ef4444';

  const bar = document.getElementById('result-score-bar');
  bar.style.background = result.isLive
    ? 'linear-gradient(90deg,#22c55e,#86efac)'
    : 'linear-gradient(90deg,#ef4444,#fca5a5)';
  // Animate after paint
  requestAnimationFrame(() => requestAnimationFrame(() => {
    bar.style.width = `${result.score}%`;
  }));

  document.getElementById('result-score-value').textContent = `${result.score} / 100`;

  document.getElementById('result-details').innerHTML =
    result.reasons.map(r => `<div class="reason-row">${r}</div>`).join('');
}

// ── Button handlers ───────────────────────────────────────────────────────────
document.getElementById('btn-start').addEventListener('click', async () => {
  showScreen('scan');
  try {
    await acquireWakeLock();
    await startCamera();
    const frames = await runScan();
    const result  = analyzeLiveness(frames);
    showResult(result);
  } catch (err) {
    stopCamera();
    releaseWakeLock();
    alert('Error: ' + err.message + '\n\nEnsure camera permission is granted.');
    showScreen('start');
  }
});

document.getElementById('btn-retry').addEventListener('click', () => {
  // Reset scan UI state
  document.getElementById('result-score-bar').style.width = '0%';
  videoEl.classList.remove('pip');
  pipContainer.style.display = 'none';
  showScreen('start');
});
