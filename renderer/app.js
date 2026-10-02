// BitChord Desktop — renderer entry.
import { bc, $, $$, icon, esc, fmt, artistNames, store, api, toast, h, state, art, proxied, streamUrl, saveSettings, likes, history, isDownloaded, askText, confirmDialog } from './core.js';
import { Engine } from './engine.js';
import { parseResult } from './lyrics-parse.js';
import { settingsView } from './settings-view.js';
import { libraryView } from './library-view.js';
import { eqPanel } from './eq-panel.js';
import { mountVisualizer, unmountVisualizer, visOnTrackChange, presetNames, currentPreset, pickPreset, randomPreset, scheduleAuto, onVisChange, favorites, toggleFavorite } from './visualizer.js';
import { importView } from './import-view.js';
import { tr, translateStatic, syncUiLang, locale } from './i18n.js';

// ------------------------------------------------------------------ router
const nav = { stack: [], index: -1 };
const scrollMemo = new Map();

export function go(route, { replace = false } = {}) {
  if (nav.index >= 0) scrollMemo.set(nav.index, $('#content').scrollTop);
  if (replace && nav.index >= 0) nav.stack[nav.index] = route;
  else { nav.stack = nav.stack.slice(0, nav.index + 1); nav.stack.push(route); nav.index++; }
  render();
}
function back() { if (nav.index > 0) { scrollMemo.set(nav.index, $('#content').scrollTop); nav.index--; render(true); } }
function forward() { if (nav.index < nav.stack.length - 1) { scrollMemo.set(nav.index, $('#content').scrollTop); nav.index++; render(true); } }
export const currentRoute = () => nav.stack[nav.index];

let renderToken = 0;
export async function render(restoreScroll = false, animate = true) {
  const route = nav.stack[nav.index];
  const token = ++renderToken;
  closeNowPlaying();
  $('#back').disabled = nav.index <= 0;
  $('#forward').disabled = nav.index >= nav.stack.length - 1;
  markNav();
  document.body.classList.toggle('route-settings', route.name === 'settings');
  if (route.name === 'search') $('#search').value = route.q || '';

  const content = $('#content');
  content.style.scrollBehavior = 'auto';
  const keep = restoreScroll ? scrollMemo.get(nav.index) || 0 : 0;
  content.scrollTop = 0;
  content.innerHTML = '<div class="spinner"></div>';
  try {
    const view = await views[route.name](route);
    if (token !== renderToken) return;
    content.innerHTML = '';
    if (animate) view.classList.add('view-in');
    content.append(view);
    content.scrollTop = keep;
    markPlaying();
  } catch (e) {
    if (token !== renderToken) return;
    console.error(e);
    content.innerHTML = '';
    content.append(h(`<div class="empty">${icon('cloudOff')}<div><b>${tr('No se pudo cargar')}</b></div><div class="muted">${esc(e.message)}</div><button class="btn ghost" style="margin-top:12px">${tr('Reintentar')}</button></div>`));
    content.querySelector('button').onclick = () => render();
  }
  content.style.scrollBehavior = '';
}
// ------------------------------------------------------------------ customizable sidebar
export const SIDEBAR_ITEMS = {
  home: { label: tr('Inicio'), icon: 'home', group: 'main', route: { name: 'home' } },
  search: { label: tr('Buscar'), icon: 'search', group: 'main', route: { name: 'search', q: '' } },
  library: { label: tr('Biblioteca'), icon: 'library', group: 'main', route: { name: 'library' } },
  'lib:playlists': { label: tr('Playlists'), icon: 'queue', group: 'lib', route: { name: 'library', tab: 'playlists' } },
  'lib:likes': { label: tr('Favoritos'), icon: 'heartFill', group: 'lib', route: { name: 'library', tab: 'likes' } },
  'lib:downloads': { label: tr('Descargas'), icon: 'download', group: 'lib', route: { name: 'library', tab: 'downloads' } },
  'lib:local': { label: tr('En este equipo'), icon: 'computer', group: 'lib', route: { name: 'library', tab: 'local' } },
  'lib:network': { label: tr('En red'), icon: 'folder', group: 'lib', route: { name: 'library', tab: 'network' } },
  'lib:history': { label: tr('Historial'), icon: 'history', group: 'lib', route: { name: 'library', tab: 'history' } },
  'lib:account': { label: tr('Tu YouTube Music'), icon: 'account', group: 'lib', route: { name: 'library', tab: 'account' } },
  nowplaying: { label: tr('Reproduciendo'), icon: 'disc', group: 'player', action: () => (npOpen() ? closeNowPlaying() : openNowPlaying()) },
  queue: { label: tr('Cola'), icon: 'queue', group: 'player', action: () => toggleQueue() },
};

export function renderSidebar() {
  const box = $('#nav-items');
  box.innerHTML = '<span class="nav-pill no-anim"></span>';
  let lastGroup = null;
  for (const { id, on } of state.settings.sidebar || []) {
    const it = SIDEBAR_ITEMS[id];
    if (!it || !on) continue;
    if (lastGroup && lastGroup !== it.group) box.append(h('<div class="nav-sep"></div>'));
    lastGroup = it.group;
    const b = h(`<button class="nav-item" id="nav-${id.replace(':', '-')}" data-nav="${id}" data-group="${it.group}"><span class="ico">${icon(it.icon)}</span><span class="nav-label">${esc(it.label)}</span></button>`);
    b.onclick = () => (it.action ? it.action() : go({ ...it.route }));
    box.append(b);
    if (id === 'lib:playlists') addPlaylistsFold(b, box);
  }
  markNav();
  $('#nav-queue')?.classList.toggle('active', !$('#queue').hidden);
  $('#nav-nowplaying')?.classList.toggle('active', !$('#nowplaying').hidden);
}

function markNav() {
  const route = nav.stack[nav.index];
  if (!route) return;
  $$('.nav-item[data-nav]').forEach((b) => {
    const it = SIDEBAR_ITEMS[b.dataset.nav];
    if (!it.route) return;
    // Only a tab asked for explicitly (a pinned shortcut, or a chip inside Biblioteca) lights up
    // its shortcut; clicking "Biblioteca" itself keeps "Biblioteca" lit even though it opens on
    // Playlists (before, the highlight slid down to a pinned "Playlists").
    const tab = route.name === 'library' ? route.tab || null : null;
    const libTab = b.dataset.nav.startsWith('lib:') ? b.dataset.nav.slice(4) : null;
    const pinned = !!tab && (state.settings.sidebar || []).some((x) => x.on && x.id === 'lib:' + tab);
    const active = libTab ? route.name === 'library' && tab === libTab
      : b.dataset.nav === 'library' ? route.name === 'library' && !pinned
      : route.name === it.route.name;
    b.classList.toggle('active', active);
  });
  $$('.nav-item[data-route]').forEach((b) => b.classList.toggle('active', b.dataset.route === route.name));
  moveNavPill();
  $('#settings-btn')?.classList.toggle('active', route.name === 'settings');
}

/** "Playlists" in the sidebar: an arrow that unfolds your playlists as a grid of covers. */
function addPlaylistsFold(item, box) {
  const open = store.get('sbPlaylistsOpen', false);
  const arrow = h(`<span class="nav-fold${open ? ' open' : ''}" role="button" title="${tr(open ? 'Ocultar tus playlists' : 'Mostrar tus playlists')}">${icon('chevron')}</span>`);
  item.append(arrow);
  const grid = h(`<div class="sb-pl-grid${open ? ' open' : ''}"><div class="sb-pl-inner"></div></div>`);
  item.after(grid);
  arrow.onclick = (e) => {
    e.stopPropagation();
    const now = !grid.classList.contains('open');
    store.set('sbPlaylistsOpen', now);
    grid.classList.toggle('open', now); arrow.classList.toggle('open', now);
    arrow.title = tr(now ? 'Ocultar tus playlists' : 'Mostrar tus playlists');
    if (now) fillPlaylistsFold(grid.firstElementChild); // refresh (it's already filled, see below)
    followNavPill(560); // the items below move with the fold: keep the highlight on its item
  };
  // Filled even while folded, so opening it animates the real height instead of jumping when
  // the list arrives.
  fillPlaylistsFold(grid.firstElementChild);
}
/** Keeps the sidebar highlight glued to its item while something above it changes height. */
function followNavPill(ms) {
  const pill = $('#nav-items .nav-pill');
  if (!pill) return;
  pill.classList.add('no-anim');
  const end = performance.now() + ms;
  const step = () => { moveNavPill(); if (performance.now() < end) requestAnimationFrame(step); else pill.classList.remove('no-anim'); };
  requestAnimationFrame(step);
}
async function fillPlaylistsFold(inner) {
  const [mine, yt] = await Promise.all([
    api('playlistsList').catch(() => []),
    state.account ? api('accountPlaylists').catch(() => []) : [],
  ]);
  const items = [
    ...sortByPlaylistOrder([
      ...(state.account && !isHiddenPlaylist('LM') ? [{ key: 'yt:LM', liked: true, title: tr('Me gusta'), route: { name: 'playlist', id: 'LM' } }] : []),
      ...yt.filter((p) => !isHiddenPlaylist(p.id)).map((p) => ({ key: 'yt:' + p.id, title: p.title, thumb: state.ytCovers[p.id] || p.thumb, route: { name: 'playlist', id: p.id } })),
    ], (x) => x.key),
    ...sortByPlaylistOrder(mine.map((p) => ({ key: 'bc:' + p.id, title: p.name, thumb: p.cover || p.thumbs?.[0], route: { name: 'localplaylist', id: p.id } })), (x) => x.key),
  ];
  const key = JSON.stringify(items.map((x) => [x.title, x.thumb]));
  if (inner.dataset.key === key) return; // nothing changed: don't redraw (no flicker)
  inner.dataset.key = key;
  inner.replaceChildren();
  if (!items.length) { inner.append(h(`<div class="sb-pl-empty">${tr('Aún no tienes playlists')}</div>`)); return; }
  for (const [n, it] of items.entries()) {
    const el = h(`<button class="sb-pl" title="${esc(it.title)}">
      <span class="sb-pl-art${it.liked ? ' liked' : ''}">${it.liked ? icon('heartFill') : it.thumb ? `<img loading="lazy" src="${esc(art(it.thumb))}" alt="">` : icon('queue')}</span>
      <span class="sb-pl-t">${esc(it.title)}</span></button>`);
    el.style.setProperty('--i', Math.min(n, 12)); // staggered entrance
    el.onclick = () => go(it.route);
    inner.append(el);
  }
}

// ------------------------------------------------------------------ resizable sidebars
/** Drag the inner edge of the left sidebar or of the queue to make it wider or narrower. */
function setupResizers() {
  const root = document.documentElement.style;
  const LIMITS = { sidebar: [180, 420, 'sidebarW', '--sidebar-user'], queue: [260, 600, 'queueW', '--queue-user'] };
  for (const [k, [, , key, prop]] of Object.entries(LIMITS)) { const w = store.get(key, null); if (w) root.setProperty(prop, w + 'px'); }
  const drag = (handle, kind, widthAt) => handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const [min, max, key, prop] = LIMITS[kind];
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    let w = 0;
    const move = (ev) => {
      w = Math.round(Math.min(max, Math.max(min, widthAt(ev))));
      root.setProperty(prop, w + 'px');
      if (kind === 'sidebar') moveNavPill(); // the playlist grid may wrap differently
    };
    const up = () => {
      document.body.classList.remove('resizing');
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up);
      if (w) store.set(key, w);
    };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up);
  });
  drag($('#sb-resize'), 'sidebar', (ev) => ev.clientX - $('#sidebar').getBoundingClientRect().left);
  drag($('#queue-resize'), 'queue', (ev) => $('#queue').getBoundingClientRect().right - ev.clientX);
  // Double click: back to the default width.
  $('#sb-resize').ondblclick = () => { root.removeProperty('--sidebar-user'); store.set('sidebarW', null); moveNavPill(); };
  $('#queue-resize').ondblclick = () => { root.removeProperty('--queue-user'); store.set('queueW', null); };
}

/** Slides the sidebar highlight to the page's item (first time / after a redraw: no animation). */
function moveNavPill() {
  const pill = $('#nav-items .nav-pill');
  if (!pill) return;
  const cur = $$('#nav-items .nav-item.active').find((b) => b.dataset.group !== 'player');
  pill.classList.toggle('on', !!cur);
  if (!cur) return;
  pill.style.height = cur.offsetHeight + 'px';
  pill.style.transform = `translateY(${cur.offsetTop}px)`;
  if (pill.classList.contains('no-anim')) requestAnimationFrame(() => requestAnimationFrame(() => pill.classList.remove('no-anim')));
}
addEventListener('resize', () => { const p = $('#nav-items .nav-pill'); if (p) { p.classList.add('no-anim'); moveNavPill(); } });

/** Re-render the current view keeping the scroll position. */
export const refreshView = () => { scrollMemo.set(nav.index, $('#content').scrollTop); render(true, false); };

// ------------------------------------------------------------------ building blocks
export function trackRow(t, i, list, opts = {}) {
  const dl = isDownloaded(t.id);
  const el = h(`
    <div class="row${opts.compact ? ' compact' : ''}${opts.details && t.file ? ' tall' : ''}${opts.details && state.settings.localInfo?.album === false ? ' no-album' : ''}" data-id="${esc(t.id)}">
      <div class="thumb">${opts.numbered ? `<span class="num">${i + 1}</span>` : t.thumb ? `<img loading="lazy" src="${esc(art(t.thumb))}" alt="">` : `<span class="num">${icon('disc')}</span>`}<span class="ov">${icon('play')}</span></div>
      <div style="min-width:0">
        <div class="ttl ellipsis">${esc(t.title)}${t.isVideo ? ` <span class="badge">${tr('Vídeo')}</span>` : ''}</div>
        <div class="sub ellipsis">${dl || t.local ? `<span class="dl-mark" title="${tr(t.remote ? 'En tu servidor' : t.local ? 'En este equipo' : 'Descargada')}">${icon(t.remote ? 'folder' : t.local ? 'computer' : 'downloaded')}</span>` : ''}${(t.artists || []).map((a) => a.id ? `<span class="link" data-artist="${esc(a.id)}">${esc(a.name)}</span>` : esc(a.name)).join(', ')}</div>
        ${opts.details && t.file ? fileDetails(t) : ''}
      </div>
      <div class="alb ellipsis">${t.album?.name ? (t.album.id ? `<span class="link" data-album="${esc(t.album.id)}">${esc(t.album.name)}</span>` : esc(t.album.name)) : ''}</div>
      <div class="dur">${t.duration ? fmt(t.duration) : ''}</div>
      <button class="icon-btn more" title="${tr('Más opciones')}">${icon('more')}</button>
    </div>`);
  el.addEventListener('click', (e) => {
    const a = e.target.closest('[data-artist]');
    if (a) return go({ name: 'artist', id: a.dataset.artist });
    const al = e.target.closest('[data-album]');
    if (al) return go({ name: 'album', id: al.dataset.album });
    if (e.target.closest('.more')) return trackMenu(t, e.target.closest('.more'), opts);
    if (opts.onClick) return opts.onClick(t, i);
    if (opts.radio && !t.local) player.playRadio(t);
    else player.playList(list, i);
  });
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); trackMenu(t, { x: e.clientX, y: e.clientY }, opts); });
  return el;
}

