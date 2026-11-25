// Adapted from AutoMix's src/lib/engine/deck.ts (https://github.com/heydavidf/automix),
// Copyright (C) 2026 David Finnegan, as adapted by BitChord. AGPL-3.0-only: see ../LICENSE and ../NOTICE.md.
//
// AutoMix's own deck (signalsmith-stretch over decoded audio), used for the loop mix only. It plays
// a decoded region of a track, so it can loop whole bars sample-accurately and change tempo with
// the pitch kept, over any ratio, which an <audio> element can't.
// BitChord Desktop: ported to plain JavaScript; signalsmith-stretch (MIT) is in ../vendor.
import SignalsmithStretch from '../vendor/SignalsmithStretch.mjs';
import { ThreeBandEQ } from './eq.js';

/**
 * The worklet keeps only one pending future change (each schedule() prunes everything after "now"),
 * so changes wait here and go out just before their time. Beats are at least 0.33 s apart at 180 BPM.
 */
const POST_AHEAD_SEC = 0.25;
const DISPATCH_MS = 20;

/** [channels] from [fromRate] to [toRate], with the browser's own resampler. */
async function resample(channels, fromRate, toRate) {
  const src = new AudioBuffer({ numberOfChannels: channels.length, length: channels[0].length, sampleRate: fromRate });
  channels.forEach((c, i) => src.copyToChannel(c, i));
  const off = new OfflineAudioContext({ numberOfChannels: channels.length, length: Math.ceil((channels[0].length * toRate) / fromRate), sampleRate: toRate });
  const node = new AudioBufferSourceNode(off, { buffer: src });
  node.connect(off.destination);
  node.start();
  const out = await off.startRendering();
  return channels.map((_, i) => out.getChannelData(i));
}

export class LoopDeck {
  constructor(ctx, stretch, destination) {
    this.ctx = ctx;
    this.stretch = stretch;
    this.eq = new ThreeBandEQ(ctx);
    this.sweep = {
      highpass: new BiquadFilterNode(ctx, { type: 'highpass', frequency: 20, Q: 0.7 }),
      lowpass: new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 20000, Q: 0.7 }),
    };
    this.gain = new GainNode(ctx, { gain: 0 });
    /** Track seconds the loaded region starts at. */
    this.regionStart = 0;
    this.regionEnd = 0;
    this.loadedKey = null;
    this.latencySec = 0.12;
    this.pending = [];
    this.timer = null;
    stretch.connect(this.eq.input);
    // keeps inputTime current (the default leaves it stale)
    stretch.setUpdateInterval(0.05);
    this.eq.output.connect(this.sweep.highpass).connect(this.sweep.lowpass).connect(this.gain).connect(destination);
  }

  static async create(ctx, destination) {
    // NB (AutoMix): default node options only; numberOfInputs: 0 silently kills the processor.
    const stretch = await SignalsmithStretch(ctx);
    const deck = new LoopDeck(ctx, stretch, destination);
    deck.latencySec = await stretch.latency();
    return deck;
  }

  /** Loads [startSec, endSec) of a decoded track (resampled to the output's rate: the worklet plays samples as they are). */
  async load(key, buffer, startSec, endSec) {
    this.stop();
    await this.stretch.dropBuffers();
    const from = Math.max(0, Math.floor(startSec * buffer.sampleRate));
    const to = Math.min(buffer.length, Math.ceil(endSec * buffer.sampleRate));
    let channels = [];
    for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) channels.push(buffer.getChannelData(c).slice(from, to));
    if (channels.length === 1) channels.push(channels[0].slice());
    if (buffer.sampleRate !== this.ctx.sampleRate) channels = await resample(channels, buffer.sampleRate, this.ctx.sampleRate);
    await this.stretch.addBuffers(channels);
    this.regionStart = from / buffer.sampleRate;
    this.regionEnd = to / buffer.sampleRate;
    this.loadedKey = key;
  }

  /** Queues changes ({ output, input, rate, active, loop: [start, end] | null }, track seconds); each is posted just before it's due. */
  schedule(changes) {
    this.pending.push(...changes);
    this.pending.sort((a, b) => a.output - b.output);
    this.timer ??= setInterval(() => this.dispatch(), DISPATCH_MS);
    this.dispatch();
  }

  dispatch() {
    const now = this.ctx.currentTime;
    while (this.pending.length && this.pending[0].output - now < POST_AHEAD_SEC) {
      const c = this.pending.shift();
      const r = this.regionStart;
      this.stretch.schedule({
        output: c.output,
        input: c.input - r,
        rate: c.rate,
        active: c.active,
        loopStart: c.loop ? c.loop[0] - r : 0,
        loopEnd: c.loop ? c.loop[1] - r : 0,
      });
    }
    if (!this.pending.length && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Stops now and forgets everything queued; filters, EQ and gain back to rest. */
  stop() {
    this.pending = [];
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.stretch.schedule({ active: false });
    const now = this.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(0, now);
    this.eq.reset();
    for (const [param, open] of [[this.sweep.highpass.frequency, 20], [this.sweep.lowpass.frequency, 20000]]) {
      param.cancelScheduledValues(now);
      param.setValueAtTime(open, now);
    }
  }

  /** Track seconds the worklet reports it's at (~50 ms granularity). */
  get inputTime() { return this.stretch.inputTime + this.regionStart; }
}
