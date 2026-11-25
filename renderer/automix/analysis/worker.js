// From AutoMix (https://github.com/heydavidf/automix), Copyright (C) 2026 David Finnegan, as adapted
// by BitChord (https://github.com/kushagrasinghx/BitChord). AGPL-3.0-only: see ../LICENSE and ../NOTICE.md.
// BitChord Desktop: ported from TypeScript to plain JavaScript.

/**
 * Analysis worker: essentia.js (WASM) for BPM/ticks/key, plus the beat-grid regression, downbeat
 * phase, energy curve and intro/outro; then the phone's models (Beat This! for beats and downbeats,
 * open-unmix for where the song is sung). Input audio must be mono 44100 Hz (RhythmExtractor2013
 * assumes 44.1k).
 */
import { EssentiaWASM } from '../vendor/essentia-wasm.es.js';
import Essentia from '../vendor/essentia.js-core.es.js';
import { fitGrid, normalizeTempo, findDownbeat } from './beatgrid.js';
import { energyCurve, detectIntroOutro } from './energy.js';
import { toCamelot } from './camelot.js';
import { setModelBase, trackBeats, vocalCurve, VOCAL_FPS } from './models.js';

const ready = new Promise((resolve) => {
  if (EssentiaWASM.calledRun) resolve();
  else EssentiaWASM.onRuntimeInitialized = () => resolve();
});

let essentia = null;

self.onmessage = async (ev) => {
  const { id, modelBase, samples, sampleRate, beatWindows = [], vocalWindows = [] } = ev.data;
  try {
    if (modelBase) setModelBase(modelBase);
    const times = {};
    let t = performance.now();
    const lap = (k) => { const n = performance.now(); times[k] = Math.round(n - t); t = n; };
    // BitChord: the phone's models. Beat This! gives the grids wherever it finds a beat; essentia's
    // rhythm step is the fallback (BitChord Desktop: run only for a side the model found nothing on,
    // instead of always, which saves ~6 s a song). One at a time: a session runs one inference at once.
    // BitChord Desktop: progress for the Automix pill (the beat model is ~60% of the time, the vocal mask ~30%)
    const progress = (p) => self.postMessage({ id, progress: Math.min(1, p) });
    const beatWins = beatWindows.slice(0, 2);
    const grids = [];
    for (const [i, w] of beatWins.entries()) { grids.push(await trackBeats(w.pcm, w.offsetSec).catch(() => null)); progress((0.6 * (i + 1)) / beatWins.length); }
    lap('beats');
    const [head = null, tail = null] = grids;
    const headBeats = head ? beatSide(head) : null;
    const tailBeats = tail ? beatSide(tail) : (beatWindows.length === 1 ? headBeats : null);
    await ready;
    essentia ??= new Essentia(EssentiaWASM);
    const result = analyze(essentia, samples, sampleRate, lap, {
      head: headBeats ? localGrid(headBeats) : null,
      tail: tailBeats ? localGrid(tailBeats) : null,
    });
    result.headBeats = headBeats;
    result.tailBeats = tailBeats;
    progress(0.68);

    for (const [i, w] of vocalWindows.entries()) {
      progress(0.68 + (0.32 * i) / vocalWindows.length);
      const curve = await vocalCurve(w.left, w.right).catch(() => null);
      if (curve) result.vocals.push({ startSec: w.offsetSec, fps: VOCAL_FPS, curve: Array.from(curve, (v) => Math.round(v * 1000) / 1000) });
    }
    lap('vocals');
    self.postMessage({ id, result, times });
  } catch (e) {
    self.postMessage({ id, error: String(e?.message || e) });
  }
};

