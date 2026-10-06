// Offline fixtures used only when BITCHORD_MOCK=1 (UI development without network).
import http from 'node:http';
import { serveVisualizer } from './vis-files.js';

const palette = [['#ff5f6d', '#ffc371'], ['#2193b0', '#6dd5ed'], ['#8e2de2', '#4a00e0'], ['#11998e', '#38ef7d'], ['#fc4a1a', '#f7b733'], ['#ee0979', '#ff6a00'], ['#3a1c71', '#d76d77'], ['#1f4037', '#99f2c8']];
const art = (i) => {
  const [a, b] = palette[i % palette.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="400" height="400" fill="url(#g)"/><circle cx="${120 + (i * 37) % 160}" cy="${140 + (i * 53) % 120}" r="${60 + (i * 13) % 50}" fill="#fff" fill-opacity=".18"/></svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
};
const names = ['Luz de Neón', 'Midnight Drive', 'Olas', 'Paper Planes', 'Ciudad Dormida', 'Golden Hour', 'Satélites', 'Echoes', 'Verano Eterno', 'Afterglow', 'Nubes Rosas', 'Static Hearts'];
const artistsN = ['Lúa Vega', 'The Night Owls', 'Marea Alta', 'Kite Club', 'Solenne'];
const track = (i) => ({
  kind: 'track', id: ('mockvideo' + String(i).padStart(2, '0')).slice(0, 11), title: names[i % names.length],
  artists: [{ name: artistsN[i % artistsN.length], id: 'UCmock' + (i % artistsN.length) }],
  album: { id: 'MPREmock' + (i % 4), name: 'Álbum ' + (i % 4 + 1) }, duration: 40, thumb: art(i),
});
const card = (kind, i) => ({ kind, id: (kind === 'album' ? 'MPREmock' : kind === 'artist' ? 'UCmock' : 'PLmock') + i, title: kind === 'artist' ? artistsN[i % 5] : names[(i + 3) % names.length], subtitle: kind === 'album' ? `Álbum · ${artistsN[i % 5]}` : kind === 'artist' ? '1,2 M suscriptores' : 'Playlist · YouTube Music', thumb: art(i + 2) });

export const configure = () => {};
export const client = async () => ({});
export const home = async () => [
  { title: 'Selección rápida', layout: 'list', items: Array.from({ length: 8 }, (_, i) => ({ ...track(i), feedback: { item: 'fbitem' + i, artist: 'fbartist' + i } })) },
  { title: 'Álbumes para ti', layout: 'cards', items: Array.from({ length: 8 }, (_, i) => card('album', i)) },
  { title: 'Mixes', layout: 'cards', items: Array.from({ length: 6 }, (_, i) => card('playlist', i)) },
  { title: 'Artistas', layout: 'cards', items: Array.from({ length: 5 }, (_, i) => card('artist', i)) },
];
export const search = async (q) => [
  ...(q === 'lua vegaa' ? [{ layout: 'correction', title: '', items: [], query: 'lua vega', auto: true }] : []),
  { title: 'Resultado principal', layout: 'top', top: { kind: 'artist', id: 'UCmock0', title: 'Lúa Vega', subtitle: 'Artista · 1,2 M de oyentes mensuales', thumb: art(5) }, items: Array.from({ length: 4 }, (_, i) => track(i)) },
  { title: 'Canciones · Lúa Vega', layout: 'list', items: Array.from({ length: 5 }, (_, i) => track(i)), artistId: 'UCmock0' },
  { title: 'Álbumes · Lúa Vega', layout: 'cards', items: Array.from({ length: 4 }, (_, i) => card('album', i)), artistId: 'UCmock0' },
  { title: 'Canciones', layout: 'list', items: Array.from({ length: 6 }, (_, i) => track(i + 2)) },
  { title: 'Álbumes', layout: 'cards', items: Array.from({ length: 6 }, (_, i) => card('album', i)) },
];
export const suggestions = async (q) => [q + ' remix', q + ' en vivo', q + ' acústico'];
const detail = (kind, id) => ({ kind, id, title: kind === 'album' ? 'Álbum 1' : 'Mix de la semana', subtitle: 'Lúa Vega · 2025', meta: '10 canciones · 38 min', thumb: art(3), tracks: Array.from({ length: 10 }, (_, i) => track(i)), sections: [] });
export const album = async (id) => detail('album', id);
export const playlist = async (id) => detail('playlist', id);
export const artist = async (id) => ({ kind: 'artist', id, title: 'Lúa Vega', subtitle: '1,2 M suscriptores', thumb: art(5), sections: [{ title: 'Canciones', layout: 'list', items: Array.from({ length: 5 }, (_, i) => track(i)) }, { title: 'Álbumes', layout: 'cards', items: Array.from({ length: 4 }, (_, i) => card('album', i)) }] });
export const upNext = async (id) => Array.from({ length: 10 }, (_, i) => track(i + 5));
export const resolveStream = async () => true;
export const streamInfo = () => ({ mime: 'audio/wav', codec: 'pcm', bitrate: 705, client: 'MOCK' });
export const signedIn = () => false;
export const accountInfo = async () => null;
export const library = async () => ({ playlists: Array.from({ length: 4 }, (_, i) => card('playlist', i)), albums: Array.from({ length: 3 }, (_, i) => card('album', i)), artists: Array.from({ length: 3 }, (_, i) => card('artist', i)) });
export const history = async () => Array.from({ length: 6 }, (_, i) => track(i + 1));
export const rate = async () => true;
const mockLines = ['Bajo la luz de neón', 'la ciudad se queda en calma', 'y tu voz en la canción', 'me devuelve el alma', '', 'Cruzamos la avenida', 'sin mirar atrás', 'la noche está encendida', 'y no hay nada más'];
export const fetchLyrics = async (t, provider) => {
  if (/Paper Planes/.test(t?.title || '')) return null; // a song without lyrics (tests)
  if (provider === 'lyricsplus') {
    // word-synced sample
    return { format: 'lyricsplus', data: { lyrics: mockLines.filter(Boolean).map((text, i) => {
      const t0 = 1500 + i * 3000; const words = text.split(' ');
      return { time: t0, duration: 2600, text, syllabus: words.map((w, k) => ({ time: t0 + k * 450, duration: 420, text: w + (k < words.length - 1 ? ' ' : '') })) };
    }) } };
  }
  if (provider === 'lrclib') return { format: 'lrc', data: mockLines.map((l, i) => `[00:${String(1 + i * 3).padStart(2, '0')}.50]${l}`).join('\n') };
  return null;
};
function wav(seconds, freq) {
  const rate = 22050, n = rate * seconds, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * i / rate) * 3000 * Math.min(1, (n - i) / rate)), 44 + i * 2);
  return buf;
}

