// Animated covers: the looping video some releases have instead of a still sleeve (Apple Music's
// "motion artwork", Tidal's video covers). Ported from BitChord for Android (data/canvas/*).
//
// Three public sources, asked in turn: Apple Music (most coverage), Tidal, and a community index
// that reaches older records. Spotify's Canvas is left out: it needs the listener's own Spotify
// web session. None of these hosts are ours and all of them will happily answer a search with the
// wrong record, so every answer is checked against what's playing, and any failure is simply "no
// animated cover": the still artwork is always there underneath.
import { tr } from './i18n.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
let country = 'us';
export function configure({ countryCode } = {}) {
  if (/^[a-z]{2}$/i.test(countryCode || '')) country = countryCode.toLowerCase();
}

const get = async (url, headers = {}) => {
  const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(12000) });
  return r;
};

// ---------------------------------------------------------------- matching
/** Case, accents and punctuation differ between services for the same release: fold them away. */
const norm = (s) => String(s || '').normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
/** One credit into its artists: every service has its own separator. */
const splitArtists = (s) => String(s || '').split(/\s*,\s*|\s*&\s*|\s+×\s+|\s+x\s+|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b|\bwith\b/i).map(norm).filter(Boolean);
/** YouTube titles carry packaging the catalogues never see ("| Official Video", [tags]…). */
const clean = (s) => String(s || '').replace(/\((?:from|official|lyrical|video|audio)[^)]*\)|\[[^\]]*]|\b(?:official (?:video|audio|music video)|lyrical|full song|4k video)\b/gi, ' ')
  .split(' | ')[0].replace(/\s+/g, ' ').trim() || String(s || '');
// The main artist has to be credited: guests are often only in the title on the other side
// (YouTube credits «Taylor Swift, Post Malone», Apple «Taylor Swift» + «(feat. Post Malone)»).
const mainCredited = (want, got) => { const w = splitArtists(want), g = splitArtists(got); return !!(w.length && g.length && g.includes(w[0])); };
const COMPILATION = ['playlist', 'set list', 'essentials', 'dj mix', 'mixed', 'apple music', "today's hits", 'session'];
const isCompilation = (name) => COMPILATION.some((m) => String(name || '').toLowerCase().includes(m));

// ---------------------------------------------------------------- Apple Music
// Needs the read-only token the web player mints for anonymous visitors: read from its JS bundle,
// the way the browser gets it, and kept until shortly before it expires.
const AMP = 'https://amp-api.music.apple.com/v1/catalog';
let apple = { token: null, until: 0, retryAt: 0, rejected: new Set() };

async function appleToken() {
  const now = Date.now();
  if (apple.token && now < apple.until - 60e3) return apple.token;
  if (now < apple.retryAt) return null;
  try {
    const html = await (await get('https://music.apple.com/us/browse')).text();
    const scripts = [...new Set(html.match(/\/assets\/index(?:-legacy)?[~-][A-Za-z0-9_-]+\.js/g) || [])];
    for (const p of scripts) {
      const js = await (await get('https://music.apple.com' + p)).text();
      const jwts = [...new Set(js.match(/ey[A-Za-z0-9_-]+\.ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) || [])].filter((j) => !apple.rejected.has(j));
      const read = (j) => { try { const [h, b] = j.split('.').slice(0, 2).map((x) => Buffer.from(x, 'base64url').toString()); return { h, b, exp: +(/"exp"\s*:\s*(\d+)/.exec(b)?.[1] || 0) * 1000 }; } catch { return null; } };
      const cands = jwts.map((j) => ({ j, ...read(j) })).filter((c) => c.exp > now);
      const pick = cands.find((c) => c.h.includes('WebPlayKid') || c.b.includes('AMPWebPlay')) || cands[0];
      if (pick) { apple.token = pick.j; apple.until = pick.exp; return pick.j; }
    }
  } catch (e) { console.error('[canvas] token de Apple:', e?.message || e); }
  apple.retryAt = now + 30 * 60e3; // Apple changed the page: don't hammer it on every song
  return null;
}

