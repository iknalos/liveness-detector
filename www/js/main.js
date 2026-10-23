'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
const TEMPLATE_KEY = 'liveness_template_v3';
const OLD_TEMPLATE_KEYS = ['liveness_face_template'];   // spectral-only templates from v1/v2
const CROP = 128;                // analysis crop, pixels square
const FACE_MIN = 0.30, FACE_MAX = 0.78;   // face width as a share of the frame width

// ── State ─────────────────────────────────────────────────────────────────────
let cameraStream = null;
let wakeLock = null;
let scanMode = 'verify';         // 'register' | 'verify'
let storedTemplate = null;
let cancelled = false;
let lastReport = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const screens = { register: $('screen-register'), start: $('screen-start'), scan: $('screen-scan'), result: $('screen-result') };
const videoEl = $('camera-feed');
const flashEl = $('flash');
const hintEl = $('scan-hint');
const guideEl = $('face-guide');
const progressEl = $('scan-progress');
const progressBar = $('scan-progress-bar');

// ── Template persistence ──────────────────────────────────────────────────────
function loadTemplate() {
  try {
    OLD_TEMPLATE_KEYS.forEach(k => localStorage.removeItem(k));
    const raw = localStorage.getItem(TEMPLATE_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw);
    return t.version === 3 && Array.isArray(t.descriptor) ? t : null;
  } catch { return null; }
}
const saveTemplate = t => localStorage.setItem(TEMPLATE_KEY, JSON.stringify(t));
const clearTemplate = () => localStorage.removeItem(TEMPLATE_KEY);

// ── Screen routing ────────────────────────────────────────────────────────────
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

// ── Utilities ─────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const nextFrame = () => new Promise(r => requestAnimationFrame(r));
class Cancelled extends Error {}
const checkCancel = () => { if (cancelled) throw new Cancelled('cancelled'); };

async function acquireWakeLock() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
}
function releaseWakeLock() { if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; } }

// Our BrightnessPlugin (Java): affects only this window, no system permission needed.
const plugins = () => (window.Capacitor && window.Capacitor.Plugins) || {};
async function setMaxBrightness() { try { await plugins().Brightness.setBrightness({ brightness: 1.0 }); } catch (_) {} }
async function restoreBrightness() { try { await plugins().Brightness.resetBrightness(); } catch (_) {} }

// ── Camera ────────────────────────────────────────────────────────────────────
async function startCamera() {
  cameraStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    audio: false,
  });
  videoEl.srcObject = cameraStream;
  await new Promise((res, rej) => { videoEl.onloadedmetadata = res; videoEl.onerror = rej; });
  await videoEl.play();
}

function stopCamera() {
  if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
  videoEl.srcObject = null;
}

function cameraInfo() {
  const track = cameraStream && cameraStream.getVideoTracks()[0];
  if (!track) return {};
  const caps = track.getCapabilities ? track.getCapabilities() : {};
  const s = track.getSettings ? track.getSettings() : {};
  return {
    label: track.label, width: s.width, height: s.height, frameRate: s.frameRate,
    whiteBalanceModes: caps.whiteBalanceMode, exposureModes: caps.exposureMode,
    whiteBalanceMode: s.whiteBalanceMode, exposureMode: s.exposureMode,
  };
}

// White balance is locked for the scan so the camera can't "correct away" the red flash.
// Chromium maps 'manual' white balance to Camera2's AWB lock, which holds the current gains.
// Exposure is deliberately NOT locked: Chromium's 'manual' exposure switches auto-exposure
// off and resets ISO to a default, which made the old version's frames jump in brightness.
// The analysis instead compares patterns of equal brightness and subtracts a black frame
// taken a moment earlier and later, so slow exposure changes cancel out.
async function lockWhiteBalance() {
  const track = cameraStream && cameraStream.getVideoTracks()[0];
  if (!track || !track.getCapabilities) return false;
  try {
    const caps = track.getCapabilities();
    if (!caps.whiteBalanceMode || !caps.whiteBalanceMode.includes('manual')) return false;
    await track.applyConstraints({ advanced: [{ whiteBalanceMode: 'manual' }] });
    return true;
  } catch (_) { return false; }
}
async function unlockWhiteBalance(locked) {
  if (!locked || !cameraStream) return;
  try { await cameraStream.getVideoTracks()[0].applyConstraints({ advanced: [{ whiteBalanceMode: 'continuous' }] }); } catch (_) {}
}

