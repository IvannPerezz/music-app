// Spotify account link: reads the user's playlists with the Spotify Web API (through a developer app
// the user creates, Authorization Code + PKCE, no client secret) and keeps copies of them in
// YouTube Music / BitChord up to date. Songs are matched with the same scoring as the .zip import.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { safeStorage, nativeImage } from 'electron';
import { tr } from './i18n.js';
import { matchTrack } from './spotify-import.js';

export const REDIRECT_PORT = 47832;
export const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
const SCOPES = 'playlist-read-private playlist-read-collaborative user-library-read';
const API = 'https://api.spotify.com/v1';
const LIKED = '__liked__';
const AUTO_EVERY = 6 * 3600e3;

const MOCK = process.env.BITCHORD_MOCK === '1';

let file = null;
// { clientId, token (encrypted refresh token, base64), user: {id, name}, auto, links: [link] }
// link: { id, name, dest: 'yt', target, snapshot, matches: {spotifyTrackId: track|null}, added: [videoId], count, missing, lastSync, error }
let cfg = { clientId: '', token: '', user: null, auto: true, links: [] };
let access = null; // { token, until }
let deps = null;   // { yt, playlists, openExternal, notify }
let busy = null;

export function init(userData, d) {
  deps = d;
  file = path.join(userData, 'spotify.json');
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  // Copies kept only in BitChord no longer exist (v0.6.37): those links now go to YouTube Music,
  // where the copy is created on the next update.
  let moved = 0;
  for (const l of cfg.links) if (l.dest !== 'yt') { Object.assign(l, { dest: 'yt', target: null, snapshot: null, added: [], cover: null }); moved++; }
  if (moved) { console.log('[spotify]', moved, 'vínculos pasan de BitChord a YouTube Music'); save(); }
  if (MOCK && process.env.BITCHORD_MOCK_SPOTIFY === '1') cfg = { ...cfg, clientId: 'mockclient', token: 'mock', user: { id: 'iv', name: 'Iván' } };
  // Auto update: a little after start, then every few hours.
  setTimeout(() => autoSync(), MOCK ? 3e9 : 45e3);
  setInterval(() => autoSync(), AUTO_EVERY).unref?.();
}

function save() {
  if (!file) return;
  fs.writeFileSync(file + '.tmp', JSON.stringify(cfg));
  fs.renameSync(file + '.tmp', file);
}
const enc = (s) => (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(s) : Buffer.from(s)).toString('base64');
const dec = (s) => { const b = Buffer.from(s, 'base64'); return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(b) : b.toString(); };

export function status() {
  return {
    clientId: cfg.clientId, connected: !!cfg.token, user: cfg.user, auto: cfg.auto !== false, redirectUri: REDIRECT_URI,
    busy: busy ? { ...busy } : null,
    links: cfg.links.map(({ matches, added, ...l }) => l),
  };
}
const notify = () => deps?.notify?.(status());

// ---------------------------------------------------------------- sign in (PKCE)
let pending = null;

