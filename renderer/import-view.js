// Spotify import wizard: pick the export → choose playlists and destination → match → review → create.
import { bc, icon, esc, fmt, api, toast, h, state, art, askText } from './core.js';
import { go, player, openMenu, refreshView, currentRoute } from './app.js';
import { tr } from './i18n.js';
import { spotifyLinkView } from './spotify-link.js';

// The wizard survives navigating away (matching a big library takes a while).
const W = { step: 'pick', file: null, lists: [], sel: {}, dest: {}, results: null, choice: {}, progress: null, created: null, filter: 'all', open: {} };
const reset = () => Object.assign(W, { step: 'pick', file: null, lists: [], sel: {}, dest: {}, results: null, choice: {}, progress: null, created: null, filter: 'all', open: {} });

bc.on('import-progress', (p) => {
  W.progress = p;
  const bar = document.querySelector('#imp-progress');
  if (!bar) return;
  if (p.phase === 'match') {
    bar.querySelector('.progress div').style.width = `${(p.done / p.total) * 100}%`;
    bar.querySelector('.imp-count').textContent = tr('{done} de {total} canciones', { done: p.done, total: p.total });
  } else {
    bar.querySelector('.progress div').style.width = `${((p.index + p.done / Math.max(1, p.count)) / p.total) * 100}%`;
    bar.querySelector('.imp-count').textContent = `${tr('Playlist {i} de {total}', { i: p.index + 1, total: p.total })}: «${p.name}» · ${p.done}/${p.count}`;
  }
});

const signedIn = () => !!state.account;
const actions = (root, ...btns) => { const el = h('<div class="actions"></div>'); el.append(...btns); root.append(el); return el; };
// Only repaint if the wizard is what's on screen (matching can finish while you're elsewhere).
const repaint = () => { if (currentRoute()?.name === 'spotify-import') refreshView(); };
const key = (pk, i) => `${pk}#${i}`;

function steps() {
  const order = [['pick', tr('Archivo')], ['select', tr('Playlists')], ['matching', tr('Búsqueda')], ['review', tr('Revisión')], ['done', tr('Listo')]];
  const cur = order.findIndex(([k]) => k === (W.step === 'creating' ? 'done' : W.step));
  return h(`<div class="imp-steps">${order.map(([, l], i) => `<span class="${i < cur ? 'past' : i === cur ? 'cur' : ''}">${i + 1}. ${l}</span>`).join('')}</div>`);
}

// ---------------------------------------------------------------- step 1
function pickStep(root) {
  root.append(h(`<div class="imp-card">
    <h2>${tr('Trae tus playlists de Spotify')}</h2>
    <ol class="imp-help">
      <li>${tr('En <a href="#" data-url="https://www.spotify.com/account/privacy/">spotify.com → Cuenta → Privacidad</a>, pide tus <b>Datos de la cuenta</b> (no hace falta el historial ampliado).')}</li>
      <li>${tr('Spotify te manda un enlace por correo en unos días. Descarga el <b>.zip</b>.')}</li>
      <li>${tr('Elígelo aquí. BitChord lee tus playlists y tus «Canciones que te gustan» (que se importan como la playlist <b>Me gusta de Spotify</b>).')}</li>
    </ol>
    <p class="muted">${tr('BitChord busca cada canción en YouTube Music. Antes de crear nada podrás revisar las coincidencias dudosas.')}</p>
  </div>`));
  const b = h(`<button class="btn primary">${icon('importIcon')}${tr('Elegir el .zip de Spotify…')}</button>`);
  b.onclick = async () => {
    const file = await api('chooseFile', tr('Datos de la cuenta de Spotify'), ['zip', 'json']);
    if (!file) return;
    b.disabled = true;
    try {
      W.lists = await api('spotifyParse', file);
      W.file = file;
      W.sel = Object.fromEntries(W.lists.map((p) => [p.key, true]));
      W.dest = Object.fromEntries(W.lists.map((p) => [p.key, signedIn() ? 'yt' : 'local']));
      W.step = 'select';
      refreshView();
    } catch (e) { toast(e.message, true); b.disabled = false; }
  };
  actions(root, b);
}

