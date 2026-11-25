// Adapted from AutoMix's src/lib/analysis/analyzer.ts (https://github.com/heydavidf/automix),
// Copyright (C) 2026 David Finnegan, as adapted by BitChord. AGPL-3.0-only: see ../LICENSE and ../NOTICE.md.
//
// BitChord Desktop: the audio comes through the local proxy (the same stream the player plays),
// tracks are keyed by their id, and results are kept in memory and in IndexedDB so the mix loop
// can read them synchronously.

/** Bump when the analysis changes shape or method: older cached results are analysed again. */
export const ANALYSIS_VERSION = 8;
const ANALYSIS_SR = 44100; // RhythmExtractor2013 assumes 44.1 kHz
/** Beat This! wants mono at 22,050 Hz (the browser's resampler: an aliased spectrogram gives a wrong grid). */
const BEAT_SR = 22050;
/** Beat This! is run over this much of the opening and of the end: two model chunks. */
const BEAT_WINDOW_SEC = 59;
/** The vocal model's fixed input, ~22.3 s (models.js VOCAL_WINDOW_SEC). */
const VOCAL_WINDOW_SEC = ((960 - 2) * 1024) / 44100;
/** A failed analysis is asked for again after this long. */
const RETRY_FAILED_MS = 60_000;
/** Compressed audio kept for the loop mix to decode from (current, next, a few around). */
const KEEP_BYTES_FOR = 6;

const log = (...a) => console.info('[automix]', ...a);

/**
 * Sequential analysis queue: fetch -> decode at 44.1k (and 22.05k for Beat This!) -> mono downmix ->
 * the worker -> cache. One track at a time keeps peak memory at one decoded file.
 */
class Analyzer {
  constructor() {
    this.worker = null;
    this.queue = [];
    this.running = false;
    this.results = new Map();
    this.status = new Map();
    this.failedAt = new Map();
    this.bytes = new Map();
    this.listeners = new Set();
    /** How far each track's analysis is, 0-1 (for the Automix pill). */
    this.progress = new Map();
    /** Set by the engine: the stream URL of a track, and where the models are served. */
    this.urlFor = null;
    this.modelBase = '';
  }

