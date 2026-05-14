// ── Utilities ─────────────────────────────────────────────────────────────────

function pearsonCorrelation(xs, ys) {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, sx = 0, sy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy; sx += dx * dx; sy += dy * dy;
  }
  const denom = Math.sqrt(sx * sy);
  return denom < 1e-9 ? 0 : num / denom;
}

function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom < 1e-9 ? 0 : dot / denom;
}

// ── Template builder ───────────────────────────────────────────────────────────
// Creates a normalised spectral signature from a completed scan.
// All values are divided by the peak brightness so the template is
// lighting-invariant — the SHAPE of the curve is what identifies a person,
// not the absolute brightness.

function buildTemplate(frames) {
  const maxLum = Math.max(...frames.map(f => f.data.brightness));
  if (maxLum < 0.05) return null; // no usable signal after ambient correction

  return {
    version: 2, // v2 = ambient-corrected ratio values (not raw 0-255)
    createdAt: new Date().toISOString(),
    curve: frames.map(f => ({
      nm:  f.step.nm,
      r:   f.data.r          / maxLum,
      g:   f.data.g          / maxLum,
      b:   f.data.b          / maxLum,
      lum: f.data.brightness / maxLum,
    })),
  };
}

// ── Template comparator ────────────────────────────────────────────────────────
// Compares a new scan against a stored template.
// Returns a similarity score 0–1.
//
// Uses cosine similarity on four normalised vectors:
//   - luminance curve (weighted 50%) — the primary spectral shape
//   - R, G, B channel curves (20 / 20 / 10%) — skin-tone colour bias
//
// Same person, different ambient light → similar curve shape → high score (≥ 0.88)
// Different person → different curve shape → low score (< 0.80)

function compareTemplate(frames, template) {
  // Match frames to template entries by wavelength — handles the case where
  // verification uses a 12-step subset of the 24-step registration template.
  const matched = frames.map(f => {
    const ref = template.curve.find(c => c.nm === f.step.nm);
    return ref ? { frame: f, ref } : null;
  }).filter(Boolean);

  if (matched.length < 6) return 0;

  const maxLum = Math.max(...matched.map(m => m.frame.data.brightness));
  if (maxLum < 0.05) return 0;

  const curLum = matched.map(m => m.frame.data.brightness / maxLum);
  const curR   = matched.map(m => m.frame.data.r          / maxLum);
  const curG   = matched.map(m => m.frame.data.g          / maxLum);
  const curB   = matched.map(m => m.frame.data.b          / maxLum);

  const refLum = matched.map(m => m.ref.lum);
  const refR   = matched.map(m => m.ref.r);
  const refG   = matched.map(m => m.ref.g);
  const refB   = matched.map(m => m.ref.b);

  const simLum = cosineSimilarity(curLum, refLum);
  const simR   = cosineSimilarity(curR,   refR);
  const simG   = cosineSimilarity(curG,   refG);
  const simB   = cosineSimilarity(curB,   refB);

  return simLum * 0.50 + simR * 0.20 + simG * 0.20 + simB * 0.10;
}

// ── Liveness analysis ─────────────────────────────────────────────────────────
// Core insight: a real face REFLECTS the screen light — its captured colour
// changes in sync with the illumination colour.
// A phone screen showing a face EMITS its own fixed colours and doesn't track.
// A printed photo reflects everything fairly uniformly (no skin-specific signature).
//
// If a template is provided, also runs identity matching against it.

