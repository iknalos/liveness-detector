// End-to-end tests of the reflection analysis on a simulated camera.
//
// fixtures/sim.json.gz comes from sim_geometry.py: the screen-light irradiance on a 3D face
// mesh (and on a flat print of it) for every half-screen pattern, 30 cm from an S21-sized
// screen with the camera at its top edge. The synthetic camera here adds what a real one
// does: skin colour, ambient light, camera colour crosstalk, display lag, exposure blur
// across pattern changes, auto-exposure wobble, gamma, sensor noise and 8-bit rounding.
// Run: node --test test/

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { analyzeScan, spectralDistance } = require('../www/js/analysis.js');
const { buildSequence } = require('../www/js/patterns.js');

const fx = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures', 'sim.json.gz'))));
const n = fx.n;
const decode = arr => Float32Array.from(arr, q => (q === 65535 ? NaN : q / 65000));
const MAPS = {};
for (const [k, maps] of Object.entries(fx.cases)) {
  MAPS[k] = {};
  for (const [p, arr] of Object.entries(maps)) MAPS[k][p] = decode(arr);
}

function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = rnd => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const encode = v => {
  const c = Math.max(0, Math.min(1, v));
  return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
};

// camera channel (row) response to screen primary (column)
const CROSSTALK = [[1, 0.12, 0.02], [0.10, 1, 0.15], [0.02, 0.20, 1]];
const SKIN = [0.55, 0.32, 0.22];
const CONTENT = { K: [0, 0, 0], W: [1, 1, 1], R: [1, 0, 0], G: [0, 1, 0], B: [0, 0, 1],
                  HL: [1, 1, 1], HR: [1, 1, 1], HT: [1, 1, 1], HB: [1, 1, 1], SA: [1, 1, 1], SB: [1, 1, 1] };
const MAPOF = { W: 'W', R: 'W', G: 'W', B: 'W', HL: 'HL', HR: 'HR', HT: 'HT', HB: 'HB', SA: 'SA', SB: 'SB' };
// patterns that light only part of the screen, so only part of its mirror image
const glare0 = { HL: 1, HR: 1, HT: 1, HB: 1, SA: 1, SB: 1 };

// Mirror glare off a flat glossy surface parallel to the phone: the camera sees the screen
// point at twice the surface point (in the camera plane). Returns which patterns light it.
function glareAt(x, y) {
  const t = fx.zc - fx.planeZ;
  const qx = 2 * ((x + 0.5 - n / 2) / fx.focal) * t;
  const qy = 2 * (-(y + 0.5 - n / 2) / fx.focal) * t;
  const { w, h, gap } = fx.screen;
  if (qx < -w / 2 || qx > w / 2 || qy > -gap || qy < -gap - h) return null;
  const bar = Math.min(7, Math.floor((w / 2 - qx) / (w / 8)));   // bars counted from the user's left (+x)
  return { HL: qx >= 0, HR: qx < 0, HT: qy > -gap - h / 2, HB: qy <= -gap - h / 2, SA: bar % 2 === 0, SB: bar % 2 === 1 };
}

function simulate(opts) {
  const o = {
    surface: 'face', ambient: 0.02, screen: 0.45, lagMs: 110, expMs: 22, fps: 30, noiseDN: 1.2,
    aeWobble: 0.02, albedo: SKIN, emission: 0, diffuse: 1, glare: 0, drift: 0, seed: 1, ...opts,
  };
  const rnd = prng(o.seed);
  const seq = buildSequence(200, rnd);
  let t = 1000;
  const slots = seq.map(s => { const sl = { p: s.p, rep: s.rep, t0: t, t1: t + s.ms }; t += s.ms; return sl; });
  const maps = MAPS[o.surface];
  const texture = new Float32Array(n * n).map(() => 1 + 0.12 * gauss(rnd));
  const glare = o.glare ? Array.from({ length: n * n }, (_, i) => glareAt(i % n, Math.floor(i / n))) : null;

  // irradiance per pixel per pattern, colour already split into primaries
  const patternLight = (p, i) => {
    const c = CONTENT[p];
    if (p === 'K') return [0, 0, 0];
    const e = maps[MAPOF[p]][i];
    return Number.isFinite(e) ? c.map(v => v * e) : [0, 0, 0];
  };

  const frames = [];
  const dt = 1000 / o.fps;
  for (let tf = slots[0].t0 + 5; tf < slots[slots.length - 1].t1 - 5; tf += dt + (rnd() - 0.5) * 3) {
    // which patterns were on screen during this frame's exposure (shifted by the display lag)
    const a = tf - o.lagMs - o.expMs, b = tf - o.lagMs;
    const weights = [];
    for (const sl of slots) {
      const ov = Math.min(b, sl.t1) - Math.max(a, sl.t0);
      if (ov > 0) weights.push([sl.p, ov / o.expMs]);
    }
    const gain = 1 + o.aeWobble * Math.sin(tf / 370);
    const data = new Uint8ClampedArray(n * n * 4);
    const shift = Math.round(o.drift * (tf - slots[0].t0) / (slots[slots.length - 1].t1 - slots[0].t0));
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + Math.min(n - 1, Math.max(0, x - shift));
        const inFace = Number.isFinite(maps.W[i]);
        const amb = inFace ? 0.35 + maps.AMB[i] : 0.6;
        const light = [0, 0, 0];
        for (const [p, wgt] of weights) {
          const e = patternLight(p, i);
          for (let c = 0; c < 3; c++) {
            for (let q = 0; q < 3; q++) light[c] += wgt * CROSSTALK[c][q] * e[q] * o.albedo[q] * o.diffuse * texture[i];
            const half = p in glare0;
            if (glare && glare[i] && p !== 'K' && (!half || glare[i][p])) {
              for (let q = 0; q < 3; q++) light[c] += wgt * o.glare * CROSSTALK[c][q] * CONTENT[p][q];
            }
          }
        }
        for (let c = 0; c < 3; c++) {
          const ambient = o.ambient * amb * [1, 0.9, 0.75][c] * o.albedo[c] * texture[i];
          const emit = o.emission * (inFace ? o.albedo[c] * (0.5 + maps.AMB[i]) : 0.2);
          const lin = gain * (ambient + emit + o.screen * light[c]);
          data[(y * n + x) * 4 + c] = Math.round(encode(lin) + o.noiseDN * gauss(rnd));
        }
        data[(y * n + x) * 4 + 3] = 255;
      }
    }
    frames.push({ times: { cap: tf, now: tf + 45 }, data });
  }
  const lm = fx.landmarks;
  const lmEnd = lm.map(([x, y]) => [x + o.drift, y]);
  return { w: n, h: n, frames, slots, lmStart: lm, lmEnd, tStart: slots[0].t0, tEnd: slots[slots.length - 1].t1 };
}

