// From AutoMix (https://github.com/heydavidf/automix), Copyright (C) 2026 David Finnegan, as adapted
// by BitChord. AGPL-3.0-only: see ../LICENSE and ../NOTICE.md.
// BitChord Desktop: ported to plain JavaScript; rates are absolute, so "1" is the player's speed (deck.unity).
import { gridOf, phraseAtOrBefore, phraseAtOrAfter, downbeatAtOrAfter, downbeatAtOrBefore, BEATS_PER_BAR } from './grid.js';

// Below this, a beat-lock is more likely confidently WRONG than right (a 0.17 grid locked precisely
// off-beat): a clean crossfade beats a bad beatmatch. 0.2-0.45 grids beatmatch but only for the
// short 4-bar tier, so a wrong lock costs ~11 s, not a 46 s blend.
export const MIN_GRID_CONFIDENCE = 0.2;
// Bass swap depth: full on long blends with room for it; gentle on short blends so piano-led lows
// aren't gutted but the cross is still audible.
const KILL_DB = -12;
const SHORT_BLEND_KILL_DB = -6;
const FULL_SWAP_MIN_BARS = 8;

/**
 * Confidence-scaled blend length: the chosen bar count is a MAX, not a command. Two melodic tracks
 * over a shaky grid for 46 s is mush, so weaker grids get shorter blends.
 */
export function effectiveBlendBars(requestedBars, fromConfidence, toConfidence) {
  const conf = Math.min(fromConfidence, toConfidence);
  if (conf >= 0.6) return requestedBars;
  if (conf >= 0.45) return Math.min(requestedBars, 8);
  return Math.min(requestedBars, 4);
}

/**
 * BitChord Desktop (Iván, after trying rock and reggaeton playlists): mixes were too long and came
 * too early, cutting into lines still being sung. A blend lasts at most this long (the bars halve
 * until it fits: 16 bars at 95 BPM were 40 s) ...
 */
export const MAX_BLEND_SEC = 22;
/** ... and the outgoing song stays on top until its last sung line ends: the mix may start at most this share of itself before. */
const VOCAL_OVERLAP = 0.3;

/** [bars] halved until the blend (at [beatSec] output seconds a beat) fits MAX_BLEND_SEC, never under 4. */
export function fitBars(bars, beatSec) {
  while (bars > 4 && bars * BEATS_PER_BAR * beatSec > MAX_BLEND_SEC) bars /= 2;
  return bars;
}

/**
 * BitChord Desktop: where the outgoing song starts mixing out (track seconds) and for how many bars.
 * The blend ends where the song's energy drops (its outro) but never starts before the singing is
 * nearly over ([vocalEndSec]: the last sung line, from the lyrics or the vocal mask), and always ends
 * a bar before the song does; a blend that can't fit after the singing gets shorter. It snaps to the
 * phrase only when that's within 2 bars (AutoMix's phrase could move it 8 bars early), else to a bar.
 */
export function planMixOut(grid, a, bars, outRate, vocalEndSec = null) {
  for (;;) {
    const blendInputSec = bars * grid.barSec;
    const latest = a.durationSec - blendInputSec - grid.barSec;
    let target = (a.outroStartSec ?? a.durationSec) - blendInputSec;
    if (vocalEndSec != null) target = Math.max(target, vocalEndSec - blendInputSec * VOCAL_OVERLAP);
    if (target > latest && bars > 4 && vocalEndSec != null && vocalEndSec - blendInputSec * VOCAL_OVERLAP > latest) { bars /= 2; continue; }
    target = Math.min(target, latest);
    const phrase = phraseAtOrBefore(grid, target);
    const mixOut = target - phrase <= 2 * grid.barSec ? phrase : downbeatAtOrBefore(grid, target);
    return { bars, mixOut, blendInputSec, durationSec: blendInputSec / outRate };
  }
}

/** The incoming rate (absolute) folded by half/double time so the stretch stays nearest 1. */
const fold = (raw, unity) => [raw, raw / 2, raw * 2].reduce((best, r) => (Math.abs(r / unity - 1) < Math.abs(best / unity - 1) ? r : best));

/**
 * Schedule a phrase-aligned DJ blend on the Web Audio clock:
 * - incoming starts at its pre-full-energy phrase boundary, stretched to the outgoing tempo
 * - equal-power gain cross over the window
 * - bass swap over 1 bar at the midpoint, gentle high-shelf cross over the window
 * - outgoing stops at the end; incoming glides back to its normal speed
 */
