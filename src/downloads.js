// Offline downloads: fetch the stream at the chosen quality, remux/tag it, keep an index.
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { resolveStream, markRefused, rememberMeta } from './yt.js';
import * as settings from './settings.js';
import { webmToOggOpus } from './mux/webm-opus.js';
import { tagMp4 } from './mux/mp4-tag.js';
import { fetchLyrics } from './lyrics.js';
import { tr } from './i18n.js';

let indexFile = null;
let coverDir = null;
let index = {}; // videoId -> entry
const jobs = new Map(); // videoId -> {track, status, progress, error}
const queue = [];
let running = 0;
const CONCURRENCY = 2;
let notify = () => {};

export function init(userData, onChange) {
  indexFile = path.join(userData, 'downloads.json');
  coverDir = path.join(userData, 'covers');
  notify = onChange;
  try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch { index = {}; }
  // Forget files the user deleted by hand.
  let changed = false;
  for (const [id, e] of Object.entries(index)) if (!fs.existsSync(e.path)) { delete index[id]; changed = true; }
  if (changed) save();
}

function save() {
  try { fs.writeFileSync(indexFile + '.tmp', JSON.stringify(index, null, 1)); fs.renameSync(indexFile + '.tmp', indexFile); } catch (e) { console.error('[dl] save', e); }
}

export const dir = () => settings.get('downloadDir') || path.join(app.getPath('music'), 'BitChord');
export const localPath = (id) => (index[id] && fs.existsSync(index[id].path) ? index[id].path : null);
export const entry = (id) => index[id] || null;

export function list() {
  const done = Object.values(index).sort((a, b) => b.at - a.at);
  const active = [...jobs.values()].map((j) => ({ ...j }));
  return { done, active, dir: dir() };
}

const safe = (s) => String(s || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 120) || 'Sin título';

function emit() { notify(list()); }

export function enqueue(tracks) {
  for (const t of tracks) {
    if (!t?.id || t.id.startsWith('L') || index[t.id] || jobs.has(t.id)) continue;
    const { _k, ...track } = t;
    jobs.set(t.id, { id: t.id, track, status: 'queued', progress: 0 });
    queue.push(t.id);
  }
  emit();
  pump();
}

export function cancel(id) {
  const j = jobs.get(id);
  if (!j) return;
  j.cancelled = true;
  j.abort?.abort();
  jobs.delete(id);
  const qi = queue.indexOf(id);
  if (qi >= 0) queue.splice(qi, 1);
  emit();
}

export function remove(id) {
  const e = index[id];
  if (!e) return;
  for (const p of [e.path, e.lrc, coverDir && path.join(coverDir, id + '.jpg')]) if (p) try { fs.rmSync(p, { force: true }); } catch {}
  delete index[id];
  save();
  emit();
}

function pump() {
  while (running < CONCURRENCY && queue.length) {
    const id = queue.shift();
    const job = jobs.get(id);
    if (!job) continue;
    running++;
    run(job).catch((e) => {
      if (job.cancelled) return;
      console.error('[dl]', id, e);
      job.status = 'error'; job.error = String(e?.message || e);
      emit();
    }).finally(() => { running--; pump(); });
  }
}