// ---------------------------------------------------------------- step 2
function destSwitch(pk) {
  const el = h(`<div class="seg"><button data-v="yt">${icon('library')}${tr('Mi YT Music')}</button><button data-v="local">${icon('computer')}${tr('Solo BitChord')}</button></div>`);
  const paint = () => el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', W.dest[pk] === b.dataset.v));
  el.querySelectorAll('button').forEach((b) => {
    if (b.dataset.v === 'yt' && !signedIn()) { b.disabled = true; b.title = tr('Inicia sesión con Google para crear playlists en tu cuenta'); }
    b.onclick = (e) => { e.stopPropagation(); W.dest[pk] = b.dataset.v; paint(); };
  });
  paint();
  return el;
}

function selectStep(root) {
  const total = W.lists.reduce((s, p) => s + p.tracks.length, 0);
  root.append(h(`<div class="imp-bar"><span class="muted">${tr('{n} playlists · {total} canciones en el archivo', { n: W.lists.length, total })}</span></div>`));
  const bar = root.lastChild;
  const allYt = h(`<button class="btn ghost small"${signedIn() ? '' : ' disabled'}>${tr('Todas a mi YT Music')}</button>`);
  const allLocal = h(`<button class="btn ghost small">${tr('Todas solo en BitChord')}</button>`);
  const toggleAll = h(`<button class="btn ghost small">${tr('Marcar / desmarcar todas')}</button>`);
  allYt.onclick = () => { W.lists.forEach((p) => (W.dest[p.key] = 'yt')); refreshView(); };
  allLocal.onclick = () => { W.lists.forEach((p) => (W.dest[p.key] = 'local')); refreshView(); };
  toggleAll.onclick = () => { const v = !W.lists.every((p) => W.sel[p.key]); W.lists.forEach((p) => (W.sel[p.key] = v)); refreshView(); };
  bar.append(h('<span class="btn-row"></span>'));
  bar.lastChild.append(toggleAll, allYt, allLocal);
  if (!signedIn()) root.append(h(`<div class="set-note">${icon('info')} ${tr('Para crearlas en tu cuenta de YouTube Music (y verlas en la app oficial) inicia sesión con Google en Ajustes → Cuenta. Mientras tanto solo puedes guardarlas en BitChord.')}</div>`));

  const list = h('<div class="imp-lists"></div>');
  for (const p of W.lists) {
    const el = h(`<label class="imp-pl${W.sel[p.key] ? '' : ' off'}">
      <input type="checkbox"${W.sel[p.key] ? ' checked' : ''}>
      <div class="imp-pl-t"><b>${esc(p.name)}</b><div class="muted small">${tr('{n} canciones', { n: p.tracks.length })}${p.skipped ? ' · ' + tr('{n} podcasts/archivos locales que no se importan', { n: p.skipped }) : ''}${p.liked ? ' · ' + tr('tus «Canciones que te gustan»') : ''}</div></div>
    </label>`);
    el.querySelector('input').onchange = (e) => { W.sel[p.key] = e.target.checked; el.classList.toggle('off', !e.target.checked); };
    el.append(destSwitch(p.key));
    list.append(el);
  }
  root.append(list);

  const go1 = h(`<button class="btn primary">${icon('search')}${tr('Buscar en YouTube Music')}</button>`);
  const back = h(`<button class="btn ghost">${tr('Elegir otro archivo')}</button>`);
  back.onclick = () => { reset(); refreshView(); };
  go1.onclick = async () => {
    const chosen = W.lists.filter((p) => W.sel[p.key] && p.tracks.length);
    if (!chosen.length) return toast(tr('Marca al menos una playlist'));
    W.step = 'matching'; W.progress = { phase: 'match', done: 0, total: chosen.reduce((s, p) => s + p.tracks.length, 0) };
    refreshView();
    try {
      W.results = await api('spotifyMatch', chosen.map(({ key, tracks }) => ({ key, tracks })));
      W.choice = {};
      for (const p of chosen) W.results[p.key].forEach((r, i) => { W.choice[key(p.key, i)] = r.status === 'none' ? null : r.track; });
      W.step = 'review';
      toast(tr('Búsqueda terminada: revisa las coincidencias'));
    } catch (e) { toast(e.message, true); W.step = 'select'; }
    repaint();
  };
  actions(root, go1, back);
}