function analyzeLiveness(frames, template = null) {
  const n = frames.length;

  const iR = frames.map(f => f.step.rgb[0] / 255);
  const iG = frames.map(f => f.step.rgb[1] / 255);
  const iB = frames.map(f => f.step.rgb[2] / 255);

  // Frame data is ambient-corrected ratios (dimensionless) — no /255 needed.
  // Pearson correlation and downstream checks are all scale-invariant.
  const fR   = frames.map(f => f.data.r);
  const fG   = frames.map(f => f.data.g);
  const fB   = frames.map(f => f.data.b);
  const fLum = frames.map(f => f.data.brightness);

  // ── Check 1: Spectral tracking correlation ──────────────────────────────────
  const corrR   = pearsonCorrelation(iR, fR);
  const corrG   = pearsonCorrelation(iG, fG);
  const corrB   = pearsonCorrelation(iB, fB);
  const avgCorr = (corrR + corrG + corrB) / 3;

  // ── Check 2: Spectral variance ──────────────────────────────────────────────
  const maxL = Math.max(...fLum), minL = Math.min(...fLum);
  const spectralVariance = maxL > 0.005 ? (maxL - minL) / maxL : 0;

  // ── Check 3: Red > blue bias ────────────────────────────────────────────────
  const redFrames  = frames.filter(f => f.step.nm >= 620 && f.step.nm <= 680);
  const blueFrames = frames.filter(f => f.step.nm >= 430 && f.step.nm <= 490);
  const avgRedLum  = redFrames .reduce((s, f) => s + f.data.brightness, 0) / (redFrames .length || 1);
  const avgBlueLum = blueFrames.reduce((s, f) => s + f.data.brightness, 0) / (blueFrames.length || 1);
  const redBlueBias = avgBlueLum > 0 ? avgRedLum / avgBlueLum : 1;

  // ── Check 4: Warm > cool ────────────────────────────────────────────────────
  const warmFrames = frames.filter(f => f.step.nm >= 580);
  const coolFrames = frames.filter(f => f.step.nm <  580);
  const avgWarm = warmFrames.reduce((s, f) => s + f.data.brightness, 0) / (warmFrames.length || 1);
  const avgCool = coolFrames.reduce((s, f) => s + f.data.brightness, 0) / (coolFrames.length || 1);
  const warmBias = avgWarm > avgCool;

  // ── Check 5: Face presence ──────────────────────────────────────────────────
  // With ambient correction, values are ratios not 0-1; check for any positive
  // screen contribution (ratio > 0.02 means face is reflecting screen light).
  const meanLum = fLum.reduce((a, b) => a + b, 0) / n;
  const hasFace = meanLum > 0.02;

  // ── Check 6: Hemoglobin dip ─────────────────────────────────────────────────
  // Oxyhemoglobin absorbs at 540-560nm, creating a dip between the 520 and 580
  // peaks. Uses only 520/550/580nm so the check fires in both registration (24
  // steps) and verification (12 steps — 535nm and 565nm are skipped there).
  const f520 = frames.find(f => f.step.nm === 520);
  const f550 = frames.find(f => f.step.nm === 550);
  const f580 = frames.find(f => f.step.nm === 580);
  let hemoScore = 0;
  if (f520 && f550 && f580) {
    const surround = (f520.data.brightness + f580.data.brightness) / 2;
    hemoScore = f550.data.brightness < surround ? 1 : 0;
  }

  // ── Liveness score (0–100) ──────────────────────────────────────────────────
  let score = 0;
  const reasons = [];

  const corrPts  = Math.round(Math.max(0, Math.min(38, avgCorr * 46)));
  score += corrPts;
  reasons.push(`Illumination tracking: r=${avgCorr.toFixed(2)} (+${corrPts})`);

  const varPts = Math.round(Math.max(0, Math.min(22, spectralVariance * 32)));
  score += varPts;
  reasons.push(`Spectral range: ${(spectralVariance * 100).toFixed(0)}% (+${varPts})`);

  const biasPts = Math.round(Math.max(0, Math.min(18, (redBlueBias - 0.7) * 12)));
  score += biasPts;
  reasons.push(`Red/blue ratio: ${redBlueBias.toFixed(2)}x (+${biasPts})`);

  if (hasFace)   { score += 12; reasons.push('Face region detected (+12)');          }
  if (warmBias)  { score +=  6; reasons.push('Warm spectral bias confirmed (+6)');   }
  if (hemoScore) { score +=  4; reasons.push('Hemoglobin signature detected (+4)');  }

  score = Math.min(100, Math.round(score));
  const isLive = score >= 58;

  // ── Identity match (only when template provided) ────────────────────────────
  let identity = null;
  if (template) {
    const similarity  = compareTemplate(frames, template);
    // Map similarity 0.70–1.00 → score 0–100
    const idScore     = Math.round(Math.max(0, Math.min(100, (similarity - 0.70) / 0.30 * 100)));
    const isMatch     = similarity >= 0.88;
    identity = { similarity, score: idScore, isMatch };
  }

  return {
    isLive,
    score,
    reasons,
    identity,
    passed: isLive && (identity ? identity.isMatch : true),
  };
}