async function run(job) {
  const t = job.track;
  job.status = 'resolving'; emit();
  const format = settings.get('downloadFormat');
  const maxKbps = settings.maxKbps(settings.get('downloadQuality'));
  rememberMeta(t.id, { title: t.title, artist: (t.artists || []).map((a) => a.name).join(', '), duration: t.duration });
  let stream = await resolveStream(t.id, { maxKbps, prefer: format === 'm4a' ? 'm4a' : 'opus', fresh: true });
  job.status = 'downloading'; emit();
  job.abort = new AbortController();

  // Chunked download with the minting client's headers (same as playback).
  const parts = [];
  let pos = 0, lastEmit = 0;
  while (pos < stream.size) {
    const end = Math.min(pos + stream.chunk * 4 - 1, stream.size - 1);
    let r, tries = 0;
    for (;;) {
      r = await fetch(stream.url, { headers: { ...stream.headers, Range: `bytes=${pos}-${end}` }, signal: job.abort.signal });
      if (r.status === 206 || (r.status === 200 && pos === 0)) break;
      if (++tries > 3) throw new Error(tr('HTTP {status} al descargar', { status: r.status }));
      if (r.status === 403 && stream.clientName) {
        // Refused past the authorisation boundary: same format from another client.
        markRefused(t.id, stream.clientName);
        const next = await resolveStream(t.id, { maxKbps, itag: stream.itag, fresh: true }).catch(() => null);
        if (next && next.size === stream.size) { stream = next; continue; }
      }
      await new Promise((ok) => setTimeout(ok, 800 * tries));
    }
    const b = Buffer.from(await r.arrayBuffer());
    parts.push(b);
    pos += b.length;
    if (r.status === 200) break;
    job.progress = pos / stream.size;
    if (Date.now() - lastEmit > 300) { lastEmit = Date.now(); emit(); }
    if (job.cancelled) return;
  }
  let data = Buffer.concat(parts);
  job.status = 'tagging'; job.progress = 1; emit();

  // Cover art (square, jpeg).
  let cover = null;
  if (t.thumb && /^https?:/.test(t.thumb)) {
    try {
      const u = t.thumb.replace(/=w\d+-h\d+[^&?#]*$/, '=w1200-h1200-l95-rj');
      const r = await fetch(u);
      if (r.ok) cover = { mime: r.headers.get('content-type')?.includes('png') ? 'image/png' : 'image/jpeg', data: Buffer.from(await r.arrayBuffer()) };
    } catch {}
  }

  // Synced lyrics as a sidecar .lrc (and embedded in m4a).
  let lrc = null;
  try {
    const l = await fetchLyrics(t, 'lrclib');
    if (l?.format === 'lrc') lrc = l.data;
  } catch {}

  const artist = (t.artists || []).map((a) => a.name).filter(Boolean).join(', ');
  const tags = { title: t.title, artist, album: t.album?.name || '', albumArtist: t.artists?.[0]?.name || '' };
  let ext;
  if (stream.mime.includes('webm')) {
    ext = 'opus';
    data = webmToOggOpus(data, {
      TITLE: tags.title, ARTIST: (t.artists || []).map((a) => a.name), ALBUM: tags.album, ALBUMARTIST: tags.albumArtist,
      COMMENT: `https://music.youtube.com/watch?v=${t.id}`, ...(lrc ? { LYRICS: lrc } : {}),
    }, cover);
  } else {
    ext = 'm4a';
    data = tagMp4(data, { ...tags, comment: `https://music.youtube.com/watch?v=${t.id}`, lyrics: lrc || undefined, encoder: 'BitChord Desktop' }, cover);
  }

  const folder = dir();
  fs.mkdirSync(folder, { recursive: true });
  let base = safe(`${t.artists?.[0]?.name ? t.artists[0].name + ' - ' : ''}${t.title}`);
  let file = path.join(folder, `${base}.${ext}`);
  for (let i = 2; fs.existsSync(file); i++) file = path.join(folder, `${base} (${i}).${ext}`);
  fs.writeFileSync(file, data);
  let offlineThumb = null;
  if (cover && cover.mime === 'image/jpeg') {
    try { fs.mkdirSync(coverDir, { recursive: true }); fs.writeFileSync(path.join(coverDir, t.id + '.jpg'), cover.data); offlineThumb = true; } catch {}
  }
  let lrcPath = null;
  if (lrc) { lrcPath = file.replace(/\.[^.]+$/, '.lrc'); fs.writeFileSync(lrcPath, lrc); }

  index[t.id] = {
    id: t.id, path: file, lrc: lrcPath, format: ext, codec: stream.codec, bitrate: stream.bitrate, size: data.length, at: Date.now(),
    offlineThumb,
    track: { ...t, downloaded: true },
  };
  save();
  jobs.delete(t.id);
  emit();
}

export function mimeFor(file) {
  const e = path.extname(file).toLowerCase();
  return { '.opus': 'audio/ogg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.aac': 'audio/aac', '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav', '.webm': 'audio/webm', '.weba': 'audio/webm' }[e] || 'application/octet-stream';
}