// ---------------------------------------------------------------- step 3
function progressStep(root, title) {
  const p = W.progress || { done: 0, total: 1 };
  const el = h(`<div class="imp-card" id="imp-progress"><h2>${esc(title)}</h2><div class="progress big"><div style="width:0%"></div></div><div class="imp-count muted">…</div></div>`);
  root.append(el);
  if (p.phase === 'match') { el.querySelector('.progress div').style.width = `${(p.done / p.total) * 100}%`; el.querySelector('.imp-count').textContent = tr('{done} de {total} canciones', { done: p.done, total: p.total }); }
  if (W.step === 'matching') {
    root.append(h(`<p class="muted">${tr('Se buscan unas pocas canciones a la vez para no saturar YouTube. Puedes seguir usando BitChord mientras tanto.')}</p>`));
    const c = h(`<button class="btn ghost">${tr('Cancelar')}</button>`);
    c.onclick = () => api('spotifyCancel');
    actions(root, c);
  }
}

// ---------------------------------------------------------------- step 4
function reviewRow(p, i) {
  const src = p.tracks[i];
  const r = W.results[p.key][i];
  const k = key(p.key, i);
  const pick = W.choice[k];
  const badge = !pick ? `<span class="mbadge none">${tr(r.status === 'none' ? 'No encontrada' : 'Omitida')}</span>`
    : r.status === 'doubt' && pick === r.track ? `<span class="mbadge doubt">${tr('Dudosa')} · ${Math.round(r.score * 100)} %</span>`
    : pick !== r.track ? `<span class="mbadge ok">${tr('Elegida a mano')}</span>` : `<span class="mbadge ok">${Math.round(r.score * 100)} %</span>`;
  const el = h(`<div class="mrow ${!pick ? 'none' : r.status === 'doubt' && pick === r.track ? 'doubt' : 'ok'}">
    <div class="msrc"><b class="ellipsis">${esc(src.title)}</b><span class="muted ellipsis">${esc(src.artist)}${src.album ? ' · ' + esc(src.album) : ''}</span></div>
    <span class="marrow">${icon('forward')}</span>
    <div class="mdst">${pick ? `<img src="${esc(art(pick.thumb))}" alt=""><div style="min-width:0"><b class="ellipsis">${esc(pick.title)}</b><span class="muted ellipsis">${esc((pick.artists || []).map((a) => a.name).join(', '))}${pick.album?.name ? ' · ' + esc(pick.album.name) : ''}${pick.duration ? ' · ' + fmt(pick.duration) : ''}</span></div>` : `<span class="muted">— ${tr('no se añadirá')} —</span>`}</div>
    ${badge}
    <button class="icon-btn" data-a="play" title="${tr('Escuchar')}"${pick ? '' : ' disabled'}>${icon('play')}</button>
    <button class="icon-btn" data-a="change" title="${tr('Cambiar')}">${icon('more')}</button>
  </div>`);
  el.querySelector('[data-a=play]').onclick = () => pick && player.playList([pick], 0);
  el.querySelector('[data-a=change]').onclick = (e) => {
    const anchor = e.currentTarget;
    openMenu([
      { header: tr('Elegir coincidencia') },
      ...r.alternatives.map((a) => ({ icon: pick?.id === a.id ? 'check' : 'disc', label: `${a.title} — ${(a.artists || []).map((x) => x.name).join(', ')}`, hint: `${Math.round(a._score * 100)} %`, action: () => { W.choice[k] = a; redraw(); } })),
      null,
      { icon: 'search', label: tr('Buscar otra…'), action: async () => {
        const q = await askText(tr('Buscar en YouTube Music'), { value: `${src.title} ${src.artist.split(',')[0]}`, ok: tr('Buscar') });
        if (!q) return;
        const found = await api('songSearch', q);
        if (!found.length) return toast(tr('Sin resultados'));
        openMenu([{ header: tr('Resultados') }, ...found.slice(0, 8).map((a) => ({ icon: 'disc', label: `${a.title} — ${(a.artists || []).map((x) => x.name).join(', ')}`, action: () => { W.choice[k] = a; redraw(); } }))], { x: innerWidth / 2 - 160, y: innerHeight / 4 });
      } },
      pick ? { icon: 'remove', label: tr('No añadir esta canción'), action: () => { W.choice[k] = null; redraw(); } } : null,
    ].filter((x) => x !== undefined), anchor);
  };
  return el;
}