export async function connect(clientId) {
  clientId = String(clientId || '').trim();
  if (!/^[0-9a-f]{32}$/i.test(clientId)) throw new Error(tr('El Client ID no parece correcto: son 32 letras y números (Spotify lo muestra en los ajustes de tu app).'));
  cfg.clientId = clientId; save();
  if (MOCK) { cfg.token = 'mock'; cfg.user = { id: 'iv', name: 'Iván' }; save(); notify(); return status(); }
  pending?.close();
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(12).toString('hex');
  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, REDIRECT_URI);
      if (u.pathname !== '/callback') return res.writeHead(404).end();
      const ok = u.searchParams.get('state') === state && u.searchParams.get('code');
      const err = u.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>BitChord</title><body style="font:16px system-ui;background:#111;color:#eee;display:grid;place-items:center;height:90vh;text-align:center"><div><h2>${ok ? tr('¡Listo! BitChord ya está vinculado con Spotify.') : tr('No se ha podido vincular')}</h2><p>${ok ? tr('Puedes cerrar esta pestaña y volver a BitChord.') : esc(err || '')}</p></div>`);
      finish();
      if (ok) resolve(ok); else reject(new Error(err === 'access_denied' ? tr('Has cancelado el permiso en Spotify.') : tr('Spotify no ha devuelto el permiso ({e}).', { e: err || '?' })));
    });
    const timer = setTimeout(() => { finish(); reject(new Error(tr('Se acabó el tiempo para dar permiso en Spotify. Vuelve a intentarlo.'))); }, 5 * 60e3);
    const finish = () => { clearTimeout(timer); server.close(); pending = null; };
    pending = { close: () => { finish(); reject(new Error(tr('Cancelado'))); } };
    server.on('error', (e) => { finish(); reject(new Error(tr('No se pudo abrir el puerto {port} para recibir el permiso de Spotify ({e}).', { port: REDIRECT_PORT, e: e.code || e.message }))); });
    server.listen(REDIRECT_PORT, '127.0.0.1', () => {
      const q = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: REDIRECT_URI, scope: SCOPES, state, code_challenge_method: 'S256', code_challenge: challenge });
      deps.openExternal('https://accounts.spotify.com/authorize?' + q);
    });
  });
  await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: verifier });
  const me = await get('/me');
  cfg.user = { id: me.id, name: me.display_name || me.id };
  save(); notify();
  console.log('[spotify] vinculado como', cfg.user.name);
  return status();
}

export function cancelConnect() { pending?.close(); }

export function disconnect() {
  cfg.token = ''; cfg.user = null; access = null; save(); notify();
  return status();
}

async function tokenRequest(params) {
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.clientId, ...params }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (j.error === 'invalid_grant' && params.grant_type === 'refresh_token') { cfg.token = ''; save(); notify(); throw new Error(tr('Spotify ha retirado el permiso. Vuelve a vincular la cuenta en Importar.')); }
    throw new Error(tr('Spotify ha rechazado el inicio de sesión: {e}', { e: j.error_description || j.error || r.status }));
  }
  access = { token: j.access_token, until: Date.now() + (j.expires_in - 60) * 1000 };
  if (j.refresh_token) { cfg.token = enc(j.refresh_token); save(); }
  return true;
}

async function accessToken() {
  if (access && access.until > Date.now()) return access.token;
  if (!cfg.token) throw new Error(tr('Vincula tu cuenta de Spotify primero.'));
  await tokenRequest({ grant_type: 'refresh_token', refresh_token: dec(cfg.token) });
  return access.token;
}

async function get(p, tries = 0) {
  const r = await fetch(p.startsWith('http') ? p : API + p, { headers: { Authorization: 'Bearer ' + (await accessToken()) } });
  if (r.status === 429 && tries < 3) { await sleep(Math.min(30, +r.headers.get('retry-after') || 5) * 1000); return get(p, tries + 1); }
  if (r.status === 401 && tries < 1) { access = null; return get(p, tries + 1); }
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    const e = new Error(r.status === 403 && /user may not be registered|not registered/i.test(j.error?.message || '')
      ? tr('Spotify dice que tu cuenta no está dada de alta en la app. En el panel de desarrollador, abre tu app → User Management y añade tu correo de Spotify.')
      : tr('Spotify respondió {s}: {e}', { s: r.status, e: j.error?.message || r.statusText }));
    e.status = r.status;
    throw e;
  }
  return r.json();
}
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------------------------------------------------------- reading Spotify

/** The user's playlists (+ «Canciones que te gustan»). */
export async function playlists() {
  if (MOCK) return mockLists();
  const out = [];
  let next = '/me/playlists?limit=50';
  while (next) {
    const j = await get(next);
    for (const p of j.items || []) if (p) out.push({ id: p.id, name: p.name, owner: p.owner?.display_name || '', mine: p.owner?.id === cfg.user?.id, count: (p.items || p.tracks)?.total ?? 0, image: p.images?.[0]?.url || '', snapshot: p.snapshot_id });
    next = j.next;
  }
  let liked = 0;
  try { liked = (await get('/me/tracks?limit=1')).total; } catch {}
  out.unshift({ id: LIKED, name: tr('Me gusta de Spotify'), owner: cfg.user?.name || '', mine: true, count: liked, image: '', liked: true });
  return out;
}

const trackOf = (t) => (t && t.type !== 'episode' && !t.is_local && t.name ? { sid: t.id || t.uri, title: t.name, artist: (t.artists || []).map((a) => a.name).join(', '), album: t.album?.name || '', uri: t.uri } : null);

async function tracksOf(id) {
  if (MOCK) return mockTracks(id);
  const out = [];
  let next;
  if (id === LIKED) next = '/me/tracks?limit=50';
  else {
    // Newer API name first (/items), the older one (/tracks) if this account still has that.
    try { const j = await get(`/playlists/${id}/items?limit=100`); push(j); next = j.next; return await rest(); }
    catch (e) { if (e.status !== 404) throw e; }
    next = `/playlists/${id}/tracks?limit=100`;
  }
  async function rest() { while (next) { const j = await get(next); push(j); next = j.next; } return out; }
  function push(j) { for (const it of j.items || []) { const t = trackOf(it.item || it.track); if (t) out.push(t); } }
  return rest();
}

/** Version of the playlist (changes when its songs change), its cover, name and description
 *  (name/description null for «Me gusta», which has neither). */
async function snapshotOf(id) {
  if (MOCK) {
    const m = mockLists().find((x) => x.id === id);
    // (The same version id even when songs are added: like Spotify's stale answers.)
    return { snap: 'mock', image: id === LIKED ? '' : 'mock:' + id, name: id === LIKED ? null : m?.name ?? null, description: id === LIKED ? null : m?.description ?? '' };
  }
  if (id === LIKED) { const j = await get('/me/tracks?limit=1'); return { snap: `${j.total}:${j.items?.[0]?.added_at || ''}`, image: '', name: null, description: null }; }
  const j = await get(`/playlists/${id}?fields=snapshot_id,images,name,description`);
  // The biggest image Spotify has (its own collage, or the one you uploaded).
  const img = (j.images || []).slice().sort((a, b) => (b.width || 0) - (a.width || 0))[0];
  return { snap: j.snapshot_id, image: img?.url || '', name: j.name || null, description: plainText(j.description || '') };
}
/** Spotify sends descriptions as HTML (entities, links to other playlists): keep just the text. */
const plainText = (s) => s.replace(/<[^>]*>/g, '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[e.toLowerCase()];
  if (named) return named;
  const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return Number.isFinite(n) ? String.fromCodePoint(n) : m;
}).trim();

/** Name and description changed in Spotify go to the copy too (what you change on the copy itself
 *  stays until they change again in Spotify). */
async function updateDetails(l, name, description) {
  if (!l.target) return;
  const { yt } = deps;
  if (name && name !== l.name) {
    await yt.renameAccountPlaylist(l.target, name).catch((e) => console.error('[spotify] nombre de', l.name, e?.message || e));
    l.name = name;
  }
  // (descSynced: copies made before v0.6.38 kept BitChord's own text; they get Spotify's once.)
  if (description != null && (description !== l.description || !l.descSynced)) {
    try { await yt.describeAccountPlaylist(l.target, description); l.descSynced = true; }
    catch (e) { console.error('[spotify] descripción de', l.name, e?.message || e); }
    l.description = description;
  }
}

/** Puts the Spotify cover on the copy (as the BitChord-only cover of the YT Music playlist). */
async function updateCover(l, image) {
  if (!image || !l.target || l.cover === image) return;
  try {
    let bytes;
    if (MOCK) bytes = nativeImage.createFromBitmap(Buffer.alloc(64 * 64 * 4, 0x9a), { width: 64, height: 64 }).toPNG();
    else {
      const r = await fetch(image);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      bytes = Buffer.from(await r.arrayBuffer());
    }
    deps.playlists.setYtCover(l.target, bytes, nativeImage);
    l.cover = image;
  } catch (e) { console.error('[spotify] portada de', l.name, e?.message || e); }
}

// ---------------------------------------------------------------- links

/** The copy always goes to the YouTube Music account. */
export function link(id, name) {
  if (!cfg.token) throw new Error(tr('Vincula tu cuenta de Spotify primero.'));
  let l = cfg.links.find((x) => x.id === id);
  if (!l) cfg.links.push(l = { id, name, dest: 'yt', target: null, snapshot: null, matches: {}, added: [], count: 0, missing: 0, lastSync: 0 });
  else l.name = name;
  save(); notify();
  return status();
}

export function unlink(id) {
  cfg.links = cfg.links.filter((x) => x.id !== id);
  save(); notify();
  return status();
}

export function setAuto(on) { cfg.auto = !!on; save(); return status(); }

/** Updates one linked playlist, several (array of ids), or all of them (null). */
export async function sync(id = null, { force = false } = {}) {
  const ids = id == null ? null : new Set([].concat(id));
  if (busy) throw new Error(tr('Ya se está actualizando con Spotify'));
  const todo = cfg.links.filter((l) => !ids || ids.has(l.id));
  if (!todo.length) return status();
  busy = { index: 0, total: todo.length, name: todo[0].name, done: 0, count: 0 };
  notify();
  let blocked = null;
  try {
    for (const [i, l] of todo.entries()) {
      Object.assign(busy, { index: i, name: l.name, done: 0, count: 0 });
      notify();
      try { await syncOne(l, force); l.error = null; }
      catch (e) {
        console.error('[spotify] sync', l.name, e);
        l.error = String(e?.message || e);
        if (e?.code === 'YT_BLOCKED' || /limitado temporalmente/.test(e?.message)) { blocked = e; break; }
        if (/retirado el permiso|Vincula tu cuenta/.test(l.error)) break;
      }
      save();
    }
  } finally { busy = null; save(); notify(); }
  if (blocked) throw blocked;
  return status();
}

async function syncOne(l, force) {
  if (force) l.cover = null;
  const { yt } = deps;
  const { snap, image, name, description } = await snapshotOf(l.id);
  console.log('[spotify]', l.name, '· portada:', image ? 'sí' : 'no', '· descripción:', description ? `${description.length} caracteres` : 'vacía');
  const targetOk = !!l.target;
  if (!targetOk) l.cover = null; // a new copy needs the cover again
  if (targetOk) await updateDetails(l, name, description);
  // The song list is always read again: Spotify can keep answering with an old version id
  // (snapshot) for a while after a change, so trusting it skipped new songs. Only songs not seen
  // before are looked up in YouTube Music, and nothing is written there if nothing changed.
  l.lastAdded = 0; l.lastRemoved = 0;
  const src = await tracksOf(l.id);
  busy.count = src.length;
  // Look up only songs that weren't matched before.
  for (const [i, t] of src.entries()) {
    if (!(t.sid in l.matches)) {
      const r = await matchTrack(t, (q) => yt.searchSongs(q));
      l.matches[t.sid] = r.track ? clean(r.track) : null;
      await sleep(350 + Math.random() * 300); // be gentle with YouTube
    }
    busy.done = i + 1;
    if (i % 5 === 0) notify();
  }
  const ids = new Set(src.map((t) => t.sid));
  for (const k of Object.keys(l.matches)) if (!ids.has(k)) delete l.matches[k]; // forget removed songs
  const seen = new Set();
  const tracks = src.map((t) => l.matches[t.sid]).filter((t) => t && !seen.has(t.id) && seen.add(t.id));

  if (!targetOk) { // a new copy starts with Spotify's name and description
    if (name) l.name = name;
    if (description != null) l.description = description;
  }
  const want = tracks.map((t) => t.id);
  if (!l.target) {
    l.target = await yt.createAccountPlaylist(l.name, want, { description: description || '' });
    l.added = want;
    l.descSynced = true;
  } else {
    const have = new Set(l.added || []);
    const add = want.filter((v) => !have.has(v));
    const wantSet = new Set(want);
    const remove = (l.added || []).filter((v) => !wantSet.has(v)); // only songs BitChord put there
    try {
      if (add.length) await yt.addToAccountPlaylist(l.target, add);
      if (remove.length) await yt.removeFromAccountPlaylist(l.target, remove);
    } catch (e) {
      if (/not found|no existe|404|cannot be edited/i.test(e?.message)) { l.target = null; l.added = []; throw new Error(tr('La playlist de YouTube Music ya no existe; se volverá a crear en la próxima actualización.')); }
      throw e;
    }
    l.added = want;
    l.lastAdded = add.length; l.lastRemoved = remove.length;
    if (add.length || remove.length) console.log('[spotify]', l.name, '+' + add.length, '-' + remove.length);
  }
  await updateCover(l, image);
  l.snapshot = snap;
  l.count = tracks.length;
  l.missing = src.length - src.filter((t) => l.matches[t.sid]).length;
  l.lastSync = Date.now();
}
const clean = ({ _k, _score, feedback, ...t }) => t;

async function autoSync() {
  if (!cfg.auto || !cfg.token || !cfg.links.length || busy) return;
  try { await sync(null); } catch (e) { console.error('[spotify] auto', e?.message || e); }
}

// ---------------------------------------------------------------- test data
function mockLists() {
  return [
    { id: LIKED, name: tr('Me gusta de Spotify'), owner: 'Iván', mine: true, count: 6, image: '', liked: true },
    { id: 'sp1', name: 'Rock en español', owner: 'Iván', mine: true, count: 5, image: '' },
    { id: 'sp2', name: 'Para correr', owner: 'Iván', mine: true, count: 4, image: '' },
    { id: 'sp3', name: 'Éxitos de hoy', owner: 'Spotify', mine: false, count: 50, image: '' },
  ];
}
function mockTracks(id) {
  // Tests add songs "in Spotify" through globalThis.__mockSpotifyExtra = { [id]: n }.
  const n = Math.min(6, (id === LIKED ? 6 : id === 'sp1' ? 5 : 4) + (globalThis.__mockSpotifyExtra?.[id] || 0));
  const names = ['Luz de Neón', 'Midnight Drive', 'Olas', 'Paper Planes', 'Ciudad Dormida', 'Golden Hour'];
  const artists = ['Lúa Vega', 'The Night Owls', 'Marea Alta', 'Kite Club', 'Solenne'];
  return Array.from({ length: n }, (_, i) => ({ sid: id + i, title: names[i], artist: artists[i % 5], album: '', uri: '' }));
}
