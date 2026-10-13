// Proof-of-Origin tokens via BotGuard (port of BitChord's PoTokenWebView / NewPipe's approach).
// BotGuard runs inside a hidden Chromium window with no network access; the two
// service calls (Create, GenerateIT) are made from here.
import { BrowserWindow, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOOGLE_API_KEY = 'AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw';
const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const PARTITION = 'potoken';

let win = null;
let ready = null; // Promise while initialising
let expiresAt = 0;
let failures = 0;
let disabledUntil = 0;

async function bgRequest(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'User-Agent': UA, Accept: 'application/json', 'Content-Type': 'application/json+protobuf', 'x-goog-api-key': GOOGLE_API_KEY, 'x-user-agent': 'grpc-web-javascript/0.1' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`BotGuard ${new URL(url).pathname}: HTTP ${r.status}`);
  return r.json();
}

const b64 = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/').replace(/\./g, '='), 'base64');

function parseChallenge(raw) {
  let data;
  if (raw.length > 1 && typeof raw[1] === 'string') {
    const descrambled = Buffer.from(b64(raw[1]).map((b) => (b + 97) & 0xff)).toString('utf8');
    data = JSON.parse(descrambled);
  } else data = raw[0];
  const firstString = (a) => (Array.isArray(a) ? a.find((x) => typeof x === 'string') ?? null : null);
  return {
    messageId: data[0],
    interpreterJavascript: {
      privateDoNotAccessOrElseSafeScriptWrappedValue: firstString(data[1]),
      privateDoNotAccessOrElseTrustedResourceUrlWrappedValue: firstString(data[2]),
    },
    interpreterHash: data[3], program: data[4], globalName: data[5], clientExperimentsStateBlob: data[7],
  };
}

async function createWindow() {
  const ses = session.fromPartition(PARTITION);
  // BotGuard must not phone home from the page itself: block every request but the page.
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !/^(data|about|file):/.test(d.url) }));
  ses.setUserAgent(UA);
  const w = new BrowserWindow({
    show: false, width: 400, height: 300,
    webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, offscreen: false, backgroundThrottling: false },
  });
  const html = fs.readFileSync(path.join(__dirname, '..', 'assets', 'po_token.html'), 'utf8');
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html), { baseURLForDataURL: 'https://www.youtube.com/' });
  return w;
}

async function init() {
  if (win && !win.isDestroyed()) win.destroy();
  win = await createWindow();
  const challenge = parseChallenge(await bgRequest('https://www.youtube.com/api/jnn/v1/Create', [REQUEST_KEY]));
  if (!challenge.interpreterJavascript.privateDoNotAccessOrElseSafeScriptWrappedValue) throw new Error('BotGuard sin intérprete');
  const botguardResponse = await win.webContents.executeJavaScript(
    `runBotGuard(${JSON.stringify(challenge)}).then(function (r) { window.webPoSignalOutput = r.webPoSignalOutput; return r.botguardResponse; })`, true);
  const it = await bgRequest('https://www.youtube.com/api/jnn/v1/GenerateIT', [REQUEST_KEY, botguardResponse]);
  const integrity = Array.from(b64(it[0]));
  const ttl = Number(it[1]) || 3600;
  await win.webContents.executeJavaScript(`createPoTokenMinter(window.webPoSignalOutput, new Uint8Array(${JSON.stringify(integrity)}))`, true);
  expiresAt = Date.now() + (ttl - 600) * 1000;
  console.log(`[potoken] BotGuard listo (caduca en ${Math.round(ttl / 60)} min)`);
}

async function ensure() {
  if (Date.now() < disabledUntil) throw new Error('PO token desactivado temporalmente');
  if (win && !win.isDestroyed() && Date.now() < expiresAt) return;
  if (!ready) {
    ready = init().then(() => { failures = 0; }).catch((e) => {
      failures++;
      if (failures >= 3) disabledUntil = Date.now() + 10 * 60 * 1000;
      throw e;
    }).finally(() => { ready = null; });
  }
  return ready;
}

async function mint(identifier) {
  await ensure();
  const bytes = Array.from(Buffer.from(identifier, 'utf8'));
  const out = await Promise.race([
    win.webContents.executeJavaScript(`obtainPoToken(new Uint8Array(${JSON.stringify(bytes)})).then(function (u) { return Array.from(u); })`, true),
    new Promise((_, rej) => setTimeout(() => rej(new Error('PO token: tiempo agotado')), 8000)),
  ]);
  return Buffer.from(out).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

/** {player, streaming} tokens for a video, or null. Both are bound to the video: since 2026 the
 *  streaming (GVS) one bound to the visitor or the account's Data Sync ID, as before, is ignored and
 *  googlevideo stops after the first MiB (yt-dlp's PO Token Guide: web tokens are video-bound). */
export async function tokensFor(videoId) {
  try {
    const token = await mint(videoId);
    return { player: token, streaming: token };
  } catch (e) {
    console.warn('[potoken]', e?.message || e);
    if (win && !win.isDestroyed()) { win.destroy(); }
    win = null; expiresAt = 0;
    return null;
  }
}

export function warmUp() { ensure().catch((e) => console.warn('[potoken] warm-up:', e?.message)); }
