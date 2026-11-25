// From AutoMix (https://github.com/heydavidf/automix), Copyright (C) 2026 David Finnegan.
// AGPL-3.0-only: see ../LICENSE and ../NOTICE.md. BitChord Desktop: ported to plain JavaScript.

/** DJ-mixer-style 3-band EQ: lowshelf 250 Hz, peaking 1 kHz, highshelf 4 kHz. */
export class ThreeBandEQ {
  constructor(ctx) {
    this.ctx = ctx;
    this.input = new BiquadFilterNode(ctx, { type: 'lowshelf', frequency: 250 });
    this.mid = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 1000, Q: 0.6 });
    this.output = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: 4000 });
    this.input.connect(this.mid).connect(this.output);
  }

  param(band) { return band === 'low' ? this.input.gain : band === 'mid' ? this.mid.gain : this.output.gain; }

  /** Scheduled hard set at a future time (transition automation). */
  setGainAt(band, dB, ctxTime) { this.param(band).setValueAtTime(dB, ctxTime); }

  /** Scheduled linear ramp with an explicit anchor, so ramps compose with other future-scheduled values. */
  rampGain(band, fromDb, toDb, startCtxTime, durationSec) {
    const p = this.param(band);
    p.setValueAtTime(fromDb, startCtxTime);
    p.linearRampToValueAtTime(toDb, startCtxTime + durationSec);
  }

  reset() {
    for (const band of ['low', 'mid', 'high']) {
      this.param(band).cancelScheduledValues(this.ctx.currentTime);
      this.param(band).setValueAtTime(0, this.ctx.currentTime);
    }
  }
}
