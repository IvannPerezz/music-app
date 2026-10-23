// Importar → Spotify account: sign in on Spotify's page, then keep the chosen playlists up to date.
import { bc, icon, esc, api, toast, h, state, confirmDialog } from './core.js';
import { go } from './app.js';
import { tr } from './i18n.js';

const S = { status: null, lists: null, loading: false, connecting: false, sel: new Set() };
let mount = null;

bc.on('spotify-sync', (st) => { S.status = st; paint(); });

function ago(ms) {
  if (!ms) return tr('nunca');
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return tr('ahora mismo');
  if (m < 60) return tr('hace {n} min', { n: m });
  const hrs = Math.round(m / 60);
  if (hrs < 48) return tr('hace {n} h', { n: hrs });
  return tr('hace {n} días', { n: Math.round(hrs / 24) });
}

/** What linking does, in a few plain words (shown before signing in). */
export const SPOTIFY_HOW = () => [
  tr('<b>Inicio de sesión:</b> entras en la página oficial de Spotify. Tu contraseña no pasa por BitChord y la sesión se queda solo en este PC.'),
  tr('<b>Lectura:</b> BitChord ve tus playlists y tus «Canciones que te gustan», pero no cambia nada en tu Spotify.'),
  tr('<b>Copia:</b> busca cada canción en YouTube Music y crea la playlist en tu cuenta, con la portada de Spotify.'),
  tr('<b>Al día:</b> al abrir BitChord y cada 6 horas se añaden las canciones nuevas y se quitan las que borraste en Spotify.'),
];

function guide() {
  const el = h(`<div class="imp-card sp-guide">
    <h2>${tr('Vincula tu cuenta de Spotify')}</h2>
    <p class="muted">${tr('Elige qué playlists de Spotify quieres tener en BitChord: se copian a tu YouTube Music y <b>se mantienen al día solas</b>.')}</p>
    <ul class="imp-help sp-how">${SPOTIFY_HOW().map((t) => `<li>${t}</li>`).join('')}</ul>
    <div class="sp-connect"></div>
    <div class="set-note">${icon('info')} <span>${tr('Entra con tu correo y contraseña o con el código que te manda Spotify. «Continuar con Google» puede fallar, porque Google suele bloquear su inicio de sesión dentro de otras apps.')}</span></div>
  </div>`);
  const box = el.querySelector('.sp-connect');
  if (S.connecting) box.append(h(`<span class="muted sp-wait">${icon('loading')} ${tr('Inicia sesión en la ventana de Spotify… (ciérrala para cancelar)')}</span>`));
  else {
    const b = h(`<button class="btn primary spotify">${icon('open')}${tr('Iniciar sesión en Spotify')}</button>`);
    b.onclick = async () => {
      S.connecting = true; paint();
      try {
        S.status = await api('spotifyConnect'); S.lists = null;
        toast(S.status.user?.name ? tr('Spotify vinculado como {name}', { name: S.status.user.name }) : tr('Spotify vinculado'));
      } catch (e) { if (e.message !== tr('Cancelado')) toast(e.message, true); }
      S.connecting = false; paint();
    };
    box.append(b);
  }
  return el;
}

async function doSync(id, opts) {
  try { S.status = await api('spotifySync', id, opts); }
  catch (e) { toast(e.message, true); }
  paint();
  const ids = id == null ? null : new Set([].concat(id));
  const errs = (S.status?.links || []).filter((l) => (!ids || ids.has(l.id)) && l.error);
  if (errs.length) toast(`${errs[0].name}: ${errs[0].error}`, true);
  else toast(tr('Playlists de Spotify actualizadas'));
}

