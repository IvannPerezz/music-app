// Settings page.
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
    row(tr('Calidad de streaming'), tr('Bitrate máximo del formato de audio que se pide a YouTube Music en streaming: Baja hasta 64 kbps, Normal hasta 96, Alta hasta 160 y Máxima sin límite. Se elige el mejor formato por debajo del límite, con preferencia por Opus sobre AAC.'), select('streamQuality', QUALITY)),
    row(tr('Reproducción sin pausas (gapless)'), tr('El motor de audio tiene dos pletinas (Web Audio): mientras suena una, la siguiente canción se carga en la otra y arranca justo al terminar la primera, sin el hueco que deja abrir un archivo nuevo.'), toggle('gapless')),
    row(tr('Fundido entre canciones'), tr('Superpone el final de una canción y el principio de la siguiente durante los segundos elegidos (0–12): el volumen de una baja mientras sube el de la otra. Como mucho dura un tercio de la canción.'), cf),
    row(`Automix <span class="beta">Beta</span>`, tr('Transiciones tipo DJ. Un análisis en segundo plano (Web Worker) calcula el tempo (BPM), los compases y dónde empieza y acaba el sonido de cada canción. La siguiente entra en un tiempo fuerte, con su tempo igualado al de la que suena (hasta ±8 %, sin cambiar el tono) y con intercambio de graves, y luego vuelve poco a poco a su tempo. Si los tempos son muy distintos, hace una mezcla corta sin sincronizar. Sustituye al fundido.'), toggle('automix')),
    row(tr('Duración de la mezcla'), tr('Duración de cada mezcla del Automix en compases de 4 tiempos, al tempo de la canción que suena (entre 4 y 24 segundos). Si los tempos no encajan, se usan 4 compases como mucho.'), select('automixBars', [4, 8, 16].map((n) => [n, tr('{n} compases', { n })]))),
    row(tr('Saltar silencios'), tr('El análisis de audio detecta dónde empieza y termina el sonido de cada canción: se salta el silencio inicial (si dura más de 0,4 s) y se pasa a la siguiente al acabar el sonido, sin esperar al silencio final.'), toggle('skipSilence')),
    row(tr('Normalizar volumen'), tr('Aplica a cada canción una ganancia según su sonoridad medida por YouTube (loudness_db): baja las que suenan por encima de la referencia y sube un poco las más flojas (entre −12 y +6 dB), para que todas suenen a un volumen parecido.'), toggle('normalize')),
    row(tr('Velocidad de reproducción'), tr('De 0,5× a 2× con corrección de tono (preservesPitch): la canción va más rápida o más lenta sin sonar más aguda ni más grave.'), range('speed', 0.5, 2, 0.05, (v) => `${(+v).toFixed(2)}×`)),
    row(tr('Reproducción automática'), tr('Cuando se acaba la cola, BitChord pide a YouTube Music la lista «A continuación» (la radio) de la última canción y añade esas canciones, para que la música no se pare.'), toggle('autoplayRadio')),
    row(tr('Recordar la cola al abrir'), tr('Guarda en este equipo la cola, la canción que suena y el segundo por el que va; al abrir BitChord se recuperan en pausa, listas para seguir.'), toggle('resumeOnStart')),
  );
}