/** Technical details of a local file (which ones: Ajustes → Personalización). */
export function fileDetails(t) {
  const f = t.file, on = state.settings.localInfo || {};
  const chips = [];
  if (on.format) {
    const codec = f.codec.replace(/^MPEG-4\//, '').replace(/^MPEG 1 Layer 3$/, 'MP3');
    const fmt = codec && codec.toUpperCase() !== f.ext ? `${codec} · ${f.ext}` : f.ext || codec;
    chips.push(`<span class="chip-i${f.lossless ? ' hi' : ''}">${esc(fmt)}${f.lossless ? ' · ' + tr('Sin pérdida') : ''}</span>`);
  }
  if (on.bitrate && f.bitrate) chips.push(`<span class="chip-i">${f.bitrate} kbps</span>`);
  if (on.sampleRate && f.sampleRate) chips.push(`<span class="chip-i">${(f.sampleRate / 1000).toLocaleString(locale(), { maximumFractionDigits: 1 })} kHz</span>`);
  if (on.bitDepth && f.bitDepth) chips.push(`<span class="chip-i${f.bitDepth >= 24 ? ' hi' : ''}">${f.bitDepth}-bit</span>`);
  if (on.channels && f.channels) chips.push(`<span class="chip-i">${{ 1: tr('Mono'), 2: tr('Estéreo'), 6: '5.1', 8: '7.1' }[f.channels] || tr('{n} canales', { n: f.channels })}</span>`);
  if (on.size && f.size) chips.push(`<span class="chip-i">${(f.size / 1048576).toLocaleString(locale(), { maximumFractionDigits: 1, minimumFractionDigits: 1 })} MB</span>`);
  if (on.year && f.year) chips.push(`<span class="chip-i">${f.year}</span>`);
  if (on.genre && f.genre) chips.push(`<span class="chip-i">${esc(f.genre)}</span>`);
  const pathLine = on.path && f.path ? `<div class="file-path ellipsis" title="${esc(f.path)}">${esc(f.path)}</div>` : '';
  return chips.length || pathLine ? `<div class="file-info">${chips.join('')}</div>${pathLine}` : '';
}

export function card(item) {
  if (item.kind === 'playlist' && state.ytCovers[item.id]) item = { ...item, thumb: state.ytCovers[item.id] };
  const el = h(`
    <div class="card ${item.kind}">
      <div class="art">${item.thumb ? `<img loading="lazy" src="${esc(art(item.thumb))}" alt="">` : ''}<span class="hover-play">${icon('play')}</span></div>
      <div class="t ellipsis">${esc(item.title)}</div>
      <div class="s">${esc(item.subtitle || (item.kind === 'track' ? artistNames(item) : ''))}</div>
    </div>`);
  el.addEventListener('click', async (e) => {
    if (e.target.closest('.hover-play')) {
      e.stopPropagation();
      if (item.kind === 'track') return player.playRadio(item);
      if (item.kind === 'artist') return go({ name: 'artist', id: item.id });
      try {
        const d = await api(item.kind === 'album' ? 'album' : 'playlist', item.id);
        if (d.tracks.length) player.playList(d.tracks, 0, { from: { kind: item.kind === 'album' ? 'Álbum' : 'Playlist', name: item.title } });
      } catch (err) { toast(err.message, true); }
      return;
    }
    if (item.kind === 'track') return player.playRadio(item);
    go({ name: item.kind, id: item.id });
  });
  if (item.kind === 'track') el.addEventListener('contextmenu', (e) => { e.preventDefault(); trackMenu(item, { x: e.clientX, y: e.clientY }); });
  return el;
}

// Home sections are identified by their title; YouTube words a few of them differently from
// time to time, so those get a stable key.
const HOME_ALIASES = [
  ['recent', /escuchado recientemente/], ['library', /de tu biblioteca/], ['quick', /seleccion(es)? rapida/],
  ['covers', /versiones y remixes/], ['forgotten', /favoritos olvidados/], ['trending', /canciones en tendencia/],
  ['discover', /nuevos descubrimientos|favoritos de siempre/],
];
export function homeKey(title) {
  const n = String(title || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
  for (const [k, re] of HOME_ALIASES) if (re.test(n)) return k;
  return n;
}

export function section(sec, { wrap = false, radio = true } = {}) {
  const el = h(`<section class="section">${sec.title ? `<h2>${esc(sec.title)}</h2>` : ''}</section>`);
  if (sec.layout === 'list') {
    const grid = sec.items.length > 4 && !wrap;
    const box = h(`<div class="tracks${grid ? ' grid' : ''}"></div>`);
    sec.items.forEach((t, i) => box.append(trackRow(t, i, sec.items, { radio, compact: grid })));
    el.append(box);
  } else {
    const box = h(`<div class="cards${wrap ? ' wrap' : ''}"></div>`);
    sec.items.forEach((it) => box.append(card(it)));
    el.append(box);
  }
  return el;
}

/** Search "top result": a big card (artist, album, song…) with its songs beside it. */
function topResult(sec) {
  const el = h(`<section class="section top-result"><h2>${esc(sec.title)}</h2><div class="top-grid"></div></section>`);
  const grid = el.querySelector('.top-grid');
  const it = sec.top;
  if (it) {
    const kind = { artist: tr('Artista'), album: tr('Álbum'), playlist: tr('Playlist'), track: tr('Canción') }[it.kind] || '';
    const sub = it.subtitle && !it.subtitle.toLowerCase().startsWith(kind.toLowerCase()) ? `${kind} · ${it.subtitle}` : it.subtitle || kind;
    const c = h(`<div class="top-card ${it.kind}">
      ${it.thumb ? `<img src="${esc(art(it.thumb))}" alt="">` : `<div class="top-ph">${icon(it.kind === 'artist' ? 'person' : 'disc')}</div>`}
      <div class="top-text"><b class="ellipsis">${esc(it.title)}</b><span class="ellipsis">${esc(sub)}</span></div>
      <div class="top-actions">
        <button class="btn primary small" data-a="play">${icon('play')}${tr('Reproducir')}</button>
        ${it.kind !== 'track' ? `<button class="btn ghost small" data-a="open">${tr(it.kind === 'artist' ? 'Ver artista' : 'Abrir')}</button>` : `<button class="btn ghost small" data-a="radio">${icon('radio')}${tr('Radio')}</button>`}
      </div></div>`);
    const playAll = async () => {
      if (it.kind === 'track') return player.playRadio(it);
      if (it.kind === 'artist') { if (sec.items.length) return player.playList(sec.items, 0, { from: { kind: tr('Artista'), name: it.title } }); return go({ name: 'artist', id: it.id }); }
      try { const d = await api(it.kind === 'album' ? 'album' : 'playlist', it.id); if (d.tracks.length) player.playList(d.tracks, 0, { from: { kind: it.kind === 'album' ? tr('Álbum') : tr('Playlist'), name: it.title } }); }
      catch (e) { toast(e.message, true); }
    };
    c.querySelector('[data-a=play]').onclick = (e) => { e.stopPropagation(); playAll(); };
    c.querySelector('[data-a=open]')?.addEventListener('click', (e) => { e.stopPropagation(); go({ name: it.kind, id: it.id }); });
    c.querySelector('[data-a=radio]')?.addEventListener('click', (e) => { e.stopPropagation(); player.playRadio(it); });
    c.onclick = () => (it.kind === 'track' ? player.playRadio(it) : go({ name: it.kind, id: it.id }));
    if (it.kind === 'track') c.addEventListener('contextmenu', (e) => { e.preventDefault(); trackMenu(it, { x: e.clientX, y: e.clientY }); });
    grid.append(c);
  }
  if (sec.items.length) {
    const box = h('<div class="tracks"></div>');
    sec.items.forEach((t, i) => box.append(trackRow(t, i, sec.items, { compact: true })));
    grid.append(box);
  }
  return el;
}

// ------------------------------------------------------------------ views
const views = {
  async home() {
    const hidden = new Set(state.settings.homeHidden || []);
    const seen = store.get('homeSeen', {});
    const add = (sec, el) => {
      const key = homeKey(sec.title);
      if (!seen[key]) { seen[key] = sec.title; store.set('homeSeen', seen); }
      if (hidden.has(key)) return;
      const hd = el.querySelector('h2');
      if (hd) {
        const x = h(`<button class="sec-hide" title="${tr('Ocultar este apartado')}">${icon('close')}<span>${tr('Ocultar')}</span></button>`);
        x.onclick = async () => {
          await saveSettings({ homeHidden: [...new Set([...(state.settings.homeHidden || []), key])] });
          el.classList.add('sec-leaving');
          setTimeout(() => el.remove(), 260);
          toast(tr('«{name}» oculto · recupéralo en Ajustes → Personalización', { name: sec.title }));
        };
        hd.append(x);
      }
      root.append(el);
    };
    const root = h('<div></div>');
    root.append(h(`<h1 class="page-title" id="home-greet">${esc(greeting())}</h1>`));
    const recent = history.all().slice(0, 8);
    if (recent.length) { const sec = { title: tr('Escuchado recientemente'), layout: 'list', items: recent }; add(sec, section(sec)); }
    let sections = [];
    try { sections = await api('home'); }
    catch (e) {
      if (!recent.length) throw e;
      root.append(h(`<div class="empty small">${icon('cloudOff')}<div class="muted">${tr('Sin conexión con YouTube Music:')} ${esc(e.message)}</div></div>`));
    }
    sections.forEach((s) => add(s, section(s)));
    // The account may have arrived while Home was loading (before it was on the page).
    root.querySelector('#home-greet').textContent = greeting();
    return root;
  },

  async search(route) {
    const root = h('<div></div>');
    const filters = [['all', tr('Todo')], ['song', tr('Canciones')], ['video', tr('Vídeos')], ['album', tr('Álbumes')], ['artist', tr('Artistas')], ['playlist', tr('Playlists')]];
    if (!route.q) {
      root.append(h(`<div class="empty">${icon('search')}<div><b>${tr('Busca en YouTube Music')}</b></div><div class="muted">${tr('Canciones, artistas, álbumes y playlists')}</div></div>`));
      setTimeout(() => $('#search').focus(), 0);
      return root;
    }
    const type = route.type || 'all';
    root.append(h(`<div class="search-head"><span>${tr('Resultados de')}</span><h1 class="page-title">"${esc(route.q)}"</h1></div>`));
    const chips = h('<div class="chips"></div>');
    filters.forEach(([k, label]) => {
      const c = h(`<button class="chip${k === type ? ' active' : ''}">${label}</button>`);
      c.onclick = () => go({ name: 'search', q: route.q, type: k }, { replace: true });
      chips.append(c);
    });
    root.append(chips);
    const sections = await api('search', route.q, type);
    // "¿Querías decir…?": YouTube's spelling suggestion, one click to search it.
    const fix = sections.find((s) => s.layout === 'correction');
    if (fix && fix.query.toLowerCase() !== route.q.trim().toLowerCase()) {
      const el = h(`<div class="did-you-mean">${icon('search')}<span>${tr('¿Querías decir')} <a href="#">"${esc(fix.query)}"</a>?${fix.auto ? ` <small>${tr('Se muestran resultados de "{q}".', { q: esc(fix.query) })}</small>` : ''}</span></div>`);
      el.querySelector('a').onclick = (e) => { e.preventDefault(); $('#search').value = fix.query; go({ name: 'search', q: fix.query, type }); };
      chips.before(el); // above the content-type filters
    }
    const nonEmpty = sections.filter((s) => s.layout !== 'correction' && s.items.length);
    if (!nonEmpty.length) root.append(h(`<div class="empty">${icon('search')}<div>${tr('Sin resultados')}</div></div>`));
    nonEmpty.forEach((s) => root.append(s.layout === 'top' ? topResult(s) : section(s, { wrap: type !== 'all' })));
    return root;
  },

  async album(route) { return detailView(await api('album', route.id), tr('Álbum')); },
  async playlist(route) {
    const d = await api('playlist', route.id);
    const custom = state.ytCovers[route.id];
    const view = detailView({ ...d, thumb: custom || d.thumb }, tr('Playlist'));
    // Custom artwork kept on this computer (YouTube doesn't let apps change it).
    const head = view.querySelector('.detail-head');
    if (!head.querySelector(':scope > img, :scope > .mosaic')) head.prepend(h(`<div class="mosaic empty">${icon('queue')}</div>`));
    coverEditor(view, {
      title: tr('Portada de la playlist (solo en BitChord)'), hasCover: !!custom,
      onData: async (bytes) => { const url = await api('ytCoverData', route.id, bytes); state.ytCovers = { ...state.ytCovers, [route.id]: url }; },
      onRemove: async () => { await api('ytCoverRemove', route.id); const m = { ...state.ytCovers }; delete m[route.id]; state.ytCovers = m; },
    });
    if (state.account && route.id !== 'LM') {
      const del = h(`<button class="btn ghost">${icon('trash')}${tr('Eliminar playlist')}</button>`);
      del.onclick = () => deletePlaylist({ kind: 'playlist', id: route.id, title: d.title }, { leave: true });
      view.querySelector('.actions').append(del);
    }
    return view;
  },

  async artist(route) {
    const a = await api('artist', route.id);
    const root = h('<div></div>');
    const head = h(`
      <div class="detail-head artist">
        ${a.thumb ? `<img src="${esc(art(a.thumb))}" alt="">` : ''}
        <div style="min-width:0">
          <div class="kind">${tr('Artista')}</div>
          <h1>${esc(a.title)}</h1>
          <div class="muted">${esc(a.subtitle || '')}</div>
          ${a.description ? `<div class="desc">${esc(a.description)}</div>` : ''}
          <div class="actions"><button class="btn primary" data-a="play">${icon('play')}${tr('Reproducir')}</button><button class="btn ghost" data-a="radio">${icon('radio')}${tr('Radio')}</button></div>
        </div>
      </div>`);
    const songs = a.sections.find((s) => s.layout === 'list')?.items || [];
    head.querySelector('[data-a=play]').onclick = () => songs.length ? player.playList(songs, 0) : toast(tr('Este artista no tiene canciones disponibles'));
    head.querySelector('[data-a=radio]').onclick = () => songs.length && player.playRadio(songs[Math.floor(Math.random() * songs.length)]);
    root.append(head);
    a.sections.forEach((s) => {
      if (s.layout === 'list') {
        const el = h(`<section class="section"><h2>${esc(s.title || tr('Canciones'))}</h2></section>`);
        const box = h('<div class="tracks"></div>');
        s.items.forEach((t, i) => box.append(trackRow(t, i, s.items, {})));
        el.append(box);
        root.append(el);
      } else root.append(section(s));
    });
    return root;
  },

  library: (route) => libraryView(route),
  'spotify-import': () => importView(),
  async localplaylist(route) {
    const p = await api('playlistGet', route.id);
    const view = detailView({
      kind: 'localplaylist', id: p.id, title: p.name,
      subtitle: tr(p.origin === 'spotify' ? 'Playlist de BitChord · importada de Spotify' : 'Playlist de BitChord'),
      thumb: p.cover || p.thumbs[0] || null, mosaic: p.cover ? [] : p.thumbs,
      tracks: p.tracks, sections: [],
    }, tr('Playlist'), { playlistId: p.id });
    const actions = view.querySelector('.actions');
    coverEditor(view, {
      title: tr('Portada de la playlist'), hasCover: !!p.cover,
      onData: (bytes) => api('playlistCoverData', p.id, bytes),
      onRemove: () => api('playlistCoverRemove', p.id),
    });
    const ren = h(`<button class="btn ghost">${icon('edit')}${tr('Renombrar')}</button>`);
    ren.onclick = async () => { const n = await askText(tr('Renombrar playlist'), { value: p.name, ok: tr('Guardar') }); if (n) { await api('playlistRename', p.id, n); refreshView(); } };
    const del = h(`<button class="btn ghost">${icon('trash')}${tr('Eliminar playlist')}</button>`);
    del.onclick = () => deletePlaylist({ kind: 'localplaylist', id: p.id, title: p.name }, { leave: true });
    actions.append(ren, del);
    return view;
  },
  async localfolder(route) {
    const f = await api('localFolderGet', route.id);
    const view = detailView({
      kind: 'localfolder', id: f.id, title: f.name, noDownload: true,
      subtitle: f.path,
      meta: `${tr('{n} canciones', { n: f.count })} · ${Math.round(f.duration / 60)} min · ${sizeLabel(f.size)}${f.watching ? ' · ' + tr('se actualiza sola') : ''}`,
      thumb: f.cover || f.thumbs[0] || null, mosaic: f.cover ? [] : f.thumbs,
      tracks: f.tracks, sections: [],
    }, tr('Carpeta local'), { details: true });
    coverEditor(view, {
      title: tr('Portada de la carpeta'), hasCover: !!f.cover,
      onData: (bytes) => api('localFolderCoverData', f.id, bytes),
      onRemove: () => api('localFolderCoverRemove', f.id),
    });
    const actions = view.querySelector('.actions');
    const ren = h(`<button class="btn ghost">${icon('edit')}${tr('Renombrar')}</button>`);
    ren.onclick = async () => {
      const n = await askText(tr('Nombre en BitChord'), { value: f.customName ? f.name : '', ok: tr('Guardar'), placeholder: f.path.split(/[\\/]/).filter(Boolean).pop() || tr('Nombre'), message: tr('Solo cambia el nombre dentro de BitChord; la carpeta no se toca. Déjalo vacío para usar el nombre de la carpeta.'), allowEmpty: true });
      if (n !== null) { await api('localFolderRename', f.id, n); refreshView(); }
    };
    const open = h(`<button class="btn ghost">${icon('folder')}${tr('Abrir carpeta')}</button>`);
    open.onclick = () => api('localFolderOpen', f.id);
    const rescan = h(`<button class="btn ghost">${icon('refresh')}${tr('Volver a escanear')}</button>`);
    rescan.onclick = async () => { rescan.disabled = true; toast(tr('Escaneando la carpeta…')); await api('localFolderRescan', f.id); refreshView(); };
    actions.append(ren, open, rescan);
    return view;
  },
  settings: (route) => settingsView(route),
};

export const sizeLabel = (b) => (b >= 1073741824 ? (b / 1073741824).toLocaleString(locale(), { maximumFractionDigits: 2 }) + ' GB' : (b / 1048576).toLocaleString(locale(), { maximumFractionDigits: 1 }) + ' MB');

/** Click the artwork (or drop an image on it) to set a custom cover. */
function coverEditor(view, { title, hasCover, onData, onRemove }) {
  const head = view.querySelector('.detail-head');
  const artEl = head.firstElementChild;
  const wrap = h(`<div class="cover-edit" title="${tr('Cambiar portada')}"><span class="cover-ov">${icon('edit')}<b>${tr('Cambiar portada')}</b><small>${tr('o arrastra una imagen aquí')}</small></span></div>`);
  artEl.replaceWith(wrap);
  wrap.prepend(artEl);
  const setFrom = async (file) => {
    try { await onData(await squareJpeg(file)); toast(tr('Portada actualizada')); refreshView(); }
    catch (e) { toast(e.message || tr('No se pudo usar esa imagen'), true); }
  };
  const pickFile = () => {
    const input = h('<input type="file" accept="image/*" hidden>');
    input.onchange = () => input.files[0] && setFrom(input.files[0]);
    document.body.append(input); input.click(); setTimeout(() => input.remove(), 60000);
  };
  wrap.onclick = (e) => openMenu([
    { header: title },
    { icon: 'image', label: tr('Elegir imagen…'), action: pickFile },
    ...(hasCover ? [{ icon: 'remove', label: tr('Quitar portada personalizada'), action: async () => { await onRemove(); refreshView(); } }] : []),
  ], { x: e.clientX, y: e.clientY });
  wrap.addEventListener('dragover', (e) => { e.preventDefault(); wrap.classList.add('drop'); });
  wrap.addEventListener('dragleave', () => wrap.classList.remove('drop'));
  wrap.addEventListener('drop', (e) => {
    e.preventDefault(); wrap.classList.remove('drop');
    const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/'));
    if (f) setFrom(f); else toast(tr('Eso no es una imagen'), true);
  });
}

export function detailView(d, kindLabel, rowOpts = {}) {
  const root = h('<div></div>');
  const total = d.tracks.reduce((s, t) => s + (t.duration || 0), 0);
  const head = h(`
    <div class="detail-head">
      ${d.mosaic?.length >= 4 ? `<div class="mosaic">${d.mosaic.slice(0, 4).map((u) => `<img src="${esc(art(u))}" alt="">`).join('')}</div>` : d.thumb ? `<img src="${esc(art(d.thumb))}" alt="">` : d.kind === 'localplaylist' ? `<div class="mosaic empty">${icon('queue')}</div>` : d.kind === 'localfolder' ? `<div class="mosaic empty">${icon('folder')}</div>` : ''}
      <div style="min-width:0">
        <div class="kind">${kindLabel}</div>
        <h1>${esc(d.title)}</h1>
        <div>${esc(d.subtitle || '')}</div>
        <div class="muted" style="font-size:13px;margin-top:4px">${esc(d.meta || `${tr('{n} canciones', { n: d.tracks.length })}${total ? ' · ' + Math.round(total / 60) + ' min' : ''}`)}</div>
        ${d.description ? `<div class="desc">${esc(d.description)}</div>` : ''}
        <div class="actions">
          <button class="btn primary" data-a="play">${icon('play')}${tr('Reproducir')}</button>
          <button class="btn ghost" data-a="shuffle">${icon('shuffle')}${tr('Aleatorio')}</button>
          <button class="btn ghost" data-a="queue">${icon('addQueue')}${tr('A la cola')}</button>
          ${d.noDownload ? '' : `<button class="btn ghost" data-a="download">${icon('download')}${tr('Descargar')}</button>`}
        </div>
      </div>
    </div>`);
  head.querySelector('[data-a=play]').onclick = () => d.tracks.length && player.playList(d.tracks, 0);
  head.querySelector('[data-a=shuffle]').onclick = () => d.tracks.length && player.playList(d.tracks, 0, { shuffle: true });
  head.querySelector('[data-a=queue]').onclick = () => { player.enqueue(d.tracks); toast(tr('{n} canciones añadidas a la cola', { n: d.tracks.length })); };
  const dlb = head.querySelector('[data-a=download]');
  if (dlb) dlb.onclick = () => downloadTracks(d.tracks);
  root.append(head);
  const box = h('<div class="tracks"></div>');
  d.tracks.forEach((t, i) => box.append(trackRow(t, i, d.tracks, { numbered: d.kind === 'album', details: !!rowOpts.details, ...(rowOpts.playlistId ? { playlistId: rowOpts.playlistId, playlistIndex: i } : {}) })));
  if (!d.tracks.length) box.append(h(`<div class="empty">${tr('No hay canciones.')}</div>`));
  root.append(box);
  (d.sections || []).forEach((s) => root.append(section(s)));
  return root;
}

export async function downloadTracks(tracks) {
  const list = tracks.filter((t) => t && !t.local && !isDownloaded(t.id));
  if (!list.length) return toast(tr('Ya está todo descargado'));
  await api('download', list);
  toast(list.length === 1 ? tr('Descargando «{name}»…', { name: list[0].title }) : tr('Descargando {n} canciones…', { n: list.length }));
}

// ------------------------------------------------------------------ playlist menu (right click on a playlist)
/** p: { kind: 'playlist' (YouTube Music) | 'localplaylist' (BitChord), id, title }. */
export function playlistMenu(p, anchor) {
  const tracks = () => api(p.kind === 'localplaylist' ? 'playlistGet' : 'playlist', p.id).then((d) => d.tracks).catch((e) => { toast(e.message, true); return []; });
  const from = { kind: tr('Playlist'), name: p.title };
  const yt = p.kind === 'playlist';
  openMenu([
    { header: p.title },
    { icon: 'play', label: tr('Reproducir'), action: async () => { const t = await tracks(); if (t.length) player.playList(t, 0, { from }); } },
    { icon: 'shuffle', label: tr('Aleatorio'), action: async () => { const t = await tracks(); if (t.length) player.playList(t, 0, { shuffle: true, from }); } },
    { icon: 'addQueue', label: tr('Añadir a la cola'), action: async () => { const t = await tracks(); if (t.length) { player.enqueue(t); toast(tr('{n} canciones añadidas a la cola', { n: t.length })); } } },
    { icon: 'download', label: tr('Descargar'), action: async () => downloadTracks(await tracks()) },
    null,
    { icon: 'open', label: tr('Abrir'), action: () => go({ name: p.kind, id: p.id }) },
    ...(yt ? [{ icon: 'open', label: tr('Abrir en YouTube Music'), action: () => bc.openExternal(`https://music.youtube.com/playlist?list=${p.id.replace(/^VL/, '')}`) }] : []),
    ...(!yt ? [{ icon: 'edit', label: tr('Renombrar'), action: async () => { const n = await askText(tr('Renombrar playlist'), { value: p.title, ok: tr('Guardar') }); if (n) { await api('playlistRename', p.id, n); refreshView(); renderSidebar(); } } }] : []),
    null,
    // Hiding works for any YouTube Music playlist, "Me gusta" included (it can't be deleted).
    ...(yt ? [{ icon: 'remove', label: tr('Ocultar en BitChord'), action: async () => { await hidePlaylist(p); refreshView(); } }] : []),
    ...(yt && p.id === 'LM' ? [] : [{ icon: 'trash', label: tr('Eliminar playlist'), action: () => deletePlaylist(p) }]),
  ], anchor);
}
/** Deletes a whole playlist after a confirmation (YouTube Music ones from the account too). */
export async function deletePlaylist(p, { leave = false } = {}) {
  const yt = p.kind === 'playlist';
  const msg = yt ? tr('¿Eliminar «{name}» de tu cuenta de YouTube Music? Desaparecerá también de la app oficial. Las canciones no se borran.', { name: p.title })
    : tr('¿Borrar «{name}»? Las canciones no se borran, solo la lista.', { name: p.title });
  if (!(await confirmDialog(tr('Eliminar playlist'), msg, { ok: tr('Eliminar'), danger: true }))) return false;
  try {
    await api(yt ? 'ytPlaylistDelete' : 'playlistDelete', p.id);
    toast(tr('Playlist eliminada'));
    renderSidebar();
    if (leave) go({ name: 'library', tab: 'playlists' }, { replace: true }); else refreshView();
    return true;
  } catch (e) {
    if (!yt) { toast(e.message, true); return false; }
    // YouTube refuses to delete its own special lists ("Episodios para más tarde"…) and playlists
    // saved from other people: explain it and offer to hide it in BitChord instead.
    const hide = await confirmDialog(tr('No se puede eliminar'),
      tr('YouTube Music no deja eliminar «{name}»: es una lista especial de tu cuenta (como «Me gusta» o «Episodios para más tarde») o una playlist de otra persona que tienes guardada. Puedes ocultarla en BitChord: dejará de aparecer en tus playlists y en la barra lateral, pero seguirá en tu cuenta. Podrás volver a mostrarla en Ajustes → Personalización.', { name: p.title }),
      { ok: tr('Ocultar') });
    if (!hide) return false;
    await hidePlaylist(p);
    if (leave) go({ name: 'library', tab: 'playlists' }, { replace: true }); else refreshView();
    return false;
  }
}
/** Order chosen by dragging in Biblioteca -> Playlists; playlists not placed yet (new ones) go first. */
export function sortByPlaylistOrder(list, keyOf) {
  const pos = new Map((state.settings.playlistOrder || []).map((k, i) => [k, i]));
  return list.map((x, i) => [x, pos.has(keyOf(x)) ? pos.get(keyOf(x)) : -1e6 + i]).sort((a, b) => a[1] - b[1]).map(([x]) => x);
}
/** YouTube Music playlists hidden in BitChord (they stay in the account). */
export const isHiddenPlaylist = (id) => (state.settings.hiddenPlaylists || []).some((x) => x.id === id);
export async function hidePlaylist(p) {
  await saveSettings({ hiddenPlaylists: [...(state.settings.hiddenPlaylists || []).filter((x) => x.id !== p.id), { id: p.id, title: p.title }] });
  renderSidebar();
  toast(tr('«{name}» oculta en BitChord', { name: p.title }));
}

// ------------------------------------------------------------------ menus
function fillMenu(m, items, pick) {
  items.forEach((it) => {
    if (!it) return m.append(document.createElement('hr'));
    if (it.header) return m.append(h(`<div class="menu-head">${esc(it.header)}</div>`));
    if (it.el) return m.append(it.el); // custom content (sliders…)
    const b = h(`<button${it.checked ? ' class="checked"' : ''}>${icon(it.icon || (it.checked ? 'check' : ''))}<span class="ellipsis">${esc(it.label)}</span>${it.hint ? `<span class="hint">${esc(it.hint)}</span>` : ''}</button>`);
    b.onclick = () => pick(it);
    m.append(b);
  });
}
// Menus of the full-screen buttons open in the side panel instead (title by button).
const FS_MENUS = { 'lyrics-source': tr('Letra') };
let fsMenuPicking = false;
export function openMenu(items, anchor) {
  if (isFs() && anchor instanceof Element && FS_MENUS[anchor.id]) {
    if (fsPanelKind === anchor.id && !fsMenuPicking) return closeFsPanel(); // second click closes it
    const list = h('<div class="fs-menu"></div>');
    fillMenu(list, items, (it) => {
      // An item may open another menu in the panel (a submenu): only close if it didn't.
      const gen = fsPanelGen;
      fsMenuPicking = true;
      try { it.action(); } finally { fsMenuPicking = false; }
      if (gen === fsPanelGen) closeFsPanel();
    });
    return openFsPanel(anchor.id, FS_MENUS[anchor.id], list);
  }
  const m = $('#menu');
  m.innerHTML = '';
  fillMenu(m, items, (it) => { closeMenu(); it.action(); });
  m.hidden = false;
  let x, y;
  if (anchor instanceof Element) {
    const r = anchor.getBoundingClientRect();
    // Right-aligned to the button, or opening to its right if the button asks (data-menu=right).
    x = anchor.dataset.menu === 'right' ? r.left : r.right - m.offsetWidth; y = r.bottom + 4;
    if (y + m.offsetHeight > innerHeight - 8) y = r.top - m.offsetHeight - 4;
  } else ({ x, y } = anchor);
  x = Math.max(8, Math.min(x, innerWidth - m.offsetWidth - 8));
  y = Math.max(8, Math.min(y, innerHeight - m.offsetHeight - 8));
  m.style.left = x + 'px';
  m.style.top = y + 'px';
}
export function closeMenu() { $('#menu').hidden = true; $('#lyrics-source')?.classList.remove('open'); }
document.addEventListener('mousedown', (e) => { if (!e.target.closest('#menu')) closeMenu(); });
window.addEventListener('blur', closeMenu);

function trackMenu(t, anchor, opts = {}) {
  const liked = likes.has(t.id);
  openMenu([
    { icon: 'playNext', label: tr('Reproducir a continuación'), action: () => { player.playNext(t); toast(tr('Se reproducirá a continuación')); } },
    { icon: 'addQueue', label: tr('Añadir a la cola'), action: () => { player.enqueue([t]); toast(tr('Añadida a la cola')); } },
    ...(t.local ? [] : [{ icon: 'radio', label: tr('Iniciar radio'), action: () => player.playRadio(t) }]),
    null,
    { icon: liked ? 'heartFill' : 'heart', label: tr(liked ? 'Quitar de favoritos' : 'Añadir a favoritos'), action: () => toggleLike(t) },
    { icon: 'playlistAdd', label: tr('Añadir a una playlist…'), action: () => addToPlaylistMenu([t], anchor) },
    ...(t.local ? [] : isDownloaded(t.id)
      ? [{ icon: 'trash', label: tr('Borrar descarga'), action: () => api('downloadRemove', t.id).then(() => toast(tr('Descarga borrada'))) }]
      : [{ icon: 'download', label: tr('Descargar'), action: () => downloadTracks([t]) }]),
    null,
    ...(t.artists || []).filter((a) => a.id).slice(0, 2).map((a) => ({ icon: 'person', label: tr('Ir a {name}', { name: a.name }), action: () => go({ name: 'artist', id: a.id }) })),
    ...(t.album?.id ? [{ icon: 'album', label: tr('Ir al álbum'), action: () => go({ name: 'album', id: t.album.id }) }] : []),
    ...(t.local ? [] : [{ icon: 'open', label: tr('Abrir en YouTube Music'), action: () => bc.openExternal(`https://music.youtube.com/watch?v=${t.id}`) }]),
    ...(opts.queueIndex != null ? [null, { icon: 'remove', label: tr('Quitar de la cola'), action: () => player.removeAt(opts.queueIndex) }] : []),
    ...(opts.playlistId ? [null, { icon: 'remove', label: tr('Quitar de esta playlist'), action: async () => { await api('playlistRemoveAt', opts.playlistId, opts.playlistIndex); refreshView(); } }] : []),
  ], anchor);
}

/** Any image the browser can decode (JPG, PNG, WebP, GIF, AVIF…) → centre-cropped square JPEG bytes. */
async function squareJpeg(file) {
  if (file.size > 40 * 1024 * 1024) throw new Error(tr('La imagen es demasiado grande (máx. 40 MB)'));
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const out = Math.min(1000, side);
  const c = document.createElement('canvas');
  c.width = c.height = out;
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, out, out);
  bmp.close?.();
  const blob = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.9));
  return new Uint8Array(await blob.arrayBuffer());
}

