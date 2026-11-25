// Adapted from AutoMix's src/lib/engine/deck.ts (https://github.com/heydavidf/automix),
// Copyright (C) 2026 David Finnegan, as adapted by BitChord. AGPL-3.0-only: see ../LICENSE and ../NOTICE.md.
//
// AutoMix's deck is a signalsmith-stretch worklet over a decoded buffer. Here (as in BitChord's web
// player) it is one of the player's two <audio> elements, routed through Web Audio. The public
// surface is AutoMix's, so the transition scheduler runs unchanged: a Timeline mirror of every
// scheduled change, a 3-band EQ, a gain, and changes applied only when due. What the worklet did
// sample-accurately, a phase-lock servo does here: while a transition is in flight the element is
// held on its timeline by nudging its pitch-preserving playbackRate, or by a seek when it is far off.
//
// BitChord Desktop: wraps a deck of renderer/engine.js (which owns the element, the EQ, the filters
// and the gain nodes); rates here are absolute (the player's speed included).
import { Timeline } from './timeline.js';

/** Off by more than this, a seek; below it, a rate nudge. */
const SEEK_ERROR_SEC = 0.25;
/** Inside this, the element is on the beat (a 16th at 128 BPM is 117 ms). */
const DEADBAND_SEC = 0.006;
/** Largest rate nudge: 3% is below what a listener hears with pitch preserved. */
const MAX_NUDGE = 0.03;
/** Largest rate nudge while the deck's gain is under 0.3. */
const MAX_QUIET_NUDGE = 0.1;
/** Seconds of error corrected per second of playback. */
const SERVO_GAIN = 0.8;
const SERVO_MS = 40;

export class MixDeck {
  /** @param deck a Deck of renderer/engine.js: { engine, audio, mixEq, sweep, fade } */
  constructor(deck) {
    this.deck = deck;
    this.ctx = deck.engine.ctx;
    this.audio = deck.audio;
    this.eq = deck.mixEq;
    this.gain = deck.fade;
    this.sweep = deck.sweep;
    this.timeline = new Timeline();
    /** How long play() takes to put audio out, learned from each start. */
    this.latencySec = 0.12;
    this.pending = [];
    this.dispatchTimer = null;
    this.locked = false;
    /** The deck this one follows while locked: the outgoing track, which is never nudged. */
    this.leader = null;
    this.errors = [];
    this.seekingUntil = 0;
  }

  get track() { return this.deck.track; }
  get durationSec() { return Number.isFinite(this.audio.duration) ? this.audio.duration : (this.deck.track?.duration || 0); }
  /** Earliest ctx time a new schedule can take full effect. */
  get scheduleAhead() { return this.latencySec + 0.05; }
  /** The player's speed: what "normal" means for a rate. */
  get unity() { return this.deck.engine.speed || 1; }

  /** Model = what the element is doing now (no transition in flight: follows seeks, pauses, its own clock). */
  anchor() {
    if (this.locked || this.pending.length) return;
    const now = this.ctx.currentTime;
    this.timeline.clear();
    this.timeline.add({ output: now, input: this.audio.currentTime, rate: this.audio.playbackRate || 1, active: !this.audio.paused && !this.audio.ended });
  }

  /** anchor() from the median of several readings (the element's clock moves in audio-callback steps). */
  async anchorPrecise(samples = 9, spacingMs = 35) {
    if (this.audio.paused) return this.anchor();
    const offsets = [];
    const rate = this.audio.playbackRate || 1;
    for (let i = 0; i < samples; i++) {
      offsets.push(this.audio.currentTime - this.ctx.currentTime * rate);
      await new Promise((r) => setTimeout(r, spacingMs));
    }
    offsets.sort((a, b) => a - b);
    const offset = offsets[offsets.length >> 1];
    const now = this.ctx.currentTime;
    this.timeline.clear();
    this.timeline.add({ output: now, input: offset + now * rate, rate, active: !this.audio.paused });
  }

  /** Schedule playback of trackTime at ctxTime. */
  playAt({ ctxTime, trackTime, rate = 1 }) {
    const output = ctxTime ?? this.ctx.currentTime + this.scheduleAhead;
    this.scheduleChange({ output, input: trackTime, rate, active: true });
  }

  /** Change rate while playing, keeping position continuous. */
  setRate(rate, atCtxTime) {
    const output = atCtxTime ?? this.ctx.currentTime + this.scheduleAhead;
    const input = this.timeline.trackTimeAt(output);
    if (input === null) return;
    this.scheduleChange({ output, input, rate, active: this.timeline.activeAt(output) });
  }

  pause() { this.pauseAt(this.ctx.currentTime); }

  /** Schedule a stop at a future AudioContext time. */
  pauseAt(ctxTime) {
    const input = this.timeline.trackTimeAt(ctxTime) ?? this.audio.currentTime;
    const rate = this.timeline.rateAt(ctxTime) || 1;
    this.scheduleChange({ output: ctxTime, input, rate, active: false });
  }

  /** Hold the element to its timeline from now until release(); [leader] is the deck to follow. */
  lock(leader = null) {
    this.leader = leader;
    this.locked = true;
    this.errors = [];
    this.ensureTimer();
  }

