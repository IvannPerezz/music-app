// Library: favourites, downloads, local files, history and the YouTube Music account library.
import { bc, $, icon, esc, fmt, api, toast, h, state, art, likes, history, askText } from './core.js';
import { trackRow, section, card, player, go, refreshView, currentRoute, sizeLabel, playlistMenu, isHiddenPlaylist } from './app.js';
import { tr } from './i18n.js';

const TABS = [
  ['playlists', tr('Playlists'), 'queue'],
  ['likes', tr('Favoritos'), 'heartFill'],
  ['downloads', tr('Descargas'), 'download'],
  ['local', tr('En este equipo'), 'computer'],
  ['network', tr('En red'), 'folder'],
  ['history', tr('Historial'), 'history'],
  ['account', tr('Tu YouTube Music'), 'library'],
];

function coverHtml(p, fallback) {
  return p.cover ? `<img src="${esc(art(p.cover))}" alt="">` : p.thumbs.length >= 4 ? `<div class="mosaic">${p.thumbs.slice(0, 4).map((u) => `<img src="${esc(art(u))}" alt="">`).join('')}</div>` : p.thumbs[0] ? `<img src="${esc(art(p.thumbs[0]))}" alt="">` : `<div class="mosaic empty">${icon(fallback)}</div>`;
}

/** A local folder shown as a playlist card. */
export function folderCard(f) {
  const c = h(`<div class="card playlist folder-card"><div class="art">${coverHtml(f, 'folder')}<span class="hover-play">${icon('play')}</span></div><div class="t ellipsis">${esc(f.name)}</div><div class="s ellipsis" title="${esc(f.path)}">${tr('{n} canciones', { n: f.count })}</div></div>`);
  c.onclick = async (e) => {
    if (e.target.closest('.hover-play')) { const d = await api('localFolderGet', f.id); if (d.tracks.length) player.playList(d.tracks, 0, { from: { kind: 'Carpeta', name: f.name } }); return; }
    go({ name: 'localfolder', id: f.id });
  };
  return c;
}

// Re-render library pages when a folder changes on disk (watcher or manual rescan).
let scanRefresh = null;
bc.on('local-scan', (st) => {
  if (st.scanning) return;
  clearTimeout(scanRefresh);
  scanRefresh = setTimeout(() => {
    const r = currentRoute();
    if ((r?.name === 'library' && ['local', 'playlists'].includes(r.tab || 'playlists')) || (r?.name === 'localfolder' && (!st.folders || st.folders.includes(r.id)))) refreshView();
  }, 400);
});

function trackList(tracks, { empty, actions = true, title, details = false } = {}) {
  const root = h('<div></div>');
  if (actions && tracks.length) {
    const bar = h(`<div class="actions" style="margin:0 0 16px">
      <button class="btn primary" data-a="play">${icon('play')}${tr('Reproducir')}</button>
      <button class="btn ghost" data-a="shuffle">${icon('shuffle')}${tr('Aleatorio')}</button>
      <span class="muted count">${tr('{n} canciones', { n: tracks.length })} · ${Math.round(tracks.reduce((s, t) => s + (t.duration || 0), 0) / 60)} min${details ? ' · ' + sizeLabel(tracks.reduce((s, t) => s + (t.file?.size || 0), 0)) : ''}</span></div>`);
    bar.querySelector('[data-a=play]').onclick = () => player.playList(tracks, 0);
    bar.querySelector('[data-a=shuffle]').onclick = () => player.playList(tracks, 0, { shuffle: true });
    root.append(bar);
  }
  if (!tracks.length) { root.append(h(`<div class="empty">${empty}</div>`)); return root; }
  const box = h('<div class="tracks"></div>');
  tracks.forEach((t, i) => box.append(trackRow(t, i, tracks, { details })));
  root.append(box);
  return root;
}

