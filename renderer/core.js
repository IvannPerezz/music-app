// Shared renderer helpers.
export const bc = window.bc;
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export { icon } from './icons.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmt = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
};
export const artistNames = (t) => (t?.artists || []).map((a) => a.name).filter(Boolean).join(', ');

export const store = {
  get(k, d) { try { const v = localStorage.getItem('bc.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('bc.' + k, JSON.stringify(v)); } catch {} },
};

export async function api(name, ...args) {
  const r = await bc[name](...args);
  if (!r || !r.ok) throw new Error(r?.error || 'Error desconocido');
  return r.data;
}

let toastTimer, toastOutTimer;
/** Notice at the bottom: zooms in, and zooms out again before disappearing. */
export function toast(msg, error = false) {
  const t = $('#toast');
  clearTimeout(toastTimer); clearTimeout(toastOutTimer);
  t.textContent = msg;
  t.className = error ? 'error' : '';
  t.hidden = false;
  void t.offsetWidth; // restart the zoom-in if a notice was already showing
  t.classList.add('in');
  toastTimer = setTimeout(() => {
    t.classList.replace('in', 'out');
    toastOutTimer = setTimeout(() => { t.hidden = true; t.classList.remove('out'); }, 220);
  }, error ? 6000 : 2600);
}

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export const state = { port: 0, settings: {}, account: null, downloads: { done: [], active: [] }, ytCovers: {} };

/** Artwork URL: local-server paths ("/cover/…") become absolute. */
export const art = (u) => (u && u.startsWith('/') ? `http://127.0.0.1:${state.port}${u}` : u || '');
/** CORS-friendly artwork URL for canvas colour extraction. */
export const proxied = (u) => {
  u = art(u);
  return u && /^https?:/.test(u) && !u.startsWith('http://127.0.0.1') ? `http://127.0.0.1:${state.port}/img?u=${encodeURIComponent(u)}` : u;
};
export const streamUrl = (t) => {
  const base = `http://127.0.0.1:${state.port}`;
  if (t.remote) return `${base}/webdav/${t.id}`;
  if (t.local) return `${base}/local/${t.id}`;
  // Title/artist/duration let the media server look the track up on alternative sources (JioSaavn).
  const q = new URLSearchParams({ t: t.title || '', a: (t.artists || [])[0]?.name || '', d: String(t.duration || 0) });
  return `${base}/stream/${t.id}?${q}`;
};

export async function saveSettings(patch) {
  state.settings = await api('settingsSet', patch);
  document.dispatchEvent(new CustomEvent('settings', { detail: patch }));
  return state.settings;
}

// Local favourites and history (work without an account).
export const likes = {
  all() { return store.get('likes', []); },
  has(id) { return this.all().some((t) => t.id === id); },
  toggle(t) {
    const all = this.all();
    const i = all.findIndex((x) => x.id === t.id);
    if (i >= 0) all.splice(i, 1); else { const { _k, ...clean } = t; all.unshift({ ...clean, likedAt: Date.now() }); }
    store.set('likes', all);
    return i < 0;
  },
};
export const history = {
  all() { return store.get('history', []); },
  push(t) {
    const { _k, ...clean } = t;
    const all = this.all().filter((x) => x.id !== t.id);
    all.unshift({ ...clean, playedAt: Date.now() });
    store.set('history', all.slice(0, 300));
  },
  clear() { store.set('history', []); },
};
export const isDownloaded = (id) => state.downloads.done.some((d) => d.id === id);

/** Small modal asking for a line of text. Resolves with the text, or null if cancelled. */
export function askText(title, { value = '', placeholder = '', ok = 'Aceptar', message = '', allowEmpty = false } = {}) {
  return new Promise((resolve) => {
    const m = h(`<div class="modal-back"><div class="modal">
      <h3>${esc(title)}</h3>${message ? `<p class="muted">${esc(message)}</p>` : ''}
      <input class="text" type="text" placeholder="${esc(placeholder)}" value="${esc(value)}" spellcheck="false">
      <div class="btn-row"><button class="btn ghost small" data-a="no">Cancelar</button><button class="btn primary small" data-a="ok">${esc(ok)}</button></div>
    </div></div>`);
    const input = m.querySelector('input');
    const done = (v) => { m.remove(); resolve(v); };
    const val = () => (allowEmpty ? input.value.trim() : input.value.trim() || null);
    m.querySelector('[data-a=ok]').onclick = () => done(val());
    m.querySelector('[data-a=no]').onclick = () => done(null);
    m.addEventListener('mousedown', (e) => { if (e.target === m) done(null); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(val()); if (e.key === 'Escape') done(null); e.stopPropagation(); });
    document.body.append(m);
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}

/** Yes/no modal. */
export function confirmDialog(title, message, { ok = 'Aceptar', danger = false } = {}) {
  return new Promise((resolve) => {
    const m = h(`<div class="modal-back fade"><div class="modal mica">
      <h3>${esc(title)}</h3><p class="muted">${esc(message)}</p>
      <div class="btn-row"><button class="btn ghost small" data-a="no">Cancelar</button><button class="btn ${danger ? 'danger' : 'primary'} small" data-a="ok">${esc(ok)}</button></div>
    </div></div>`);
    const done = (v) => { m.remove(); document.removeEventListener('keydown', key, true); resolve(v); };
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } if (e.key === 'Enter') { e.stopPropagation(); done(true); } };
    m.querySelector('[data-a=ok]').onclick = () => done(true);
    m.querySelector('[data-a=no]').onclick = () => done(false);
    m.addEventListener('mousedown', (e) => { if (e.target === m) done(false); });
    document.addEventListener('keydown', key, true);
    document.body.append(m);
  });
}
