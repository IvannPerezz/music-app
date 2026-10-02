// Equalizer controls shared by Ajustes → Ecualizador and the pop-over in the player bar.
// Both write to the same settings, and every instance re-syncs when any of them changes.
import { esc, h, state, saveSettings } from './core.js';
import { EQ_FREQS, EQ_PRESETS } from './engine.js';
import { tr } from './i18n.js';

const EQ_KEYS = ['eqEnabled', 'eqBands', 'eqPreset', 'preamp'];
const db = (v) => `${v > 0 ? '+' : ''}${v}`;

export function eqPanel({ compact = false } = {}) {
  const root = h(`<div class="eq-panel${compact ? ' compact' : ''}">
    <div class="eq-top">
      <label class="eq-switch"><span>${tr('Ecualizador')}</span><label class="switch"><input type="checkbox" data-k="on"><span></span></label></label>
      <select class="select" data-k="preset">${Object.entries(EQ_PRESETS).map(([k, p]) => `<option value="${k}">${esc(tr(p.label))}</option>`).join('')}<option value="custom">${tr('Personalizado')}</option></select>
    </div>
    <div class="eq-pre"><span>${tr('Preamplificación')}</span><input type="range" min="-12" max="6" step="1" data-k="preamp"><span class="range-val" data-k="preval"></span></div>
    <div class="eq"></div>
  </div>`);
  const sw = root.querySelector('[data-k=on]');
  const preset = root.querySelector('[data-k=preset]');
  const pre = root.querySelector('[data-k=preamp]');
  const preVal = root.querySelector('[data-k=preval]');
  const box = root.querySelector('.eq');
  let bands = [];
  const inputs = EQ_FREQS.map((f, i) => {
    const col = h(`<div class="eq-band"><span class="eq-db"></span><input type="range" min="-12" max="12" step="1"><span class="eq-f">${f >= 1000 ? f / 1000 + 'k' : f}</span></div>`);
    const input = col.querySelector('input');
    input.oninput = () => {
      bands[i] = +input.value;
      col.querySelector('.eq-db').textContent = db(bands[i]);
      preset.value = 'custom';
    };
    input.onchange = () => saveSettings({ eqBands: [...bands], eqPreset: 'custom', eqEnabled: true });
    box.append(col);
    return { input, label: col.querySelector('.eq-db') };
  });

  const sync = () => {
    const s = state.settings;
    bands = [...(s.eqBands || new Array(10).fill(0))];
    sw.checked = !!s.eqEnabled;
    preset.value = s.eqPreset && (EQ_PRESETS[s.eqPreset] || s.eqPreset === 'custom') ? s.eqPreset : 'custom';
    pre.value = s.preamp || 0;
    preVal.textContent = `${db(s.preamp || 0)} dB`;
    inputs.forEach(({ input, label }, i) => { input.value = bands[i] || 0; label.textContent = db(bands[i] || 0); });
    root.classList.toggle('off', !s.eqEnabled);
  };

  sw.onchange = () => saveSettings({ eqEnabled: sw.checked });
  preset.onchange = () => { if (preset.value !== 'custom') saveSettings({ eqPreset: preset.value, eqBands: [...EQ_PRESETS[preset.value].bands], eqEnabled: true }); };
  pre.oninput = () => { preVal.textContent = `${db(+pre.value)} dB`; };
  pre.onchange = () => saveSettings({ preamp: +pre.value });

  const onSettings = (e) => {
    if (!root.isConnected) { document.removeEventListener('settings', onSettings); return; }
    if (Object.keys(e.detail).some((k) => EQ_KEYS.includes(k))) sync();
  };
  document.addEventListener('settings', onSettings);
  sync();
  return root;
}
