// Adapted from AutoMix's src/lib/engine/autodj.ts (https://github.com/heydavidf/automix),
// Copyright (C) 2026 David Finnegan, as adapted by BitChord. AGPL-3.0-only: see ../LICENSE and ../NOTICE.md.
//
// BitChord: the queue decides what comes next, as on the phone, and only the playing and the next
// song are analysed. A track whose analysis isn't ready in time mixes through AutoMix's own
// fallback, a plain 12-second equal-power crossfade at its end. The handoff to the incoming track
// happens at the blend's midpoint, where the phone's CrossfadeController hands over.
// BitChord Desktop: ported to plain JavaScript; tracks are the player's track objects (keyed by id).
import { analyzer } from '../analysis/analyzer.js';
import { scheduleTransition, plannedBars, MIN_GRID_CONFIDENCE } from './transition-scheduler.js';
import { asOutgoing, gridOf, phraseAtOrBefore } from './grid.js';
import { IN_REGION_SEC, mixBeatPhaseAt, mixPositionAt, OUT_REGION_SEC, OUT_SEARCH_SEC, planLoopMix, scheduleLoopMix } from './loopMix.js';

const PRELOAD_WINDOW_SEC = 60;
/** BitChord: the loop mix is prepared (bars chosen, decks loaded) from this far before the end. */
const LOOP_PREPARE_SEC = OUT_SEARCH_SEC + 40;
/** BitChord: the outgoing loop starts at least this far ahead of the playhead when it's planned. */
const LOOP_SETUP_SEC = 15;
const SCHEDULE_WINDOW_SEC = 12;
const EMERGENCY_REMAINING_SEC = 10;

const log = (...a) => console.info('[automix]', ...a);
const STYLE_NAMES = { blend: 'mezcla a ritmo', filter: 'mezcla con filtros', crossfade: 'fundido', loop: 'mezcla con bucles' };

/**
 * The auto-mix loop: preload the queue's next track into the idle deck as the mix-out point
 * approaches, schedule the blend, flip decks, repeat. All timing decisions read the active deck's
 * timeline; the tick only decides, the Web Audio clock executes.
 *
 * host: { ctx, front(), back(), current(), next(), loadBack(track), handoff(), finished(),
 *         loopDecks(), sungSpans(track), hold(on) }
 */
export class AutoDJ {
  constructor(host, onUpdate = () => {}) {
    this.host = host;
    this.onUpdate = onUpdate;
    this.transitionBars = 16;
    this.state = 'idle';
    this.currentKey = null;
    this.nextKey = null;
    this.nextLoadedKey = null;
    this.plan = null;
    this.blend = null;
    /** The deck a finished blend left gliding back to its normal speed. */
    this.settling = null;
    this.timer = null;
    this.ticking = false;
    this.loadToken = 0;
    this.window = null;
    /** Both songs of the coming mix are analysed (the seek bar shows nothing until they are). */
    this.bothAnalyzed = false;
    this.loopPlan = null;
    this.loopPreparing = null;
    this.loopTimes = null;
    this.loopDecks = null;
    this.beatSec = null;
  }

  get snapshot() {
    return {
      state: this.state,
      currentKey: this.currentKey,
      nextKey: this.nextKey,
      plan: this.plan,
      window: this.window,
      startsInSec: this.plan ? this.plan.t0 - this.host.ctx.currentTime : null,
      beatSec: this.beatSec,
      loop: this.loopPlan,
    };
  }

  /** Where [id] is right now in its own seconds while a loop mix plays it from a deck; null otherwise. */
  mixPlayhead(id) {
    const plan = this.loopPlan, times = this.loopTimes;
    if (!plan || !times) return null;
    const side = id === plan.out.key ? 'out' : id === plan.in.key ? 'in' : null;
    return side ? mixPositionAt(plan, times, side, this.host.ctx.currentTime) : null;
  }

  /** The running mix's beat, 0 on the beat rising to 1 (null phase when the tempo isn't known); null between mixes. */
  mixBeat() {
    if (this.state !== 'scheduled' || !this.plan) return null;
    const now = this.host.ctx.currentTime;
    if (this.loopTimes) {
      const phase = mixBeatPhaseAt(this.loopTimes, now);
      return phase === null ? null : { phase };
    }
    const { t0, durationSec } = this.plan;
    if (now < t0 || now > t0 + durationSec) return null;
    if (!this.beatSec) return { phase: null };
    const x = (now - t0) / this.beatSec;
    return { phase: x - Math.floor(x) };
  }

