// Local music library: scans the folders the user picks and reads tags with music-metadata.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseFile } from 'music-metadata';
import { coverPath } from './playlists.js';
import { tr } from './i18n.js';

const EXT = new Set(['.mp3', '.m4a', '.mp4', '.aac', '.flac', '.ogg', '.opus', '.wav', '.webm', '.weba', '.wma']);
let indexFile = null;
let byId = new Map(); // id -> {path, mtime, track}
let scanning = null;
let pending = null;
let latest = [];
let metaFile = null;
let meta = {}; // folder id -> { name?, coverAt? }

export function init(userData) {
  indexFile = path.join(userData, 'local-index.json');
  metaFile = path.join(userData, 'local-folders.json');
  try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) || {}; } catch { meta = {}; }
  try {
    const arr = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    byId = new Map(arr.map((e) => [e.track.id, e]));
  } catch { byId = new Map(); }
}

const idFor = (p) => 'L' + crypto.createHash('sha1').update(p).digest('hex').slice(0, 15);
export const pathFor = (id) => byId.get(id)?.path || null;
export const tracks = () => [...byId.values()].map((e) => e.track).sort((a, b) => (a.artists[0]?.name || '').localeCompare(b.artists[0]?.name || '') || (a.album?.name || '').localeCompare(b.album?.name || '') || (a.trackNo || 0) - (b.trackNo || 0));

function* walk(dir, depth = 0) {
  if (depth > 12) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, depth + 1);
    else if (EXT.has(path.extname(e.name).toLowerCase())) yield p;
  }
}

/**
 * Indexes the given folders. With `only`, just those folders are walked again (the rest of the
 * index is kept as is) — that's what the folder watcher uses after a change.
 */
export function scan(folders, onProgress = () => {}, { only = null } = {}) {
  latest = folders;
  if (scanning) {
    // A scan is running: queue one more (full, cheap: unchanged files are skipped) pass afterwards.
    pending = pending || scanning.then(() => { pending = null; return scan(latest, onProgress); });
    return pending;
  }
  scanning = (async () => {
    const seen = new Set();
    const roots = only || folders;
    let n = 0;
    for (const folder of roots) {
      for (const p of walk(folder)) {
        const id = idFor(p);
        seen.add(id);
        let st; try { st = fs.statSync(p); } catch { continue; }
        const prev = byId.get(id);
        // v2 entries carry the technical details shown in the library; re-read older ones once.
        if (prev && prev.mtime === st.mtimeMs && prev.v === 2) continue;
        try {
          const m = await parseFile(p, { duration: true, skipCovers: false });
          const c = m.common;
          const artists = (c.artists?.length ? c.artists : c.artist ? [c.artist] : []).map((name) => ({ name, id: null }));
          byId.set(id, {
            path: p, mtime: st.mtimeMs, hasCover: !!c.picture?.length, v: 2,
            track: {
              kind: 'track', id, local: true,
              title: c.title || path.basename(p, path.extname(p)),
              artists: artists.length ? artists : [{ name: 'Artista desconocido', id: null }],
              album: c.album ? { id: null, name: c.album } : null,
              duration: Math.round(m.format.duration || 0),
              trackNo: c.track?.no || 0,
              thumb: c.picture?.length ? `/cover/${id}` : null,
              codec: m.format.codec || '', bitrate: Math.round((m.format.bitrate || 0) / 1000), sampleRate: m.format.sampleRate || null,
              file: {
                ext: path.extname(p).slice(1).toUpperCase(),
                container: m.format.container || '',
                codec: m.format.codec || '',
                profile: m.format.codecProfile || '',
                lossless: !!m.format.lossless,
                // music-metadata derives bitrate from file size; take embedded artwork out of it.
                bitrate: Math.round(Math.min(m.format.bitrate || Infinity,
                  m.format.duration ? Math.max(0, st.size - (c.picture || []).reduce((a, x) => a + x.data.length, 0) * (/ogg/i.test(m.format.container || '') ? 4 / 3 : 1)) * 8 / m.format.duration : Infinity) / 1000) || 0,
                sampleRate: m.format.sampleRate || null,
                bitDepth: m.format.bitsPerSample || null,
                channels: m.format.numberOfChannels || null,
                size: st.size,
                year: c.year || null,
                genre: (c.genre || []).join(', '),
                trackNo: c.track?.no || null, trackOf: c.track?.of || null,
                disc: c.disk?.no || null,
                path: p,
                modified: st.mtimeMs,
              },
            },
          });
        } catch (e) { console.warn('[local] skip', p, e?.message); }
        if (++n % 25 === 0) onProgress(n);
      }
    }
    // Drop files that disappeared or whose folder was removed.
    for (const [id, e] of [...byId]) {
      if (seen.has(id)) continue;
      const inScope = only ? only.some((f) => inside(e.path, f)) || !folders.some((f) => inside(e.path, f)) : true;
      if (inScope) byId.delete(id);
    }
    try { fs.writeFileSync(indexFile, JSON.stringify([...byId.values()])); } catch {}
    return tracks();
  })().finally(() => { scanning = null; });
  return scanning;
}

