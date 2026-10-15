const { contextBridge, ipcRenderer } = require('electron');

const call = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
const channels = [
  'home', 'search', 'suggestions', 'album', 'playlist', 'artist', 'up-next', 'prefetch', 'refresh-stream', 'stream-info',
  'lyrics-providers', 'lyrics', 'settings-get', 'settings-set', 'settings-defaults',
  'account', 'login', 'login-cookie', 'logout', 'library', 'history', 'rate',
  'downloads', 'download', 'download-cancel', 'download-remove', 'download-show', 'choose-folder',
  'local-tracks', 'local-rescan', 'webdav-servers', 'webdav-add', 'webdav-test', 'webdav-remove', 'webdav-tracks', 'webdav-rescan', 'account-playlists', 'font-status', 'font-import', 'font-faces', 'config-export', 'config-open', 'config-apply', 'app-relaunch', 'spotify-status', 'spotify-connect', 'spotify-disconnect', 'spotify-playlists', 'spotify-link', 'spotify-unlink', 'spotify-sync', 'spotify-auto', 'canvas-for', 'listenbrainz-validate', 'lastfm-begin', 'lastfm-finish', 'lastfm-logout', 'yt-status', 'yt-covers', 'yt-playlist-add', 'yt-playlist-delete', 'yt-playlist-rename', 'yt-feedback', 'yt-playlist-create', 'yt-cover-data', 'yt-cover-remove', 'local-folders', 'local-folder-get', 'local-folder-rename', 'local-folder-cover-data', 'local-folder-cover-remove', 'local-folder-open', 'local-folder-rescan',
];
const api = {};
for (const ch of channels) api[ch.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = call(ch);

contextBridge.exposeInMainWorld('bc', {
  ...api,
  proxyPort: () => ipcRenderer.invoke('proxy-port'),
  openLog: () => ipcRenderer.invoke('open-log'),
  setFullscreen: (on) => ipcRenderer.invoke('set-fullscreen', on),
  windowControl: (what) => ipcRenderer.invoke('window-control', what),
  openExternal: (u) => ipcRenderer.invoke('open-external', u),
  appInfo: () => ipcRenderer.invoke('app-info'),
  playerState: (st) => ipcRenderer.send('player-state', st),
  setProgress: (p) => ipcRenderer.send('set-progress', p),
  on: (ch, fn) => {
    if (!['command', 'downloads', 'local-scan', 'spotify-sync', 'yt-status', 'fullscreen', 'maximized', 'window-visible'].includes(ch)) return;
    ipcRenderer.on(ch, (_e, data) => fn(data));
  },
  platform: process.platform,
});
