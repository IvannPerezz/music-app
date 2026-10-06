// Custom playlist covers kept on this PC: for YouTube Music playlists (YouTube doesn't let apps
// change a playlist's thumbnail) and, through coverPath, for the local music folders.
// (BitChord's own playlists, saved only on this PC, were removed in v0.6.37: playlists live in
// the YouTube Music account now. An old playlists.json is left untouched.)
import fs from 'node:fs';
import path from 'node:path';
import { tr } from './i18n.js';

let coverDir = null;

export function init(userData) {
  coverDir = path.join(userData, 'playlist-covers');
}

export const coverPath = (id) => path.join(coverDir, String(id).replace(/[^\w-]/g, '') + '.jpg');

// ---------------------------------------------------------------- covers for YouTube Music playlists
let ytCoversFile = null, ytCovers = null;
function ytLoad() {
  if (ytCovers) return ytCovers;
  ytCoversFile = path.join(coverDir, '..', 'yt-playlist-covers.json');
  try { ytCovers = JSON.parse(fs.readFileSync(ytCoversFile, 'utf8')) || {}; } catch { ytCovers = {}; }
  // Before v0.6.38 a cover set on a "VL…" page was kept under that spelling: move it to the bare id.
  let moved = false;
  for (const [id, at] of Object.entries(ytCovers)) {
    if (!id.startsWith('VL')) continue;
    const old = path.join(coverDir, 'yt-' + id.replace(/[^\w-]/g, '') + '.jpg');
    const newer = !(bare(id) in ytCovers) || ytCovers[bare(id)] < at;
    try { if (newer && fs.existsSync(old)) fs.renameSync(old, coverPath(ytKey(id))); else fs.rmSync(old, { force: true }); } catch {}
    delete ytCovers[id];
    if (newer) ytCovers[bare(id)] = at;
    moved = true;
  }
  if (moved) try { fs.writeFileSync(ytCoversFile, JSON.stringify(ytCovers)); } catch {}
  return ytCovers;
}
// YouTube writes the same playlist with or without "VL" in front: covers are kept under the bare
// id and listed under both spellings.
const bare = (id) => String(id).replace(/^VL/, '');
const ytKey = (id) => 'yt-' + bare(id).replace(/[^\w-]/g, '');
export function ytCoverMap() {
  const m = ytLoad();
  return Object.fromEntries(Object.entries(m).flatMap(([id, at]) => { const url = `/plcover/${ytKey(id)}?v=${at}`; return [[bare(id), url], ['VL' + bare(id), url]]; }));
}
/** Saves a cover from image bytes (any format Chromium decodes), centre-cropped to a 1000 px square JPEG. */
export function setYtCover(id, bytes, nativeImage) {
  id = bare(id);
  let img = nativeImage.createFromBuffer(Buffer.from(bytes));
  if (img.isEmpty()) throw new Error(tr('No se pudo leer la imagen (usa JPG, PNG, WebP o BMP)'));
  const { width, height } = img.getSize();
  const side = Math.min(width, height);
  img = img.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side });
  if (side > 1000) img = img.resize({ width: 1000, height: 1000, quality: 'best' });
  fs.mkdirSync(coverDir, { recursive: true });
  fs.writeFileSync(coverPath(ytKey(id)), img.toJPEG(90));
  delete ytLoad()['VL' + id];
  ytLoad()[id] = Date.now();
  fs.writeFileSync(ytCoversFile, JSON.stringify(ytCovers));
  return ytCoverMap()[id];
}
export function removeYtCover(id) {
  try { fs.rmSync(coverPath(ytKey(id)), { force: true }); } catch {}
  delete ytLoad()[id];
  delete ytLoad()[bare(id)];
  delete ytLoad()['VL' + bare(id)];
  try { fs.writeFileSync(ytCoversFile, JSON.stringify(ytCovers)); } catch {}
}