/** "Add to playlist" picker (BitChord playlists; a new one can be created on the spot). */
export async function addToPlaylistMenu(tracks, anchor) {
  const online = tracks.filter((t) => !t.local);
  const [lists, ytLists] = await Promise.all([
    api('playlistsList'),
    state.account && online.length ? api('accountPlaylists').catch(() => []) : [],
  ]);
  const add = async (id, name) => {
    const n = await api('playlistAdd', id, tracks);
    toast(n ? (n > 1 ? tr('Añadidas {n} canciones a «{name}»', { n, name }) : tr('Añadida a «{name}»', { name })) : tr('Ya estaba en «{name}»', { name }));
  };
  const addYt = async (id, name) => {
    try { await api('ytPlaylistAdd', id, online.map((t) => t.id)); toast(online.length > 1 ? tr('Añadidas {n} canciones a «{name}»', { n: online.length, name }) : tr('Añadida a «{name}»', { name })); }
    catch (e) { toast(e.message, true); }
  };
  const newLocal = async () => {
    const name = await askText(tr('Nueva playlist (solo en BitChord)'), { placeholder: tr('Nombre de la playlist'), ok: tr('Crear') });
    if (!name) return;
    await api('playlistCreate', name, tracks);
    toast(tr('Playlist «{name}» creada', { name }));
  };
  const items = [];
  if (state.account && online.length) {
    items.push({ header: tr('Tus playlists de YouTube Music') }, { icon: 'add', label: tr('Nueva playlist…'), action: async () => {
      const name = await askText(tr('Nueva playlist de YouTube Music'), { placeholder: tr('Nombre de la playlist'), ok: tr('Crear') });
      if (!name) return;
      try { await api('ytPlaylistCreate', name, online.map((t) => t.id)); toast(tr('Playlist «{name}» creada en YouTube Music', { name })); }
      catch (e) { toast(e.message, true); }
    } });
    ytLists.slice(0, 40).forEach((p) => items.push({ icon: 'queue', label: p.title, action: () => addYt(p.id, p.title) }));
    items.push(null, { header: tr('Solo en BitChord') }, { icon: 'add', label: tr('Nueva playlist solo en BitChord…'), action: newLocal });
  } else {
    items.push({ header: tr('Añadir a playlist de BitChord') }, { icon: 'add', label: tr('Nueva playlist…'), action: newLocal });
  }
  lists.slice(0, 30).forEach((p) => items.push({ icon: 'queue', label: p.name, hint: `${p.count}`, action: () => add(p.id, p.name) }));
  openMenu(items, anchor instanceof Element && anchor.isConnected ? anchor : { x: innerWidth / 2 - 120, y: innerHeight / 3 });
}