  /** True while a loop mix runs: both elements are held paused and the decks carry the sound. */
  get loopMixing() { return this.state === 'scheduled' && this.loopTimes !== null; }
  /** True between scheduling a blend and its end: the back deck carries the next track. */
  get mixing() { return this.state === 'scheduled'; }

  start() {
    if (this.state === 'idle') this.state = 'playing';
    this.timer ??= setInterval(() => this.tick(), 1000);
    this.tick();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.cancel();
    this.state = 'idle';
    this.push();
  }

  /** Ask for the playing and next songs' analyses and re-plan now (a new song, a new next one). */
  poke() { if (this.state !== 'idle') this.tick(); }

  /**
   * The user took over (pause, seek, another track): drop the blend and the preloaded deck. The deck
   * in front plays on, at full volume and normal speed once the glide is gone.
   */
  cancel() {
    this.loadToken++;
    if (this.loopTimes && this.blend && this.loopDecks) {
      // Settle onto the song that's ahead in the mix, where its deck is now.
      const [outDeck, inDeck] = this.loopDecks;
      const onIncoming = this.blend.handedOff;
      const keep = onIncoming ? this.blend.to : this.blend.from;
      const drop = onIncoming ? this.blend.from : this.blend.to;
      const at = this.mixPlayhead((onIncoming ? this.loopPlan?.in.key : this.loopPlan?.out.key) ?? '')
        ?? (onIncoming ? this.loopTimes.elementTrackTime : this.loopPlan?.out.loop[0])
        ?? keep.audio.currentTime;
      outDeck.stop();
      inDeck.stop();
      drop.cancel();
      keep.cancel();
      try { keep.audio.currentTime = at; } catch {}
      keep.audio.play().catch(() => {});
      this.loopTimes = null;
      this.blend = null;
      this.host.hold(false);
    }
    this.loopPlan = null;
    this.loopPreparing = null;
    if (this.blend) { this.blend.from.cancel(); this.blend.to.cancel(); }
    this.settling?.cancel();
    this.settling = null;
    this.window = null;
    this.blend = null;
    this.plan = null;
    this.nextKey = null;
    this.nextLoadedKey = null;
    if (this.state === 'scheduled') this.state = 'playing';
    this.push();
  }

  /** The outgoing track ran out before the midpoint (a stalled stream): hand over now. */
  forceHandoff() {
    if (!this.blend || this.blend.handedOff) return false;
    this.blend.handedOff = true;
    this.host.handoff();
    return true;
  }

  currentAnalysis() { return this.currentKey ? analyzer.get(this.currentKey) : null; }

  async tick() {
    if (this.ticking || this.state === 'idle') return;
    this.ticking = true;
    try {
      const now = this.host.ctx.currentTime;

      if (this.state === 'scheduled' && this.plan && this.blend) {
        const handoffAt = this.loopTimes?.handoffAt ?? this.plan.t0 + this.plan.durationSec / 2;
        if (!this.blend.handedOff && now >= handoffAt) {
          this.blend.handedOff = true;
          this.host.handoff();
        }
        if (now > this.plan.t0 + this.plan.durationSec + 0.3) this.completeTransition();
        this.push();
        return;
      }

      const playing = this.host.current();
      const front = this.host.front();
      if (!playing || !front.isPlaying) { this.push(); return; }
      if (playing.id !== this.currentKey) {
        // A new track in front that this loop didn't mix in (a tap, a skip).
        this.currentKey = playing.id;
        this.nextKey = null;
        this.nextLoadedKey = null;
        this.window = null;
        this.loopPlan = null;
      }
      front.anchor();
      analyzer.request(playing, true);

      const queued = this.host.next();
      if (!queued) { this.nextKey = null; this.window = null; this.push(); return; }
      if (queued.id !== this.nextKey) {
        this.nextKey = queued.id;
        this.nextLoadedKey = null;
        this.loopPlan = null;
        this.loadToken++;
      }
      analyzer.request(queued, true);
      // and the playing track ahead of it, if it's still waiting: its mix-out comes first
      analyzer.request(playing, true);

      // As on the phone: only with both songs analysed is there a mix to plan. Until then nothing is
      // drawn on the seek bar, and if they aren't ready in time the song plays to its end and
      // crossfades there (a stub has no grid and no outro, so the fallback lands at the last 12 s).
      this.bothAnalyzed = this.currentAnalysis() !== null && analyzer.get(queued.id) !== null;
      const cur = asOutgoing(this.bothAnalyzed ? this.currentAnalysis() : stubAnalysis(playing, front.durationSec));
      if (this.bothAnalyzed && !this.loopPlan && this.trackRemaining() < LOOP_PREPARE_SEC) {
        this.prepareLoopMix(cur, analyzer.get(queued.id), playing, queued);
      }
      const remaining = this.timeToMixOut(cur);
      if (!this.bothAnalyzed) this.window = null;

      if (this.nextKey && this.nextLoadedKey !== this.nextKey && remaining < PRELOAD_WINDOW_SEC) {
        await this.loadNext(queued);
      }

      const ready = this.nextKey !== null && this.nextLoadedKey === this.nextKey;
      if (ready && remaining < SCHEDULE_WINDOW_SEC && this.loopPlan) await this.scheduleLoop(cur);
      else if (ready && remaining < SCHEDULE_WINDOW_SEC) this.scheduleBlend(cur, false);
      else if (ready && this.trackRemaining() < EMERGENCY_REMAINING_SEC) this.scheduleBlend(cur, true);
      this.push();
    } catch (e) {
      console.warn('[automix] tick', e);
    } finally {
      this.ticking = false;
    }
  }