const summary = r => r.checks.map(c => `${c.pass ? 'PASS' : 'FAIL'} ${c.id}: ${c.detail}`).join('\n');
const failed = r => r.checks.filter(c => !c.pass).map(c => c.id);

test('real face in a dim room is live', () => {
  const r = analyzeScan(simulate({ seed: 1 }));
  assert.ok(r.live, summary(r));
  const expect = 110 + 22 / 2 + (r.metrics.clock === 'now' ? 45 : 0);   // lag + half exposure (+ callback delay)
  assert.ok(Math.abs(r.metrics.lagMs - expect) < 25, `lag ${r.metrics.lagMs} via ${r.metrics.clock}`);
});

test('real face in a lit room, with auto-exposure wobble, is live', () => {
  const r = analyzeScan(simulate({ seed: 2, ambient: 0.25, aeWobble: 0.03 }));
  assert.ok(r.live, summary(r));
});

test('real face at 15 fps and a long camera lag is live', () => {
  const r = analyzeScan(simulate({ seed: 3, fps: 15, lagMs: 260, expMs: 50 }));
  // 200 ms slots at 15 fps leave ~2 clean frames each; the app lengthens slots at low fps
  assert.ok(r.metrics.trackR2 > 0.8, summary(r));
});

test('flat matte print is rejected by the 3D tests', () => {
  const r = analyzeScan(simulate({ seed: 4, surface: 'flat' }));
  assert.ok(!r.live, summary(r));
  assert.ok(failed(r).includes('depthH') && failed(r).includes('depthV'), summary(r));
});

test('glossy print (mirror glare) is rejected', () => {
  const r = analyzeScan(simulate({ seed: 5, surface: 'flat', glare: 0.9 }));
  assert.ok(!r.live, summary(r));
});

test('semi-gloss print with faint glare is rejected (glare is colourless, shading is not)', () => {
  // faint glare fakes a nose step of ~0.19, more than a real face gives
  for (const glare of [0.005, 0.02, 0.08]) {
    const r = analyzeScan(simulate({ seed: 12, surface: 'flat', glare }));
    assert.ok(!r.live, `glare ${glare}\n` + summary(r));
  }
});

test('face on a phone screen (self-lit, glossy, barely reflective) is rejected', () => {
  const r = analyzeScan(simulate({ seed: 6, surface: 'flat', emission: 0.35, diffuse: 0.02, glare: 0.5, ambient: 0.02 }));
  assert.ok(!r.live, summary(r));
  assert.ok(failed(r).includes('emission') || failed(r).includes('coverage'), summary(r));
});

test('static picture that ignores the flashes is rejected', () => {
  const r = analyzeScan(simulate({ seed: 7, surface: 'flat', emission: 0.3, diffuse: 0, glare: 0 }));
  assert.ok(!r.live, summary(r));
  assert.ok(failed(r).includes('tracking'), summary(r));
});

test('moving during the scan is reported, not mistaken for a spoof verdict', () => {
  const r = analyzeScan(simulate({ seed: 8, drift: 12 }));
  assert.ok(failed(r).includes('still'), summary(r));
});

test('spectral signature repeats for the same skin and differs for other materials', () => {
  const a = analyzeScan(simulate({ seed: 9 }));
  const b = analyzeScan(simulate({ seed: 10, ambient: 0.15 }));
  const ink = analyzeScan(simulate({ seed: 11, albedo: [0.50, 0.40, 0.30] }));
  const same = spectralDistance(a.spectral.features, b.spectral.features);
  const other = spectralDistance(a.spectral.features, ink.spectral.features);
  assert.ok(same < 0.05, `same skin distance ${same}`);
  assert.ok(other > same * 3, `ink ${other} vs same ${same}`);
});
