// Persistent settings (userData/settings.json), shared by main and renderer.
import fs from 'node:fs';
import path from 'node:path';

export const LYRICS_PROVIDERS = [
  { id: 'lyricsplus', label: 'LyricsPlus', detail: 'Sílaba a sílaba, en espejos comunitarios', word: true },
  { id: 'betterlyrics', label: 'BetterLyrics', detail: 'Tiempos de Apple Music, palabra a palabra', word: true },
  { id: 'simpmusic', label: 'SimpMusic', detail: 'Emparejada con el vídeo exacto', word: true },
  { id: 'unison', label: 'Unison', detail: 'Aportadas por la comunidad', word: true },
  { id: 'betterlyrics_qq', label: 'BetterLyrics Portato', detail: 'Karaoke de QQ Music', word: true },
  { id: 'lrclib', label: 'LRCLIB', detail: 'Por líneas, siempre disponible', word: false },
  { id: 'kugou', label: 'KuGou', detail: 'Por líneas, fuerte fuera del catálogo inglés', word: false },
  { id: 'youtube', label: 'YouTube Music', detail: 'Texto sin sincronizar de la pestaña Letra', word: false },
];

export const SIDEBAR_DEFAULT = [
  { id: 'search', on: true }, { id: 'home', on: true }, { id: 'library', on: true },
  { id: 'lib:local', on: true }, { id: 'lib:playlists', on: true }, { id: 'lib:likes', on: false }, { id: 'lib:downloads', on: true },
  { id: 'lib:network', on: false }, { id: 'lib:history', on: false }, { id: 'lib:account', on: false },
  { id: 'nowplaying', on: false }, { id: 'queue', on: false },
];

