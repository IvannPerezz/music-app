// YouTube Music access for BitChord Desktop.
// Port of BitChord's data layer (YtMusicRepository + StreamResolver) on top of youtubei.js.
// Everything returned from here is plain JSON so it can cross the IPC bridge.

import { Innertube, UniversalCache, YTNodes, Platform, YT } from 'youtubei.js';
import vm from 'node:vm';
import { tr } from './i18n.js';

// youtubei.js no longer ships a JavaScript evaluator: deciphering signatures and the `n`
// parameter means running a snippet extracted from YouTube's player. We run it in an isolated
// V8 context (no Node globals) with a time limit.
Platform.shim.eval = (data) => vm.runInNewContext(
  `(function () {\n${data.output}\n})()`,
  { URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa },
  { timeout: 5000 },
);

let yt = null;
let ytPromise = null;
let cacheDir = null;
let cookie = null;
let locale = { lang: 'es', location: 'ES' };

// ---------------------------------------------------------------- rate-limit circuit breaker
// When YouTube decides there is "unusual traffic" it answers 429 or 403 with its "Sorry…" page.
// Hammering it after that only extends the block, so every YouTube request fails fast until the
// back-off window ends; then a single request is let through to test the water.
const block = { until: 0, strikes: 0, scope: 'all' }; // scope: 'all' (every request) | 'playback' (only audio)
let onBlockChange = () => {};
export function setBlockListener(fn) { onBlockChange = fn; }
export function blockStatus() { return { blocked: Date.now() < block.until, until: block.until, strikes: block.strikes, scope: block.scope }; }
export class BlockedError extends Error {
  constructor() {
    const min = Math.max(1, Math.ceil((block.until - Date.now()) / 60000));
    super(block.scope === 'playback'
      ? tr('YouTube está rechazando la reproducción desde tu conexión. BitChord esperará ~{min} min antes de volver a intentarlo.', { min })
      : tr('YouTube ha limitado temporalmente las peticiones desde tu conexión. BitChord esperará ~{min} min antes de volver a intentarlo.', { min }));
    this.code = 'YT_BLOCKED';
  }
}
function tripBreaker(why, scope = 'all') {
  const active = Date.now() < block.until;
  block.scope = active && block.scope === 'all' ? 'all' : scope;
  block.strikes = Math.min(block.strikes + 1, 6);
  const mins = [2, 5, 10, 20, 30, 60][block.strikes - 1];
  block.until = Date.now() + mins * 60000;
  console.warn(`[yt] bloqueo de YouTube detectado (${why}); pausa de ${mins} min`);
  onBlockChange(blockStatus());
}
function assertNotBlocked(kind = 'api') { if (Date.now() < block.until && (block.scope === 'all' || kind === 'playback')) throw new BlockedError(); }
function clearBreaker(kind) {
  if (!block.strikes || Date.now() < block.until) return;
  if (kind === 'api' && block.scope !== 'all') return;
  block.strikes = 0; block.until = 0; block.scope = 'all';
  console.log('[yt] YouTube vuelve a responder con normalidad');
  onBlockChange(blockStatus());
}
const isYouTubeApi = (u) => /^https:\/\/(www|music|m|youtubei)\.(youtube|googleapis)\.com\//.test(u) && !/googlevideo\.com/.test(u);
async function guardedFetch(input, init) {
  const url = typeof input === 'string' ? input : input?.url || String(input);
  if (!isYouTubeApi(url)) return fetch(input, init);
  assertNotBlocked();
  const res = await fetch(input, init);
  if (res.status === 429 || res.status === 403) {
    let sorry = res.status === 429;
    if (!sorry) { try { const body = await res.clone().text(); sorry = /\/sorry\/|unusual traffic|tráfico inusual|<title>Sorry/i.test(body); } catch {} }
    if (sorry) { tripBreaker(`HTTP ${res.status} en ${new URL(url).pathname}`); throw new BlockedError(); }
  } else if (res.ok) clearBreaker('api');
  return res;
}

export function configure({ cachePath, cookie: c, lang, location }) {
  if (cachePath !== undefined) cacheDir = cachePath;
  if (lang) locale.lang = lang;
  if (location) locale.location = location;
  if (c !== undefined && c !== cookie) {
    cookie = c || null;
    // Session changes (sign in / out): rebuild the client and forget minted URLs.
    yt = null; ytPromise = null;
    resolved.clear();
  }
}

export const signedIn = () => !!cookie;

export async function client() {
  if (yt) return yt;
  if (!ytPromise) {
    const opts = {
      lang: locale.lang, location: locale.location,
      cache: cacheDir ? new UniversalCache(true, cacheDir) : undefined,
      ...(cookie ? { cookie } : {}),
      fetch: guardedFetch,
    };
    ytPromise = Innertube.create({ ...opts, retrieve_player: true })
      .catch((e) => {
        // Without the player script some URLs can't be deciphered, but ANDROID_VR/IOS ones still work.
        console.warn('[yt] player script unavailable, continuing without it:', e?.message);
        return Innertube.create({ ...opts, retrieve_player: false });
      })
      .then((c) => (yt = c))
      .catch((e) => { ytPromise = null; throw e; });
  }
  return ytPromise;
}

// ---------------------------------------------------------------- helpers

const txt = (t) => (t == null ? '' : typeof t === 'string' ? t : (t.toString?.() ?? t.text ?? ''));

