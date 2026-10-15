// Spotify sign-in as the official BitChord app does it: Spotify's own login page in a window, and
// then the web player's session (the `sp_dc` cookie, kept in its own Electron session on this PC).
// No developer app: the playlists are read through the same GraphQL API open.spotify.com uses,
// with the access token the web player mints for itself (read from its own requests).
import { BrowserWindow, session } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tr } from './i18n.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PARTITION = 'persist:spotify';
// A plain Chrome identity for Spotify (with Firefox's, its Facebook/Google/Apple buttons answer
// HTTP 400). Google's pages («Continuar con Google») get the desktop-Firefox one of the Google
// login (see auth.js), since Google refuses sign-in from embedded Chromium.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const GOOGLE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0';
const isGoogle = (url) => { try { return /(^|\.)google\.com$/.test(new URL(url).hostname); } catch { return false; } };
const TOKEN_TTL = 40 * 60e3; // the web player's tokens last an hour

let tokens = null; // { bearer, clientToken, until }
let harvesting = null;
// GraphQL operations seen in the web player's own requests: operationName -> sha256Hash. Spotify
// changes these hashes now and then; the ones the web player uses are always current.
export const seenOps = new Map();
function noteOp(d) {
  try {
    const u = new URL(d.url);
    let name = u.searchParams.get('operationName'), hash = null;
    if (name) hash = JSON.parse(u.searchParams.get('extensions') || '{}').persistedQuery?.sha256Hash;
    else if (d.uploadData?.[0]?.bytes) {
      const j = JSON.parse(Buffer.from(d.uploadData[0].bytes).toString('utf8'));
      name = j.operationName; hash = j.extensions?.persistedQuery?.sha256Hash;
    }
    if (name && hash) seenOps.set(name, hash);
  } catch {}
}

function ses() {
  const s = session.fromPartition(PARTITION);
  if (!s.__bc) {
    s.__bc = true;
    s.setUserAgent(UA); // (no Accept-Language of our own: with one, Spotify's social sign-in buttons answer HTTP 400)
    s.webRequest.onBeforeRequest({ urls: ['https://api-partner.spotify.com/pathfinder/*'] }, (d, cb) => { noteOp(d); cb({}); });
    s.webRequest.onBeforeSendHeaders((d, cb) => {
      const h = { ...d.requestHeaders };
      if (isGoogle(d.url)) {
        for (const k of Object.keys(h)) if (/^sec-ch-ua/i.test(k) || /^x-client-data$/i.test(k)) delete h[k];
        h['User-Agent'] = GOOGLE_UA;
      }
      // The web player's own calls carry its token: that's the one BitChord uses.
      const auth = h.Authorization || h.authorization;
      if (s.__onToken && /^Bearer /.test(auth || '') && /(^|\.)spotify\.com$/.test(new URL(d.url).hostname)) {
        s.__onToken({ bearer: auth.slice(7), clientToken: h['client-token'] || h['Client-Token'] || null });
      }
      cb({ requestHeaders: h });
    });
  }
  return s;
}

/** Whether there's a Spotify session on this PC. */
export async function signedIn() {
  const c = await ses().cookies.get({ name: 'sp_dc' }).catch(() => []);
  return c.some((x) => x.value);
}

/** Spotify's login page; resolves true once signed in, false if the window is closed. */
export function login(parent) {
  return new Promise((resolve) => {
    const s = ses();
    const win = new BrowserWindow({
      parent, width: 480, height: 760, title: tr('Iniciar sesión en Spotify'), autoHideMenuBar: true, backgroundColor: '#121212',
      webPreferences: { partition: PARTITION, contextIsolation: false, sandbox: true, nodeIntegration: false, preload: path.join(__dirname, 'spotify-login-preload.cjs') },
    });
    win.setMenu(null);
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); if (!win.isDestroyed()) win.close(); };
    // Taken as soon as the web player's page is reached with the session cookie (it needs DRM to
    // play, which isn't here, so it's never shown).
    const check = async () => {
      if (!/^https:\/\/open\.spotify\.com/.test(win.webContents.getURL())) return;
      if (await signedIn()) { tokens = null; finish(true); }
    };
    // The page's own identity follows the site it's on (see GOOGLE_UA).
    win.webContents.on('did-start-navigation', (e) => {
      const want = isGoogle(e.url) ? GOOGLE_UA : UA;
      if (e.isMainFrame && !e.isSameDocument && win.webContents.getUserAgent() !== want) win.webContents.setUserAgent(want);
    });
    win.webContents.on('did-navigate', check);
    win.webContents.on('did-finish-load', check);
    win.webContents.setWindowOpenHandler(({ url }) => { win.loadURL(url); return { action: 'deny' }; });
    win.on('closed', () => finish(false));
    s.clearStorageData().catch(() => {}).finally(() => win.loadURL('https://accounts.spotify.com/login?continue=' + encodeURIComponent('https://open.spotify.com/')));
  });
}

export async function logout() {
  tokens = null;
  try { await ses().clearStorageData(); } catch {}
}

/** The web player's access token (and client token), minted by loading it in a hidden window. */
export async function token({ fresh = false } = {}) {
  if (!fresh && tokens && tokens.until > Date.now()) return tokens;
  if (!harvesting) harvesting = harvest().finally(() => { harvesting = null; });
  return harvesting;
}

function harvest() {
  return new Promise((resolve, reject) => {
    const s = ses();
    const win = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, backgroundThrottling: false, autoplayPolicy: 'user-gesture-required' } });
    win.webContents.setAudioMuted(true);
    let found = null, timer = null, grace = null;
    const end = (err) => {
      clearTimeout(timer); clearTimeout(grace);
      s.__onToken = null;
      // (Open a few seconds more, so the page's own queries show their current hashes.)
      setTimeout(() => { if (!win.isDestroyed()) win.destroy(); }, err ? 0 : 8000);
      if (err) reject(err);
      else { tokens = { ...found, until: Date.now() + TOKEN_TTL }; resolve(tokens); }
    };
    s.__onToken = (t) => {
      // The first request may come before the client token exists: wait a moment for one with both.
      found = { bearer: t.bearer, clientToken: t.clientToken || found?.clientToken || null };
      if (found.clientToken) end();
      else if (!grace) grace = setTimeout(() => end(), 2500);
    };
    timer = setTimeout(() => end(found ? null : new Error(tr('Spotify no ha respondido. Comprueba la conexión o vuelve a iniciar sesión en Spotify.'))), 30000);
    win.loadURL('https://open.spotify.com/').catch(() => {});
  });
}
