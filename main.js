// BitChord Desktop — Electron main process.
import { app, BrowserWindow, ipcMain, shell, nativeTheme, Menu, Tray, nativeImage, dialog, powerSaveBlocker } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import util from 'node:util';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK = process.env.BITCHORD_MOCK === '1';
// The version of *this* code (with in-place updates it can differ from the installer's app.asar).
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version; } catch { return app.getVersion(); } })();

app.setAppUserModelId('com.music.bitchord.desktop');
app.setName('BitChord');
// Videos (only the animated covers) are decoded in software, never by the graphics card's video
// decoder: on Iván's PC (NVIDIA) the hardware path failed mid-clip and the machine then froze.
// A small square clip costs the processor next to nothing.
app.commandLine.appendSwitch('disable-accelerated-video-decode');
if (process.env.BITCHORD_USERDATA) app.setPath('userData', process.env.BITCHORD_USERDATA);
const userData = app.getPath('userData');

// ---------------------------------------------------------------- logging
const logFile = path.join(userData, 'bitchord.log');
try {
  fs.mkdirSync(userData, { recursive: true });
  if (fs.existsSync(logFile) && fs.statSync(logFile).size > 2_000_000) fs.renameSync(logFile, logFile + '.old');
} catch {}
for (const level of ['log', 'info', 'warn', 'error']) {
  const orig = console[level].bind(console);
  // The file first: opened from its shortcut BitChord has no console, and writing to it can fail.
  console[level] = (...args) => {
    try { fs.appendFileSync(logFile, `${new Date().toISOString()} [${level}] ${util.format(...args)}\n`); } catch {}
    try { orig(...args); } catch {}
  };
}
process.on('uncaughtException', (e) => console.error('[uncaught]', e));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e));
if (globalThis.__bitchordLoader?.note) console.log('[update]', globalThis.__bitchordLoader.note);
console.log(`BitChord ${VERSION} · Electron ${process.versions.electron} · ${process.platform} ${process.arch}${MOCK ? ' · MOCK' : ''}`);

const settings = await import('./src/settings.js');
settings.load(userData);
const { tr } = await import('./src/i18n.js');
const yt = MOCK ? await import('./src/mock.js') : await import('./src/yt.js');
const lyrics = MOCK ? await import('./src/mock.js') : await import('./src/lyrics.js');
const { startProxy } = MOCK ? await import('./src/mock.js') : await import('./src/proxy.js');
const downloads = await import('./src/downloads.js');
const local = await import('./src/local.js');
const auth = await import('./src/auth.js');
const discord = await import('./src/discord.js');
const scrobble = await import('./src/scrobble.js');
const potoken = MOCK ? null : await import('./src/potoken.js');
const webdav = await import('./src/sources/webdav.js');
const canvas = await import('./src/canvas.js');
const playlists = await import('./src/playlists.js');
const spotify = await import('./src/spotify-import.js');
const spotifySync = await import('./src/spotify-sync.js');
const backup = await import('./src/backup.js');
const sources = await import('./src/sources/index.js');

nativeTheme.themeSource = 'dark';

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}


let win = null;
let tray = null;
let proxyPort = 0;
let quitting = false;
let playing = false;
let blocker = null;
const send = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data); };

const img = (n) => nativeImage.createFromPath(path.join(__dirname, 'build', n));

function updateThumbar() {
  if (process.platform !== 'win32' || !win) return;
  if (!win || win.isDestroyed()) return;
  win.setThumbarButtons([
    { tooltip: tr('Anterior'), icon: img('tb-prev.png'), click: () => send('command', 'prev') },
    { tooltip: tr(playing ? 'Pausa' : 'Reproducir'), icon: img(playing ? 'tb-pause.png' : 'tb-play.png'), click: () => send('command', 'toggle') },
    { tooltip: tr('Siguiente'), icon: img('tb-next.png'), click: () => send('command', 'next') },
  ]);
}