export const DEFAULTS = {
  sidebar: SIDEBAR_DEFAULT,
  sidebarMode: 'fixed', // fixed | hover | button
  sidebarOpen: true, // for 'button' mode
  localInfo: { format: true, bitrate: true, sampleRate: true, bitDepth: true, channels: false, size: true, year: false, genre: false, album: true, path: false },
  // Audio
  streamQuality: 'max', // low | normal | high | max
  downloadQuality: 'max',
  downloadFormat: 'opus', // opus | m4a
  downloadDir: '',
  crossfade: 4, // seconds 0-12
  gapless: true,
  automix: true,
  automixBars: 8,
  normalize: true,
  skipSilence: false,
  speed: 1,
  eqEnabled: true,
  eqPreset: 'rock',
  eqBands: [4, 3, 2, 0, -1, -1, 1, 3, 4, 4],
  preamp: 0,
  // Lyrics
  lyricsOrder: LYRICS_PROVIDERS.map((p) => p.id),
  lyricsDisabled: [],
  lyricsWordSync: true,
  lyricsFontSize: 30,
  lyricsOffsetMs: 0,
  // Playback behaviour
  autoplayRadio: true,
  resumeOnStart: true,
  trackCols: { num: false, thumb: true, artists: true, album: true, duration: true }, // columns of song lists (albums, playlists…)
  playlistOrder: [], // ['yt:ID'…] order chosen by dragging in Biblioteca -> Playlists
  hiddenPlaylists: [{ id: 'VLSE', title: 'Episodios para más tarde' }, { id: 'LM', title: 'Me gusta' }], // [{ id, title }] YouTube Music playlists hidden in BitChord (ones YouTube won't delete)
  windowButtons: 'mac', // 'mac' (red/yellow/green, drawn by the app, on the left) | 'windows' (native)
  closeToTray: false,
  // Integrations
  discordRpc: true,
  listenbrainzToken: '',
  lastfmApiKey: '',
  lastfmSecret: '',
  lastfmSession: '',
  lastfmUser: '',
  scrobblePercent: 50,
  // Sources
  sourceJioSaavn: true,
  // Library
  localFolders: [],
  localWatch: true,
  theme: 'default', // 'default' (BitChord) or the id of one of customThemes
  customThemes: [], // [{ id, name, css }] made in Ajustes > Tema
  npLyricsHidden: false,
  homeHidden: ['forgotten'],
  performanceMode: false, // no glass, moving backgrounds, visualizer, animated covers or animations
  animatedCovers: true, // looping video on the big artwork when the release has one (src/canvas.js)
  ambient: true,
  ambientMode: 'cover',
  ambientIntensity: 55,
  ambientBlur: 110,
  ambientSpeed: 75,
  ambientSize: 100,
  ambientSaturation: 125,
  micaSidebar: true,
  micaQueue: true,
  micaPlayer: true,
  micaLyrics: true,
  // MilkDrop visualizer of the cover and lyrics view.
  visualizer: false,
  visPreset: 'martin - ghost city',
  visAuto: 'song', // 'song' | seconds ('30', '60') | 'off'
  visFavorites: [ // preset names marked with the star
    'Geiss - Color Pox (Acid Impression Mix) (color saturation remix)', '$$$ Royal - Mashup (307)', 'Zylot - Star Ornament',
    'suksma - heretical crosscut playpen', 'flexi - jelly fish mandala',
    'flexi - patternton, district of media, capitol of the united abstractions of fractopia', 'martin - reflections on black tiles',
    'Flexi - alien fader', 'martin - gate to moria', 'martin - extreme heat',
  ],
  appleEmoji: true, // Apple's emoji (when its font file is on this PC)
  uiFont: 'sf', // 'default' (Inter) | 'sf' (SF Pro Display, the user's own files; Inter while they aren't there)
  circleMode: false, // "Círculo" view (Trap Nation style), instead of cover and lyrics
  circleGain: 0.2, // how strongly the aura reacts to the music
  circleSize: 1,
  circlePulse: 1, // how much the cover beats with the bass
  circleParticles: true,
  circleShake: true,
  circleColor: 'cover', // 'cover' | 'white'
  circleBg: 'cover', // 'cover' (blurred cover) | 'black'
  visUseFavs: false, // "Favoritos" tab: random and automatic changes only among the favourites
  // Buttons shown in full-screen mode (Ajustes de pantalla completa, the gear in that mode).
  fsButtons: { queue: true, eq: true, more: true, lyricsSource: true, lyricsToggle: true, like: true, shuffle: true, repeat: true, vis: true, circle: true },
  micaTint: 30,
  micaBlur: 30,
  micaSaturation: 190,
  dynamicAccent: true,
  accentMode: null, // 'cover' | 'theme' | 'custom' (null = from dynamicAccent)
  customAccent: '#fa2d48',
  uiLanguage: 'es', // interface language (Ajustes > General); 'language' is YouTube Music's
  language: 'es',
  region: 'ES',
};

let file = null;
let data = { ...DEFAULTS };
const listeners = new Set();

export function load(userData) {
  file = path.join(userData, 'settings.json');
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    data = { ...DEFAULTS, ...saved, localInfo: { ...DEFAULTS.localInfo, ...(saved.localInfo || {}) } };
    // New providers added in later versions go to the end of the saved order.
    const known = new Set(data.lyricsOrder);
    for (const p of LYRICS_PROVIDERS) if (!known.has(p.id)) data.lyricsOrder.push(p.id);
    data.lyricsOrder = data.lyricsOrder.filter((id) => LYRICS_PROVIDERS.some((p) => p.id === id));
    const ids = new Set(SIDEBAR_DEFAULT.map((x) => x.id));
    data.sidebar = (Array.isArray(data.sidebar) ? data.sidebar : []).filter((x) => ids.has(x.id));
    for (const d of SIDEBAR_DEFAULT) if (!data.sidebar.some((x) => x.id === d.id)) data.sidebar.push({ ...d });
  } catch {
    data = { ...DEFAULTS };
  }
  return data;
}

export const get = (k) => (k ? data[k] : { ...data });

export function set(patch) {
  data = { ...data, ...patch };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2));
    fs.renameSync(file + '.tmp', file);
  } catch (e) { console.error('[settings] save failed', e); }
  for (const fn of listeners) { try { fn(patch, data); } catch (e) { console.error(e); } }
  return data;
}

export const onChange = (fn) => listeners.add(fn);

/** Bitrate ceiling (kbps) for a quality name. */
export const maxKbps = (q) => ({ low: 64, normal: 96, high: 160, max: 9999 }[q] ?? 9999);
