// Reflection analysis: turns the frames captured while the screen flashed into liveness
// evidence. Pure functions (no DOM), so the same code runs in the app and in the Node tests.
//
// The model: a camera pixel (linearised) = ambient + reflection of the screen's light.
// Reflection is linear in the light, so subtracting the neighbouring black slot leaves only
// the part the face reflected. From that:
//   tracking   the face's brightness follows the random sequence, with a plausible lag
//   coverage   every part of the face reflects the flash (a screen only mirrors it in a patch)
//   emission   the face is not much brighter than the flash can explain (self-lit screen)
//   glare      no mirror-like glare (glossy photo, phone screen)
//   depth      left-vs-right and top-vs-bottom light shade the face like a 3D surface:
//              log(I_left / I_right) steps across the nose and log(I_top / I_bottom) is
//              far from planar. Albedo (the printed picture) cancels in the ratio, so a photo
//              of a face, flat, tilted or bent, gives a smooth near-planar map.
//   spectral   the 3x3 response of the camera's R,G,B channels to the screen's R,G,B light,
//              normalised per channel (white balance and exposure cancel). Compared with the
//              registered template on verification.
// Patch "L"/"R" in names means image-left/right; the depth test only uses signs relative to
// the measured gradient, so it doesn't care whether the camera mirrors the picture.

