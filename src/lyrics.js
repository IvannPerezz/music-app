// Lyrics providers (ported from BitChord's data/lyrics). Main process only fetches;
// the renderer parses (it has DOMParser for TTML) and walks the user's provider order.

import { ytLyrics } from './yt.js';
import * as spotifyWeb from './spotify-web.js';
import * as settings from './settings.js';

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

// NetEase Cloud Music: word by word (its "yrc" karaoke format) for a large catalogue, no account.
// Some lyrics there come censored (words replaced by asterisks).
const NE_HEADERS = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://music.163.com/' };
async function neGet(url) {
  try { const r = await fetch(url, { headers: NE_HEADERS, signal: AbortSignal.timeout(TIMEOUT) }); return r.ok ? await r.json() : null; }
  catch { return null; }
}
async function netease(t) {
  const r = await neGet(`https://music.163.com/api/search/get?${qs({ s: `${t.title} ${t.artist}`, type: 1, limit: 10 })}`);
  const title = norm(t.title), artist = norm(t.artist);
  const song = (r?.result?.songs || []).find((x) => {
    if (norm(x.name) !== title) return false;
    const off = t.duration && x.duration ? Math.abs(x.duration / 1000 - t.duration) : 0;
    const who = (x.artists || []).map((a) => norm(a.name));
    return off <= 5 && (who.some((a) => a && (a.includes(artist) || artist.includes(a))) || (t.duration && off <= 2));
  });
  if (!song) return null;
  const l = await neGet(`https://music.163.com/api/song/lyric/v1?${qs({ id: song.id, lv: -1, kv: -1, tv: -1, yv: -1 })}`);
  const yrc = (l?.yrc?.lyric || '').split('\n').filter((x) => /^\[\d+,\d+\]/.test(x)).join('\n');
  if (yrc) return { format: 'provider', data: yrc };
  return l?.lrc?.lyric ? { format: 'lrc', data: l.lrc.lyric } : null;
}