function downloadsTab() {
  const root = h('<div></div>');
  const draw = () => {
    root.innerHTML = '';
    const { active, done, dir } = state.downloads;
    const bar = h(`<div class="dl-bar"><span class="muted">${icon('folder')} ${esc(dir || '')}</span></div>`);
    const open = h(`<button class="btn ghost small">${icon('open')}${tr('Abrir carpeta')}</button>`);
    open.onclick = () => api('downloadShow', '');
    bar.append(open);
    root.append(bar);
    if (active.length) {
      const box = h(`<section class="section"><h2>${tr('En curso')}</h2></section>`);
      active.forEach((j) => {
        const pct = Math.round((j.progress || 0) * 100);
        const status = { queued: tr('En cola'), resolving: tr('Preparando…'), downloading: `${pct} %`, tagging: tr('Añadiendo metadatos…'), error: tr('Error') }[j.status] || j.status;
        const el = h(`<div class="dl-job${j.status === 'error' ? ' err' : ''}">
          <img src="${esc(art(j.track.thumb))}" alt="">
          <div class="dl-info"><div class="ellipsis"><b>${esc(j.track.title)}</b> <span class="muted">${esc((j.track.artists || []).map((a) => a.name).join(', '))}</span></div>
            <div class="progress"><div style="width:${j.status === 'downloading' ? pct : j.status === 'tagging' ? 100 : 0}%"></div></div>
            <div class="muted small">${esc(status)}${j.error ? ' — ' + esc(j.error) : ''}</div></div>
          <button class="icon-btn" title="${tr('Cancelar')}">${icon('close')}</button></div>`);
        el.querySelector('button').onclick = () => api('downloadCancel', j.id);
        box.append(el);
      });
      root.append(box);
    }
    const tracks = done.map((d) => ({ ...d.track, thumb: d.offlineThumb ? `/dlcover/${d.id}` : d.track.thumb }));
    root.append(trackList(tracks, { empty: `${icon('download')}<div><b>${tr('Aún no has descargado nada')}</b></div><div class="muted">${tr('Usa "Descargar" en cualquier canción, álbum o playlist para escucharla sin conexión.')}</div>` }));
  };
  draw();
  const onChange = () => { if (!root.isConnected) return document.removeEventListener('downloads', onChange); draw(); };
  document.addEventListener('downloads', onChange);
  return root;
}

async function localTab() {
  const root = h('<div></div>');
  const tracks = await api('localTracks');
  const folders = state.settings.localFolders || [];
  if (!folders.length) {
    root.append(h(`<div class="empty">${icon('computer')}<div><b>${tr('Añade tus carpetas de música')}</b></div><div class="muted">MP3, M4A, FLAC, OGG, Opus, WAV…</div></div>`));
    const b = h(`<button class="btn primary" style="margin:0 auto;display:flex">${icon('folder')}${tr('Añadir carpeta')}</button>`);
    b.onclick = () => go({ name: 'settings', section: 'local' });
    root.append(b);
    return root;
  }
  const bar = h(`<div class="dl-bar"><span class="muted">${tr(folders.length === 1 ? '1 carpeta' : '{n} carpetas', { n: folders.length })}${state.settings.localWatch ? ' · ' + tr('se actualizan solas al añadir o quitar canciones') : ''}</span></div>`);
  const manage = h(`<button class="btn ghost small">${icon('settings')}${tr('Gestionar carpetas')}</button>`);
  manage.onclick = () => go({ name: 'settings', section: 'local' });
  const rescan = h(`<button class="btn ghost small">${icon('refresh')}${tr('Volver a escanear')}</button>`);
  rescan.onclick = async () => { rescan.disabled = true; toast(tr('Escaneando…')); await api('localRescan'); refreshView(); };
  const grp = h('<div class="btn-row" style="margin:0"></div>'); grp.append(manage, rescan);
  bar.append(grp);
  root.append(bar);
  const fl = await api('localFolders');
  const fsec = h(`<section class="section"><h2>${tr('Carpetas')}</h2></section>`);
  const cards = h('<div class="cards wrap"></div>');
  fl.forEach((f) => cards.append(folderCard(f)));
  fsec.append(cards);
  root.append(fsec);
  const all = h(`<section class="section"><h2>${tr('Todas las canciones')}</h2></section>`);
  all.append(trackList(tracks, { details: true, empty: tr('No se encontraron canciones en tus carpetas (o se están escaneando).') }));
  root.append(all);
  return root;
}