  /** The track's compressed audio: fetched once, kept for the last few tracks. */
  audioBytes(track) {
    let held = this.bytes.get(track.id);
    if (held) { this.bytes.delete(track.id); this.bytes.set(track.id, held); return held; }
    held = fetch(this.urlFor(track)).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.arrayBuffer();
    });
    held.catch(() => this.bytes.delete(track.id));
    this.bytes.set(track.id, held);
    while (this.bytes.size > KEEP_BYTES_FOR) this.bytes.delete(this.bytes.keys().next().value);
    return held;
  }

  /** The analysis of [id], if it is done. */
  get(id) { return this.results.get(id) ?? null; }
  statusOf(id) { return this.status.get(id) ?? null; }
  progressOf(id) { return this.status.get(id) === 'done' ? 1 : this.progress.get(id) ?? 0; }
  setProgress(id, p) { this.progress.set(id, p); for (const l of this.listeners) l(id, this.status.get(id)); }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /** Asks for [track] to be analysed. A cached analysis resolves at once; `urgent` jumps the queue. */
  request(track, urgent = false) {
    const id = track.id;
    const known = this.status.get(id);
    if (known === 'done' || known === 'analyzing') return;
    // a failure (a refused download, a network blip) is tried again after a while, not given up on
    if (known === 'error' && Date.now() - (this.failedAt.get(id) ?? 0) < RETRY_FAILED_MS) return;
    if (known === 'pending') {
      if (urgent) {
        const at = this.queue.findIndex((q) => q.id === id);
        if (at > 0) this.queue.unshift(...this.queue.splice(at, 1));
      }
      return;
    }
    this.setStatus(id, 'pending');
    dbGet(id).then((cached) => {
      if (cached && cached.analysisVersion === ANALYSIS_VERSION && this.status.get(id) === 'pending') {
        this.results.set(id, cached);
        this.queue = this.queue.filter((q) => q.id !== id);
        this.setStatus(id, 'done');
      }
    }).catch(() => {});
    if (urgent) this.queue.unshift(track); else this.queue.push(track);
    this.run();
  }

  setStatus(id, status) {
    this.status.set(id, status);
    for (const l of this.listeners) l(id, status);
  }

  ensureWorker() {
    if (this.worker) return this.worker;
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    return this.worker;
  }

  async run() {
    if (this.running) return;
    this.running = true;
    // Let the cache lookups above answer before downloading anything.
    await new Promise((r) => setTimeout(r, 50));
    while (this.queue.length > 0) {
      const track = this.queue.shift();
      if (this.status.get(track.id) !== 'pending') continue;
      this.setStatus(track.id, 'analyzing');
      const started = performance.now();
      try {
        const a = await this.analyzeOne(track);
        this.results.set(track.id, a);
        dbPut(a).catch(() => {});
        log(`${track.title}: ${a.bpm?.toFixed(1) ?? '?'} BPM, ${a.keyName ?? '?'}, ritmo ${a.gridConfidence.toFixed(2)} (final ${a.tailGrid?.gridConfidence?.toFixed(2) ?? '-'}), voz ${a.vocals?.length ?? 0} tramos, ${Math.round(performance.now() - started)} ms (${Object.entries(this.lastTimes || {}).map(([k, v]) => `${k} ${v}`).join(', ')})`);
        this.setStatus(track.id, 'done');
      } catch (e) {
        console.warn('[automix] análisis fallido', track.title, String(e?.message || e));
        this.failedAt.set(track.id, Date.now());
        this.bytes.delete(track.id);
        this.setStatus(track.id, 'error');
      }
    }
    this.running = false;
  }

  async analyzeOne(track) {
    let t0 = performance.now();
    const times = {};
    const lap = (k) => { const n = performance.now(); times[k] = Math.round(n - t0); t0 = n; };
    this.setProgress(track.id, 0.02);
    const bytes = await this.audioBytes(track);
    lap('fetch');
    this.setProgress(track.id, 0.08);
    const buffer = await new OfflineAudioContext({ numberOfChannels: 1, length: 1, sampleRate: ANALYSIS_SR }).decodeAudioData(bytes.slice(0));
    const mono = downmixToMono(buffer);
    const durationSec = buffer.duration;

    // The phone's models read the opening and the end: Beat This! mono at 22,050 Hz, open-unmix stereo at 44.1 kHz.
    const beatWindows = [];
    const mono22 = downmixToMono(await new OfflineAudioContext({ numberOfChannels: 1, length: 1, sampleRate: BEAT_SR }).decodeAudioData(bytes.slice(0)));
    beatWindows.push({ offsetSec: 0, pcm: mono22.slice(0, Math.round(Math.min(durationSec, BEAT_WINDOW_SEC) * BEAT_SR)) });
    if (durationSec > BEAT_WINDOW_SEC) {
      const from = durationSec - BEAT_WINDOW_SEC;
      beatWindows.push({ offsetSec: from, pcm: mono22.slice(Math.round(from * BEAT_SR)) });
    }
    lap('decode');
    this.setProgress(track.id, 0.22);
    const vocalWindows = [];
    const left = buffer.getChannelData(0);
    const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
    // the opening the incoming loop is looked for in (45 s) and the end the outgoing one is (60 s)
    const vocalStarts = [0, VOCAL_WINDOW_SEC].filter((s) => s + VOCAL_WINDOW_SEC <= durationSec);
    for (let k = 1; k <= 3; k++) {
      const start = durationSec - k * VOCAL_WINDOW_SEC;
      if (start >= 2 * VOCAL_WINDOW_SEC) vocalStarts.push(start);
    }
    for (const start of vocalStarts) {
      const a = Math.round(start * ANALYSIS_SR);
      const b = Math.min(left.length, a + Math.floor(VOCAL_WINDOW_SEC * ANALYSIS_SR));
      vocalWindows.push({ offsetSec: start, left: left.slice(a, b), right: right.slice(a, b) });
    }

    const worker = this.ensureWorker();
    const id = Math.random();
    const result = await new Promise((resolve, reject) => {
      const done = () => { worker.removeEventListener('message', on); worker.removeEventListener('error', fail); };
      const on = (e) => {
        if (e.data.id !== id) return;
        if (e.data.progress != null) { this.setProgress(track.id, 0.22 + 0.78 * e.data.progress); return; }
        done();
        if (e.data.error) reject(new Error(e.data.error)); else { Object.assign(times, e.data.times); resolve(e.data.result); }
      };
      const fail = (e) => { done(); this.worker = null; reject(new Error(e.message || 'worker error')); };
      worker.addEventListener('message', on);
      worker.addEventListener('error', fail);
      worker.postMessage(
        { id, modelBase: this.modelBase, samples: mono, sampleRate: ANALYSIS_SR, beatWindows, vocalWindows },
        [mono.buffer, ...beatWindows.map((w) => w.pcm.buffer), ...vocalWindows.flatMap((w) => [w.left.buffer, w.right.buffer])],
      );
    });
    this.lastTimes = times;
    return { fileKey: track.id, tags: { title: track.title || '' }, durationSec, ...result, musicVideo: !!track.isVideo, analysisVersion: ANALYSIS_VERSION };
  }
}

function downmixToMono(buffer) {
  const channels = buffer.numberOfChannels;
  if (channels === 1) return buffer.getChannelData(0).slice();
  const out = new Float32Array(buffer.length);
  for (let ch = 0; ch < channels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < out.length; i++) out[i] += data[i] / channels;
  }
  return out;
}

// ---- IndexedDB cache (as AutoMix's db.ts, without the idb package) ----
let dbp = null;
function db() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('automix', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('analyses', { keyPath: 'fileKey' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}
async function dbGet(id) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction('analyses').objectStore('analyses').get(id);
    r.onsuccess = () => resolve(r.result ?? null);
    r.onerror = () => reject(r.error);
  });
}
async function dbPut(a) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('analyses', 'readwrite');
    tx.objectStore('analyses').put(a);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export const analyzer = new Analyzer();
