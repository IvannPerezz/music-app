// JioSaavn source (port of BitChord's JioSaavnSource/JioSaavnService): when enabled, a YouTube
// Music track that has a confident match on JioSaavn plays from there (AAC up to 320 kbps).
// JioSaavn only serves its catalogue in some regions; elsewhere it simply finds nothing and
// YouTube Music is used.
import crypto from 'node:crypto';

const BASE = 'https://www.jiosaavn.com/api.php';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const matchCache = new Map(); // videoId -> {id, title, kbps} | null

async function call(params) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 6000);
  try {
    const q = new URLSearchParams({ _format: 'json', _marker: '0', api_version: '4', ctx: 'android', ...params });
    const r = await fetch(`${BASE}?${q}`, { headers: { Accept: 'application/json', 'User-Agent': UA, Cookie: 'explicit_content=1' }, signal: ctl.signal });
    if (!r.ok) throw new Error(`JioSaavn HTTP ${r.status}`);
    return JSON.parse(await r.text());
  } finally { clearTimeout(t); }
}

function decrypt(enc) {
  if (!enc) return '';
  try {
    const d = crypto.createDecipheriv('des-ecb', Buffer.from('38346591'), null);
    return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8').trim();
  } catch (e) { console.warn('[jiosaavn] decrypt', e.message); return ''; }
}

function bestUrl(url, has320) {
  const m = /_(48|96|160|320)\.(mp4|aac|mp3)(?=[?#]|$)/i.exec(url);
  if (!m) return { url, kbps: null };
  if (!has320) return { url, kbps: +m[1] };
  return { url: url.slice(0, m.index) + `_320.${m[2]}` + url.slice(m.index + m[0].length), kbps: 320 };
}

const norm = (s) => String(s || '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\(.*?\)|\[.*?\]/g, ' ')
  .replace(/\b(feat|ft|with|remaster(ed)?|version|official|audio|video|lyrics?)\b.*$/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ').trim();

function similar(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85;
  const A = new Set(a.split(' ')), B = new Set(b.split(' '));
  const inter = [...A].filter((x) => B.has(x)).length;
  return inter / Math.max(A.size, B.size);
}

export async function search(query) {
  const r = await call({ __call: 'search.getResults', q: query, p: '1', n: '10' });
  return (r.results || []).map((x) => ({
    id: x.id,
    title: x.title,
    artist: (x.more_info?.artistMap?.primary_artists || []).map((a) => a.name).join(', '),
    album: x.more_info?.album || '',
    duration: parseInt(x.more_info?.duration, 10) || 0,
    image: String(x.image || '').replace(/150x150|50x50/, '500x500').replace(/^http:/, 'https:'),
  }));
}

/** Finds the same recording on JioSaavn, or null. Strict on duration so a live/remix edit isn't picked. */
export async function match(track) {
  if (matchCache.has(track.id)) return matchCache.get(track.id);
  let found = null;
  try {
    const artist = (track.artists || [])[0]?.name || '';
    const results = await search(`${track.title} ${artist}`);
    let best = null, bestScore = 0;
    for (const r of results) {
      if (track.duration && r.duration && Math.abs(r.duration - track.duration) > 3) continue;
      const score = similar(r.title, track.title) * 0.6 + similar(r.artist, artist) * 0.4;
      if (score > bestScore) { bestScore = score; best = r; }
    }
    if (best && bestScore >= 0.75) found = best;
  } catch (e) { console.warn('[jiosaavn] match', e.message); }
  matchCache.set(track.id, found);
  return found;
}

export async function streamFor(saavnId) {
  const r = await call({ __call: 'song.getDetails', pids: saavnId });
  const song = r.songs?.[0] || Object.values(r).find((v) => v && typeof v === 'object' && v.more_info);
  if (!song) return null;
  const url = decrypt(song.more_info?.encrypted_media_url);
  if (!url) return null;
  const s = bestUrl(url, String(song.more_info?.['320kbps']).toLowerCase() === 'true');
  if (s.kbps && s.kbps <= 96) return null;
  // Probe and get the size.
  const head = await fetch(s.url, { headers: { Range: 'bytes=0-1', 'User-Agent': UA } });
  try { await head.arrayBuffer(); } catch {}
  if (head.status !== 206 && head.status !== 200) return null;
  const size = parseInt((head.headers.get('content-range') || '').split('/')[1], 10) || null;
  if (!size) return null;
  return { url: s.url, headers: { 'User-Agent': UA }, size, chunk: 1024 * 1024, mime: 'audio/mp4', codec: 'aac', bitrate: s.kbps || 160, client: 'JioSaavn', clientName: 'JIOSAAVN', itag: null, loudnessDb: null };
}
