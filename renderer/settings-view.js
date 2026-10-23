// Settings page.
import { lyricsLookControls } from './lyrics-look.js';
import { checkForUpdates } from './update-dialog.js';
import { bc, $, icon, esc, api, toast, h, state, saveSettings, art, store, confirmDialog } from './core.js';
import { eqPanel } from './eq-panel.js';
import { applyFont, refreshAccount, refreshView, go, SIDEBAR_ITEMS, applyCustomAccent, applyTheme, setThemeCss } from './app.js';
import { colorPicker } from './color-picker.js';
import { SPOTIFY_HOW } from './spotify-link.js';
import { tr, LANGUAGES, uiLang, syncUiLang, locale } from './i18n.js';

const QUALITY = [['low', tr('Baja (~64 kbps)')], ['normal', tr('Normal (~96 kbps)')], ['high', tr('Alta (~160 kbps)')], ['max', tr('Máxima disponible')]];
// Ajustes is split in categories (left column); each one shows its sections (cards). Links from
// elsewhere name a section (route.section): it opens its category and scrolls to it.
const CATEGORIES = [
  ['account', tr('Cuenta'), 'account', ['account', 'import']],
  ['appearance', tr('Apariencia'), 'image', ['theme', 'sidebar', 'effects', 'performance']],
  ['playback', tr('Reproducción'), 'play', ['playback', 'eq', 'lyrics']],
  ['library', tr('Fuentes y biblioteca'), 'library', ['sources', 'downloads', 'local']],
  ['integrations', tr('Integraciones'), 'sparkle', ['integrations']],
  ['general', tr('General'), 'settings', ['general', 'backup', 'about']],
];

function row(label, desc, control) {
  const el = h(`<div class="set-row"><div class="set-text"><div class="set-label">${label}</div>${desc ? `<div class="set-desc">${desc}</div>` : ''}</div><div class="set-ctl"></div></div>`);
  el.querySelector('.set-ctl').append(control);
  return el;
}

function toggle(key, onChange) {
  const el = h(`<label class="switch"><input type="checkbox"${state.settings[key] ? ' checked' : ''}><span></span></label>`);
  el.querySelector('input').onchange = async (e) => { await saveSettings({ [key]: e.target.checked }); onChange?.(e.target.checked); };
  return el;
}

