// Winamp-style MilkDrop visualizer for the cover and lyrics view (and full screen). The actual
// renderer (Butterchurn) lives in a sandboxed iframe (visualizer/visualizer.html): it's the only
// page allowed to eval, which the presets need. This side taps the audio after the equalizer,
// sends the samples to the iframe every frame and picks the presets.
import { state, saveSettings, toast } from './core.js';

const SIZE = 1024; // samples per channel Butterchurn works with
let engine = null, taps = null, frame = null, host = null, raf = 0, autoTimer = 0;
let names = [], current = '';
const listeners = new Set();
const buf = { t: new Uint8Array(SIZE), l: new Uint8Array(SIZE), r: new Uint8Array(SIZE) };

export const presetNames = () => names;
export const currentPreset = () => current;
export const isReady = () => !!names.length && !!frame;
/** Called when the preset list arrives or the preset changes (to refresh the presets panel). */
export const onVisChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const notify = () => listeners.forEach((fn) => fn());

function ensureTaps() {
  if (taps) return;
  const ctx = engine.ctx;
  const mk = () => { const a = ctx.createAnalyser(); a.fftSize = SIZE; a.smoothingTimeConstant = 0; return a; };
  const split = ctx.createChannelSplitter(2);
  taps = { m: mk(), l: mk(), r: mk() };
  engine.tap.connect(taps.m);
  engine.tap.connect(split);
  split.connect(taps.l, 0);
  split.connect(taps.r, 1);
}

function loop() {
  raf = requestAnimationFrame(loop);
  const win = frame?.contentWindow;
  if (!win || !names.length) return;
  taps.m.getByteTimeDomainData(buf.t);
  taps.l.getByteTimeDomainData(buf.l);
  taps.r.getByteTimeDomainData(buf.r);
  win.postMessage({ type: 'audio', t: buf.t, l: buf.l, r: buf.r }, '*');
}

function onMessage(e) {
  if (!frame || e.source !== frame.contentWindow) return;
  const m = e.data || {};
  if (m.type === 'ready' && Array.isArray(m.presets)) {
    names = m.presets.filter((s) => typeof s === 'string').sort((a, b) => a.localeCompare(b));
    document.body.dataset.vis = 'ready';
    const saved = state.settings.visPreset;
    setPreset(saved && names.includes(saved) && state.settings.visAuto === 'off' ? saved : randomName(), 0);
    scheduleAuto();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(loop);
    notify();
  } else if (m.type === 'error') {
    toast('No se pudo iniciar el visualizador: ' + String(m.message || '').slice(0, 160), true);
    unmountVisualizer();
  }
}

/** Creates the visualizer behind the cover and lyrics view (if it isn't there already). */
export function mountVisualizer(into, eng) {
  engine = eng;
  if (frame) return;
  ensureTaps();
  host = into;
  frame = document.createElement('iframe');
  frame.id = 'np-vis';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.src = `http://127.0.0.1:${state.port}/vis/visualizer.html`;
  frame.onload = () => frame?.contentWindow?.postMessage({ type: 'init', sampleRate: engine.ctx.sampleRate }, '*');
  window.addEventListener('message', onMessage);
  host.prepend(frame);
}

/** Removes it completely (frees the GPU while the view is closed or the visualizer is off). */
export function unmountVisualizer() {
  cancelAnimationFrame(raf); raf = 0;
  clearInterval(autoTimer); autoTimer = 0;
  window.removeEventListener('message', onMessage);
  frame?.remove();
  frame = null; names = []; current = '';
  delete document.body.dataset.vis;
  notify();
}

function randomName() {
  if (!names.length) return '';
  if (names.length === 1) return names[0];
  let n;
  do n = names[Math.floor(Math.random() * names.length)]; while (n === current);
  return n;
}

export function setPreset(name, blend = 2.7) {
  if (!frame || !names.includes(name)) return;
  current = name;
  frame.contentWindow?.postMessage({ type: 'preset', name, blend }, '*');
  notify();
}
export const randomPreset = () => setPreset(randomName());

/** Automatic preset changes: 'song' (on each new song), a number of seconds, or 'off'. */
export function scheduleAuto() {
  clearInterval(autoTimer); autoTimer = 0;
  const secs = Number(state.settings.visAuto);
  if (frame && secs > 0) autoTimer = setInterval(randomPreset, secs * 1000);
}
export function visOnTrackChange() {
  if (frame && names.length && (state.settings.visAuto || 'song') === 'song') randomPreset();
}
/** Picked by hand in the presets panel: remembered for when changes are off. */
export function pickPreset(name) {
  setPreset(name);
  saveSettings({ visPreset: name }).catch(() => {});
}