function beatTrack(seconds, bpm, seed) {
  const rate = 22050, n = rate * seconds, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  const x = new Float32Array(n);
  const beat = 60 / bpm, lead = 1;
  for (let t = lead, k = 0; t < seconds - 3; t += beat, k++) {
    const s = Math.round(t * rate);
    for (let i = 0; i < rate * 0.15 && s + i < n; i++) x[s + i] += (k % 4 === 0 ? 0.9 : 0.6) * Math.exp(-i / (rate * 0.03)) * Math.sin(2 * Math.PI * (55 + 90 * Math.exp(-i / (rate * 0.01))) * i / rate);
    const h = Math.round((t + beat / 2) * rate);
    for (let i = 0; i < rate * 0.03 && h + i < n; i++) x[h + i] += 0.12 * Math.exp(-i / (rate * 0.005)) * (Math.random() * 2 - 1);
  }
  const root = [220, 246.9, 261.6, 293.7, 329.6][seed % 5];
  for (let i = Math.round(lead * rate); i < n - rate * 3; i++) x[i] += 0.06 * Math.sin(2 * Math.PI * root * i / rate) + 0.04 * Math.sin(2 * Math.PI * root * 1.5 * i / rate);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(x[i] * 20000))), 44 + i * 2);
  return buf;
}
const cache = new Map();
export function startProxy() {
  const server = http.createServer(async (req, res) => {
    if (serveVisualizer(req.url.split('?')[0], res)) return;
    if (req.url.startsWith('/plcover/')) {
      const { coverPath } = await import('./playlists.js');
      const fs = await import('node:fs');
      const p = coverPath(req.url.split('?')[0].split('/')[2]);
      if (!fs.existsSync(p)) return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Access-Control-Allow-Origin': '*' });
      return res.end(fs.readFileSync(p));
    }
    const id = (req.url.split('?')[0].split('/')[2]) || '';
    const seed = parseInt(id.replace(/\D/g, '') || '0', 10);
    if (!cache.has(seed)) cache.set(seed, beatTrack(40, 118 + (seed % 5) * 3, seed));
    const data = cache.get(seed);
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    const start = m && m[1] ? +m[1] : 0, end = m && m[2] ? +m[2] : data.length - 1;
    res.writeHead(m ? 206 : 200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, ...(m ? { 'Content-Range': `bytes ${start}-${end}/${data.length}` } : {}) });
    res.end(data.subarray(start, end + 1));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, port: server.address().port })));
}

export const searchSongs = async (q) => {
  await new Promise((ok) => setTimeout(ok, 40));
  const words = q.toLowerCase().split(/\s+/);
  const base = Array.from({ length: 12 }, (_, i) => track(i));
  // Pretend YouTube Music finds songs whose mock title shares a word with the query, else a random one.
  const hits = base.filter((t) => words.some((w) => t.title.toLowerCase().includes(w)));
  if (/zzz/.test(q)) return [];
  // (Each query gives its own ids, so different songs never collapse into one.)
  const tag = [...q].reduce((s, c) => (s * 31 + c.charCodeAt(0)) % 100, 7);
  return (hits.length ? hits : [base[q.length % 12]]).map((t) => ({ ...t, id: (t.id.slice(0, 9) + String(tag).padStart(2, '0')).slice(0, 11) }));
};
export const createAccountPlaylist = async (title, ids, { onProgress = () => {} } = {}) => { for (let i = 0; i <= ids.length; i += 50) { onProgress(Math.min(i, ids.length)); await new Promise((ok) => setTimeout(ok, 50)); } return 'PLmock' + title.length; };
export const accountPlaylists = async () => Array.from({ length: 4 }, (_, i) => card('playlist', i));
export const addToAccountPlaylist = async (id, ids) => ids.length;
export const removeFromAccountPlaylist = async (id, ids) => ids.length;
// The first account playlist behaves like a special list YouTube won't delete.
export const renameAccountPlaylist = async () => true;
export const describeAccountPlaylist = async () => true;
export const sendFeedback = async () => true;
export const deleteAccountPlaylist = async (id) => { if (id === 'PLmock0') throw new Error('Request to https://www.youtube.com/youtubei/v1/playlist/delete failed with status code 400'); return true; };