function row(p, st) {
  const l = st.links.find((x) => x.id === p.id);
  const busy = st.busy && st.busy.name === (l?.name ?? p.name) ? st.busy : null;
  const where = l?.dest === 'view' ? tr('solo en BitChord') : tr('en tu YT Music');
  const info = l
    ? (busy ? tr('Actualizando… {done} de {total}', { done: busy.done, total: busy.count || '…' })
      : l.error ? `<span class="sp-err">${esc(l.error)}</span>`
      : !l.lastSync ? tr('Pendiente de la primera actualización')
      : `${tr('{n} canciones', { n: l.count })}${l.missing ? ' · ' + tr('{n} no encontradas en YouTube Music', { n: l.missing }) : ''} · ${where} · ${tr('actualizada {when}', { when: ago(l.lastSync) })}`)
    : [p.count != null ? tr('{n} canciones', { n: p.count }) : '', p.mine || p.liked || !p.owner ? '' : tr('de {owner}', { owner: esc(p.owner) })].filter(Boolean).join(' · ');
  const el = h(`<${l ? 'div' : 'label'} class="imp-pl sp-row${l ? ' linked' : ''}${!l && !S.sel.has(p.id) ? ' off' : ''}">
    ${l ? '' : `<input type="checkbox"${S.sel.has(p.id) ? ' checked' : ''}${st.busy ? ' disabled' : ''}>`}
    <div class="sp-img">${p.image ? `<img src="${esc(p.image)}" alt="">` : icon(p.liked ? 'heartFill' : 'queue')}</div>
    <div class="imp-pl-t"><b>${esc(p.name)}</b><div class="muted small">${info}</div></div>
  </${l ? 'div' : 'label'}>`);
  if (l) {
    if (l.lastSync && (l.target || l.dest === 'view')) {
      const open = h(`<button class="btn ghost small">${icon('play')}${tr('Abrir')}</button>`);
      open.onclick = () => go(l.dest === 'view' ? { name: 'spotify', id: l.id } : { name: 'playlist', id: l.target });
      el.append(open);
    }
    if (l.dest === 'view' && state.account) {
      const copy = h(`<button class="icon-btn" title="${tr('Copiar a YouTube Music')}"${st.busy ? ' disabled' : ''}>${icon('importIcon')}</button>`);
      copy.onclick = async () => {
        try { S.status = await api('spotifyLink', p.id, l.name, 'yt'); } catch (e) { return toast(e.message, true); }
        paint(); doSync(p.id);
      };
      el.append(copy);
    }
    const up = h(`<button class="icon-btn" title="${tr('Actualizar ahora')}"${st.busy ? ' disabled' : ''}>${icon('refresh')}</button>`);
    up.onclick = () => doSync(p.id, { force: true });
    const un = h(`<button class="icon-btn" title="${tr('Dejar de sincronizar')}"${st.busy ? ' disabled' : ''}>${icon('close')}</button>`);
    un.onclick = async () => {
      if (!(await confirmDialog(tr('Dejar de sincronizar'), tr('«{name}» ya no se actualizará con Spotify. La copia que ya tienes no se borra.', { name: p.name }), { ok: tr('Dejar de sincronizar') }))) return;
      S.status = await api('spotifyUnlink', p.id); paint();
    };
    el.append(up, un);
  } else {
    el.querySelector('input').onchange = (e) => { if (e.target.checked) S.sel.add(p.id); else S.sel.delete(p.id); paint(); };
  }
  return el;
}