export async function toggleLike(t) {
  const now = likes.toggle(t);
  toast(tr(now ? 'Añadida a favoritos' : 'Quitada de favoritos'));
  updateLikeButtons();
  if (state.account && !t.local) api('rate', t.id, now ? 'like' : 'none').catch((e) => console.warn('rate', e));
}
function updateLikeButtons() {
  const t = player.current;
  const on = t && likes.has(t.id);
  for (const b of [$('#like'), $('#np-like'), $('#fs-like')]) { b.innerHTML = icon(on ? 'heartFill' : 'heart'); b.classList.toggle('on', !!on); }
}

// ------------------------------------------------------------------ player
export const engine = new Engine();
engine.urlFor = streamUrl;

let uidN = 0;
const uid = () => ++uidN;
function shuffleArr(a) { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

export const player = {
  queue: [],
  index: -1,
  shuffle: store.get('shuffle', false),
  repeat: store.get('repeat', 'off'), // off | all | one
  extending: false,
  lyrics: null,
  nextIndex: -1,
  sleep: null, // {until} | {endOfTrack}

  get current() { return this.queue[this.index] || null; },

  playList(list, start = 0, { shuffle = false, from = playContext() } = {}) {
    this.from = from;
    let q = list.filter((t) => t && t.kind === 'track');
    let idx = Math.max(0, q.indexOf(list[start]));
    if (shuffle) { q = shuffleArr(q); idx = 0; this.setShuffle(true, false); }
    this.queue = q.map((t) => ({ ...t, _k: uid() }));
    this.extendWith = !q.every((t) => t.local);
    this.load(idx);
  },

  async playRadio(track) {
    this.from = { label: 'Radio basada en', name: track.title }; // label translated when shown
    this.queue = [{ ...track, _k: uid() }];
    this.extendWith = true;
    this.load(0);
    if (track.local) return;
    try {
      const more = await api('upNext', track.id);
      if (this.queue[0]?.id !== track.id) return;
      const seen = new Set(this.queue.map((t) => t.id));
      this.queue.push(...more.filter((t) => !seen.has(t.id) && seen.add(t.id)).map((t) => ({ ...t, _k: uid() })));
      renderQueue();
      this.prepareNext();
    } catch (e) { console.warn('radio', e); }
  },

  playNext(t) {
    if (!this.current) return this.playList([t], 0);
    this.queue.splice(this.index + 1, 0, { ...t, _k: uid() });
    renderQueue(); this.prepareNext();
  },

  enqueue(list) {
    const wasEmpty = !this.current;
    this.queue.push(...list.map((t) => ({ ...t, _k: uid() })));
    if (wasEmpty) this.load(0); else { renderQueue(); this.prepareNext(); }
  },

  removeAt(i) {
    if (i === this.index) { this.queue.splice(i, 1); if (this.queue.length) this.load(Math.min(i, this.queue.length - 1)); else this.stop(); return; }
    this.queue.splice(i, 1);
    if (i < this.index) this.index--;
    renderQueue(); this.prepareNext();
  },

  move(from, to) {
    if (from === to) return;
    const [t] = this.queue.splice(from, 1);
    this.queue.splice(to, 0, t);
    if (this.index === from) this.index = to;
    else if (from < this.index && to >= this.index) this.index--;
    else if (from > this.index && to <= this.index) this.index++;
    renderQueue(); this.prepareNext();
  },

  clearUpcoming() { this.queue.splice(this.index + 1); renderQueue(); this.prepareNext(); },

  stop() {
    engine.stop();
    this.index = -1; this.queue = [];
    updateNowPlaying(); renderQueue(); pushState();
  },

  load(i, { autoplay = true, at = 0 } = {}) {
    if (i < 0 || i >= this.queue.length) return;
    this.index = i;
    this.retries = 0;
    const t = this.current;
    engine.play(t, streamUrl(t), { at, autoplay });
    setLoading(autoplay);
    this.afterTrackChange(t);
  },

  afterTrackChange(t) {
    updateNowPlaying();
    renderQueue();
    persistQueue();
    loadLyrics(t);
    history.push(t);
    this.maybeExtend();
    this.prepareNext();
    // Loudness normalisation needs the resolved stream.
    if (!t.local) api('streamInfo', t.id).then((s) => { if (s && player.current?.id === t.id) engine.cur.setNorm(s.loudnessDb ?? null); }).catch(() => {});
  },

  /** Tell the engine what comes next so it can preload / crossfade / automix. */
  async prepareNext() {
    let ni = -1;
    if (this.repeat === 'one' || this.sleep?.endOfTrack) ni = -1;
    else if (this.index < this.queue.length - 1) ni = this.index + 1;
    else if (this.repeat === 'all' && this.queue.length > 1) ni = 0;
    this.nextIndex = ni;
    const t = this.queue[ni];
    if (!t) { engine.setNext(null); return; }
    let loud = null;
    if (!t.local && ytBlocked()) { engine.setNext(null); return; }
    try { if (!t.local) { await api('prefetch', t.id); loud = (await api('streamInfo', t.id))?.loudnessDb ?? null; } }
    catch (e) {
      // Don't let the engine preload (and analyse) a stream we already know is broken.
      console.warn('prefetch failed', t.title, e.message);
      if (this.queue[this.nextIndex] === t) engine.setNext(null);
      return;
    }
    if (this.queue[this.nextIndex] !== t) return;
    engine.setNext(t, streamUrl(t), loud);
  },

  toggle() {
    if (!this.current) return;
    if (!engine.cur.track) return this.load(this.index);
    engine.toggle();
  },

  next(auto = false) {
    if (!this.queue.length) return;
    if (this.index < this.queue.length - 1) return this.load(this.index + 1);
    if (this.repeat === 'all') return this.load(0);
    if (auto) { engine.playPause(false); engine.seek(0); setPlayIcon(); }
  },

  prev() {
    if (engine.currentTime > 3 || this.index <= 0) { engine.seek(0); return; }
    this.load(this.index - 1);
  },

  setShuffle(on, reorder = true) {
    this.shuffle = on;
    store.set('shuffle', on);
    if (on && reorder && this.index >= 0) {
      const rest = shuffleArr(this.queue.slice(this.index + 1));
      this.queue.splice(this.index + 1, rest.length, ...rest);
      renderQueue(); this.prepareNext();
    }
    $('#shuffle').classList.toggle('on', on);
  },

  cycleRepeat() {
    this.repeat = { off: 'all', all: 'one', one: 'off' }[this.repeat];
    store.set('repeat', this.repeat);
    updateRepeatBtn();
    this.prepareNext();
  },

  async maybeExtend() {
    if (!state.settings.autoplayRadio || !this.extendWith || this.extending || this.repeat !== 'off') return;
    if (this.queue.length - this.index > 2) return;
    const last = [...this.queue].reverse().find((t) => !t.local);
    if (!last) return;
    this.extending = true;
    try {
      const more = await api('upNext', last.id);
      const seen = new Set(this.queue.map((t) => t.id));
      const add = more.filter((t) => !seen.has(t.id) && seen.add(t.id)).map((t) => ({ ...t, _k: uid() }));
      this.queue.push(...add);
      renderQueue();
      this.prepareNext();
    } catch (e) { console.warn('extend', e); }
    this.extending = false;
  },

  setSleep(minutes) {
    clearTimeout(this.sleepTimer);
    if (minutes === null) { this.sleep = null; toast(tr('Temporizador cancelado')); this.prepareNext(); updateMoreBtn(); return; }
    if (minutes === 'track') { this.sleep = { endOfTrack: true }; toast(tr('Se detendrá al terminar esta canción')); engine.setNext(null); updateMoreBtn(); return; }
    this.sleep = { until: Date.now() + minutes * 60000 };
    this.sleepTimer = setTimeout(async () => {
      // Fade out over 8 s, then pause.
      for (let i = 20; i >= 0; i--) { engine.setVolume(volumeGain() * (i / 20)); await new Promise((r) => setTimeout(r, 400)); }
      engine.playPause(false);
      engine.setVolume(volumeGain());
      this.sleep = null; updateMoreBtn();
      toast(tr('Temporizador: reproducción detenida'));
    }, minutes * 60000);
    toast(tr('Se detendrá en {n} min', { n: minutes }));
    updateMoreBtn();
  },
};

function persistQueue() {
  const start = Math.max(0, player.index - 20);
  store.set('queue', { queue: player.queue.slice(start, player.index + 200).map(({ _k, ...t }) => t), index: player.index - start, from: player.from || null });
}
/** What a queue is being played from, read off the page it was started on ("Playlist" · name). */
function playContext() {
  const head = $('#content .detail-head');
  if (head) return { kind: head.querySelector('.kind')?.textContent.trim() || '', name: head.querySelector('h1')?.textContent.trim() || '' };
  const r = currentRoute();
  if (r?.name === 'search') return { kind: tr('Búsqueda'), name: r.q || '' };
  if (r?.name === 'home') return { kind: '', name: tr('Inicio') };
  const title = $('#content .page-title')?.textContent.trim();
  return title ? { kind: '', name: title } : null;
}
function updateFrom() {
  const f = player.from, el = $('#np-from');
  el.hidden = !f?.name;
  if (!f?.name) return;
  // Saved queues may carry the Spanish words: translate them here, when shown.
  el.querySelector('small').textContent = f.label ? tr(f.label) : f.kind ? tr('Reproduciendo desde {kind}', { kind: tr(f.kind).toLowerCase() }) : tr('Reproduciendo desde');
  el.querySelector('b').textContent = f.name;
  el.title = f.name;
}

// engine → UI
engine.addEventListener('playing', () => { setLoading(false); player.failStreak = 0; pushState(); });
engine.addEventListener('pause', () => { setPlayIcon(); pushState(); });
engine.addEventListener('play', () => { setPlayIcon(); pushState(); });
engine.addEventListener('waiting', () => setLoading(true));
engine.addEventListener('canplay', () => setLoading(false));
engine.addEventListener('timeupdate', onTime);
engine.addEventListener('progress', onTime);
engine.addEventListener('ended', () => {
  if (player.repeat === 'one') { engine.seek(0); engine.playPause(true); return; }
  if (player.sleep?.endOfTrack) { player.sleep = null; updateMoreBtn(); engine.playPause(false); engine.seek(0); toast(tr('Temporizador: reproducción detenida')); return; }
  player.next(true);
});
engine.addEventListener('trackchange', (e) => {
  if (!e.detail.auto) return;
  // The engine moved to the preloaded track on its own (gapless / crossfade / automix).
  if (player.nextIndex >= 0 && player.queue[player.nextIndex]?.id === e.detail.track.id) player.index = player.nextIndex;
  else { const i = player.queue.findIndex((t, k) => k > player.index && t.id === e.detail.track.id); if (i >= 0) player.index = i; }
  player.retries = 0;
  player.afterTrackChange(player.current);
  if (e.detail.transition === 'automix') showMixBadge();
});
// ---- YouTube rate limiting: show it, and stop generating traffic while it lasts.
const ytBlock = { until: 0 };
const isBlockedMsg = (m) => /limitado temporalmente|rechazando la reproducción|temporarily limit|refusing playback/i.test(String(m || ''));
const ytBlocked = () => Date.now() < ytBlock.until;
function showYtBanner(st) {
  const prevUntil = ytBlock.until;
  ytBlock.until = st?.blocked ? st.until : 0;
  ytBlock.scope = st?.scope || 'all';
  // A new, longer block brings the full notice back even if it was minimised.
  if (ytBlock.until > prevUntil + 1000 && prevUntil) ytBlock.minimised = false;
  let b = $('#yt-banner'), chip = $('#yt-chip');
  if (!b) {
    b = h('<div id="yt-banner" hidden></div>'); document.body.append(b);
    chip = h(`<button id="yt-chip" class="yt-chip" hidden title="${tr('YouTube está limitando las peticiones — pulsa para ver el aviso')}"></button>`);
    $('#account-btn').before(chip);
    chip.onclick = () => { ytBlock.minimised = false; draw(); };
  }
  function draw() {
    const left = Math.max(0, ytBlock.until - Date.now());
    if (!left) { b.hidden = true; chip.hidden = true; ytBlock.minimised = false; clearInterval(showYtBanner.t); return; }
    const m = Math.floor(left / 60000), sec = Math.floor(left / 1000) % 60, clock = `${m}:${String(sec).padStart(2, '0')}`;
    b.hidden = !!ytBlock.minimised;
    chip.hidden = !ytBlock.minimised;
    chip.innerHTML = `${icon('warning')}<span>${clock}</span>`;
    if (!b.hidden) {
      const msg = ytBlock.scope === 'playback'
        ? `<b>${tr('YouTube está rechazando la reproducción desde tu conexión')}</b><div class="muted small">${tr('Todas las formas de obtener el audio han fallado en varias canciones seguidas. BitChord deja de intentarlo durante {clock} para no empeorarlo. Puedes seguir navegando; la música local y las descargas funcionan.', { clock })}</div>`
        : `<b>${tr('YouTube está limitando las peticiones de tu conexión')}</b><div class="muted small">${tr('Ha detectado demasiadas peticiones seguidas. BitChord deja de pedir nada durante {clock} para que el bloqueo se levante cuanto antes. La música local y las descargas siguen funcionando.', { clock })}</div>`;
      b.innerHTML = `${icon('info')}<div>${msg}</div><button class="icon-btn yt-x" title="${tr('Ocultar (seguirá arriba a la derecha)')}">${icon('close')}</button>`;
      b.querySelector('.yt-x').onclick = () => { b.classList.add('leaving'); setTimeout(() => { b.classList.remove('leaving'); ytBlock.minimised = true; draw(); }, 250); };
    }
  }
  showYtBanner.draw = draw;
  draw();
  clearInterval(showYtBanner.t);
  if (ytBlocked()) showYtBanner.t = setInterval(draw, 1000);
}

engine.addEventListener('error', async (e) => {
  const t = player.current;
  if (!t) return;
  const at = e.detail?.time || 0;
  player.retries = (player.retries || 0) + 1;
  let msg = null;
  if (player.retries <= 2 && !t.local && !ytBlocked()) {
    try {
      await api('refreshStream', t.id);
      engine.reloadCurrent(streamUrl(t) + (streamUrl(t).includes('?') ? '&' : '?') + 'r=' + Date.now(), at);
      return;
    } catch (err) { msg = err.message; }
  }
  setLoading(false);
  player.failStreak = (player.failStreak || 0) + 1;
  if (ytBlocked() || isBlockedMsg(msg)) {
    // Skipping ahead would only fire more requests at YouTube and prolong the block.
    engine.playPause(false); setPlayIcon();
    toast(msg && isBlockedMsg(msg) ? msg : tr('YouTube está limitando las peticiones; la reproducción se ha pausado.'), true);
    return;
  }
  toast(msg ? `«${t.title}»: ${msg.slice(0, 220)}` : tr('No se pudo reproducir «{name}»', { name: t.title }), true);
  if (player.failStreak >= 3) {
    engine.playPause(false); setPlayIcon();
    toast(tr('Han fallado varias canciones seguidas, así que he pausado la cola en vez de seguir saltando.'), true);
    return;
  }
  if (player.index < player.queue.length - 1) setTimeout(() => player.next(), 1500);
});
const preloadRetried = new Set();
engine.addEventListener('preload-error', () => {
  const n = player.queue[player.nextIndex];
  if (!n || n.local || ytBlocked() || preloadRetried.has(n.id)) return;
  preloadRetried.add(n.id);
  api('refreshStream', n.id).catch(() => {});
});

function setLoading(on) {
  const b = $('#play');
  if (on && !engine.paused) { b.classList.add('loading'); b.innerHTML = icon('loading'); }
  else setPlayIcon();
}
function setPlayIcon() {
  const b = $('#play');
  b.classList.remove('loading');
  b.innerHTML = icon(engine.paused ? 'play' : 'pause');
  b.title = tr(engine.paused ? 'Reproducir' : 'Pausa');
  $('#nowplaying').classList.toggle('paused', !!engine.paused);
  document.body.classList.toggle('ambient-paused', !!engine.paused);
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = engine.paused ? 'paused' : 'playing';
}
function updateRepeatBtn() {
  const b = $('#repeat');
  b.innerHTML = icon(player.repeat === 'one' ? 'repeatOne' : 'repeat');
  b.classList.toggle('on', player.repeat !== 'off');
  b.title = tr({ off: 'Repetir: no', all: 'Repetir: todo', one: 'Repetir: una' }[player.repeat]);
}
function updateMoreBtn() { for (const b of [$('#btn-more'), $('#fs-more')]) b.classList.toggle('on', !!player.sleep || engine.speed !== 1); }

let lastMediaPos = 0;
function onTime() {
  const d = engine.duration || player.current?.duration || 0;
  const c = engine.currentTime || 0;
  if (!seekDrag) {
    $('#t-cur').textContent = fmt(c);
    $('#seek .fill').style.width = d ? (c / d) * 100 + '%' : '0';
    $('#seek .knob').style.left = d ? (c / d) * 100 + '%' : '0';
  }
  $('#t-dur').textContent = fmt(d);
  const b = engine.buffered;
  if (b.length && d) $('#seek .buffered').style.width = (b.end(b.length - 1) / d) * 100 + '%';
  if ('mediaSession' in navigator && d && Math.abs(c - lastMediaPos) > 1) {
    lastMediaPos = c;
    try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(c, d), playbackRate: engine.speed }); } catch {}
  }
  if ($('#play').classList.contains('loading') && !engine.paused && engine.audio.readyState >= 3) setPlayIcon();
}