function createTray() {
  if (tray) return;
  tray = new Tray(img(process.platform === 'win32' ? 'icon.ico' : 'tray.png'));
  tray.setToolTip('BitChord');
  const menu = () => Menu.buildFromTemplate([
    { label: tr('Mostrar BitChord'), click: () => { win.show(); win.focus(); } },
    { type: 'separator' },
    { label: tr(playing ? 'Pausa' : 'Reproducir'), click: () => send('command', 'toggle') },
    { label: tr('Siguiente'), click: () => send('command', 'next') },
    { label: tr('Anterior'), click: () => send('command', 'prev') },
    { type: 'separator' },
    { label: tr('Salir'), click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu());
  tray.on('click', () => { win.isVisible() ? win.focus() : win.show(); });
  tray.refresh = () => tray.setContextMenu(menu());
}

function createWindow() {
  const bounds = settings.get('windowBounds') || {};
  win = new BrowserWindow({
    width: bounds.width || 1280,
    height: bounds.height || 820,
    x: bounds.x, y: bounds.y,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0d0d0f',
    title: 'BitChord',
    icon: path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    titleBarStyle: 'hidden',
    // Native buttons only with 'windows' window buttons; the macOS-style ones are drawn by the app
    // and then the window has no native buttons at all (even a hidden overlay lit up on hover).
    titleBarOverlay: settings.get('windowButtons') === 'windows' ? { color: '#00000000', symbolColor: '#f2f2f7', height: 44 } : false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  if (bounds.maximized) win.maximize();
  win.once('ready-to-show', () => { win.show(); updateThumbar(); });
  // Full-screen mode of the cover and lyrics view (button next to the volume, or F11).
  // The window buttons (minimise/maximise/close) stay drawn over a full-screen window: squash
  // the overlay while full screen and bring it back afterwards.
  // Native Windows buttons only in 'windows' mode and out of full screen; with macOS-style buttons
  // the app draws its own (renderer) and the overlay is squashed out of the way.
  const overlay = (on) => { if (settings.get('windowButtons') !== 'windows') return; try { win.setTitleBarOverlay({ color: '#00000000', symbolColor: on ? '#f2f2f7' : '#00000000', height: on ? 44 : 1 }); } catch {} };
  win.applyWindowButtons = () => overlay(!win.isFullScreen());
  win.on('maximize', () => send('maximized', true));
  win.on('unmaximize', () => send('maximized', false));
  win.on('enter-full-screen', () => { overlay(false); send('fullscreen', true); });
  win.on('leave-full-screen', () => { overlay(true); send('fullscreen', false); });
  win.webContents.on('before-input-event', (e, input) => {
    const k = input.key.toLowerCase();
    if (input.type === 'keyDown' && ((input.control && input.shift && k === 'i') || k === 'f12')) { win.webContents.toggleDevTools(); e.preventDefault(); }
    if (input.type === 'keyDown' && input.control && k === 'r') { win.webContents.reload(); e.preventDefault(); }
  });
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') console.warn('[renderer]', e.message);
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  const saveBounds = () => {
    if (win.isMinimized() || win.isFullScreen()) return;
    settings.set({ windowBounds: { ...(win.isMaximized() ? settings.get('windowBounds') : win.getBounds()), maximized: win.isMaximized() } });
  };
  win.on('close', (e) => {
    saveBounds();
    if (!quitting && settings.get('closeToTray')) { e.preventDefault(); createTray(); win.hide(); }
  });
  // Hidden helper windows (PO token) must not keep the process alive once the main window is gone:
  // otherwise a headless BitChord keeps the single-instance lock and new launches do nothing.
  win.on('closed', () => { win = null; quitting = true; app.quit(); });
}

app.on('second-instance', () => {
  if (!win || win.isDestroyed()) { win = null; if (app.isReady()) createWindow(); return; }
  { if (!win.isVisible()) win.show(); if (win.isMinimized()) win.restore(); win.focus(); }
});
app.on('before-quit', () => { quitting = true; });

const wrap = (fn) => async (_e, ...args) => {
  try { return { ok: true, data: await fn(...args) }; }
  catch (e) {
    console.error('[ipc]', e?.message || e);
    return { ok: false, error: String(e?.message || e) };
  }
};
const handle = (ch, fn) => ipcMain.handle(ch, wrap(fn));

function applyYtConfig() {
  yt.configure?.({
    cachePath: path.join(userData, 'yt-cache'),
    cookie: MOCK ? null : auth.loadCookie(),
    lang: settings.get('language'), location: settings.get('region'),
  });
}

app.whenReady().then(async () => {
  auth.init(userData);
  applyYtConfig();
  downloads.init(userData, (state) => send('downloads', state));
  local.init(userData);
  webdav.init(userData);
  playlists.init(userData);
  spotifySync.init(userData, { yt, playlists, openExternal: (u) => shell.openExternal(u), notify: (st) => send('spotify-sync', st) });
  const { port } = await startProxy({ userData });
  proxyPort = port;
  console.log('media server on port', port);

  ipcMain.handle('proxy-port', () => proxyPort);
  yt.setBlockListener?.((st) => send('yt-status', st));
  handle('yt-status', () => yt.blockStatus?.() || { blocked: false });
  // YouTube Music
  handle('home', () => yt.home());
  handle('search', (q, type) => yt.search(q, type));
  handle('suggestions', (q) => yt.suggestions(q));
  handle('album', (id) => yt.album(id));
  handle('playlist', (id) => yt.playlist(id));
  handle('artist', (id) => yt.artist(id));
  handle('up-next', (id) => yt.upNext(id));
  handle('prefetch', (id) => (downloads.localPath(id) ? true : yt.resolveStream(id, { maxKbps: settings.maxKbps(settings.get('streamQuality')) }).then(() => true)));
  handle('refresh-stream', (id) => yt.resolveStream(id, { fresh: true, maxKbps: settings.maxKbps(settings.get('streamQuality')) }).then(() => true));
  handle('stream-info', (id) => {
    const d = downloads.entry(id);
    if (d) return { mime: downloads.mimeFor(d.path), codec: d.codec, bitrate: d.bitrate, client: 'descargada', size: d.size };
    const alt = sources.usedFor(id);
    if (alt && alt.client === 'JioSaavn') return alt;
    return yt.streamInfo(id);
  });
  // Lyrics
  handle('lyrics-providers', () => settings.LYRICS_PROVIDERS);
  handle('lyrics', (track, provider) => lyrics.fetchLyrics(track, provider));
  // Settings
  handle('settings-get', () => settings.get());
  handle('settings-defaults', () => settings.DEFAULTS);
  handle('settings-set', (patch) => {
    const before = settings.get();
    const next = settings.set(patch);
    if ('discordRpc' in patch) discord.setEnabled(!!patch.discordRpc);
    if ('language' in patch || 'region' in patch) applyYtConfig();
    if ('uiLanguage' in patch) { tray?.refresh?.(); updateThumbar(); }
    if ('closeToTray' in patch && patch.closeToTray) createTray();
    // The native buttons can only be added or removed when the window is created: restart.
    if ('windowButtons' in patch && patch.windowButtons !== before.windowButtons) setTimeout(() => { quitting = true; app.relaunch(); app.exit(0); }, 400);
    if ('localFolders' in patch && JSON.stringify(before.localFolders) !== JSON.stringify(patch.localFolders)) { local.pruneFolderMeta(patch.localFolders || []); rescanLocal(); }
    if ('localFolders' in patch || 'localWatch' in patch) applyLocalWatch();
    return next;
  });
  // Account
  handle('account', async () => (MOCK ? (process.env.BITCHORD_MOCK_ACCOUNT ? { name: 'Prueba', email: 'prueba@example.com', photo: null } :  null) : yt.signedIn() ? await yt.accountInfo() : null));
  handle('login', async () => {
    const cookie = await auth.login(win);
    if (!cookie) return null;
    auth.saveCookie(cookie);
    applyYtConfig();
    return await yt.accountInfo();
  });
  handle('login-cookie', async (cookie) => {
    if (!/SAPISID=/.test(cookie || '')) throw new Error(tr('La cookie no parece de una sesión de YouTube (falta SAPISID).'));
    auth.saveCookie(cookie.trim());
    applyYtConfig();
    return await yt.accountInfo();
  });
  handle('logout', async () => { await auth.logout(); applyYtConfig(); return true; });
  handle('library', () => yt.library());
  handle('history', () => yt.history());
  handle('rate', (id, value) => yt.rate(id, value));
  // Downloads
  handle('downloads', () => downloads.list());
  handle('download', (tracks) => { downloads.enqueue(tracks); return true; });
  handle('download-cancel', (id) => downloads.cancel(id));
  handle('download-remove', (id) => downloads.remove(id));
  handle('download-show', (id) => { const p = downloads.localPath(id); if (p) shell.showItemInFolder(p); else shell.openPath(downloads.dir()); });
  handle('choose-folder', async (title) => {
    const r = await dialog.showOpenDialog(win, { title: title || 'Elegir carpeta', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  // Local library
  handle('local-tracks', () => local.tracks());
  handle('local-rescan', () => rescanLocal());
  const folderList = () => settings.get('localFolders') || [];
  handle('local-folders', () => local.folders(folderList()).map((f) => ({ ...f, watched: local.watched(f.path) })));
  handle('local-folder-get', (id) => ({ ...local.folderGet(folderList(), id), watching: !!settings.get('localWatch') }));
  handle('local-folder-rename', (id, name) => { local.renameFolder(id, name); return true; });
  handle('local-folder-cover-data', (id, bytes) => local.setFolderCover(id, bytes, nativeImage));
  handle('local-folder-cover-remove', (id) => { local.removeFolderCover(id); return true; });
  handle('local-folder-open', (id) => { const f = folderList().find((x) => local.folderId(x) === id); if (f) shell.openPath(f); return !!f; });
  handle('local-folder-rescan', (id) => { const f = folderList().find((x) => local.folderId(x) === id); return (f ? rescanLocal([f]) : rescanLocal()).then((l) => l.length); });
  // Custom covers of YouTube Music playlists (kept only on this PC)
  handle('yt-covers', () => playlists.ytCoverMap());
  handle('yt-cover-data', (id, bytes) => playlists.setYtCover(id, bytes, nativeImage));
  handle('yt-cover-remove', (id) => { playlists.removeYtCover(id); return true; });
  handle('account-playlists', async () => (MOCK || yt.signedIn() ? yt.accountPlaylists() : []));
  handle('yt-playlist-add', (id, videoIds) => yt.addToAccountPlaylist(id, videoIds));
  handle('yt-playlist-delete', (id) => yt.deleteAccountPlaylist(id));
  handle('yt-playlist-rename', (id, name) => yt.renameAccountPlaylist(id, name));
  handle('yt-feedback', (token) => yt.sendFeedback(token));
  handle('yt-playlist-create', (title, videoIds) => yt.createAccountPlaylist(title, videoIds || [], { description: 'Creada con BitChord' }));
  // Spotify import
  handle('choose-file', async (title, ext) => {
    if (process.env.BITCHORD_TEST_FILE) return process.env.BITCHORD_TEST_FILE; // automated UI tests
    const r = await dialog.showOpenDialog(win, { title, properties: ['openFile'], filters: [{ name: 'Datos de Spotify', extensions: ext || ['zip', 'json'] }] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('spotify-parse', (file) => spotify.parse(file));
  handle('spotify-match', (lists) => spotify.match(lists, (q) => yt.searchSongs(q), (p) => send('import-progress', { phase: 'match', ...p })));
  handle('spotify-cancel', () => spotify.cancel());
  handle('song-search', (q) => yt.searchSongs(q));
  // Animated cover of the big artwork (cover and lyrics view, full screen). The mock has none,
  // unless a test hands it a clip (BITCHORD_MOCK_CANVAS).
  canvas.configure({ countryCode: app.getLocaleCountryCode() });
  handle('canvas-for', (t) => (!MOCK ? canvas.canvasFor(t) : process.env.BITCHORD_MOCK_CANVAS ? { url: process.env.BITCHORD_MOCK_CANVAS, source: 'prueba' } : null));
  // Configuration backup (Ajustes → Copia de la configuración)
  let pendingBackup = null;
  handle('config-export', async (localStore) => {
    const day = new Date().toISOString().slice(0, 10);
    let file = process.env.BITCHORD_TEST_EXPORT;
    if (!file) {
      const r = await dialog.showSaveDialog(win, { title: tr('Guardar la configuración de BitChord'), defaultPath: path.join(app.getPath('desktop'), `BitChord-configuracion-${day}.bitchord`), filters: [{ name: tr('Configuración de BitChord'), extensions: ['bitchord'] }] });
      if (r.canceled || !r.filePath) return null;
      file = r.filePath;
    }
    const { data, manifest } = backup.build(userData, settings, localStore, VERSION);
    fs.writeFileSync(file, data);
    console.log('[backup] configuración guardada en', file);
    return { file, manifest };
  });
  handle('config-open', async () => {
    let file = process.env.BITCHORD_TEST_EXPORT;
    if (!file) {
      const r = await dialog.showOpenDialog(win, { title: tr('Importar la configuración de BitChord'), properties: ['openFile'], filters: [{ name: tr('Configuración de BitChord'), extensions: ['bitchord'] }] });
      if (r.canceled) return null;
      file = r.filePaths[0];
    }
    pendingBackup = backup.read(file);
    return pendingBackup.manifest;
  });
  handle('config-apply', () => {
    if (!pendingBackup) throw new Error(tr('Elige antes el archivo de configuración.'));
    const local = backup.apply(userData, settings, pendingBackup);
    pendingBackup = null;
    console.log('[backup] configuración importada');
    return local;
  });
  handle('app-relaunch', () => { setTimeout(() => { quitting = true; app.relaunch(); app.exit(0); }, 150); return true; });
  // Spotify account link (playlists kept up to date)
  handle('spotify-status', () => spotifySync.status());
  handle('spotify-connect', (clientId) => spotifySync.connect(clientId));
  handle('spotify-connect-cancel', () => spotifySync.cancelConnect());
  handle('spotify-disconnect', () => spotifySync.disconnect());
  handle('spotify-playlists', () => spotifySync.playlists());
  handle('spotify-link', (id, name) => spotifySync.link(id, name));
  handle('spotify-unlink', (id) => spotifySync.unlink(id));
  handle('spotify-sync', (id, opts) => spotifySync.sync(id, opts));
  handle('spotify-auto', (on) => spotifySync.setAuto(on));
  handle('spotify-create', async (items) => {
    const out = [];
    for (const [n, it] of items.entries()) {
      const ids = it.tracks.map((t) => t.id);
      try {
        const id = await yt.createAccountPlaylist(it.name, ids, {
          description: it.description || 'Importada de Spotify con BitChord',
          onProgress: (d) => send('import-progress', { phase: 'create', index: n, total: items.length, name: it.name, done: d, count: ids.length }),
        });
        out.push({ name: it.name, dest: 'yt', id, count: ids.length });
      } catch (e) {
        console.error('[import]', it.name, e);
        out.push({ name: it.name, dest: 'yt', error: String(e?.message || e), count: ids.length });
        if (e?.code === 'YT_BLOCKED' || /limitado temporalmente/.test(e?.message)) {
          // YouTube is refusing us: don't insist with the rest.
          for (const rest of items.slice(n + 1)) out.push({ name: rest.name, dest: 'yt', error: tr('No se intentó: YouTube estaba limitando las peticiones'), count: rest.tracks.length });
          break;
        }
      }
    }
    return out;
  });
  // Other sources
  handle('webdav-servers', () => webdav.listServers());
  handle('webdav-add', async (cfg) => { await webdav.test(cfg); const id = webdav.addServer(cfg); rescanWebdav(); return id; });
  handle('webdav-test', (cfg) => webdav.test(cfg));
  handle('webdav-remove', (id) => { webdav.removeServer(id); return true; });
  handle('webdav-tracks', () => webdav.tracks());
  handle('webdav-rescan', () => rescanWebdav());
  // Integrations
  ipcMain.on('player-state', (_e, st) => {
    const was = playing;
    playing = !!st?.playing;
    if (was !== playing) {
      updateThumbar(); tray?.refresh?.();
      if (playing && !blocker) blocker = powerSaveBlocker.start('prevent-app-suspension');
      if (!playing && blocker != null) { powerSaveBlocker.stop(blocker); blocker = null; }
    }
    discord.update(st);
    try { scrobble.tick(st); } catch (e) { console.warn('[scrobble]', e.message); }
    win?.setTitle(st?.track ? `${st.track.title} · ${(st.track.artists || []).map((a) => a.name).join(', ')} — BitChord` : 'BitChord');
  });
  handle('listenbrainz-validate', (token) => scrobble.validateListenBrainz(token));
  handle('lastfm-begin', () => scrobble.lastfmBeginAuth());
  handle('lastfm-finish', () => scrobble.lastfmFinishAuth());
  handle('lastfm-logout', () => { settings.set({ lastfmSession: '', lastfmUser: '' }); return true; });
  // Misc
  ipcMain.handle('open-log', () => shell.showItemInFolder(logFile));
  ipcMain.handle('set-fullscreen', (_e, on) => { win?.setFullScreen(!!on); return !!on; });
  // macOS-style window buttons (close goes through the normal close, so "close to tray" still works).
  ipcMain.handle('window-control', (_e, what) => {
    if (!win) return;
    if (what === 'close') win.close();
    else if (what === 'minimize') win.minimize();
    else if (what === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
  });
  ipcMain.handle('open-external', (_e, url) => { if (/^https?:/.test(url)) shell.openExternal(url); });
  ipcMain.on('set-progress', (_e, p) => win?.setProgressBar(p < 0 ? -1 : p, { mode: p < 0 ? 'none' : 'normal' }));
  ipcMain.handle('app-info', () => ({ version: VERSION, electron: process.versions.electron, chrome: process.versions.chrome, userData, platform: process.platform }));

  Menu.setApplicationMenu(null);
  createWindow();
  if (settings.get('closeToTray')) createTray();
  discord.setEnabled(!!settings.get('discordRpc'));
  // Pick up whatever changed in the music folders while BitChord was closed, then keep watching.
  applyLocalWatch();
  if ((settings.get('localFolders') || []).length) setTimeout(() => rescanLocal(), 4000);

  // Warm up the YouTube session while the window paints.
  if (!MOCK) {
    yt.setPoTokenProvider(potoken);
    yt.client().catch((e) => console.error('[yt] init failed', e));
    setTimeout(() => potoken.warmUp(), 3000);
  }
});

function rescanWebdav() {
  send('local-scan', { scanning: true, source: 'webdav' });
  return webdav.scan((n) => send('local-scan', { scanning: true, source: 'webdav', count: n }))
    .then((list) => { send('local-scan', { scanning: false, source: 'webdav', count: list.length }); return list; });
}

function rescanLocal(only = null) {
  const folders = settings.get('localFolders') || [];
  send('local-scan', { scanning: true });
  return local.scan(folders, (n) => send('local-scan', { scanning: true, count: n }), { only })
    .then((list) => { send('local-scan', { scanning: false, count: list.length, folders: only ? only.map(local.folderId) : null }); return list; });
}

function applyLocalWatch() {
  const list = settings.get('localWatch') ? settings.get('localFolders') || [] : [];
  local.watch(list, (folder) => { console.log('[local] cambios en', folder); rescanLocal([folder]); });
}

app.on('window-all-closed', () => { local.unwatchAll(); app.quit(); });