async function appleGet(url, token) {
  const r = await get(url, { Authorization: 'Bearer ' + token, Origin: 'https://music.apple.com', Referer: 'https://music.apple.com/' });
  if (r.status === 401) { apple.rejected.add(token); if (apple.token === token) apple.token = null; return null; }
  return r.ok ? r.json() : null;
}

/** How well a hit lines up with what's playing (null = wrong artist or a compilation). */
function appleScore(a, title, artist, album) {
  if (isCompilation(a.name) || isCompilation(a.albumName)) return null;
  if (!mainCredited(artist, a.artistName)) return null;
  let s = 10;
  const wt = norm(title), ht = norm(a.name);
  s += ht === wt ? 15 : ht.includes(wt) || wt.includes(ht) ? 7 : -10;
  if (album && a.albumName) {
    const wa = norm(album), ga = norm(a.albumName);
    s += ga === wa ? 20 : ga.includes(wa) || wa.includes(ga) ? 10 : 0;
  }
  for (const w of ['deluxe', 'expanded', 'remastered', 'remix', 'version', 'edit', 'mix', 'bonus']) {
    const inW = title.toLowerCase().includes(w), inH = String(a.name).toLowerCase().includes(w);
    if (inW && inH) s += 5; else if (inH) s -= 3;
  }
  return s;
}

/** The clip is HLS, but each rendition is one fragmented MP4 cut by byte ranges: Chromium plays
 *  that file directly. Picks an H.264 rendition up to 768 px (HEVC doesn't always decode on Windows;
 *  bigger is wasted on a cover and costs more to decode). */