function select(key, options, onChange) {
  const el = h(`<select class="select">${options.map(([v, l]) => `<option value="${esc(v)}"${String(state.settings[key]) === String(v) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`);
  el.onchange = async () => { await saveSettings({ [key]: el.value }); onChange?.(el.value); };
  return el;
}

function range(key, min, max, step, show, onInput) {
  const el = h(`<div class="range-wrap"><input type="range" min="${min}" max="${max}" step="${step}" value="${state.settings[key]}"><span class="range-val">${show(state.settings[key])}</span></div>`);
  const input = el.querySelector('input');
  input.oninput = () => { el.querySelector('.range-val').textContent = show(+input.value); onInput?.(+input.value); };
  input.onchange = () => saveSettings({ [key]: +input.value });
  return el;
}

function text(key, placeholder, { secret = false, onSave } = {}) {
  const el = h(`<div class="text-wrap"><input class="text" type="${secret ? 'password' : 'text'}" placeholder="${esc(placeholder)}" value="${esc(state.settings[key] || '')}" spellcheck="false"></div>`);
  const input = el.querySelector('input');
  input.onchange = async () => { await saveSettings({ [key]: input.value.trim() }); onSave?.(input.value.trim()); };
  return el;
}

const btn = (label, cls = 'ghost', ic = '') => h(`<button class="btn ${cls} small">${ic ? icon(ic) : ''}${esc(label)}</button>`);

/** Redraws a reorderable list and slides every row from its old place to its new one. */
function flip(list, redraw) {
  const before = new Map([...list.children].map((el) => [el.dataset.key, el.getBoundingClientRect().top]));
  redraw();
  for (const el of list.children) {
    const was = before.get(el.dataset.key);
    if (was == null) continue;
    const dy = was - el.getBoundingClientRect().top;
    if (dy) el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 300, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
}

/** Heading of a group of settings inside a section (Personalización has several). */
const sub = (title, ic) => h(`<h3 class="set-sub"><span class="set-sub-ic">${icon(ic)}</span><span>${esc(title)}</span></h3>`);

function card(id, title, ic, ...rows) {
  const el = h(`<section class="set-card" id="set-${id}"><h2>${icon(ic)}${esc(title)}</h2></section>`);
  rows.filter(Boolean).forEach((r) => el.append(r));
  return el;
}

// ------------------------------------------------------------------ sections
function playback() {
  const cf = range('crossfade', 0, 12, 1, (v) => (v ? `${v} s` : tr('No')));
  return card('playback', tr('Reproducción'), 'play',
    row(tr('Calidad de streaming'), tr('Más calidad suena mejor pero gasta más datos. «Máxima» pide siempre la mejor que haya.'), select('streamQuality', QUALITY)),
    row(tr('Reproducción sin pausas (gapless)'), tr('La siguiente canción empieza justo cuando acaba la anterior, sin silencio entre medias.'), toggle('gapless')),
    row(tr('Fundido entre canciones'), tr('Durante estos segundos, una canción se va apagando mientras entra la siguiente.'), cf),
    row(`Automix <span class="beta">Beta</span>`, tr('Mezcla las canciones como un DJ: ajusta el ritmo de la siguiente y la hace entrar a tiempo. Si los ritmos no se parecen, hace una mezcla corta. Sustituye al fundido.'), toggle('automix')),
    row(tr('Duración de la mezcla'), tr('Cuánto dura cada mezcla, en compases de la canción que suena.'), select('automixBars', [4, 8, 16].map((n) => [n, tr('{n} compases', { n })]))),
    row(tr('Saltar silencios'), tr('Se salta el silencio del principio y del final de las canciones.'), toggle('skipSilence')),
    row(tr('Normalizar volumen'), tr('Sube o baja cada canción para que todas suenen a un volumen parecido.'), toggle('normalize')),
    row(tr('Velocidad de reproducción'), tr('Más rápido o más lento sin que la voz cambie de tono.'), range('speed', 0.5, 2, 0.05, (v) => `${(+v).toFixed(2)}×`)),
    row(tr('Reproducción automática'), tr('Cuando se acaba la cola, sigue con canciones parecidas a la última.'), toggle('autoplayRadio')),
    row(tr('Recordar la cola al abrir'), tr('Al abrir BitChord, la cola y la canción vuelven a estar donde las dejaste, en pausa.'), toggle('resumeOnStart')),
  );
}

function sourcesCard() {
  const el = card('sources', tr('Fuentes de música online'), 'library',
    h(`<div class="set-note">${tr('La música sale de YouTube Music. Si activas otra fuente y tiene la misma canción, suena desde esa.')}</div>`),
    row(tr('YouTube Music'), tr('Todo el catálogo. Siempre activa.'), h(`<span class="badge">${tr('Principal')}</span>`)),
    row(tr('JioSaavn'), tr('Si la canción está en JioSaavn, suena desde ahí con más calidad (AAC a 320 kbps). Solo funciona en algunos países.'), toggle('sourceJioSaavn')),
  );
  // WebDAV servers
  const list = h('<div class="folders"></div>');
  const drawServers = async () => {
    list.innerHTML = '';
    const servers = await api('webdavServers');
    if (!servers.length) list.append(h(`<div class="set-desc">${tr('Ningún servidor añadido.')}</div>`));
    servers.forEach((sv) => {
      const it = h(`<div class="folder">${icon('folder')}<span class="path" style="direction:ltr">${esc(sv.label)} · ${esc(sv.url)}</span><span class="set-desc">${tr('{n} canciones', { n: sv.tracks })}</span><button class="icon-btn" title="${tr('Quitar')}">${icon('close')}</button></div>`);
      it.querySelector('button').onclick = async () => { await api('webdavRemove', sv.id); drawServers(); };
      list.append(it);
    });
  };
  drawServers();
  const form = h(`<details class="adv"><summary>${tr('Añadir servidor WebDAV (Nextcloud, ownCloud, Synology, QNAP…)')}</summary>
    <div class="dav-form">
      <input class="text" data-k="url" placeholder="${tr('https://mi-nas.local/remote.php/dav/files/usuario/Música/')}">
      <input class="text" data-k="user" placeholder="${tr('Usuario (opcional)')}">
      <input class="text" data-k="pass" type="password" placeholder="${tr('Contraseña (opcional)')}">
    </div></details>`);
  const addBtn = btn(tr('Probar y añadir'), 'ghost', 'check');
  addBtn.onclick = async () => {
    const v = (k) => form.querySelector(`[data-k=${k}]`).value.trim();
    addBtn.disabled = true;
    try { await api('webdavAdd', { url: v('url'), user: v('user'), pass: v('pass') }); toast(tr('Servidor añadido. Escaneando…')); form.querySelectorAll('input').forEach((i) => (i.value = '')); drawServers(); }
    catch (e) { toast(e.message, true); }
    addBtn.disabled = false;
  };
  form.append(addBtn);
  const rescan = btn(tr('Volver a escanear'), 'ghost', 'refresh');
  rescan.onclick = async () => { toast(tr('Escaneando servidores…')); const n = (await api('webdavRescan')).length; toast(tr('{n} canciones en tus servidores', { n })); drawServers(); };
  el.append(row(tr('Servidores WebDAV'), tr('Escucha la música que tengas en un NAS o en Nextcloud sin descargarla. Aparece en Biblioteca → En red.'), rescan), list, form);
  el.append(h(`<div class="set-note">${tr('Las fuentes «Hi‑Res» de la app móvil, que sacan FLAC de servicios de pago, no están incluidas.')}</div>`));
  return el;
}

function equalizer() {
  return card('eq', tr('Ecualizador'), 'equalizer',
    h(`<div class="set-note">${tr('Ajusta graves, medios y agudos de todo lo que suena, también de tu música local.')}</div>`),
    eqPanel(),
  );
}

function lyrics() {
  const list = h('<div class="prov-list"></div>');
  const draw = () => {
    list.innerHTML = '';
    const order = state.settings.lyricsOrder;
    const disabled = new Set(state.settings.lyricsDisabled || []);
    order.forEach((id, i) => {
      const p = providers.find((x) => x.id === id);
      if (!p) return;
      const el = h(`
        <div class="prov${disabled.has(id) ? ' off' : ''}" draggable="true" data-key="${esc(id)}">
          <span class="prov-n">${i + 1}</span>
          <div class="prov-t"><b>${esc(p.label)}</b>${p.word ? `<span class="badge">${tr('palabra a palabra')}</span>` : ''}<div class="set-desc">${esc(tr(p.detail))}</div></div>
          <button class="icon-btn" data-a="up" title="${tr('Subir')}">${icon('up')}</button>
          <button class="icon-btn" data-a="down" title="${tr('Bajar')}">${icon('down')}</button>
          <label class="switch"><input type="checkbox"${disabled.has(id) ? '' : ' checked'}><span></span></label>
        </div>`);
      const move = async (to) => {
        if (to < 0 || to >= order.length) return;
        const o = [...order]; const [x] = o.splice(i, 1); o.splice(to, 0, x);
        await saveSettings({ lyricsOrder: o }); flip(list, draw);
      };
      el.querySelector('[data-a=up]').onclick = () => move(i - 1);
      el.querySelector('[data-a=down]').onclick = () => move(i + 1);
      el.querySelector('input').onchange = async (e) => {
        const d = new Set(state.settings.lyricsDisabled || []);
        e.target.checked ? d.delete(id) : d.add(id);
        await saveSettings({ lyricsDisabled: [...d] }); draw();
      };
      el.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', String(i)));
      el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag-over'); });
      el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
      el.addEventListener('drop', async (e) => {
        e.preventDefault(); el.classList.remove('drag-over');
        const from = +e.dataTransfer.getData('text/plain');
        const o = [...order]; const [x] = o.splice(from, 1); o.splice(i, 0, x);
        await saveSettings({ lyricsOrder: o }); flip(list, draw);
      });
      list.append(el);
    });
  };
  draw();
  return card('lyrics', tr('Letras'), 'lyrics',
    h(`<div class="set-note">${tr('La letra se busca en este orden y se usa la primera sincronizada que aparezca. Arrastra para cambiar el orden o apaga los que no quieras.')}</div>`),
    list,
    row(tr('Clave de Spicy Lyrics'), tr('Consíguela gratis en developers.spicylyrics.org: crea una app, permite las peticiones sin «Origin» y pega aquí la clave sl_pk_. Spicy Lyrics y Musixmatch necesitan además tener Spotify vinculado.'), text('spicyLyricsKey', 'sl_pk_…', { secret: true })),
    row(tr('Sincronización palabra a palabra'), tr('Cada palabra se ilumina al cantarse. Si la letra no lo permite, se ilumina la línea entera.'), toggle('lyricsWordSync')),
    h(`<div class="set-sub">${tr('Aspecto')}</div>`),
    h(`<div class="set-note">${tr('Estos controles también están en el menú de la letra, donde ves el cambio mientras arrastras. El botón ↺ deja cada uno como estaba.')}</div>`),
    lyricsLookControls(),
  );
}

function downloads() {
  const dir = h(`<div class="path-ctl"><span class="path">${esc(state.settings.downloadDir || state.downloads.dir || tr('Música') + '\\BitChord')}</span></div>`);
  const change = btn(tr('Cambiar…'), 'ghost', 'folder');
  change.onclick = async () => { const p = await api('chooseFolder', tr('Carpeta de descargas')); if (p) { await saveSettings({ downloadDir: p }); refreshView(); } };
  dir.append(change);
  return card('downloads', tr('Descargas'), 'download',
    row(tr('Calidad de descarga'), tr('La calidad de lo que descargas. Se guarda tal cual, sin perder calidad.'), select('downloadQuality', QUALITY)),
    row(tr('Formato'), tr('Opus ocupa menos con la misma calidad. AAC (.m4a) funciona en cualquier reproductor. Los dos llevan título, artista, carátula y letra.'), select('downloadFormat', [['opus', 'Opus (.opus)'], ['m4a', 'AAC (.m4a)']])),
    row(tr('Carpeta'), tr('Dónde se guardan los archivos descargados.'), dir),
    row(tr('Descargas'), tr('{n} canciones descargadas.', { n: state.downloads.done.length }), (() => { const b = btn(tr('Ver descargas'), 'ghost', 'library'); b.onclick = () => go({ name: 'library', tab: 'downloads' }); return b; })()),
  );
}

function localMusic() {
  const box = h('<div class="folders"></div>');
  const folders = state.settings.localFolders || [];
  if (!folders.length) box.append(h(`<div class="set-desc">${tr('Aún no has añadido ninguna carpeta.')}</div>`));
  api('localFolders').then((info) => {
    folders.forEach((f) => {
      const fi = info.find((x) => x.path === f);
      const el = h(`<div class="folder">
        <div class="folder-art">${fi?.cover ? `<img src="${esc(art(fi.cover))}" alt="">` : fi?.thumbs?.[0] ? `<img src="${esc(art(fi.thumbs[0]))}" alt="">` : icon('folder')}</div>
        <div class="folder-text"><b class="ellipsis">${esc(fi?.name || f)}</b><span class="folder-sub"><span class="path"><bdi>${esc(f)}</bdi></span><span>${fi ? `&nbsp;· ${tr('{n} canciones', { n: fi.count })}` : ''}${fi?.watched ? ' · ' + tr('se actualiza sola') : ''}</span></span></div>
        <button class="btn ghost small" data-a="open">${tr('Ver playlist')}</button>
        <button class="icon-btn" data-a="rm" title="${tr('Quitar de BitChord (no borra nada del disco)')}">${icon('close')}</button></div>`);
      el.querySelector('[data-a=open]').onclick = () => fi && go({ name: 'localfolder', id: fi.id });
      el.querySelector('[data-a=rm]').onclick = async () => { await saveSettings({ localFolders: folders.filter((x) => x !== f) }); refreshView(); };
      box.append(el);
    });
  });
  const add = btn(tr('Añadir carpeta'), 'ghost', 'folder');
  add.onclick = async () => {
    const p = await api('chooseFolder', tr('Carpeta con música'));
    if (p && !folders.includes(p)) { await saveSettings({ localFolders: [...folders, p] }); toast(tr('Escaneando la carpeta…')); refreshView(); }
  };
  const rescan = btn(tr('Volver a escanear'), 'ghost', 'refresh');
  rescan.onclick = async () => { toast(tr('Escaneando…')); const n = (await api('localRescan')).length; toast(tr('{n} canciones en tu equipo', { n })); };
  const unc = h(`<input class="text" placeholder="${tr('Escribe una ruta...')}" style="min-width:260px">`);
  unc.onkeydown = async (e) => {
    if (e.key !== 'Enter') return;
    const p = unc.value.trim();
    if (p && !folders.includes(p)) { await saveSettings({ localFolders: [...folders, p] }); toast(tr('Escaneando la carpeta…')); refreshView(); }
  };
  const actions = h('<div class="btn-row local-actions"></div>'); actions.append(unc, add, rescan);
  return card('local', tr('Música local'), 'computer',
    h(`<div class="set-note">${tr('Cada carpeta que añadas aparece como una playlist en Biblioteca → En este equipo. Vale MP3, M4A, FLAC, OGG, Opus, WAV y más.')}</div>`),
    box, actions,
    row(tr('Actualizar automáticamente'), tr('Si añades o quitas canciones de una carpeta, BitChord se entera solo. En carpetas de red puede que no: usa «Volver a escanear».'), toggle('localWatch')),
  );
}

function importCard() {
  const link = btn(tr('Vincular cuenta de Spotify…'), 'spotify', 'open');
  link.onclick = () => go({ name: 'spotify-import' });
  return card('import', tr('Importar de Spotify'), 'importIcon',
    row(tr('Cuenta de Spotify'), tr('Lleva tus playlists de Spotify a YouTube Music y las mantiene al día. Necesitas haber iniciado sesión con Google.'), link),
    h(`<ul class="set-note sp-how">${SPOTIFY_HOW().map((t) => `<li>${t}</li>`).join('')}</ul>`),
  );
}

function account() {
  const a = state.account;
  const el = card('account', tr('Cuenta de Google'), 'account');
  if (a) {
    el.append(h(`<div class="acct">${a.photo ? `<img src="${esc(a.photo)}" alt="">` : icon('account')}<div><b>${esc(a.name || tr('Sesión iniciada'))}</b><div class="set-desc">${esc(a.handle || 'YouTube Music')}</div></div></div>`));
    const out = btn(tr('Cerrar sesión'), 'ghost', 'logout');
    out.onclick = async () => { await api('logout'); await refreshAccount(); toast(tr('Sesión cerrada')); refreshView(); };
    el.append(row(tr('Biblioteca y recomendaciones'), tr('Ves tu inicio, tus playlists y tus «Me gusta», y lo que hagas aquí se guarda en tu cuenta. Al cerrar sesión se borran tus datos de acceso de este equipo.'), out));
  } else {
    const login = btn(tr('Iniciar sesión con Google'), 'primary', 'account');
    login.onclick = async () => {
      login.disabled = true;
      try {
        const r = await api('login');
        if (r !== null) { await refreshAccount(); toast(tr('Sesión iniciada')); refreshView(); }
      } catch (e) { toast(e.message, true); }
      login.disabled = false;
    };
    el.append(row(tr('Inicia sesión'), tr('Se abre la página de Google para entrar. Tu contraseña no pasa por BitChord y el acceso se guarda cifrado en este equipo.'), login));
    const manual = h(`<details class="adv"><summary>${tr('¿Google no te deja entrar? Pega la cookie a mano')}</summary>
      <div class="set-desc">${tr('En el navegador, entra en music.youtube.com, pulsa F12 → Red, recarga y copia el valor de la cabecera <b>cookie</b> de cualquier petición.')}</div>
      <textarea class="text" rows="3" placeholder="VISITOR_INFO1_LIVE=…; SAPISID=…; …"></textarea></details>`);
    const save = btn(tr('Usar esta cookie'), 'ghost');
    save.onclick = async () => {
      try { await api('loginCookie', manual.querySelector('textarea').value); await refreshAccount(); toast(tr('Sesión iniciada')); refreshView(); }
      catch (e) { toast(e.message, true); }
    };
    manual.append(save);
    el.append(manual);
  }
  return el;
}

function integrations() {
  const lbStatus = h(`<span class="set-desc"></span>`);
  const lb = text('listenbrainzToken', tr('Token de usuario de ListenBrainz'), {
    secret: true,
    onSave: async (v) => {
      if (!v) return (lbStatus.textContent = '');
      const r = await api('listenbrainzValidate', v).catch(() => ({ ok: false }));
      lbStatus.textContent = r.ok ? '✓ ' + tr('Conectado como {user}', { user: r.user }) : '✗ ' + tr('Token no válido');
    },
  });
  lb.append(lbStatus);

  const lfm = h('<div class="stack"></div>');
  lfm.append(text('lastfmApiKey', 'API key'), text('lastfmSecret', 'Shared secret', { secret: true }));
  const lfmBtns = h('<div class="btn-row"></div>');
  if (state.settings.lastfmSession) {
    lfmBtns.append(h(`<span class="set-desc">✓ ${tr('Conectado como {user}', { user: `<b>${esc(state.settings.lastfmUser)}</b>` })}</span>`));
    const out = btn(tr('Desconectar'), 'ghost');
    out.onclick = async () => { await api('lastfmLogout'); state.settings = await api('settingsGet'); refreshView(); };
    lfmBtns.append(out);
  } else {
    const c1 = btn(tr('1. Autorizar en Last.fm'), 'ghost', 'open');
    const c2 = btn(tr('2. Ya he autorizado'), 'ghost', 'check');
    c1.onclick = async () => { try { await api('lastfmBegin'); toast(tr('Autoriza BitChord en el navegador y vuelve aquí')); } catch (e) { toast(e.message, true); } };
    c2.onclick = async () => { try { const r = await api('lastfmFinish'); state.settings = await api('settingsGet'); toast(tr('Conectado como {user}', { user: r.user })); refreshView(); } catch (e) { toast(e.message, true); } };
    lfmBtns.append(c1, c2);
  }
  lfm.append(lfmBtns);

  return card('integrations', tr('Integraciones'), 'sparkle',
    row(tr('Discord Rich Presence'), tr('Tu perfil de Discord muestra lo que estás escuchando. Solo hace falta tener Discord abierto en este PC.'), toggle('discordRpc')),
    row(tr('ListenBrainz'), tr('Guarda en <a href="#" data-url="https://listenbrainz.org/settings/">ListenBrainz</a> lo que escuchas. Pega el token que aparece en sus ajustes.'), lb),
    row(tr('Last.fm'), tr('Igual con Last.fm: crea una clave gratis en <a href="#" data-url="https://www.last.fm/api/account/create">last.fm/api</a>, pégala con su «shared secret» y autoriza a BitChord en la web.'), lfm),
    row(tr('Porcentaje para scrobblear'), tr('Una canción cuenta como escuchada al llegar a este porcentaje o a los 4 minutos, lo que pase antes.'), range('scrobblePercent', 30, 90, 5, (v) => `${v} %`)),
  );
}

const THEME_TEMPLATE = `/* Cambia los colores que quieras y pulsa «Vista previa» para verlo.
   Puedes añadir cualquier otra regla CSS debajo. */
:root {
  --bg: #0d0d0f;             /* fondo de la app */
  --surface: #1c1c1e;        /* tarjetas y filas */
  --surface-2: #2c2c2e;
  --text: #f2f2f7;           /* texto */
  --muted: #8e8e93;          /* texto secundario */
  --accent: #940825;         /* con «Color de acento: El del tema» */
  --accent-soft: rgba(148, 8, 37, .18);
  --chrome: rgba(20, 20, 22, .78);
  --chrome-solid: rgba(18, 18, 20, .97); /* paneles sin efecto Mica */
  --popup: rgba(40, 40, 44, .97);
  --mica-rgb: 36, 36, 42;    /* tinte del efecto Mica (R, G, B) */
}
`;

/** Colours for a theme's preview tile, read from its CSS (falls back to BitChord's). */
function themeColors(css = '') {
  const v = (name, def) => (new RegExp(`--${name}\\s*:\\s*([^;}]+)`).exec(css)?.[1].trim()) || def;
  return { bg: v('bg', '#0d0d0f'), surf: v('surface', '#1c1c1e'), acc: v('accent', '#940825') };
}

/** Modal with a CSS editor. Resolves with { name, css } or null if cancelled. */
function themeEditor(theme) {
  return new Promise((resolve) => {
    const m = h(`<div class="modal-back"><div class="modal theme-editor">
      <h3>${tr(theme ? 'Editar tema' : 'Nuevo tema')}</h3>
      <p class="muted">${tr('Cambia los colores de la plantilla. Para usar tu <code>--accent</code>, elige «El del tema» en <b>Color de acento</b>.')}</p>
      <input class="text" type="text" placeholder="${tr('Nombre del tema')}" spellcheck="false">
      <textarea class="text" spellcheck="false"></textarea>
      <div class="te-err"></div>
      <div class="btn-row"><button class="btn ghost small" data-a="preview">${tr('Vista previa')}</button><button class="btn ghost small" data-a="no">${tr('Cancelar')}</button><button class="btn primary small" data-a="ok">${tr('Guardar y usar')}</button></div>
    </div></div>`);
    const name = m.querySelector('input'), code = m.querySelector('textarea'), err = m.querySelector('.te-err');
    name.value = theme?.name || tr('Mi tema {n}', { n: (state.settings.customThemes || []).length + 1 });
    code.value = theme?.css ?? THEME_TEMPLATE;
    const check = () => {
      // Count braces to catch the most common mistake (an unclosed block) before applying it.
      const open = (code.value.match(/{/g) || []).length, close = (code.value.match(/}/g) || []).length;
      err.textContent = open === close ? '' : tr('Revisa las llaves: hay {open} «{» y {close} «}».', { open, close });
      return open === close;
    };
    const done = (v) => { m.remove(); document.removeEventListener('keydown', key, true); resolve(v); };
    const cancel = () => { applyTheme(); done(null); };
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); cancel(); } };
    code.addEventListener('keydown', (e) => {
      e.stopPropagation(); // keep the app's keyboard shortcuts out of the editor
      if (e.key === 'Tab') { e.preventDefault(); code.setRangeText('  ', code.selectionStart, code.selectionEnd, 'end'); }
    });
    name.addEventListener('keydown', (e) => e.stopPropagation());
    code.addEventListener('input', check);
    m.querySelector('[data-a=preview]').onclick = () => { if (check()) setThemeCss(code.value); };
    m.querySelector('[data-a=no]').onclick = cancel;
    m.querySelector('[data-a=ok]').onclick = () => { if (check()) done({ name: name.value.trim() || tr('Mi tema'), css: code.value }); };
    document.addEventListener('keydown', key, true);
    document.body.append(m);
    setTimeout(() => code.focus(), 0);
  });
}

function themeCard() {
  const mode = state.settings.accentMode || (state.settings.dynamicAccent === false ? 'theme' : 'cover');
  const pickerRow = h(`<div class="cp-row"${mode === 'custom' ? '' : ' hidden'}><div class="set-text"><div class="set-label">${tr('Tu color')}</div><div class="set-desc">${tr('Elige el color arrastrando o escribe su código (#RRGGBB).')}</div></div></div>`);
  pickerRow.append(colorPicker(state.settings.customAccent || '#940825', {
    onChange: (hex) => applyCustomAccent(hex),
    onCommit: (hex) => saveSettings({ customAccent: hex }),
  }));
  const accentSel = select('accentMode', [['cover', tr('Según la portada')], ['theme', tr('El del tema')], ['custom', tr('Personalizado…')]], (v) => { pickerRow.hidden = v !== 'custom'; });
  accentSel.value = mode;
  const grid = h('<div class="theme-grid"></div>');
  const draw = () => {
    grid.innerHTML = '';
    const custom = state.settings.customThemes || [];
    const current = custom.some((t) => t.id === state.settings.theme) ? state.settings.theme : 'default';
    const tile = (id, name, css, editable) => {
      const c = themeColors(css);
      const el = h(`<div class="theme-opt${current === id ? ' on' : ''}" role="button" tabindex="0" title="${esc(name)}">
        <div class="theme-prev" style="background:${esc(c.bg)}"><i></i><i></i><b style="background:${esc(c.acc)}"></b><u style="background:${esc(c.surf)}"></u></div>
        <span>${esc(name)}</span>
        ${editable ? `<div class="theme-acts"><button data-a="edit" title="${tr('Editar')}">${icon('edit')}</button><button data-a="del" title="${tr('Eliminar')}">${icon('trash')}</button></div>` : ''}</div>`);
      el.onclick = async (e) => {
        const act = e.target.closest('[data-a]')?.dataset.a;
        if (act === 'edit') {
          const r = await themeEditor(custom.find((x) => x.id === id));
          if (r) await saveSettings({ customThemes: custom.map((x) => (x.id === id ? { ...x, ...r } : x)), theme: id });
        } else if (act === 'del') {
          if (!(await confirmDialog(tr('Eliminar tema'), tr('¿Eliminar «{name}»? No se puede deshacer.', { name }), { ok: tr('Eliminar'), danger: true }))) return;
          await saveSettings({ customThemes: custom.filter((x) => x.id !== id), theme: current === id ? 'default' : current });
        } else {
          await saveSettings({ theme: id });
        }
        draw();
      };
      el.onkeydown = (e) => { if (e.target === el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); el.click(); } };
      grid.append(el);
    };
    tile('default', 'BitChord', '', false);
    custom.forEach((t) => tile(t.id, t.name, t.css, true));
    const add = h(`<button class="theme-opt theme-add" title="${tr('Crear un tema con tu propio CSS')}"><div class="theme-prev">${icon('add')}</div><span>${tr('Crear tema')}</span></button>`);
    add.onclick = async () => {
      const r = await themeEditor(null);
      if (!r) return;
      const id = 'c' + Date.now().toString(36);
      await saveSettings({ customThemes: [...custom, { id, ...r }], theme: id });
      draw();
    };
    grid.append(add);
  };
  draw();
  return card('theme', tr('Tema'), 'sparkle',
    h(`<div class="set-note">${tr('Crea tus propios temas con <b>+</b> y pruébalos con «Vista previa» antes de guardarlos. Pasa el ratón por uno tuyo para editarlo o borrarlo.')}</div>`),
    grid,
    row(tr('Color de acento'), tr('El color de botones y resaltados. «Según la portada» lo saca de la carátula que suena.'), accentSel),
    pickerRow,
  );
}

/** Playlists hidden in BitChord (ones YouTube won't delete), with a button to show each again. */
function hiddenPlaylistsBlock() {
  const box = h('<div></div>');
  const draw = () => {
    box.replaceChildren();
    const list = state.settings.hiddenPlaylists || [];
    if (!list.length) return;
    box.append(sub(tr('Playlists ocultas'), 'queue'), h(`<div class="set-note">${tr('Playlists que no quieres ver aquí. Siguen en tu cuenta de YouTube Music.')}</div>`));
    for (const p of list) {
      const b = btn(tr('Mostrar'), 'ghost');
      b.onclick = async () => { await saveSettings({ hiddenPlaylists: (state.settings.hiddenPlaylists || []).filter((x) => x.id !== p.id) }); import('./app.js').then((m) => m.renderSidebar()); draw(); };
      box.append(row(esc(p.title), '', b));
    }
  };
  draw();
  return box;
}

function sidebarCard() {
  const list = h('<div class="prov-list"></div>');
  const draw = () => {
    list.innerHTML = '';
    const items = state.settings.sidebar || [];
    items.forEach(({ id, on }, i) => {
      const it = SIDEBAR_ITEMS[id];
      if (!it) return;
      const group = tr({ main: 'Navegación', lib: 'Atajo de Biblioteca', player: 'Reproductor' }[it.group]);
      const el = h(`
        <div class="prov${on ? '' : ' off'}" draggable="true" data-key="${esc(id)}">
          <span class="prov-n">${icon(it.icon)}</span>
          <div class="prov-t"><b>${esc(it.label)}</b><div class="set-desc">${group}</div></div>
          <button class="icon-btn" data-a="up" title="${tr('Subir')}">${icon('up')}</button>
          <button class="icon-btn" data-a="down" title="${tr('Bajar')}">${icon('down')}</button>
          <label class="switch"><input type="checkbox"${on ? ' checked' : ''}><span></span></label>
        </div>`);
      const save = async (next) => { await saveSettings({ sidebar: next }); flip(list, draw); };
      const move = (to) => {
        if (to < 0 || to >= items.length) return;
        const o = items.map((x) => ({ ...x })); const [x] = o.splice(i, 1); o.splice(to, 0, x); save(o);
      };
      el.querySelector('[data-a=up]').onclick = () => move(i - 1);
      el.querySelector('[data-a=down]').onclick = () => move(i + 1);
      el.querySelector('input').onchange = (e) => save(items.map((x, k) => (k === i ? { ...x, on: e.target.checked } : x)));
      el.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', String(i)));
      el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag-over'); });
      el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
      el.addEventListener('drop', (e) => {
        e.preventDefault(); el.classList.remove('drag-over');
        const from = +e.dataTransfer.getData('text/plain');
        const o = items.map((x) => ({ ...x })); const [x] = o.splice(from, 1); o.splice(i, 0, x); save(o);
      });
      list.append(el);
    });
  };
  draw();
  const reset = btn(tr('Restablecer'), 'ghost', 'refresh');
  reset.onclick = async () => { await saveSettings({ sidebar: (await api('settingsDefaults')).sidebar }); draw(); };
  const info = h('<div class="info-grid"></div>');
  const INFO = [
    ['format', tr('Formato y códec'), tr('FLAC, MP3, AAC… y si es sin pérdida')], ['bitrate', 'Bitrate', tr('kbps del audio')],
    ['sampleRate', tr('Frecuencia de muestreo'), tr('44,1 kHz, 96 kHz…')], ['bitDepth', tr('Profundidad de bits'), '16-bit, 24-bit…'],
    ['channels', tr('Canales'), tr('Mono, estéreo, 5.1…')], ['size', tr('Tamaño del archivo'), tr('En MB')],
    ['year', tr('Año'), tr('De las etiquetas')], ['genre', tr('Género'), tr('De las etiquetas')],
    ['album', tr('Columna de álbum'), ''], ['path', tr('Ruta del archivo'), tr('Carpeta donde está')],
  ];
  INFO.forEach(([k, label, desc]) => {
    const el = h(`<label class="info-opt"><input type="checkbox"${state.settings.localInfo?.[k] ? ' checked' : ''}><span><b>${esc(label)}</b>${desc ? `<small>${esc(desc)}</small>` : ''}</span></label>`);
    el.querySelector('input').onchange = (e) => saveSettings({ localInfo: { ...state.settings.localInfo, [k]: e.target.checked } });
    info.append(el);
  });
  // Home screen sections.
  const HOME_KNOWN = [
    ['recent', tr('Escuchado recientemente'), tr('Lo último que has puesto en este equipo')], ['library', tr('De tu biblioteca'), ''],
    ['quick', tr('Selecciones rápidas'), ''], ['covers', tr('Versiones y remixes'), ''], ['forgotten', tr('Favoritos olvidados'), ''],
    ['trending', tr('Canciones en tendencia para ti'), ''], ['discover', tr('Nuevos descubrimientos y los favoritos de siempre'), ''],
  ];
  const seen = store.get('homeSeen', {});
  const extra = Object.entries(seen).filter(([k]) => !HOME_KNOWN.some(([kk]) => kk === k)).map(([k, t]) => [k, t, tr('Visto en tu pantalla principal')]);
  const homeGrid = h('<div class="info-grid"></div>');
  for (const [k, label, desc] of [...HOME_KNOWN, ...extra]) {
    const on = !(state.settings.homeHidden || []).includes(k);
    const el = h(`<label class="info-opt"><input type="checkbox"${on ? ' checked' : ''}><span><b>${esc(label)}</b>${desc ? `<small>${esc(desc)}</small>` : ''}</span></label>`);
    el.querySelector('input').onchange = (e) => {
      const set = new Set(state.settings.homeHidden || []);
      if (e.target.checked) set.delete(k); else set.add(k);
      saveSettings({ homeHidden: [...set] });
    };
    homeGrid.append(el);
  }
  const live = (key, fn) => (v) => { state.settings = { ...state.settings, [key]: v }; fn(); };
  const amb = () => import('./app.js').then((m) => m.applyAmbient());
  const mica = () => import('./app.js').then((m) => m.applyMica());
  // Interface font: SF Pro Display comes from the user's own files (the first time it's chosen,
  // they're copied from the "sf-pro-display" folder on the Desktop, or from a folder picked).
  const font = select('uiFont', [['default', tr('Inter (la de siempre)')], ['sf', 'SF Pro Display']], async (v) => {
    if (v !== 'sf') return;
    const st = await api('fontStatus');
    if (st.installed) return;
    let n = 0;
    try { n = await api('fontImport'); } catch (e) { toast(e.message, true); }
    if (!n) { font.value = 'default'; await saveSettings({ uiFont: 'default' }); return; }
    toast(tr('SF Pro Display añadida ({n} archivos)', { n }));
    applyFont();
  });
  // Two sections (Apariencia shows both): the interface itself, and the background and glass effects.
  return [
    card('sidebar', tr('Interfaz'), 'tune',
      sub(tr('Fuente'), 'edit'),
      row(tr('Emojis de Apple'), tr('Usa los emojis de Apple si tienes instalada la fuente «Apple Color Emoji». Si no, se ven los de Windows.'), toggle('appleEmoji')),
      row(tr('Fuente de la aplicación'), tr('La letra de toda la app. Para SF Pro Display hacen falta sus archivos: BitChord los coge de la carpeta «sf-pro-display» del Escritorio o de la que elijas.'), font),
      hiddenPlaylistsBlock(),
      sub(tr('Pantalla principal'), 'home'),
      h(`<div class="set-note">${tr('Elige qué apartados quieres ver en Inicio. También puedes ocultar uno desde Inicio pasando el ratón por encima.')}</div>`),
      homeGrid,
      sub(tr('Barra lateral'), 'menu'),
      row(tr('Mostrar la barra lateral'), tr('Siempre visible, oculta hasta que acercas el ratón al borde izquierdo, u oculta con un botón para abrirla.'),
        select('sidebarMode', [['fixed', tr('Siempre visible')], ['hover', tr('Al pasar el ratón por la izquierda')], ['button', tr('Con un botón')]])),
      h(`<div class="set-note">${tr('Elige qué aparece en la barra lateral y en qué orden. <b>Ajustes</b> sigue siempre arriba a la derecha, junto a tu perfil.')}</div>`),
      list,
      row(tr('Volver a la configuración original'), tr('Devuelve los elementos y el orden de la barra lateral a los de serie.'), reset),
      sub(tr('Datos de las pistas en «En este equipo»'), 'computer'),
      h(`<div class="set-note">${tr('Qué información de cada archivo se muestra en tu música local.')}</div>`),
      info,
    ),
    card('effects', tr('Fondo y efectos'), 'image',
      sub(tr('Fondo animado'), 'image'),
      h(`<div class="set-note">${tr('La carátula que suena, muy desenfocada y moviéndose despacio detrás de la app. Se para cuando no suena nada.')}</div>`),
      row(tr('Fondo animado'), tr('Si lo apagas, el fondo es el color del tema y la gráfica descansa.'), toggle('ambient', () => amb())),
      row(tr('Estilo'), tr('La carátula girando despacio o manchas con sus colores.'), select('ambientMode', [['cover', tr('Portada desenfocada')], ['colors', tr('Manchas de color')]], () => amb())),
      row(tr('Intensidad del brillo'), tr('Cuánto se ve el fondo animado.'), range('ambientIntensity', 5, 100, 1, (v) => `${v} %`, live('ambientIntensity', amb))),
      row(tr('Desenfoque'), tr('Cuanto más alto, más suaves y mezclados los colores.'), range('ambientBlur', 20, 220, 5, (v) => `${v} px`, live('ambientBlur', amb))),
      row(tr('Velocidad de movimiento'), tr('Lo rápido que se mueve el fondo. Con 0 se queda quieto.'), range('ambientSpeed', 0, 100, 1, (v) => (v ? `${v} %` : tr('Quieto')), live('ambientSpeed', amb))),
      row(tr('Tamaño'), tr('El tamaño de la carátula o de las manchas de color.'), range('ambientSize', 50, 160, 5, (v) => `${v} %`, live('ambientSize', amb))),
      row(tr('Saturación'), tr('Lo vivos que se ven los colores. Al 0 % queda en blanco y negro.'), range('ambientSaturation', 0, 250, 5, (v) => `${v} %`, live('ambientSaturation', amb))),
      sub(tr('Portadas animadas'), 'album'),
      row(tr('Portada animada'), tr('Si la canción tiene portada animada (un vídeo corto en bucle), se ve en la vista de portada y letra y en pantalla completa.'), toggle('animatedCovers')),
      sub(tr('Efecto Mica'), 'sparkle'),
      h(`<div class="set-note">${tr('Los paneles se ven como un cristal teñido con el color del tema. Puedes activarlo en cada panel por separado.')}</div>`),
      row(tr('Barra lateral izquierda'), '', toggle('micaSidebar', () => mica())),
      row(tr('Cola (barra lateral derecha)'), '', toggle('micaQueue', () => mica())),
      row(tr('Controles de reproducción (abajo)'), '', toggle('micaPlayer', () => mica())),
      row(tr('Botones de pantalla completa'), tr('Los botones de la vista de portada y letra y de la pantalla completa también se ven como cristal.'), toggle('micaLyrics', () => mica())),
      row(tr('Intensidad del tinte'), tr('Cuánto color del tema lleva el cristal.'), range('micaTint', 0, 100, 1, (v) => `${v} %`, live('micaTint', mica))),
      row(tr('Desenfoque del cristal'), tr('Cuánto se difumina lo que hay detrás. A 0 el cristal es transparente.'), range('micaBlur', 0, 120, 2, (v) => `${v} px`, live('micaBlur', mica))),
      row(tr('Saturación'), tr('Lo vivos que se ven los colores a través del cristal.'), range('micaSaturation', 100, 300, 5, (v) => `${v} %`, live('micaSaturation', mica))),
    ),
  ];
}

function performanceCard() {
  return card('performance', tr('Rendimiento'), 'speed',
    h(`<div class="set-note">${tr('Quita los efectos que más gastan, para equipos modestos, portátiles con batería o para jugar mientras escuchas música. También tienes el botón del velocímetro, arriba a la derecha.')}</div>`),
    row(tr('Modo rendimiento'), tr('Se quitan los fondos animados, el cristal, el visualizador y las animaciones. Tus ajustes no se pierden: al desactivarlo todo vuelve como estaba.'), toggle('performanceMode')),
  );
}

function general() {
  // Interface language: kept apart from YouTube Music's (titles and recommendations). The
  // modules read it as they load, so changing it reloads the window.
  const langSel = select('uiLanguage', LANGUAGES, async (v) => {
    if (v === uiLang()) return;
    syncUiLang(v);
    toast(tr('Cambiando el idioma…'));
    setTimeout(() => location.reload(), 300);
  });
  return card('general', tr('General'), 'settings',
    row(tr('Idioma de la interfaz'), tr('El idioma de la app (el de YouTube Music se elige aparte). Al cambiarlo, la ventana se recarga.'), langSel),
    row(tr('Botones de la ventana'), tr('Los círculos de colores de macOS o los botones de Windows. BitChord se reinicia al cambiarlo.'), select('windowButtons', [['mac', tr('Estilo macOS')], ['windows', tr('Estilo Windows')]])),
    row(tr('Cerrar a la bandeja del sistema'), tr('Al cerrar la ventana, la música sigue y BitChord se queda junto al reloj. Para salir del todo: clic derecho en su icono → Salir.'), toggle('closeToTray')),
    row(tr('Idioma de YouTube Music'), tr('El idioma de los títulos y recomendaciones de YouTube Music.'), select('language', [['es', 'Español'], ['en', 'English'], ['pt', 'Português'], ['fr', 'Français'], ['de', 'Deutsch'], ['it', 'Italiano']])),
    row(tr('País'), tr('Cambia las listas de éxitos, las recomendaciones y qué canciones están disponibles.'), select('region', [['ES', tr('España')], ['MX', tr('México')], ['AR', 'Argentina'], ['CO', 'Colombia'], ['CL', 'Chile'], ['PE', tr('Perú')], ['US', tr('Estados Unidos')], ['GB', tr('Reino Unido')]])),
    row(tr('Historial de reproducción'), tr('Las canciones que has escuchado en este equipo. No toca el historial de tu cuenta de YouTube.'), (() => { const b = btn(tr('Borrar historial'), 'ghost', 'trash'); b.onclick = () => { localStorage.setItem('bc.history', '[]'); toast(tr('Historial borrado')); }; return b; })()),
  );
}

// Everything customised, in one file to take to another PC.
function backupCard() {
  const localStore = () => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith('bc.')) o[k] = localStorage.getItem(k); } return o; };
  const exp = btn(tr('Exportar…'), 'primary', 'download');
  exp.onclick = async () => {
    try {
      const r = await api('configExport', localStore());
      if (r) toast(tr('Configuración guardada en {file}', { file: r.file.split(/[\\/]/).pop() }));
    } catch (e) { toast(e.message, true); }
  };
  const imp = btn(tr('Importar…'), 'ghost', 'importIcon');
  imp.onclick = async () => {
    let m;
    try { m = await api('configOpen'); } catch (e) { return toast(e.message, true); }
    if (!m) return;
    const what = [
      tr('ajustes, temas y personalización'),
      m.covers ? tr('{n} portadas', { n: m.covers }) : null,
      m.spotifyLinks ? tr('{n} playlists vinculadas con Spotify', { n: m.spotifyLinks }) : null,
    ].filter(Boolean).join(', ');
    const when = new Date(m.created).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });
    if (!(await confirmDialog(tr('Importar configuración'), tr('Copia del {when} (BitChord {version}) con {what}. Sustituirá la configuración de este equipo y BitChord se reiniciará.', { when, version: m.version, what }), { ok: tr('Importar y reiniciar') }))) return;
    try {
      const local = await api('configApply');
      for (const [k, v] of Object.entries(local)) localStorage.setItem(k, v);
      toast(tr('Configuración importada. Reiniciando…'));
      setTimeout(() => api('appRelaunch'), 600);
    } catch (e) { toast(e.message, true); }
  };
  const box = h('<span class="btn-row"></span>');
  box.append(exp, imp);
  return card('backup', tr('Copia de la configuración'), 'folder',
    h(`<div class="set-note">${icon('info')} <span>${tr('Guarda todo lo que has personalizado en un archivo <b>.bitchord</b> para llevártelo a otro PC.')}</span></div>`),
    row(tr('Exportar o importar'), tr('Al importarlo se sustituye la configuración de este equipo y BitChord se reinicia.'), box),
    h(`<div class="set-note">${tr('No incluye tus sesiones (Google, Spotify, Last.fm…) ni tu música: en el otro PC tendrás que volver a entrar.')}</div>`),
  );
}

async function about() {
  const i = await bc.appInfo();
  const log = btn(tr('Abrir registro'), 'ghost', 'folder');
  log.onclick = () => bc.openLog();
  const now = btn(tr('Buscar ahora'), 'ghost', 'refresh');
  now.onclick = async () => { now.disabled = true; try { await checkForUpdates({ manual: true }); } finally { now.disabled = false; } };
  return card('about', tr('Acerca de'), 'info',
    h(`<div class="set-note">BitChord Desktop ${esc(i.version)} — ${tr('port para Windows de')} <a href="#" data-url="https://github.com/kushagrasinghx/BitChord">BitChord</a> (GPL-3.0). Electron ${esc(i.electron)} · Chromium ${esc(i.chrome)}.<br>${tr('No está afiliado a YouTube ni a Google.')}</div>`),
    row(tr('Buscar actualizaciones al abrir'), tr('Al abrir BitChord, mira si hay una versión nueva y te avisa con sus novedades. Se descarga e instala con un clic.'), toggle('updateCheck')),
    row(tr('Buscar actualizaciones'), tr('Mira ahora si hay una versión nueva, aunque la hayas omitido.'), now),
    row(tr('Registro de diagnóstico'), tr('Un archivo donde BitChord apunta lo que va haciendo. Si algo falla, es lo primero que hay que mirar.'), log),
    h(`<div class="set-note keys"><b>${tr('Atajos')}</b><br>${tr('Espacio play/pausa · Ctrl+←/→ anterior/siguiente · ←/→ ±5 s · ↑/↓ volumen · E ecualizador · L letra · Q cola · V visualizador · S aleatorio · R repetir · M silenciar · F favorito · F11 pantalla completa · Ctrl+F buscar · Ctrl+, ajustes')}</div>`),
  );
}

let providers = [];
const BUILD = {
  account: () => account(), import: () => importCard(), theme: () => themeCard(), sidebar: () => sidebarCard(),
  effects: () => [], performance: () => performanceCard(), playback: () => playback(), eq: () => equalizer(), lyrics: () => lyrics(),
  sources: () => sourcesCard(), downloads: () => downloads(), local: () => localMusic(), integrations: () => integrations(),
  general: () => general(), backup: () => backupCard(), about: () => about(),
};
export async function settingsView(route) {
  providers = await api('lyricsProviders');
  state.settings = await api('settingsGet');
  try { state.downloads = await api('downloads'); } catch {}
  const catOf = (section) => CATEGORIES.find((c) => c[3].includes(section))?.[0];
  let cat = (route.section && catOf(route.section)) || (CATEGORIES.some((c) => c[0] === store.get('settingsCat')) ? store.get('settingsCat') : 'account');
  const outer = h(`<div class="set-wrap"><div class="settings set-title"><h1 class="page-title">${tr('Ajustes')}</h1></div><div class="set-layout"><nav class="set-nav"></nav><div class="set-pane"><div class="settings set-inner"></div></div></div></div>`);
  // Only the sections scroll (.set-pane); the title and the categories stay put.
  const nav = outer.querySelector('.set-nav'), pane = outer.querySelector('.set-pane'), inner = outer.querySelector('.set-inner');
  // The top edge fades only once something has scrolled under it (at the top the cards look sharp).
  pane.addEventListener('scroll', () => pane.classList.toggle('scrolled', pane.scrollTop > 2), { passive: true });
  // The highlight slides to the chosen category, as in the left sidebar (its first placing, and a
  // change of layout, without animation).
  const pill = h('<span class="set-nav-pill"></span>');
  nav.append(pill);
  const placePill = (animate = true) => {
    const cur = nav.querySelector('.set-nav-item.active');
    if (!cur || !cur.offsetWidth) return;
    pill.classList.toggle('no-anim', !animate);
    pill.style.width = cur.offsetWidth + 'px'; pill.style.height = cur.offsetHeight + 'px';
    pill.style.transform = `translate(${cur.offsetLeft}px, ${cur.offsetTop}px)`;
    pill.classList.add('on');
    if (!animate) requestAnimationFrame(() => requestAnimationFrame(() => pill.classList.remove('no-anim')));
  };
  new ResizeObserver(() => placePill(false)).observe(nav);
  // Changing category, with an elastic stretch: the sections leave stretching the way they go, and
  // the new ones arrive stretched from the other side, then shrink back with a small bounce. Up when
  // the category is further down the list, down when it's further up (dir 1 / -1). The opacity only
  // covers the moment of the swap.
  let seq = 0;
  const show = async (id, dir = 0) => {
    const mine = ++seq;
    cat = id;
    store.set('settingsCat', id);
    nav.querySelectorAll('.set-nav-item').forEach((b) => b.classList.toggle('active', b.dataset.cat === id));
    placePill(pill.classList.contains('on'));
    if (document.body.classList.contains('perf') || matchMedia('(prefers-reduced-motion: reduce)').matches) dir = 0;
    const building = Promise.all(CATEGORIES.find((c) => c[0] === id)[3].map((k) => BUILD[k]()));
    if (dir && inner.childElementCount) {
      inner.style.transformOrigin = dir > 0 ? 'center bottom' : 'center top'; // (the trailing edge stays, the rest stretches away)
      await inner.animate([
        { opacity: 1, transform: 'none' },
        { opacity: 0.85, transform: `translateY(${-dir * 6}px) scaleY(1.02)`, offset: 0.5 },
        { opacity: 0, transform: `translateY(${-dir * 14}px) scaleY(1.04)` },
      ], { duration: 200, easing: 'cubic-bezier(.45,0,.55,1)', fill: 'forwards' }).finished.catch(() => {});
    }
    const cards = await building;
    if (mine !== seq) return; // (another category was picked meanwhile)
    inner.getAnimations().forEach((a) => a.cancel());
    inner.replaceChildren(...cards.flat()); // (Interfaz y Fondo y efectos come from one builder)
    pane.scrollTop = 0;
    pane.classList.remove('scrolled');
    // (No fill mode: an animation still holding its end state would turn off the glass effect.)
    if (dir) {
      inner.style.transformOrigin = dir > 0 ? 'center top' : 'center bottom'; // (the leading edge arrives first)
      inner.animate([
        { opacity: 0, transform: `translateY(${dir * 22}px) scaleY(1.06)` },
        { opacity: 1, transform: `translateY(${dir * 6}px) scaleY(1.025)`, offset: 0.24 },
        { opacity: 1, transform: `translateY(${-dir * 6}px) scaleY(0.982)`, offset: 0.43 }, // (past its place: the bounce)
        { opacity: 1, transform: `translateY(${dir * 3.5}px) scaleY(1.009)`, offset: 0.6 },
        { opacity: 1, transform: `translateY(${-dir * 1.6}px) scaleY(0.996)`, offset: 0.76 },
        { opacity: 1, transform: `translateY(${dir * 0.5}px) scaleY(1.001)`, offset: 0.9 },
        { opacity: 1, transform: 'none' },
      ], { duration: 860, easing: 'cubic-bezier(.3,.85,.45,1)' });
    }
  };
  for (const [id, label, ic, sections] of CATEGORIES) {
    const b = h(`<button class="set-nav-item" data-cat="${id}">${icon(ic)}<span>${esc(label)}</span></button>`);
    b.title = sections.map((k) => ({ account: tr('Cuenta de Google'), import: tr('Importar de Spotify'), theme: tr('Tema'), sidebar: tr('Interfaz'), effects: tr('Fondo y efectos'), performance: tr('Rendimiento'), playback: tr('Reproducción'), eq: tr('Ecualizador'), lyrics: tr('Letras'), sources: tr('Fuentes'), downloads: tr('Descargas'), local: tr('Música local'), integrations: tr('Integraciones'), general: tr('General'), backup: tr('Copia de la configuración'), about: tr('Acerca de') }[k])).join(' · ');
    b.onclick = async () => {
      if (id === cat) return;
      route.section = null; // (a later refresh stays here)
      const at = (c) => CATEGORIES.findIndex((x) => x[0] === c);
      await show(id, Math.sign(at(id) - at(cat)));
    };
    nav.append(b);
  }
  await show(cat);
  outer.addEventListener('click', (e) => { const a = e.target.closest('a[data-url]'); if (a) { e.preventDefault(); bc.openExternal(a.dataset.url); } });
  if (route.section) setTimeout(() => pane.querySelector('#set-' + route.section)?.scrollIntoView({ block: 'start' }), 30);
  return outer;
}