async function playlistsTab() {
  const root = h('<div></div>');
  const bar = h('<div class="actions" style="margin:0 0 18px"></div>');
  const create = h(`<button class="btn primary">${icon('add')}${tr('Nueva playlist')}</button>`);
  create.onclick = async () => {
    if (state.account) {
      const n = await askText(tr('Nueva playlist de YouTube Music'), { placeholder: tr('Nombre de la playlist'), ok: tr('Crear') });
      if (!n) return;
      try { const id = await api('ytPlaylistCreate', n, []); toast(tr('Playlist «{name}» creada en YouTube Music', { name: n })); go({ name: 'playlist', id }); }
      catch (e) { toast(e.message, true); }
      return;
    }
    const n = await askText(tr('Nueva playlist'), { placeholder: tr('Nombre de la playlist'), ok: tr('Crear') });
    if (n) { const id = await api('playlistCreate', n, []); go({ name: 'localplaylist', id }); }
  };
  const imp = h(`<button class="btn ghost">${icon('importIcon')}${tr('Importar de Spotify')}</button>`);
  imp.onclick = () => go({ name: 'spotify-import' });
  bar.append(create, imp);
  root.append(bar);
  const [lists, fl, ytLists] = await Promise.all([
    api('playlistsList'),
    api('localFolders'),
    state.account ? api('accountPlaylists').catch(() => []) : Promise.resolve([]),
  ]);
  const grid = (title, cards, style = '') => {
    const sec = h(`<section class="section"${style ? ` style="${style}"` : ''}>${title ? `<h2>${esc(title)}</h2>` : ''}</section>`);
    const box = h('<div class="cards wrap"></div>');
    cards.forEach((c) => box.append(c));
    sec.append(box);
    root.append(sec);
  };
  // YouTube Music playlists (the ones the app shows on the home screen too) come first.
  if (state.account) {
    const liked = h(`<div class="card playlist"><div class="art liked">${icon('heartFill')}</div><div class="t">${tr('Me gusta')}</div><div class="s">${tr('Canciones que te gustan en YouTube Music')}</div></div>`);
    liked.onclick = () => go({ name: 'playlist', id: 'LM' });
    const ytCards = ytLists.filter((p) => !isHiddenPlaylist(p.id)).map((p) => {
      const c = card(p);
      c.addEventListener('contextmenu', (e) => { e.preventDefault(); playlistMenu({ kind: 'playlist', id: p.id, title: p.title }, { x: e.clientX, y: e.clientY }); });
      return c;
    });
    liked.addEventListener('contextmenu', (e) => { e.preventDefault(); playlistMenu({ kind: 'playlist', id: 'LM', title: tr('Me gusta') }, { x: e.clientX, y: e.clientY }); });
    grid(tr('Tus playlists de YouTube Music'), [liked, ...ytCards]);
  }
  if (lists.length) {
    grid(state.account ? tr('Solo en BitChord') : '', lists.map((p) => {
      const c = h(`<div class="card playlist"><div class="art">${coverHtml(p, 'queue')}<span class="hover-play">${icon('play')}</span></div><div class="t ellipsis">${esc(p.name)}</div><div class="s">${tr('{n} canciones', { n: p.count })}${p.origin === 'spotify' ? ' · ' + tr('de Spotify') : ''}</div></div>`);
      c.onclick = async (e) => {
        if (e.target.closest('.hover-play')) { const d = await api('playlistGet', p.id); if (d.tracks.length) player.playList(d.tracks, 0, { from: { kind: 'Playlist', name: p.name } }); return; }
        go({ name: 'localplaylist', id: p.id });
      };
      c.addEventListener('contextmenu', (e) => { e.preventDefault(); playlistMenu({ kind: 'localplaylist', id: p.id, title: p.name }, { x: e.clientX, y: e.clientY }); });
      return c;
    }), state.account ? 'margin-top:28px' : '');
  }
  if (!state.account && !lists.length) {
    root.append(h(`<div class="empty">${icon('queue')}<div><b>${tr('Aún no tienes playlists')}</b></div><div class="muted">${tr('Inicia sesión con Google para ver tus playlists de YouTube Music, crea una aquí, añade canciones desde el menú ⋮ de cualquier canción o importa tus playlists de Spotify.')}</div></div>`));
  }
  if (fl.length) grid(tr('Carpetas de este equipo'), fl.map((f) => folderCard(f)), 'margin-top:28px');
  return root;
}

