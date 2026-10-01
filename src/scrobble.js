// Scrobbling to ListenBrainz (user token) and Last.fm (user's own API key/secret + web auth).
import crypto from 'node:crypto';
import { shell } from 'electron';
import * as settings from './settings.js';

const artistOf = (t) => (t.artists || [])[0]?.name || '';

// ---------------------------------------------------------------- ListenBrainz
async function lb(type, t, listenedAt) {
  const token = settings.get('listenbrainzToken');
  if (!token) return;
  const payload = [{
    ...(listenedAt ? { listened_at: listenedAt } : {}),
    track_metadata: {
      artist_name: artistOf(t), track_name: t.title, release_name: t.album?.name || undefined,
      additional_info: { media_player: 'BitChord Desktop', submission_client: 'BitChord Desktop', music_service: 'music.youtube.com', origin_url: t.local ? undefined : `https://music.youtube.com/watch?v=${t.id}`, duration_ms: t.duration ? t.duration * 1000 : undefined },
    },
  }];
  const r = await fetch('https://api.listenbrainz.org/1/submit-listens', {
    method: 'POST', headers: { Authorization: `Token ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ listen_type: type, payload }),
  });
  if (!r.ok) console.warn('[listenbrainz]', r.status, await r.text().catch(() => ''));
}

export async function validateListenBrainz(token) {
  const r = await fetch('https://api.listenbrainz.org/1/validate-token', { headers: { Authorization: `Token ${token}` } });
  const j = await r.json().catch(() => ({}));
  return j.valid ? { ok: true, user: j.user_name } : { ok: false };
}

// ---------------------------------------------------------------- Last.fm
const LFM = 'https://ws.audioscrobbler.com/2.0/';
function sign(params, secret) {
  const keys = Object.keys(params).filter((k) => k !== 'format' && k !== 'callback').sort();
  return crypto.createHash('md5').update(keys.map((k) => k + params[k]).join('') + secret, 'utf8').digest('hex');
}
async function lfmCall(params, { post = false } = {}) {
  const key = settings.get('lastfmApiKey'), secret = settings.get('lastfmSecret');
  if (!key || !secret) throw new Error('Falta la API key / secret de Last.fm');
  const p = { ...params, api_key: key };
  p.api_sig = sign(p, secret);
  p.format = 'json';
  const body = new URLSearchParams(p);
  const r = await fetch(post ? LFM : `${LFM}?${body}`, post ? { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } } : {});
  const j = await r.json();
  if (j.error) throw new Error(`Last.fm: ${j.message}`);
  return j;
}

let lfmToken = null;
export async function lastfmBeginAuth() {
  const j = await lfmCall({ method: 'auth.getToken' });
  lfmToken = j.token;
  await shell.openExternal(`https://www.last.fm/api/auth/?api_key=${settings.get('lastfmApiKey')}&token=${lfmToken}`);
  return true;
}
export async function lastfmFinishAuth() {
  if (!lfmToken) throw new Error('Primero pulsa "Conectar"');
  const j = await lfmCall({ method: 'auth.getSession', token: lfmToken });
  settings.set({ lastfmSession: j.session.key, lastfmUser: j.session.name });
  lfmToken = null;
  return { user: j.session.name };
}
async function lfm(method, t, ts) {
  const sk = settings.get('lastfmSession');
  if (!sk) return;
  const p = { method, sk, artist: artistOf(t), track: t.title };
  if (t.album?.name) p.album = t.album.name;
  if (t.duration) p.duration = String(t.duration);
  if (ts) p.timestamp = String(ts);
  await lfmCall(p, { post: true });
}

// ---------------------------------------------------------------- session logic
let current = null; // {track, startedAt, played, scrobbled}

/** Called by the renderer every few seconds: {track, playing, position, duration}. */
export function tick(st) {
  if (!st?.track) { current = null; return; }
  const t = st.track;
  if (!current || current.track.id !== t.id || (st.position < 2 && current.played > 30)) {
    current = { track: t, startedAt: Math.floor(Date.now() / 1000), played: 0, scrobbled: false, lastPos: st.position, nowPlayingSent: false };
  }
  if (st.playing) {
    const d = st.position - current.lastPos;
    if (d > 0 && d < 10) current.played += d;
    if (!current.nowPlayingSent) {
      current.nowPlayingSent = true;
      lb('playing_now', t).catch((e) => console.warn('[lb]', e.message));
      lfm('track.updateNowPlaying', t).catch((e) => console.warn('[lfm]', e.message));
    }
  }
  current.lastPos = st.position;
  const dur = st.duration || t.duration || 0;
  const need = Math.min(240, (dur || 60) * (settings.get('scrobblePercent') / 100));
  if (!current.scrobbled && dur >= 30 && current.played >= need) {
    current.scrobbled = true;
    lb('single', t, current.startedAt).catch((e) => console.warn('[lb]', e.message));
    lfm('track.scrobble', t, current.startedAt).catch((e) => console.warn('[lfm]', e.message));
  }
}
