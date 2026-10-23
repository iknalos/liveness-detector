// Illumination patterns shown on the screen during a scan, and the random sequence they
// are played in.
//
// A phone screen only has three emitters (red, green and blue sub-pixels), so every colour
// it can show is a mix of those three. Full-screen R, G and B therefore carry all of the
// spectral information the screen can give; the half-screen white patterns light the face
// from the left, right, top or bottom so the reflection also reveals its 3D shape.
// Every pattern is followed by a black slot, which measures the ambient light at nearly
// the same moment so it can be subtracted.

(function (root) {
  'use strict';

  const PATTERNS = {
    K:  { name: 'Black',       css: '#000000' },
    W:  { name: 'White',       css: '#ffffff' },
    R:  { name: 'Red',         css: '#ff0000' },
    G:  { name: 'Green',       css: '#00ff00' },
    B:  { name: 'Blue',        css: '#0000ff' },
    HL: { name: 'Left half',   css: 'linear-gradient(to right, #fff 50%, #000 50%)' },
    HR: { name: 'Right half',  css: 'linear-gradient(to right, #000 50%, #fff 50%)' },
    HT: { name: 'Top half',    css: 'linear-gradient(to bottom, #fff 50%, #000 50%)' },
    HB: { name: 'Bottom half', css: 'linear-gradient(to bottom, #000 50%, #fff 50%)' },
    // 8 vertical bars and their complement. A matte surface (skin) averages them out; a
    // mirror-like one (glossy photo, phone glass) reflects the bars themselves.
    SA: { name: 'Stripes',     css: 'repeating-linear-gradient(to right, #fff 0 12.5%, #000 12.5% 25%)' },
    SB: { name: 'Stripes 2',   css: 'repeating-linear-gradient(to right, #000 0 12.5%, #fff 12.5% 25%)' },
  };

  function randomUnit() {
    const c = root.crypto || (typeof globalThis !== 'undefined' && globalThis.crypto);
    if (c && c.getRandomValues) {
      const a = new Uint32Array(1);
      c.getRandomValues(a);
      return a[0] / 4294967296;
    }
    return Math.random();
  }

  function shuffle(arr, rnd) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Returns [{p, rep, ms}]. The order of the blocks, the order inside each block and every
  // slot's duration are random, so a recording of an earlier scan cannot line up with this one.
  function buildSequence(slotMs, rnd = randomUnit) {
    const jitter = () => Math.round(slotMs * (0.85 + 0.35 * rnd()));
    const pair = (a, b, rep) => (rnd() < 0.5 ? [a, b] : [b, a]).map(p => ({ p, rep }));
    const h1 = pair('HL', 'HR', 1), v1 = pair('HT', 'HB', 1);
    // second repetitions run in the opposite order, so a slow drift cancels in the average
    const h2 = h1.slice().reverse().map(s => ({ p: s.p, rep: 2 }));
    const v2 = v1.slice().reverse().map(s => ({ p: s.p, rep: 2 }));
    const rgb = shuffle(['R', 'G', 'B'], rnd).map(p => ({ p, rep: 1 }));
    const stripes = pair('SA', 'SB', 1);
    const blocks = shuffle([h1, v1, rgb, h2, v2, stripes], rnd);

    const seq = [{ p: 'K', rep: 0 }, { p: 'W', rep: 1 }, { p: 'K', rep: 0 }];
    for (const block of blocks) {
      for (const s of block) seq.push(s, { p: 'K', rep: 0 });
    }
    seq.push({ p: 'W', rep: 2 }, { p: 'K', rep: 0 });
    return seq.map(s => ({ ...s, ms: jitter() }));
  }

  const api = { PATTERNS, buildSequence };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis);
