// Lyrics providers (ported from BitChord's data/lyrics). Main process only fetches;
// the renderer parses (it has DOMParser for TTML) and walks the user's provider order.

import { ytLyrics } from './yt.js';

const AGENT = 'BitChord (https://github.com/bitchord)';
const TIMEOUT = 7000;

async function get(url, { json = false } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': AGENT, Accept: 'application/json, text/plain, */*' }, signal: ctl.signal });
    if (!r.ok) return null;
    return json ? await r.json() : await r.text();
  } catch { return null; }
  finally { clearTimeout(t); }
}

const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();

const cleanTitle = (s) => String(s || '')
  .replace(/\s*[\(\[](?:official|video|audio|lyric|lyrics|visualizer|remaster(?:ed)?|explicit|letra|mv|m\/v)[^\)\]]*[\)\]]/gi, '')
  .replace(/\s+-\s+topic$/i, '')
  .trim();

function info(track) {
  return {
    title: cleanTitle(track.title),
    artist: cleanTitle((track.artists || []).map((a) => a.name)[0] || ''),
    album: track.album?.name || '',
    duration: Math.round(track.duration || 0),
    videoId: track.id,
  };
}

// ---- providers: each returns {format, data} or null
// formats: 'lrc' | 'elrc' | 'ttml' | 'lyricsplus' | 'provider' (auto-detect) | 'plain'

async function lrclib(t) {
  let hit = await get(`https://lrclib.net/api/get?${qs({ track_name: t.title, artist_name: t.artist, album_name: t.album, duration: t.duration || undefined })}`, { json: true });
  if (!hit || (!hit.syncedLyrics && !hit.plainLyrics && !hit.instrumental)) {
    const res = await get(`https://lrclib.net/api/search?${qs({ track_name: t.title, artist_name: t.artist })}`, { json: true });
    if (Array.isArray(res) && res.length) {
      const close = (r) => !t.duration || !r.duration || Math.abs(r.duration - t.duration) <= 4;
      hit = res.find((r) => r.syncedLyrics && close(r)) || res.find((r) => r.plainLyrics && close(r)) || null;
    }
  }
  if (!hit) return null;
  if (hit.instrumental) return { format: 'plain', data: '♪ Instrumental ♪' };
  if (hit.syncedLyrics) return { format: 'lrc', data: hit.syncedLyrics };
  if (hit.plainLyrics) return { format: 'plain', data: hit.plainLyrics };
  return null;
}

async function kugou(t) {
  const strip = (s) => s.replace(/[(（].*?[)）]/g, '').trim() || s;
  const keyword = `${strip(t.title)} - ${strip(t.artist)}${t.album ? ' ' + t.album : ''}`;
  const songs = await get(`https://mobileservice.kugou.com/api/v3/search/song?${qs({ version: 9108, plat: 0, pagesize: 8, showtype: 0, keyword })}`, { json: true });
  const hashes = (songs?.data?.info || [])
    .filter((i) => !t.duration || Math.abs((i.duration || -1) - t.duration) <= 8)
    .sort((a, b) => Math.abs(a.duration - t.duration) - Math.abs(b.duration - t.duration))
    .map((i) => i.hash);
  let cand = null;
  for (const hash of hashes) {
    const r = await get(`https://lyrics.kugou.com/search?${qs({ ver: 1, man: 'yes', client: 'pc', hash })}`, { json: true });
    cand = r?.candidates?.[0];
    if (cand) break;
  }
  if (!cand) {
    const r = await get(`https://lyrics.kugou.com/search?${qs({ ver: 1, man: 'yes', client: 'pc', keyword, duration: t.duration ? t.duration * 1000 : undefined })}`, { json: true });
    cand = r?.candidates?.[0];
  }
  if (!cand) return null;
  const dl = await get(`https://lyrics.kugou.com/download?${qs({ fmt: 'lrc', charset: 'utf8', client: 'pc', ver: 1, id: cand.id, accesskey: cand.accesskey })}`, { json: true });
  if (!dl?.content) return null;
  let lrc = Buffer.from(dl.content, 'base64').toString('utf8');
  // Drop the credit lines KuGou puts at both ends ("作词：…").
  const stamped = lrc.split(/\r?\n/).filter((l) => /^\[\d{2}:\d{2}\.\d{2,3}].*/.test(l));
  const credit = /.+][^\[]+[:：].+/;
  let head = 0;
  for (let i = Math.min(30, stamped.length - 1); i >= 0; i--) if (credit.test(stamped[i])) { head = i + 1; break; }
  let body = stamped.slice(head);
  let tail = 0;
  for (let i = 0; i <= Math.min(30, body.length - 1); i++) if (credit.test(body[body.length - 1 - i])) { tail = i + 1; break; }
  body = body.slice(0, body.length - tail);
  lrc = body.join('\n');
  return lrc ? { format: 'lrc', data: lrc } : null;
}