// Main process (Discord, scrobbling, taskbar) gets the state every 2 s and on changes.
function pushState() {
  const t = player.current;
  const { _k, ...track } = t || {};
  bc.playerState({ track: t ? track : null, playing: !!t && !engine.paused, position: engine.currentTime, duration: engine.duration });
  bc.setProgress(t && engine.duration && !engine.paused ? engine.currentTime / engine.duration : -1);
}
setInterval(pushState, 2000);

// ------------------------------------------------------------------ sliders
let seekDrag = false;
export function slider(el, onChange, onCommit) {
  const at = (e) => { const r = el.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    onChange(at(e));
    const move = (ev) => onChange(at(ev));
    const up = (ev) => { el.classList.remove('dragging'); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); onCommit?.(at(ev)); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  });
}
slider($('#seek'), (p) => {
  seekDrag = true;
  const d = engine.duration || 0;
  $('#seek .fill').style.width = p * 100 + '%';
  $('#seek .knob').style.left = p * 100 + '%';
  $('#t-cur').textContent = fmt(p * d);
}, (p) => { seekDrag = false; if (engine.duration) engine.seek(p * engine.duration); pushState(); });

let muted = false;
const volumeGain = () => { const v = store.get('volume', 0.8); return muted ? 0 : v * v; };
function setVolume(v, save = true) {
  v = Math.min(1, Math.max(0, v));
  if (save) store.set('volume', v);
  muted = false;
  engine.setVolume(v * v);
  $('#volume .fill').style.width = v * 100 + '%';
  $('#volume .knob').style.left = v * 100 + '%';
  $('#mute').innerHTML = icon(v === 0 ? 'volumeOff' : 'volume');
  $('#mute').classList.remove('on');
  syncFsVolume();
}
let fsVolTimer = null;
/** Full screen: slide the volume bar in, and out again after a moment unless it's in use. */
function peekFsVolume(ms = 1800) {
  if (!isFs()) return;
  document.body.classList.add('fs-vol-show');
  clearTimeout(fsVolTimer);
  fsVolTimer = setTimeout(() => {
    if ($('#fs-vol').matches(':hover') || $('#fs-vol-bar').classList.contains('dragging')) return peekFsVolume(ms);
    document.body.classList.remove('fs-vol-show');
  }, ms);
}
function syncFsVolume() {
  peekFsVolume();
  const v = muted ? 0 : store.get('volume', 0.8);
  $('#fs-vol-bar .fill').style.height = v * 100 + '%';
  $('#fs-vol-bar .knob').style.bottom = v * 100 + '%';
  $('#fs-vol-pct').textContent = Math.round(v * 100) + '%';
  $('#fs-mute').innerHTML = icon(v === 0 ? 'volumeOff' : 'volume');
}
slider($('#volume'), (p) => setVolume(p));
$('#volume').addEventListener('wheel', (e) => { e.preventDefault(); setVolume(store.get('volume', 0.8) + (e.deltaY < 0 ? 0.05 : -0.05)); });
$('#mute').onclick = () => {
  muted = !muted;
  engine.setVolume(volumeGain());
  $('#mute').innerHTML = icon(muted ? 'volumeOff' : 'volume');
  $('#mute').classList.toggle('on', muted);
  syncFsVolume();
};
{
  // Vertical volume bar of the full-screen mode.
  const bar = $('#fs-vol-bar');
  const at = (e) => { const r = bar.getBoundingClientRect(); return Math.min(1, Math.max(0, (r.bottom - e.clientY) / r.height)); };
  bar.addEventListener('pointerdown', (e) => {
    bar.setPointerCapture(e.pointerId); bar.classList.add('dragging'); setVolume(at(e));
    const move = (ev) => setVolume(at(ev));
    const up = () => { bar.classList.remove('dragging'); bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', up); };
    bar.addEventListener('pointermove', move); bar.addEventListener('pointerup', up);
  });
  $('#fs-vol').addEventListener('wheel', (e) => { e.preventDefault(); setVolume(store.get('volume', 0.8) + (e.deltaY < 0 ? 0.05 : -0.05)); });
  $('#fs-mute').onclick = () => $('#mute').click();
  $('#nowplaying').addEventListener('mousemove', (e) => { if (isFs() && e.clientX < 150) peekFsVolume(); });
}

// ------------------------------------------------------------------ full-screen mode
const isFs = () => document.body.classList.contains('fs');
/** Asks the window to go full screen (or back); the main process answers with 'fullscreen'. */
function setFullscreen(on) {
  if (on && !player.current) return toast(tr('No hay nada sonando'));
  if (on) openNowPlaying();
  bc.setFullscreen(on);
}
/** Applies the full-screen layout: the player bar's controls move under the artwork. */
const FS_BUTTONS = [
  // key, label, icon, group
  ['queue', tr('Cola'), 'queue', 'side'], ['eq', tr('Ecualizador'), 'equalizer', 'side'],
  ['lyricsSource', tr('Cambiar la fuente de la letra'), 'lyrics', 'side'], ['lyricsToggle', tr('Mostrar u ocultar la letra'), 'subtitlesOff', 'side'],
  ['vis', tr('Visualizador y sus presets'), 'visualizer', 'side'],
  ['like', tr('Favorito'), 'heart', 'play'], ['shuffle', tr('Aleatorio'), 'shuffle', 'play'], ['repeat', tr('Repetir'), 'repeat', 'play'],
  ['more', tr('Más opciones (temporizador, velocidad…)'), 'more', 'play'],
];
function applyFsButtons() {
  const on = state.settings.fsButtons || {};
  for (const [k] of FS_BUTTONS) document.body.classList.toggle(`fs-hide-${k}`, on[k] === false);
}
/** Settings of the full-screen mode: which buttons it shows. Opens in the middle, over a blur. */
function fsSettings() {
  const m = h(`<div class="modal-back fs-set-back"><div class="modal fs-set">
    <h3>${tr('Ocultar/Mostrar botones en pantalla completa')}</h3>
    <h4>${tr('Columna de la derecha')}</h4><div data-g="side"></div>
    <h4>${tr('Controles de reproducción')}</h4><div data-g="play"></div>
    <div class="btn-row"><button class="btn primary small" data-a="ok">${tr('Listo')}</button></div>
  </div></div>`);
  for (const [k, label, ic, g] of FS_BUTTONS) {
    const row = h(`<label class="fs-opt">${icon(ic)}<span class="fs-lbl">${esc(label)}</span><span class="switch" style="flex:none"><input type="checkbox"${(state.settings.fsButtons || {})[k] !== false ? ' checked' : ''}><span></span></span></label>`);
    row.querySelector('input').onchange = (e) => saveSettings({ fsButtons: { ...(state.settings.fsButtons || {}), [k]: e.target.checked } });
    m.querySelector(`[data-g=${g}]`).append(row);
  }
  const close = () => { m.remove(); document.body.classList.remove('fs-set-open'); document.removeEventListener('keydown', key, true); };
  const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  m.querySelector('[data-a=ok]').onclick = close;
  document.body.classList.add('fs-set-open');
  m.addEventListener('mousedown', (e) => { if (e.target === m) close(); });
  document.addEventListener('keydown', key, true);
  document.body.append(m);
}
let fsPanelKind = null, fsPanelGen = 0, fsPanelTimer = null;
/** Full screen: side panel (same place and animation as the queue) with a menu or the EQ. */
function openFsPanel(kind, title, body) {
  const p = $('#fs-panel');
  if (!$('#queue').hidden) toggleQueue(false);
  clearTimeout(fsPanelTimer);
  fsPanelGen++;
  fsPanelKind = kind;
  p.querySelector('h3').textContent = title;
  p.querySelector('.fs-panel-body').replaceChildren(body);
  p.classList.remove('closing');
  p.dataset.kind = kind;
  p.hidden = false;
  document.body.style.setProperty('--fs-panel-w', p.offsetWidth + 'px');
  document.body.classList.add('panel-open');
  syncFsPanelButtons();
}
function closeFsPanel() {
  const p = $('#fs-panel');
  if (p.hidden || p.classList.contains('closing')) return;
  fsPanelKind = null;
  document.body.classList.remove('panel-open');
  syncFsPanelButtons();
  p.classList.add('closing');
  fsPanelTimer = setTimeout(() => { p.hidden = true; p.classList.remove('closing'); }, 300);
}
// ------------------------------------------------------------------ visualizer
function applyVis() {
  const on = !!state.settings.visualizer;
  document.body.classList.toggle('vis-on', on);
  $('#np-vis-toggle').classList.toggle('on', on);
  $('#np-vis-toggle').title = tr(on ? 'Volver a portada y letra (V)' : 'Visualizador (V)');
  if (on && npOpen()) mountVisualizer($('#nowplaying'), engine);
  if (!on) { unmountVisualizer(); if (fsPanelKind === 'vis') closeFsPanel(); }
}
/** Presets panel: another one at random, when to change on its own, search and the list. */
function toggleVisPanel() {
  if (fsPanelKind === 'vis') return closeFsPanel();
  const root = h(`<div class="vis-panel">
    <div class="vis-row">
      <button class="btn ghost small" data-a="rand" title="${tr('Otro preset al azar')}">${icon('shuffle')}${tr('Al azar')}</button>
      <select class="select" data-a="auto" title="${tr('Cuándo cambia de preset solo')}">
        <option value="song">${tr('Con cada canción')}</option><option value="30">${tr('Cada 30 segundos')}</option>
        <option value="60">${tr('Cada minuto')}</option><option value="off">${tr('Siempre el mismo')}</option>
      </select>
    </div>
    <div class="vis-tabs"><span class="vis-tab-pill"></span><button data-t="all">${tr('Todos')}</button><button data-t="fav">${tr('Favoritos')}</button></div>
    <input class="text" type="search" placeholder="${tr('Buscar preset…')}" spellcheck="false">
    <div class="vis-list"></div>
  </div>`);
  const list = root.querySelector('.vis-list'), search = root.querySelector('input'), auto = root.querySelector('select');
  auto.value = String(state.settings.visAuto || 'song');
  auto.onchange = () => saveSettings({ visAuto: auto.value });
  root.querySelector('[data-a=rand]').onclick = () => randomPreset();
  search.addEventListener('keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation(); });
  // Tabs: all the presets, or only the starred ones (then "Al azar" and the automatic changes
  // also pick among the favourites).
  const tabs = root.querySelector('.vis-tabs');
  tabs.onclick = (e) => {
    const t = e.target.closest('[data-t]');
    const fav = t?.dataset.t === 'fav';
    if (!t || fav === !!state.settings.visUseFavs) return;
    // The pill slides at once; the list slides in from the side of the tab that was picked.
    tabs.classList.toggle('fav', fav);
    saveSettings({ visUseFavs: fav }).then(() => {
      draw();
      list.classList.remove('slide-l', 'slide-r');
      void list.offsetWidth; // restart the animation
      list.classList.add(fav ? 'slide-l' : 'slide-r');
    });
  };
  list.onclick = (e) => {
    const row = e.target.closest('.vis-item');
    if (!row) return;
    if (e.target.closest('.vis-fav')) toggleFavorite(row.dataset.name);
    else pickPreset(row.dataset.name);
  };
  const draw = () => {
    if (!root.isConnected && list.childElementCount) return off();
    const favOnly = !!state.settings.visUseFavs;
    const favs = new Set(favorites());
    tabs.classList.toggle('fav', favOnly);
    tabs.querySelector('[data-t=all]').classList.toggle('on', !favOnly);
    tabs.querySelector('[data-t=fav]').classList.toggle('on', favOnly);
    tabs.querySelector('[data-t=fav]').textContent = favs.size ? `${tr('Favoritos')} · ${favs.size}` : tr('Favoritos');
    const q = search.value.trim().toLowerCase();
    const names = presetNames().filter((n) => (!favOnly || favs.has(n)) && (!q || n.toLowerCase().includes(q)));
    list.replaceChildren();
    if (!presetNames().length) return list.append(h(`<div class="vis-empty">${tr('Cargando los presets…')}</div>`));
    if (favOnly && !favs.size) return list.append(h(`<div class="vis-empty">${tr('Aún no tienes favoritos')}</div>`));
    if (!names.length) return list.append(h(`<div class="vis-empty">${tr('Ningún preset coincide.')}</div>`));
    const cur = currentPreset();
    for (const n of names) {
      const fav = favs.has(n);
      list.append(h(`<div class="vis-item${n === cur ? ' checked' : ''}" data-name="${esc(n)}">
        <button class="vis-pick">${icon(n === cur ? 'check' : '')}<span class="ellipsis">${esc(n)}</span></button>
        <button class="vis-fav${fav ? ' on' : ''}" title="${tr(fav ? 'Quitar de favoritos' : 'Añadir a favoritos')}">${icon(fav ? 'starFill' : 'star')}</button>
      </div>`));
    }
    // First time: bring the current preset into view (scrolling the list only, never the window).
    const c = list.querySelector('.checked');
    if (c && !draw.done) { draw.done = true; list.scrollTop = c.offsetTop - list.offsetTop - (list.clientHeight - c.offsetHeight) / 2; }
  };
  const off = onVisChange(draw);
  search.addEventListener('input', draw);
  openFsPanel('vis', tr('Visualizador'), root);
  draw();
}
function syncFsPanelButtons() {
  $('#np-vis-presets').classList.toggle('on', fsPanelKind === 'vis');
  $('#fs-eq').classList.toggle('on', fsPanelKind === 'eq');
  // The panel already says which source is in use: keep the pill folded, just highlighted.
  $('#lyrics-source').classList.remove('open');
  $('#lyrics-source').classList.toggle('on', fsPanelKind === 'lyrics-source');
}
function applyFullscreen(on) {
  document.body.classList.toggle('fs', on);
  const center = $('.p-center');
  if (on) $('#np-fs-slot').append(center);
  else $('#player .p-left').after(center);
  $('#btn-fs').innerHTML = icon(on ? 'fullscreenExit' : 'fullscreen');
  $('#btn-fs').title = tr(on ? 'Salir de pantalla completa (Esc)' : 'Pantalla completa (F11)');
  $('#btn-fs').classList.toggle('on', on);
  if (on && !npOpen()) openNowPlaying();
  if (on) peekFsVolume(2500); else document.body.classList.remove('fs-vol-show');
  closeFsPanel();
  if (!on) toggleEq(false);
}

// ------------------------------------------------------------------ now playing / theming
let visTrackKey = null;
function updateNowPlaying() {
  const t = player.current;
  updateFrom();
  if (t?._k !== visTrackKey) { visTrackKey = t?._k; visOnTrackChange(); }
  $('#np-album').textContent = t ? [t.album?.name, t.year].filter(Boolean).join(' • ') : '';
  $('#p-title').textContent = t ? t.title : tr('Nada sonando');
  $('#p-artist').innerHTML = t ? (t.artists || []).map((a) => a.id ? `<span class="link" data-artist="${esc(a.id)}">${esc(a.name)}</span>` : esc(a.name)).join(', ') : tr('Busca algo para empezar');
  $('#p-art').src = art(t?.thumb);
  $('#np-art').src = art(t?.thumb);
  $('#np-title').textContent = t?.title || '';
  $('#np-artist').textContent = t ? artistNames(t) : '';
  $('#np-stats').textContent = '';
  $('.np-bg').style.backgroundImage = t?.thumb ? `url("${art(t.thumb)}")` : '';
  document.documentElement.style.setProperty('--amb-img', t?.thumb ? `url("${art(t.thumb)}")` : 'none');
  markPlaying();
  applyAccent(t?.thumb);
  updateLikeButtons();
  if ('mediaSession' in navigator) {
    const a = art(t?.thumb);
    navigator.mediaSession.metadata = t ? new MediaMetadata({
      title: t.title, artist: artistNames(t), album: t.album?.name || '',
      artwork: a ? [{ src: a, sizes: '544x544', type: 'image/jpeg' }] : [],
    }) : null;
  }
  pushState();
  if (t) setTimeout(updateStats, 2500);
}

async function updateStats() {
  const t = player.current;
  if (!t) return;
  let s = null;
  try { s = t.local ? { codec: t.codec, bitrate: t.bitrate, client: t.remote ? 'WebDAV' : tr('archivo local'), sampleRate: t.sampleRate } : await api('streamInfo', t.id); } catch {}
  if (player.current?.id !== t.id) return;
  const an = engine.analysisFor(t.id);
  const sr = s?.sampleRate || engine.ctx.sampleRate;
  const parts = [
    s?.codec && s.codec.toUpperCase(),
    s?.bitrate && s.bitrate + ' kbps',
    sr && (sr / 1000).toFixed(1) + ' kHz',
    s?.loudnessDb != null && (s.loudnessDb > 0 ? '+' : '') + Number(s.loudnessDb).toFixed(1) + ' dB',
    an?.bpm && Math.round(an.bpm) + ' BPM',
    s?.client,
  ].filter(Boolean);
  $('#np-stats').textContent = parts.join(' · ');
}

function markPlaying() {
  const id = player.current?.id;
  $$('#content .row').forEach((r) => r.classList.toggle('playing', r.dataset.id === id));
}

let accentFor = null;
function applyAccent(src) {
  accentFor = src;
  const root = document.documentElement.style;
  const mode = accentMode();
  const dyn = mode === 'cover';
  const clearAccent = () => {
    if (mode === 'custom') return applyCustomAccent();
    root.removeProperty('--accent'); root.removeProperty('--accent-soft');
  };
  if (!src) { clearAccent(); setAmbientColors(null); return; }
  if (!dyn) clearAccent();
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    if (accentFor !== src) return;
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 32;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0, 32, 32);
      const d = g.getImageData(0, 0, 32, 32).data;
      const buckets = new Map();
      for (let i = 0; i < d.length; i += 4) {
        const key = (d[i] >> 5) << 6 | (d[i + 1] >> 5) << 3 | (d[i + 2] >> 5);
        const e = buckets.get(key) || { r: 0, g: 0, b: 0, n: 0 };
        e.r += d[i]; e.g += d[i + 1]; e.b += d[i + 2]; e.n++;
        buckets.set(key, e);
      }
      const ranked = [...buckets.values()].map((e) => {
        const [hh, s, l] = rgbToHsl(e.r / e.n, e.g / e.n, e.b / e.n);
        return { hh, s, l, n: e.n, score: s * (1 - Math.abs(l - 0.55) * 1.6) * Math.sqrt(e.n) };
      }).sort((x, y) => y.score - x.score);
      const best = ranked[0];
      if (dyn) {
        if (!best || best.s < 0.18) clearAccent();
        else {
          root.setProperty('--accent', `hsl(${Math.round(best.hh * 360)} ${Math.round(Math.min(0.9, Math.max(0.55, best.s)) * 100)}% 60%)`);
          root.setProperty('--accent-soft', `hsla(${Math.round(best.hh * 360)}, ${Math.round(best.s * 100)}%, 50%, .22)`);
        }
      }
      // Ambient background: the two or three most prominent, clearly different colours.
      const picks = [];
      const hueDist = (a1, a2) => Math.min(Math.abs(a1 - a2), 1 - Math.abs(a1 - a2));
      for (const c2 of ranked) {
        if (c2.n < 6 && picks.length) continue;
        if (picks.every((p) => hueDist(p.hh, c2.hh) > 0.07 || Math.abs(p.l - c2.l) > 0.3)) picks.push(c2);
        if (picks.length === 3) break;
      }
      // Fallback for one-colour covers: neighbours of the main hue.
      while (picks.length && picks.length < 3) { const p0 = picks[0]; picks.push({ ...p0, hh: (p0.hh + (picks.length === 1 ? 0.08 : 0.92)) % 1, l: Math.max(0.25, p0.l - 0.12) }); }
      setAmbientColors(picks.map((p) => `hsl(${Math.round(p.hh * 360)} ${Math.round(Math.max(0.35, Math.min(0.95, p.s)) * 100)}% ${Math.round(Math.max(0.32, Math.min(0.62, p.l)) * 100)}%)`));
    } catch (e) { console.warn('accent', e); }
  };
  img.src = proxied(src);
}