  /** Output seconds until the natural blend start on the active deck. */
  timeToMixOut(cur) {
    const front = this.host.front();
    const now = this.host.ctx.currentTime;
    const pos = front.expectedTrackTime ?? 0;
    if (this.loopPlan && this.loopPlan.out.loop[0] > pos + 1) {
      // the loop mix starts where the outgoing loop does; that's the stretch the seek bar shows
      const [start, end] = this.loopPlan.out.loop;
      this.window = { id: cur.fileKey, startSec: start, endSec: end, style: 'loop' };
      this.beatSec = this.loopPlan.out.beatSec;
      const t0 = front.timeline.ctxTimeAt(start, now);
      return t0 === null ? 0 : Math.max(0, t0 - now);
    }
    if (this.loopPlan) this.loopPlan = null; // the playhead went past it
    const grid = gridOf(cur);
    if (!grid || cur.gridConfidence < MIN_GRID_CONFIDENCE) {
      const target = (cur.outroStartSec ?? cur.durationSec) - 12;
      this.window = { id: cur.fileKey, startSec: Math.max(0, target), endSec: Math.max(0, target) + 12, style: 'crossfade' };
      this.beatSec = null;
      return Math.max(0, target - pos);
    }
    const outRate = front.timeline.rateAt(now) || front.unity;
    const effBpm = grid.bpm * outRate;
    const next = this.nextKey ? analyzer.get(this.nextKey) : null;
    // the same length the scheduler will choose for this pair (a filter mix runs longer than a weak-grid blend)
    const bars = plannedBars(this.transitionBars, cur, next ?? null, outRate, front.unity);
    const blendOutputSec = bars * 4 * (60 / effBpm);
    const blendInputSec = blendOutputSec * outRate;
    let mixOut = phraseAtOrBefore(grid, (cur.outroStartSec ?? cur.durationSec) - blendInputSec);
    mixOut = Math.min(mixOut, phraseAtOrBefore(grid, cur.durationSec - blendInputSec - grid.barSec));
    this.window = { id: cur.fileKey, startSec: mixOut, endSec: mixOut + blendInputSec, style: 'blend' };
    this.beatSec = grid.beatSec / outRate;
    const t0 = front.timeline.ctxTimeAt(mixOut, now);
    return t0 === null ? 0 : Math.max(0, t0 - now);
  }

  trackRemaining() {
    const front = this.host.front();
    return front.durationSec - (front.expectedTrackTime ?? 0);
  }

  async loadNext(track) {
    const token = ++this.loadToken;
    const ok = await this.host.loadBack(track);
    if (token !== this.loadToken) return; // superseded by cancel() or a newer load
    if (ok) this.nextLoadedKey = track.id;
    else this.nextKey = null;
  }

