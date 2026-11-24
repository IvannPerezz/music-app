// Smooth scrolling with the mouse wheel, everywhere in the app (Ajustes → Apariencia → Interfaz →
// "Desplazamiento suave"). Each notch of the wheel moves a target; the list glides towards it and
// eases out, and notches in a row add up, so a fast spin travels far and still stops softly.
// Touchpads already scroll smoothly by themselves (many small steps), so they are left alone, and
// so is anything that handles the wheel itself (volume, lyrics, sliders…: it calls preventDefault).
import { state } from './core.js';

const EASE_MS = 95;       // how quickly the list catches up with the wheel (lower = snappier)
const STEP = 1;           // travel per notch: the same as the browser's own

const lists = new WeakMap(); // element → { target, raf, last, set }

function scroller(from, dy) {
  for (let el = from; el && el !== document.documentElement; el = el.parentElement) {
    if (el.nodeType !== 1) continue;
    const oy = getComputedStyle(el).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1) {
      const max = el.scrollHeight - el.clientHeight;
      const s = lists.get(el);
      const at = s?.raf ? s.target : el.scrollTop;
      if ((dy < 0 && at > 0.5) || (dy > 0 && at < max - 0.5)) return el;
    }
  }
  return null;
}

function glide(el, dy) {
  let s = lists.get(el);
  if (!s) { s = { target: el.scrollTop, raf: 0, last: 0, set: el.scrollTop }; lists.set(el, s); }
  // Moved some other way since (scrollbar, keyboard, code): start from where it really is.
  if (!s.raf || Math.abs(el.scrollTop - s.set) > 2) s.target = el.scrollTop;
  const max = el.scrollHeight - el.clientHeight;
  s.target = Math.max(0, Math.min(max, s.target + dy));
  if (s.raf) return;
  s.last = 0;
  const frame = (now) => {
    if (Math.abs(el.scrollTop - s.set) > 2 && s.last) { s.raf = 0; return; } // taken over meanwhile
    const dt = s.last ? Math.min(64, now - s.last) : 16.7;
    s.last = now;
    const cur = s.set = s.set + (s.target - s.set) * (1 - Math.exp(-dt / EASE_MS));
    const done = Math.abs(s.target - cur) < 0.5;
    if (done) s.set = s.target;
    el.scrollTo({ top: s.set, behavior: 'instant' });
    s.raf = done ? 0 : requestAnimationFrame(frame);
  };
  s.set = el.scrollTop;
  s.raf = requestAnimationFrame(frame);
}

// (Bubbling phase: anything with its own wheel handling has already had its say.)
window.addEventListener('wheel', (e) => {
  if (e.defaultPrevented || e.ctrlKey || e.shiftKey || state.settings?.smoothScroll === false) return;
  if (!e.deltaY || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
  const lines = e.deltaMode === 1, pages = e.deltaMode === 2;
  if (!lines && !pages && Math.abs(e.deltaY) < 50) return; // a touchpad: already smooth
  const t = e.target;
  if (t.closest?.('input, textarea, select, [contenteditable="true"], iframe, canvas')) return;
  const dy = (lines ? e.deltaY * 40 : pages ? e.deltaY * window.innerHeight : e.deltaY) * STEP;
  const el = scroller(t, dy);
  if (!el) return;
  e.preventDefault();
  glide(el, dy);
}, { passive: false });