async function appleClip(video) {
  const asset = (k) => video?.[k]?.video || video?.[k]?.url || null;
  const master = asset('motionDetailSquare') || asset('motionSquareVideo1x1') || asset('motionDetailRaw');
  if (!master) return null;
  const text = await (await get(master)).text();
  const lines = text.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
    const codecs = /CODECS="([^"]+)"/.exec(lines[i])?.[1] || '';
    const size = +(/RESOLUTION=(\d+)x/.exec(lines[i])?.[1] || 0);
    const uri = lines.slice(i + 1).find((l) => l && !l.startsWith('#'));
    if (uri && /avc1/.test(codecs)) variants.push({ size, url: new URL(uri, master).href });
  }
  const best = variants.filter((v) => v.size <= 768).sort((a, b) => b.size - a.size)[0] || variants.sort((a, b) => a.size - b.size)[0];
  if (!best) return null;
  const playlist = await (await get(best.url)).text();
  const files = [...new Set([...playlist.matchAll(/^(?!#)(\S+)$/gm)].map((m) => m[1]))];
  const map = /#EXT-X-MAP:URI="([^"]+)"/.exec(playlist)?.[1];
  if (files.length !== 1 || (map && map !== files[0])) return null; // not the single-file layout
  return new URL(files[0], best.url).href;
}

async function appleSearch(title, artist, album) {
  const token = await appleToken();
  if (!token) return null;
  let term = (title.toLowerCase().includes(artist.toLowerCase()) ? '' : artist + ' ') + title;
  if (album && !title.toLowerCase().includes(album.toLowerCase())) term += ' ' + album;
  const j = await appleGet(`${AMP}/${country}/search?term=${encodeURIComponent(term)}&types=songs&limit=10&extend=editorialVideo&include=albums`, token);
  const hits = (j?.results?.songs?.data || []).map((s) => ({ s, score: appleScore(s.attributes || {}, title, artist, album) }))
    .filter((x) => x.score != null && x.score >= 12).sort((a, b) => b.score - a.score);
  for (const { s } of hits) {
    const a = s.attributes;
    let video = a.editorialVideo;
    if (!video) {
      const id = s.relationships?.albums?.data?.[0]?.id || (a.url || '').split('/album/')[1]?.split('?')[0]?.split('/').pop();
      if (!id || !/^\d+$/.test(id)) continue;
      const al = (await appleGet(`${AMP}/${country}/albums/${id}?extend=editorialVideo`, token))?.data?.[0]?.attributes;
      if (!al || isCompilation(al.name)) continue;
      video = al.editorialVideo;
    }
    const url = video && await appleClip(video).catch(() => null);
    if (url) return { url, source: 'Apple Music', title: a.name, artist: a.artistName, album: a.albumName };
  }
  return null;
}

// ---------------------------------------------------------------- Tidal
// Square video covers on a lot of what Apple misses, through Tidal's public embed token.
async function tidalSearch(title, artist, album) {
  const q = album ? `${album} ${artist} ${title}` : `${artist} ${title}`;
  const r = await get(`https://api.tidal.com/v1/search?query=${encodeURIComponent(q)}&limit=10&types=TRACKS&countryCode=${country.toUpperCase()}`, { 'X-Tidal-Token': 'vNVdglQOjFJJGG2U' });
  if (!r.ok) return null;
  for (const t of (await r.json())?.tracks?.items || []) {
    if (norm(t.title) !== norm(title)) continue;
    const names = (t.artists || []).map((a) => a.name);
    if (!mainCredited(artist, names.join(', '))) continue;
    const parts = String(t.album?.videoCover || '').split('-');
    if (parts.length !== 5) continue;
    return { url: `https://resources.tidal.com/videos/${parts.join('/')}/640x640.mp4`, source: 'Tidal', title: t.title, artist: names.join(', '), album: t.album?.title };
  }
  return null;
}

// ---------------------------------------------------------------- community index
// A hand-made list (the only source that reaches back catalogue), refreshed every half hour.
let community = { items: [], at: 0 };
async function communitySearch(title, artist, album) {
  if (!community.items.length || Date.now() - community.at > 30 * 60e3) {
    community.at = Date.now();
    try { const j = await (await get('https://vivimusicanvas.mkmdevilmi.workers.dev/canvas.json')).json(); if (j?.items?.length) community.items = j.items; } catch {}
  }
  const wt = norm(title), wa = norm(artist), wal = norm(album);
  const hit = community.items.find((e) => {
    const s = norm(e.song), a = norm(e.artist), al = norm(e.album);
    return s && a && (wt.includes(s) || s.includes(wt)) && (wa.includes(a) || a.includes(wa)) && (!al || !wal || al === wal);
  });
  return hit?.url ? { url: hit.url, source: tr('comunidad'), title: hit.song, artist: hit.artist, album: hit.album } : null;
}

// ---------------------------------------------------------------- lookup
const cache = new Map(); // key -> answer (null = known to have none), last 100 tracks
let queue = Promise.resolve();

/** The animated cover for a track ({ url, source }) or null. Never throws. Lookups go one at a
 *  time (skipping through a queue fires one per song) and are remembered, misses included. */
export function canvasFor(t) {
  const key = t?.id || `${t?.title}|${t?.artist}`;
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  const run = async () => {
    if (cache.has(key)) return cache.get(key);
    const title = clean(t?.title), artist = clean(t?.artist), album = t?.album ? clean(t.album) : null;
    let found = null;
    if (title && artist) {
      for (const [name, source] of [['Apple', appleSearch], ['Tidal', tidalSearch], ['comunidad', communitySearch]]) {
        try { found = await source(title, artist, album); } catch (e) { console.error('[canvas]', name, e?.message || e); }
        if (found) break;
      }
    }
    console.log('[canvas]', `${artist} — ${title}:`, found ? `portada animada de ${found.source}` : 'sin portada animada');
    cache.set(key, found);
    if (cache.size > 100) cache.delete(cache.keys().next().value);
    return found;
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p.catch(() => null);
}