  scheduleBlend(cur, forceNow) {
    const queued = this.host.next();
    if (!this.nextKey || queued?.id !== this.nextKey) return;
    const from = this.host.front();
    const to = this.host.back();
    const next = (this.bothAnalyzed ? analyzer.get(this.nextKey) : null) ?? stubAnalysis(queued, to.durationSec);
    // The outgoing deck runs free (only its scheduled stop applies); the incoming one follows it.
    to.lock(from);
    to.setVolume(1);
    to.eq.reset();
    this.plan = scheduleTransition({ from, to, fromAnalysis: cur, toAnalysis: next, bars: this.transitionBars, forceNow });
    this.blend = { from, to, handedOff: false };
    const outRate = from.timeline.rateAt(this.host.ctx.currentTime) || from.unity;
    this.window = this.bothAnalyzed
      ? { id: cur.fileKey, startSec: this.plan.mixOutTrackTime, endSec: this.plan.mixOutTrackTime + this.plan.durationSec * outRate, style: this.plan.style }
      : null;
    const grid = this.plan.style === 'crossfade' ? null : gridOf(cur);
    this.beatSec = grid ? grid.beatSec / outRate : null;
    this.state = 'scheduled';
    log(`${STYLE_NAMES[this.plan.style]} hacia «${queued.title}»: ${this.plan.bars ? `${this.plan.bars} compases, ` : ''}${this.plan.durationSec.toFixed(1)} s${this.plan.rate !== from.unity ? `, velocidad ×${(this.plan.rate / from.unity).toFixed(3)}` : ''}${this.plan.reason ? ` (${this.plan.reason})` : ''}`);
  }

  /**
   * BitChord: picks the bars to loop and loads both decks, in the background while the song plays.
   * Decodes each song once (from the bytes the analysis kept) and holds only the stretch each deck plays.
   */
  async prepareLoopMix(cur, next, curTrack, nextTrack) {
    const key = `${cur.fileKey}>${next.fileKey}`;
    if (this.loopPreparing === key) return;
    this.loopPreparing = key;
    const stillWanted = () => this.loopPreparing === key && this.currentKey === cur.fileKey && this.nextKey === next.fileKey;
    try {
      if (cur.gridConfidence < MIN_GRID_CONFIDENCE || next.gridConfidence < MIN_GRID_CONFIDENCE) return;
      // BitChord Desktop: the loop decks play at the songs' own tempo; at another speed, a blend instead.
      if (this.host.front().unity !== 1) return;
      this.loopDecks ??= await this.host.loopDecks();
      const [outBytes, inBytes, outSung, inSung] = await Promise.all([
        analyzer.audioBytes(curTrack),
        analyzer.audioBytes(nextTrack),
        this.host.sungSpans(curTrack).catch(() => null),
        this.host.sungSpans(nextTrack).catch(() => null),
      ]);
      // BitChord Desktop: decoded at 44.1 kHz, not at the output's rate (192 kHz on some cards: two whole
      // songs would take ~1 GB); the decks resample only the stretch they play (LoopDeck.load).
      const decode = (bytes) => new OfflineAudioContext({ numberOfChannels: 2, length: 1, sampleRate: 44100 }).decodeAudioData(bytes.slice(0));
      const [outBuffer, inBuffer] = await Promise.all([decode(outBytes), decode(inBytes)]);
      if (!stillWanted()) return;
      const pos = this.host.front().expectedTrackTime ?? 0;
      const plan = planLoopMix(cur, outBuffer, next, inBuffer, pos + LOOP_SETUP_SEC, { out: outSung, in: inSung });
      if (!plan) return;
      const [outDeck, inDeck] = this.loopDecks;
      await outDeck.load(cur.fileKey, outBuffer, Math.max(0, cur.durationSec - OUT_REGION_SEC), cur.durationSec);
      await inDeck.load(next.fileKey, inBuffer, 0, Math.min(next.durationSec, IN_REGION_SEC));
      if (!stillWanted()) return;
      this.loopPlan = plan;
    } catch (error) {
      console.warn('[automix] mezcla con bucles no preparada', String(error?.message || error));
    } finally {
      if (this.loopPreparing === key && !this.loopPlan) this.loopPreparing = null;
    }
  }

