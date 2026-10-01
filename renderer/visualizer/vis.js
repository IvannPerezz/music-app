// MilkDrop visualizer (Butterchurn) inside a sandboxed iframe. The app sends it the audio
// samples every frame and which preset to show; it only answers with the preset names.
//   parent → { type: 'init', sampleRate } | { type: 'audio', t, l, r } | { type: 'preset', name, blend }
//   iframe → { type: 'ready', presets: [names] } | { type: 'error', message }
const lib = (g) => (g && g.default) || g;
const canvas = document.getElementById('c');
let viz = null, levels = null, presets = {};

function size() {
  // Capped pixel ratio: a full-screen MilkDrop at 2x would cost the GPU four times as much.
  const r = Math.min(window.devicePixelRatio || 1, 1.25);
  const w = Math.max(1, Math.round(innerWidth * r)), h = Math.max(1, Math.round(innerHeight * r));
  canvas.width = w; canvas.height = h;
  if (viz) viz.setRendererSize(w, h);
}

function init(sampleRate) {
  try {
    presets = { ...lib(window.butterchurnPresets).getPresets(), ...lib(window.butterchurnPresetsExtra).getPresets() };
    size();
    // The audio arrives already sampled from the app; this context only provides the sample rate.
    const ac = new OfflineAudioContext(2, 128, sampleRate || 44100);
    viz = lib(window.butterchurn).createVisualizer(ac, canvas, { width: canvas.width, height: canvas.height, pixelRatio: 1, textureRatio: 1 });
    const images = lib(window.butterchurnExtraImages);
    if (images && images.getImages) viz.loadExtraImages(images.getImages());
    parent.postMessage({ type: 'ready', presets: Object.keys(presets) }, '*');
    requestAnimationFrame(loop);
  } catch (err) {
    parent.postMessage({ type: 'error', message: String((err && err.message) || err) }, '*');
  }
}

function loop() {
  requestAnimationFrame(loop);
  try { viz.render(levels ? { audioLevels: levels } : undefined); } catch {}
}

addEventListener('message', (e) => {
  if (e.source !== parent) return;
  const m = e.data || {};
  if (m.type === 'init' && !viz) init(m.sampleRate);
  else if (m.type === 'audio') levels = { timeByteArray: m.t, timeByteArrayL: m.l, timeByteArrayR: m.r };
  else if (m.type === 'preset' && viz && presets[m.name]) {
    try { viz.loadPreset(presets[m.name], Number(m.blend) || 0); } catch {}
  }
});
addEventListener('resize', size);
