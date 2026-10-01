// Small HSV colour picker: saturation/value square, hue bar and alpha bar (+ hex field).
import { h } from './core.js';

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

export function hsvToRgb(hh, s, v) {
  const f = (n) => { const k = (n + hh * 6) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5), f(3), f(1)].map((x) => Math.round(x * 255));
}
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let hh = 0;
  if (d) hh = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [((hh / 6) + 1) % 1, max ? d / max : 0, max];
}
export function parseColor(str) {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(str || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: n >> 16 & 255, g: n >> 8 & 255, b: n & 255, a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
}
const hex2 = (n) => n.toString(16).padStart(2, '0');
export const toHex = ({ r, g, b, a = 1 }) => `#${hex2(r)}${hex2(g)}${hex2(b)}${a < 1 ? hex2(Math.round(a * 255)) : ''}`;

/** onChange(hex, {r,g,b,a}) fires while dragging; onCommit(hex) when the pointer is released. */
export function colorPicker(initial, { onChange = () => {}, onCommit = () => {} } = {}) {
  const c0 = parseColor(initial) || { r: 250, g: 45, b: 72, a: 1 };
  let [hh, s, v] = rgbToHsv(c0.r, c0.g, c0.b);
  let a = c0.a;
  const el = h(`<div class="cpick">
    <div class="cp-sv"><div class="cp-knob"></div></div>
    <div class="cp-bar cp-hue"><div class="cp-handle"></div></div>
    <div class="cp-bar cp-alpha"><div class="cp-alpha-fill"></div><div class="cp-handle"></div></div>
    <div class="cp-foot"><span class="cp-swatch"></span><input class="text cp-hex" spellcheck="false" maxlength="9"></div>
  </div>`);
  const sv = el.querySelector('.cp-sv'), knob = el.querySelector('.cp-knob');
  const hue = el.querySelector('.cp-hue'), alpha = el.querySelector('.cp-alpha');
  const hex = el.querySelector('.cp-hex'), sw = el.querySelector('.cp-swatch');
  const current = () => { const [r, g, b] = hsvToRgb(hh, s, v); return { r, g, b, a: Math.round(a * 100) / 100 }; };
  const paint = (fromInput = false) => {
    const col = current();
    const [hr, hg, hb] = hsvToRgb(hh, 1, 1);
    sv.style.backgroundColor = `rgb(${hr},${hg},${hb})`;
    knob.style.left = `${s * 100}%`; knob.style.top = `${(1 - v) * 100}%`;
    knob.style.backgroundColor = `rgb(${col.r},${col.g},${col.b})`;
    hue.querySelector('.cp-handle').style.left = `${hh * 100}%`;
    hue.querySelector('.cp-handle').style.backgroundColor = `rgb(${hr},${hg},${hb})`;
    alpha.querySelector('.cp-alpha-fill').style.background = `linear-gradient(90deg, rgba(${col.r},${col.g},${col.b},0), rgb(${col.r},${col.g},${col.b}))`;
    alpha.querySelector('.cp-handle').style.left = `${a * 100}%`;
    alpha.querySelector('.cp-handle').style.backgroundColor = `rgba(${col.r},${col.g},${col.b},${a})`;
    sw.style.background = `rgba(${col.r},${col.g},${col.b},${a})`;
    if (!fromInput) hex.value = toHex(col);
  };
  const drag = (area, fn) => {
    area.addEventListener('pointerdown', (e) => {
      area.setPointerCapture(e.pointerId);
      const move = (ev) => { const r = area.getBoundingClientRect(); fn(clamp((ev.clientX - r.left) / r.width), clamp((ev.clientY - r.top) / r.height)); paint(); onChange(toHex(current()), current()); };
      const up = () => { area.removeEventListener('pointermove', move); area.removeEventListener('pointerup', up); onCommit(toHex(current())); };
      area.addEventListener('pointermove', move); area.addEventListener('pointerup', up);
      move(e);
    });
  };
  drag(sv, (x, y) => { s = x; v = 1 - y; });
  drag(hue, (x) => { hh = Math.min(x, 0.9999); });
  drag(alpha, (x) => { a = x; });
  hex.addEventListener('input', () => {
    const p = parseColor(hex.value);
    if (!p) return;
    [hh, s, v] = rgbToHsv(p.r, p.g, p.b); a = p.a;
    paint(true); onChange(toHex(current()), current());
  });
  hex.addEventListener('change', () => { paint(); onCommit(toHex(current())); });
  hex.addEventListener('keydown', (e) => e.stopPropagation());
  paint();
  return el;
}
