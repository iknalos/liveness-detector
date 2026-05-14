// Multispectral liveness analysis
//
// Core insight: a real face REFLECTS the screen light — its captured color
// changes in sync with the illumination color. A phone screen showing a face
// EMITS its own fixed colors and doesn't track our illumination. A printed
// photo reflects everything fairly uniformly (no skin-specific signature).
//
// Three main checks:
//   1. Spectral tracking — face color correlates with illumination color
//   2. Skin spectral shape — brightness rises from blue (400nm) to red (700nm)
//   3. Variance — brightness swings significantly across the 24 steps

function pearsonCorrelation(xs, ys) {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, sx = 0, sy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy;
    sx  += dx * dx;
    sy  += dy * dy;
  }
  const denom = Math.sqrt(sx * sy);
  return denom < 1e-9 ? 0 : num / denom;
}

function analyzeLiveness(frames) {
  const n = frames.length;

  // Normalized illumination channels (0–1)
  const iR = frames.map(f => f.step.rgb[0] / 255);
  const iG = frames.map(f => f.step.rgb[1] / 255);
  const iB = frames.map(f => f.step.rgb[2] / 255);

  // Normalized face region channels (0–1)
  const fR  = frames.map(f => f.data.r          / 255);
  const fG  = frames.map(f => f.data.g          / 255);
  const fB  = frames.map(f => f.data.b          / 255);
  const fLum = frames.map(f => f.data.brightness / 255);

  // ── Check 1: Spectral tracking correlation ──────────────────────────────
  // Real face tracks each channel; screen attack doesn't.
  const corrR   = pearsonCorrelation(iR, fR);
  const corrG   = pearsonCorrelation(iG, fG);
  const corrB   = pearsonCorrelation(iB, fB);
  const avgCorr = (corrR + corrG + corrB) / 3;

  // ── Check 2: Spectral luminance variance ────────────────────────────────
  // Large swing means the face is responding to different illuminations.
  const maxL = Math.max(...fLum);
  const minL = Math.min(...fLum);
  const spectralVariance = maxL > 0.05 ? (maxL - minL) / maxL : 0;

  // ── Check 3: Red > blue (skin spectral bias) ────────────────────────────
  // Skin reflects ~3–4× more red than blue light.
  const redFrames  = frames.filter(f => f.step.nm >= 620 && f.step.nm <= 680);
  const blueFrames = frames.filter(f => f.step.nm >= 430 && f.step.nm <= 490);
  const avgRedLum  = redFrames .reduce((s, f) => s + f.data.brightness, 0) / (redFrames .length || 1);
  const avgBlueLum = blueFrames.reduce((s, f) => s + f.data.brightness, 0) / (blueFrames.length || 1);
  const redBlueBias = avgBlueLum > 0 ? avgRedLum / avgBlueLum : 1;

  // ── Check 4: Warm half brighter than cool half ──────────────────────────
  const warmFrames = frames.filter(f => f.step.nm >= 580);
  const coolFrames = frames.filter(f => f.step.nm <  580);
  const avgWarm = warmFrames.reduce((s, f) => s + f.data.brightness, 0) / (warmFrames.length || 1);
  const avgCool = coolFrames.reduce((s, f) => s + f.data.brightness, 0) / (coolFrames.length || 1);
  const warmBias = avgWarm > avgCool;

  // ── Check 5: Face region has meaningful signal ──────────────────────────
  const meanLum = fLum.reduce((a, b) => a + b, 0) / n;
  const hasFace = meanLum > 0.07 && meanLum < 0.93;

  // ── Check 6: Hemoglobin signature (dip at ~540–575nm) ───────────────────
  // Blood in skin absorbs green-yellow more than the neighboring bands.
  const f520 = frames.find(f => f.step.nm === 520);
  const f535 = frames.find(f => f.step.nm === 535);
  const f550 = frames.find(f => f.step.nm === 550);
  const f565 = frames.find(f => f.step.nm === 565);
  const f580 = frames.find(f => f.step.nm === 580);
  let hemoScore = 0;
  if (f520 && f535 && f550 && f565 && f580) {
    const surroundAvg = (f520.data.brightness + f580.data.brightness) / 2;
    const midAvg      = (f535.data.brightness + f550.data.brightness + f565.data.brightness) / 3;
    // Real skin: midpoint slightly suppressed vs surrounding (hemoglobin absorption)
    hemoScore = midAvg < surroundAvg ? 1 : 0;
  }

  // ── Weighted scoring (total 100) ─────────────────────────────────────────
  //   Spectral tracking is the strongest signal — it directly catches screen attacks.
  //   Variance and skin bias catch photo/print attacks.
  let score = 0;
  const reasons = [];

  const corrPoints = Math.round(Math.max(0, Math.min(38, avgCorr * 46)));
  score += corrPoints;
  reasons.push(`Illumination tracking: r=${avgCorr.toFixed(2)} (+${corrPoints}pts)`);

  const varPoints = Math.round(Math.max(0, Math.min(22, spectralVariance * 32)));
  score += varPoints;
  reasons.push(`Spectral range: ${(spectralVariance * 100).toFixed(0)}% (+${varPoints}pts)`);

  const biasPoints = Math.round(Math.max(0, Math.min(18, (redBlueBias - 0.7) * 12)));
  score += biasPoints;
  reasons.push(`Red/blue ratio: ${redBlueBias.toFixed(2)}x (+${biasPoints}pts)`);

  if (hasFace)   { score += 12; reasons.push('Face region detected (+12pts)');         }
  if (warmBias)  { score += 6;  reasons.push('Warm spectral bias confirmed (+6pts)');  }
  if (hemoScore) { score += 4;  reasons.push('Hemoglobin signature detected (+4pts)'); }

  score = Math.min(100, Math.round(score));

  return {
    isLive:  score >= 58,
    score,
    reasons,
    raw: { avgCorr, spectralVariance, redBlueBias, hasFace, warmBias, hemoScore },
  };
}
