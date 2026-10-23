// Virtual front camera for end-to-end tests in desktop Chrome. Injected before the app loads;
// replaces getUserMedia with a canvas stream showing a face photo lit by whatever the app's
// #flash layer is showing, a camera-lag later. The lighting comes from the same simulated
// irradiance maps as the Node tests (sim_geometry.py): a 3D face mesh, or a flat print.
// Config comes from ?vcam={...} in the page URL.
(() => {
  'use strict';
  const q = new URLSearchParams(location.search).get('vcam');
  if (!q) return;
  const C = Object.assign({
    surface: 'face', img: '', crop: [0, 0, 512, 512], lagMs: 120, ambient: 0.05, screen: 0.55,
    emission: 0, diffuse: 1, glare: 0, noiseDN: 1.2,
  }, JSON.parse(q));

  const W = 480, H = 640, Y0 = 80;            // photo occupies a 480x480 square at y=80
  const CROSS = [[1, 0.12, 0.02], [0.10, 1, 0.15], [0.02, 0.20, 1]];
  const CONTENT = { K: [0, 0, 0], W: [1, 1, 1], R: [1, 0, 0], G: [0, 1, 0], B: [0, 0, 1],
    HL: [1, 1, 1], HR: [1, 1, 1], HT: [1, 1, 1], HB: [1, 1, 1], SA: [1, 1, 1], SB: [1, 1, 1],
    prep: [0.32, 0.32, 0.32], ui: [0.12, 0.12, 0.12] };
  const MAPOF = { K: 'W', W: 'W', R: 'W', G: 'W', B: 'W', HL: 'HL', HR: 'HR', HT: 'HT', HB: 'HB', SA: 'SA', SB: 'SB', prep: 'W', ui: 'W' };
  const HALF = { HL: 1, HR: 1, HT: 1, HB: 1, SA: 1, SB: 1 };
  const LUT = new Float32Array(256).map((_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  const ENC = new Float32Array(8193).map((_, i) => { const c = i / 8192; return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055); });
  const enc = v => ENC[Math.round(Math.max(0, Math.min(1, v)) * 8192)];

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const history = [{ t: -1e9, p: 'ui' }];
  let frames = null;   // pattern -> [ImageData, ImageData] (two noise draws)
  window.__vcamState = { ready: false };

  const patternNow = () => {
    const f = document.getElementById('flash');
    return !f || f.hidden ? 'ui' : (f.dataset.p || 'K');
  };
  const watch = () => {
    const f = document.getElementById('flash');
    if (!f) return setTimeout(watch, 50);
    new MutationObserver(() => {
      const p = patternNow();
      if (p !== history[history.length - 1].p) history.push({ t: performance.now(), p });
    }).observe(f, { attributes: true });
  };
  document.addEventListener('DOMContentLoaded', watch);

  async function loadImage(src) {
    const im = new Image();
    im.src = src;
    await im.decode();
    return im;
  }

  async function fixture() {
    const r = await fetch('/test/fixtures/sim.json.gz');
    const text = await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).text();
    return JSON.parse(text);
  }

  async function prepare() {
    const [fx, im] = await Promise.all([fixture(), loadImage(C.img)]);
    ctx.fillStyle = '#202020'; ctx.fillRect(0, 0, W, H);
    ctx.drawImage(im, C.crop[0], C.crop[1], C.crop[2], C.crop[3], 0, Y0, W, W);
    const base = ctx.getImageData(0, 0, W, H);
    await window.Face.load();
    const det = await window.Face.detect(canvas, false);
    if (!det) throw new Error('virtualcam: no face in the test photo');

    // similarity transform from the simulation's crop to this canvas (Procrustes on 68 points)
    const src = fx.landmarks, dst = det.landmarks;
    const mean = a => [a.reduce((s, p) => s + p[0], 0) / a.length, a.reduce((s, p) => s + p[1], 0) / a.length];
    const ms = mean(src), md = mean(dst);
    let sxx = 0, sxy = 0, ss = 0;
    for (let i = 0; i < 68; i++) {
      const a = [src[i][0] - ms[0], src[i][1] - ms[1]], b = [dst[i][0] - md[0], dst[i][1] - md[1]];
      sxx += a[0] * b[0] + a[1] * b[1]; sxy += a[0] * b[1] - a[1] * b[0]; ss += a[0] ** 2 + a[1] ** 2;
    }
    const th = Math.atan2(sxy, sxx), sc = Math.hypot(sxx, sxy) / ss;
    const toSim = (x, y) => {      // inverse map canvas -> sim coords
      const dx = (x - md[0]) / sc, dy = (y - md[1]) / sc;
      return [ms[0] + Math.cos(th) * dx + Math.sin(th) * dy, ms[1] - Math.sin(th) * dx + Math.cos(th) * dy];
    };

    const n = fx.n, maps = {};
    for (const [k, arr] of Object.entries(fx.cases[C.surface])) maps[k] = Float32Array.from(arr, v => (v === 65535 ? NaN : v / 65000));
    const sample = (m, x, y) => {
      const x0 = Math.floor(x - 0.5), y0 = Math.floor(y - 0.5);
      if (x0 < 0 || y0 < 0 || x0 >= n - 1 || y0 >= n - 1) return NaN;
      const fx_ = x - 0.5 - x0, fy = y - 0.5 - y0, i = y0 * n + x0;
      return (m[i] * (1 - fx_) + m[i + 1] * fx_) * (1 - fy) + (m[i + n] * (1 - fx_) + m[i + n + 1] * fx_) * fy;
    };
    const glareAt = (x, y) => {      // mirror point of a flat print on the screen (sim geometry)
      const t = fx.zc - fx.planeZ, qx = 2 * ((x - n / 2) / fx.focal) * t, qy = 2 * (-(y - n / 2) / fx.focal) * t;
      const { w, h, gap } = fx.screen;
      if (qx < -w / 2 || qx > w / 2 || qy > -gap || qy < -gap - h) return null;
      const bar = Math.min(7, Math.floor((w / 2 - qx) / (w / 8)));
      return { HL: qx >= 0, HR: qx < 0, HT: qy > -gap - h / 2, HB: qy <= -gap - h / 2, SA: bar % 2 === 0, SB: bar % 2 === 1 };
    };

    // per pixel: albedo, and the screen irradiance for every map
    const N = W * H, alb = new Float32Array(N * 3), E = {}, G = new Array(N).fill(null), amb = new Float32Array(N);
    for (const k of Object.keys(maps)) E[k] = new Float32Array(N);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      for (let c = 0; c < 3; c++) alb[i * 3 + c] = LUT[base.data[i * 4 + c]];
      const [sx, sy] = toSim(x + 0.5, y + 0.5);
      const inFace = Number.isFinite(sample(maps.W, sx, sy));
      for (const k of Object.keys(maps)) E[k][i] = inFace ? sample(maps[k], sx, sy) || 0 : 0;
      amb[i] = inFace ? 0.35 + E.AMB[i] : 0.8;
      if (C.glare && inFace) G[i] = glareAt(sx, sy);
    }
    const rnd = (() => { let s = 7; return () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296); })();
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    frames = {};
    for (const p of Object.keys(CONTENT)) {
      frames[p] = [0, 1].map(() => {
        const out = new ImageData(W, H);
        for (let i = 0; i < N; i++) {
          const e = E[MAPOF[p]][i], con = CONTENT[p];
          const lit = G[i] && p !== 'K' && (!(p in HALF) || G[i][p]);
          for (let c = 0; c < 3; c++) {
            let screen = 0;
            for (let k = 0; k < 3; k++) screen += CROSS[c][k] * con[k];
            const a = alb[i * 3 + c] * 1.6;
            let lin = a * (C.ambient * amb[i] + C.screen * C.diffuse * screen * e) + C.emission * a * amb[i];
            if (lit) lin += C.glare * C.screen * screen;
            out.data[i * 4 + c] = Math.round(enc(lin) + C.noiseDN * gauss());
          }
          out.data[i * 4 + 3] = 255;
        }
        return out;
      });
    }
    window.__vcamState = { ready: true, faceW: det.box.w / W };
  }

  let flip = 0;
  function render() {
    if (frames) {
      const t = performance.now() - C.lagMs;
      let p = 'ui';
      for (let k = history.length - 1; k >= 0; k--) if (history[k].t <= t) { p = history[k].p; break; }
      flip ^= 1;
      ctx.putImageData((frames[p] || frames.ui)[flip], 0, 0);
    }
    requestAnimationFrame(render);
  }

  let running = false;
  navigator.mediaDevices.getUserMedia = async () => {
    if (!frames) await prepare();
    if (!running) { running = true; requestAnimationFrame(render); }
    return canvas.captureStream(30);
  };
})();
