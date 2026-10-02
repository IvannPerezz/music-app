// BitChord's own playlists (stored on this PC, not in any account).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tr } from './i18n.js';

let file = null;
let coverDir = null;
let lists = []; // [{id, name, description, created, updated, tracks: [track]}]

export function init(userData) {
  file = path.join(userData, 'playlists.json');
  coverDir = path.join(userData, 'playlist-covers');
  try { lists = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { lists = []; }
}

function save() {
  fs.writeFileSync(file + '.tmp', JSON.stringify(lists));
  fs.renameSync(file + '.tmp', file);
}

const clean = (t) => { const { _k, ...rest } = t; return rest; };
const summary = (p) => ({
  id: p.id, name: p.name, description: p.description || '', count: p.tracks.length,
  duration: p.tracks.reduce((s, t) => s + (t.duration || 0), 0),
  thumbs: [...new Set(p.tracks.map((t) => t.thumb).filter(Boolean))].slice(0, 4),
  cover: p.coverAt ? `/plcover/${p.id}?v=${p.coverAt}` : null,
  updated: p.updated, origin: p.origin || null,
});

export const list = () => lists.map(summary).sort((a, b) => b.updated - a.updated);

export function get(id) {
  const p = lists.find((x) => x.id === id);
  if (!p) throw new Error(tr('Esa playlist ya no existe'));
  return { ...summary(p), tracks: p.tracks };
}

export function create(name, tracks = [], { description = '', origin = null } = {}) {
  name = String(name || '').trim() || 'Nueva playlist';
  const p = { id: 'P' + crypto.randomBytes(6).toString('hex'), name, description, origin, created: Date.now(), updated: Date.now(), tracks: tracks.map(clean) };
  lists.push(p);
  save();
  return p.id;
}

export function rename(id, name) {
  const p = lists.find((x) => x.id === id);
  if (!p) return;
  p.name = String(name || '').trim() || p.name;
  p.updated = Date.now();
  save();
}

export function remove(id) {
  lists = lists.filter((x) => x.id !== id);
  try { fs.rmSync(coverPath(id), { force: true }); } catch {}
  save();
}

export function addTracks(id, tracks) {
  const p = lists.find((x) => x.id === id);
  if (!p) throw new Error(tr('Esa playlist ya no existe'));
  const have = new Set(p.tracks.map((t) => t.id));
  const add = tracks.map(clean).filter((t) => !have.has(t.id) && have.add(t.id));
  p.tracks.push(...add);
  p.updated = Date.now();
  save();
  return add.length;
}

export function removeAt(id, index) {
  const p = lists.find((x) => x.id === id);
  if (!p) return;
  p.tracks.splice(index, 1);
  p.updated = Date.now();
  save();
}

export function move(id, from, to) {
  const p = lists.find((x) => x.id === id);
  if (!p || from === to) return;
  const [t] = p.tracks.splice(from, 1);
  p.tracks.splice(to, 0, t);
  p.updated = Date.now();
  save();
}

// ---------------------------------------------------------------- custom covers
export const coverPath = (id) => path.join(coverDir, String(id).replace(/[^\w-]/g, '') + '.jpg');

/** Saves a cover from image bytes (any format Chromium decodes), centre-cropped to a 1000 px square JPEG. */
export function setCover(id, bytes, nativeImage) {
  const p = lists.find((x) => x.id === id);
  if (!p) throw new Error(tr('Esa playlist ya no existe'));
  let img = nativeImage.createFromBuffer(Buffer.from(bytes));
  if (img.isEmpty()) throw new Error(tr('No se pudo leer la imagen (usa JPG, PNG, WebP o BMP)'));
  const { width, height } = img.getSize();
  const side = Math.min(width, height);
  img = img.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side });
  if (side > 1000) img = img.resize({ width: 1000, height: 1000, quality: 'best' });
  fs.mkdirSync(coverDir, { recursive: true });
  fs.writeFileSync(coverPath(id), img.toJPEG(90));
  p.coverAt = Date.now();
  p.updated = Date.now();
  save();
  return summary(p).cover;
}

export function removeCover(id) {
  const p = lists.find((x) => x.id === id);
  if (!p) return;
  try { fs.rmSync(coverPath(id), { force: true }); } catch {}
  delete p.coverAt;
  save();
}

// ---------------------------------------------------------------- covers for YouTube Music playlists
// YouTube doesn't let third-party apps change a playlist's thumbnail, so these live only here.
let ytCoversFile = null, ytCovers = null;
function ytLoad() {
  if (ytCovers) return ytCovers;
  ytCoversFile = path.join(coverDir, '..', 'yt-playlist-covers.json');
  try { ytCovers = JSON.parse(fs.readFileSync(ytCoversFile, 'utf8')) || {}; } catch { ytCovers = {}; }
  return ytCovers;
}
const ytKey = (id) => 'yt-' + String(id).replace(/[^\w-]/g, '');
export function ytCoverMap() {
  const m = ytLoad();
  return Object.fromEntries(Object.entries(m).map(([id, at]) => [id, `/plcover/${ytKey(id)}?v=${at}`]));
}
export function setYtCover(id, bytes, nativeImage) {
  let img = nativeImage.createFromBuffer(Buffer.from(bytes));
  if (img.isEmpty()) throw new Error(tr('No se pudo leer la imagen (usa JPG, PNG, WebP o BMP)'));
  const { width, height } = img.getSize();
  const side = Math.min(width, height);
  img = img.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side });
  if (side > 1000) img = img.resize({ width: 1000, height: 1000, quality: 'best' });
  fs.mkdirSync(coverDir, { recursive: true });
  fs.writeFileSync(coverPath(ytKey(id)), img.toJPEG(90));
  ytLoad()[id] = Date.now();
  fs.writeFileSync(ytCoversFile, JSON.stringify(ytCovers));
  return ytCoverMap()[id];
}
export function removeYtCover(id) {
  try { fs.rmSync(coverPath(ytKey(id)), { force: true }); } catch {}
  delete ytLoad()[id];
  try { fs.writeFileSync(ytCoversFile, JSON.stringify(ytCovers)); } catch {}
}