// The song on Spotify (for Spotify's own lyrics and Spicy Lyrics), found with the Spotify session
// that "Importar de Spotify" signs in. Without that session these two sources are skipped.
const spCache = new Map();
// The web player's own search (GraphQL "searchTopResultsList"): Spotify's public search API
// answers 429 to the web player's token. The query's hash is the one the web player itself was seen
// using, or else the one it used in October 2026.
const SEARCH_HASH = 'dd78eaff943eba629ed70ee25517b9cea0dcaa41193e2592ae2727660b21892c';
async function spotifyTrack(t) {
  if (spCache.has(t.videoId)) return spCache.get(t.videoId);
  if (!(await spotifyWeb.signedIn().catch(() => false))) return null;
  let hit = null;
  try {
    const tok = await spotifyWeb.token();
    const r = await fetch('https://api-partner.spotify.com/pathfinder/v2/query', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + tok.bearer, ...(tok.clientToken ? { 'client-token': tok.clientToken } : {}), 'app-platform': 'WebPlayer',
        Accept: 'application/json', 'Content-Type': 'application/json;charset=UTF-8', Origin: 'https://open.spotify.com', Referer: 'https://open.spotify.com/',
      },
      body: JSON.stringify({
        operationName: 'searchTopResultsList',
        variables: { query: `${t.title} ${t.artist}`, limit: 10, offset: 0, numberOfTopResults: 10, includeArtistHasConcertsField: false, includeAudiobooks: false, includeAuthors: false, includePreReleases: false, includeAlbumPreReleases: false, includeEpisodeContentRatingsV2: false, isPrefix: null, sectionFilters: ['GENERIC'] },
        extensions: { persistedQuery: { version: 1, sha256Hash: spotifyWeb.seenOps.get('searchTopResultsList') || SEARCH_HASH } },
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!r.ok) { console.warn('[lyrics] búsqueda en Spotify:', r.status); return null; }
    const sv = (await r.json())?.data?.searchV2;
    const found = [...(sv?.topResultsV2?.itemsV2 || []), ...(sv?.tracksV2?.items || [])]
      .map((x) => x.item?.data).filter((d) => d?.__typename === 'Track' && d.id)
      .map((d) => ({ id: d.id, name: d.name, artists: (d.artists?.items || []).map((a) => a.profile?.name || ''), secs: (d.duration?.totalMilliseconds || 0) / 1000 }));
    const title = norm(t.title), artist = norm(t.artist);
    const off = (x) => (t.duration && x.secs ? Math.abs(x.secs - t.duration) : 0);
    const byArtist = (x) => x.artists.some((a) => { a = norm(a); return a && (a.includes(artist) || artist.includes(a)); });
    hit = found.filter((x) => off(x) <= 5 && (norm(x.name) === title || byArtist(x)))
      .sort((a, b) => (norm(b.name) === title) - (norm(a.name) === title) || byArtist(b) - byArtist(a) || off(a) - off(b))[0] || null;
  } catch (e) { console.warn('[lyrics] búsqueda en Spotify:', e?.message); return null; }
  const out = hit ? { id: hit.id } : null;
  spCache.set(t.videoId, out);
  return out;
}

// Spotify's own lyrics (Musixmatch's licensed catalogue): mostly by lines, some by syllables.
async function musixmatch(t) {
  const sp = await spotifyTrack(t);
  if (!sp) return null;
  const tok = await spotifyWeb.token();
  const r = await fetch(`https://spclient.wg.spotify.com/color-lyrics/v2/track/${sp.id}?format=json&vocalRemoval=false&market=from_token`, {
    headers: { Authorization: 'Bearer ' + tok.bearer, ...(tok.clientToken ? { 'client-token': tok.clientToken } : {}), 'app-platform': 'WebPlayer', Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT),
  }).catch(() => null);
  if (!r?.ok) { if (r && r.status !== 404) console.warn('[lyrics] letra de Spotify:', r.status); return null; }
  const l = (await r.json().catch(() => null))?.lyrics;
  if (!l?.lines?.length) return null;
  if (l.syncType === 'UNSYNCED') return { format: 'plain', data: l.lines.map((x) => x.words).join('\n') };
  const lines = l.lines.map((x, i) => {
    const time = +x.startTimeMs / 1000, text = String(x.words || '').trim();
    if (!text || text === '♪') return null;
    const next = l.lines[i + 1] ? +l.lines[i + 1].startTimeMs / 1000 : time + 5;
    const syl = (x.syllables || []).filter((y) => y.startTimeMs != null && y.numChars > 0);
    if (!syl.length) return { time, text };
    // Syllables: a start time and how many characters of the line each one covers.
    const words = [];
    let pos = 0, open = false;
    syl.forEach((y, k) => {
      const piece = String(x.words).slice(pos, pos + y.numChars);
      pos += y.numChars;
      const start = +y.startTimeMs / 1000, end = syl[k + 1] ? +syl[k + 1].startTimeMs / 1000 : next;
      const bit = piece.trim();
      if (!bit) { open = false; return; }
      const part = { start, end, len: [...bit].length };
      const last = words[words.length - 1];
      if (open && last && !/^\s/.test(piece)) { last.text += bit; last.end = end; last.parts.push(part); }
      else words.push({ start, end, text: bit, parts: [part] });
      open = !/\s$/.test(piece);
    });
    return words.length ? { time: Math.min(time, words[0].start), text: words.map((w) => w.text).join(' '), words } : { time, text };
  }).filter(Boolean);
  return lines.length ? { format: 'lines', data: lines } : null;
}

// Spicy Lyrics: needs a key of the user's own (developers.spicylyrics.org) and the song's Spotify id.
async function spicy(t) {
  const key = String(settings.get('spicyLyricsKey') || '').trim();
  if (!key) return null;
  const sp = await spotifyTrack(t);
  if (!sp) return null;
  const r = await fetch(`https://api.spicylyrics.org/v1/lyrics/${sp.id}`, { headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT) }).catch(() => null);
  if (!r?.ok) { if (r) console.warn('[lyrics] Spicy Lyrics respondió', r.status); return null; }
  const j = await r.json().catch(() => null);
  const b = j?.Body || j;
  if (!b) return null;
  // Their terms: always name the source and, when given, credit and link who uploaded and who made the sync.
  const who = (u) => (u?.username ? { name: u.username, url: u.url || '' } : null);
  const attribution = { source: b.source || '', via: b.source_via || '', uploader: who(b.UploadAttribution?.Uploader), maker: who(b.UploadAttribution?.Maker) };
  // Times are numbers whose unit the docs don't state: seconds, unless they're clearly milliseconds.
  const stamps = (JSON.stringify(b.Content || []).match(/"(?:Start|End)Time":\s*[\d.]+/g) || []).map((m) => parseFloat(m.split(':')[1]));
  const ms = stamps.some((v) => v > 36000);
  const sec = (v) => (v == null ? null : ms ? +v / 1000 : +v);
  if (b.Type === 'Static') { const text = (b.Lines || []).map((x) => x.Text).join('\n').trim(); return text ? { format: 'plain', data: text, attribution } : null; }
  const syllWords = (syls) => {
    const words = [];
    let cur = null;
    for (const y of syls || []) {
      const text = String(y.Text || '').trim(), start = sec(y.StartTime), end = sec(y.EndTime);
      if (!text || start == null) continue;
      if (!cur) { cur = { start, end, text: '', parts: [] }; words.push(cur); }
      cur.text += text; cur.end = end; cur.parts.push({ start, end, len: [...text].length });
      if (!y.IsPartOfWord) cur = null;
    }
    return words;
  };
  const lines = [];
  for (const c of b.Content || []) {
    if (b.Type === 'Line') {
      const text = String(c.Text || '').trim();
      if (text) lines.push({ time: sec(c.StartTime), text, end: sec(c.EndTime), ...(c.OppositeAligned ? { align: 'end' } : {}) });
      continue;
    }
    const words = syllWords(c.Lead?.Syllables);
    if (!words.length) continue;
    const line = { time: Math.min(sec(c.Lead.StartTime) ?? words[0].start, words[0].start), text: words.map((w) => w.text).join(' '), words };
    if (c.OppositeAligned) line.align = 'end';
    const bgw = (c.Background || []).flatMap((x) => syllWords(x.Syllables));
    if (bgw.length) line.bg = { time: bgw[0].start, text: bgw.map((w) => w.text).join(' '), words: bgw };
    lines.push(line);
  }
  return lines.length ? { format: 'lines', data: lines, attribution } : null;
}

/** Tries a Spicy Lyrics key on a song it's known to have: { ok, why? } (why: origin | key | limit | net). */
export async function testSpicy(key) {
  key = String(key || '').trim();
  if (!key) return { ok: false, why: 'empty' };
  try {
    const r = await fetch('https://api.spicylyrics.org/v1/lyrics/3Gfs29GWViOqUnHSBq911p', { headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT) });
    if (r.ok || r.status === 404) return { ok: true };
    const err = (await r.json().catch(() => null))?.Body?.error || '';
    if (r.status === 403 && /origin/i.test(err)) return { ok: false, why: 'origin' };
    if (r.status === 401 || r.status === 403) return { ok: false, why: 'key' };
    if (r.status === 429) return { ok: false, why: 'limit' };
    return { ok: false, why: 'net', status: r.status };
  } catch { return { ok: false, why: 'net' }; }
}

async function youtube(t) {
  const y = await ytLyrics(t.videoId);
  return y?.text ? { format: 'plain', data: y.text, credit: y.source } : null;
}

export const PROVIDERS = {
  lrclib, kugou, simpmusic, unison, youtube, lyricsplus, binilyrics, netease, musixmatch, spicy,
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