async function simpmusic(t) {
  if (!t.videoId) return null;
  const r = await get(`https://api-lyrics.simpmusic.org/v1/${encodeURIComponent(t.videoId)}`, { json: true });
  if (!r?.success) return null;
  const tr = (r.data || [])
    .filter((x) => !t.duration || Math.abs((x.duration || 0) - t.duration) <= 10)
    .sort((a, b) => Math.abs((a.duration || 0) - t.duration) - Math.abs((b.duration || 0) - t.duration))[0];
  if (!tr) return null;
  if (tr.richSyncLyrics) return { format: 'elrc', data: tr.richSyncLyrics, fallback: tr.syncedLyrics ? { format: 'lrc', data: tr.syncedLyrics } : null };
  if (tr.syncedLyrics) return { format: 'lrc', data: tr.syncedLyrics };
  if (tr.plainLyrics) return { format: 'plain', data: tr.plainLyrics };
  return null;
}

const betterlyrics = (endpoint) => async (t) => {
  const raw = await get(`${endpoint}?${qs({ s: t.title, a: t.artist, d: t.duration || undefined, al: t.album })}`);
  return raw ? { format: 'provider', data: raw } : null;
};

const LP_MIRRORS = [
  'https://lyricsplus.prjktla.my.id', 'https://lyricsplus.atomix.one', 'https://lyricsplus.binimum.org',
  'https://lyricsplus.prjktla.workers.dev', 'https://lyricsplus-seven.vercel.app', 'https://lyrics-plus-backend.vercel.app',
];
let lpLastGood = null;
async function lyricsplus(t) {
  const hosts = lpLastGood ? [lpLastGood, ...LP_MIRRORS.filter((m) => m !== lpLastGood)] : LP_MIRRORS;
  const query = qs({ title: t.title, artist: t.artist, duration: t.duration || undefined, album: t.album });
  // Race the mirrors; first non-empty answer wins.
  return new Promise((resolve) => {
    let pending = hosts.length;
    hosts.forEach((host) => {
      get(`${host}/v2/lyrics/get?${query}`, { json: true }).then((r) => {
        if (r && Array.isArray(r.lyrics) && r.lyrics.length) { lpLastGood = host; resolve({ format: 'lyricsplus', data: r }); }
        else if (--pending === 0) resolve(null);
      });
    });
  });
}

async function unison(t) {
  const r = await get(`https://unison.boidu.dev/lyrics?${qs({ song: t.title, artist: t.artist, album: t.album, duration: t.duration || undefined })}`, { json: true });
  const d = r?.success ? r.data : null;
  if (!d?.lyrics) return null;
  if (String(d.format).toLowerCase() === 'ttml') return { format: 'ttml', data: d.lyrics };
  if (String(d.syncType).toLowerCase() === 'plain') return { format: 'plain', data: d.lyrics };
  return { format: 'elrc', data: d.lyrics, fallback: { format: 'lrc', data: d.lyrics } };
}

// BiniLyrics (lyrics-api.binimum.org, now served by lrc.red): Apple Music TTML, word by word for most
// songs. The search returns every release of the song; take the one with the finest timing whose
// title, artist and length match.
const norm = (s) => String(s || '').toLowerCase()
  .replace(/\s*[\(\[][^\)\]]*[\)\]]/g, '').replace(/\s+-\s+.*$/, '').replace(/\b(feat|ft)\..*$/, '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
async function binilyrics(t) {
  const r = await get(`https://lrc.red/api/v1?${qs({ track: t.title, artist: t.artist })}`, { json: true });
  const title = norm(t.title), artist = norm(t.artist);
  const rank = { word: 0, syllable: 0, line: 1 };
  const hit = (r?.results || [])
    .filter((x) => x.lyricsUrl && x.timing_type in rank && norm(x.track_name) === title)
    .filter((x) => {
      const a = norm(x.artist_name), off = t.duration && x.duration ? Math.abs(x.duration - t.duration) : 0;
      // Some releases spell the artist in another script (カロルG): then the length alone must match.
      return off <= 8 && (a.includes(artist) || artist.includes(a) || (t.duration && off <= 3));
    })
    .sort((a, b) => rank[a.timing_type] - rank[b.timing_type] || Math.abs((a.duration || 0) - t.duration) - Math.abs((b.duration || 0) - t.duration))[0];
  if (!hit) return null;
  const ttml = await get(hit.lyricsUrl);
  return ttml && ttml.includes('<tt') ? { format: 'ttml', data: ttml } : null;
}

async function youtube(t) {
  const y = await ytLyrics(t.videoId);
  return y?.text ? { format: 'plain', data: y.text, credit: y.source } : null;
}

export const PROVIDERS = {
  lrclib, kugou, simpmusic, unison, youtube, lyricsplus, binilyrics,
  betterlyrics: betterlyrics('https://lyrics-api.boidu.dev/getLyrics'),
  betterlyrics_qq: betterlyrics('https://lyrics-api.boidu.dev/qq/getLyrics'),
};

const cache = new Map();
export async function fetchLyrics(track, providerId) {
  const fn = PROVIDERS[providerId];
  if (!fn) throw new Error('Proveedor de letras desconocido: ' + providerId);
  const key = providerId + '|' + track.id;
  if (cache.has(key)) return cache.get(key);
  let res = null;
  try { res = await fn(info(track)); } catch (e) { console.warn('[lyrics]', providerId, e?.message); }
  if (cache.size > 400) cache.clear();
  cache.set(key, res);
  return res;
}
