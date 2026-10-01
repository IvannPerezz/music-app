// Track analysis for Automix / skip-silence (inspired by BitChord's native tempo_analysis + TrackAnalyzer).
// Input: mono PCM @ ~22 kHz. Output: bpm, beat grid phase, downbeat, sound start/end, outro start, energy curve.

self.onmessage = (e) => {
  const { id, samples, sampleRate } = e.data;
  try { self.postMessage({ id, result: analyze(samples, sampleRate) }); }
  catch (err) { self.postMessage({ id, error: String(err?.message || err) }); }
};

function analyze(x, sr) {
  const duration = x.length / sr;
  const hop = 512, win = 1024;
  const frames = Math.floor((x.length - win) / hop);
  const fps = sr / hop;

  // --- band-split onset strength (low / mid / high via one-pole filters), log energy flux
  const lowE = new Float32Array(frames), midE = new Float32Array(frames), highE = new Float32Array(frames), rms = new Float32Array(frames);
  let lp1 = 0, lp2 = 0;
  const aLow = Math.exp(-2 * Math.PI * 150 / sr), aMid = Math.exp(-2 * Math.PI * 2500 / sr);
  const low = new Float32Array(x.length), mid = new Float32Array(x.length), high = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    lp1 = (1 - aLow) * x[i] + aLow * lp1;
    lp2 = (1 - aMid) * x[i] + aMid * lp2;
    low[i] = lp1; mid[i] = lp2 - lp1; high[i] = x[i] - lp2;
  }
  for (let f = 0; f < frames; f++) {
    let l = 0, m = 0, h = 0, t = 0;
    const s = f * hop;
    for (let i = s; i < s + win; i++) { l += low[i] * low[i]; m += mid[i] * mid[i]; h += high[i] * high[i]; t += x[i] * x[i]; }
    lowE[f] = Math.log1p(1000 * l / win); midE[f] = Math.log1p(1000 * m / win); highE[f] = Math.log1p(1000 * h / win);
    rms[f] = Math.sqrt(t / win);
  }
  const onset = new Float32Array(frames);
  for (let f = 1; f < frames; f++) {
    onset[f] = Math.max(0, lowE[f] - lowE[f - 1]) * 1.4 + Math.max(0, midE[f] - midE[f - 1]) + Math.max(0, highE[f] - highE[f - 1]) * 0.6;
  }
  // Remove slow trend (local mean) so sustained loud parts don't dominate.
  const detr = new Float32Array(frames);
  const W = Math.round(fps * 0.5);
  let acc = 0;
  for (let f = 0; f < frames; f++) {
    acc += onset[f]; if (f >= W) acc -= onset[f - W];
    detr[f] = Math.max(0, onset[f] - acc / Math.min(f + 1, W));
  }

  // --- sound start / end (−40 dB below the loud part)
  const sorted = Array.from(rms).sort((a, b) => a - b);
  const loud = sorted[Math.floor(sorted.length * 0.9)] || 1e-6;
  const thr = loud * 0.01; // −40 dB
  let first = 0; while (first < frames && rms[first] < thr) first++;
  let last = frames - 1; while (last > 0 && rms[last] < thr) last--;
  const soundStart = first / fps, soundEnd = Math.min(duration, (last + 1) / fps + win / sr);

  // --- tempo by autocorrelation of the onset curve over the musical part (60–200 BPM), log-Gaussian prior at 120
  const a0 = first, a1 = Math.min(last, first + Math.round(fps * 120)); // analyse up to 2 minutes
  const seg = detr.subarray(a0, a1);
  const minLag = Math.floor(fps * 60 / 200), maxLag = Math.ceil(fps * 60 / 60);
  const ac = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < seg.length; i++) s += seg[i] * seg[i + lag];
    ac[lag] = s / (seg.length - lag);
  }
  let bestLag = 0, best = -1;
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    const bpm = 60 * fps / lag;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    // Reward lags whose double also correlates (metrical consistency).
    const harmonic = lag * 2 <= maxLag ? ac[lag * 2] * 0.5 : 0;
    const score = (ac[lag] + harmonic) * prior;
    if (score > best && ac[lag] >= ac[lag - 1] && ac[lag] >= ac[lag + 1]) { best = score; bestLag = lag; }
  }
  if (!bestLag) return { duration, soundStart, soundEnd, bpm: null };
  // Parabolic refinement of the peak.
  const y0 = ac[bestLag - 1], y1 = ac[bestLag], y2 = ac[bestLag + 1];
  const delta = (y0 - y2) / (2 * (y0 - 2 * y1 + y2) || 1);
  const period = bestLag + (Math.abs(delta) < 1 ? delta : 0); // frames per beat
  let bpm = 60 * fps / period;
  while (bpm < 75) bpm *= 2;
  while (bpm > 175) bpm /= 2;
  // --- joint refinement of period and phase with a comb over the whole track
  // (a 0.5% tempo error drifts a third of a second over a minute, so phase alone is not enough).
  const sample = (t) => { const i = Math.floor(t), fr = t - i; return (detr[i] || 0) * (1 - fr) + (detr[i + 1] || 0) * fr; };
  let P = 60 * fps / bpm, bestPhase = 0, bestSum = -1, bestP = P;
  for (let pr = P * 0.985; pr <= P * 1.015; pr += P * 0.0008) {
    for (let ph = 0; ph < pr; ph += 0.5) {
      let s = 0;
      for (let t = first + ph; t < last; t += pr) s += sample(t);
      if (s > bestSum) { bestSum = s; bestPhase = ph; bestP = pr; }
    }
  }
  P = bestP;
  bpm = 60 * fps / P;
  // +30 ms: an onset frame fires as soon as its window starts to overlap the hit.
  const beat0 = (first + bestPhase) / fps + 0.03; // seconds
  const beatSec = 60 / bpm;


  // --- downbeat: which of the 4 beat positions carries the most low-end onset
  const barScore = [0, 0, 0, 0];
  let k = 0;
  for (let t = beat0; t < soundEnd; t += beatSec, k++) {
    const i = Math.round(t * fps);
    barScore[k % 4] += (Math.max(0, lowE[i] - (lowE[i - 2] || 0))) + detr[i] * 0.3;
  }
  const db = barScore.indexOf(Math.max(...barScore));
  let downbeat = beat0 + db * beatSec;
  while (downbeat - 4 * beatSec >= soundStart - 0.05) downbeat -= 4 * beatSec;

  // --- energy curve (1 value / second) and outro detection
  const perSec = Math.round(fps);
  const energy = [];
  for (let f = 0; f < frames; f += perSec) {
    let s = 0, n = 0;
    for (let i = f; i < Math.min(frames, f + perSec); i++) { s += rms[i]; n++; }
    energy.push(+(s / n).toFixed(5));
  }
  const med = [...energy].sort((a, b) => a - b)[Math.floor(energy.length * 0.6)] || 0;
  // Outro: from the end backwards, the point where energy stays below 60% of the body.
  let outroAt = null;
  for (let s = energy.length - 1; s > energy.length * 0.5; s--) {
    let window = 0; for (let j = s - 4; j <= s; j++) window += energy[j] || 0;
    if (window / 5 >= med * 0.6) { outroAt = Math.min(soundEnd, s + 1); break; }
  }

  // Confidence: how peaky the autocorrelation is.
  let mean = 0; for (let lag = minLag; lag <= maxLag; lag++) mean += ac[lag]; mean /= (maxLag - minLag + 1);
  const confidence = Math.min(1, Math.max(0, (ac[bestLag] / (mean || 1) - 1) / 3));

  return {
    duration: +duration.toFixed(3),
    bpm: +bpm.toFixed(2),
    confidence: +confidence.toFixed(2),
    beat0: +beat0.toFixed(3),
    downbeat: +downbeat.toFixed(3),
    soundStart: +soundStart.toFixed(3),
    soundEnd: +soundEnd.toFixed(3),
    outroAt,
  };
}
