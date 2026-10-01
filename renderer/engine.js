// BitChord Desktop audio engine.
// Two decks (A/B) on Web Audio so we can do gapless, crossfade and Automix (beat-matched DJ transitions),
// plus a 10-band EQ, loudness normalisation, speed and "skip silence".

export const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const EQ_PRESETS = {
  flat: { label: 'Plano', bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  bass: { label: 'Refuerzo de graves', bands: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
  treble: { label: 'Refuerzo de agudos', bands: [0, 0, 0, 0, 0, 1, 2, 4, 5, 6] },
  vocal: { label: 'Voces', bands: [-2, -2, -1, 1, 3, 4, 3, 1, 0, -1] },
  rock: { label: 'Rock', bands: [4, 3, 2, 0, -1, -1, 1, 3, 4, 4] },
  pop: { label: 'Pop', bands: [-1, 1, 3, 4, 3, 0, -1, -1, 0, 1] },
  electronic: { label: 'Electrónica', bands: [5, 4, 1, 0, -2, 1, 0, 2, 4, 5] },
  hiphop: { label: 'Hip-hop', bands: [5, 4, 2, 3, -1, -1, 1, 0, 2, 3] },
  acoustic: { label: 'Acústico', bands: [3, 3, 2, 1, 2, 2, 3, 3, 2, 1] },
  classical: { label: 'Clásica', bands: [3, 2, 1, 0, 0, 0, -1, 1, 2, 3] },
  loudness: { label: 'Sonoridad', bands: [5, 3, 0, 0, -2, 0, -1, 0, 3, 4] },
  night: { label: 'Nocturno (suave)', bands: [-3, -2, -1, 0, 1, 1, 0, -1, -3, -4] },
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

class Deck {
  constructor(engine, name) {
    this.engine = engine;
    this.name = name;
    const ctx = engine.ctx;
    this.audio = new Audio();
    this.audio.crossOrigin = 'anonymous';
    this.audio.preload = 'auto';
    this.audio.preservesPitch = true;
    this.src = ctx.createMediaElementSource(this.audio);
    this.hp = ctx.createBiquadFilter(); this.hp.type = 'highpass'; this.hp.frequency.value = 10; this.hp.Q.value = 0.7;
    this.norm = ctx.createGain();
    this.fade = ctx.createGain();
    this.src.connect(this.hp).connect(this.norm).connect(this.fade).connect(engine.input);
    this.track = null;
    this.analysis = null;
  }
  get time() { return this.audio.currentTime || 0; }
  get duration() { return isFinite(this.audio.duration) ? this.audio.duration : (this.track?.duration || 0); }
  load(track, url) {
    this.track = track;
    this.analysis = null;
    this.retried = false;
    this.audio.src = url;
    this.audio.load();
    this.setRate(1);
    this.hp.frequency.cancelScheduledValues(0); this.hp.frequency.value = 10;
    this.fade.gain.cancelScheduledValues(0); this.fade.gain.value = 1;
  }
  unload() {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.track = null;
    this.analysis = null;
  }
  setRate(r) { this.baseRate = r; this.audio.playbackRate = clamp(r * this.engine.speed, 0.25, 4); }
  setNorm(db) {
    this.lastNormDb = db;
    // YouTube's loudness_db: how far above the reference the track is. Attenuate loud tracks, lift quiet ones a little.
    const g = db == null || !this.engine.normalize ? 1 : Math.pow(10, clamp(-db, -12, 6) / 20);
    this.norm.gain.setTargetAtTime(g, this.engine.ctx.currentTime, 0.05);
  }
}

export class Engine extends EventTarget {
  constructor() {
    super();
    this.ctx = new AudioContext({ latencyHint: 'playback' });
    const ctx = this.ctx;
    this.input = ctx.createGain();
    this.preampNode = ctx.createGain();
    this.eq = EQ_FREQS.map((f, i) => {
      const b = ctx.createBiquadFilter();
      b.type = i === 0 ? 'lowshelf' : i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking';
      b.frequency.value = f; b.Q.value = 1.1; b.gain.value = 0;
      return b;
    });
    this.volumeNode = ctx.createGain();
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1; this.limiter.knee.value = 0; this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.003; this.limiter.release.value = 0.15;
    this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 2048;
    let node = this.input.connect(this.preampNode);
    for (const b of this.eq) node = node.connect(b);
    node.connect(this.volumeNode).connect(this.limiter).connect(this.analyser).connect(ctx.destination);

    this.decks = [new Deck(this, 'A'), new Deck(this, 'B')];
    this.cur = this.decks[0];
    this.speed = 1;
    this.normalize = true;
    this.crossfade = 0;
    this.gapless = true;
    this.automix = false;
    this.automixBars = 8;
    this.skipSilence = false;
    this.nextTrack = null; // {track, url}
    this.transition = null;
    this.analyses = new Map();
    this.worker = null;

    for (const d of this.decks) this.#wire(d);
    this.tick = this.tick.bind(this);
    setInterval(this.tick, 50);
  }

  get other() { return this.cur === this.decks[0] ? this.decks[1] : this.decks[0]; }
  get audio() { return this.cur.audio; }
  get paused() { return this.cur.audio.paused; }
  get currentTime() { return this.cur.time; }
  set currentTime(t) { this.seek(t); }
  get duration() { return this.cur.duration; }
  get buffered() { return this.cur.audio.buffered; }

  #emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  #wire(d) {
    const a = d.audio;
    const mine = () => d === this.cur;
    a.addEventListener('playing', () => mine() && this.#emit('playing'));
    a.addEventListener('pause', () => mine() && !this.transition && this.#emit('pause'));
    a.addEventListener('play', () => mine() && this.#emit('play'));
    a.addEventListener('waiting', () => mine() && this.#emit('waiting'));
    a.addEventListener('canplay', () => mine() && this.#emit('canplay'));
    a.addEventListener('durationchange', () => mine() && this.#emit('timeupdate'));
    a.addEventListener('progress', () => mine() && this.#emit('progress'));
    a.addEventListener('ended', () => {
      if (!mine()) return;
      if (this.transition) return;
      if (this.nextTrack && (this.gapless || this.crossfade > 0 || this.automix)) this.#startNext({ kind: 'gapless' });
      else this.#emit('ended');
    });
    a.addEventListener('error', () => {
      if (mine()) this.#emit('error', { track: d.track, time: d.time });
      else if (d.track && this.nextTrack && d.track === this.nextTrack.track) this.#emit('preload-error', { track: d.track });
    });
  }

  // ---------------------------------------------------------------- basic transport
  async resume() { if (this.ctx.state !== 'running') try { await this.ctx.resume(); } catch {} }

  play(track, url, { at = 0, autoplay = true, loudnessDb = null } = {}) {
    this.#cancelTransition(true);
    this.other.unload();
    const d = this.cur;
    d.load(track, url);
    d.setNorm(loudnessDb);
    const a = this.analyses.get(track.id);
    if (a) d.analysis = a;
    const start = at || (this.skipSilence && a?.soundStart > 0.4 ? a.soundStart : 0);
    if (start) d.audio.currentTime = start;
    if (autoplay) { this.resume(); d.audio.play().catch(() => {}); }
    this.#emit('trackchange', { track, auto: false });
    this.#emit('timeupdate');
    if (this.#wantAnalysis()) this.analyze(track).then((an) => { if (d.track === track) d.analysis = an; }).catch((e) => console.warn('analysis', e));
  }

  reloadCurrent(url, at) {
    const d = this.cur;
    const wasPlaying = !d.audio.paused;
    d.audio.src = url;
    d.audio.load();
    if (at) d.audio.currentTime = at;
    d.setRate(d.baseRate || 1);
    if (wasPlaying || true) d.audio.play().catch(() => {});
  }

  toggle() { this.paused ? this.playPause(true) : this.playPause(false); }
  playPause(play) {
    if (play) { this.resume(); this.cur.audio.play().catch(() => {}); if (this.transition) this.other.audio.play().catch(() => {}); }
    else {
      this.cur.audio.pause();
      if (this.transition) this.#finishTransition(true);
    }
  }
  seek(t) {
    if (this.transition) this.#finishTransition(true);
    const d = this.cur;
    d.audio.currentTime = clamp(t, 0, Math.max(0, d.duration - 0.05));
  }
  stop() { this.#cancelTransition(true); for (const d of this.decks) d.unload(); this.nextTrack = null; }

  setVolume(v) { this.volumeNode.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02); }
  setSpeed(s) { this.speed = s; for (const d of this.decks) d.setRate(d.baseRate || 1); }
  setEq(enabled, bands, preamp = 0) {
    this.eq.forEach((b, i) => b.gain.setTargetAtTime(enabled ? bands[i] || 0 : 0, this.ctx.currentTime, 0.03));
    this.preampNode.gain.setTargetAtTime(enabled ? Math.pow(10, preamp / 20) : 1, this.ctx.currentTime, 0.03);
  }
  configure(o) {
    for (const k of ['crossfade', 'gapless', 'automix', 'automixBars', 'skipSilence', 'normalize']) if (k in o) this[k] = o[k];
    if ('normalize' in o) for (const d of this.decks) d.setNorm(d.lastNormDb ?? null);
    if (this.#wantAnalysis()) {
      for (const d of this.decks) {
        if (!d.track || d.analysis) continue;
        const tr = d.track;
        this.analyze(tr).then((an) => { if (d.track === tr) { d.analysis = an; if (d === this.other) this.#cueNext(); } }).catch((e) => console.warn('analysis', e));
      }
    }
  }

  /** What plays after the current track (already resolved URL). Preloads it on the idle deck. */
  setNext(track, url, loudnessDb = null) {
    if (this.transition) return; // decided already
    if (!track) { this.nextTrack = null; this.other.unload(); return; }
    if (this.nextTrack?.track?.id === track.id && this.nextTrack.url === url) return;
    this.nextTrack = { track, url, loudnessDb };
    const o = this.other;
    o.load(track, url);
    o.setNorm(loudnessDb);
    o.audio.pause();
    const a = this.analyses.get(track.id);
    if (a) { o.analysis = a; this.#cueNext(); }
    if (this.#wantAnalysis()) this.analyze(track).then((an) => { if (o.track === track) { o.analysis = an; this.#cueNext(); } }).catch(() => {});
    else this.#cueNext();
  }

  #cueNext() {
    const o = this.other;
    if (!o.track) return;
    const start = this.automix && o.analysis ? this.#plan()?.inAt ?? 0 : (this.skipSilence && o.analysis?.soundStart > 0.4 ? o.analysis.soundStart : 0);
    try { o.audio.currentTime = start; } catch {}
  }

  #wantAnalysis() { return this.automix || this.skipSilence; }

  // ---------------------------------------------------------------- transitions
  #plan() {
    const out = this.cur, inn = this.other;
    const dur = out.duration;
    if (!dur || !inn.track) return null;
    const oa = out.analysis, ia = inn.analysis;
    const endOfSound = this.skipSilence && oa?.soundEnd ? Math.min(dur, oa.soundEnd + 0.2) : dur;

    if (this.automix && oa?.bpm && ia?.bpm) {
      // Beat-matched mix: choose tempo ratio (allowing half/double time), N bars ending at the outro.
      let ratio = oa.bpm / ia.bpm;
      if (ratio > 1.5) ratio /= 2; else if (ratio < 0.67) ratio *= 2;
      const matchable = Math.abs(1 - ratio) <= 0.08;
      const beat = 60 / oa.bpm;
      const bars = matchable ? this.automixBars : Math.min(4, this.automixBars);
      let len = bars * 4 * beat;
      len = clamp(len, 4, Math.min(24, dur / 3));
      // Where to start: snap to a downbeat of the outgoing track that ends the mix before the sound ends.
      const outEnd = oa.outroAt && oa.outroAt > dur * 0.5 ? Math.min(endOfSound, oa.outroAt + len * 0.75) : endOfSound;
      let outAt = outEnd - len;
      if (oa.downbeat != null) outAt = snapToBar(outAt, oa.downbeat, beat);
      outAt = clamp(outAt, dur * 0.35, dur - 1);
      // Incoming: first downbeat after its sound starts.
      const ibeat = 60 / ia.bpm;
      let inAt = ia.downbeat != null ? ia.downbeat : (ia.soundStart || 0);
      while (inAt < (ia.soundStart || 0) - 0.01) inAt += 4 * ibeat;
      return { kind: 'automix', outAt, len, inAt, ratio: matchable ? ratio : 1, beatmatch: matchable, beat };
    }
    if (this.crossfade > 0) {
      const len = Math.min(this.crossfade, dur / 3);
      return { kind: 'crossfade', outAt: endOfSound - len, len, inAt: this.skipSilence ? ia?.soundStart || 0 : 0, ratio: 1 };
    }
    if (this.gapless || this.skipSilence) {
      // Start the next deck just before the end to hide decoder start-up.
      return { kind: 'gapless', outAt: endOfSound - 0.08, len: 0.08, inAt: this.skipSilence ? ia?.soundStart || 0 : 0, ratio: 1 };
    }
    return null;
  }

  tick() {
    const d = this.cur;
    if (!d.track) return;
    this.#emit('timeupdate');
    if (this.transition) { this.#stepTransition(); return; }
    if (d.audio.paused || !this.nextTrack || this.other.track !== this.nextTrack.track) return;
    const plan = this.#plan();
    if (plan && d.time >= plan.outAt && d.time < d.duration - 0.02) this.#startNext(plan);
  }

  #startNext(plan) {
    const out = this.cur, inn = this.other;
    if (!inn.track) return;
    if (plan.kind === 'gapless' && !plan.len) plan = { kind: 'gapless', len: 0, inAt: 0, ratio: 1 };
    const ctx = this.ctx, now = ctx.currentTime;
    try { if (Math.abs(inn.time - (plan.inAt || 0)) > 0.25) inn.audio.currentTime = plan.inAt || 0; } catch {}
    inn.setRate(plan.ratio || 1);
    const len = Math.max(0.01, plan.len || 0) / (this.speed || 1);
    inn.fade.gain.cancelScheduledValues(now);
    out.fade.gain.cancelScheduledValues(now);
    if (plan.kind === 'automix') {
      // Equal-power fade + bass swap: the incoming track comes in thin, the outgoing one loses its low end.
      inn.fade.gain.setValueAtTime(0.0001, now);
      inn.fade.gain.setValueCurveAtTime(curve(0, 1), now, len);
      out.fade.gain.setValueCurveAtTime(curve(1, 0), now, len);
      inn.hp.frequency.setValueAtTime(350, now);
      inn.hp.frequency.setValueAtTime(350, now + len * 0.45);
      inn.hp.frequency.exponentialRampToValueAtTime(10, now + len * 0.55);
      out.hp.frequency.setValueAtTime(10, now + len * 0.45);
      out.hp.frequency.exponentialRampToValueAtTime(350, now + len * 0.55);
    } else if (plan.kind === 'crossfade') {
      inn.fade.gain.setValueAtTime(0.0001, now);
      inn.fade.gain.setValueCurveAtTime(curve(0, 1), now, len);
      out.fade.gain.setValueCurveAtTime(curve(1, 0), now, len);
    } else {
      inn.fade.gain.setValueAtTime(1, now);
    }
    inn.audio.play().catch(() => {});
    this.transition = { plan, out, inn, startCtx: now, len, outStart: out.time, inStart: plan.inAt || 0 };
    // Swap: the incoming deck is now "current" for the UI.
    this.cur = inn;
    this.nextTrack = null;
    this.#emit('trackchange', { track: inn.track, auto: true, transition: plan.kind });
    if (plan.kind === 'gapless') setTimeout(() => this.#finishTransition(), 150);
  }

  #stepTransition() {
    const t = this.transition;
    const el = this.ctx.currentTime - t.startCtx;
    if (t.plan.kind === 'automix' && t.plan.beatmatch && el < t.len) {
      // Keep the beats locked: nudge the incoming rate by the phase error against the outgoing grid.
      const outPos = t.out.time - t.outStart; // seconds of outgoing played since mix start
      const expected = t.inStart + outPos / t.plan.ratio;
      const err = t.inn.time - expected; // + = incoming ahead
      const corr = clamp(-err * 0.5, -0.03, 0.03);
      t.inn.audio.playbackRate = clamp(t.plan.ratio * (1 + corr) * this.speed, 0.25, 4);
    }
    if (el >= t.len) this.#finishTransition();
  }

  #finishTransition(abrupt = false) {
    const t = this.transition;
    if (!t) return;
    this.transition = null;
    const now = this.ctx.currentTime;
    t.out.audio.pause();
    t.out.fade.gain.cancelScheduledValues(now); t.out.fade.gain.value = 1;
    t.out.hp.frequency.cancelScheduledValues(now); t.out.hp.frequency.value = 10;
    t.inn.fade.gain.cancelScheduledValues(now); t.inn.fade.gain.setValueAtTime(1, now);
    t.inn.hp.frequency.cancelScheduledValues(now); t.inn.hp.frequency.setValueAtTime(10, now);
    t.out.unload();
    // Glide the incoming tempo back to normal over a few bars (no pitch change: preservesPitch).
    if (t.plan.ratio && t.plan.ratio !== 1 && !abrupt) glideRate(t.inn, t.plan.ratio, 1, 8 * (t.plan.beat || 0.5) * 4);
    else t.inn.setRate(1);
    this.#emit('transition-done');
  }

  #cancelTransition(abrupt) { if (this.transition) this.#finishTransition(abrupt); }

  // ---------------------------------------------------------------- analysis (BPM, beats, silence)
  analyze(track) {
    if (this.analyses.has(track.id)) return Promise.resolve(this.analyses.get(track.id));
    const cached = loadAnalysis(track.id);
    if (cached) { this.analyses.set(track.id, cached); return Promise.resolve(cached); }
    if (this.pendingAnalysis?.id === track.id) return this.pendingAnalysis.p;
    const p = (async () => {
      const url = this.urlFor(track);
      const buf = await (await fetch(url)).arrayBuffer();
      const off = new OfflineAudioContext(1, 1, 22050);
      const audio = await off.decodeAudioData(buf);
      const n = audio.length, ch = audio.numberOfChannels;
      const mono = new Float32Array(n);
      for (let c = 0; c < ch; c++) { const d = audio.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / ch; }
      if (!this.worker) this.worker = new Worker(new URL('./analysis-worker.js', import.meta.url), { type: 'module' });
      const result = await new Promise((resolve, reject) => {
        const id = Math.random();
        const on = (e) => { if (e.data.id !== id) return; this.worker.removeEventListener('message', on); e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.result); };
        this.worker.addEventListener('message', on);
        this.worker.postMessage({ id, samples: mono, sampleRate: audio.sampleRate }, [mono.buffer]);
      });
      this.analyses.set(track.id, result);
      saveAnalysis(track.id, result);
      return result;
    })();
    this.pendingAnalysis = { id: track.id, p };
    p.finally(() => { if (this.pendingAnalysis?.p === p) this.pendingAnalysis = null; });
    return p;
  }

  analysisFor(id) { return this.analyses.get(id) || null; }
}

function curve(from, to, n = 64) {
  // Equal-power curve.
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    c[i] = Math.max(0.0001, from < to ? Math.sin(x * Math.PI / 2) : Math.cos(x * Math.PI / 2));
  }
  return c;
}

function snapToBar(t, downbeat, beat) {
  const bar = beat * 4;
  const k = Math.floor((t - downbeat) / bar + 0.05);
  return downbeat + k * bar;
}

function glideRate(deck, from, to, seconds) {
  const steps = Math.max(1, Math.round(seconds * 10));
  let i = 0;
  const id = setInterval(() => {
    i++;
    if (!deck.track) { clearInterval(id); return; }
    deck.setRate(from + (to - from) * (i / steps));
    if (i >= steps) clearInterval(id);
  }, 100);
}

function loadAnalysis(id) { try { const v = localStorage.getItem('an.' + id); return v ? JSON.parse(v) : null; } catch { return null; } }
function saveAnalysis(id, a) {
  try {
    localStorage.setItem('an.' + id, JSON.stringify(a));
    const keys = Object.keys(localStorage).filter((k) => k.startsWith('an.'));
    if (keys.length > 1500) keys.slice(0, 300).forEach((k) => localStorage.removeItem(k));
  } catch {}
}
