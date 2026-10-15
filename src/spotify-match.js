// Finds a Spotify song on YouTube Music: Spotify only gives title / artist / album, so each one is
// searched and the results are scored by how well they match.

const norm = (s) => String(s || '').toLowerCase()
  .normalize('NFD').replace(/\p{M}/gu, '')
  .replace(/\s*[\(\[][^\)\]]*(remaster|version|versión|live|en vivo|edit|mix|feat|ft\.?|with)[^\)\]]*[\)\]]/g, ' ')
  .replace(/\s+-\s+.*(remaster|version|live|edit|mix).*$/g, ' ')
  .replace(/\b(feat|ft)\.?\s.*$/g, ' ')
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ').trim();

function similarity(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.startsWith(b) || b.startsWith(a)) return 0.9;
  const A = new Set(a.split(' ')), B = new Set(b.split(' '));
  const inter = [...A].filter((x) => B.has(x)).length;
  return (2 * inter) / (A.size + B.size);
}

function artistScore(spotifyArtist, ytArtists) {
  const wanted = spotifyArtist.split(/,|&| x | y /i).map((s) => s.trim()).filter(Boolean);
  const names = ytArtists.map((a) => a.name);
  if (!wanted.length || !names.length) return 0;
  let best = 0;
  for (const w of wanted) for (const n of names) best = Math.max(best, similarity(w, n));
  return best;
}

function score(src, cand) {
  const t = similarity(src.title, cand.title);
  const a = artistScore(src.artist, cand.artists || []);
  const al = src.album && cand.album?.name ? similarity(src.album, cand.album.name) : 0.5;
  let s = t * 0.55 + a * 0.35 + al * 0.1;
  // Live/remix/karaoke versions that the Spotify title didn't ask for are worse matches.
  const unwanted = /(live|en vivo|karaoke|instrumental|remix|sped up|slowed|cover)/i;
  if (unwanted.test(cand.title) && !unwanted.test(src.title)) s -= 0.2;
  return Math.max(0, Math.min(1, s));
}

const cache = new Map();

/** The best YouTube Music match for a Spotify track ({title, artist, album, uri}), with its score:
 *  status 'ok' (sure), 'doubt' or 'none'. */
export async function matchTrack(src, search) {
  const key = src.uri || `${src.title}|${src.artist}`;
  if (cache.has(key)) return cache.get(key);
  const primaryArtist = src.artist.split(',')[0];
  let results = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    try { results = await search(`${src.title} ${primaryArtist}`); break; }
    catch (e) { if (attempt === 2 || (e?.code === 'YT_BLOCKED' || /limitado temporalmente/.test(e?.message))) throw e; await new Promise((ok) => setTimeout(ok, 2500 * (attempt + 1))); }
  }
  const ranked = results.slice(0, 8).map((c) => ({ track: c, score: score(src, c) })).sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const status = !best || best.score < 0.45 ? 'none' : best.score >= 0.78 ? 'ok' : 'doubt';
  const r = { status, score: best ? +best.score.toFixed(2) : 0, track: status === 'none' ? null : best.track, alternatives: ranked.slice(0, 5).map((x) => ({ ...x.track, _score: +x.score.toFixed(2) })) };
  cache.set(key, r);
  return r;
}
