// WebDAV servers (Nextcloud, ownCloud, NAS…) as a music source — port of BitChord's WebDAV library.
// Folder layout "Artista/Álbum/01 - Título.ext" is understood; a cover.jpg/folder.jpg becomes the artwork.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { safeStorage } from 'electron';

const AUDIO = /\.(mp3|m4a|mp4|aac|flac|ogg|opus|wav|webm|weba|alac|wma)$/i;
const COVER = /^(cover|folder|front|album|artwork)\.(jpe?g|png|webp)$/i;
let indexFile = null;
let byId = new Map(); // id -> {serverId, url, coverUrl, track}
let servers = []; // [{id, label, url, user, passEnc}]
let serversFile = null;
let scanning = null;

export function init(userData) {
  indexFile = path.join(userData, 'webdav-index.json');
  serversFile = path.join(userData, 'webdav-servers.json');
  try { byId = new Map(JSON.parse(fs.readFileSync(indexFile, 'utf8')).map((e) => [e.track.id, e])); } catch {}
  try { servers = JSON.parse(fs.readFileSync(serversFile, 'utf8')); } catch { servers = []; }
}

const enc = (s) => (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(s).toString('base64') : 'plain:' + Buffer.from(s).toString('base64'));
const dec = (s) => {
  if (!s) return '';
  try { return s.startsWith('plain:') ? Buffer.from(s.slice(6), 'base64').toString() : safeStorage.decryptString(Buffer.from(s, 'base64')); } catch { return ''; }
};
const saveServers = () => fs.writeFileSync(serversFile, JSON.stringify(servers, null, 1));
const saveIndex = () => { try { fs.writeFileSync(indexFile, JSON.stringify([...byId.values()])); } catch {} };

export const listServers = () => servers.map(({ passEnc, ...s }) => ({ ...s, tracks: [...byId.values()].filter((e) => e.serverId === s.id).length }));

function authHeaders(server) {
  if (!server.user) return {};
  return { Authorization: 'Basic ' + Buffer.from(`${server.user}:${dec(server.passEnc)}`).toString('base64') };
}

export function addServer({ url, user, pass, label }) {
  url = String(url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('La dirección debe empezar por http:// o https://');
  if (!url.endsWith('/')) url += '/';
  const s = { id: 'w' + crypto.randomBytes(4).toString('hex'), url, user: user || '', passEnc: pass ? enc(pass) : '', label: label || new URL(url).host };
  servers.push(s);
  saveServers();
  return s.id;
}

export function removeServer(id) {
  servers = servers.filter((s) => s.id !== id);
  for (const [k, v] of byId) if (v.serverId === id) byId.delete(k);
  saveServers(); saveIndex();
}

async function propfind(server, url) {
  const r = await fetch(url, {
    method: 'PROPFIND',
    headers: { ...authHeaders(server), Depth: '1', 'Content-Type': 'application/xml' },
    body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>',
  });
  if (r.status === 401) throw new Error('Usuario o contraseña incorrectos');
  if (r.status !== 207) throw new Error(`El servidor respondió HTTP ${r.status} (¿es una dirección WebDAV?)`);
  const xml = await r.text();
  const out = [];
  for (const m of xml.matchAll(/<(?:\w+:)?response\b[^>]*>([\s\S]*?)<\/(?:\w+:)?response>/gi)) {
    const body = m[1];
    const href = /<(?:\w+:)?href[^>]*>([\s\S]*?)<\/(?:\w+:)?href>/i.exec(body)?.[1]?.trim();
    if (!href) continue;
    const isDir = /<(?:\w+:)?collection\s*\/?>/i.test(body);
    const size = parseInt(/<(?:\w+:)?getcontentlength[^>]*>(\d+)</i.exec(body)?.[1] || '0', 10);
    const abs = new URL(href.replace(/&amp;/g, '&'), url).toString();
    out.push({ url: abs, isDir, size });
  }
  return out;
}

export async function test({ url, user, pass }) {
  const s = { url: url.endsWith('/') ? url : url + '/', user, passEnc: pass ? enc(pass) : '' };
  const items = await propfind(s, s.url);
  return { ok: true, entries: items.length - 1 };
}

const nameOf = (u) => decodeURIComponent(new URL(u).pathname.replace(/\/$/, '').split('/').pop() || '');

function trackFromPath(server, fileUrl, coverUrl) {
  const segs = decodeURIComponent(new URL(fileUrl).pathname).split('/').filter(Boolean);
  const file = segs.pop() || '';
  const album = segs.length ? segs[segs.length - 1] : '';
  const artistDir = segs.length > 1 ? segs[segs.length - 2] : '';
  let base = file.replace(/\.[^.]+$/, '');
  let trackNo = 0;
  const n = /^(\d{1,3})[\s._-]+(.*)$/.exec(base);
  if (n) { trackNo = +n[1]; base = n[2]; }
  let artist = artistDir, title = base;
  const dash = /^(.+?)\s+-\s+(.+)$/.exec(base);
  if (dash) { artist = dash[1]; title = dash[2]; }
  const id = 'W' + crypto.createHash('sha1').update(fileUrl).digest('hex').slice(0, 15);
  return {
    serverId: server.id, url: fileUrl, coverUrl,
    track: {
      kind: 'track', id, local: true, remote: true, source: 'webdav',
      title: title.trim() || file,
      artists: [{ name: (artist || server.label).trim(), id: null }],
      album: album ? { id: null, name: album } : null,
      duration: 0, trackNo,
      thumb: coverUrl ? `/webdavcover/${id}` : null,
    },
  };
}

export function scan(onProgress = () => {}) {
  if (scanning) return scanning;
  scanning = (async () => {
    const seen = new Set();
    let count = 0;
    for (const server of servers) {
      const queue = [{ url: server.url, depth: 0 }];
      const visited = new Set();
      while (queue.length && count < 20000) {
        const { url, depth } = queue.shift();
        if (visited.has(url)) continue;
        visited.add(url);
        let items;
        try { items = await propfind(server, url); } catch (e) { console.warn('[webdav]', url, e.message); continue; }
        const entries = items.filter((i) => i.url.replace(/\/$/, '') !== url.replace(/\/$/, ''));
        const cover = entries.find((i) => !i.isDir && COVER.test(nameOf(i.url)));
        for (const e of entries) {
          if (e.isDir) { if (depth < 8) queue.push({ url: e.url.endsWith('/') ? e.url : e.url + '/', depth: depth + 1 }); continue; }
          if (!AUDIO.test(nameOf(e.url))) continue;
          const t = trackFromPath(server, e.url, cover?.url || null);
          seen.add(t.track.id);
          if (!byId.has(t.track.id)) byId.set(t.track.id, t);
          if (++count % 50 === 0) onProgress(count);
        }
      }
    }
    for (const k of [...byId.keys()]) if (!seen.has(k)) byId.delete(k);
    saveIndex();
    return tracks();
  })().finally(() => { scanning = null; });
  return scanning;
}

export const tracks = () => [...byId.values()].map((e) => e.track).sort((a, b) =>
  (a.artists[0]?.name || '').localeCompare(b.artists[0]?.name || '') || (a.album?.name || '').localeCompare(b.album?.name || '') || (a.trackNo - b.trackNo) || a.title.localeCompare(b.title));

/** {url, headers} to fetch the file (for the media server). */
export function source(id, cover = false) {
  const e = byId.get(id);
  if (!e) return null;
  const server = servers.find((s) => s.id === e.serverId);
  if (!server) return null;
  const url = cover ? e.coverUrl : e.url;
  return url ? { url, headers: authHeaders(server) } : null;
}
