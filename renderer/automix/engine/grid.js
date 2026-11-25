// From AutoMix (https://github.com/heydavidf/automix), Copyright (C) 2026 David Finnegan, as adapted
// by BitChord. AGPL-3.0-only: see ../LICENSE and ../NOTICE.md. BitChord Desktop: ported to plain JavaScript.

export const BEATS_PER_BAR = 4;
export const BEATS_PER_PHRASE = 32; // 8 bars

export function gridOf(a) {
  if (!a.bpm || !a.beatIntervalSec || a.firstDownbeatSec === null || a.firstDownbeatSec === undefined) return null;
  const beatSec = a.beatIntervalSec;
  return {
    beatSec,
    barSec: beatSec * BEATS_PER_BAR,
    phraseSec: beatSec * BEATS_PER_PHRASE,
    downbeatSec: a.firstDownbeatSec,
    bpm: a.bpm,
  };
}

/**
 * BitChord: the analysis as the outgoing side of a blend sees it, its grid fields swapped for the
 * tail grid (fitted to the song's last two minutes, where it is mixed out).
 */
export function asOutgoing(a) {
  if (a.tailGrid === undefined) return a;
  const t = a.tailGrid;
  return t
    ? { ...a, bpm: t.bpm, beatIntervalSec: t.beatIntervalSec, firstDownbeatSec: t.firstDownbeatSec, gridConfidence: t.gridConfidence }
    : { ...a, beatIntervalSec: null, firstDownbeatSec: null, gridConfidence: 0 };
}

export const phraseAtOrBefore = (g, t) => g.downbeatSec + Math.floor((t - g.downbeatSec) / g.phraseSec) * g.phraseSec;
export const phraseAtOrAfter = (g, t) => g.downbeatSec + Math.ceil((t - g.downbeatSec) / g.phraseSec) * g.phraseSec;
export const downbeatAtOrBefore = (g, t) => g.downbeatSec + Math.floor((t - g.downbeatSec) / g.barSec) * g.barSec;
export const downbeatAtOrAfter = (g, t) => g.downbeatSec + Math.ceil((t - g.downbeatSec) / g.barSec) * g.barSec;