(function (root) {
  'use strict';

  const CONFIG = {
    lagMinMs: -40, lagMaxMs: 700, lagStepMs: 4,
    marginFrames: 0.6,          // frames this close to a slot edge (in frame periods) are skipped
    satLevel: 250,              // 8-bit value treated as clipped
    trackR2Min: 0.80,           // sequence-tracking fit quality
    coverageSnrMin: 6,          // white-flash reflection vs frame-to-frame noise, per patch
    coverageFracMin: 0.70,      // share of face patches that must reflect
    emissionMax: 30,            // ambient (or self-emission) / reflected-white, median patch
    glareDevH: 0.6, glareDevV: 0.9, glareBright: 3.5, glareMaxPatches: 2,
    stripeMax: 0.35,            // |log(stripes / complement)|, simulated face ≤ 0.07 at 95%
    stripePixel: 0.4, stripeFracMax: 0.03,   // per pixel: share of the face that mirrors the bars
    stepChromaMax: 1.6,         // green or blue nose step vs red (shape alone: 1.0)
    noseStepMin: 0.05, noseStepSigma: 4, noseStepMax: 0.6,   // simulated face 0.17, prints < 0.005
    vResidMin: 0.015, vResidF: 6, vResidMax: 0.3,           // simulated face 0.058, prints < 0.002
    noiseMaxLog: 0.08,          // rep-to-rep spread of the log maps (movement, flicker)
    stillMaxFrac: 0.05,         // landmark drift start->end, fraction of face width
    identityMaxDist: 0.50,      // face-api descriptor distance (0.6 is its usual default)
    spectralMaxDist: 0.35,      // RMS of the log spectral ratios vs the template
  };

  const LUT = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    LUT[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  // ── small maths helpers ────────────────────────────────────────────────────
  const median = a => {
    const b = a.filter(Number.isFinite).sort((x, y) => x - y);
    if (!b.length) return NaN;
    const m = b.length >> 1;
    return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
  };
  const clamp01 = x => Math.max(0, Math.min(1, x));
  const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const centroid = (...p) => [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[1], 0) / p.length];

  // Least squares via normal equations (tiny systems, well conditioned after normalising).
  function lstsq(rows, y) {
    const k = rows[0].length;
    const A = Array.from({ length: k }, () => new Float64Array(k + 1));
    for (let r = 0; r < rows.length; r++) {
      for (let i = 0; i < k; i++) {
        for (let j = 0; j < k; j++) A[i][j] += rows[r][i] * rows[r][j];
        A[i][k] += rows[r][i] * y[r];
      }
    }
    for (let c = 0; c < k; c++) {
      let piv = c;
      for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      [A[c], A[piv]] = [A[piv], A[c]];
      if (Math.abs(A[c][c]) < 1e-12) return null;
      for (let r = 0; r < k; r++) {
        if (r === c) continue;
        const f = A[r][c] / A[c][c];
        for (let j = c; j <= k; j++) A[r][j] -= f * A[c][j];
      }
    }
    return Array.from({ length: k }, (_, i) => A[i][k] / A[i][i]);
  }

  // ── face geometry ──────────────────────────────────────────────────────────
  // 68-point (iBUG) landmarks -> sample patches away from albedo edges (brows, eyes,
  // nostrils, lips) and away from where glasses sit.
  function facePatches(L) {
    const p = i => L[i];
    const W = dist2(p(0), p(16));
    let up = [p(27)[0] - p(8)[0], p(27)[1] - p(8)[1]];
    const n = Math.hypot(up[0], up[1]) || 1;
    up = [up[0] / n, up[1] / n];
    const add = (a, s) => [a[0] + up[0] * s, a[1] + up[1] * s];
    const cheekL = centroid(p(41), p(2), p(31));
    const cheekR = centroid(p(46), p(14), p(35));
    const flank = lerp(p(28), p(30), 0.6);
    const defs = [
      ['foreheadC', add(centroid(p(19), p(24)), 0.17 * W), { skin: true }],
      ['foreheadL', add(p(19), 0.13 * W), { skin: true }],
      ['foreheadR', add(p(24), 0.13 * W), { skin: true }],
      ['glabella', p(27), { glareExempt: true }],
      ['noseBridge', lerp(p(27), p(30), 0.45), { glareExempt: true, nose: true }],
      ['noseTip', lerp(p(30), p(33), 0.3), { glareExempt: true, nose: true }],
      ['noseFlankL', lerp(flank, p(31), 0.55), { nose: true }],
      ['noseFlankR', lerp(flank, p(35), 0.55), { nose: true }],
      ['cheekL', cheekL, { skin: true }],
      ['cheekR', cheekR, { skin: true }],
      ['cheekOuterL', lerp(cheekL, p(1), 0.5), { skin: true }],
      ['cheekOuterR', lerp(cheekR, p(15), 0.5), { skin: true }],
      ['philtrum', lerp(p(33), p(51), 0.5), {}],
      ['chin', lerp(p(57), p(8), 0.5), { skin: true }],
      ['jawL', lerp(p(4), p(48), 0.45), {}],
      ['jawR', lerp(p(12), p(54), 0.45), {}],
    ];
    return {
      width: W,
      patches: defs.map(([id, pt, f]) => ({ id, x: pt[0], y: pt[1], r: (f.nose ? 0.035 : 0.045) * W, ...f })),
    };
  }

  function patchPixels(patch, w, h) {
    const out = [];
    const r = Math.max(1.5, patch.r);
    const x0 = Math.max(0, Math.floor(patch.x - r)), x1 = Math.min(w - 1, Math.ceil(patch.x + r));
    const y0 = Math.max(0, Math.floor(patch.y - r)), y1 = Math.min(h - 1, Math.ceil(patch.y + r));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if ((x + 0.5 - patch.x) ** 2 + (y + 0.5 - patch.y) ** 2 <= r * r) out.push(y * w + x);
      }
    }
    return out;
  }

  // Face outline: jaw (0..16) then brows right-to-left (26..17), lifted a little for the forehead.
  function faceMask(L, w, h) {
    const W = dist2(L[0], L[16]);
    let up = [L[27][0] - L[8][0], L[27][1] - L[8][1]];
    const n = Math.hypot(up[0], up[1]) || 1;
    up = [up[0] / n, up[1] / n];
    const poly = [];
    for (let i = 0; i <= 16; i++) poly.push(L[i]);
    for (let i = 26; i >= 17; i--) poly.push([L[i][0] + up[0] * 0.12 * W, L[i][1] + up[1] * 0.12 * W]);
    const idx = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const px = x + 0.5, py = y + 0.5;
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const [xi, yi] = poly[i], [xj, yj] = poly[j];
          if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
        }
        if (inside) idx.push(y * w + x);
      }
    }
    return idx;
  }

  // ── timing: find the camera's lag behind the screen ───────────────────────
  // For each candidate lag, frames are binned into the slot that was on screen when they
  // were exposed. The brightness is then fitted as "one level per pattern + a slow drift",
  // and the score is how much of what the drift leaves over the patterns explain (partial
  // R^2). A face reflecting the screen scores ~1; anything that doesn't react to the flashes
  // (a static picture, a replay of another scan) scores ~0, however much it drifts.
  const SEQ_PATTERNS = ['W', 'R', 'G', 'B', 'HL', 'HR', 'HT', 'HB', 'SA', 'SB'];
  function slotAt(slots, t) {
    let lo = 0, hi = slots.length - 1;
    if (t < slots[0].t0 || t >= slots[hi].t1) return -1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (slots[mid].t0 <= t) lo = mid; else hi = mid - 1;
    }
    return t < slots[lo].t1 ? lo : -1;
  }

  function fitLag(times, y, slots, cfg) {
    const dts = [];
    for (let i = 1; i < times.length; i++) dts.push(times[i] - times[i - 1]);
    const frameDt = median(dts.filter(d => d > 0)) || 33;
    const margin = cfg.marginFrames * frameDt;
    const tFirst = times[0], span = Math.max(1, times[times.length - 1] - tFirst);
    let best = { r2: -Infinity, lag: NaN, assign: null, frameDt };
    const curve = [];
    const sse = (rows, ys) => {
      const c = lstsq(rows, ys);
      if (!c) return NaN;
      let e = 0;
      rows.forEach((r, i) => { const d = ys[i] - r.reduce((a, x, j) => a + x * c[j], 0); e += d * d; });
      return e;
    };
    for (let lag = cfg.lagMinMs; lag <= cfg.lagMaxMs; lag += cfg.lagStepMs) {
      const assign = new Int32Array(times.length).fill(-1);
      const cnt = new Int32Array(slots.length);
      for (let f = 0; f < times.length; f++) {
        const te = times[f] - lag;
        const s = slotAt(slots, te);
        if (s < 0 || te - slots[s].t0 < margin || slots[s].t1 - te < margin) continue;
        assign[f] = s; cnt[s]++;
      }
      let filled = 0;
      for (let s = 0; s < slots.length; s++) if (cnt[s]) filled++;
      if (filled < 0.85 * slots.length) { curve.push([lag, NaN]); continue; }
      const present = SEQ_PATTERNS.filter(p => slots.some((sl, s) => cnt[s] && sl.p === p));
      const drift = [], full = [], ys = [];
      for (let f = 0; f < times.length; f++) {
        const s = assign[f];
        if (s < 0) continue;
        const u = (2 * (times[f] - tFirst)) / span - 1;
        const d = [1, u, u * u, u * u * u];
        drift.push(d);
        full.push(d.concat(present.map(p => (slots[s].p === p ? 1 : 0))));
        ys.push(y[f]);
      }
      const eDrift = sse(drift, ys), eFull = sse(full, ys);
      const r2 = eDrift > 0 && Number.isFinite(eFull) ? 1 - eFull / eDrift : 0;
      curve.push([lag, r2]);
      if (r2 > best.r2) best = { r2, lag, assign, frameDt, filled };
    }
    best.curve = curve;
    return best;
  }

  // ── main entry ─────────────────────────────────────────────────────────────
  // input: { w, h, frames:[{times:{cap,disp,now}, data:Uint8ClampedArray(w*h*4)}],
  //          slots:[{p, rep, t0, t1}], lmStart, lmEnd (68 [x,y] in crop pixels), tStart, tEnd }
  function analyzeScan(input, overrides = {}) {
    const cfg = { ...CONFIG, ...overrides };
    const { w, h, frames, slots } = input;
    const N = w * h;
    const out = { config: cfg, checks: [], metrics: {}, patches: [], maps: null, live: false, score: 0 };

    if (!frames.length || !slots.length || !input.lmStart) {
      out.checks.push(check('capture', 'Camera frames', false, 'No frames were captured', 0));
      return finish(out);
    }

    // landmark drift between the detections before and after the flashes
    const lmEnd = input.lmEnd || input.lmStart;
    const geomStart = facePatches(input.lmStart);
    const faceW = geomStart.width;
    let drift = 0;
    for (let i = 0; i < 68; i++) drift += dist2(input.lmStart[i], lmEnd[i]);
    drift = drift / 68 / faceW;
    out.metrics.drift = drift;

    // per-frame face luminance (linear) for the timing fit
    const mask = faceMask(input.lmStart, w, h);
    const faceY = frames.map(fr => {
      let s = 0;
      const d = fr.data;
      for (const i of mask) s += LUT[d[i * 4]] + LUT[d[i * 4 + 1]] + LUT[d[i * 4 + 2]];
      return s / mask.length;
    });

    // try every clock the camera gave us; keep the one the sequence fits best
    let fit = null, clock = null;
    for (const key of ['cap', 'disp', 'now']) {
      const times = frames.map(f => f.times && f.times[key]);
      if (!times.every(Number.isFinite)) continue;
      const order = times.map((t, i) => [t, i]).sort((a, b) => a[0] - b[0]);
      if (order.some((o, k) => o[1] !== k)) continue;   // clock not monotonic, unusable
      const r = fitLag(times, faceY, slots, cfg);
      // clocks are tried best-first (capture time); a later one has to fit clearly better
      if (!fit || r.r2 > fit.r2 + 0.005) { fit = r; clock = key; }
    }
    if (!fit || !Number.isFinite(fit.r2)) {
      out.checks.push(check('tracking', 'Follows the flash sequence', false, 'Could not line frames up with the flashes', 0));
      return finish(out);
    }
    out.metrics.lagMs = fit.lag;
    out.metrics.trackR2 = fit.r2;
    out.metrics.clock = clock;
    out.metrics.frameMs = fit.frameDt;
    out.metrics.frames = frames.length;
    out.metrics.lagCurve = fit.curve.filter(c => Number.isFinite(c[1])).map(c => [c[0], +c[1].toFixed(3)]);

    // average the clean frames of each slot (linear RGB), and note clipped pixels
    const S = slots.length;
    const img = new Array(S).fill(null), sat = new Array(S).fill(null), nUsed = new Int32Array(S);
    for (let f = 0; f < frames.length; f++) {
      const s = fit.assign[f];
      if (s < 0) continue;
      if (!img[s]) { img[s] = new Float32Array(N * 3); sat[s] = new Uint8Array(N); }
      const d = frames[f].data, a = img[s], m = sat[s];
      for (let i = 0; i < N; i++) {
        const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
        a[i * 3] += LUT[r]; a[i * 3 + 1] += LUT[g]; a[i * 3 + 2] += LUT[b];
        if (r >= cfg.satLevel || g >= cfg.satLevel || b >= cfg.satLevel) m[i] = 1;
      }
      nUsed[s]++;
    }
    for (let s = 0; s < S; s++) if (img[s]) for (let i = 0; i < N * 3; i++) img[s][i] /= nUsed[s];

    // patch positions per slot: landmarks interpolated in time (small, slow drift)
    const tA = input.tStart ?? slots[0].t0, tB = input.tEnd ?? slots[S - 1].t1;
    const lmAt = t => {
      const u = tB > tA ? clamp01((t - tA) / (tB - tA)) : 0;
      return input.lmStart.map((p, i) => lerp(p, lmEnd[i], u));
    };
    const geomFor = s => facePatches(lmAt((slots[s].t0 + slots[s].t1) / 2)).patches;
    const P = geomStart.patches.length;

    const sampleRGB = (im, satMask, patch) => {
      const px = patchPixels(patch, w, h);
      let r = 0, g = 0, b = 0, n = 0;
      for (const i of px) {
        if (satMask && satMask[i]) continue;
        r += im[i * 3]; g += im[i * 3 + 1]; b += im[i * 3 + 2]; n++;
      }
      return n ? [r / n, g / n, b / n, n] : [NaN, NaN, NaN, 0];
    };

    // temporal noise per patch: spread of single frames around their slot's mean (black slots)
    const patchPx0 = geomStart.patches.map(pt => patchPixels(pt, w, h));
    const noise = new Float64Array(P);
    {
      const acc = new Float64Array(P), dof = new Float64Array(P);
      const perSlot = new Map();
      for (let f = 0; f < frames.length; f++) {
        const s = fit.assign[f];
        if (s < 0 || slots[s].p !== 'K') continue;
        const d = frames[f].data;
        const vals = patchPx0.map(px => {
          let v = 0;
          for (const i of px) v += LUT[d[i * 4]] + LUT[d[i * 4 + 1]] + LUT[d[i * 4 + 2]];
          return v / Math.max(1, px.length);
        });
        if (!perSlot.has(s)) perSlot.set(s, []);
        perSlot.get(s).push(vals);
      }
      for (const list of perSlot.values()) {
        if (list.length < 2) continue;
        for (let k = 0; k < P; k++) {
          const m = list.reduce((a, v) => a + v[k], 0) / list.length;
          for (const v of list) acc[k] += (v[k] - m) ** 2;
          dof[k] += list.length - 1;
        }
      }
      // floor: 8-bit quantisation of a mid-dark pixel averaged over the patch
      for (let k = 0; k < P; k++) noise[k] = Math.max(dof[k] ? Math.sqrt(acc[k] / dof[k]) : 0, 2e-4);
    }

    // ambient-subtracted response of every pattern slot
    const blackNear = s => {
      const before = [], after = [];
      for (let j = s - 1; j >= 0; j--) if (slots[j].p === 'K' && img[j]) { before.push(j); break; }
      for (let j = s + 1; j < S; j++) if (slots[j].p === 'K' && img[j]) { after.push(j); break; }
      return before.concat(after);
    };
    const resp = {};   // key "p:rep" -> {rgb:[P][3], Y:[P], sat}
    for (let s = 0; s < S; s++) {
      const sl = slots[s];
      if (sl.p === 'K' || !img[s]) continue;
      const ks = blackNear(s);
      if (!ks.length) continue;
      const diff = new Float32Array(N * 3);
      for (let i = 0; i < N * 3; i++) {
        let a = 0;
        for (const k of ks) a += img[k][i];
        diff[i] = img[s][i] - a / ks.length;
      }
      const geo = geomFor(s);
      const rgb = geo.map(pt => sampleRGB(diff, sat[s], pt));
      resp[`${sl.p}:${sl.rep}`] = { rgb, Y: rgb.map(v => v[0] + v[1] + v[2]), diff, slot: s };
    }
    // black level per patch (ambient or self-emission)
    const blackY = new Float64Array(P);
    {
      let n = 0;
      for (let s = 0; s < S; s++) {
        if (slots[s].p !== 'K' || !img[s]) continue;
        const geo = geomFor(s);
        geo.forEach((pt, k) => { const v = sampleRGB(img[s], null, pt); blackY[k] += v[0] + v[1] + v[2]; });
        n++;
      }
      for (let k = 0; k < P; k++) blackY[k] /= Math.max(1, n);
    }

    const get = (p, rep) => resp[`${p}:${rep}`];
    const W1 = get('W', 1), W2 = get('W', 2);
    const Wy = geomStart.patches.map((_, k) => median([W1 && W1.Y[k], W2 && W2.Y[k]]));

    // coverage + emission
    const snr = Wy.map((v, k) => v / noise[k]);
    const covered = snr.filter(v => v >= cfg.coverageSnrMin).length / P;
    const emission = median(Wy.map((v, k) => (v > 0 ? blackY[k] / v : NaN)));
    out.metrics.coverage = covered;
    out.metrics.emissionRatio = emission;

    // depth maps at the patches
    const logRatio = (a, b, k) => {
      if (!a || !b) return NaN;
      const ya = a.Y[k], yb = b.Y[k], floor = 3 * noise[k];
      return ya > floor && yb > floor ? Math.log(ya / yb) : NaN;
    };
    const hRep = [1, 2].map(rep => geomStart.patches.map((_, k) => logRatio(get('HL', rep), get('HR', rep), k)));
    const vRep = [1, 2].map(rep => geomStart.patches.map((_, k) => logRatio(get('HT', rep), get('HB', rep), k)));
    const avgReps = reps => reps[0].map((_, k) => {
      const v = reps.map(r => r[k]).filter(Number.isFinite);
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
    });
    const hMean = avgReps(hRep), vMean = avgReps(vRep);
    // Noise from how much the two repeats disagree. A uniform offset between repeats (the
    // exposure changed a little) is removed first: every fit below has an intercept for it.
    const repSpread = reps => {
      const d = [];
      for (let k = 0; k < P; k++) {
        if (Number.isFinite(reps[0][k]) && Number.isFinite(reps[1][k])) d.push(reps[0][k] - reps[1][k]);
      }
      if (d.length < 4) return NaN;
      const m = d.reduce((a, b) => a + b, 0) / d.length;
      return Math.sqrt(d.reduce((a, v) => a + (v - m) ** 2, 0) / (2 * (d.length - 1)));
    };
    const sigH = repSpread(hRep), sigV = repSpread(vRep);
    out.metrics.noiseH = sigH;
    out.metrics.noiseV = sigV;

    // normalised patch coordinates
    const xs = geomStart.patches.map(pt => pt.x), ys = geomStart.patches.map(pt => pt.y);
    const mx = xs.reduce((a, b) => a + b, 0) / P, my = ys.reduce((a, b) => a + b, 0) / P;
    const xn = xs.map(x => (x - mx) / faceW), yn = ys.map(y => (y - my) / faceW);
    const ids = geomStart.patches.map(pt => pt.id);
    const iL = ids.indexOf('noseFlankL'), iR = ids.indexOf('noseFlankR');

    // horizontal: step across the nose beyond a smooth trend of the rest of the face
    const stepOf = hv => {
      const others = ids.map((id, k) => k).filter(k => !ids[k].startsWith('nose') && Number.isFinite(hv[k]));
      if (others.length < 5 || !Number.isFinite(hv[iL]) || !Number.isFinite(hv[iR])) return { step: NaN, slope: NaN };
      const c = lstsq(others.map(k => [1, xn[k], yn[k], xn[k] ** 2]), others.map(k => hv[k]));
      if (!c) return { step: NaN, slope: NaN };
      const pred = k => c[0] + c[1] * xn[k] + c[2] * yn[k] + c[3] * xn[k] ** 2;
      return { step: (hv[iR] - pred(iR)) - (hv[iL] - pred(iL)), slope: c[1] };
    };
    const { step: noseStep, slope: slopeX } = stepOf(hMean);
    const signedStep = noseStep * Math.sign(slopeX || 1);

    // Shading from shape is the same in every colour channel (the skin colour cancels in the
    // ratio). Mirror glare is colourless, so on skin-coloured ink it is a bigger share of the
    // green/blue signal than of the red: the step grows in green and blue.
    const chanStep = c => {
      const reps = [1, 2].map(rep => {
        const a = get('HL', rep), b = get('HR', rep);
        return geomStart.patches.map((_, k) => {
          if (!a || !b) return NaN;
          const ya = a.rgb[k][c], yb = b.rgb[k][c], floor = 3 * noise[k];
          return ya > floor && yb > floor ? Math.log(ya / yb) : NaN;
        });
      });
      return stepOf(avgReps(reps)).step * Math.sign(slopeX || 1);
    };
    const stepRGB = [0, 1, 2].map(chanStep);
    const chroma = Number.isFinite(stepRGB[0]) && Math.abs(stepRGB[0]) > 0.02
      ? Math.max(...[1, 2].map(c => stepRGB[c] / stepRGB[0]).filter(Number.isFinite))
      : NaN;
    out.metrics.stepRGB = stepRGB;
    out.metrics.stepChroma = chroma;
    const sigMeanH = Number.isFinite(sigH) ? sigH / Math.SQRT2 : 0.03;
    const stepNeed = Math.max(cfg.noseStepMin, cfg.noseStepSigma * 1.2 * sigMeanH);
    out.metrics.noseStep = signedStep;
    out.metrics.noseStepNeed = stepNeed;

    // vertical: how far log(top/bottom) is from a smooth quadratic surface
    let vResid = NaN, vF = NaN;
    {
      const ks = ids.map((_, k) => k).filter(k => Number.isFinite(vMean[k]));
      if (ks.length >= 9) {
        const rows = ks.map(k => [1, xn[k], yn[k], xn[k] ** 2, xn[k] * yn[k], yn[k] ** 2]);
        const c = lstsq(rows, ks.map(k => vMean[k]));
        if (c) {
          let rss = 0;
          ks.forEach((k, r) => { const e = vMean[k] - rows[r].reduce((a, x, j) => a + x * c[j], 0); rss += e * e; });
          vResid = Math.sqrt(rss / ks.length);
          const sigMeanV = Number.isFinite(sigV) ? sigV / Math.SQRT2 : 0.03;
          vF = rss / (ks.length - 6) / Math.max(sigMeanV, 1e-3) ** 2;
        }
      }
    }
    out.metrics.vResid = vResid;
    out.metrics.vF = vF;

    // glare: mirror reflections make one half-screen dominate a patch, or a patch blaze.
    // Only patches that clearly reflect are judged; no reflection is the coverage check's call.
    const lit = k => snr[k] >= cfg.coverageSnrMin;
    const medH = median(hMean.filter((_, k) => lit(k)));
    const medV = median(vMean.filter((_, k) => lit(k)));
    const medW = median(Wy.filter((_, k) => lit(k)));
    const glare = geomStart.patches.map((pt, k) => {
      if (pt.glareExempt || !lit(k)) return false;
      const dh = Math.max(...[0, 1].map(r => Math.abs(hRep[r][k] - medH)).filter(Number.isFinite), 0);
      const dv = Math.max(...[0, 1].map(r => Math.abs(vRep[r][k] - medV)).filter(Number.isFinite), 0);
      return dh > cfg.glareDevH || dv > cfg.glareDevV || Wy[k] > cfg.glareBright * medW;
    });
    // stripes: a matte face averages the 8 bars out; a mirror shows them
    const SA = get('SA', 1), SB = get('SB', 1);
    const stripe = geomStart.patches.map((pt, k) => {
      if (!SA || !SB || !lit(k)) return NaN;
      const a = SA.Y[k], b = SB.Y[k], floor = 3 * noise[k];
      return a > floor && b > floor ? Math.log(a / b) : (a > floor || b > floor ? Infinity : NaN);
    });
    stripe.forEach((s, k) => {
      if (!geomStart.patches[k].glareExempt && Math.abs(s) > cfg.stripeMax) glare[k] = true;
    });
    out.metrics.stripeMax = Math.max(0, ...stripe.filter((s, k) => Number.isFinite(s) && !geomStart.patches[k].glareExempt).map(Math.abs));
    // the same per pixel: mirror images of the bars are finer than a patch. Eye areas are
    // skipped (glasses are mirrors too).
    let stripeFrac = NaN;
    if (SA && SB) {
      const L0 = input.lmStart;
      const eyes = [centroid(...L0.slice(36, 42)), centroid(...L0.slice(42, 48))];
      const lensR2 = (0.22 * faceW) ** 2;
      const lumA = i => SA.diff[i * 3] + SA.diff[i * 3 + 1] + SA.diff[i * 3 + 2];
      const lumB = i => SB.diff[i * 3] + SB.diff[i * 3 + 1] + SB.diff[i * 3 + 2];
      const levels = mask.map(i => Math.max(lumA(i), lumB(i)));
      const ref = median(levels);
      let lit = 0, mirror = 0;
      mask.forEach((i, j) => {
        const x = (i % w) + 0.5, y = Math.floor(i / w) + 0.5;
        if (eyes.some(e => (x - e[0]) ** 2 + (y - e[1]) ** 2 < lensR2)) return;
        if (sat[SA.slot][i] || sat[SB.slot][i] || !(levels[j] > 0.25 * ref)) return;
        lit++;
        const a = Math.max(lumA(i), 1e-6), b = Math.max(lumB(i), 1e-6);
        if (Math.abs(Math.log(a / b)) > cfg.stripePixel) mirror++;
      });
      stripeFrac = lit ? mirror / lit : NaN;
    }
    out.metrics.stripeFrac = stripeFrac;
    const striped = Number.isFinite(stripeFrac) && stripeFrac > cfg.stripeFracMax;
    const glareCount = glare.filter(Boolean).length;
    const noseGlare = glare[iL] || glare[iR];
    out.metrics.glarePatches = glareCount;
    // relief far beyond what a face can produce at arm's length is glare too
    const tooDeep = signedStep > cfg.noseStepMax || vResid > cfg.vResidMax;
    const tinted = Number.isFinite(chroma) && chroma > cfg.stepChromaMax;

    // spectral signature on skin patches: per camera channel, the share of each screen colour
    const R1 = get('R', 1), G1 = get('G', 1), B1 = get('B', 1);
    const spectral = spectralSignature(geomStart.patches, R1, G1, B1);
    out.spectral = spectral;
    // Superposition: light adds, so white (all three emitters) should reflect as red+green+blue.
    // A ratio near 1 shows every screen colour is just a mix of the three (OLED power limiting
    // full-white a little pulls it below 1).
    if (R1 && G1 && B1) {
      out.metrics.superposition = median(geomStart.patches.map((pt, k) =>
        pt.skin && lit(k) ? Wy[k] / (R1.Y[k] + G1.Y[k] + B1.Y[k]) : NaN));
    }

    // per-patch table for the diagnostics screen
    out.patches = geomStart.patches.map((pt, k) => ({
      id: pt.id, x: pt.x, y: pt.y, r: pt.r, snr: snr[k], white: Wy[k], black: blackY[k],
      h: hMean[k], v: vMean[k], stripe: stripe[k], glare: glare[k],
    }));

    // raw per-patch responses, so thresholds can be re-tuned from a copied report
    out.responses = Object.fromEntries(Object.entries(resp).map(([key, r]) => [key, r.rgb.map(v => v.slice(0, 3))]));
    out.responses.black = Array.from(blackY);
    out.responses.noise = Array.from(noise);

    // maps for display
    out.maps = buildMaps(w, h, get, mask);
    out.faceWidth = faceW;

    // ── checks (hard pass/fail) ──
    const noisy = (Number.isFinite(sigH) && sigH > cfg.noiseMaxLog) || (Number.isFinite(sigV) && sigV > cfg.noiseMaxLog);
    out.checks.push(check('still', 'Kept still', drift <= cfg.stillMaxFrac && !noisy,
      noisy ? `Readings jumped between repeats (${fmt(Math.max(sigH || 0, sigV || 0), 3)} > ${cfg.noiseMaxLog})`
            : `Moved ${(drift * 100).toFixed(1)}% of face width (max ${cfg.stillMaxFrac * 100}%)`,
      clamp01(1 - drift / (2 * cfg.stillMaxFrac))));
    out.checks.push(check('tracking', 'Follows the flash sequence', fit.r2 >= cfg.trackR2Min,
      `Fit R² ${fmt(fit.r2, 3)} (min ${cfg.trackR2Min}), camera lag ${Math.round(fit.lag)} ms`,
      clamp01((fit.r2 - 0.5) / 0.5)));
    out.checks.push(check('coverage', 'Whole face reflects the light', covered >= cfg.coverageFracMin,
      `${Math.round(covered * 100)}% of face regions (min ${cfg.coverageFracMin * 100}%)`, covered));
    out.checks.push(check('emission', 'Not self-lit', Number.isFinite(emission) && emission <= cfg.emissionMax,
      `Ambient/reflected ${fmt(emission, 2)} (max ${cfg.emissionMax})`,
      Number.isFinite(emission) ? clamp01(1 - emission / (2 * cfg.emissionMax)) : 0));
    const glareOk = !noseGlare && glareCount <= cfg.glareMaxPatches && !tooDeep && !tinted && !striped;
    out.checks.push(check('glare', 'No mirror-like glare', glareOk,
      noseGlare ? 'Glare on the nose'
        : striped ? `Reflects the stripe pattern like a mirror (${fmt(stripeFrac * 100, 1)}% of the face)`
        : tooDeep ? `Relief too strong for a face (nose ${fmt(signedStep, 2)}, max ${cfg.noseStepMax})`
        : tinted ? `Shading differs by colour channel (×${fmt(chroma, 2)}, max ${cfg.stepChromaMax})`
        : `${glareCount} glare region(s) (max ${cfg.glareMaxPatches}), stripes ${fmt(out.metrics.stripeMax, 2)}`,
      glareOk ? 1 : 0));
    out.checks.push(check('depthH', '3D shape: side light', Number.isFinite(signedStep) && signedStep >= stepNeed,
      `Nose step ${fmt(signedStep, 3)} (need ≥ ${fmt(stepNeed, 3)})`,
      Number.isFinite(signedStep) ? clamp01(signedStep / (2 * stepNeed)) : 0));
    out.checks.push(check('depthV', '3D shape: top/bottom light',
      Number.isFinite(vResid) && vResid >= cfg.vResidMin && vF >= cfg.vResidF,
      `Relief ${fmt(vResid, 3)} (need ≥ ${cfg.vResidMin}), F ${fmt(vF, 1)} (need ≥ ${cfg.vResidF})`,
      Number.isFinite(vResid) ? clamp01(Math.min(vResid / (2 * cfg.vResidMin), vF / (2 * cfg.vResidF))) : 0));
    return finish(out);
  }

  function spectralSignature(patches, R1, G1, B1) {
    const empty = { features: null, spread: NaN, matrix: null };
    if (!R1 || !G1 || !B1) return empty;
    const feats = [], mats = [];
    patches.forEach((pt, k) => {
      if (!pt.skin) return;
      // M[c][p]: camera channel c (R,G,B) under screen colour p (R,G,B)
      const M = [0, 1, 2].map(c => [R1.rgb[k][c], G1.rgb[k][c], B1.rgb[k][c]]);
      if (M.some(row => row.some(v => !(v > 0)))) return;
      mats.push(M);
      feats.push([
        Math.log(M[1][0] / M[1][1]),   // red light seen by the green channel, vs green light
        Math.log(M[2][1] / M[2][2]),   // green light seen by the blue channel, vs blue light
        Math.log(M[0][1] / M[0][0]),   // green light seen by the red channel, vs red light
        Math.log(M[1][2] / M[1][1]),   // blue light seen by the green channel, vs green light
      ]);
    });
    if (feats.length < 3) return empty;
    const features = [0, 1, 2, 3].map(j => median(feats.map(f => f[j])));
    const spread = median(feats.map(f => Math.sqrt(f.reduce((a, v, j) => a + (v - features[j]) ** 2, 0) / 4)));
    // row-normalised average matrix, for display
    const matrix = [0, 1, 2].map(c => {
      const row = [0, 1, 2].map(p => median(mats.map(M => M[c][p] / (M[c][0] + M[c][1] + M[c][2]))));
      return row;
    });
    return { features, spread, matrix, patches: feats.length };
  }

  function buildMaps(w, h, get, mask) {
    const N = w * h;
    const lum = d => { const y = new Float32Array(N); for (let i = 0; i < N; i++) y[i] = d[i * 3] + d[i * 3 + 1] + d[i * 3 + 2]; return y; };
    const avg = (a, b) => (a && b ? a.map((v, i) => (v + b[i]) / 2) : a || b);
    const W = avg(get('W', 1) && lum(get('W', 1).diff), get('W', 2) && lum(get('W', 2).diff));
    const ratio = (pa, pb) => {
      const reps = [1, 2].map(r => (get(pa, r) && get(pb, r) ? [lum(get(pa, r).diff), lum(get(pb, r).diff)] : null)).filter(Boolean);
      if (!reps.length) return null;
      const out = new Float32Array(N).fill(NaN);
      const inFace = new Uint8Array(N);
      for (const i of mask) inFace[i] = 1;
      const wMax = W ? Math.max(...mask.map(i => W[i])) : 1;
      for (let i = 0; i < N; i++) {
        if (!inFace[i]) continue;
        let s = 0, n = 0;
        for (const [a, b] of reps) if (a[i] > 0.02 * wMax && b[i] > 0.02 * wMax) { s += Math.log(a[i] / b[i]); n++; }
        if (n) out[i] = s / n;
      }
      return out;
    };
    return { w, h, white: W, horiz: ratio('HL', 'HR'), vert: ratio('HT', 'HB') };
  }

  function check(id, label, pass, detail, strength) {
    return { id, label, pass: !!pass, detail, strength: Number.isFinite(strength) ? strength : 0 };
  }

  function finish(out) {
    out.live = out.checks.length > 1 && out.checks.every(c => c.pass);
    out.score = out.checks.length
      ? Math.round(100 * out.checks.reduce((a, c) => a + c.strength, 0) / out.checks.length)
      : 0;
    if (!out.live && out.score > 59) out.score = 59;   // a failed check can never read as a pass
    return out;
  }

  const fmt = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : '—');

  // ── template comparisons ─────────────────────────────────────────────────────
  function descriptorDistance(a, b) {
    if (!a || !b || a.length !== b.length) return NaN;
    let s = 0;
    for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
    return Math.sqrt(s);
  }

  function spectralDistance(a, b) {
    if (!a || !b) return NaN;
    let s = 0, n = 0;
    for (let j = 0; j < Math.min(a.length, b.length); j++) {
      if (Number.isFinite(a[j]) && Number.isFinite(b[j])) { s += (a[j] - b[j]) ** 2; n++; }
    }
    return n ? Math.sqrt(s / n) : NaN;
  }

  const api = { CONFIG, LUT, analyzeScan, facePatches, faceMask, fitLag, descriptorDistance, spectralDistance, median };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Analysis = api;
})(typeof window !== 'undefined' ? window : globalThis);