  /** Let the element run free again at the rate the timeline ends on. */
  release() {
    this.locked = false;
    this.leader = null;
    const rate = this.timeline.rateAt(this.ctx.currentTime) || this.unity;
    if (this.pending.length === 0) this.deck.setRate(rate / this.unity);
  }

  /** Drop everything scheduled: automation, pending changes, the servo. */
  cancel() {
    this.pending = [];
    this.locked = false;
    this.leader = null;
    this.timeline.clear();
    const now = this.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(1, now);
    this.eq.reset();
    this.resetSweep();
    this.deck.setRate(1);
  }

  /** Opens the filter mix's filters again. */
  resetSweep() {
    const now = this.ctx.currentTime;
    for (const [param, open] of [[this.sweep.highpass.frequency, 20], [this.sweep.lowpass.frequency, 20000]]) {
      param.cancelScheduledValues(now);
      param.setValueAtTime(open, now);
    }
  }

  /** The element has no scheduler: a change is applied the moment its time comes (less the start latency for a start). */
  scheduleChange(p) {
    this.timeline.add(p);
    this.pending = this.pending.filter((q) => q.output < p.output);
    this.pending.push(p);
    // The start more than a moment away: put the element there now, so the seek's fetch is done by the time it plays.
    const first = this.pending[0];
    if (first === p && p.active && this.audio.paused && p.output - this.ctx.currentTime > 0.5) {
      try { this.audio.currentTime = p.input; } catch {}
    }
    this.ensureTimer();
    this.dispatch();
  }

  ensureTimer() { this.dispatchTimer ??= setInterval(() => this.dispatch(), SERVO_MS); }

  dispatch() {
    const now = this.ctx.currentTime;
    while (this.pending.length > 0) {
      const next = this.pending[0];
      const lead = next.active && this.audio.paused ? this.latencySec : 0;
      if (next.output - lead > now) break;
      this.pending.shift();
      this.apply(next, now);
    }
    if (this.locked) this.servo(now);
    if (this.pending.length === 0 && !this.locked && this.dispatchTimer !== null) {
      clearInterval(this.dispatchTimer);
      this.dispatchTimer = null;
    }
  }

  apply(change, now) {
    const audio = this.audio;
    if (!change.active) {
      if (!audio.paused) audio.pause();
      return;
    }
    audio.playbackRate = change.rate;
    this.deck.baseRate = change.rate / this.unity;
    if (audio.paused) {
      const target = Math.max(0, change.input + Math.max(0, now + this.latencySec - change.output) * change.rate);
      if (Math.abs(audio.currentTime - target) > 0.02) try { audio.currentTime = target; } catch {}
      const asked = this.ctx.currentTime;
      const started = () => {
        // How long the element took to move: the next start leads by that much.
        const took = this.ctx.currentTime - asked;
        if (took > 0 && took < 1) this.latencySec = this.latencySec * 0.5 + took * 0.5;
      };
      audio.addEventListener('playing', started, { once: true });
      audio.play().catch(() => {});
    }
  }

  /** Stop following the outgoing deck (it has gone); the clock alone leads from here. */
  unfollow() { this.leader = null; }

  /** The AudioContext time this deck's element is actually at, per its timeline; null when it isn't playing to one. */
  actualCtxTime(now) {
    if (this.audio.paused || this.audio.seeking) return null;
    return this.timeline.ctxTimeAt(this.audio.currentTime, now - 10);
  }

  servo(now) {
    const audio = this.audio;
    // Following the outgoing deck: read this timeline where that element really is.
    const at = this.leader?.actualCtxTime(now) ?? now;
    const expected = this.timeline.trackTimeAt(at);
    const rate = this.timeline.rateAt(at);
    if (expected === null || !this.timeline.activeAt(at) || audio.paused || audio.seeking || now < this.seekingUntil) return;
    const error = audio.currentTime - expected;
    if (Math.abs(error) > SEEK_ERROR_SEC) {
      try { audio.currentTime = expected + this.latencySec * rate; } catch {}
      this.seekingUntil = now + 0.3;
      this.errors = [];
      return;
    }
    // currentTime moves in audio-callback steps; a short median keeps the nudge from chasing that jitter.
    this.errors.push(error);
    if (this.errors.length > 5) this.errors.shift();
    const smoothed = [...this.errors].sort((a, b) => a - b)[this.errors.length >> 1];
    // While the deck is still quiet (an incoming track's first bars) it may be pulled harder.
    const limit = this.gain.gain.value < 0.3 ? MAX_QUIET_NUDGE : MAX_NUDGE;
    const nudge = Math.abs(smoothed) < DEADBAND_SEC ? 0 : Math.max(-limit, Math.min(limit, -smoothed * SERVO_GAIN * (limit / MAX_NUDGE)));
    const want = rate * (1 + nudge);
    if (Math.abs(audio.playbackRate - want) > 0.0015) audio.playbackRate = want;
  }

  get isPlaying() { return !this.audio.paused; }
  /** Expected track position right now per the timeline (model truth). */
  get expectedTrackTime() { return this.timeline.trackTimeAt(this.ctx.currentTime); }

  setVolume(v) {
    try { this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02); } catch {}
  }
}
