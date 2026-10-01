// Local media server on 127.0.0.1:
//   /stream/<videoId>  YouTube audio (or the downloaded file, if there is one), with Range support
//   /local/<id>        a file from the local library
//   /cover/<id>        embedded cover of a local file;  /dlcover/<id> cover saved with a download
//   /img?u=<url>       artwork with CORS headers (for colour extraction)
// googlevideo is fetched in small ranges with the headers of the client that minted the URL
// (what BitChord's ExoPlayer data source does), re-resolving if a URL dies mid-song.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { resolveStream, markRefused } from './yt.js';
import * as settings from './settings.js';
import * as downloads from './downloads.js';
import * as local from './local.js';
import * as webdav from './sources/webdav.js';
import * as sources from './sources/index.js';
import { coverPath as playlistCoverPath } from './playlists.js';
import { serveVisualizer } from './vis-files.js';

const ALLOWED_IMG = /(^|\.)(googleusercontent\.com|ggpht\.com|ytimg\.com|lrclib\.net)$/;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges' };
let coverDir = null;

export function startProxy({ userData } = {}) {
  if (userData) coverDir = path.join(userData, 'covers');
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      const [, kind, id] = u.pathname.split('/');
      if (req.method === 'OPTIONS') return res.writeHead(204, { ...CORS, 'Access-Control-Allow-Headers': 'Range' }).end();
      if (kind === 'stream') {
        const file = downloads.localPath(id);
        if (file) return serveFile(file, req, res);
        const meta = { title: u.searchParams.get('t') || '', artist: u.searchParams.get('a') || '', duration: +u.searchParams.get('d') || 0 };
        return await serveStream(id, req, res, meta);
      }
      if (kind === 'webdav' || kind === 'webdavcover') {
        const src = webdav.source(id, kind === 'webdavcover');
        return src ? await servePassthrough(src, req, res) : res.writeHead(404, CORS).end();
      }
      if (kind === 'local') { const p = local.pathFor(id); return p ? serveFile(p, req, res) : res.writeHead(404, CORS).end(); }
      if (kind === 'cover') {
        const c = await local.cover(id);
        if (!c) return res.writeHead(404, CORS).end();
        res.writeHead(200, { ...CORS, 'Content-Type': c.mime, 'Cache-Control': 'max-age=86400' });
        return res.end(c.data);
      }
      if (kind === 'plcover') {
        const p = playlistCoverPath(id);
        if (!fs.existsSync(p)) return res.writeHead(404, CORS).end();
        res.writeHead(200, { ...CORS, 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=31536000' });
        return fs.createReadStream(p).pipe(res);
      }
      if (kind === 'dlcover') {
        const p = coverDir && path.join(coverDir, id.replace(/[^\w-]/g, '') + '.jpg');
        if (!p || !fs.existsSync(p)) return res.writeHead(404, CORS).end();
        res.writeHead(200, { ...CORS, 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=86400' });
        return fs.createReadStream(p).pipe(res);
      }
      if (u.pathname === '/img') return await serveImage(u.searchParams.get('u'), res);
      if (serveVisualizer(u.pathname, res)) return;
      res.writeHead(404, CORS).end();
    } catch (e) {
      console.error('[proxy]', req.url, e?.message || e);
      if (!res.headersSent) res.writeHead(502, { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(String(e?.message || e));
    }
  });
  const listen = (port) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(server.address().port); });
  });
  // A fixed port keeps saved artwork/stream URLs valid between runs; fall back to any free one.
  return listen(47831).catch(() => listen(0)).then((port) => ({ server, port }));
}

function drained(res) {
  return new Promise((ok) => {
    const done = () => { res.off('drain', done); res.off('close', done); ok(); };
    res.on('drain', done); res.on('close', done);
  });
}

export const coverPath = (id) => coverDir && path.join(coverDir, id + '.jpg');

async function serveImage(src, res) {
  if (!src) return res.writeHead(400, CORS).end();
  const host = new URL(src).hostname;
  if (!ALLOWED_IMG.test(host)) return res.writeHead(403, CORS).end();
  const r = await fetch(src);
  const buf = Buffer.from(await r.arrayBuffer());
  res.writeHead(r.status, { ...CORS, 'Content-Type': r.headers.get('content-type') || 'image/jpeg', 'Cache-Control': 'max-age=86400' });
  res.end(buf);
}