let redraw = () => {};
function reviewStep(root) {
  const chosen = W.lists.filter((p) => W.results?.[p.key]);
  let ok = 0, doubt = 0, none = 0;
  for (const p of chosen) W.results[p.key].forEach((r, i) => { const c = W.choice[key(p.key, i)]; if (!c) none++; else if (r.status === 'doubt' && c === r.track) doubt++; else ok++; });
  root.append(h(`<div class="imp-summary"><span class="mbadge ok">${tr('{n} encontradas', { n: ok })}</span><span class="mbadge doubt">${tr('{n} dudosas', { n: doubt })}</span><span class="mbadge none">${tr('{n} sin añadir', { n: none })}</span></div>`));
  const chips = h('<div class="chips"></div>');
  [['all', tr('Todas')], ['doubt', tr('Dudosas')], ['none', tr('Sin añadir')]].forEach(([f, l]) => {
    const c = h(`<button class="chip${W.filter === f ? ' active' : ''}">${l}</button>`);
    c.onclick = () => { W.filter = f; refreshView(); };
    chips.append(c);
  });
  root.append(chips);
  root.append(h(`<p class="muted small">${tr('Revisa sobre todo las <b>dudosas</b>: pulsa ▶ para escucharlas y ⋮ para elegir otra versión o descartarla.')}</p>`));

  for (const p of chosen) {
    const idx = p.tracks.map((_, i) => i).filter((i) => {
      const r = W.results[p.key][i], c = W.choice[key(p.key, i)];
      if (W.filter === 'doubt') return c && r.status === 'doubt' && c === r.track;
      if (W.filter === 'none') return !c;
      return true;
    });
    if (!idx.length) continue;
    const added = p.tracks.filter((_, i) => W.choice[key(p.key, i)]).length;
    const issues = W.results[p.key].some((r, i) => !W.choice[key(p.key, i)] || (r.status === 'doubt' && W.choice[key(p.key, i)] === r.track));
    const open = W.open[p.key] ?? (W.filter !== 'all' || chosen.length === 1 || issues);
    const sec = h(`<section class="imp-sec${open ? ' open' : ''}">
      <header><span class="chev">${icon('chevron')}</span><b>${esc(p.name)}</b><span class="muted small">${tr('{done} de {total} canciones', { done: added, total: p.tracks.length })} · ${tr(W.dest[p.key] === 'yt' ? 'a tu YT Music' : 'solo en BitChord')}</span></header>
      <div class="imp-rows"></div></section>`);
    sec.querySelector('header').append(destSwitch(p.key));
    sec.querySelector('header').onclick = () => { W.open[p.key] = !open; refreshView(); };
    const rows = sec.querySelector('.imp-rows');
    if (open) {
      const LIMIT = 300;
      idx.slice(0, W.showAll?.[p.key] ? idx.length : LIMIT).forEach((i) => rows.append(reviewRow(p, i)));
      if (idx.length > LIMIT && !W.showAll?.[p.key]) {
        const more = h(`<button class="btn ghost small">${tr('Mostrar las {n} restantes', { n: idx.length - LIMIT })}</button>`);
        more.onclick = () => { W.showAll = { ...(W.showAll || {}), [p.key]: true }; refreshView(); };
        rows.append(more);
      }
    }
    root.append(sec);
  }

  const create = h(`<button class="btn primary">${icon('check')}${tr('Crear playlists')}</button>`);
  const back = h(`<button class="btn ghost">${tr('Volver')}</button>`);
  back.onclick = () => { W.step = 'select'; refreshView(); };
  create.onclick = async () => {
    const items = chosen.map((p) => ({
      name: p.name, description: p.description, dest: W.dest[p.key],
      tracks: p.tracks.map((_, i) => W.choice[key(p.key, i)]).filter(Boolean),
    })).filter((it) => it.tracks.length);
    if (!items.length) return toast(tr('No hay canciones que añadir'));
    W.step = 'creating'; W.progress = { phase: 'create', index: 0, total: items.length, done: 0, count: 1, name: items[0].name };
    refreshView();
    try { W.created = await api('spotifyCreate', items); } catch (e) { toast(e.message, true); W.step = 'review'; repaint(); return; }
    W.step = 'done';
    toast(tr('Importación terminada'));
    repaint();
  };
  actions(root, create, back).classList.add('sticky-actions');
  redraw = () => refreshView();
}