export function scheduleTransition(req) {
  const { from, to, fromAnalysis, toAnalysis, bars, forceNow } = req;
  const ctx = from.ctx;
  const now = ctx.currentTime;
  const earliest = now + Math.max(from.scheduleAhead, to.scheduleAhead) + 0.1;
  const unity = to.unity;

  const fromGrid = gridOf(fromAnalysis);
  const toGrid = gridOf(toAnalysis);
  const gridsUsable = fromGrid !== null && toGrid !== null && fromAnalysis.gridConfidence >= MIN_GRID_CONFIDENCE && toAnalysis.gridConfidence >= MIN_GRID_CONFIDENCE;

  // BitChord: only the outgoing side's grid decides between a beat-aware mix and the plain
  // crossfade. An incoming track without one, or a tempo too far off to stretch, gets the phone's
  // filter mix: a queue isn't picked for tempo the way AutoMix's library was.
  if (fromGrid === null || fromAnalysis.gridConfidence < MIN_GRID_CONFIDENCE) {
    return scheduleFallback(req, earliest, 'esta canción no tiene ritmo claro al final');
  }
  if (!gridsUsable) return scheduleFilterMix(req, earliest, fromGrid, null, 'la siguiente canción no tiene ritmo claro');

  const outRate = from.timeline.rateAt(now) || unity;
  const effectiveFromBpm = fromGrid.bpm * outRate;
  // fold half/double-time so the stretch stays near 1 (64 vs 128 BPM still beat-locks)
  const rate = fold(effectiveFromBpm / toGrid.bpm, unity);
  // tempo gap too wide to beatmatch musically: the next song slowed at most 10% or sped up at most 25%
  if (!stretchAllowed(rate / unity)) {
    return scheduleFilterMix(req, earliest, fromGrid, toGrid, `ritmos un ${Math.round(Math.abs(rate / unity - 1) * 100)} % distintos`);
  }
  // blend length measured in output seconds at the outgoing tempo (BitChord Desktop: at most MAX_BLEND_SEC)
  let effBars = fitBars(effectiveBlendBars(bars, fromAnalysis.gridConfidence, toAnalysis.gridConfidence), 60 / effectiveFromBpm);

  // --- outgoing mix-out point (track time) ---
  let mixOutTrackTime;
  const fromPos = from.expectedTrackTime ?? 0;
  if (forceNow) {
    const earliestTrack = from.timeline.trackTimeAt(earliest) ?? fromPos;
    mixOutTrackTime = downbeatAtOrAfter(fromGrid, earliestTrack);
  } else {
    const p = planMixOut(fromGrid, fromAnalysis, effBars, outRate, req.vocalEndSec);
    effBars = p.bars;
    mixOutTrackTime = p.mixOut;
    if (mixOutTrackTime < fromPos) {
      // too late for the natural point: go at the next bar instead
      mixOutTrackTime = downbeatAtOrAfter(fromGrid, from.timeline.trackTimeAt(earliest) ?? fromPos);
    }
  }

  let t0 = from.timeline.ctxTimeAt(mixOutTrackTime, now);
  if (t0 === null || t0 < earliest) {
    mixOutTrackTime = downbeatAtOrAfter(fromGrid, from.timeline.trackTimeAt(earliest) ?? fromPos);
    t0 = from.timeline.ctxTimeAt(mixOutTrackTime, now);
    if (t0 === null) return scheduleFallback(req, earliest);
  }
  const durationSec = effBars * BEATS_PER_BAR * (60 / effectiveFromBpm);

  // --- incoming mix-in point (track time) ---
  const introEnd = toAnalysis.introEndSec ?? 0;
  const fullEnergyPhrase = phraseAtOrAfter(toGrid, Math.max(introEnd, toGrid.downbeatSec));
  let mixInTrackTime = fullEnergyPhrase - durationSec * rate;
  if (mixInTrackTime < toGrid.downbeatSec) mixInTrackTime = toGrid.downbeatSec;

  // --- schedule transport ---
  to.playAt({ ctxTime: t0, trackTime: mixInTrackTime, rate });
  from.pauseAt(t0 + durationSec + 0.05);

  // --- gains: equal-power cross ---
  applyEqualPowerCross(from.gain.gain, to.gain.gain, t0, durationSec);

  // --- EQ: bass swap at midpoint over 1 bar, highs cross the whole window ---
  const swapDb = effBars >= FULL_SWAP_MIN_BARS ? KILL_DB : SHORT_BLEND_KILL_DB;
  const mid = t0 + durationSec / 2;
  const barOutSec = fromGrid.barSec / outRate;
  to.eq.setGainAt('low', swapDb, t0 - 0.02);
  from.eq.rampGain('low', 0, swapDb, mid - barOutSec / 2, barOutSec);
  to.eq.rampGain('low', swapDb, 0, mid - barOutSec / 2, barOutSec);
  from.eq.rampGain('high', 0, -8, t0, durationSec);
  to.eq.setGainAt('high', -8, t0 - 0.02);
  to.eq.rampGain('high', -8, 0, t0, durationSec);

  // --- after the blend: outgoing cleanup + incoming rate glide back to normal ---
  const tEnd = t0 + durationSec;
  scheduleAfter(ctx, tEnd + 0.2, () => { from.eq.reset(); from.setVolume(1); });
  glideRateToUnity(to, rate, tEnd);

  return { t0, durationSec, mixInTrackTime, mixOutTrackTime, rate, fallback: false, style: 'blend', reason: null, bars: effBars };
}