export function accentMode() {
  const st = state.settings;
  return st.accentMode || (st.dynamicAccent === false ? 'theme' : 'cover');
}
/** A colour chosen by hand in Ajustes > Tema (hex, optionally with alpha). */
export function applyCustomAccent(hex = state.settings.customAccent) {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex || '');
  if (!m) return;
  const n = parseInt(m[1], 16), r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255;
  const a = m[2] ? parseInt(m[2], 16) / 255 : 1;
  const root = document.documentElement.style;
  root.setProperty('--accent', `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`);
  root.setProperty('--accent-soft', `rgba(${r}, ${g}, ${b}, ${(0.22 * a).toFixed(3)})`);
}

// ---- animated ambient background (colours of the current cover)
function setAmbientColors(colors) {
  const root = document.documentElement.style;
  const list = colors && colors.length ? colors : ['var(--accent)', 'var(--accent)', 'var(--surface-2)'];
  list.forEach((c, i) => root.setProperty(`--amb${i + 1}`, c));
}
export function applyAmbient() {
  const st = state.settings;
  const root = document.documentElement.style;
  const on = st.ambient !== false;
  document.body.classList.toggle('ambient-on', on);
  document.body.classList.toggle('ambient-cover', (st.ambientMode || 'cover') === 'cover');
  root.setProperty('--amb-int', String((st.ambientIntensity ?? 45) / 100));
  root.setProperty('--amb-blur', `${st.ambientBlur ?? 110}px`);
  root.setProperty('--amb-size', `${st.ambientSize ?? 100}`);
  root.setProperty('--amb-sat', String((st.ambientSaturation ?? 100) / 100));
  const speed = st.ambientSpeed ?? 35;
  root.setProperty('--amb-dur', `${speed > 0 ? Math.round(90 - speed * 0.8) : 60}s`);
  document.body.classList.toggle('ambient-still', speed <= 0);
}
export function applyMica() {
  const st = state.settings;
  const root = document.documentElement.style;
  const b = document.body.classList;
  b.toggle('no-mica-sidebar', st.micaSidebar === false);
  b.toggle('no-mica-queue', st.micaQueue === false);
  b.toggle('no-mica-player', st.micaPlayer === false);
  b.toggle('no-mica-lyrics', st.micaLyrics === false);
  root.setProperty('--mica-op', String((st.micaTint ?? 50) / 100));
  root.setProperty('--mica-blur', `${st.micaBlur ?? 50}px`);
  root.setProperty('--mica-sat', String((st.micaSaturation ?? 190) / 100));
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let hh = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    hh = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    hh /= 6;
  }
  return [hh, s, l];
}

function showMixBadge() {
  const b = $('#mix-badge');
  b.hidden = false;
  clearTimeout(showMixBadge.t);
  showMixBadge.t = setTimeout(() => (b.hidden = true), 5000);
}

let npCloseTimer = null;
function openNowPlaying() {
  if (!player.current) return toast(tr('No hay nada sonando'));
  const np = $('#nowplaying');
  clearTimeout(npCloseTimer); np.classList.remove('closing');
  // Cover and lyrics (and full screen) get the whole window: the queue tucks itself away until
  // its button brings it back, and comes back by itself when this view closes.
  if (np.hidden && !$('#queue').hidden && !$('#queue').classList.contains('closing')) { toggleQueue(false, { remember: false }); queueAutoHidden = true; }
  np.hidden = false;
  document.body.classList.add('np-open');
  $('#btn-lyrics').classList.add('on');
  $('#nav-nowplaying')?.classList.add('active');
  applyLyricsHidden();
  renderLyrics();
  updateStats();
  if (state.settings.visualizer) mountVisualizer($('#nowplaying'), engine);
}
function applyLyricsHidden() {
  const off = !!state.settings.npLyricsHidden;
  $('#nowplaying').classList.toggle('no-lyrics', off);
  const b = $('#np-lyrics-toggle');
  b.innerHTML = icon(off ? 'subtitles' : 'subtitlesOff');
  b.title = tr(off ? 'Mostrar la letra' : 'Ocultar la letra (solo portada)');
}
function closeNowPlaying() {
  const np = $('#nowplaying');
  if (np.hidden || np.classList.contains('closing')) return;
  if (isFs()) setFullscreen(false);
  $('#btn-lyrics').classList.remove('on');
  $('#nav-nowplaying')?.classList.remove('active');
  // Slide/fade out first; the title bar keeps the artwork tone until the view is gone.
  np.classList.add('closing');
  npCloseTimer = setTimeout(() => { np.hidden = true; np.classList.remove('closing'); document.body.classList.remove('np-open'); unmountVisualizer(); }, 230);
  if (fsPanelKind === 'vis') closeFsPanel();
  if (queueAutoHidden) { queueAutoHidden = false; toggleQueue(true, { remember: false }); }
}
const npOpen = () => !$('#nowplaying').hidden && !$('#nowplaying').classList.contains('closing');

// ------------------------------------------------------------------ lyrics (provider order from settings)
let providerMeta = [];
async function loadLyrics(t, forced = null) {
  player.lyrics = { loading: true, id: t.id };
  if (npOpen()) renderLyrics();
  const order = forced ? [forced] : (state.settings.lyricsOrder || []).filter((id) => !(state.settings.lyricsDisabled || []).includes(id));
  const q = { id: t.id, title: t.title, artists: t.artists, album: t.album, duration: t.duration || Math.round(engine.duration) || 0 };
  // Ask a few providers at a time and pick by the user's order; synced beats plain.
  const inflight = new Map();
  const launch = (i) => { const p = order[i]; if (p && !inflight.has(p)) inflight.set(p, api('lyrics', q, p).then(parseResult).catch(() => null)); };
  let plain = null, result = null;
  for (let i = 0; i < order.length; i++) {
    launch(i); launch(i + 1); launch(i + 2);
    const r = await inflight.get(order[i]);
    if (player.current?.id !== t.id) return;
    if (r?.synced) { result = { ...r, provider: order[i] }; break; }
    if (r?.plain && !plain) plain = { ...r, provider: order[i] };
  }
  result = result || plain || { synced: false, lines: [], plain: '', provider: null };
  if (player.current?.id !== t.id) return;
  player.lyrics = { ...result, id: t.id, forced };
  if (npOpen()) renderLyrics();
}