function sourcesCard() {
  const el = card('sources', tr('Fuentes de música online'), 'library',
    h(`<div class="set-note">${tr('YouTube Music es la fuente del catálogo, la radio y las recomendaciones, y la del audio por defecto. Las fuentes que actives aquí se consultan antes: si una tiene la misma canción con suficiente seguridad, el audio sale de ella; si no, de YouTube Music.')}</div>`),
    row(tr('YouTube Music'), tr('Catálogo completo. El audio se descarga de los servidores de YouTube (googlevideo) a través de varios clientes de su API interna, que se prueban en orden hasta que uno sirve la canción entera (el registro apunta cuál). Opus hasta ~160 kbps o AAC. Siempre activa.'), h(`<span class="badge">${tr('Principal')}</span>`)),
    row(tr('JioSaavn'), tr('Antes de pedir el audio a YouTube, busca la canción en JioSaavn por título y artista. Solo la usa si la duración coincide (±3 s) y el parecido es alto; entonces suena en AAC de hasta 320 kbps. Si no hay coincidencia o tarda más de 4 s, se usa YouTube Music. JioSaavn solo da servicio en algunos países.'), toggle('sourceJioSaavn')),
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
  el.append(row(tr('Servidores WebDAV'), tr('Lee tu música de un servidor WebDAV (NAS, Nextcloud…): recorre sus carpetas con PROPFIND, toma artista, álbum y título de la ruta "Artista/Álbum/01 - Título" y usa cover.jpg o folder.jpg como carátula. El audio pasa por el servidor local de BitChord por partes, sin descargarlo entero. Aparece en Biblioteca → En red.'), rescan), list, form);
  el.append(h(`<div class="set-note">${tr('Las fuentes "Hi‑Res" por módulos de la app móvil (plugins que extraen FLAC de servicios de pago como Tidal, Qobuz o Apple Music) no están incluidas.')}</div>`));
  return el;
}

function equalizer() {
  return card('eq', tr('Ecualizador'), 'equalizer',
    h(`<div class="set-note">${tr('10 bandas (31 Hz – 16 kHz): filtros de pico en las centrales y de estantería en los extremos, en el motor de audio, detrás del preamplificador. Se aplica a todo lo que suena, también a la música local, y el visualizador recibe el sonido ya ecualizado.')}</div>`),
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
    h(`<div class="set-note">${tr('Para cada canción se pregunta a los proveedores en este orden y se usa la primera letra sincronizada que aparezca. Los marcados «palabra a palabra» dan el tiempo de cada palabra o sílaba. Arrastra para cambiar la prioridad o desactiva los que no quieras. En la vista de portada y letra puedes forzar un proveedor para la canción que suena.')}</div>`),
    list,
    row(tr('Sincronización palabra a palabra'), tr('Si el proveedor da tiempos por palabra o sílaba (TTML o LRC mejorado), cada palabra se rellena a su ritmo; si no, se resalta la línea entera.'), toggle('lyricsWordSync')),
    row(tr('Tamaño del texto'), tr('Tamaño de la letra en la vista de portada y letra.'), range('lyricsFontSize', 20, 48, 1, (v) => `${v} px`)),
    row(tr('Desfase'), tr('Se suma a los tiempos de todas las letras (de −2 a +2 s): positivo si la letra va por detrás de la voz, negativo si va por delante.'), range('lyricsOffsetMs', -2000, 2000, 50, (v) => `${v > 0 ? '+' : ''}${(v / 1000).toFixed(2)} s`)),
  );
}

function downloads() {
  const dir = h(`<div class="path-ctl"><span class="path">${esc(state.settings.downloadDir || state.downloads.dir || tr('Música') + '\\BitChord')}</span></div>`);
  const change = btn(tr('Cambiar…'), 'ghost', 'folder');
  change.onclick = async () => { const p = await api('chooseFolder', tr('Carpeta de descargas')); if (p) { await saveSettings({ downloadDir: p }); refreshView(); } };
  dir.append(change);
  return card('downloads', tr('Descargas'), 'download',
    row(tr('Calidad de descarga'), tr('Bitrate máximo del audio que se descarga, independiente del de streaming. Se guarda el audio original de YouTube, sin recomprimir.'), select('downloadQuality', QUALITY)),
    row(tr('Formato'), tr('Opus: el audio original pasado de WebM a .opus (Ogg) sin recomprimir; más calidad por tamaño. AAC (.m4a): el audio AAC original en MP4, compatible con cualquier reproductor. Los dos llevan etiquetas con título, artista, álbum, carátula y letra.'), select('downloadFormat', [['opus', 'Opus (.opus)'], ['m4a', 'AAC (.m4a)']])),
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
    h(`<div class="set-note">${tr('BitChord indexa las carpetas que añadas: lee las etiquetas de cada archivo (título, artista, álbum, carátula, duración y datos técnicos) y guarda el índice para no volver a leerlos. Cada carpeta es una playlist con su propia portada en Biblioteca → En este equipo y en Playlists. Formatos: MP3, M4A, FLAC, OGG, Opus, WAV…')}</div>`),
    box, actions,
    row(tr('Actualizar automáticamente'), tr('Vigila las carpetas con los avisos de cambios del sistema de archivos de Windows: al añadir, quitar o cambiar un archivo, se vuelve a escanear solo esa carpeta a los pocos segundos. Sin cambios no gasta nada. En carpetas de red esos avisos pueden no llegar; ahí usa «Volver a escanear».'), toggle('localWatch')),
  );
}

function importCard() {
  const link = btn(tr('Vincular cuenta de Spotify…'), 'spotify', 'open');
  link.onclick = () => go({ name: 'spotify-import' });
  return card('import', tr('Importar de Spotify'), 'importIcon',
    row(tr('Cuenta de Spotify'), tr('Copia las playlists que elijas de Spotify (y tus «Canciones que te gustan») a tu cuenta de YouTube Music y las mantiene sincronizadas. Necesita la sesión de Google iniciada (Ajustes → Cuenta), porque las copias se crean ahí.'), link),
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
    el.append(row(tr('Biblioteca y recomendaciones'), tr('Las peticiones a YouTube Music van con las cookies de tu sesión: Inicio, recomendaciones, biblioteca, «Me gusta» y playlists son los de tu cuenta, y lo que crees o cambies en BitChord se guarda en ella. Cerrar sesión borra esas cookies de este equipo.'), out));
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
    el.append(row(tr('Inicia sesión'), tr('Abre la página oficial de Google en una ventana de BitChord. Al entrar, BitChord guarda solo las cookies de YouTube, cifradas con el almacén de claves de Windows (DPAPI), y las envía en sus peticiones a YouTube Music: así ves tus playlists, «Me gusta» y recomendaciones. Tu contraseña no pasa por BitChord.'), login));
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
    row(tr('Discord Rich Presence'), tr('Envía la canción que suena (título, artista, carátula y tiempo) a la app de Discord abierta en este PC por su conexión local (named pipe discord-ipc), y Discord la muestra en tu perfil como «Escuchando BitChord». No usa tu cuenta de Discord.'), toggle('discordRpc')),
    row(tr('ListenBrainz'), tr('Envía a <a href="#" data-url="https://listenbrainz.org/settings/">listenbrainz.org</a> la canción que suena y, al pasar el porcentaje de abajo, la registra como escuchada (scrobble), con su API y tu token de usuario (está en su página de ajustes).'), lb),
    row(tr('Last.fm'), tr('Lo mismo con Last.fm: crea una API key gratuita en <a href="#" data-url="https://www.last.fm/api/account/create">last.fm/api</a>, pégala con su «shared secret» y autoriza a BitChord en la web de Last.fm; la sesión que devuelve se guarda en este equipo.'), lfm),
    row(tr('Porcentaje para scrobblear'), tr('Una canción cuenta como escuchada al reproducir este porcentaje de su duración o 4 minutos, lo que llegue antes (la regla de Last.fm).'), range('scrobblePercent', 30, 90, 5, (v) => `${v} %`)),
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
    h(`<div class="set-note">${tr('Un tema es una hoja de estilos CSS que se carga encima de la de BitChord: cambia sus variables de color (<code>--bg</code>, <code>--accent</code>…) o añade reglas propias. Con <b>+</b> creas uno desde una plantilla y lo pruebas con «Vista previa» antes de guardarlo. Pasa el ratón por uno tuyo para editarlo o eliminarlo.')}</div>`),
    grid,
    row(tr('Color de acento'), tr('Color de botones, interruptores y resaltados (la variable --accent). «Según la portada» toma el color dominante de la carátula que suena y lo ajusta para que se lea bien; «El del tema», el de su CSS; «Personalizado», el que elijas.'), accentSel),
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
    box.append(sub(tr('Playlists ocultas'), 'queue'), h(`<div class="set-note">${tr('Playlists de tu cuenta de YouTube Music que BitChord no muestra (por ejemplo, las que YouTube no deja borrar). Solo se ocultan aquí: siguen en tu cuenta.')}</div>`));
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
      row(tr('Emojis de Apple'), tr('Dibuja los emojis de títulos, artistas y letras con la fuente «Apple Color Emoji» si está instalada en Windows. Se carga como fuente limitada a los caracteres de emoji (unicode-range), así que el resto del texto no cambia. Sin esa fuente se ven los de Windows.'), toggle('appleEmoji')),
      row(tr('Fuente de la aplicación'), tr('Tipografía de toda la interfaz. Inter va incluida. SF Pro Display es de Apple y no se puede distribuir, así que se usan tus archivos: la primera vez se copian de la carpeta «sf-pro-display» del Escritorio (o de la que elijas) al perfil de BitChord, y cada grosor (Light, Regular, Medium, Semibold, Bold…) se carga como una variante de la misma fuente.'), font),
      hiddenPlaylistsBlock(),
      sub(tr('Pantalla principal'), 'home'),
      h(`<div class="set-note">${tr('Inicio muestra los apartados que YouTube Music devuelve para tu cuenta. Marca los que quieres ver; se reconocen por su título, así que también puedes ocultar uno desde Inicio con «Ocultar» al pasar el ratón por él. Los apartados nuevos que añada YouTube aparecen aquí en cuanto salgan.')}</div>`),
      homeGrid,
      sub(tr('Barra lateral'), 'menu'),
      row(tr('Mostrar la barra lateral'), tr('Fija; oculta y desplegada al acercar el ratón al borde izquierdo de la ventana; u oculta, con un botón junto a las flechas de navegación para abrirla.'),
        select('sidebarMode', [['fixed', tr('Siempre visible')], ['hover', tr('Al pasar el ratón por la izquierda')], ['button', tr('Con un botón')]])),
      h(`<div class="set-note">${tr('Elige qué aparece en la barra lateral y en qué orden (arrastra o usa las flechas). Las pestañas de Biblioteca se pueden anclar como accesos directos. <b>Ajustes</b> está siempre arriba a la derecha (junto a tu perfil), así que nunca te quedas sin forma de volver aquí.')}</div>`),
      list,
      row(tr('Volver a la configuración original'), tr('Devuelve los elementos y el orden de la barra lateral a los de serie.'), reset),
      sub(tr('Datos de las pistas en «En este equipo»'), 'computer'),
      h(`<div class="set-note">${tr('Columnas con datos técnicos de cada archivo de música local, leídos de sus etiquetas y cabeceras al indexarlo.')}</div>`),
      info,
    ),
    card('effects', tr('Fondo y efectos'), 'image',
      sub(tr('Fondo animado'), 'image'),
      h(`<div class="set-note">${tr('Detrás de la app (y en la vista de portada y letra) se dibuja la carátula que suena, muy desenfocada, en capas que se mueven despacio con animaciones CSS (o manchas con sus colores principales). Solo se mueve mientras suena música y se para con la ventana minimizada. Los cambios se ven al momento.')}</div>`),
      row(tr('Fondo animado'), tr('Apagado, se usa el color de fondo del tema y la tarjeta gráfica no hace este trabajo.'), toggle('ambient', () => amb())),
      row(tr('Estilo'), tr('La carátula desenfocada girando despacio, o manchas difuminadas con sus colores más destacados.'), select('ambientMode', [['cover', tr('Portada desenfocada')], ['colors', tr('Manchas de color')]], () => amb())),
      row(tr('Intensidad del brillo'), tr('Opacidad del fondo animado sobre el color de fondo del tema.'), range('ambientIntensity', 5, 100, 1, (v) => `${v} %`, live('ambientIntensity', amb))),
      row(tr('Desenfoque'), tr('Radio del desenfoque (filtro blur) de la carátula o las manchas. Más alto = colores más suaves y mezclados, y algo más de trabajo para la gráfica.'), range('ambientBlur', 20, 220, 5, (v) => `${v} px`, live('ambientBlur', amb))),
      row(tr('Velocidad de movimiento'), tr('Velocidad de las animaciones del fondo. Solo se mueve mientras suena una canción; en pausa se queda quieto. 0 lo deja siempre quieto.'), range('ambientSpeed', 0, 100, 1, (v) => (v ? `${v} %` : tr('Quieto')), live('ambientSpeed', amb))),
      row(tr('Tamaño'), tr('Escala de la carátula o de las manchas de color respecto a la ventana.'), range('ambientSize', 50, 160, 5, (v) => `${v} %`, live('ambientSize', amb))),
      row(tr('Saturación'), tr('Filtro de saturación de los colores del fondo: 100 % es el color original, 0 % blanco y negro.'), range('ambientSaturation', 0, 250, 5, (v) => `${v} %`, live('ambientSaturation', amb))),
      sub(tr('Portadas animadas'), 'album'),
      row(tr('Portada animada'), tr('Si la canción tiene portada animada (un vídeo corto en bucle), se busca en Apple Music, Tidal o un índice de la comunidad y se reproduce sin sonido sobre la carátula grande de la vista de portada y letra y de la pantalla completa. Se pausa con la ventana minimizada.'), toggle('animatedCovers')),
      sub(tr('Efecto Mica'), 'sparkle'),
      h(`<div class="set-note">${tr('Los paneles se dibujan como cristal: lo que hay detrás se desenfoca y satura (backdrop-filter) y se tiñe con el color del tema. Se activa por separado en cada panel; apagado, el panel usa el color sólido del tema. La intensidad, el desenfoque y la saturación son comunes a todos.')}</div>`),
      row(tr('Barra lateral izquierda'), '', toggle('micaSidebar', () => mica())),
      row(tr('Cola (barra lateral derecha)'), '', toggle('micaQueue', () => mica())),
      row(tr('Controles de reproducción (abajo)'), '', toggle('micaPlayer', () => mica())),
      row(tr('Botones de pantalla completa'), tr('En la vista de portada y letra y en pantalla completa: la flecha de minimizar, la columna de botones de la derecha (letra, cola, ecualizador, ajustes, salir) y favorito, aleatorio y repetir cuando están activados.'), toggle('micaLyrics', () => mica())),
      row(tr('Intensidad del tinte'), tr('Opacidad del color del tema sobre el cristal: más alto = más color y menos transparencia.'), range('micaTint', 0, 100, 1, (v) => `${v} %`, live('micaTint', mica))),
      row(tr('Desenfoque del cristal'), tr('Radio del desenfoque de lo que hay detrás del cristal. 0 = cristal transparente.'), range('micaBlur', 0, 120, 2, (v) => `${v} px`, live('micaBlur', mica))),
      row(tr('Saturación'), tr('Saturación de lo que se ve a través del cristal (100 % = sin cambios).'), range('micaSaturation', 100, 300, 5, (v) => `${v} %`, live('micaSaturation', mica))),
    ),
  ];
}