/**
 * BitChord: the bars the scheduler will use for this pair, so the mix loop times the mix-out for
 * the same length: a filter mix is up to FILTER_MAX_BARS, a beatmatch the confidence-scaled length.
 */
export function plannedBars(requestedBars, fromAnalysis, toAnalysis, outRate, unity = 1) {
  const fromGrid = gridOf(fromAnalysis);
  const toGrid = toAnalysis ? gridOf(toAnalysis) : null;
  const beatOut = fromGrid ? fromGrid.beatSec / outRate : 0.5;
  if (!toAnalysis) return fitBars(effectiveBlendBars(requestedBars, fromAnalysis.gridConfidence, 1), beatOut);
  if (!fromGrid || !toGrid || toAnalysis.gridConfidence < MIN_GRID_CONFIDENCE) return fitBars(Math.min(requestedBars, FILTER_MAX_BARS), beatOut);
  const rate = fold((fromGrid.bpm * outRate) / toGrid.bpm, unity);
  if (!stretchAllowed(rate / unity)) return fitBars(Math.min(requestedBars, FILTER_MAX_BARS), beatOut);
  return fitBars(effectiveBlendBars(requestedBars, fromAnalysis.gridConfidence, toAnalysis.gridConfidence), beatOut);
}

/**
 * BitChord: how far the blend may stretch the incoming song ([rate] relative to its normal speed):
 * slowed down at most 10%, sped up at most 25%. The loop mix ramps any gap; this is for the blend.
 */
export function stretchAllowed(rate) {
  return rate >= 1 ? rate - 1 <= MAX_SPEED_UP : 1 - rate <= MAX_SLOW_DOWN;
}
const MAX_SLOW_DOWN = 0.1;
const MAX_SPEED_UP = 0.25;
/** BitChord: a filter mix is at most this many outgoing bars (the phone's DJ_FILTER length). */
const FILTER_MAX_BARS = 8;

/**
 * BitChord, after the phone's DJ_FILTER: a pair that can't be beatmatched still mixes on the
 * outgoing track's phrase. The incoming track starts on its own downbeat exactly on the outgoing
 * one's, at its own tempo, low-passed; the outgoing track drains away through a rising high-pass;
 * the bass hands over in one bar at the midpoint, so two kick drums at two tempi never play at full
 * weight together.
 */
function scheduleFilterMix(req, earliest, fromGrid, toGrid, reason) {
  const { from, to, fromAnalysis, toAnalysis, forceNow } = req;
  const ctx = from.ctx;
  const now = ctx.currentTime;
  const unity = to.unity;
  const outRate = from.timeline.rateAt(now) || unity;
  const barOutSec = fromGrid.barSec / outRate;
  let bars = fitBars(Math.min(req.bars, FILTER_MAX_BARS), barOutSec / BEATS_PER_BAR);

  const fromPos = from.expectedTrackTime ?? 0;
  let mixOutTrackTime;
  if (forceNow) {
    mixOutTrackTime = downbeatAtOrAfter(fromGrid, from.timeline.trackTimeAt(earliest) ?? fromPos);
  } else {
    const p = planMixOut(fromGrid, fromAnalysis, bars, outRate, req.vocalEndSec);
    bars = p.bars;
    mixOutTrackTime = p.mixOut;
    if (mixOutTrackTime < fromPos) mixOutTrackTime = downbeatAtOrAfter(fromGrid, from.timeline.trackTimeAt(earliest) ?? fromPos);
  }
  let t0 = from.timeline.ctxTimeAt(mixOutTrackTime, now);
  if (t0 === null || t0 < earliest) {
    mixOutTrackTime = downbeatAtOrAfter(fromGrid, from.timeline.trackTimeAt(earliest) ?? fromPos);
    t0 = from.timeline.ctxTimeAt(mixOutTrackTime, now);
    if (t0 === null) return scheduleFallback(req, earliest, reason);
  }

  let durationSec = bars * barOutSec;
  let blendInputSec = durationSec * outRate;
  // never past the outgoing track's end: shorten to the bars that still fit
  const room = fromAnalysis.durationSec - 0.3 - mixOutTrackTime;
  if (blendInputSec > room) {
    bars = Math.max(1, Math.floor(room / fromGrid.barSec));
    durationSec = bars * barOutSec;
    blendInputSec = durationSec * outRate;
  }

  // the incoming track from its first downbeat (its intro is what a filter mix is for)
  const mixInTrackTime = toGrid ? toGrid.downbeatSec : Math.min(toAnalysis.introEndSec ?? 0, 1);
  to.playAt({ ctxTime: t0, trackTime: mixInTrackTime, rate: unity });
  from.pauseAt(t0 + durationSec + 0.05);
  applyEqualPowerCross(from.gain.gain, to.gain.gain, t0, durationSec);

  // filters: outgoing high-pass rises, incoming low-pass opens
  const hp = from.sweep.highpass.frequency;
  const lp = to.sweep.lowpass.frequency;
  hp.cancelScheduledValues(t0 - 0.03);
  lp.cancelScheduledValues(t0 - 0.03);
  hp.setValueAtTime(FILTER_OPEN_LOW_HZ, t0);
  hp.exponentialRampToValueAtTime(FILTER_HP_END_HZ, t0 + durationSec);
  lp.setValueAtTime(FILTER_LP_START_HZ, t0 - 0.02);
  lp.exponentialRampToValueAtTime(FILTER_OPEN_HIGH_HZ, t0 + durationSec);

  // bass hands over in one bar at the midpoint
  const mid = t0 + durationSec / 2;
  to.eq.setGainAt('low', KILL_DB, t0 - 0.02);
  from.eq.rampGain('low', 0, KILL_DB, mid - barOutSec / 2, barOutSec);
  to.eq.rampGain('low', KILL_DB, 0, mid - barOutSec / 2, barOutSec);

  const tEnd = t0 + durationSec;
  scheduleAfter(ctx, tEnd + 0.2, () => { from.eq.reset(); from.resetSweep(); to.resetSweep(); from.setVolume(1); });
  return { t0, durationSec, mixInTrackTime, mixOutTrackTime, rate: unity, fallback: false, style: 'filter', reason, bars };
}