function analyze(ess, samples, sampleRate, lap = () => {}, model = {}) {
  const durationSec = samples.length / sampleRate;
  const vec = ess.arrayToVector(samples);
  try {
    // --- rhythm --- (BitChord: over the opening, where the track is mixed in, and the last two
    // minutes, where it is mixed out, each with its own grid and confidence; Beat This!'s where it has one)
    const head = model.head ?? rhythmGrid(ess, samples, sampleRate, 0, Math.min(durationSec, HEAD_SEC));
    const tailGrid = model.tail ?? (durationSec > HEAD_SEC ? rhythmGrid(ess, samples, sampleRate, Math.max(0, durationSec - TAIL_SEC), durationSec) : head);
    const bpm = head?.bpm ?? tailGrid?.bpm ?? null;
    const beatIntervalSec = head?.beatIntervalSec ?? null;
    const firstDownbeatSec = head?.firstDownbeatSec ?? null;
    const gridConfidence = head?.gridConfidence ?? 0;
    lap('rhythm');

    // --- key ---
    const key = ess.KeyExtractor(vec);
    const camelot = toCamelot(key.key, key.scale);
    lap('key');

    // --- energy / structure ---
    const beat = beatIntervalSec ?? tailGrid?.beatIntervalSec;
    const windowSec = beat ? beat * 16 : 4;
    const curve = energyCurve(samples, sampleRate, windowSec);
    const { introEndSec, outroStartSec } = detectIntroOutro(curve, windowSec, durationSec);
    const energy = curve.reduce((a, b) => a + b, 0) / Math.max(1, curve.length);

    return {
      bpm, beatIntervalSec, firstDownbeatSec, gridConfidence,
      camelot, keyName: `${key.key} ${key.scale}`, keyConfidence: key.strength,
      energy, energyCurve: curve, introEndSec, outroStartSec, tailGrid,
      headBeats: null, tailBeats: null, vocals: [],
    };
  } finally {
    vec.delete();
  }
}

/** BitChord: essentia's "excellent" beat-tracking confidence. */
const ESS_EXCELLENT = 3.5;
/** BitChord: the residual a steady beat still shows, from essentia's 11.6 ms hop and its tick wobble. */
const TICK_JITTER_MS = 20;
/** BitChord: how much of the opening the mix-in grid is fitted to; the mix-in point is at most a third in. */
const HEAD_SEC = 100;
/** BitChord: how much of the end the mix-out grid is fitted to (a 32-bar blend at 90 BPM is 85 s). */
const TAIL_SEC = 120;

/** AutoMix's rhythm step (RhythmExtractor2013 -> fitGrid -> downbeat -> confidence) over [startSec, endSec). */
function rhythmGrid(ess, samples, sampleRate, startSec, endSec) {
  const slice = samples.subarray(Math.round(startSec * sampleRate), Math.round(endSec * sampleRate));
  const vec = ess.arrayToVector(slice);
  try {
    const rhythm = ess.RhythmExtractor2013(vec, 208, 'multifeature', 60);
    const ticks = ess.vectorToArray(rhythm.ticks);
    rhythm.ticks.delete();
    rhythm.estimates.delete();
    rhythm.bpmIntervals.delete();
    // essentia's multifeature confidence read on its documented scale, where 1.5-3.5 is "good"
    const essConfidence = Math.max(0, Math.min(1, rhythm.confidence / ESS_EXCELLENT));
    const rawFit = fitGrid(ticks);
    if (!rawFit) return null;
    const fit = normalizeTempo(rawFit);
    const db = findDownbeat(slice, sampleRate, fit.beatIntervalSec, fit.offsetSec);
    return {
      bpm: fit.bpm,
      beatIntervalSec: fit.beatIntervalSec,
      firstDownbeatSec: startSec + db.firstDownbeatSec,
      // jittery ticks (vs the constant grid) and a weak downbeat both reduce trust
      gridConfidence: essConfidence * Math.exp(-Math.max(0, fit.residualMs - TICK_JITTER_MS) / 50) * (0.5 + 0.5 * db.confidence),
    };
  } finally {
    vec.delete();
  }
}

function beatSide(g) {
  return { beats: g.beats, downbeats: g.downbeats, bpm: g.bpm, confidence: g.confidence };
}

/**
 * BitChord: a model grid as AutoMix's constant grid. The model's confidence (0.35-0.95, the phone's
 * scale, beatmatch from 0.55) maps onto AutoMix's (0.2 gate) so 0.55 lands at 0.33 and 0.95 at 1.
 */
function localGrid(side) {
  // the phase-coherence fit over the model's beats: a median gap of 50 Hz frames drifts over a song
  const fit = fitGrid(side.beats);
  const beatIntervalSec = fit ? normalizeTempo(fit).beatIntervalSec : 60 / side.bpm;
  return {
    bpm: 60 / beatIntervalSec,
    beatIntervalSec,
    firstDownbeatSec: side.downbeats[0] ?? side.beats[0],
    gridConfidence: Math.max(0, Math.min(1, (side.confidence - 0.35) / 0.6)),
  };
}