function parseRange(header, size) {
  let start = 0, end = size - 1;
  const m = header && /bytes=(\d*)-(\d*)/.exec(header);
  if (m) {
    if (m[1]) start = parseInt(m[1], 10);
    else if (m[2]) { start = Math.max(0, size - parseInt(m[2], 10)); }
    if (m[1] && m[2]) end = Math.min(parseInt(m[2], 10), size - 1);
  }
  return { start, end, partial: !!m };
}

function serveFile(file, req, res) {
  const size = fs.statSync(file).size;
  const { start, end, partial } = parseRange(req.headers.range, size);
  if (start >= size) return res.writeHead(416, { ...CORS, 'Content-Range': `bytes */${size}` }).end();
  res.writeHead(partial ? 206 : 200, {
    ...CORS, 'Content-Type': downloads.mimeFor(file), 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
    ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file, { start, end }).pipe(res);
}

async function servePassthrough(src, req, res) {
  const headers = { ...src.headers };
  if (req.headers.range) headers.Range = req.headers.range;
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  const r = await fetch(src.url, { headers, signal: abort.signal });
  const out = { ...CORS };
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) { const v = r.headers.get(h); if (v) out[h] = v; }
  if (!out['accept-ranges']) out['accept-ranges'] = 'bytes';
  res.writeHead(r.status, out);
  if (req.method === 'HEAD' || !r.body) return res.end();
  try { for await (const c of r.body) { if (!res.write(Buffer.from(c))) await drained(res); } } catch {}
  res.end();
}

async function serveStream(videoId, req, res, meta = {}) {
  if (!/^[\w-]{11}$/.test(videoId)) return res.writeHead(400, CORS).end();
  const opts = { maxKbps: settings.maxKbps(settings.get('streamQuality')) };
  let stream = (await sources.override(videoId, meta).catch(() => null)) || await resolveStream(videoId, opts);
  sources.noteUsed(videoId, stream);
  const { start, end, partial } = parseRange(req.headers.range, stream.size);
  if (start > end || start >= stream.size) {
    return res.writeHead(416, { ...CORS, 'Content-Range': `bytes */${stream.size}` }).end();
  }
  res.writeHead(partial ? 206 : 200, {
    ...CORS,
    'Content-Type': stream.mime,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${stream.size}` } : {}),
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') return res.end();

  const abort = new AbortController();
  let closed = false;
  res.on('close', () => { closed = true; abort.abort(); });

  let pos = start;
  let switches = 0, netRetries = 0;
  // A URL can be refused mid-song (googlevideo's ~1 MiB authorisation boundary): bench that
  // client for this track, mint the *same* format from another client and carry on from the same byte.
  const switchClient = async (why) => {
    if (closed || switches >= 3) return false;
    switches++;
    if (stream.clientName === 'JIOSAAVN') { sources.invalidate(videoId); return false; }
    markRefused(videoId, stream.clientName);
    console.warn(`[proxy] ${videoId}: ${why} en ${pos}/${stream.size}; cambiando de cliente`);
    const next = await resolveStream(videoId, { ...opts, fresh: true, itag: stream.itag }).catch((e) => { console.warn('[proxy]', e.message); return null; });
    if (!next || next.size !== stream.size) return false;
    stream = next;
    return true;
  };
  while (pos <= end && !closed) {
    const chunkEnd = Math.min(pos + stream.chunk - 1, end);
    let r = null;
    try {
      r = await fetch(stream.url, { headers: { ...stream.headers, Range: `bytes=${pos}-${chunkEnd}` }, signal: abort.signal, redirect: 'follow' });
    } catch {
      if (closed) return;
      if (++netRetries <= 3) { await new Promise((ok) => setTimeout(ok, 400 * netRetries)); continue; }
      res.destroy(); return;
    }
    if (r.status !== 206) {
      try { await r.arrayBuffer(); } catch {}
      if (await switchClient(`HTTP ${r.status}`)) continue;
      res.destroy(); return;
    }
    try {
      for await (const chunk of r.body) {
        if (closed) return;
        const buf = Buffer.from(chunk);
        pos += buf.length;
        if (!res.write(buf)) await drained(res);
      }
      netRetries = 0;
    } catch {
      if (closed) return;
      if (++netRetries > 3) { res.destroy(); return; }
    }
  }
  res.end();
}
