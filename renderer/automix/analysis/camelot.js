// From AutoMix (https://github.com/heydavidf/automix), Copyright (C) 2026 David Finnegan.
// AGPL-3.0-only: see ../LICENSE and ../NOTICE.md. BitChord Desktop: ported to plain JavaScript
// (only what the analysis uses).

const MAJOR = { C: 8, G: 9, D: 10, A: 11, E: 12, B: 1, 'F#': 2, Gb: 2, 'C#': 3, Db: 3, 'G#': 4, Ab: 4, 'D#': 5, Eb: 5, 'A#': 6, Bb: 6, F: 7 };
const MINOR = { A: 8, E: 9, B: 10, 'F#': 11, Gb: 11, 'C#': 12, Db: 12, 'G#': 1, Ab: 1, 'D#': 2, Eb: 2, 'A#': 3, Bb: 3, F: 4, C: 5, G: 6, D: 7 };

export function toCamelot(key, scale) {
  const num = (scale === 'major' ? MAJOR : MINOR)[key];
  return num === undefined ? null : { num, letter: scale === 'major' ? 'B' : 'A' };
}

export const formatCamelot = (c) => (c ? `${c.num}${c.letter}` : '—');