/** A filter at these is as good as open. */
const FILTER_OPEN_LOW_HZ = 20;
const FILTER_OPEN_HIGH_HZ = 20000;
/** Where the outgoing high-pass ends: the body of the track gone, its top still trailing. */
const FILTER_HP_END_HZ = 1800;
/** Where the incoming low-pass starts: kick and bass only, the rest arriving as it opens. */
const FILTER_LP_START_HZ = 350;

/** No usable grid: plain equal-power volume fade, no beatmatch, no EQ moves. */
function scheduleFallback(req, earliest, reason = null) {
  const { from, to, toAnalysis } = req;
  const ctx = from.ctx;
  const durationSec = 12;
  const t0 = earliest;
  const mixInTrackTime = toAnalysis.introEndSec ?? 0;
  to.playAt({ ctxTime: t0, trackTime: mixInTrackTime, rate: to.unity });
  from.pauseAt(t0 + durationSec + 0.05);
  applyEqualPowerCross(from.gain.gain, to.gain.gain, t0, durationSec);
  scheduleAfter(ctx, t0 + durationSec + 0.2, () => { from.eq.reset(); from.setVolume(1); });
  return { t0, durationSec, mixInTrackTime, mixOutTrackTime: from.expectedTrackTime ?? 0, rate: to.unity, fallback: true, style: 'crossfade', reason, bars: 0 };
}

function applyEqualPowerCross(outParam, inParam, t0, durationSec) {
  const N = 65;
  const fadeOut = new Float32Array(N);
  const fadeIn = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const x = i / (N - 1);
    fadeOut[i] = Math.cos((x * Math.PI) / 2);
    fadeIn[i] = Math.sin((x * Math.PI) / 2);
  }
  outParam.cancelScheduledValues(t0 - 0.03);
  inParam.cancelScheduledValues(t0 - 0.03);
  outParam.setValueAtTime(1, t0 - 0.02);
  inParam.setValueAtTime(0, t0 - 0.02);
  outParam.setValueCurveAtTime(fadeOut, t0, durationSec);
  inParam.setValueCurveAtTime(fadeIn, t0, durationSec);
}

/** Step the incoming deck's rate back to normal in inaudible ~0.8% increments. */
function glideRateToUnity(deck, fromRate, startCtxTime) {
  const unity = deck.unity;
  if (Math.abs(fromRate / unity - 1) < 0.002) { deck.setRate(unity, startCtxTime + 0.5); return; }
  const steps = 8;
  const stepSec = 3;
  for (let i = 1; i <= steps; i++) deck.setRate(fromRate + (unity - fromRate) * (i / steps), startCtxTime + i * stepSec);
}

/** Fire a callback near an AudioContext time (cosmetic cleanup only). */
function scheduleAfter(ctx, ctxTime, fn) {
  setTimeout(fn, Math.max(0, (ctxTime - ctx.currentTime) * 1000));
}