let activeLine = -1;
let wordEls = [];
function renderLyrics() {
  const box = $('#lyrics');
  const l = player.lyrics;
  activeLine = -1; wordEls = [];
  box.className = '';
  box.innerHTML = '';
  box.style.setProperty('--lyr-size', (state.settings.lyricsFontSize || 30) + 'px');
  const label = providerMeta.find((p) => p.id === l?.provider)?.label;
  $('#lyrics-source').innerHTML = `${icon('lyrics')}<span class="pill-label"><span>${l?.loading ? tr('Buscando letra…') : label ? label + (l.forced ? '' : ' · auto') : tr('Sin letra')}</span>${icon('chevron')}</span>`;
  $('#lyrics-source').title = tr('Fuente de la letra');
  if (!l || l.loading) { box.innerHTML = '<div class="none"><div class="spinner"></div></div>'; return; }
  const useWords = state.settings.lyricsWordSync !== false;
  if (l.synced && l.lines?.length) {
    l.lines.forEach((ln) => {
      const el = h(`<div class="line${ln.gap || !ln.text ? ' gap' : ''}${ln.align === 'end' ? ' end' : ''}"></div>`);
      const words = [];
      if (ln.gap || !ln.text) el.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
      else if (useWords && ln.words?.length) {
        ln.words.forEach((w, k) => { const s = h(`<span class="w">${esc(w.text)}</span>`); el.append(s); if (k < ln.words.length - 1) el.append(' '); words.push(s); });
      } else el.textContent = ln.text;
      if (ln.bg && ln.bg.text) {
        const bg = h(`<div class="bgv"></div>`);
        if (useWords && ln.bg.words?.length) ln.bg.words.forEach((w, k) => { const s = h(`<span class="w">${esc(w.text)}</span>`); bg.append(s); if (k < ln.bg.words.length - 1) bg.append(' '); words.push(s); });
        else bg.textContent = ln.bg.text;
        el.append(bg);
      }
      el.onclick = () => { engine.seek(ln.time - (state.settings.lyricsOffsetMs || 0) / 1000); if (engine.paused) engine.playPause(true); };
      wordEls.push(words);
      box.append(el);
    });
    box.append(h(`<div class="src">${tr('Letra:')} ${esc(label || '')}</div>`));
    syncLyrics(true);
    return;
  }
  box.classList.add('unsynced');
  if (l.plain) { box.append(h(`<div class="plain">${esc(l.plain)}</div>`)); box.append(h(`<div class="src">${tr('Letra:')} ${esc(label || '')} · ${tr('sin sincronizar')}</div>`)); return; }
  box.innerHTML = `<div class="none">${tr('No hay letra disponible para esta canción')}</div>`;
}

function syncLyrics(force = false) {
  const l = player.lyrics;
  if (!npOpen() || !l?.synced || !l.lines?.length) return;
  const t = engine.currentTime + (state.settings.lyricsOffsetMs || 0) / 1000 + 0.15;
  let i = -1;
  for (let k = 0; k < l.lines.length; k++) { if (l.lines[k].time <= t) i = k; else break; }
  // Word-by-word fill of the active line (and its background vocals).
  if (i >= 0 && wordEls[i]?.length) {
    const ln = l.lines[i];
    const all = [...(ln.words || []), ...(ln.bg?.words || [])];
    wordEls[i].forEach((el, k) => {
      const w = all[k];
      if (!w) return;
      const p = t <= w.start ? 0 : t >= w.end ? 1 : (t - w.start) / Math.max(0.05, w.end - w.start);
      el.style.setProperty('--p', p.toFixed(3));
      el.classList.toggle('sung', p >= 1);
      el.classList.toggle('singing', p > 0 && p < 1);
    });
  }
  if (i === activeLine && !force) return;
  if (activeLine >= 0 && wordEls[activeLine]) wordEls[activeLine].forEach((el) => { el.style.setProperty('--p', 1); el.classList.add('sung'); el.classList.remove('singing'); });
  activeLine = i;
  const els = $$('#lyrics .line');
  els.forEach((el, k) => { el.classList.toggle('active', k === i); el.classList.toggle('past', k < i); });
  const target = els[Math.max(0, i)];
  if (target && !lyricsUserScroll) {
    const box = $('#lyrics');
    box.scrollTo({ top: target.offsetTop - box.clientHeight * 0.38, behavior: force ? 'auto' : 'smooth' });
  }
}
let lyricsUserScroll = false, lyricsScrollTimer;
$('#lyrics').addEventListener('wheel', () => { lyricsUserScroll = true; clearTimeout(lyricsScrollTimer); lyricsScrollTimer = setTimeout(() => (lyricsUserScroll = false), 3000); });
(function loop() { syncLyrics(); requestAnimationFrame(loop); })();

function lyricsSourceMenu(anchor) {
  const t = player.current;
  if (!t) return;
  const cur = player.lyrics;
  anchor.classList.add('open');
  openMenu([
    { header: tr('Fuente de la letra') },
    { icon: 'sparkle', label: tr('Automático (según tu orden)'), checked: !cur?.forced, action: () => loadLyrics(t) },
    null,
    ...providerMeta.map((p) => ({ label: p.label, hint: p.word ? tr('palabra a palabra') : '', checked: cur?.forced === p.id, action: () => loadLyrics(t, p.id) })),
    null,
    { icon: 'settings', label: tr('Ordenar proveedores…'), action: () => go({ name: 'settings', section: 'lyrics' }) },
    null,
    { el: lyricsSliders() },
  ], anchor);
}

/** Text size and offset of the lyrics, adjustable right from the lyrics-source menu (live). */
function lyricsSliders() {
  const st = state.settings;
  const el = h(`<div class="menu-sliders">
    <label><span>${tr('Tamaño del texto')}</span><input type="range" min="20" max="48" step="1" data-k="lyricsFontSize"><b></b></label>
    <label><span>${tr('Desfase')}</span><input type="range" min="-2000" max="2000" step="50" data-k="lyricsOffsetMs"><b></b></label>
  </div>`);
  const show = { lyricsFontSize: (v) => `${v} px`, lyricsOffsetMs: (v) => `${v > 0 ? '+' : ''}${(v / 1000).toFixed(2)} s` };
  el.querySelectorAll('input').forEach((input) => {
    const k = input.dataset.k, out = input.nextElementSibling;
    input.value = st[k] ?? (k === 'lyricsFontSize' ? 30 : 0);
    out.textContent = show[k](+input.value);
    input.oninput = () => {
      out.textContent = show[k](+input.value);
      state.settings = { ...state.settings, [k]: +input.value }; // live: the lyrics follow while dragging
      if (k === 'lyricsFontSize') $('#lyrics').style.setProperty('--lyr-size', input.value + 'px');
      else syncLyrics(true);
    };
    input.onchange = () => saveSettings({ [k]: +input.value });
  });
  return el;
}

// ------------------------------------------------------------------ "more" menu (sleep timer, speed…)
function moreMenu(anchor) {
  const t = player.current;
  const sleepLabel = player.sleep?.until ? tr('termina en {n} min', { n: Math.max(1, Math.round((player.sleep.until - Date.now()) / 60000)) }) : tr(player.sleep?.endOfTrack ? 'al terminar la canción' : 'desactivado');
  openMenu([
    { header: `${tr('Temporizador')} · ${sleepLabel}` },
    ...[15, 30, 45, 60, 90].map((m) => ({ icon: 'timer', label: tr('{n} minutos', { n: m }), action: () => player.setSleep(m) })),
    { icon: 'timer', label: tr('Al terminar la canción'), action: () => player.setSleep('track') },
    ...(player.sleep ? [{ icon: 'close', label: tr('Cancelar temporizador'), action: () => player.setSleep(null) }] : []),
    null,
    { header: `${tr('Velocidad')} · ${engine.speed}×` },
    ...[0.75, 1, 1.25, 1.5].map((s) => ({ icon: 'speed', label: `${s}×`, checked: engine.speed === s, action: () => saveSettings({ speed: s }).then(updateMoreBtn) })),
    null,
    ...(t && !t.local ? [isDownloaded(t.id) ? { icon: 'downloaded', label: tr('Descargada · mostrar archivo'), action: () => api('downloadShow', t.id) } : { icon: 'download', label: tr('Descargar esta canción'), action: () => downloadTracks([t]) }] : []),
  ], anchor);
}

// ------------------------------------------------------------------ equalizer pop-over
function toggleEq(force) {
  if (isFs() || fsPanelKind === 'eq') {
    const show = force != null ? force : fsPanelKind !== 'eq';
    if (show) {
      const body = h('<div></div>');
      const more = h(`<button class="text-btn" style="margin:4px 6px 12px">${tr('Más en Ajustes')}</button>`);
      more.onclick = () => { closeFsPanel(); setFullscreen(false); go({ name: 'settings', section: 'eq' }); };
      body.append(eqPanel({ compact: true }), more);
      openFsPanel('eq', tr('Ecualizador'), body);
    } else if (fsPanelKind === 'eq') closeFsPanel();
    return;
  }
  const pop = $('#eq-pop');
  const show = force != null ? force : pop.hidden;
  if (show && !pop.firstChild) {
    pop.append(h(`<div class="eq-pop-head"><b>${tr('Ecualizador')}</b><button class="text-btn" data-a="more">${tr('Más en Ajustes')}</button></div>`));
    pop.append(eqPanel({ compact: true }));
    pop.querySelector('[data-a=more]').onclick = () => { toggleEq(false); go({ name: 'settings', section: 'eq' }); };
  }
  pop.hidden = !show;
  $('#btn-eq').classList.toggle('on', show);
  $('#fs-eq').classList.toggle('on', show);
}
document.addEventListener('mousedown', (e) => {
  if ($('#eq-pop').hidden || e.target.closest('#eq-pop, #btn-eq, #fs-eq')) return;
  toggleEq(false);
});

// ---- account pop-over (profile button, top right)
function toggleAccountPop(force) {
  const pop = $('#acct-pop');
  const show = force != null ? force : pop.hidden;
  $('#account-btn').classList.toggle('on', show);
  if (!show) { pop.hidden = true; return; }
  const a = state.account;
  pop.innerHTML = '';
  if (a) {
    pop.append(h(`<div class="acct-head">${a.photo ? `<img src="${esc(a.photo)}" alt="">` : `<span class="acct-ph">${icon('account')}</span>`}<div style="min-width:0"><b class="ellipsis">${esc(a.name || tr('Sesión iniciada'))}</b><div class="muted small ellipsis">${esc(a.handle || a.email || tr('Cuenta de Google'))}</div></div></div>`));
    const out = h(`<button class="acct-item danger">${icon('logout')}<span>${tr('Cerrar sesión')}</span></button>`);
    out.onclick = async () => {
      out.disabled = true;
      try { await api('logout'); await refreshAccount(); toast(tr('Sesión cerrada')); toggleAccountPop(false); refreshView(); }
      catch (e) { toast(e.message, true); out.disabled = false; }
    };
    pop.append(h('<div class="acct-sep"></div>'), out);
  } else {
    pop.append(h(`<div class="acct-head"><span class="acct-ph">${icon('account')}</span><div><b>${tr('Sin sesión')}</b><div class="muted small">${tr('Inicia sesión para ver tus playlists y recomendaciones')}</div></div></div>`));
    const login = h(`<button class="acct-item">${icon('account')}<span>${tr('Iniciar sesión con Google')}</span></button>`);
    login.onclick = async () => {
      login.disabled = true; toggleAccountPop(false);
      try { const r = await api('login'); if (r !== null) { await refreshAccount(); toast(tr('Sesión iniciada')); refreshView(); } }
      catch (e) { toast(e.message, true); }
    };
    pop.append(h('<div class="acct-sep"></div>'), login);
  }
  const r = $('#account-btn').getBoundingClientRect();
  pop.style.right = Math.max(8, innerWidth - r.right - 6) + 'px';
  pop.hidden = false;
}
document.addEventListener('mousedown', (e) => {
  if ($('#acct-pop').hidden || e.target.closest('#acct-pop, #account-btn')) return;
  toggleAccountPop(false);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#acct-pop').hidden) toggleAccountPop(false); });

// ------------------------------------------------------------------ sidebar visibility (fixed / hover / button)
let sbHideTimer;
function setupSidebarMode() {
  const hot = $('#sb-hot'), sb = $('#sidebar');
  hot.addEventListener('mouseenter', () => { if (document.body.classList.contains('sb-hover')) { clearTimeout(sbHideTimer); document.body.classList.add('sb-show'); } });
  sb.addEventListener('mouseenter', () => clearTimeout(sbHideTimer));
  sb.addEventListener('mouseleave', () => {
    if (!document.body.classList.contains('sb-hover')) return;
    clearTimeout(sbHideTimer);
    sbHideTimer = setTimeout(() => document.body.classList.remove('sb-show'), 250);
  });
  // Clicking an item in hover mode also tucks the bar away.
  sb.addEventListener('click', (e) => { if (document.body.classList.contains('sb-hover') && e.target.closest('.nav-item')) document.body.classList.remove('sb-show'); });
  applySidebarMode();
  applyTheme();
  applyAmbient();
  applyMica();
  applyWindowButtons();
}
/** macOS-style window buttons (red/yellow/green on the left) or the native Windows ones. */
function applyWindowButtons() {
  const mac = (state.settings.windowButtons || 'mac') === 'mac';
  document.body.classList.toggle('mac-buttons', mac);
  $('#titlebar .traffic').hidden = !mac;
}
export function applyTheme() {
  delete document.documentElement.dataset.theme; // the old built-in themes are gone
  const t = (state.settings.customThemes || []).find((x) => x.id === state.settings.theme);
  setThemeCss(t ? t.css : '');
  applyAccent(player.current?.thumb);
}
/** The CSS of a custom theme goes in a <style> after styles.css, so its :root rules win. */
export function setThemeCss(css) {
  let el = document.getElementById('user-theme');
  if (!el) { el = document.createElement('style'); el.id = 'user-theme'; document.head.append(el); }
  el.textContent = css || '';
}
function applySidebarMode() {
  const mode = state.settings.sidebarMode || 'fixed';
  const b = document.body.classList;
  b.toggle('sb-hover', mode === 'hover');
  b.toggle('sb-collapsed', mode === 'button' && state.settings.sidebarOpen === false);
  if (mode !== 'hover') b.remove('sb-show');
  $('#sb-toggle').hidden = mode !== 'button';
  $('#sb-toggle').classList.toggle('on', mode === 'button' && state.settings.sidebarOpen !== false);
}

// ------------------------------------------------------------------ queue panel
function renderQueue() {
  const box = $('#queue-list');
  if ($('#queue').hidden) return;
  box.innerHTML = '';
  if (!player.queue.length) { box.append(h(`<div class="empty" style="padding:40px 0">${icon('queue')}<div>${tr('La cola está vacía')}</div></div>`)); return; }
  const addLabel = (t) => box.append(h(`<div class="label">${t}</div>`));
  player.queue.forEach((t, i) => {
    if (i === player.index) addLabel(tr('Sonando'));
    if (i === player.index + 1) addLabel(state.settings.automix ? `${tr('A continuación')} · Automix` : tr('A continuación'));
    const row = trackRow(t, i, player.queue, { compact: true, queueIndex: i, onClick: () => player.load(i) });
    if (i < player.index) row.classList.add('past');
    if (i === player.index) row.classList.add('playing');
    if (i > player.index) {
      row.draggable = true;
      row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(i)); e.dataTransfer.effectAllowed = 'move'; });
      row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drag-over'); });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', (e) => { e.preventDefault(); row.classList.remove('drag-over'); player.move(+e.dataTransfer.getData('text/plain'), i); });
    }
    box.append(row);
  });
  const cur = box.querySelector('.row.playing');
  // Centre the current song by scrolling the list only: scrollIntoView would also scroll the
  // window sideways while the panel is still sliding in from off-screen.
  if (cur && !renderQueue.scrolled) { box.scrollTop = cur.offsetTop - box.offsetTop - (box.clientHeight - cur.offsetHeight) / 2; renderQueue.scrolled = true; }
}
let queueCloseTimer = null;
let queueAutoHidden = false; // tucked away by the cover/lyrics view, to come back when it closes
function toggleQueue(force, { remember = true } = {}) {
  if (remember) queueAutoHidden = false; // the user decided: don't bring it back on our own
  const q = $('#queue');
  const isOpen = !q.hidden && !q.classList.contains('closing');
  const open = force != null ? !!force : !isOpen;
  clearTimeout(queueCloseTimer);
  if (open) { closeFsPanel(); q.classList.remove('closing'); q.hidden = false; }
  else if (!q.hidden) { q.classList.add('closing'); queueCloseTimer = setTimeout(() => { q.hidden = true; q.classList.remove('closing'); }, 300); }
  $('#btn-queue').classList.toggle('on', open);
  $('#fs-queue').classList.toggle('on', open);
  document.body.classList.toggle('queue-open', open);
  $('#nav-queue')?.classList.toggle('active', open);
  renderQueue.scrolled = false;
  renderQueue();
  if (remember) store.set('queueOpen', open);
}

