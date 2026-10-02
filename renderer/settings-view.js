// Settings page.
import { bc, $, $$, icon, esc, api, toast, h, state, saveSettings, art, store, confirmDialog } from './core.js';
import { eqPanel } from './eq-panel.js';
import { refreshAccount, refreshView, go, SIDEBAR_ITEMS, applyCustomAccent, applyTheme, setThemeCss } from './app.js';
import { colorPicker } from './color-picker.js';
import { tr, LANGUAGES, uiLang, syncUiLang } from './i18n.js';

const QUALITY = [['low', tr('Baja (~64 kbps)')], ['normal', tr('Normal (~96 kbps)')], ['high', tr('Alta (~160 kbps)')], ['max', tr('Máxima disponible')]];
const SECTIONS = [
  ['account', tr('Cuenta')], ['playback', tr('Reproducción')], ['sources', tr('Fuentes')], ['eq', tr('Ecualizador')], ['lyrics', tr('Letras')], ['downloads', tr('Descargas')],
  ['local', tr('Música local')], ['import', tr('Importar')], ['integrations', tr('Integraciones')], ['theme', tr('Tema')], ['sidebar', tr('Personalización')], ['general', tr('General')], ['about', tr('Acerca de')],
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

function card(id, title, ic, ...rows) {
  const el = h(`<section class="set-card" id="set-${id}"><h2>${icon(ic)}${esc(title)}</h2></section>`);
  rows.filter(Boolean).forEach((r) => el.append(r));
  return el;
}

// ------------------------------------------------------------------ sections
function playback() {
  const cf = range('crossfade', 0, 12, 1, (v) => (v ? `${v} s` : tr('No')));
  return card('playback', tr('Reproducción'), 'play',
    row(tr('Calidad de streaming'), tr('Límite de bitrate al escuchar por internet.'), select('streamQuality', QUALITY)),
    row(tr('Reproducción sin pausas (gapless)'), tr('Precarga la siguiente canción y la encadena sin silencio.'), toggle('gapless')),
    row(tr('Fundido entre canciones'), tr('Crossfade de 0 a 12 segundos.'), cf),
    row(`Automix <span class="beta">Beta</span>`, tr('Transiciones tipo DJ: detecta el tempo y los compases de cada canción, ajusta el tempo de la siguiente para que los beats coincidan (sin cambiar el tono) y mezcla con intercambio de graves. Sustituye al fundido cuando está activo.'), toggle('automix')),
    row(tr('Duración de la mezcla'), tr('Compases que dura cada transición del Automix.'), select('automixBars', [4, 8, 16].map((n) => [n, tr('{n} compases', { n })]))),
    row(tr('Saltar silencios'), tr('Recorta los silencios del principio y del final de cada canción.'), toggle('skipSilence')),
    row(tr('Normalizar volumen'), tr('Iguala el volumen entre canciones usando el dato de sonoridad de YouTube.'), toggle('normalize')),
    row(tr('Velocidad de reproducción'), tr('Sin cambiar el tono.'), range('speed', 0.5, 2, 0.05, (v) => `${(+v).toFixed(2)}×`)),
    row(tr('Reproducción automática'), tr('Cuando se acaba la cola, sigue con canciones parecidas (radio).'), toggle('autoplayRadio')),
    row(tr('Recordar la cola al abrir'), tr('Vuelve a cargar lo que estabas escuchando.'), toggle('resumeOnStart')),
  );
}

function sourcesCard() {
  const el = card('sources', tr('Fuentes de música online'), 'library',
    h(`<div class="set-note">${tr('Como en la app de Android, BitChord puede sacar el audio de varios sitios. YouTube Music es siempre la fuente principal (catálogo completo, radio, recomendaciones); el resto se usan cuando están activadas.')}</div>`),
    row(tr('YouTube Music'), tr('Catálogo completo · Opus hasta ~160 kbps. Siempre activa.'), h(`<span class="badge">${tr('Principal')}</span>`)),
    row(tr('JioSaavn'), tr('Si una canción tiene una coincidencia segura en JioSaavn (mismo título, artista y duración), suena desde allí en AAC de hasta 320 kbps. JioSaavn solo da servicio en algunos países: si no encuentra nada, se usa YouTube Music.'), toggle('sourceJioSaavn')),
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
  el.append(row(tr('Servidores WebDAV'), tr('Tu música en un NAS o en la nube. Se entiende la estructura "Artista/Álbum/01 - Título" y las carátulas cover.jpg / folder.jpg. Aparece en Biblioteca → En red.'), rescan), list, form);
  el.append(h(`<div class="set-note">${tr('Las fuentes "Hi‑Res" por módulos de la app móvil (plugins que extraen FLAC de servicios de pago como Tidal, Qobuz o Apple Music) no están incluidas.')}</div>`));
  return el;
}

function equalizer() {
  return card('eq', tr('Ecualizador'), 'equalizer',
    h(`<div class="set-note">${tr('10 Bandas, aplicado a todo lo que suena.')}</div>`),
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
        <div class="prov${disabled.has(id) ? ' off' : ''}" draggable="true">
          <span class="prov-n">${i + 1}</span>
          <div class="prov-t"><b>${esc(p.label)}</b>${p.word ? `<span class="badge">${tr('palabra a palabra')}</span>` : ''}<div class="set-desc">${esc(tr(p.detail))}</div></div>
          <button class="icon-btn" data-a="up" title="${tr('Subir')}">${icon('up')}</button>
          <button class="icon-btn" data-a="down" title="${tr('Bajar')}">${icon('down')}</button>
          <label class="switch"><input type="checkbox"${disabled.has(id) ? '' : ' checked'}><span></span></label>
        </div>`);
      const move = async (to) => {
        if (to < 0 || to >= order.length) return;
        const o = [...order]; const [x] = o.splice(i, 1); o.splice(to, 0, x);
        await saveSettings({ lyricsOrder: o }); draw();
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
        await saveSettings({ lyricsOrder: o }); draw();
      });
      list.append(el);
    });
  };
  draw();
  return card('lyrics', tr('Letras'), 'lyrics',
    h(`<div class="set-note">${tr('BitChord busca la letra en este orden y usa la primera sincronizada que encuentre. Arrastra para reordenar o desactiva las fuentes que no quieras. En la pantalla de reproducción puedes forzar una fuente concreta para la canción que suena.')}</div>`),
    list,
    row(tr('Sincronización palabra a palabra'), tr('Ilumina cada palabra cuando la fuente lo permite.'), toggle('lyricsWordSync')),
    row(tr('Tamaño del texto'), '', range('lyricsFontSize', 20, 48, 1, (v) => `${v} px`)),
    row(tr('Desfase'), tr('Adelanta o retrasa la letra si va descompasada.'), range('lyricsOffsetMs', -2000, 2000, 50, (v) => `${v > 0 ? '+' : ''}${(v / 1000).toFixed(2)} s`)),
  );
}

function downloads() {
  const dir = h(`<div class="path-ctl"><span class="path">${esc(state.settings.downloadDir || state.downloads.dir || tr('Música') + '\\BitChord')}</span></div>`);
  const change = btn(tr('Cambiar…'), 'ghost', 'folder');
  change.onclick = async () => { const p = await api('chooseFolder', tr('Carpeta de descargas')); if (p) { await saveSettings({ downloadDir: p }); refreshView(); } };
  dir.append(change);
  return card('downloads', tr('Descargas'), 'download',
    row(tr('Calidad de descarga'), tr('Independiente de la de streaming.'), select('downloadQuality', QUALITY)),
    row(tr('Formato'), tr('Opus da más calidad por tamaño; M4A (AAC) es compatible con todo. Ambos llevan título, artista, álbum, carátula y letra.'), select('downloadFormat', [['opus', 'Opus (.opus)'], ['m4a', 'AAC (.m4a)']])),
    row(tr('Carpeta'), '', dir),
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
    h(`<div class="set-note">${tr('Cada carpeta que añadas funciona como una playlist local independiente (con su propia portada) en Biblioteca → En este equipo y en Playlists. Formatos: MP3, M4A, FLAC, OGG, Opus, WAV…')}</div>`),
    box, actions,
    row(tr('Actualizar automáticamente'), tr('Cuando añadas, quites o cambies canciones en estas carpetas, sus playlists se actualizan solas a los pocos segundos. Usa los avisos de cambios de Windows, así que no consume recursos mientras no pasa nada. En carpetas de red puede no funcionar; ahí usa "Volver a escanear".'), toggle('localWatch')),
  );
}

function importCard() {
  const b = btn(tr('Importar playlists de Spotify…'), 'primary', 'importIcon');
  b.onclick = () => go({ name: 'spotify-import' });
  return card('import', tr('Importar de Spotify'), 'importIcon',
    h(`<div class="set-note">${tr('Sube el .zip con los «Datos de la cuenta» que te da Spotify y BitChord recrea tus playlists (y tus «Canciones que te gustan» como la playlist <b>Me gusta de Spotify</b>). En cada playlist eliges si se crea en <b>tu cuenta de YouTube Music</b> —y aparece también en la app oficial— o <b>solo en BitChord</b>. Antes de crear nada podrás revisar las coincidencias dudosas.')}</div>`),
    row(tr('Importar'), tr('Necesitas haber iniciado sesión con Google para crearlas en tu cuenta.'), b),
  );
}

function account() {
  const a = state.account;
  const el = card('account', tr('Cuenta de Google'), 'account');
  if (a) {
    el.append(h(`<div class="acct">${a.photo ? `<img src="${esc(a.photo)}" alt="">` : icon('account')}<div><b>${esc(a.name || tr('Sesión iniciada'))}</b><div class="set-desc">${esc(a.handle || 'YouTube Music')}</div></div></div>`));
    const out = btn(tr('Cerrar sesión'), 'ghost', 'logout');
    out.onclick = async () => { await api('logout'); await refreshAccount(); toast(tr('Sesión cerrada')); refreshView(); };
    el.append(row(tr('Biblioteca y recomendaciones'), tr('Tus playlists, "Me gusta" y la página de inicio personalizada vienen de tu cuenta.'), out));
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
    el.append(row(tr('Inicia sesión'), tr('Para ver tus playlists, sincronizar "Me gusta" y tener recomendaciones personalizadas. Se abre la página oficial de Google; BitChord solo guarda las cookies de YouTube, cifradas en tu equipo.'), login));
    const manual = h(`<details class="adv"><summary>${tr('¿Google no te deja entrar? Pega la cookie a mano')}</summary>
      <div class="set-desc">${tr('En el navegador, abre music.youtube.com con tu sesión, pulsa F12 → Red, recarga, elige cualquier petición a music.youtube.com y copia el valor de la cabecera <b>cookie</b>.')}</div>
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
    row(tr('Discord Rich Presence'), tr('Muestra en tu perfil de Discord lo que escuchas (necesita la app de Discord abierta en este PC).'), toggle('discordRpc')),
    row(tr('ListenBrainz'), tr('Scrobbling a <a href="#" data-url="https://listenbrainz.org/settings/">listenbrainz.org</a>. Copia tu token de la página de ajustes.'), lb),
    row(tr('Last.fm'), tr('Crea una API key gratuita en <a href="#" data-url="https://www.last.fm/api/account/create">last.fm/api</a>, pégala aquí y autoriza.'), lfm),
    row(tr('Porcentaje para scrobblear'), tr('Cuánto de la canción hay que escuchar (máximo 4 minutos).'), range('scrobblePercent', 30, 90, 5, (v) => `${v} %`)),
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
  --accent: #fa2d48;         /* con «Color de acento: El del tema» */
  --accent-soft: rgba(250, 45, 72, .18);
  --chrome: rgba(20, 20, 22, .78);
  --chrome-solid: rgba(18, 18, 20, .97); /* paneles sin efecto Mica */
  --popup: rgba(40, 40, 44, .97);
  --mica-rgb: 36, 36, 42;    /* tinte del efecto Mica (R, G, B) */
}
`;

/** Colours for a theme's preview tile, read from its CSS (falls back to BitChord's). */
function themeColors(css = '') {
  const v = (name, def) => (new RegExp(`--${name}\\s*:\\s*([^;}]+)`).exec(css)?.[1].trim()) || def;
  return { bg: v('bg', '#0d0d0f'), surf: v('surface', '#1c1c1e'), acc: v('accent', '#fa2d48') };
}

/** Modal with a CSS editor. Resolves with { name, css } or null if cancelled. */
function themeEditor(theme) {
  return new Promise((resolve) => {
    const m = h(`<div class="modal-back"><div class="modal theme-editor">
      <h3>${tr(theme ? 'Editar tema' : 'Nuevo tema')}</h3>
      <p class="muted">${tr('Escribe el CSS de tu tema. Lo más fácil es cambiar los colores de la plantilla; para que se use tu <code>--accent</code>, elige «El del tema» en <b>Color de acento</b>.')}</p>
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
  const pickerRow = h(`<div class="cp-row"${mode === 'custom' ? '' : ' hidden'}><div class="set-text"><div class="set-label">${tr('Tu color')}</div><div class="set-desc">${tr('Arrastra en el cuadro para elegir saturación y brillo, en la barra de colores para el tono y en la de abajo para la transparencia. También puedes escribir el código (#RRGGBB o #RRGGBBAA).')}</div></div></div>`);
  pickerRow.append(colorPicker(state.settings.customAccent || '#fa2d48', {
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
    h(`<div class="set-note">${tr('<b>BitChord</b> es el tema original. Con <b>+</b> puedes crear el tuyo escribiendo CSS: parte de una plantilla con los colores de la app y ves los cambios con «Vista previa» antes de guardarlo. Pasa el ratón por un tema tuyo para editarlo o eliminarlo.')}</div>`),
    grid,
    row(tr('Color de acento'), tr('El color de botones, interruptores y resaltados.'), accentSel),
    pickerRow,
  );
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
        <div class="prov${on ? '' : ' off'}" draggable="true">
          <span class="prov-n">${icon(it.icon)}</span>
          <div class="prov-t"><b>${esc(it.label)}</b><div class="set-desc">${group}</div></div>
          <button class="icon-btn" data-a="up" title="${tr('Subir')}">${icon('up')}</button>
          <button class="icon-btn" data-a="down" title="${tr('Bajar')}">${icon('down')}</button>
          <label class="switch"><input type="checkbox"${on ? ' checked' : ''}><span></span></label>
        </div>`);
      const save = async (next) => { await saveSettings({ sidebar: next }); draw(); };
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
  return card('sidebar', tr('Personalización'), 'tune',
    h(`<h3 class="set-sub">${tr('Fondo animado')}</h3>`),
    h(`<div class="set-note">${tr('Detrás de toda la app (y en la vista de portada y letra) se mueve lentamente, mientras suena la música, la portada que está sonando, muy desenfocada (o, si lo prefieres, manchas con sus colores más destacados). Los cambios se ven al momento mientras mueves los controles.')}</div>`),
    row(tr('Fondo animado'), tr('Desactívalo para usar el fondo normal del tema.'), toggle('ambient', () => amb())),
    row(tr('Estilo'), tr('La propia portada desenfocada girando despacio, o manchas con sus colores principales.'), select('ambientMode', [['cover', tr('Portada desenfocada')], ['colors', tr('Manchas de color')]], () => amb())),
    row(tr('Intensidad del brillo'), tr('Lo visibles que son los colores.'), range('ambientIntensity', 5, 100, 1, (v) => `${v} %`, live('ambientIntensity', amb))),
    row(tr('Desenfoque'), tr('Más alto = colores más suaves y difuminados.'), range('ambientBlur', 20, 220, 5, (v) => `${v} px`, live('ambientBlur', amb))),
    row(tr('Velocidad de movimiento'), tr('Solo se mueve mientras suena una canción; en pausa se queda quieto. 0 lo deja siempre quieto.'), range('ambientSpeed', 0, 100, 1, (v) => (v ? `${v} %` : tr('Quieto')), live('ambientSpeed', amb))),
    row(tr('Tamaño'), tr('De la portada o de las manchas de color.'), range('ambientSize', 50, 160, 5, (v) => `${v} %`, live('ambientSize', amb))),
    row(tr('Saturación'), tr('Lo vivos que son los colores. 0 lo deja en blanco y negro.'), range('ambientSaturation', 0, 250, 5, (v) => `${v} %`, live('ambientSaturation', amb))),
    h(`<h3 class="set-sub">${tr('Efecto Mica')}</h3>`),
    h(`<div class="set-note">${tr('Cristal desenfocado y teñido con el tema, como en Windows 11: lo que pasa por detrás (el fondo animado, la música al hacer scroll) se ve a través. Actívalo o desactívalo en cada panel; si lo quitas, el panel usa el color sólido del tema. La intensidad, el desenfoque y la saturación se aplican a todos los paneles y menús con Mica.')}</div>`),
    row(tr('Barra lateral izquierda'), '', toggle('micaSidebar', () => mica())),
    row(tr('Cola (barra lateral derecha)'), '', toggle('micaQueue', () => mica())),
    row(tr('Controles de reproducción (abajo)'), '', toggle('micaPlayer', () => mica())),
    row(tr('Botones de pantalla completa'), tr('En la vista de portada y letra y en pantalla completa: la flecha de minimizar, la columna de botones de la derecha (letra, cola, ecualizador, ajustes, salir) y favorito, aleatorio y repetir cuando están activados.'), toggle('micaLyrics', () => mica())),
    row(tr('Intensidad del tinte'), tr('Más alto = más color del tema y menos transparencia.'), range('micaTint', 0, 100, 1, (v) => `${v} %`, live('micaTint', mica))),
    row(tr('Desenfoque del cristal'), tr('Cuánto se difumina lo que hay detrás. 0 = cristal transparente.'), range('micaBlur', 0, 120, 2, (v) => `${v} px`, live('micaBlur', mica))),
    row(tr('Saturación'), tr('Lo vivos que se ven los colores a través del cristal.'), range('micaSaturation', 100, 300, 5, (v) => `${v} %`, live('micaSaturation', mica))),
    h(`<h3 class="set-sub">${tr('Pantalla principal')}</h3>`),
    h(`<div class="set-note">${tr('Marca los apartados que quieres ver en Inicio. También puedes ocultar uno directamente desde Inicio con el botón «Ocultar» que aparece al pasar el ratón por su título. Si YouTube Music añade apartados nuevos, aparecerán aquí en cuanto salgan en tu Inicio.')}</div>`),
    homeGrid,
    h(`<h3 class="set-sub">${tr('Barra lateral')}</h3>`),
    row(tr('Mostrar la barra lateral'), tr('Fija, al pasar el ratón por el borde izquierdo de la ventana, o con un botón junto a las flechas de navegación.'),
      select('sidebarMode', [['fixed', tr('Siempre visible')], ['hover', tr('Al pasar el ratón por la izquierda')], ['button', tr('Con un botón')]])),
    h(`<div class="set-note">${tr('Elige qué aparece en la barra lateral y en qué orden (arrastra o usa las flechas). Las pestañas de Biblioteca se pueden anclar como accesos directos. <b>Ajustes</b> está siempre arriba a la derecha (junto a tu perfil), así que nunca te quedas sin forma de volver aquí.')}</div>`),
    list,
    row(tr('Volver a la configuración original'), tr('Elementos y orden de la barra lateral.'), reset),
    h(`<h3 class="set-sub">${tr('Datos de las pistas en «En este equipo»')}</h3>`),
    h(`<div class="set-note">${tr('Qué información técnica se muestra de cada archivo de tu música local.')}</div>`),
    info,
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
    row(tr('Idioma de la interfaz'), tr('Idioma de los menús, botones y textos de BitChord. Al cambiarlo, la ventana se recarga (la música se pausa un momento).'), langSel),
    row(tr('Botones de la ventana'), tr('Cerrar, minimizar y maximizar: los círculos de colores de macOS (a la izquierda) o los de Windows (a la derecha).'), select('windowButtons', [['mac', tr('Estilo macOS')], ['windows', tr('Estilo Windows')]])),
    row(tr('Cerrar a la bandeja del sistema'), tr('Al cerrar la ventana, BitChord sigue sonando junto al reloj.'), toggle('closeToTray')),
    row(tr('Idioma de YouTube Music'), tr('Idioma de títulos y recomendaciones.'), select('language', [['es', 'Español'], ['en', 'English'], ['pt', 'Português'], ['fr', 'Français'], ['de', 'Deutsch'], ['it', 'Italiano']])),
    row(tr('País'), tr('Afecta a las listas y a la disponibilidad.'), select('region', [['ES', tr('España')], ['MX', tr('México')], ['AR', 'Argentina'], ['CO', 'Colombia'], ['CL', 'Chile'], ['PE', tr('Perú')], ['US', tr('Estados Unidos')], ['GB', tr('Reino Unido')]])),
    row(tr('Historial de reproducción'), tr('Lo que has escuchado en este equipo.'), (() => { const b = btn(tr('Borrar historial'), 'ghost', 'trash'); b.onclick = () => { localStorage.setItem('bc.history', '[]'); toast(tr('Historial borrado')); }; return b; })()),
  );
}

async function about() {
  const i = await bc.appInfo();
  const log = btn(tr('Abrir registro'), 'ghost', 'folder');
  log.onclick = () => bc.openLog();
  return card('about', tr('Acerca de'), 'info',
    h(`<div class="set-note">BitChord Desktop ${esc(i.version)} — ${tr('port para Windows de')} <a href="#" data-url="https://github.com/kushagrasinghx/BitChord">BitChord</a> (GPL-3.0). Electron ${esc(i.electron)} · Chromium ${esc(i.chrome)}.<br>${tr('No está afiliado a YouTube ni a Google.')}</div>`),
    row(tr('Registro de diagnóstico'), tr('Si algo falla, envía este archivo.'), log),
    h(`<div class="set-note keys"><b>${tr('Atajos')}</b><br>${tr('Espacio play/pausa · Ctrl+←/→ anterior/siguiente · ←/→ ±5 s · ↑/↓ volumen · E ecualizador · L letra · Q cola · V visualizador · S aleatorio · R repetir · M silenciar · F favorito · F11 pantalla completa · Ctrl+F buscar · Ctrl+, ajustes')}</div>`),
  );
}

let providers = [];
export async function settingsView(route) {
  providers = await api('lyricsProviders');
  state.settings = await api('settingsGet');
  try { state.downloads = await api('downloads'); } catch {}
  const outer = h('<div></div>');
  const root = h('<div class="settings"></div>');
  const bar = h('<div class="set-bar"></div>');
  const chips = h('<div class="chips"></div>');
  bar.append(chips);
  const head = h(`<div class="set-head"><div class="settings"><h1 class="page-title">${tr('Ajustes')}</h1></div></div>`);
  head.append(bar);
  outer.append(head, root);
  SECTIONS.forEach(([id, label]) => {
    const c = h(`<button class="chip">${label}</button>`);
    c.onclick = () => root.querySelector('#set-' + id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    chips.append(c);
  });
  // Highlight the chip of the section being read.
  const spy = () => {
    if (!root.isConnected) return $('#content').removeEventListener('scroll', spy);
    const top = $('#content').getBoundingClientRect().top + 150;
    let cur = SECTIONS[0][0];
    for (const [id] of SECTIONS) { const el = root.querySelector('#set-' + id); if (el && el.getBoundingClientRect().top <= top) cur = id; }
    chips.querySelectorAll('.chip').forEach((c, i) => {
      const on = SECTIONS[i][0] === cur;
      if (on && !c.classList.contains('active') && (c.offsetLeft < chips.scrollLeft || c.offsetLeft + c.offsetWidth > chips.scrollLeft + chips.clientWidth)) chips.scrollTo({ left: c.offsetLeft - 40, behavior: 'smooth' });
      c.classList.toggle('active', on);
    });
  };
  setTimeout(() => { $('#content').addEventListener('scroll', spy, { passive: true }); spy(); }, 50);
  chips.addEventListener('wheel', (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && chips.scrollWidth > chips.clientWidth) { chips.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
  root.append(account(), playback(), sourcesCard(), equalizer(), lyrics(), downloads(), localMusic(), importCard(), integrations(), themeCard(), sidebarCard(), general(), await about());
  root.addEventListener('click', (e) => { const a = e.target.closest('a[data-url]'); if (a) { e.preventDefault(); bc.openExternal(a.dataset.url); } });
  if (route.section) setTimeout(() => root.querySelector('#set-' + route.section)?.scrollIntoView({ block: 'start' }), 30);
  return outer;
}
