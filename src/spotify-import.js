// Spotify → YouTube Music / BitChord playlist import from the "Account data" export (.zip).
// The export only has title / artist / album per track, so each one is looked up on YouTube Music
// and scored; doubtful matches are left for the user to review before anything is created.
import fs from 'node:fs';
import path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { tr } from './i18n.js';

const LIKED = '__liked__';

function fromPlaylistJson(json, out) {
  for (const p of json.playlists || []) {
    const tracks = [];
    let skipped = 0;
    for (const it of p.items || []) {
      const t = it.track;
      if (t && t.trackName) tracks.push({ title: t.trackName, artist: t.artistName || '', album: t.albumName || '', uri: t.trackUri || '' });
      else skipped++; // podcast episodes, local files, audiobooks
    }
    out.push({ key: 'pl:' + out.length + ':' + p.name, name: p.name || 'Playlist sin nombre', description: p.description || '', tracks, skipped, modified: p.lastModifiedDate || '' });
  }
}

function fromLibraryJson(json, out) {
  const tracks = (json.tracks || []).filter((t) => t.track).map((t) => ({ title: t.track, artist: t.artist || '', album: t.album || '', uri: t.uri || '' }));
  if (tracks.length) out.unshift({ key: LIKED, name: tr('Me gusta de Spotify'), description: tr('Tus «Canciones que te gustan» de Spotify'), tracks, skipped: 0, liked: true });
}

/** Reads a Spotify export (.zip, or Playlist*.json / YourLibrary.json). */
export function parse(file) {
  const out = [];
  const handle = (name, text) => {
    const base = path.basename(name);
    let json;
    try { json = JSON.parse(text.replace(/^﻿/, '')); } catch { return; }
    if (/^Playlist\d*\.json$/i.test(base) || Array.isArray(json.playlists)) fromPlaylistJson(json, out);
    else if (/^YourLibrary\.json$/i.test(base) || Array.isArray(json.tracks)) fromLibraryJson(json, out);
  };
  const buf = fs.readFileSync(file);
  if (/\.zip$/i.test(file) || (buf[0] === 0x50 && buf[1] === 0x4b)) {
    const files = unzipSync(new Uint8Array(buf), { filter: (f) => /(Playlist\d*|YourLibrary)\.json$/i.test(f.name) });
    // Playlist1.json, Playlist2.json… in order.
    for (const name of Object.keys(files).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))) handle(name, strFromU8(files[name]));
  } else handle(file, buf.toString('utf8'));
  if (!out.length) throw new Error(tr('No he encontrado playlists en ese archivo. Usa el .zip de «Datos de la cuenta» de Spotify (contiene Playlist1.json y YourLibrary.json).'));
  return out;
}

// ---------------------------------------------------------------- matching

const norm = (s) => String(s || '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
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

async function matchOne(src, search) {
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

let running = null;

/** Matches every track of the chosen playlists. onProgress({done,total}). Returns results per playlist key. */
export const matchTrack = matchOne;

export async function match(playlists, search, onProgress = () => {}) {
  if (running) throw new Error(tr('Ya hay una importación en curso'));
  const jobs = [];
  playlists.forEach((p) => p.tracks.forEach((t, i) => jobs.push({ key: p.key, i, t })));
  const results = Object.fromEntries(playlists.map((p) => [p.key, new Array(p.tracks.length)]));
  let done = 0, next = 0, cancelled = false, blocked = null;
  running = { cancel: () => { cancelled = true; } };
  const worker = async () => {
    while (!cancelled && next < jobs.length) {
      const j = jobs[next++];
      try { results[j.key][j.i] = await matchOne(j.t, search); }
      catch (e) {
        if ((e?.code === 'YT_BLOCKED' || /limitado temporalmente/.test(e?.message))) { cancelled = true; blocked = e; break; }
        results[j.key][j.i] = { status: 'none', score: 0, track: null, alternatives: [], error: e.message };
      }
      done++;
      if (done % 3 === 0 || done === jobs.length) onProgress({ done, total: jobs.length });
      await new Promise((ok) => setTimeout(ok, 350 + Math.random() * 300)); // be gentle with YouTube
    }
  };
  try { await Promise.all([worker(), worker()]); }
  finally { running = null; }
  if (blocked) throw blocked;
  if (cancelled) throw new Error(tr('Importación cancelada'));
  return results;
}

export function cancel() { running?.cancel(); }
