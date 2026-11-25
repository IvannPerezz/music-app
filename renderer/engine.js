// BitChord Desktop audio engine.
// Two decks (A/B) on Web Audio so we can do gapless, crossfade and Automix (beat-matched DJ transitions),
// plus a 10-band EQ, loudness normalisation, speed and "skip silence".

export const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const EQ_PRESETS = {
  // Labels are translated where they're shown (eq-panel.js); this module also runs without a window.
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

import { ThreeBandEQ } from './automix/engine/eq.js';
import { MixDeck } from './automix/engine/deck.js';

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
    // Automix (renderer/automix): a DJ mixer's 3-band EQ and the filter mix's high- and low-pass, flat
    // and open except during a mix; `fade` is its gain.
    this.mixEq = new ThreeBandEQ(ctx);
    this.sweep = {
      highpass: new BiquadFilterNode(ctx, { type: 'highpass', frequency: 20, Q: 0.7 }),
      lowpass: new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 20000, Q: 0.7 }),
    };
    this.src.connect(this.mixEq.input);
    this.mixEq.output.connect(this.sweep.highpass).connect(this.sweep.lowpass).connect(this.hp).connect(this.norm).connect(this.fade).connect(engine.input);
    this.mix = new MixDeck(this);
    this.track = null;
    this.analysis = null;
  }
  get time() { return this.audio.currentTime || 0; }
  get duration() { return isFinite(this.audio.duration) ? this.audio.duration : (this.track?.duration || 0); }
  load(track, url) {
    // Whatever Automix had scheduled or was holding on this deck belonged to the old song: drop it
    // (its servo would seek the new song to the old one's position, or start it when paused).
    this.mix.cancel();
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
    this.mix.cancel();
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
    this.tap = node; // after the equalizer, before the volume: what the visualizer listens to
    // Pause/resume fades (as Apple Music does): their own gain, so the volume and the crossfades don't care.
    this.fadeNode = ctx.createGain();
    this.pausing = null; // the timer that pauses once the fade-out ends
    node.connect(this.volumeNode).connect(this.fadeNode).connect(this.limiter).connect(this.analyser).connect(ctx.destination);

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
    /** The new Automix (renderer/automix), built the first time it is switched on. */
    this.dj = null;
    /** A loop mix holds both elements paused while its decks play: that's still playing. */
    this.holding = false;
    /** Set by the app: where the local proxy serves Automix's models, and a track's sung lines. */
    this.automixBase = '';
    this.sungSpansFor = null;

    for (const d of this.decks) this.#wire(d);
    this.tick = this.tick.bind(this);
    setInterval(this.tick, 50);
  }

  get other() { return this.cur === this.decks[0] ? this.decks[1] : this.decks[0]; }
  get audio() { return this.cur.audio; }
  get paused() { return !!this.pausing || (this.cur.audio.paused && !this.holding); } // (fading out counts as paused)
  get currentTime() {
    // While a loop mix plays the song from a deck (looping, at the ramped tempo): the mix's own clock.
    if (this.holding && this.cur.track) { const t = this.dj?.mixPlayhead(this.cur.track.id); if (t != null) return t; }
    return this.cur.time;
  }
  /** Automix is between scheduling a mix and its end. */
  get mixing() { return !!this.dj?.mixing; }
  set currentTime(t) { this.seek(t); }
  get duration() { return this.cur.duration; }
  get buffered() { return this.cur.audio.buffered; }

  #emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  #wire(d) {
    const a = d.audio;
    const mine = () => d === this.cur;
    a.addEventListener('playing', () => mine() && this.#emit('playing'));
    a.addEventListener('pause', () => mine() && !this.transition && !this.holding && this.#emit('pause'));
    a.addEventListener('play', () => mine() && this.#emit('play'));
    a.addEventListener('waiting', () => mine() && this.#emit('waiting'));
    a.addEventListener('canplay', () => mine() && this.#emit('canplay'));
    a.addEventListener('durationchange', () => mine() && this.#emit('timeupdate'));
    a.addEventListener('progress', () => mine() && this.#emit('progress'));
    a.addEventListener('ended', () => {
      if (!mine()) return;
      if (this.transition || this.holding) return;
      // Automix's outgoing track ran out before the blend's midpoint (a stall): the incoming one is already playing.
      if (this.dj?.forceHandoff()) return;
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
    this.queuedNext = null; // (a new track: whatever was queued during a mix belonged to the old one)
    this.#cancelMix();
    this.queuedNext = null;
    this.#cancelTransition(true);
    this.other.unload();
    this.#fade(1, 0);
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
    this.dj?.poke();
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
  /** Play or pause with a fade: in over 0.7 s from silence (or from wherever a fade-out had got to),
   *  out over 0.25 s and only then paused. A new track starts at full level (see play()). */
  playPause(play, { fade = true } = {}) {
    if (play) {
      // From silence, or from the level a fade-out had got to (pressed again halfway through it).
      const from = this.pausing ? this.fadeNode.gain.value : 0;
      this.resume();
      this.cur.audio.play().catch(() => {});
      if (this.transition) this.other.audio.play().catch(() => {});
      const midFade = !!this.pausing;
      this.#fade(1, fade ? 0.7 : 0, from);
      if (midFade) this.#emit('play'); // (never really paused, so the <audio> won't say so)
    } else {
      this.#cancelMix(); // (the user took over: the song in front plays on, then pauses)
      if (this.pausing || this.cur.audio.paused) return;
      if (!fade) { this.#fade(0, 0); this.cur.audio.pause(); if (this.transition) this.#finishTransition(true); return; }
      this.#fade(0, 0.25);
      this.pausing = setTimeout(() => {
        this.pausing = null;
        this.cur.audio.pause();
        if (this.transition) this.#finishTransition(true);
      }, 250);
      this.#emit('pausing');
    }
  }
  /** Fade the output from `from` (default: where it is) to `to` over `secs`, along a smooth S-curve. */
  #fade(to, secs, from = this.fadeNode.gain.value) {
    if (this.pausing && to !== 0) { clearTimeout(this.pausing); this.pausing = null; }
    const g = this.fadeNode.gain, now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    if (!secs) { g.setValueAtTime(to, now); return; }
    // Fade-in: starts just above silence, stays low most of the way and shoots up at the end
    // (0.02 + 0.98·t^4.5, the curve Iván drew). Fade-out: a smooth S-curve.
    const rising = to > from;
    const curve = new Float32Array(64);
    for (let i = 0; i < curve.length; i++) {
      const t = i / (curve.length - 1);
      curve[i] = from + (to - from) * (rising ? 0.02 + 0.98 * t ** 4.5 : (1 - Math.cos(Math.PI * t)) / 2);
    }
    curve[curve.length - 1] = to;
    g.setValueCurveAtTime(curve, now, secs);
  }
  seek(t) {
    this.#cancelMix();
    if (this.transition) this.#finishTransition(true);
    const d = this.cur;
    d.audio.currentTime = clamp(t, 0, Math.max(0, d.duration - 0.05));
  }
  stop() { this.#cancelMix(); this.queuedNext = null; this.#cancelTransition(true); for (const d of this.decks) d.unload(); this.nextTrack = null; }

  setVolume(v) { this.volumeNode.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02); }
  setSpeed(s) { this.speed = s; for (const d of this.decks) d.setRate(d.baseRate || 1); }
  setEq(enabled, bands, preamp = 0) {
    this.eq.forEach((b, i) => b.gain.setTargetAtTime(enabled ? bands[i] || 0 : 0, this.ctx.currentTime, 0.03));
    this.preampNode.gain.setTargetAtTime(enabled ? Math.pow(10, preamp / 20) : 1, this.ctx.currentTime, 0.03);
  }
  configure(o) {
    for (const k of ['crossfade', 'gapless', 'automix', 'automixBars', 'skipSilence', 'normalize']) if (k in o) this[k] = o[k];
    if ('automix' in o || 'automixBars' in o) this.#syncAutomix();
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
    // Mid-transition the idle deck is still playing the outgoing track: keep it for when the mix ends
    // (otherwise the track we just mixed into would never learn what follows it: no Automix after it).
    if (this.transition) { this.queuedNext = [track, url, loudnessDb]; return; }
    if (this.dj?.mixing) {
      // Past the midpoint the idle deck is the outgoing song: wait for the mix to end. Before it, a
      // different next song (the queue changed) drops the mix; the same one needs nothing.
      if (this.dj.blend?.handedOff || this.holding) { this.queuedNext = [track, url, loudnessDb]; return; }
      if (track && this.other.track?.id === track.id) return;
      this.#cancelMix();
    }
    this.queuedNext = null;
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
    const start = this.automix ? 0 : (this.skipSilence && o.analysis?.soundStart > 0.4 ? o.analysis.soundStart : 0);
    try { o.audio.currentTime = start; } catch {}
  }

  #wantAnalysis() { return this.skipSilence; } // (Automix has its own analysis: renderer/automix)

  /** Where Automix will mix into the next song, in the current song's seconds ({ startSec, endSec,
   *  style }), or null while there's none yet (both songs must be analysed first). */
  get mixWindow() {
    const w = this.automix && this.dj?.bothAnalyzed ? this.dj.window : null;
    return w && w.id === this.cur.track?.id ? w : null;
  }

  /**
   * What Automix is doing right now, for the pill over the player bar:
   * { kind: 'mix', title, progress } during a mix (0-1 through it), { kind: 'soon', title, secs } just
   * before one, { kind: 'analyze', title, progress } while the playing or next song is analysed; else null.
   */
  get automixStatus() {
    const dj = this.dj;
    if (!this.automix || !dj || dj.state === 'idle') return null;
    if (dj.state === 'scheduled' && dj.plan) {
      const now = this.ctx.currentTime, { t0, durationSec } = dj.plan;
      const title = dj.mixInto?.title || '';
      if (now < t0) return { kind: 'soon', title, secs: t0 - now };
      return { kind: 'mix', title, progress: Math.min(1, (now - t0) / durationSec), style: dj.plan.style };
    }
    const a = this.analyzer;
    for (const t of [this.cur.track, this.nextTrack?.track]) {
      const st = t && a?.statusOf(t.id);
      if (st === 'analyzing' || st === 'pending') return { kind: 'analyze', title: t.title || '', progress: a.progressOf(t.id) };
    }
    return null;
  }

  // ---------------------------------------------------------------- Automix (renderer/automix)
  async #syncAutomix() {
    if (!this.automix) { this.dj?.stop(); return; }
    if (!this.dj) {
      const [{ AutoDJ }, { analyzer }, { LoopDeck }] = await Promise.all([
        import('./automix/engine/autodj.js'), import('./automix/analysis/analyzer.js'), import('./automix/engine/loopDeck.js'),
      ]);
      analyzer.urlFor = (t) => this.urlFor(t);
      analyzer.modelBase = this.automixBase;
      this.analyzer = analyzer;
      let loops = null;
      this.dj ??= new AutoDJ({
        ctx: this.ctx,
        front: () => this.cur.mix,
        back: () => this.other.mix,
        current: () => (this.cur.track && !this.paused ? this.cur.track : null),
        next: () => this.nextTrack?.track ?? null,
        loadBack: (track) => this.#loadBack(track),
        handoff: () => this.#mixHandoff(),
        finished: () => this.#mixFinished(),
        hold: (on) => { this.holding = on; },
        loopDecks: () => (loops ??= Promise.all([LoopDeck.create(this.ctx, this.input), LoopDeck.create(this.ctx, this.input)])),
        sungSpans: async (track) => (await this.sungSpansFor?.(track)) ?? null,
      });
    }
    if (!this.automix) return;
    this.dj.transitionBars = this.automixBars;
    this.dj.start();
  }

  /** The next song on the idle deck, paused and ready to start (setNext put it there). */
  #loadBack(track) {
    const o = this.other;
    if (o.track?.id !== track.id) return Promise.resolve(false);
    o.mix.cancel();
    o.audio.pause();
    if (o.audio.readyState >= 1) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (ok) => { clearTimeout(timer); o.audio.removeEventListener('loadedmetadata', yes); o.audio.removeEventListener('error', no); resolve(ok && o.track?.id === track.id); };
      const yes = () => done(true), no = () => done(false);
      const timer = setTimeout(() => done(false), 15000);
      o.audio.addEventListener('loadedmetadata', yes);
      o.audio.addEventListener('error', no);
    });
  }

  /** The mix's midpoint: the incoming song is the one playing now, as far as everything else knows. */
  #mixHandoff() {
    const inn = this.other;
    if (!inn.track || inn.track !== this.nextTrack?.track) { this.dj?.cancel(); return; }
    this.cur = inn;
    this.nextTrack = null;
    this.#emit('trackchange', { track: inn.track, auto: true, transition: 'automix' });
    this.#emit('timeupdate');
  }

  /** The mix is over: the old deck lets go of its song; whatever the app queued meanwhile goes on it. */
  #mixFinished() {
    this.other.unload();
    // (once the mix has closed: until then setNext would just queue it again)
    setTimeout(() => {
      const q = this.queuedNext;
      this.queuedNext = null;
      if (q) this.setNext(...q);
    }, 0);
  }

  /** The user took over (a pause, a seek, another song): the song in front plays on, the mix is dropped. */
  #cancelMix() {
    // A finished mix leaves the new song gliding back to its normal speed (~24 s), held to the mix's
    // clock by a servo that seeks it and starts it if paused: a pause or a seek ends that at once.
    if (this.dj?.settling) { this.dj.settling.cancel(); this.dj.settling = null; }
    if (!this.dj?.mixing) return;
    const handedOff = this.dj.blend?.handedOff;
    this.dj.cancel();
    this.holding = false;
    if (handedOff) { this.other.unload(); }
    else if (this.nextTrack && this.other.track === this.nextTrack.track) { this.other.audio.pause(); try { this.other.audio.currentTime = 0; } catch {} }
    const q = this.queuedNext;
    this.queuedNext = null;
    if (q) this.setNext(...q);
  }

  // ---------------------------------------------------------------- transitions
  #plan() {
    const out = this.cur, inn = this.other;
    const dur = out.duration;
    if (!dur || !inn.track) return null;
    const oa = out.analysis, ia = inn.analysis;
    const endOfSound = this.skipSilence && oa?.soundEnd ? Math.min(dur, oa.soundEnd + 0.2) : dur;

    if (this.automix) return null; // (renderer/automix plans its own mixes)
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
    const q = this.queuedNext;
    if (q) { this.queuedNext = null; this.setNext(...q); }
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

  analysisFor(id) { return this.analyzer?.get(id) || this.analyses.get(id) || null; }
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