async function networkTab() {
  const root = h('<div></div>');
  const servers = await api('webdavServers');
  if (!servers.length) {
    root.append(h(`<div class="empty">${icon('folder')}<div><b>${tr('Conecta tu NAS o tu nube')}</b></div><div class="muted">${tr('Añade un servidor WebDAV (Nextcloud, ownCloud, Synology…) en Ajustes → Fuentes.')}</div></div>`));
    const b = h(`<button class="btn primary" style="margin:0 auto;display:flex">${icon('settings')}${tr('Ir a Fuentes')}</button>`);
    b.onclick = () => go({ name: 'settings', section: 'sources' });
    root.append(b);
    return root;
  }
  const bar = h(`<div class="dl-bar"><span class="muted">${servers.map((s) => esc(s.label)).join(' · ')}</span></div>`);
  const rescan = h(`<button class="btn ghost small">${icon('refresh')}${tr('Volver a escanear')}</button>`);
  rescan.onclick = async () => { rescan.disabled = true; toast(tr('Escaneando…')); await api('webdavRescan'); refreshView(); };
  bar.append(rescan);
  root.append(bar);
  root.append(trackList(await api('webdavTracks'), { empty: tr('No se encontraron canciones (o se están escaneando).') }));
  return root;
}

function historyTab() {
  const root = h('<div></div>');
  const all = history.all();
  const groups = new Map();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (const t of all) {
    const d = new Date(t.playedAt); d.setHours(0, 0, 0, 0);
    const diff = Math.round((today - d) / 86400000);
    const label = tr(diff === 0 ? 'Hoy' : diff === 1 ? 'Ayer' : diff < 7 ? 'Esta semana' : 'Antes');
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(t);
  }
  if (!all.length) root.append(h(`<div class="empty">${icon('history')}<div>${tr('Todavía no has escuchado nada aquí.')}</div></div>`));
  for (const [label, items] of groups) root.append(section({ title: label, layout: 'list', items }, { wrap: true, radio: false }));
  return root;
}

async function accountTab() {
  const root = h('<div></div>');
  if (!state.account) {
    root.append(h(`<div class="empty">${icon('account')}<div><b>${tr('Inicia sesión con Google')}</b></div><div class="muted">${tr('Para ver tus playlists, álbumes y artistas de YouTube Music.')}</div></div>`));
    const b = h(`<button class="btn primary" style="margin:0 auto;display:flex">${icon('account')}${tr('Iniciar sesión')}</button>`);
    b.onclick = () => go({ name: 'settings', section: 'account' });
    root.append(b);
    return root;
  }
  const liked = h(`<div class="card playlist"><div class="art liked">${icon('heartFill')}</div><div class="t">${tr('Me gusta')}</div><div class="s">${tr('Canciones que te gustan en YouTube Music')}</div></div>`);
  liked.onclick = () => go({ name: 'playlist', id: 'LM' });
  const lib = await api('library');
  const top = h(`<section class="section"><h2>${tr('Playlists')}</h2></section>`);
  const cards = h('<div class="cards wrap"></div>');
  cards.append(liked);
  const box = section({ title: '', layout: 'cards', items: lib.playlists.filter((p) => !isHiddenPlaylist(p.id)) }, { wrap: true });
  box.querySelectorAll('.card').forEach((c) => cards.append(c));
  top.append(cards);
  root.append(top);
  if (lib.albums.length) root.append(section({ title: tr('Álbumes'), layout: 'cards', items: lib.albums }));
  if (lib.artists.length) root.append(section({ title: tr('Artistas'), layout: 'cards', items: lib.artists }));
  try {
    const hist = await api('history');
    if (hist.length) root.append(section({ title: tr('Historial de YouTube Music'), layout: 'list', items: hist.slice(0, 20) }, { wrap: true }));
  } catch {}
  return root;
}

export async function libraryView(route) {
  const tab = route.tab || 'playlists';
  const root = h('<div></div>');
  root.append(h(`<h1 class="page-title">${tr('Biblioteca')}</h1>`));
  const chips = h('<div class="chips"></div>');
  TABS.forEach(([id, label, ic]) => {
    const c = h(`<button class="chip${id === tab ? ' active' : ''}">${label}</button>`);
    c.onclick = () => go({ name: 'library', tab: id }, { replace: true });
    chips.append(c);
  });
  root.append(chips);
  let body;
  if (tab === 'likes') body = trackList(likes.all(), { empty: `${icon('heart')}<div><b>${tr('Sin favoritos todavía')}</b></div><div class="muted">${tr('Pulsa el corazón en el reproductor (o la tecla F) para guardar canciones aquí.')}</div>` });
  else if (tab === 'downloads') body = downloadsTab();
  else if (tab === 'playlists') body = await playlistsTab();
  else if (tab === 'local') body = await localTab();
  else if (tab === 'network') body = await networkTab();
  else if (tab === 'history') body = historyTab();
  else body = await accountTab();
  root.append(body);
  return root;
}