// ------------------------------------------------------------------ search box
const searchInput = $('#search');
const suggestBox = $('#suggest');
let suggestTimer, suggestSel = -1;
function submitSearch(q) {
  q = q.trim();
  suggestBox.hidden = true;
  if (!q) return;
  searchInput.blur();
  go({ name: 'search', q, type: 'all' });
}
searchInput.addEventListener('input', () => {
  clearTimeout(suggestTimer);
  const q = searchInput.value.trim();
  if (!q) { suggestBox.hidden = true; return; }
  suggestTimer = setTimeout(async () => {
    try {
      const list = await api('suggestions', q);
      if (searchInput.value.trim() !== q || document.activeElement !== searchInput) return;
      suggestSel = -1;
      suggestBox.innerHTML = '';
      list.forEach((s) => {
        const li = h(`<li>${icon('search')}<span>${esc(s)}</span></li>`);
        li.onmousedown = (e) => { e.preventDefault(); searchInput.value = s; submitSearch(s); };
        suggestBox.append(li);
      });
      suggestBox.hidden = !list.length;
    } catch {}
  }, 180);
});
searchInput.addEventListener('keydown', (e) => {
  const items = $$('li', suggestBox);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (suggestBox.hidden || !items.length) return;
    e.preventDefault();
    suggestSel = (suggestSel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items.forEach((li, i) => li.classList.toggle('sel', i === suggestSel));
    searchInput.value = items[suggestSel].textContent;
  } else if (e.key === 'Enter') submitSearch(searchInput.value);
  else if (e.key === 'Escape') { suggestBox.hidden = true; searchInput.blur(); }
});
searchInput.addEventListener('blur', () => setTimeout(() => (suggestBox.hidden = true), 100));

// ------------------------------------------------------------------ settings → engine
export function applyAudioSettings() {
  const s = state.settings;
  engine.configure({ crossfade: s.crossfade, gapless: s.gapless, automix: s.automix, automixBars: s.automixBars, skipSilence: s.skipSilence, normalize: s.normalize });
  engine.setSpeed(s.speed || 1);
  engine.setEq(s.eqEnabled, s.eqBands || [], s.preamp || 0);
  updateMoreBtn();
  player.prepareNext();
}
document.addEventListener('settings', (e) => {
  const k = Object.keys(e.detail);
  if (k.includes('sidebar')) renderSidebar();
  if (k.includes('sidebarMode') || k.includes('sidebarOpen')) applySidebarMode();
  if (k.includes('theme') || k.includes('customThemes') || k.includes('dynamicAccent') || k.includes('accentMode') || k.includes('customAccent')) applyTheme();
  if (k.some((x) => x.startsWith('ambient'))) applyAmbient();
  if (k.some((x) => x.startsWith('mica'))) applyMica();
  if (k.includes('fsButtons')) applyFsButtons();
  if (k.includes('windowButtons')) applyWindowButtons();
  if (k.includes('visualizer')) applyVis();
  if (k.includes('visAuto')) scheduleAuto();
  if (k.includes('localInfo') && currentRoute()?.name === 'library') refreshView();
  if (k.some((x) => ['crossfade', 'gapless', 'automix', 'automixBars', 'skipSilence', 'normalize', 'speed', 'eqEnabled', 'eqBands', 'preamp'].includes(x))) applyAudioSettings();
  if (k.some((x) => x.startsWith('lyrics')) && player.current) {
    if (k.includes('lyricsOrder') || k.includes('lyricsDisabled')) loadLyrics(player.current); else if (npOpen()) renderLyrics();
  }
});

// ------------------------------------------------------------------ wiring
function initButtons() {
  $('.search-icon').innerHTML = icon('search');
  $$('[data-icon]').forEach((el) => (el.innerHTML = icon(el.dataset.icon)));
  const set = { back: 'back', forward: 'forward', prev: 'prev', next: 'next', shuffle: 'shuffle', 'btn-lyrics': 'nowView', 'settings-btn': 'settings', 'btn-queue': 'queue', 'btn-more': 'more', like: 'heart', 'np-like': 'heart' };
  for (const [id, ic] of Object.entries(set)) $('#' + id).innerHTML = icon(ic);
  $('#mix-badge').innerHTML = `${icon('sparkle')}<span>Automix</span>`;
  setPlayIcon();
  updateRepeatBtn();
  $('#shuffle').classList.toggle('on', player.shuffle);

  $('#back').onclick = back;
  $('#forward').onclick = forward;
  $('#play').onclick = () => player.toggle();
  $('#next').onclick = () => player.next();
  $('#prev').onclick = () => player.prev();
  $('#shuffle').onclick = () => player.setShuffle(!player.shuffle);
  $('#repeat').onclick = () => player.cycleRepeat();
  $('#btn-queue').onclick = () => toggleQueue();
  $('#queue-clear').onclick = () => player.clearUpcoming();
  $('#queue-close').innerHTML = icon('close');
  $('#queue-close').onclick = () => toggleQueue(false);
  setupResizers();
  $('#btn-lyrics').onclick = () => (npOpen() ? closeNowPlaying() : openNowPlaying());
  $('#p-art').onclick = () => (npOpen() ? closeNowPlaying() : openNowPlaying());
  $('#p-art').addEventListener('contextmenu', (e) => { e.preventDefault(); if (player.current) trackMenu(player.current, { x: e.clientX, y: e.clientY }); });
  // Chevron drawn as a rounded stroke (same look as the mobile app's "minimise player" arrow).
  $('#np-close').innerHTML = '<svg viewBox="0 0 24 24"><path d="M5.5 9l6.5 6.5L18.5 9" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  $('#np-close').onclick = closeNowPlaying;
  $('#btn-more').onclick = (e) => moreMenu(e.currentTarget);
  $('#btn-eq').innerHTML = icon('equalizer');
  $('#btn-eq').onclick = () => toggleEq();
  $('#btn-fs').innerHTML = icon('fullscreen');
  $('#btn-fs').onclick = () => setFullscreen(!isFs());
  $('#np-fs-exit').innerHTML = icon('fullscreenExit');
  $('#np-fs-exit').onclick = () => setFullscreen(false);
  $('#fs-queue').innerHTML = icon('queue');
  $('#fs-queue').onclick = () => toggleQueue();
  $('#fs-eq').innerHTML = icon('equalizer');
  $('#fs-eq').onclick = () => toggleEq();
  $('#fs-more').innerHTML = icon('more');
  $('#fs-more').onclick = (e) => moreMenu(e.currentTarget);
  $('#fs-settings').innerHTML = icon('settings');
  $('#fs-settings').onclick = () => fsSettings();
  $('#fs-panel-close').innerHTML = icon('close');
  $('#np-vis-toggle').innerHTML = icon('visualizer');
  $('#np-vis-toggle').onclick = () => saveSettings({ visualizer: !state.settings.visualizer });
  $('#np-vis-presets').innerHTML = icon('tune');
  $('#np-vis-presets').onclick = () => toggleVisPanel();
  applyVis();
  $('#fs-panel-close').onclick = () => closeFsPanel();
  applyFsButtons();
  bc.on('fullscreen', applyFullscreen);
  syncFsVolume();
  $$('#titlebar .tl').forEach((b) => (b.onclick = () => bc.windowControl(b.dataset.w)));
  // Glyphs as in macOS: ×, − and the diagonal arrows, shown when hovering the group.
  $('#titlebar .tl-close').innerHTML = '<svg viewBox="0 0 12 12"><path d="M3.5 3.5l5 5M8.5 3.5l-5 5"/></svg>';
  $('#titlebar .tl-min').innerHTML = '<svg viewBox="0 0 12 12"><path d="M3 6h6"/></svg>';
  $('#titlebar .tl-max').innerHTML = '<svg viewBox="0 0 12 12"><path class="fill" d="M3.2 7.6V3.2h4.4zM8.8 4.4v4.4H4.4z"/></svg>';
  $('#sb-toggle').innerHTML = icon('menu');
  $('#sb-toggle').onclick = () => saveSettings({ sidebarOpen: !state.settings.sidebarOpen });
  setupSidebarMode();
  $('#like').onclick = () => player.current && toggleLike(player.current);
  $('#np-like').onclick = () => player.current && toggleLike(player.current);
  $('#fs-like').onclick = () => player.current && toggleLike(player.current);
  $('#lyrics-source').onclick = (e) => lyricsSourceMenu(e.currentTarget);
  $('#np-lyrics-toggle').onclick = async () => { await saveSettings({ npLyricsHidden: !state.settings.npLyricsHidden }); applyLyricsHidden(); };
  $('#open-log').onclick = () => bc.openLog();
  $('#p-artist').addEventListener('click', (e) => { const a = e.target.closest('[data-artist]'); if (a) go({ name: 'artist', id: a.dataset.artist }); });
  $$('.nav-item[data-route]').forEach((b) => (b.onclick = () => go({ name: b.dataset.route })));
  $('#settings-btn').onclick = () => go({ name: 'settings' });
  renderSidebar();
  $('#account-btn').onclick = () => toggleAccountPop();

  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => engine.playPause(true));
    ms.setActionHandler('pause', () => engine.playPause(false));
    ms.setActionHandler('nexttrack', () => player.next());
    ms.setActionHandler('previoustrack', () => player.prev());
    ms.setActionHandler('seekto', (d) => engine.seek(d.seekTime));
  }
  bc.on('yt-status', showYtBanner);
  api('ytStatus').then(showYtBanner).catch(() => {});
  bc.on('command', (c) => { if (c === 'toggle') player.toggle(); else if (c === 'next') player.next(); else if (c === 'prev') player.prev(); });
  bc.on('downloads', (d) => {
    const before = new Set(state.downloads.done.map((x) => x.id));
    state.downloads = d;
    const fresh = d.done.filter((x) => !before.has(x.id));
    if (fresh.length === 1) toast(tr('Descargada: {name}', { name: fresh[0].track?.title || '' }));
    else if (fresh.length > 1) toast(tr('{n} descargas completadas', { n: fresh.length }));
    const err = d.active.find((j) => j.status === 'error' && !j.notified);
    if (err) toast(tr('Error al descargar «{name}»: {error}', { name: err.track.title, error: err.error }), true);
    document.dispatchEvent(new CustomEvent('downloads'));
  });

  document.addEventListener('keydown', (e) => {
    const typing = e.target.matches('input, textarea, select');
    if ((e.ctrlKey && e.key.toLowerCase() === 'f') || (e.ctrlKey && e.key.toLowerCase() === 'l')) { e.preventDefault(); searchInput.focus(); searchInput.select(); return; }
    if (e.ctrlKey && e.key === ',') { go({ name: 'settings' }); return; }
    if (typing) return;
    if (e.code === 'Space') { e.preventDefault(); player.toggle(); }
    else if (e.key === 'ArrowRight' && e.ctrlKey) player.next();
    else if (e.key === 'ArrowLeft' && e.ctrlKey) player.prev();
    else if (e.key === 'ArrowRight') engine.seek(engine.currentTime + 5);
    else if (e.key === 'ArrowLeft') engine.seek(Math.max(0, engine.currentTime - 5));
    else if (e.key === 'ArrowUp') { e.preventDefault(); setVolume(store.get('volume', 0.8) + 0.05); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setVolume(store.get('volume', 0.8) - 0.05); }
    else if (e.key === 'Escape' && !$('#menu').hidden) closeMenu(); // an open menu goes first
    else if (e.key === 'Escape' && isFs() && fsPanelKind) closeFsPanel();
    else if (e.key === 'Escape' && isFs()) { closeMenu(); setFullscreen(false); }
    else if (e.key === 'Escape') { closeMenu(); closeNowPlaying(); toggleEq(false); }
    else if (e.key === 'F11') { e.preventDefault(); setFullscreen(!isFs()); }
    else if (e.key.toLowerCase() === 'e') toggleEq();
    else if (e.key.toLowerCase() === 'l') npOpen() ? closeNowPlaying() : openNowPlaying();
    else if (e.key.toLowerCase() === 'q') toggleQueue();
    else if (e.key.toLowerCase() === 'v' && npOpen()) saveSettings({ visualizer: !state.settings.visualizer });
    else if (e.key.toLowerCase() === 's') player.setShuffle(!player.shuffle);
    else if (e.key.toLowerCase() === 'r') player.cycleRepeat();
    else if (e.key.toLowerCase() === 'm') $('#mute').click();
    else if (e.key.toLowerCase() === 'f' && player.current) toggleLike(player.current);
  });
  document.addEventListener('mouseup', (e) => { if (e.button === 3) back(); if (e.button === 4) forward(); });
}

/** "Buenas tardes, IvanDxd": the Google account's name (as in the account menu), once known. */
function greeting() {
  const hour = new Date().getHours();
  const hello = tr(hour < 6 ? 'Buenas noches' : hour < 13 ? 'Buenos días' : hour < 21 ? 'Buenas tardes' : 'Buenas noches');
  const name = (state.account?.name || '').trim();
  return name ? `${hello}, ${name}` : hello;
}
export async function refreshAccount() {
  try { state.account = await api('account'); } catch { state.account = null; }
  const b = $('#account-btn');
  const a = state.account;
  b.innerHTML = a?.photo ? `<img src="${esc(a.photo)}" alt="">` : icon('account');
  b.title = a ? `${a.name || tr('Cuenta de Google')}${a.handle ? ' · ' + a.handle : ''}` : tr('Iniciar sesión con Google');
  b.classList.toggle('signed', !!a);
  // Home and the sidebar are drawn before the account arrives: complete the greeting and the
  // sidebar playlists (they came out empty, without the account's ones) in place.
  const fold = $('#nav-items .sb-pl-inner');
  if (fold) fillPlaylistsFold(fold);
  const g = $('#home-greet');
  if (g) g.textContent = greeting();
}

async function init() {
  state.port = await bc.proxyPort();
  state.settings = await api('settingsGet');
  // Interface language: modules read it when they load, so a change needs a fresh start.
  if (syncUiLang(state.settings.uiLanguage)) { location.reload(); return; }
  translateStatic();
  const ver = $('.sidebar-foot .muted');
  ver.textContent = ver.textContent.replace('port de BitChord', tr('port de BitChord'));
  try { state.ytCovers = await api('ytCovers'); } catch {}
  providerMeta = await api('lyricsProviders');
  try { state.downloads = await api('downloads'); } catch {}
  initButtons();
  setVolume(store.get('volume', 0.8), false);
  applyAudioSettings();
  refreshAccount();
  // Restore the last session's queue (paused).
  const saved = store.get('queue', null);
  if (state.settings.resumeOnStart !== false && saved?.queue?.length) {
    player.queue = saved.queue.map((t) => ({ ...t, _k: uid() }));
    player.index = Math.min(Math.max(0, saved.index || 0), player.queue.length - 1);
    player.from = saved.from || null;
    player.extendWith = true;
    updateNowPlaying();
    loadLyrics(player.current);
  }
  if (store.get('queueOpen', true)) toggleQueue(true); // open by default
  go({ name: 'home' });
  // Chromium needs a user gesture before audio can start; resume the context on the first interaction.
  const unlock = () => { engine.resume(); document.removeEventListener('pointerdown', unlock); document.removeEventListener('keydown', unlock); };
  document.addEventListener('pointerdown', unlock);
  document.addEventListener('keydown', unlock);
}

// Exposed for debugging from DevTools.
window.__bc = { player, go, engine, state, saveSidebar: (sidebar) => saveSettings({ sidebar }) };
init();
