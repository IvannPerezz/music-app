// Spotify account link: signs in on Spotify's own page (see spotify-web.js), reads the user's
// playlists through the web player's GraphQL API and keeps copies of them up to date in the YouTube
// Music account. Songs are matched on YouTube Music by title, artist and album (spotify-match.js).
import fs from 'node:fs';
import path from 'node:path';
import { nativeImage } from 'electron';
import { tr } from './i18n.js';
import { matchTrack } from './spotify-match.js';
import * as web from './spotify-web.js';

const GQL = 'https://api-partner.spotify.com/pathfinder/v2/query';
// Persisted queries of open.spotify.com (from the official BitChord app, October 2026). The ones the
// web player itself uses are preferred when seen (web.seenOps), so a change on Spotify's side
// doesn't break this.
const OPS = {
  libraryV3: '973e511ca44261fda7eebac8b653155e7caee3675abb4fb110cc1b8c78b091c3',
  fetchPlaylist: '346811f856fb0b7e4f6c59f8ebea78dd081c6e2fb01b77c954b26259d5fc6763',
  fetchLibraryTracks: '087278b20b743578a6262c2b0b4bcd20d879c503cc359a2285baf083ef944240',
};
const LIKED = '__liked__';
const AUTO_EVERY = 6 * 3600e3;

const MOCK = process.env.BITCHORD_MOCK === '1';

let file = null;
// { user: {id, name} | null (not linked), auto, links: [link] }
// link: { id, name, dest: 'yt', target, snapshot, matches: {spotifyTrackId: track|null}, added: [videoId], count, missing, lastSync, error }
let cfg = { user: null, auto: true, links: [] };
let deps = null;   // { yt, playlists, window, notify }
let busy = null;

export function init(userData, d) {
  deps = d;
  file = path.join(userData, 'spotify.json');
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  // Linked with a developer app before v0.6.50: the links stay, the sign-in has to be done again.
  if ('clientId' in cfg || 'token' in cfg) { delete cfg.clientId; delete cfg.token; cfg.user = null; save(); }
  if (MOCK && process.env.BITCHORD_MOCK_SPOTIFY === '1') cfg = { ...cfg, user: { id: 'iv', name: 'Iván' } };
  // Auto update: a little after start, then every few hours.
  setTimeout(() => autoSync(), MOCK ? 3e9 : 45e3);
  setInterval(() => autoSync(), AUTO_EVERY).unref?.();
}

function save() {
  if (!file) return;
  fs.writeFileSync(file + '.tmp', JSON.stringify(cfg));
  fs.renameSync(file + '.tmp', file);
}

export function status() {
  return {
    connected: !!cfg.user, user: cfg.user, auto: cfg.auto !== false,
    busy: busy ? { ...busy } : null,
    links: cfg.links.map(({ matches, added, ...l }) => l),
  };
}
const notify = () => deps?.notify?.(status());

// ---------------------------------------------------------------- sign in

export async function connect() {
  if (MOCK) { cfg.user = { id: 'iv', name: 'Iván' }; save(); notify(); return status(); }
  if (!(await web.login(deps.window?.()))) throw new Error(tr('Cancelado'));
  cfg.user = (await profile()) || { id: null, name: '' };
  save(); notify();
  console.log('[spotify] sesión iniciada como', cfg.user.name || '(sin nombre)');
  return status();
}

export async function disconnect() {
  await web.logout();
  cfg.user = null; save(); notify();
  return status();
}

/** The signed-in user's name and id, from the web player's own profile query (when it ran). */
async function profile() {
  try {
    await web.token({ fresh: true });
    await sleep(6000); // the page's own queries show up in its first seconds
    const hash = web.seenOps.get('profileAttributes');
    if (!hash) { console.warn('[spotify] el reproductor web no pidió el perfil; sin nombre de usuario'); return null; }
    const p = (await gql('profileAttributes', {}, hash))?.data?.me?.profile;
    return p ? { id: p.username || p.uri?.split(':').pop() || null, name: p.name || p.username || '' } : null;
  } catch (e) { console.warn('[spotify] perfil', e?.message || e); return null; }
}

// ---------------------------------------------------------------- reading Spotify

async function gql(operationName, variables, hash = null, tries = 0) {
  if (!(await web.signedIn())) { cfg.user = null; save(); notify(); throw new Error(tr('La sesión de Spotify ha caducado. Vuelve a iniciar sesión en Spotify (Importar).')); }
  const t = await web.token({ fresh: tries > 0 });
  const r = await fetch(GQL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + t.bearer, ...(t.clientToken ? { 'client-token': t.clientToken } : {}),
      Accept: 'application/json', 'Content-Type': 'application/json;charset=UTF-8', 'app-platform': 'WebPlayer',
      Origin: 'https://open.spotify.com', Referer: 'https://open.spotify.com/',
    },
    body: JSON.stringify({ variables, operationName, extensions: { persistedQuery: { version: 1, sha256Hash: hash || web.seenOps.get(operationName) || OPS[operationName] } } }),
  });
  if (r.status === 429 && tries < 3) { await sleep(Math.min(30, +r.headers.get('retry-after') || 5) * 1000); return gql(operationName, variables, hash, tries + 1); }
  if ((r.status === 401 || r.status === 400) && tries < 1) return gql(operationName, variables, hash, tries + 1);
  const j = await r.json().catch(() => ({}));
  const err = j.errors?.[0]?.message;
  if (!r.ok || err) throw new Error(tr('Spotify respondió {s}: {e}', { s: r.status, e: err || r.statusText }));
  return j;
}
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** Spotify lists an image's sizes in no fixed order: the widest one. */
const largest = (images) => (images?.items?.[0]?.sources || []).slice().sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url || '';
const artistsOf = (d) => (d?.artists?.items || []).map((a) => a.profile?.name).filter(Boolean).join(', ');
const trackOf = (d, uri) => (d?.name && (uri || d.uri) ? { sid: (uri || d.uri).split(':').pop(), title: d.name, artist: artistsOf(d), album: d.albumOfTrack?.name || '', uri: uri || d.uri } : null);