// Copies the face region of every new camera frame into a small buffer, with its timestamps.
function startSampler(crop) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = CROP;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const frames = [];
  let active = true;
  const grab = times => {
    ctx.drawImage(videoEl, crop.x, crop.y, crop.side, crop.side, 0, 0, CROP, CROP);
    frames.push({ times, data: ctx.getImageData(0, 0, CROP, CROP).data });
  };
  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
    const cb = (now, meta) => {
      if (!active) return;
      grab({ cap: meta.captureTime, disp: meta.expectedDisplayTime, now });
      videoEl.requestVideoFrameCallback(cb);
    };
    videoEl.requestVideoFrameCallback(cb);
  } else {
    let last = -1;
    const loop = now => {
      if (!active) return;
      if (videoEl.currentTime !== last) { last = videoEl.currentTime; grab({ now }); }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  return { frames, stop: () => { active = false; } };
}

// Median time between camera frames, measured while the user lines up.
function measureFrameInterval(ms = 700) {
  return new Promise(resolve => {
    if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return resolve(33);
    const ts = [];
    const t0 = performance.now();
    const cb = now => {
      ts.push(now);
      if (now - t0 < ms) videoEl.requestVideoFrameCallback(cb);
      else {
        const d = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b);
        resolve(d.length ? d[d.length >> 1] : 33);
      }
    };
    videoEl.requestVideoFrameCallback(cb);
  });
}

// ── Scan phases ───────────────────────────────────────────────────────────────
async function positionFace() {
  const descriptors = [];
  let good = 0;
  const t0 = performance.now();
  while (true) {
    checkCancel();
    if (performance.now() - t0 > 30000) throw new Error('No face found. Make sure your face is in the oval and lit.');
    const det = await Face.detect(videoEl, good >= 1);
    const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
    if (!det) { good = 0; hintEl.textContent = 'Put your face in the oval'; await sleep(80); continue; }
    const fw = det.box.w / vw;
    const cx = (det.box.x + det.box.w / 2) / vw, cy = (det.box.y + det.box.h / 2) / vh;
    let msg = '';
    if (fw < FACE_MIN) msg = 'Move closer';
    else if (fw > FACE_MAX) msg = 'Move back a little';
    else if (Math.abs(cx - 0.5) > 0.15 || Math.abs(cy - 0.47) > 0.2) msg = 'Centre your face in the oval';
    if (msg) { good = 0; descriptors.length = 0; hintEl.textContent = msg; continue; }
    good++;
    if (det.descriptor) descriptors.push(det.descriptor);
    hintEl.textContent = 'Hold still…';
    if (good >= 4 && descriptors.length >= 3) return { det, descriptors };
  }
}

function cropFor(box) {
  const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
  const side = Math.min(1.6 * Math.max(box.w, box.h), vw, vh);
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2 - 0.08 * box.h;
  return {
    x: Math.max(0, Math.min(vw - side, cx - side / 2)),
    y: Math.max(0, Math.min(vh - side, cy - side / 2)),
    side,
  };
}
const toCrop = (lm, crop) => lm.map(([x, y]) => [(x - crop.x) * CROP / crop.side, (y - crop.y) * CROP / crop.side]);

function setFlash(css, id) {
  flashEl.style.background = css;
  flashEl.dataset.p = id || '';
}