/** Bigger artwork: googleusercontent URLs carry their size in the URL. */
export function bigThumb(url, size = 544) {
  if (!url) return null;
  if (url.startsWith('//')) url = 'https:' + url;
  if (/googleusercontent\.com|ggpht\.com/.test(url)) {
    return url.replace(/=w\d+-h\d+[^&?#]*$/, `=w${size}-h${size}-l90-rj`).replace(/=s\d+[^&?#]*$/, `=s${size}`);
  }
  return url;
}

function pickThumb(list) {
  if (!list || !list.length) return null;
  const sorted = [...list].sort((a, b) => (b.width || 0) - (a.width || 0));
  return bigThumb(sorted[0].url);
}

function thumbsOf(node) {
  if (!node) return [];
  if (Array.isArray(node)) return node;
  if (node.contents && Array.isArray(node.contents)) return node.contents; // MusicThumbnail
  if (node.thumbnails) return node.thumbnails;
  return [];
}

const people = (arr) =>
  (arr || []).filter((a) => a && a.name).map((a) => ({ name: a.name, id: a.channel_id || null }));

function parseDuration(text) {
  if (!text) return 0;
  const parts = String(text).split(':').map((n) => parseInt(n, 10));
  if (parts.some(isNaN)) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** "No me interesa" / "No recomendar artista" tokens from an item's menu (home recommendations). */
function feedbackOf(node) {
  const items = node?.menu?.items || node?.menu?.contents || [];
  const fb = items.filter((m) => m?.endpoint?.payload?.feedbackToken);
  if (!fb.length) return undefined;
  const isArtist = (m) => /artist/i.test(txt(m.text));
  const artist = fb.find(isArtist), item = fb.find((m) => !isArtist(m));
  return { item: item?.endpoint.payload.feedbackToken, artist: artist?.endpoint.payload.feedbackToken };
}
const withFeedback = (out, node) => { if (out) { const f = feedbackOf(node); if (f) out.feedback = f; } return out; };

/** Normalises any YT Music list/card/queue item into {kind, ...}. Returns null for things we can't show. */
export function norm(node, fallback = {}) {
  if (node && (node.type === 'MusicResponsiveListItem' || node.type === 'MusicTwoRowItem')) return withFeedback(normItem(node, fallback), node);
  return normItem(node, fallback);
}
function normItem(node, fallback = {}) {
  if (!node) return null;
  const type = node.type;

  if (type === 'PlaylistPanelVideoWrapper') return norm(node.primary, fallback);

  if (type === 'PlaylistPanelVideo') {
    if (!node.video_id) return null;
    return {
      kind: 'track',
      id: node.video_id,
      title: txt(node.title),
      artists: people(node.artists).length ? people(node.artists) : [{ name: node.author || '', id: null }],
      album: node.album ? { id: node.album.id || null, name: node.album.name } : null,
      duration: node.duration?.seconds || 0,
      thumb: pickThumb(node.thumbnail) || fallback.thumb || null,
    };
  }

  if (type === 'MusicResponsiveListItem') {
    const it = node.item_type;
    const thumb = pickThumb(node.thumbnails || thumbsOf(node.thumbnail)) || fallback.thumb || null;
    if (it === 'song' || it === 'video' || it === 'non_music_track') {
      const id = node.id || node.overlay?.content?.endpoint?.payload?.videoId;
      if (!id) return null;
      let artists = people(node.artists);
      if (!artists.length) artists = people(node.authors);
      if (!artists.length && node.author) artists = people([node.author]);
      if (!artists.length && fallback.artists) artists = fallback.artists;
      return {
        kind: 'track',
        id,
        title: node.title || txt(node.name),
        artists,
        album: node.album ? { id: node.album.id || null, name: node.album.name } : fallback.album || null,
        duration: node.duration?.seconds || 0,
        thumb,
        isVideo: it === 'video',
      };
    }
    if (it === 'album') {
      return { kind: 'album', id: node.id, title: node.title || '', subtitle: [people(node.artists || (node.author ? [node.author] : [])).map((a) => a.name).join(', '), node.year].filter(Boolean).join(' · '), thumb };
    }
    if (it === 'playlist') {
      return { kind: 'playlist', id: node.id, title: node.title || '', subtitle: [node.author?.name, node.item_count].filter(Boolean).join(' · '), thumb };
    }
    if (it === 'artist' || it === 'library_artist') {
      return { kind: 'artist', id: node.id, title: node.name || node.title || '', subtitle: node.subscribers || '', thumb };
    }
    return null;
  }

  if (type === 'MusicTwoRowItem') {
    const it = node.item_type;
    const thumb = pickThumb(node.thumbnail);
    const title = txt(node.title);
    const subtitle = txt(node.subtitle);
    if (it === 'song' || it === 'video') {
      const id = node.id || node.endpoint?.payload?.videoId;
      if (!id) return null;
      return {
        kind: 'track', id, title,
        artists: people(node.artists).length ? people(node.artists) : (node.author ? people([node.author]) : [{ name: subtitle, id: null }]),
        album: null, duration: 0, thumb, isVideo: it === 'video',
      };
    }
    if (it === 'album') return { kind: 'album', id: node.id, title, subtitle, thumb };
    if (it === 'playlist') return { kind: 'playlist', id: node.id, title, subtitle, thumb };
    if (it === 'artist') return { kind: 'artist', id: node.id, title, subtitle, thumb };
    return null;
  }

  return null;
}

/** The "top result" card of a search (MusicCardShelf) as an item: artist, album, playlist or song. */
function cardShelfItem(s) {
  const ep = s.on_tap?.payload || s.title?.endpoint?.payload || {};
  const title = txt(s.title);
  const subtitle = txt(s.subtitle);
  const thumb = pickThumb(thumbsOf(s.thumbnail));
  const browseId = ep.browseId || '';
  if (ep.videoId) {
    const parts = subtitle.split(' • ').map((x) => x.trim());
    return { kind: 'track', id: ep.videoId, title, thumb, subtitle,
      artists: (s.subtitle?.runs || []).filter((r) => r.endpoint?.payload?.browseId?.startsWith('UC')).map((r) => ({ name: r.text, id: r.endpoint.payload.browseId })),
      album: null, duration: parseDuration(parts[parts.length - 1]) };
  }
  if (browseId.startsWith('UC')) return { kind: 'artist', id: browseId, title, subtitle, thumb };
  if (browseId.startsWith('MPRE')) return { kind: 'album', id: browseId, title, subtitle, thumb };
  if (browseId.startsWith('VL') || browseId.startsWith('PL')) return { kind: 'playlist', id: browseId, title, subtitle, thumb };
  return null;
}

const normAll = (arr, fallback) => (arr || []).map((n) => { try { return norm(n, fallback); } catch { return null; } }).filter(Boolean);

function normSection(sec, fallback) {
  if (!sec) return null;
  let title = '';
  if (sec.type === 'MusicCarouselShelf') title = txt(sec.header?.title);
  else if (sec.type === 'MusicShelf') title = txt(sec.title);
  else if (sec.type === 'MusicPlaylistShelf') title = '';
  else return null;
  const items = normAll(sec.contents, fallback);
  if (!items.length) return null;
  // Tracks shown as rows; everything else as cards.
  const layout = items.every((i) => i.kind === 'track') ? 'list' : 'cards';
  return { title, layout, items };
}

// ---------------------------------------------------------------- browse

export async function home() {
  const c = await client();
  let feed = await c.music.getHomeFeed();
  const sections = [];
  const push = (f) => (f.sections || []).forEach((s) => { const n = normSection(s); if (n) sections.push(n); });
  push(feed);
  // One continuation gives a fuller home page without being slow.
  try { if (feed.has_continuation) { feed = await feed.getContinuation(); push(feed); } } catch {}
  return sections;
}

/** Spelling suggestion in a search response: YouTube either already shows the corrected results
 *  (ShowingResultsFor) or only suggests it (DidYouMean). Returned as a section the UI shows on top. */
function correctionOf(r) {
  for (const s of r.contents || []) {
    for (const n of (s.type === 'ItemSection' ? s.contents : [s]) || []) {
      if (n?.type === 'ShowingResultsFor' || n?.type === 'DidYouMean') {
        const q = n.corrected_query_endpoint?.payload?.query || n.endpoint?.payload?.query || txt(n.corrected_query);
        if (q) return { layout: 'correction', title: '', items: [], query: q, auto: n.type === 'ShowingResultsFor' };
      }
    }
  }
  return null;
}

export async function search(query, type = 'all') {
  const c = await client();
  if (type === 'all') {
    const r = await c.music.search(query);
    const sections = [];
    const fix = correctionOf(r);
    if (fix) sections.push(fix);
    const loose = [];
    let top = null;
    for (const s of r.contents || []) {
      if (s.type === 'MusicCardShelf') {
        // "Top result": the card itself (an artist, album, song…) plus the songs YouTube lists with it.
        const item = cardShelfItem(s);
        const fallback = item?.kind === 'artist' ? { artists: [{ name: item.title, id: item.id }] } : undefined;
        const items = normAll(s.contents, fallback).filter((t) => t.kind === 'track');
        if (item || items.length) { top = { title: tr('Resultado principal'), layout: 'top', top: item, items: items.slice(0, 4) }; sections.push(top); }
        continue;
      }
      // Newer layout: the rest of the results come one per ItemSection, all kinds mixed.
      if (s.type === 'ItemSection') { loose.push(...normAll(s.contents)); continue; }

      const n = normSection(s);
      if (n) sections.push(n);
    }
    if (loose.length) {
      const seen = new Set([top?.top?.id, ...(top?.items || []).map((t) => t.id)]);
      const groups = [
        [tr('Canciones'), (i) => i.kind === 'track' && !i.isVideo, 'list'], [tr('Vídeos'), (i) => i.kind === 'track' && i.isVideo, 'list'],
        [tr('Artistas'), (i) => i.kind === 'artist', 'cards'], [tr('Álbumes'), (i) => i.kind === 'album', 'cards'], [tr('Playlists'), (i) => i.kind === 'playlist', 'cards'],
      ];
      for (const [title, test, layout] of groups) {
        const items = loose.filter((i) => test(i) && !seen.has(i.id) && seen.add(i.id));
        if (items.length) sections.push({ title, layout, items });
      }
    }
    // An artist as top result: follow it with their page (most played songs, latest albums,
    // singles…), like YouTube Music does, before the rest of the results.
    if (top?.top?.kind === 'artist') {
      try {
        const a = await artist(top.top.id);
        if (a.thumb) top.top.thumb = a.thumb;
        const extra = a.sections.slice(0, 5).map((sec) => ({ ...sec, title: sec.title ? `${sec.title} · ${a.title}` : a.title, artistId: top.top.id }));
        sections.splice(1, 0, ...extra);
      } catch (e) { console.warn('[yt] top artist', e?.message); }
    }
    return sections;
  }
  const r = await c.music.search(query, { type });
  const shelf = r.contents?.find((s) => s.type === 'MusicShelf') || r.contents?.[0];
  const items = normAll(shelf?.contents);
  const fix = correctionOf(r);
  return [...(fix ? [fix] : []), { title: '', layout: type === 'song' || type === 'video' ? 'list' : 'cards', items }];
}

export async function suggestions(input) {
  const c = await client();
  try {
    const res = await c.music.getSearchSuggestions(input);
    const out = [];
    for (const sec of res || []) {
      for (const s of sec.contents || []) {
        const q = txt(s.suggestion) || s.query;
        if (q) out.push(q);
      }
    }
    return [...new Set(out)].slice(0, 8);
  } catch { return []; }
}

function headerInfo(header) {
  if (!header) return {};
  const thumb = pickThumb(header.thumbnails || thumbsOf(header.thumbnail));
  return {
    title: txt(header.title),
    subtitle: [txt(header.strapline_text_one) || header.author?.name, txt(header.subtitle)].filter(Boolean).join(' · '),
    meta: txt(header.second_subtitle),
    description: txt(header.description?.description ?? header.description),
    thumb,
  };
}

export async function album(id) {
  const c = await client();
  const a = await c.music.getAlbum(id);
  const h = headerInfo(a.header);
  const artistsRaw = a.header?.strapline_text_one?.runs?.filter((r) => r.endpoint?.payload?.browseId?.startsWith('UC'))
    .map((r) => ({ name: r.text, id: r.endpoint.payload.browseId }));
  const fallback = { thumb: h.thumb, album: { id, name: h.title }, artists: artistsRaw?.length ? artistsRaw : (h.subtitle ? [{ name: h.subtitle.split(' · ')[0], id: null }] : []) };
  const tracks = normAll(a.contents, fallback);
  const more = (a.sections || []).map((s) => normSection(s)).filter(Boolean);
  return { kind: 'album', id, ...h, tracks, sections: more };
}

export async function playlist(id) {
  const c = await client();
  let p = await c.music.getPlaylist(id);
  const h = headerInfo(p.header);
  const tracks = normAll(p.items);
  // Follow a few continuations so long playlists aren't cut at 100.
  for (let i = 0; i < 4 && p.has_continuation; i++) {
    try { p = await p.getContinuation(); tracks.push(...normAll(p.items)); } catch { break; }
  }
  return { kind: 'playlist', id, ...h, tracks, sections: [] };
}

export async function artist(id) {
  const c = await client();
  const a = await c.music.getArtist(id);
  const h = a.header || {};
  const thumb = pickThumb(thumbsOf(h.thumbnail)) || pickThumb(h.thumbnails);
  const name = txt(h.title);
  const sections = (a.sections || []).map((s) => normSection(s, { artists: [{ name, id }] })).filter(Boolean);
  return {
    kind: 'artist', id,
    title: txt(h.title),
    subtitle: txt(h.subscription_button?.subscriber_count) || txt(h.subtitle) || '',
    description: txt(h.description),
    thumb,
    sections,
  };
}

/** "Radio" for a track: what YT Music would play next. */
export async function upNext(videoId) {
  const c = await client();
  const panel = await c.music.getUpNext(videoId, true);
  return normAll(panel?.contents).filter((t) => t.kind === 'track');
}

export async function ytLyrics(videoId) {
  const c = await client();
  try {
    const shelf = await c.music.getLyrics(videoId);
    if (!shelf) return null;
    return { text: txt(shelf.description), source: txt(shelf.footer) || 'YouTube Music' };
  } catch { return null; }
}

// ---------------------------------------------------------------- streams

// User agents a googlevideo URL must be fetched with, keyed by the client that minted it.
// (Taken from BitChord's PlayerClient.kt.)
const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
function mediaHeadersFor(url) {
  let c = '';
  try { c = (new URL(url).searchParams.get('c') || '').toUpperCase(); } catch {}
  if (c.startsWith('IOS')) return { 'User-Agent': 'com.google.ios.youtube/21.26.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)' };
  if (c === 'ANDROID_VR') return { 'User-Agent': 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip' };
  if (c === 'ANDROID_MUSIC') return { 'User-Agent': 'com.google.android.apps.youtube.music/8.39.42 (Linux; U; Android 15; en_US; Pixel 9 Pro; Build/AP4A.250205.002) gzip' };
  if (c.startsWith('ANDROID')) return { 'User-Agent': 'com.google.android.youtube/21.26.364 (Linux; U; Android 15; en_US; Pixel 9 Pro; Build/AP4A.250205.002; Cronet/132.0.6834.79) gzip' };
  if (c.startsWith('TVHTML5')) return { 'User-Agent': 'Mozilla/5.0(SMART-TV; Linux; Tizen 4.0.0.2) AppleWebkit/605.1.15 (KHTML, like Gecko) SamsungBrowser/9.2 TV Safari/605.1.15', Origin: 'https://www.youtube.com', Referer: 'https://www.youtube.com/' };
  if (c === 'WEB_REMIX') return { 'User-Agent': WEB_UA, Origin: 'https://music.youtube.com', Referer: 'https://music.youtube.com/' };
  return { 'User-Agent': WEB_UA, Origin: 'https://www.youtube.com', Referer: 'https://www.youtube.com/' };
}

function chunkSizeFor(url) {
  let c = '';
  try { c = (new URL(url).searchParams.get('c') || '').toUpperCase(); } catch {}
  return c === 'ANDROID_VR' || c.startsWith('TVHTML5_SIMPLY') ? 512 * 1024 : 1024 * 1024;
}

// Clients we can ask for audio. Some clients' URLs serve the first ~1 MiB (≈ 50-60 s of audio)
// and answer 403 after that unless a PO token is attached, so every candidate is probed *past*
// that boundary before it is trusted, and clients that fail mid-song are benched.
// `pot`: the client wants BotGuard PO tokens (generated in a hidden window, see potoken.js).
// Since August 2026 googlevideo cuts ANDROID_VR streams after ~1 MiB unless they carry a GVS
// PO token. Android/iOS player requests made with params=2AMB still get full streams without one
// (see anxdpanic/plugin.video.youtube#1481, yt-dlp#17348), so those go first.
const CLIENTS = [
  { id: 'ANDROID_2AMB', name: 'ANDROID', params: '2AMB' },
  { id: 'IOS_2AMB', name: 'IOS', params: '2AMB' },
  { id: 'YTMUSIC', name: 'YTMUSIC', pot: true },
  { id: 'WEB', name: 'WEB', pot: true },
  { id: 'TV', name: 'TV' },
  { id: 'MWEB', name: 'MWEB', pot: true },
  { id: 'ANDROID_VR', name: 'ANDROID_VR' },
  { id: 'IOS', name: 'IOS' },
  { id: 'ANDROID', name: 'ANDROID' },
];
for (const c of CLIENTS) c.label = c.params ? `${c.name} (${c.params})` : c.name;

/** /player request for one client. Like getBasicInfo, plus optional player params. */
async function playerInfo(c, videoId, cl, tokens) {
  const payload = {
    videoId, racyCheckOk: true, contentCheckOk: true,
    playbackContext: { contentPlaybackContext: { vis: 0, splay: false, lactMilliseconds: '-1', signatureTimestamp: c.session.player?.signature_timestamp } },
    client: cl.name,
    ...(cl.params ? { params: cl.params } : {}),
    ...(tokens ? { serviceIntegrityDimensions: { poToken: tokens.player } } : {}),
  };
  const res = await c.actions.execute('/player', payload);
  return new YT.VideoInfo([res], c.actions, Math.random().toString(36).slice(2, 18));
}
const clientScore = new Map(); // name -> score (higher = tried earlier)
const benched = new Map(); // videoId -> Map(client -> until)
const BENCH_MS = 30 * 60 * 1000;
let potoken = null;
export function setPoTokenProvider(p) { potoken = p; }

export function markRefused(videoId, clientName) {
  if (!videoId || !clientName) return;
  if (!benched.has(videoId)) benched.set(videoId, new Map());
  benched.get(videoId).set(clientName, Date.now() + BENCH_MS);
  clientScore.set(clientName, (clientScore.get(clientName) || 0) - 2);
  for (const [k, v] of resolved) if (k.startsWith(videoId + '|') && v.stream.client === clientName) resolved.delete(k);
  console.warn(`[yt] ${clientName} rechazado a mitad de ${videoId}; se descarta para esta canción`);
}
const isBenched = (videoId, name) => (benched.get(videoId)?.get(name) || 0) > Date.now();
const orderedClients = () => [...CLIENTS].sort((a, b) => (clientScore.get(b.id) || 0) - (clientScore.get(a.id) || 0));

const resolved = new Map(); // key -> {stream, at}
const inflight = new Map();
const URL_TTL = 60 * 60 * 1000; // googlevideo URLs live ~6h; refresh well before.
const lastKey = new Map(); // videoId -> last key resolved (for stats)

/**
 * Picks the audio-only format under the bitrate ceiling.
 * prefer: 'opus' | 'm4a' | 'any'. 'm4a' means *only* AAC/MP4 (for downloads that need it).
 */
function pickAudio(streaming, { maxKbps = 9999, prefer = 'any', itag = null } = {}) {
  let formats = [...(streaming?.adaptive_formats || [])].filter((f) =>
    f.has_audio && !f.has_video && !f.is_type_otf && !(f.drm_families?.length) && (f.url || f.signature_cipher || f.cipher));
  if (!formats.length) return null;
  const clean = formats.filter((f) => !f.is_drc && !f.is_vb && !f.is_sr && (f.audio_track ? f.audio_track.audio_is_default !== false : true));
  if (clean.length) formats = clean;
  const isOpus = (f) => String(f.mime_type).includes('opus');
  const isM4a = (f) => String(f.mime_type).startsWith('audio/mp4');
  if (itag) { const same = formats.filter((f) => f.itag === itag); return same[0] || null; }
  if (prefer === 'm4a') { const m = formats.filter(isM4a); if (m.length) formats = m; }
  if (prefer === 'opus') { const o = formats.filter(isOpus); if (o.length) formats = o; }
  const kbps = (f) => Math.round((f.average_bitrate || f.bitrate || 0) / 1000);
  const under = formats.filter((f) => kbps(f) <= maxKbps);
  const pool = under.length ? under : [formats.sort((a, b) => kbps(a) - kbps(b))[0]];
  // Opus beats AAC at equal size; small bonus so it wins ties.
  const score = (f) => kbps(f) + (isOpus(f) ? 20 : 0);
  return pool.sort((a, b) => score(b) - score(a))[0];
}

const AUTH_BOUNDARY = 1024 * 1024;
const PROBE_READ = 16 * 1024;
/**
 * Reads from *past* the 1 MiB boundary with a realistic range, and insists that ~16 KB of
 * audio actually arrive. A probe of the opening bytes passes on URLs that die ~50 s in.
 */
async function probe(url, headers, size) {
  const chunk = chunkSizeFor(url);
  // Probe past the 1 MiB auth boundary *and* past the ~76 s cut-off googlevideo applies to
  // unauthorised clients (2.5 MiB is ~2 min of 160 kbps Opus); short files: near the end.
  const start = size && size > AUTH_BOUNDARY + PROBE_READ ? Math.min(Math.round(2.5 * 1024 * 1024), size - PROBE_READ - 1) : 0;
  const end = Math.min(start + chunk, size || start + chunk) - 1;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 7000);
  try {
    const res = await fetch(url, { headers: { ...headers, Range: `bytes=${start}-${end}` }, redirect: 'follow', signal: ctl.signal });
    if (res.status !== 206 && res.status !== 200) { try { await res.arrayBuffer(); } catch {} throw new Error(`HTTP ${res.status} en el byte ${start}`); }
    const type = res.headers.get('content-type') || '';
    if (!/^(audio|video)\/|octet-stream/.test(type)) { try { await res.arrayBuffer(); } catch {} throw new Error(`respuesta no es audio (${type})`); }
    // The bytes have to actually arrive; a body that stalls after its headers is a failure too.
    let got = 0;
    for await (const part of res.body) { got += part.length; if (got >= PROBE_READ) break; }
    ctl.abort();
    if (got < Math.min(PROBE_READ, end - start + 1)) throw new Error('el servidor dejó de enviar datos');
    const cr = res.headers.get('content-range');
    const total = cr ? parseInt(cr.split('/')[1], 10) : NaN;
    return Number.isFinite(total) ? total : size;
  } finally { clearTimeout(timer); }
}

// Videos that no client could play recently: don't ask YouTube again for a while.
const unplayable = new Map(); // videoId -> { at, err }
const UNPLAYABLE_TTL = 10 * 60 * 1000;

// Mobile/VR clients don't accept the cookies of a signed-in web session: YouTube answers their
// /player requests with HTTP 400 ("invalid argument"). They get their own anonymous session.
const NO_COOKIE = new Set(['ANDROID_VR', 'IOS', 'ANDROID']);
let anonYt = null, anonPromise = null;
async function anonClient() {
  if (anonYt) return anonYt;
  if (!anonPromise) {
    anonPromise = Innertube.create({ lang: locale.lang, location: locale.location, fetch: guardedFetch, retrieve_player: true })
      .catch(() => Innertube.create({ lang: locale.lang, location: locale.location, fetch: guardedFetch, retrieve_player: false }))
      .then((c) => (anonYt = c))
      .catch((e) => { anonPromise = null; throw e; });
  }
  return anonPromise;
}

// Signed in, the streaming (GVS) PO token must be bound to the account's Data Sync ID, not to
// the visitor id.
let dataSync = { id: null, at: 0, forCookie: null };
async function dataSyncId(c) {
  if (dataSync.forCookie === cookie && Date.now() - dataSync.at < 6 * 3600e3) return dataSync.id;
  let id = null;
  for (const [browseId, cl] of [['FEmusic_home', 'YTMUSIC'], ['FEwhat_to_watch', 'WEB']]) {
    try {
      const r = await c.actions.execute('/browse', { browseId, client: cl });
      const raw = r?.data?.responseContext?.mainAppWebResponseContext?.datasyncId;
      if (raw) { id = String(raw).split('||')[0] || null; break; }
    } catch {}
  }
  dataSync = { id, at: Date.now(), forCookie: cookie };
  console.log('[yt] Data Sync ID de la cuenta', id ? 'obtenido' : 'no disponible');
  return id;
}

async function resolveUncached(videoId, opts) {
  assertNotBlocked('playback');
  const main = await client();
  const errors = [];
  // Plan: every client once (mobile ones without cookies); then, if signed in and all of that
  // failed, the web clients again with a fresh anonymous session.
  const plan = [];
  for (const cl of orderedClients()) if (!isBenched(videoId, cl.id)) plan.push({ cl, anon: !!cookie && NO_COOKIE.has(cl.name) });
  if (cookie) for (const cl of orderedClients()) if (!NO_COOKIE.has(cl.name) && !isBenched(videoId, cl.id)) plan.push({ cl, anon: true });
  let anonRefusals = 0, anonTries = 0;
  for (const { cl, anon } of plan) {
    const label = cl.label + (anon && !NO_COOKIE.has(cl.name) ? ' sin sesión' : '');
    try {
      const c = anon ? await anonClient() : main;
      if (anon) anonTries++;
      const visitorData = c.session?.context?.client?.visitorData || '';
      let tokens = null;
      if (cl.pot && potoken && visitorData) {
        const binding = !anon && cookie ? (await dataSyncId(c)) || visitorData : visitorData;
        tokens = await potoken.tokensFor(videoId, binding);
      }
      const info = await playerInfo(c, videoId, cl, tokens);
      const ps = info.playability_status;
      if (ps && ps.status && ps.status !== 'OK') { errors.push(`${label}: ${ps.reason || ps.status}`); continue; }
      const f = pickAudio(info.streaming_data, opts);
      if (!f) { errors.push(`${label}: sin audio`); if (anon) anonRefusals++; continue; }
      let url = await f.decipher(c.session.player);
      if (!url) { errors.push(`${label}: URL vacía`); continue; }
      if (tokens) { const u = new URL(url); u.searchParams.set('pot', tokens.streaming); url = u.toString(); }
      const headers = mediaHeadersFor(url);
      let size = Number(f.content_length) || null;
      if (!size) { try { size = Number(new URL(url).searchParams.get('clen')) || null; } catch {} }
      size = await probe(url, headers, size); // proves the URL serves audio past the 1 MiB mark
      if (!size) { errors.push(`${label}: tamaño desconocido`); continue; }
      clientScore.set(cl.id, Math.min(5, (clientScore.get(cl.id) || 0) + 1));
      clearBreaker('playback');
      console.log(`[yt] audio de ${videoId} vía ${label}${tokens ? ' + PoToken' : ''}${errors.length ? ` (tras ${errors.length} intentos fallidos)` : ''}`);
      const mime = String(f.mime_type || 'audio/webm');
      return {
        url, headers, size,
        mime: mime.split(';')[0],
        codec: (mime.match(/codecs="([^"]+)"/) || [])[1] || '',
        bitrate: Math.round((f.average_bitrate || f.bitrate || 0) / 1000),
        sampleRate: Number(f.audio_sample_rate) || null,
        channels: f.audio_channels || null,
        itag: f.itag,
        chunk: chunkSizeFor(url),
        client: label + (tokens ? ' + PoToken' : ''),
        clientName: cl.id,
        loudnessDb: f.loudness_db ?? info.player_config?.audio_config?.loudness_db ?? null,
        duration: info.basic_info?.duration || (f.approx_duration_ms ? f.approx_duration_ms / 1000 : null),
      };
    } catch (e) {
      if (e?.code === 'YT_BLOCKED' || e?.cause?.code === 'YT_BLOCKED' || Date.now() < block.until) throw e?.code === 'YT_BLOCKED' ? e : new BlockedError();
      errors.push(`${label}: ${e?.message || e}`);
      if (anon && /HTTP 4\d\d|status code 4\d\d|volver a cargar/i.test(String(e?.message))) anonRefusals++;
      if (/HTTP 403/.test(String(e?.message))) clientScore.set(cl.id, (clientScore.get(cl.id) || 0) - 1);
    }
  }
  // The anonymous identity got refused everywhere: use a brand new one next time.
  if (anonTries && anonRefusals >= anonTries) { anonYt = null; anonPromise = null; }
  console.warn('[yt] sin audio para', videoId, errors.join(' | '));
  // Group clients by reason so the message stays readable (full detail is in the log).
  const byReason = new Map();
  for (const e of errors) { const [cl, ...r] = e.split(': '); const why = r.join(': ').slice(0, 120); byReason.set(why, [...(byReason.get(why) || []), cl]); }
  const summary = [...byReason].map(([why, cls]) => `${cls.join('/')}: ${why}`).join(' · ');
  const err = new Error(tr('No se pudo obtener el audio de esta canción.') + ' ' + (summary || tr('ningún cliente disponible')));
  err.details = errors;
  // Every client refusing at once (400s on /player, "reload the page"…) is how a soft block starts.
  const refusals = errors.filter((e) => /HTTP 4\d\d|status code 4\d\d|volver a cargar|reload|sin audio/i.test(e)).length;
  if (refusals >= Math.max(3, errors.length - 1)) {
    recentWideFailures.push(Date.now());
    while (recentWideFailures.length && Date.now() - recentWideFailures[0] > 120000) recentWideFailures.shift();
    if (recentWideFailures.length >= 3) { recentWideFailures.length = 0; tripBreaker('todos los clientes rechazan 3 canciones seguidas', 'playback'); }
  }
  throw err;
}

const recentWideFailures = [];

export async function resolveStream(videoId, { fresh = false, maxKbps = 9999, prefer = 'any', itag = null } = {}) {
  const bad = unplayable.get(videoId);
  if (bad && Date.now() - bad.at < UNPLAYABLE_TTL) throw bad.err;
  const key = `${videoId}|${maxKbps}|${prefer}|${itag || ''}`;
  lastKey.set(videoId, key);
  const hit = resolved.get(key);
  if (!fresh && hit && Date.now() - hit.at < URL_TTL) return hit.stream;
  if (fresh) resolved.delete(key);
  if (inflight.has(key)) return inflight.get(key);
  const p = resolveUncached(videoId, { maxKbps, prefer, itag })
    .then((stream) => { resolved.set(key, { stream, at: Date.now() }); unplayable.delete(videoId); return stream; })
    .catch((e) => { if (e?.code !== 'YT_BLOCKED') unplayable.set(videoId, { at: Date.now(), err: e }); throw e; })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export function streamInfo(videoId) {
  const s = resolved.get(lastKey.get(videoId))?.stream;
  return s ? { mime: s.mime, codec: s.codec, bitrate: s.bitrate, client: s.client, size: s.size, sampleRate: s.sampleRate, channels: s.channels, itag: s.itag, loudnessDb: s.loudnessDb } : null;
}

// ---------------------------------------------------------------- account (needs cookie)

async function browseItems(browseId) {
  const c = await client();
  const res = await c.actions.execute('/browse', { browseId, client: 'YTMUSIC', parse: true });
  const memo = res.contents_memo;
  if (!memo) return [];
  const nodes = [
    ...(memo.getType(YTNodes.MusicTwoRowItem) || []),
    ...(memo.getType(YTNodes.MusicResponsiveListItem) || []),
  ];
  const seen = new Set();
  return normAll(nodes).filter((i) => { const k = i.kind + i.id; if (seen.has(k)) return false; seen.add(k); return true; });
}

export async function accountPlaylists() {
  if (!cookie) return [];
  return (await browseItems('FEmusic_liked_playlists')).filter((i) => i.kind === 'playlist' && i.id !== 'LM' && i.id !== 'VLLM');
}

export async function addToAccountPlaylist(playlistId, videoIds) {
  if (!cookie) throw new Error(tr('Inicia sesión con Google para añadir canciones a tus playlists de YouTube Music.'));
  const c = await client();
  await c.playlist.addVideos(playlistId.replace(/^VL/, ''), videoIds);
  return videoIds.length;
}

/** Renames a playlist of the signed-in account (it changes in the official apps too). */
export async function renameAccountPlaylist(playlistId, name) {
  if (!cookie) throw new Error(tr('Inicia sesión con Google para crear playlists en tu cuenta.'));
  const c = await client();
  const res = await c.actions.execute('/browse/edit_playlist', { playlistId: playlistId.replace(/^VL/, ''), actions: [{ action: 'ACTION_SET_PLAYLIST_NAME', playlistName: name.slice(0, 150) }] });
  if (res?.success === false) throw new Error(tr('YouTube no ha dejado cambiar el nombre de esta playlist (puede que no sea tuya).'));
  return true;
}

/** Tells YouTube Music you're not interested in a recommendation (or in its artist). */
export async function sendFeedback(token) {
  if (!cookie) throw new Error(tr('Inicia sesión con Google para que YouTube Music tenga en cuenta tus gustos.'));
  const c = await client();
  // The tokens come from YouTube Music, so the request has to go as the YouTube Music client
  // (as the default web client YouTube answers 400).
  await c.actions.execute('/feedback', { feedbackTokens: [token], isFeedbackTokenUnencrypted: false, shouldMerge: false, client: 'YTMUSIC' });
  return true;
}

/** Deletes a playlist of the signed-in account (YouTube refuses for ones you don't own). */
export async function deleteAccountPlaylist(playlistId) {
  if (!cookie) throw new Error(tr('Inicia sesión con Google para crear playlists en tu cuenta.'));
  const c = await client();
  // youtubei.js' playlist.delete() builds an endpoint without an API URL ("Expected an api_url");
  // call the InnerTube endpoint directly, the same way playlists are created.
  const res = await c.actions.execute('/playlist/delete', { playlistId: playlistId.replace(/^VL/, '') });
  if (res?.success === false) throw new Error(tr('YouTube no ha dejado eliminar esta playlist (puede que no sea tuya).'));
  return true;
}

export async function library() {
  if (!cookie) throw new Error(tr('Inicia sesión con tu cuenta de Google para ver tu biblioteca.'));
  const [playlists, albums, artists] = await Promise.all([
    browseItems('FEmusic_liked_playlists').catch(() => []),
    browseItems('FEmusic_liked_albums').catch(() => []),
    browseItems('FEmusic_library_corpus_track_artists').catch(() => []),
  ]);
  return {
    playlists: playlists.filter((i) => i.kind === 'playlist'),
    albums: albums.filter((i) => i.kind === 'album'),
    artists: artists.filter((i) => i.kind === 'artist'),
  };
}

export async function history() {
  if (!cookie) throw new Error(tr('Inicia sesión para ver tu historial de YouTube Music.'));
  return (await browseItems('FEmusic_history')).filter((i) => i.kind === 'track');
}

export async function rate(videoId, value) {
  if (!cookie) throw new Error(tr('Inicia sesión para sincronizar "me gusta" con YouTube Music.'));
  const c = await client();
  if (value === 'like') await c.interact.like(videoId);
  else if (value === 'dislike') await c.interact.dislike(videoId);
  else await c.interact.removeRating(videoId);
  return true;
}

export async function accountInfo() {
  if (!cookie) return null;
  const c = await client();
  try {
    const info = await c.account.getInfo();
    const items = info?.contents?.contents || [];
    const header = items.find((i) => i.is_selected) || items[0] || {};
    const name = txt(header.account_name) || txt(header.title) || '';
    const photo = pickThumb(header.account_photo || header.thumbnail) || null;
    const handle = txt(header.channel_handle) || '';
    return { name, handle, photo };
  } catch (e) {
    console.warn('[yt] accountInfo', e?.message);
    return { name: '', handle: '', photo: null };
  }
}

// ---------------------------------------------------------------- playlists in the account

/** Plain song search (used by the Spotify importer). */
export async function searchSongs(query) {
  const c = await client();
  const r = await c.music.search(query, { type: 'song' });
  const shelf = r.contents?.find((s) => s.type === 'MusicShelf') || r.contents?.[0];
  return normAll(shelf?.contents).filter((t) => t.kind === 'track');
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

/**
 * Creates a private playlist in the signed-in account (YouTube and YouTube Music share playlists,
 * so it shows up in the official apps too). Videos are added in batches with pauses so a large
 * import doesn't look like abuse.
 */
export async function createAccountPlaylist(title, videoIds, { description = '', onProgress = () => {} } = {}) {
  if (!cookie) throw new Error(tr('Inicia sesión con Google para crear playlists en tu cuenta.'));
  const c = await client();
  const BATCH = 50;
  const first = videoIds.slice(0, BATCH);
  const res = await c.actions.execute('/playlist/create', { title: title.slice(0, 150), description: description.slice(0, 5000), privacyStatus: 'PRIVATE', videoIds: first });
  const playlistId = res.data?.playlistId;
  if (!playlistId) throw new Error(tr('YouTube no devolvió la playlist creada'));
  let done = first.length;
  onProgress(done);
  for (let i = BATCH; i < videoIds.length; i += BATCH) {
    await sleep(1500);
    const batch = videoIds.slice(i, i + BATCH);
    let tries = 0;
    for (;;) {
      try { await c.playlist.addVideos(playlistId, batch); break; }
      catch (e) { if (++tries > 3) throw e; await sleep(4000 * tries); }
    }
    done += batch.length;
    onProgress(done);
  }
  return playlistId;
}
