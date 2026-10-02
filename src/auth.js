// Google sign-in: a real browser window on accounts.google.com, then we keep the YouTube cookies
// (encrypted with the OS keychain via safeStorage), as BitChord does with its WebView login.
import { BrowserWindow, session, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tr } from './i18n.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PARTITION = 'persist:google-login';
// Google blocks sign-in from embedded Chromium ("this browser or app may not be secure").
// Presenting a consistent desktop-Firefox identity (UA, no Client Hints, no window.chrome) avoids it.
const LOGIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0';
let file = null;

export function init(userData) { file = path.join(userData, 'auth.bin'); }

export function loadCookie() {
  try {
    const buf = fs.readFileSync(file);
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
  } catch { return null; }
}

export function saveCookie(cookie) {
  if (!cookie) { try { fs.rmSync(file, { force: true }); } catch {} return; }
  const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(cookie) : Buffer.from(cookie, 'utf8');
  fs.writeFileSync(file, data);
}

async function youtubeCookieHeader(ses) {
  const all = await ses.cookies.get({});
  const yt = all.filter((c) => /(^|\.)youtube\.com$/.test(c.domain.replace(/^\./, '')) || c.domain === '.youtube.com');
  if (!yt.some((c) => c.name === 'SAPISID' || c.name === '__Secure-3PAPISID')) return null;
  const seen = new Set();
  return yt.filter((c) => (seen.has(c.name) ? false : seen.add(c.name))).map((c) => `${c.name}=${c.value}`).join('; ');
}

/** Opens the Google login window; resolves with the cookie header, or null if the user closed it. */
export function login(parent) {
  return new Promise((resolve) => {
    const ses = session.fromPartition(PARTITION);
    ses.setUserAgent(LOGIN_UA, 'es-ES,es;q=0.9,en;q=0.8');
    if (!ses.__bcHeaders) {
      ses.__bcHeaders = true;
      ses.webRequest.onBeforeSendHeaders((d, cb) => {
        const h = { ...d.requestHeaders };
        for (const k of Object.keys(h)) if (/^sec-ch-ua/i.test(k) || /^x-client-data$/i.test(k)) delete h[k];
        h['User-Agent'] = LOGIN_UA;
        cb({ requestHeaders: h });
      });
    }
    const win = new BrowserWindow({
      parent, modal: false, width: 500, height: 740, title: tr('Iniciar sesión con Google'),
      autoHideMenuBar: true, backgroundColor: '#ffffff',
      webPreferences: { partition: PARTITION, contextIsolation: false, sandbox: true, nodeIntegration: false, preload: path.join(__dirname, 'login-preload.cjs') },
    });
    win.setMenu(null);
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); if (!win.isDestroyed()) win.close(); };
    const check = async () => {
      const url = win.webContents.getURL();
      if (!/^https:\/\/music\.youtube\.com/.test(url)) return;
      const cookie = await youtubeCookieHeader(ses);
      if (cookie) finish(cookie);
    };
    win.webContents.on('did-navigate', check);
    win.webContents.on('did-finish-load', check);
    win.on('closed', () => finish(null));
    win.loadURL('https://accounts.google.com/ServiceLogin?ltmpl=music&service=youtube&passive=true&continue=' +
      encodeURIComponent('https://www.youtube.com/signin?action_handle_signin=true&next=https%3A%2F%2Fmusic.youtube.com%2F'),
      { userAgent: LOGIN_UA });
  });
}

export async function logout() {
  saveCookie(null);
  try { await session.fromPartition(PARTITION).clearStorageData(); } catch {}
}