// Plays the sequence on display frames (requestAnimationFrame) and records when each
// pattern went up. The camera's own lag is measured afterwards from the reflection itself.
function playSequence(seq) {
  return new Promise(resolve => {
    const slots = [];
    let i = -1, next = 0;
    const tick = ts => {
      if (cancelled) { resolve(slots); return; }
      if (i < 0 || ts >= next) {
        if (i >= 0) slots[i].t1 = ts;
        i++;
        if (i >= seq.length) { resolve(slots); return; }
        setFlash(PATTERNS[seq[i].p].css, seq[i].p);
        slots.push({ p: seq[i].p, rep: seq[i].rep, t0: ts, t1: Infinity });
        next = ts + seq[i].ms;
        progressBar.style.width = `${((i + 1) / seq.length) * 100}%`;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function detectStable(tries = 4) {
  for (let k = 0; k < tries; k++) {
    const d = await Face.detect(videoEl, false);
    if (d) return d;
    await sleep(60);
  }
  return null;
}

async function runScan() {
  const t = { started: Date.now() };
  showScreen('scan');
  cancelled = false;
  flashEl.hidden = true; progressEl.hidden = true; guideEl.hidden = false;
  hintEl.hidden = false; $('btn-cancel').hidden = false;
  hintEl.textContent = 'Starting camera…';
  await acquireWakeLock();
  await startCamera();
  hintEl.textContent = 'Loading face models…';
  await Face.load();

  // 1. line up, collect the identity descriptor
  const pos = await positionFace();
  const frameMs = await measureFrameInterval();
  checkCancel();

  // 2. light the face evenly, lock white balance, take the landmarks
  hintEl.hidden = true; guideEl.hidden = true; $('btn-cancel').hidden = true;
  await setMaxBrightness();
  setFlash('#9a9a9a', 'prep');
  flashEl.hidden = false;
  await sleep(650);
  const wbLocked = await lockWhiteBalance();
  await sleep(250);
  const startDet = (await detectStable()) || pos.det;
  const tStart = performance.now();
  const crop = cropFor(startDet.box);

  // 3. the flash sequence (slots last at least ~5 camera frames)
  const slotMs = Math.round(Math.min(400, Math.max(190, 5 * frameMs)));
  const seq = buildSequence(slotMs);
  const sampler = startSampler(crop);
  progressEl.hidden = false; progressBar.style.width = '0%';
  setFlash('#000', 'K');
  await nextFrame();
  const slots = await playSequence(seq);
  // the camera lags the screen: keep black up while the last frames arrive
  setFlash('#000', 'K');
  await sleep(700);
  slots[slots.length - 1].t1 = performance.now();
  sampler.stop();
  checkCancel();

  // 4. where is the face now (it must not have moved)
  setFlash('#9a9a9a', 'prep');
  progressEl.hidden = true;
  await sleep(350);
  const endDet = (await detectStable()) || startDet;
  const tEnd = performance.now();
  await unlockWhiteBalance(wbLocked);
  await restoreBrightness();
  flashEl.hidden = true;

  // 5. analyse
  const input = {
    w: CROP, h: CROP, frames: sampler.frames, slots,
    lmStart: toCrop(startDet.landmarks, crop), lmEnd: toCrop(endDet.landmarks, crop),
    tStart, tEnd,
  };
  const analysis = Analysis.analyzeScan(input);
  const descriptor = averageDescriptor(pos.descriptors);
  const cam = { ...cameraInfo(), whiteBalanceLocked: wbLocked, frameMs, slotMs, crop };
  t.ms = Date.now() - t.started;
  return { analysis, descriptor, cam, timing: t };
}

function averageDescriptor(list) {
  const out = new Array(128).fill(0);
  for (const d of list) for (let i = 0; i < 128; i++) out[i] += d[i] / list.length;
  return out;
}

function cleanup() {
  setFlash('#000', '');
  flashEl.hidden = true;
  stopCamera();
  releaseWakeLock();
  restoreBrightness();
}

// ── Result display ────────────────────────────────────────────────────────────
const FAIL_TEXT = {
  capture: 'The camera gave no usable frames. Try again.',
  still: 'You (or the phone) moved during the scan. Rest your elbows and keep still for the whole flash sequence.',
  tracking: 'The face did not reflect the random flashes in step: typical of a screen replay or a picture.',
  coverage: 'Too little of the flash reached the face. Come closer (25–35 cm) or dim the room.',
  emission: 'The face is far brighter than the flash can explain: a lit screen, or the room is too bright.',
  glare: 'Mirror-like glare: a glossy photo or a phone/tablet screen.',
  depthH: 'Side lighting found a flat surface, not a 3D face (a photo or a screen).',
  depthV: 'Top/bottom lighting found a flat surface, not a 3D face (a photo or a screen).',
};

function showResult(scan) {
  cleanup();
  showScreen('result');
  const a = scan.analysis;
  const iconEl = $('result-icon'), titleEl = $('result-title'), summaryEl = $('result-summary');
  const bar = $('result-score-bar'), val = $('result-score-value');
  const retry = $('btn-retry');
  const firstFail = a.checks.find(c => !c.pass);

  let identity = null;
  if (scanMode === 'verify' && storedTemplate) {
    const faceDist = Analysis.descriptorDistance(scan.descriptor, storedTemplate.descriptor);
    const specDist = storedTemplate.spectral
      ? Analysis.spectralDistance(a.spectral.features, storedTemplate.spectral)
      : NaN;
    identity = {
      faceDist, specDist,
      faceOk: faceDist <= a.config.identityMaxDist,
      specOk: !storedTemplate.spectral || (Number.isFinite(specDist) && specDist <= a.config.spectralMaxDist),
    };
  }

  if (scanMode === 'register') {
    if (a.live) {
      storedTemplate = {
        version: 3, createdAt: new Date().toISOString(),
        descriptor: scan.descriptor.map(v => +v.toFixed(5)),
        spectral: a.spectral.features ? a.spectral.features.map(v => +v.toFixed(4)) : null,
      };
      saveTemplate(storedTemplate);
      setTitle('✅', 'Face registered', 'ok', 'Live face confirmed. Your face and skin spectrum are saved on this phone.');
      retry.textContent = 'Continue to verify';
    } else {
      setTitle('❌', 'Not registered', 'bad', (FAIL_TEXT[firstFail.id] || '') + ' Only a live face can register.');
      retry.textContent = 'Try again';
    }
  } else {
    const passed = a.live && identity && identity.faceOk && identity.specOk;
    if (passed) setTitle('✅', 'Identity verified', 'ok', 'Live face, and it matches the registered one.');
    else if (!a.live) setTitle('❌', 'Liveness check failed', 'bad', FAIL_TEXT[firstFail.id] || '');
    else if (!identity.faceOk) setTitle('⛔', 'Different person', 'warn', 'A live face, but not the registered one.');
    else setTitle('⛔', 'Skin spectrum mismatch', 'warn', 'The face matches, but its skin reflects the screen light differently from your registration.');
    retry.textContent = 'Try again';
  }

  function setTitle(icon, title, cls, summary) {
    iconEl.textContent = icon;
    titleEl.textContent = title;
    titleEl.className = cls;
    summaryEl.textContent = summary;
  }

  bar.style.background = a.live ? 'linear-gradient(90deg,#22c55e,#86efac)' : 'linear-gradient(90deg,#ef4444,#fca5a5)';
  bar.style.width = '0%';
  requestAnimationFrame(() => requestAnimationFrame(() => {
    bar.style.width = `${a.score}%`;
    val.textContent = `${a.score} / 100`;
  }));

  const idBlock = $('identity-block');
  idBlock.hidden = !identity;
  if (identity) {
    const fe = $('id-face'), se = $('id-spectral');
    fe.textContent = Number.isFinite(identity.faceDist) ? `${identity.faceOk ? 'Match' : 'No match'} (${identity.faceDist.toFixed(2)})` : '—';
    fe.className = 'id-value ' + (identity.faceOk ? 'ok' : 'bad');
    se.textContent = storedTemplate.spectral
      ? (Number.isFinite(identity.specDist) ? `${identity.specOk ? 'Match' : 'Differs'} (${identity.specDist.toFixed(2)})` : 'Not measured')
      : 'Not in template';
    se.className = 'id-value ' + (identity.specOk ? 'ok' : 'bad');
  }

  $('result-checks').innerHTML = a.checks.map(c => `
    <div class="check-row">
      <div class="check-mark">${c.pass ? '✅' : '❌'}</div>
      <div class="check-label">${esc(c.label)}</div>
      <div class="check-detail">${esc(c.detail)}</div>
    </div>`).join('');

  lastReport = buildReport(scan, identity);
  $('diag').hidden = true;
  $('btn-details').textContent = 'Show measurement details';
}

const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

function buildReport(scan, identity) {
  const a = scan.analysis;
  const round = v => (typeof v === 'number' && Number.isFinite(v) ? +v.toFixed(4) : v);
  const r = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'number' ? round(v) : v)));
  return {
    app: 'LivenessCheck', build: window.APP_BUILD || null, mode: scanMode, when: new Date().toISOString(),
    live: a.live, score: a.score,
    checks: a.checks.map(c => ({ id: c.id, pass: c.pass, detail: c.detail })),
    metrics: r({ ...a.metrics, lagCurve: undefined }),
    identity: identity && r(identity),
    spectral: r(a.spectral),
    patches: r(a.patches),
    responses: r(a.responses),
    camera: r(scan.cam),
    durationMs: scan.timing.ms,
    userAgent: navigator.userAgent,
    analysis: scan,   // removed below; kept for maps
  };
}

function renderDiagnostics() {
  const scan = lastReport.analysis;
  const a = scan.analysis;
  const maps = a.maps;
  if (maps) {
    drawMap($('map-white'), maps.white, maps, 'gray');
    drawMap($('map-horiz'), maps.horiz, maps, 'diverging');
    drawMap($('map-vert'), maps.vert, maps, 'diverging');
  }
  const sp = a.spectral;
  $('spectral-table').innerHTML = sp && sp.matrix ? `
    <table>
      <caption>Skin response to the screen's light (each camera channel's share from each colour)</caption>
      <tr><th></th><th style="color:#f87171">Red light</th><th style="color:#4ade80">Green light</th><th style="color:#60a5fa">Blue light</th></tr>
      ${['Red', 'Green', 'Blue'].map((n, c) => `<tr><th>${n} channel</th>${sp.matrix[c].map(v => `<td>${(v * 100).toFixed(1)}%</td>`).join('')}</tr>`).join('')}
    </table>
    <p class="diag-note">White ÷ (red + green + blue) on skin: ${Number.isFinite(a.metrics.superposition) ? a.metrics.superposition.toFixed(2) : '—'} (≈ 1 means every screen colour is just a mix of the three)</p>` : '<p class="diag-note">Spectral response not measured.</p>';
  const { analysis, ...rest } = lastReport;
  $('diag-json').value = JSON.stringify(rest, null, 1);
}

function drawMap(canvas, data, maps, kind) {
  const ctx = canvas.getContext('2d');
  canvas.width = maps.w; canvas.height = maps.h;
  const img = ctx.createImageData(maps.w, maps.h);
  if (!data) { ctx.fillStyle = '#111'; ctx.fillRect(0, 0, maps.w, maps.h); return; }
  const vals = Array.from(data).filter(Number.isFinite);
  const sorted = vals.slice().sort((x, y) => x - y);
  const q = p => sorted[Math.floor(p * (sorted.length - 1))] || 0;
  const lo = q(0.02), hi = q(0.98), mid = q(0.5);
  const span = Math.max(Math.abs(hi - mid), Math.abs(mid - lo), 1e-6);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    const o = i * 4;
    img.data[o + 3] = 255;
    if (!Number.isFinite(v)) continue;
    if (kind === 'gray') {
      const g = Math.max(0, Math.min(255, 255 * (v - lo) / Math.max(hi - lo, 1e-6)));
      img.data[o] = img.data[o + 1] = img.data[o + 2] = g;
    } else {
      const t = Math.max(-1, Math.min(1, (v - mid) / span));
      img.data[o] = t > 0 ? 255 : 255 * (1 + t);
      img.data[o + 1] = 255 * (1 - Math.abs(t)) * 0.9 + 20;
      img.data[o + 2] = t < 0 ? 255 : 255 * (1 - t);
    }
  }
  // mirror for display so it matches what the user saw in the preview
  const tmp = document.createElement('canvas');
  tmp.width = maps.w; tmp.height = maps.h;
  tmp.getContext('2d').putImageData(img, 0, 0);
  ctx.save(); ctx.translate(maps.w, 0); ctx.scale(-1, 1); ctx.drawImage(tmp, 0, 0); ctx.restore();
}

// ── Button handlers ───────────────────────────────────────────────────────────
async function startScan(mode) {
  scanMode = mode;
  try {
    const scan = await runScan();
    showResult(scan);
  } catch (err) {
    cleanup();
    if (!(err instanceof Cancelled)) alert((err && err.name === 'NotAllowedError')
      ? 'Camera permission is needed for the scan.'
      : 'Scan error: ' + (err && err.message ? err.message : err));
    showScreen(storedTemplate ? 'start' : 'register');
  }
}

$('btn-register').addEventListener('click', () => startScan('register'));
$('btn-verify').addEventListener('click', () => startScan('verify'));
$('btn-cancel').addEventListener('click', () => { cancelled = true; });

$('btn-reregister').addEventListener('click', () => {
  if (!confirm('Delete the registered face and register again?')) return;
  clearTemplate();
  storedTemplate = null;
  showScreen('register');
});

$('btn-retry').addEventListener('click', () => {
  showScreen(storedTemplate ? 'start' : 'register');
});

$('btn-details').addEventListener('click', () => {
  const d = $('diag');
  d.hidden = !d.hidden;
  $('btn-details').textContent = d.hidden ? 'Show measurement details' : 'Hide measurement details';
  if (!d.hidden && lastReport) renderDiagnostics();
});

$('btn-copy').addEventListener('click', async () => {
  const ta = $('diag-json');
  try { await navigator.clipboard.writeText(ta.value); }
  catch (_) { ta.select(); document.execCommand('copy'); }
  $('btn-copy').textContent = 'Copied';
  setTimeout(() => { $('btn-copy').textContent = 'Copy report'; }, 1500);
});

// ── Init ──────────────────────────────────────────────────────────────────────
storedTemplate = loadTemplate();
showScreen(storedTemplate ? 'start' : 'register');
Face.load().then(() => {
  $('btn-register').disabled = false; $('btn-register').textContent = 'Register my face';
  $('btn-verify').disabled = false; $('btn-verify').textContent = 'Verify identity';
}).catch(err => {
  $('btn-register').textContent = $('btn-verify').textContent = 'Face models failed to load';
  console.error(err);
});