export async function cover(id) {
  const e = byId.get(id);
  if (!e) return null;
  try {
    const m = await parseFile(e.path, { skipPostHeaders: true });
    const pic = m.common.picture?.[0];
    return pic ? { mime: pic.format || 'image/jpeg', data: Buffer.from(pic.data) } : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- folders as playlists
const norm = (p) => { const r = path.resolve(p); return process.platform === 'win32' ? r.toLowerCase() : r; };
export function inside(file, folder) {
  const f = norm(folder), p = norm(file);
  return p === f || p.startsWith(f.endsWith(path.sep) ? f : f + path.sep);
}
export const folderId = (folder) => 'F' + crypto.createHash('sha1').update(norm(folder)).digest('hex').slice(0, 15);
const saveMeta = () => { try { fs.writeFileSync(metaFile, JSON.stringify(meta, null, 1)); } catch {} };
const relCmp = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

function folderEntries(folder) {
  return [...byId.values()].filter((e) => inside(e.path, folder)).sort((a, b) => relCmp(a.path, b.path));
}

function folderSummary(folder, entries = folderEntries(folder)) {
  const id = folderId(folder);
  const m = meta[id] || {};
  const thumbs = [];
  const seenAlbums = new Set();
  for (const e of entries) {
    if (!e.track.thumb) continue;
    const k = e.track.album?.name || e.path;
    if (seenAlbums.has(k)) continue;
    seenAlbums.add(k); thumbs.push(e.track.thumb);
    if (thumbs.length >= 4) break;
  }
  return {
    id, path: folder,
    name: m.name || path.basename(folder.replace(/[\\/]+$/, '')) || folder,
    customName: !!m.name,
    count: entries.length,
    duration: entries.reduce((s, e) => s + (e.track.duration || 0), 0),
    size: entries.reduce((s, e) => s + (e.track.file?.size || 0), 0),
    thumbs,
    cover: m.coverAt ? `/plcover/${id}?v=${m.coverAt}` : null,
  };
}

export const folders = (list) => list.map((f) => folderSummary(f));

export function folderGet(list, id) {
  const folder = list.find((f) => folderId(f) === id);
  if (!folder) throw new Error(tr('Esa carpeta ya no está en BitChord'));
  const entries = folderEntries(folder);
  return { ...folderSummary(folder, entries), tracks: entries.map((e) => e.track) };
}

export function renameFolder(id, name) {
  meta[id] = { ...(meta[id] || {}) };
  if (name && name.trim()) meta[id].name = name.trim().slice(0, 120); else delete meta[id].name;
  saveMeta();
}

export function setFolderCover(id, bytes, nativeImage) {
  let img = nativeImage.createFromBuffer(Buffer.from(bytes));
  if (img.isEmpty()) throw new Error(tr('No se pudo leer la imagen (usa JPG, PNG, WebP o BMP)'));
  const { width, height } = img.getSize();
  const side = Math.min(width, height);
  img = img.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side });
  if (side > 1000) img = img.resize({ width: 1000, height: 1000, quality: 'best' });
  const file = coverPath(id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, img.toJPEG(90));
  meta[id] = { ...(meta[id] || {}), coverAt: Date.now() };
  saveMeta();
  return `/plcover/${id}?v=${meta[id].coverAt}`;
}

export function removeFolderCover(id) {
  try { fs.rmSync(coverPath(id), { force: true }); } catch {}
  if (meta[id]) { delete meta[id].coverAt; saveMeta(); }
}

/** Forget name/cover of folders that were removed from the library. */
export function pruneFolderMeta(list) {
  const keep = new Set(list.map(folderId));
  let changed = false;
  for (const id of Object.keys(meta)) if (!keep.has(id)) { removeFolderCover(id); delete meta[id]; changed = true; }
  if (changed) saveMeta();
}

// ---------------------------------------------------------------- automatic updates
// fs.watch uses the OS change notifications (ReadDirectoryChangesW on Windows), so an idle
// watcher costs nothing; after a burst of changes we wait a few seconds and re-index only
// that folder (unchanged files are skipped by their modification time).
const watchers = new Map(); // folder -> { w, timer }
export function watch(list, onChange) {
  for (const [f, x] of watchers) if (!list.includes(f)) { try { x.w.close(); } catch {} clearTimeout(x.timer); watchers.delete(f); }
  for (const folder of list) {
    if (watchers.has(folder)) continue;
    const x = { w: null, timer: null };
    try {
      x.w = fs.watch(folder, { recursive: true, persistent: false }, (_ev, name) => {
        if (name && !EXT.has(path.extname(String(name)).toLowerCase()) && path.extname(String(name))) return; // ignore non-audio files
        clearTimeout(x.timer);
        x.timer = setTimeout(() => onChange(folder), 4000);
      });
      x.w.on('error', (e) => { console.warn('[local] watcher', folder, e.message); try { x.w.close(); } catch {} watchers.delete(folder); });
      watchers.set(folder, x);
    } catch (e) { console.warn('[local] no se puede vigilar', folder, e.message); }
  }
  return [...watchers.keys()];
}
export function unwatchAll() { watch([], () => {}); }
export const watched = (folder) => watchers.has(folder);