  /** BitChord: puts the loop mix on the clock: the outgoing element hands over at its loop start. */
  async scheduleLoop(cur) {
    const plan = this.loopPlan;
    const queued = this.host.next();
    if (!this.loopDecks || queued?.id !== plan.in.key || cur.fileKey !== plan.out.key) { this.loopPlan = null; return; }
    const from = this.host.front();
    const to = this.host.back();
    await from.anchorPrecise();
    const now = this.host.ctx.currentTime;
    const t0 = from.timeline.ctxTimeAt(plan.out.loop[0], now);
    if (t0 === null || t0 - now < 1) { this.loopPlan = null; return; }
    const [outDeck, inDeck] = this.loopDecks;
    const times = scheduleLoopMix(plan, outDeck, inDeck, t0);
    this.host.hold(true);

    // the outgoing element hands its sound to the deck at the loop start, then pauses
    const og = from.gain.gain;
    og.cancelScheduledValues(now);
    og.setValueAtTime(1, t0 - 0.025);
    og.linearRampToValueAtTime(0, t0);
    from.pauseAt(t0 + 0.06);
    // the incoming element starts unheard 1.5 s early, held to the deck's clock, and takes over
    const ig = to.gain.gain;
    ig.cancelScheduledValues(now);
    ig.setValueAtTime(0, now);
    ig.setValueAtTime(0, times.elementAt);
    ig.linearRampToValueAtTime(1, times.elementAt + 0.025);
    to.eq.reset();
    to.playAt({ ctxTime: times.elementAt - 1.5, trackTime: times.elementTrackTime - 1.5, rate: 1 });
    to.lock(null);

    this.loopTimes = times;
    this.plan = { t0, durationSec: times.elementAt - t0, mixInTrackTime: plan.in.loop[0], mixOutTrackTime: plan.out.loop[0], rate: plan.fold, fallback: false, style: 'loop', reason: null, bars: plan.totalBars };
    this.blend = { from, to, handedOff: false };
    this.window = { id: cur.fileKey, startSec: plan.out.loop[0], endSec: plan.out.loop[1], style: 'loop' };
    this.beatSec = plan.out.beatSec;
    this.state = 'scheduled';
    log(`mezcla con bucles hacia «${queued.title}»: bucle de ${plan.out.bars}+${plan.in.bars} compases, rampa de ${plan.rampBars} compases (${plan.out.bpm.toFixed(1)} → ${plan.in.bpm.toFixed(1)} BPM), voz comprobada por ${plan.out.checkedBy === 'lyrics' ? 'la letra' : 'la IA'}`);
  }

  completeTransition() {
    const blend = this.blend;
    if (blend && this.loopTimes && this.loopDecks) {
      for (const d of this.loopDecks) d.stop();
      this.loopTimes = null;
      this.host.hold(false);
    }
    this.loopPlan = null;
    this.loopPreparing = null;
    if (blend) {
      if (!blend.handedOff) this.host.handoff();
      blend.from.cancel();
      blend.to.unfollow();
      // the incoming deck keeps its rate glide (posted up to ~24 s ahead); it releases itself once that is played out
      this.settling = blend.to;
      releaseWhenSettled(blend.to, () => this.settling === blend.to);
      this.host.finished();
    }
    this.currentKey = this.nextKey;
    this.nextKey = null;
    this.nextLoadedKey = null;
    this.plan = null;
    this.blend = null;
    this.window = null;
    this.state = 'playing';
  }

  push() { this.onUpdate(this.snapshot); }
}

/** A track with no analysis yet: no grid, so the scheduler takes the plain-crossfade fallback. */
function stubAnalysis(t, durationSec) {
  return {
    fileKey: t.id, tags: { title: t.title || '' }, durationSec,
    bpm: null, beatIntervalSec: null, firstDownbeatSec: null, gridConfidence: 0,
    camelot: null, keyName: null, keyConfidence: 0, energy: 0.5, energyCurve: [],
    introEndSec: null, outroStartSec: null, analysisVersion: 0,
  };
}

/** The glide's last step lands at blend end + 24 s; hold the servo until no rate change is left ahead. */
function releaseWhenSettled(deck, isCurrent) {
  const check = () => {
    if (!isCurrent()) return;
    const now = deck.ctx.currentTime;
    if (Math.abs(deck.timeline.rateAt(now + 60) - deck.timeline.rateAt(now)) < 1e-6) deck.release();
    else setTimeout(check, 1000);
  };
  setTimeout(check, 1000);
}
