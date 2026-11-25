// From AutoMix (https://github.com/heydavidf/automix), Copyright (C) 2026 David Finnegan.
// AGPL-3.0-only: see ../LICENSE and ../NOTICE.md. BitChord Desktop: ported to plain JavaScript.

/**
 * Mirror of the changes scheduled on a deck ({ output: AudioContext time, input: track time, rate,
 * active }), so we can convert trackTime <-> AudioContext time exactly. Adding a point removes any
 * scheduled points at or after its output time.
 */
export class Timeline {
  constructor() { this.points = []; }

  add(p) {
    this.points = this.points.filter((q) => q.output < p.output);
    this.points.push(p);
  }

  clear() { this.points = []; }
  get isEmpty() { return this.points.length === 0; }

  segmentAt(ctxTime) {
    let seg = null;
    for (const p of this.points) {
      if (p.output <= ctxTime) seg = p;
      else break;
    }
    return seg;
  }

  trackTimeAt(ctxTime) {
    const seg = this.segmentAt(ctxTime);
    if (!seg) return null;
    if (!seg.active) return seg.input;
    return seg.input + (ctxTime - seg.output) * seg.rate;
  }

  rateAt(ctxTime) {
    const seg = this.segmentAt(ctxTime);
    return seg && seg.active ? seg.rate : 0;
  }

  activeAt(ctxTime) { return this.segmentAt(ctxTime)?.active ?? false; }

  /** AudioContext time at which the given track time will play, searching forward from fromCtxTime. */
  ctxTimeAt(trackTime, fromCtxTime = -Infinity) {
    for (let i = 0; i < this.points.length; i++) {
      const p = this.points[i];
      if (!p.active || p.rate <= 0) continue;
      const next = this.points[i + 1];
      const segEnd = next ? next.output : Infinity;
      const t = p.output + (trackTime - p.input) / p.rate;
      if (t >= Math.max(p.output, fromCtxTime) && t < segEnd) return t;
    }
    return null;
  }
}
