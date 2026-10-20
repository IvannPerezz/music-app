// The look of the synced lyrics (glow, letter wave, blur, glide…): one set of sliders, used both in
// the lyrics menu of the cover view (where the change is seen as it's dragged) and in Ajustes.
import { h, esc, state, saveSettings } from './core.js';
import { tr } from './i18n.js';
import * as lyricsView from './lyrics-view.js';

const pct = (v) => `${v} %`;
function groups() {
  return [
    { title: '', items: [
      ['lyricsFontSize', tr('Tamaño del texto'), '', 20, 48, 1, 30, (v) => `${v} px`],
      ['lyricsGlow', tr('Resplandor'), tr('La luz alrededor de la palabra que se canta'), 0, 200, 5, 200],
      ['lyricsWave', tr('Onda de letras'), tr('Palabras sostenidas, letra a letra'), 0, 200, 5, 100],
      ['lyricsBlur', tr('Desenfoque'), tr('Líneas más lejos de la que se canta'), 0, 200, 5, 100],
      ['lyricsSmooth', tr('Suavidad'), tr('Lo despacio que se deslizan las líneas'), 50, 250, 5, 150],
    ] },
    { title: tr('Ajuste fino'), items: [
      ['lyricsGlowSpread', tr('Extensión del resplandor'), '', 0, 200, 5, 100],
      ['lyricsFillSoft', tr('Suavidad del relleno'), tr('El borde del color que recorre cada palabra'), 0, 200, 5, 100],
      ['lyricsLift', tr('Elevación de palabras'), tr('Cuánto sube la palabra cantada'), 0, 200, 5, 100],
      ['lyricsUnsung', tr('Brillo de lo no cantado'), '', 10, 70, 1, 30],
      ['lyricsOtherSize', tr('Tamaño de las otras líneas'), '', 85, 100, 1, 97],
      ['lyricsDistFade', tr('Atenuar con la distancia'), '', 0, 100, 5, 0],
      ['lyricsCascade', tr('Cascada'), tr('Las líneas de abajo siguen un instante después'), 0, 200, 5, 100],
      ['lyricsSpacing', tr('Interlineado'), '', 50, 200, 5, 100],
    ] },
    { title: tr('Voces de fondo'), items: [
      ['lyricsBgSize', tr('Tamaño'), '', 40, 100, 1, 62],
      ['lyricsBgBright', tr('Brillo'), '', 20, 100, 1, 80],
    ] },
    { title: tr('Sincronización'), items: [
      ['lyricsOffsetMs', tr('Desfase'), tr('Positivo si la letra va por detrás de la voz'), -2000, 2000, 50, 0, (v) => `${v > 0 ? '+' : ''}${(v / 1000).toFixed(2)} s`],
    ] },
  ];
}
export const LYRICS_LOOK = ['lyricsFontSize', 'lyricsGlow', 'lyricsWave', 'lyricsBlur', 'lyricsSmooth', 'lyricsGlowSpread', 'lyricsFillSoft', 'lyricsLift',
  'lyricsUnsung', 'lyricsOtherSize', 'lyricsDistFade', 'lyricsCascade', 'lyricsSpacing', 'lyricsBgSize', 'lyricsBgBright', 'lyricsOffsetMs'];

/** The sliders; each change shows at once in the lyrics and is saved when let go. */
export function lyricsLookControls({ compact = false } = {}) {
  const root = h(`<div class="lyr-look${compact ? ' compact' : ''}"></div>`);
  for (const g of groups()) {
    if (g.title) root.append(h(`<div class="lyr-look-h">${esc(g.title)}</div>`));
    const box = h('<div class="lyr-look-g"></div>');
    for (const [k, label, desc, min, max, step, def, show = pct] of g.items) {
      const cur = typeof state.settings[k] === 'number' ? state.settings[k] : def;
      const row = h(`<label class="lyr-look-r">
        <span class="lyr-look-t"><b>${esc(label)}</b><i>${esc(show(cur))}</i></span>
        ${desc ? `<small>${esc(desc)}</small>` : ''}
        <input type="range" min="${min}" max="${max}" step="${step}" value="${cur}">
      </label>`);
      const input = row.querySelector('input'), out = row.querySelector('i');
      input.oninput = () => {
        out.textContent = show(+input.value);
        state.settings = { ...state.settings, [k]: +input.value };
        lyricsView.style(state.settings);
      };
      input.onchange = () => saveSettings({ [k]: +input.value });
      // Double click: back to the default value.
      row.querySelector('.lyr-look-t').ondblclick = (e) => { e.preventDefault(); input.value = def; input.oninput(); input.onchange(); };
      box.append(row);
    }
    root.append(box);
  }
  return root;
}