function connected(st) {
  const root = h('<div></div>');
  const head = h(`<div class="imp-card sp-head">
    <div class="sp-who">${icon('check')}<div><b>${st.user?.name ? tr('Conectado como {name}', { name: esc(st.user.name) }) : tr('Sesión de Spotify iniciada')}</b><div class="muted small">${tr('{n} playlists sincronizadas', { n: st.links.length })}</div></div></div>
  </div>`);
  const all = h(`<button class="btn primary">${icon('refresh')}${tr('Actualizar todas')}</button>`);
  all.disabled = !!st.busy || !st.links.length;
  all.onclick = () => doSync(null);
  const off = h(`<button class="btn ghost">${tr('Desvincular')}</button>`);
  off.onclick = async () => {
    if (!(await confirmDialog(tr('Desvincular Spotify'), tr('BitChord cerrará la sesión de Spotify de este PC y las playlists dejarán de actualizarse. Las copias que ya tienes no se borran.'), { ok: tr('Desvincular'), danger: true }))) return;
    S.status = await api('spotifyDisconnect'); S.lists = null; paint();
  };
  head.querySelector('.sp-who').after(h('<span class="btn-row"></span>'));
  head.querySelector('.btn-row').append(all, off);
  const auto = h(`<label class="sp-auto"><span class="switch"><input type="checkbox"${st.auto ? ' checked' : ''}><span></span></span><span>${tr('Actualizar automáticamente (al abrir BitChord y cada 6 horas)')}</span></label>`);
  auto.querySelector('input').onchange = async (e) => { S.status = await api('spotifyAuto', e.target.checked); };
  head.append(auto);
  if (st.busy) {
    const pct = ((st.busy.index + (st.busy.count ? st.busy.done / st.busy.count : 0)) / st.busy.total) * 100;
    const was = mount.querySelector('.sp-busy .progress div')?.style.width;
    const b = h(`<div class="sp-busy${was ? '' : ' in'}"><div class="sp-busy-t"><b>${tr('Importando playlist {i} de {total}', { i: st.busy.index + 1, total: st.busy.total })}</b><span class="muted small">«${esc(st.busy.name)}»${st.busy.count ? ' · ' + tr('{done} de {total} canciones', { done: st.busy.done, total: st.busy.count }) : ''}</span><span class="sp-pct">${Math.round(pct)} %</span></div><div class="progress big"><div style="width:${was || '0%'}"></div></div></div>`);
    head.append(b);
    requestAnimationFrame(() => requestAnimationFrame(() => { b.querySelector('.progress div').style.width = pct + '%'; }));
  }
  root.append(head);

  if (!state.account) root.append(h(`<div class="set-note">${icon('info')} <span>${tr('Para importar a YouTube Music inicia sesión con Google en Ajustes → Cuenta. «Solo ver en BitChord» funciona sin ella.')}</span></div>`));
  root.append(h(`<h3 class="sp-title">${tr('Tus playlists de Spotify')}</h3>`));
  const list = h('<div class="imp-lists"></div>');
  const linked = new Set(st.links.map((l) => l.id));
  if (!S.lists) {
    list.append(h(`<p class="muted">${icon('loading')} ${tr('Cargando tus playlists de Spotify…')}</p>`));
    if (!S.loading) {
      S.loading = true;
      api('spotifyPlaylists').then((l) => { S.lists = l; }, (e) => { S.lists = []; toast(e.message, true); }).finally(() => { S.loading = false; paint(); });
    }
  } else {
    // Linked ones first; a linked playlist that's gone from Spotify still shows (so it can be unlinked).
    const known = new Set(S.lists.map((p) => p.id));
    const gone = st.links.filter((l) => !known.has(l.id)).map((l) => ({ id: l.id, name: l.name, count: l.count, owner: '', mine: true }));
    const all = [...gone, ...S.lists].sort((a, b) => linked.has(b.id) - linked.has(a.id));
    for (const p of all) list.append(row(p, st));
    if (!all.length) list.append(h(`<p class="muted">${tr('No hay playlists en tu Spotify.')}</p>`));
  }
  root.append(list);
  if (S.lists?.length) {
    // Bottom bar: sync every ticked playlist at once.
    const n = [...S.sel].filter((id) => S.lists.some((p) => p.id === id) && !linked.has(id)).length;
    const bar = h('<div class="actions sticky-actions sp-actions"></div>');
    const toggle = h(`<button class="btn ghost">${tr('Marcar / desmarcar todas')}</button>`);
    const free = S.lists.filter((p) => !linked.has(p.id));
    toggle.disabled = !!st.busy || !free.length;
    toggle.onclick = () => { const on = !free.every((p) => S.sel.has(p.id)); free.forEach((p) => (on ? S.sel.add(p.id) : S.sel.delete(p.id))); paint(); };
    // Two ways: a copy in the YouTube Music account, or only shown in BitChord.
    const go1 = h(`<button class="btn primary" data-dest="yt" title="${tr('Crea una copia en tu cuenta de YouTube Music que se mantiene al día con Spotify')}">${icon('importIcon')}${n ? tr('Importar {n} a YouTube Music', { n }) : tr('Importar a YouTube Music')}</button>`);
    go1.disabled = !n || !!st.busy || !state.account;
    go1.onclick = () => syncSelected('yt');
    const go2 = h(`<button class="btn spotify" data-dest="view" title="${tr('Las muestra en Biblioteca y en la barra lateral sin crear nada en YouTube Music')}">${icon('queue')}${n ? tr('Solo ver {n} en BitChord', { n }) : tr('Solo ver en BitChord')}</button>`);
    go2.disabled = !n || !!st.busy;
    go2.onclick = () => syncSelected('view');
    bar.append(go1, go2, toggle);
    root.append(bar);
  }
  return root;
}

async function syncSelected(dest) {
  const chosen = S.lists.filter((p) => S.sel.has(p.id));
  if (!chosen.length) return;
  try { for (const p of chosen) S.status = await api('spotifyLink', p.id, p.name, dest); }
  catch (e) { return toast(e.message, true); }
  S.sel.clear();
  paint();
  // Slide back up to the progress bar at the top.
  document.querySelector('#content')?.scrollTo({ top: 0, behavior: 'smooth' });
  doSync(chosen.map((p) => p.id));
}

function paint() {
  if (!mount?.isConnected) return;
  const st = S.status;
  mount.replaceChildren(!st ? h(`<p class="muted">${icon('loading')}</p>`) : st.connected ? connected(st) : guide());
}

export function spotifyLinkView() {
  mount = h('<div class="sp-link"></div>');
  mount.addEventListener('click', (e) => { const a = e.target.closest('a[data-url]'); if (a) { e.preventDefault(); e.stopPropagation(); bc.openExternal(a.dataset.url); } });
  api('spotifyStatus').then((st) => { S.status = st; paint(); });
  queueMicrotask(paint);
  return mount;
}