/** The user's playlists (+ «Canciones que te gustan»). */
export async function playlists() {
  if (MOCK) return mockLists();
  const out = [];
  for (let offset = 0; ; ) {
    const lib = (await gql('libraryV3', {
      filters: ['Playlists'], order: null, textFilter: '', features: ['LIKED_SONGS', 'YOUR_EPISODES_V2', 'PRERELEASES', 'EVENTS'],
      limit: 50, offset, flatten: true, expandedFolders: [], folderUri: null, includeFoldersWhenFlattening: false,
    }))?.data?.me?.libraryV3;
    if (!lib) throw new Error(tr('Spotify no ha devuelto tu biblioteca.'));
    const items = lib.items || [];
    for (const it of items) {
      const w = it.item, d = w?.data;
      if (!w?._uri || d?.__typename !== 'Playlist' || !d.name) continue;
      const owner = d.ownerV2?.data;
      out.push({
        id: w._uri.split(':').pop(), name: d.name, owner: owner?.name || '',
        mine: !!cfg.user?.id && (owner?.username === cfg.user.id || owner?.uri === 'spotify:user:' + cfg.user.id),
        count: d.content?.totalCount ?? null, image: largest(d.images),
      });
    }
    offset += items.length;
    if (!items.length || offset >= (lib.totalCount ?? 0)) break;
  }
  let liked = null;
  try { liked = (await gql('fetchLibraryTracks', { offset: 0, limit: 1 }))?.data?.me?.library?.tracks?.totalCount ?? null; } catch {}
  out.unshift({ id: LIKED, name: tr('Me gusta de Spotify'), owner: cfg.user?.name || '', mine: true, count: liked, image: '', liked: true });
  return out;
}

async function tracksOf(id) {
  if (MOCK) return mockTracks(id);
  const out = [];
  for (let offset = 0; ; ) {
    let items, total;
    if (id === LIKED) {
      const t = (await gql('fetchLibraryTracks', { offset, limit: 100 }))?.data?.me?.library?.tracks;
      items = t?.items || []; total = t?.totalCount ?? 0;
      for (const it of items) { const x = trackOf(it.track?.data, it.track?._uri); if (x) out.push(x); }
    } else {
      const c = (await gql('fetchPlaylist', { uri: 'spotify:playlist:' + id, offset, limit: 100, enableWatchFeedEntrypoint: false }))?.data?.playlistV2?.content;
      if (!c) throw new Error(tr('Spotify no ha devuelto esa playlist (puede que ya no exista o sea privada de otra persona).'));
      items = c.items || []; total = c.totalCount ?? 0;
      for (const it of items) { const d = it.itemV2?.data; if (d?.__typename === 'Track') { const x = trackOf(d); if (x) out.push(x); } }
    }
    offset += items.length;
    if (!items.length || offset >= total) break;
  }
  return out;
}

/** Version of the playlist (changes when its songs change), its cover, name and description
 *  (name/description null for «Me gusta», which has neither). */
async function snapshotOf(id) {
  if (MOCK) {
    const m = mockLists().find((x) => x.id === id);
    // (The same version id even when songs are added: like Spotify's stale answers.)
    return { snap: 'mock', image: id === LIKED ? '' : 'mock:' + id, name: id === LIKED ? null : m?.name ?? null, description: id === LIKED ? null : m?.description ?? '' };
  }
  if (id === LIKED) {
    const t = (await gql('fetchLibraryTracks', { offset: 0, limit: 1 }))?.data?.me?.library?.tracks;
    return { snap: `${t?.totalCount}:${t?.items?.[0]?.track?._uri || ''}`, image: '', name: null, description: null };
  }
  const p = (await gql('fetchPlaylist', { uri: 'spotify:playlist:' + id, offset: 0, limit: 1, enableWatchFeedEntrypoint: false }))?.data?.playlistV2;
  if (!p?.name) throw new Error(tr('Spotify no ha devuelto esa playlist (puede que ya no exista o sea privada de otra persona).'));
  return { snap: p.revisionId || '', image: largest(p.images), name: p.name, description: plainText(p.description || '') };
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
  if (description != null && description !== l.description) {
    try { await yt.describeAccountPlaylist(l.target, description); }
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
  if (!cfg.user) throw new Error(tr('Vincula tu cuenta de Spotify primero.'));
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
        if (/ha caducado|Vincula tu cuenta/.test(l.error)) break;
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
  if (!cfg.auto || !cfg.user || !cfg.links.length || busy) return;
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