// ---------------------------------------------------------------- step 5
function doneStep(root) {
  const ok = W.created.filter((x) => !x.error);
  root.append(h(`<div class="imp-card"><h2>${tr(ok.length === W.created.length ? '¡Hecho!' : 'Terminado con algunos errores')}</h2>
    <p class="muted">${tr('{n} playlists creadas.', { n: ok.length })}${W.created.some((x) => x.dest === 'yt' && !x.error) ? ' ' + tr('Las de tu cuenta ya aparecen también en la app oficial de YouTube Music (como privadas).') : ''}</p></div>`));
  const list = h('<div class="imp-lists"></div>');
  for (let r of W.created) {
    const el = h(`<div class="imp-pl${r.error ? ' err' : ''}"><div class="imp-pl-t"><b>${esc(r.name)}</b><div class="muted small">${r.error ? tr('Error:') + ' ' + esc(r.error) + (r.fallback ? ' — ' + tr('guardada en BitChord para que no se pierda') : '') : `${tr('{n} canciones', { n: r.count })} · ${tr(r.dest === 'yt' ? 'en tu YouTube Music' : 'en BitChord')}`}</div></div></div>`);
    if (!r.error || r.fallback) {
      if (r.fallback) r = { ...r, dest: 'local', id: r.fallback };
      const open = h(`<button class="btn ghost small">${icon('play')}${tr('Abrir')}</button>`);
      open.onclick = () => go(r.dest === 'yt' ? { name: 'playlist', id: r.id } : { name: 'localplaylist', id: r.id });
      el.append(open);
    }
    list.append(el);
  }
  root.append(list);
  const again = h(`<button class="btn ghost">${tr('Importar otro archivo')}</button>`);
  again.onclick = () => { reset(); refreshView(); };
  const lib = h(`<button class="btn primary">${tr('Ir a mis playlists')}</button>`);
  lib.onclick = () => go({ name: 'library', tab: 'playlists' });
  actions(root, lib, again);
}

export async function importView() {
  const root = h('<div class="import"></div>');
  root.append(h(`<h1 class="page-title">${tr('Importar de Spotify')}</h1>`));
  // Two ways: the one-off .zip export, or linking the account so playlists stay up to date.
  const tabs = h('<div class="chips"></div>');
  [['zip', tr('Archivo .zip de datos')], ['link', tr('Cuenta de Spotify (se actualiza sola)')]].forEach(([k, l]) => {
    const c = h(`<button class="chip${(W.tab || 'zip') === k ? ' active' : ''}" data-tab="${k}">${l}</button>`);
    c.onclick = () => { W.tab = k; refreshView(); };
    tabs.append(c);
  });
  root.append(tabs);
  if (W.tab === 'link') { root.append(spotifyLinkView()); return root; }
  root.append(steps());
  if (W.step === 'pick') pickStep(root);
  else if (W.step === 'select') selectStep(root);
  else if (W.step === 'matching') progressStep(root, tr('Buscando tus canciones en YouTube Music…'));
  else if (W.step === 'review') reviewStep(root);
  else if (W.step === 'creating') progressStep(root, tr('Creando las playlists…'));
  else doneStep(root);
  root.addEventListener('click', (e) => { const a = e.target.closest('a[data-url]'); if (a) { e.preventDefault(); bc.openExternal(a.dataset.url); } });
  return root;
}