function performanceCard() {
  return card('performance', tr('Rendimiento'), 'speed',
    h(`<div class="set-note">${tr('El modo rendimiento quita lo que más gasta de la tarjeta gráfica y del procesador: para equipos modestos, portátiles con batería o para jugar mientras escuchas música. También se activa con el botón del velocímetro, arriba a la derecha junto a tu foto.')}</div>`),
    row(tr('Modo rendimiento'), tr('Mientras está activo: los paneles pasan a color sólido (sin backdrop-filter), se quitan el fondo animado y el fondo difuminado de la vista de portada y letra, se apagan el visualizador, el círculo y las portadas animadas, y las animaciones de la interfaz son instantáneas. Tus ajustes no cambian: al desactivarlo vuelve todo como estaba.'), toggle('performanceMode')),
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
    row(tr('Idioma de la interfaz'), tr('Idioma de los menús, botones y textos de BitChord (aparte del de YouTube Music). Los textos se cargan al abrir la ventana, así que al cambiarlo se recarga (la música se pausa un momento).'), langSel),
    row(tr('Botones de la ventana'), tr('Los botones de minimizar, maximizar y cerrar: los círculos de colores de macOS (los dibuja BitChord) o los nativos de Windows. La ventana se crea con unos u otros, así que BitChord se reinicia al cambiarlo.'), select('windowButtons', [['mac', tr('Estilo macOS')], ['windows', tr('Estilo Windows')]])),
    row(tr('Cerrar a la bandeja del sistema'), tr('Al cerrar la ventana, BitChord se oculta en la bandeja del sistema (junto al reloj) y la música sigue. Para salir del todo: clic derecho en su icono → Salir.'), toggle('closeToTray')),
    row(tr('Idioma de YouTube Music'), tr('Idioma (parámetro hl) con el que se piden los datos a YouTube Music: títulos de los apartados, géneros y recomendaciones.'), select('language', [['es', 'Español'], ['en', 'English'], ['pt', 'Português'], ['fr', 'Français'], ['de', 'Deutsch'], ['it', 'Italiano']])),
    row(tr('País'), tr('País (parámetro gl) que se envía a YouTube Music: cambia las listas de éxitos, las recomendaciones y qué canciones están disponibles.'), select('region', [['ES', tr('España')], ['MX', tr('México')], ['AR', 'Argentina'], ['CO', 'Colombia'], ['CL', 'Chile'], ['PE', tr('Perú')], ['US', tr('Estados Unidos')], ['GB', tr('Reino Unido')]])),
    row(tr('Historial de reproducción'), tr('Canciones escuchadas, guardadas solo en este equipo (las usa «Escuchado recientemente»). No borra el historial de tu cuenta de YouTube.'), (() => { const b = btn(tr('Borrar historial'), 'ghost', 'trash'); b.onclick = () => { localStorage.setItem('bc.history', '[]'); toast(tr('Historial borrado')); }; return b; })()),
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
    h(`<div class="set-note">${icon('info')} <span>${tr('Guarda en un archivo <b>.bitchord</b> todo lo que has personalizado: ajustes, tema y temas propios, efecto Mica y fondo, barra lateral, ecualizador, letras, visualizador, portadas de playlists y carpetas, playlists ocultas y su orden, favoritos, búsquedas recientes y las playlists vinculadas con Spotify. Llévalo a otro PC (USB, nube, correo…) e impórtalo allí.')}</span></div>`),
    row(tr('Exportar o importar'), tr('Exporta un archivo .bitchord (un .zip) con los ajustes, los datos guardados de la interfaz, las portadas personalizadas y las playlists vinculadas con Spotify. Al importarlo se sustituye la configuración de este equipo y BitChord se reinicia.'), box),
    h(`<div class="set-note">${tr('No se incluyen las sesiones (Google, Spotify, Last.fm ni ListenBrainz): van cifradas solo para este equipo, así que en el otro hay que volver a iniciarlas. Tampoco las canciones descargadas ni la música local, que son archivos.')}</div>`),
  );
}

async function about() {
  const i = await bc.appInfo();
  const log = btn(tr('Abrir registro'), 'ghost', 'folder');
  log.onclick = () => bc.openLog();
  return card('about', tr('Acerca de'), 'info',
    h(`<div class="set-note">BitChord Desktop ${esc(i.version)} — ${tr('port para Windows de')} <a href="#" data-url="https://github.com/kushagrasinghx/BitChord">BitChord</a> (GPL-3.0). Electron ${esc(i.electron)} · Chromium ${esc(i.chrome)}.<br>${tr('No está afiliado a YouTube ni a Google.')}</div>`),
    row(tr('Registro de diagnóstico'), tr('Archivo de texto (bitchord.log, en la carpeta del perfil) donde BitChord apunta lo que hace: por qué cliente sale cada canción, errores, sincronizaciones… Si algo falla, es lo primero que hay que mirar.'), log),
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
