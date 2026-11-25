# Automix

This folder is BitChord's Automix (https://github.com/kushagrasinghx/BitChord,
`web/app/src/playback/automix`), ported from TypeScript to plain JavaScript for
BitChord Desktop. BitChord's Automix is itself ported from **AutoMix**
(https://github.com/heydavidf/automix), Copyright (C) 2026 David Finnegan,
licensed under the GNU Affero General Public License v3.0 (`./LICENSE`).
BitChord Desktop is GPL-3.0; GPLv3 §13 permits combining it with AGPLv3 code,
and the files here stay under the AGPL. The source is public
(https://github.com/IvannPerezz/music-app).

`analysis/models.js` is BitChord's port of the phone's Beat This! and
open-unmix front ends, themselves ported from **Orchard**
(https://github.com/SFG5453/Orchard), Copyright (C) 2026 SFG545 and
Kushagra Singh, AGPL-3.0-or-later.

## Third-party parts

| What | Where | Licence |
| --- | --- | --- |
| essentia.js 0.1.3 (Music Technology Group, Universitat Pompeu Fabra) | `vendor/essentia-wasm.es.js`, `vendor/essentia.js-core.es.js` | AGPL-3.0 |
| ONNX Runtime Web 1.30.0 (Microsoft) | `vendor/ort.wasm.min.mjs`, `vendor/ort-wasm-simd-threaded.mjs`, `assets/automix/ort-wasm-simd-threaded.wasm` | MIT |
| signalsmith-stretch 1.3.2 (Signalsmith Audio) | `vendor/SignalsmithStretch.mjs` | MIT |
| Beat This! final0 weights (CPJKU), int8 export by BitChord | `assets/automix/beat_this_final0_q8.onnx` | MIT |
| open-unmix umxhq vocals weights (Sony / Inria), int8 | `assets/automix/vocals_umxhq_int8.onnx` | MIT |

## What BitChord Desktop changed

- Plain JavaScript modules, no bundler: the vendor files are the packages'
  own ES builds.
- The analysis worker runs from `file://`, which `fetch()` can't read, so the
  models and the runtime's `.wasm` are served by the app's local proxy at
  `/automix/` (`src/automix-files.js`).
- The audio is the player's own stream through the local proxy; analyses are
  cached in IndexedDB by track id.
- `engine/deck.js` wraps a deck of `renderer/engine.js` (its `<audio>`
  element, EQ, filters and gain); rates are absolute, so a song's normal speed
  is the player's speed setting.
- `engine/autodj.js` takes the queue's next song from the engine (`setNext`),
  hands the player over to it at the mix's midpoint and reports the mix's
  stretch of the playing song for the seek bar.
- The loop mix needs the songs at their own speed: with another playback
  speed, a blend is made instead.
