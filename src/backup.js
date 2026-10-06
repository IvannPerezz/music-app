// Ajustes → Copia de la configuración: everything the user has set up, in one .bitchord file
// (a zip) to take to another PC. Sign-ins (Google, Last.fm, ListenBrainz, Spotify's permission)
// are left out: they're encrypted for this PC and are credentials anyway.
import fs from 'node:fs';
import path from 'node:path';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { tr } from './i18n.js';

// Settings that belong to this PC or are credentials.
const SKIP_SETTINGS = ['windowBounds', 'listenbrainzToken', 'lastfmSession', 'lastfmUser', 'lastfmSecret', 'lastfmApiKey'];
// localStorage (bc.*) keys that are playback state rather than customisation.
const SKIP_LOCAL = ['queue', 'resumeAt', 'history', 'homeSeen'];
const FILES = ['local-folders.json', 'yt-playlist-covers.json'];
const COVERS = 'playlist-covers';

const readJson = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };

export function build(userData, settings, localStore, version) {
  const files = {};
  const s = settings.get();
  for (const k of SKIP_SETTINGS) delete s[k];
  files['settings.json'] = strToU8(JSON.stringify(s, null, 1));
  const local = Object.fromEntries(Object.entries(localStore || {}).filter(([k]) => k.startsWith('bc.') && !SKIP_LOCAL.includes(k.slice(3))));
  files['local-storage.json'] = strToU8(JSON.stringify(local));
  for (const f of FILES) { const p = path.join(userData, f); if (fs.existsSync(p)) files[f] = new Uint8Array(fs.readFileSync(p)); }
  const sp = readJson(path.join(userData, 'spotify.json'));
  if (sp) { const { token, user, ...rest } = sp; files['spotify.json'] = strToU8(JSON.stringify(rest)); }
  const dir = path.join(userData, COVERS);
  let covers = 0;
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) {
    if (!/\.jpg$/i.test(f)) continue;
    files[`${COVERS}/${f}`] = new Uint8Array(fs.readFileSync(path.join(dir, f)));
    covers++;
  }
  const manifest = { app: 'BitChord', format: 1, version, created: Date.now(), covers, themes: (s.customThemes || []).length, spotifyLinks: (sp?.links || []).length };
  files['manifest.json'] = strToU8(JSON.stringify(manifest));
  return { data: zipSync(files, { level: 6 }), manifest };
}

export function read(file) {
  let files;
  try { files = unzipSync(new Uint8Array(fs.readFileSync(file))); } catch { throw new Error(tr('Ese archivo no es una copia de configuración de BitChord.')); }
  const manifest = files['manifest.json'] && JSON.parse(strFromU8(files['manifest.json']));
  if (manifest?.app !== 'BitChord') throw new Error(tr('Ese archivo no es una copia de configuración de BitChord.'));
  return { files, manifest };
}

/** Writes a backup over this PC's configuration. Returns the localStorage entries for the window. */
export function apply(userData, settings, { files }) {
  const imported = JSON.parse(strFromU8(files['settings.json'] || strToU8('{}')));
  for (const k of SKIP_SETTINGS) delete imported[k];
  settings.set(imported);
  for (const f of FILES) if (files[f]) fs.writeFileSync(path.join(userData, f), files[f]);
  if (files['spotify.json']) {
    const incoming = JSON.parse(strFromU8(files['spotify.json']));
    const here = readJson(path.join(userData, 'spotify.json'), {}) || {};
    // Keep this PC's Spotify permission if it's the same developer app.
    const keep = here.token && here.clientId === incoming.clientId ? { token: here.token, user: here.user } : {};
    fs.writeFileSync(path.join(userData, 'spotify.json'), JSON.stringify({ ...incoming, ...keep }));
  }
  const dir = path.join(userData, COVERS);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    if (!name.startsWith(COVERS + '/')) continue;
    const base = path.basename(name);
    if (/^[\w-]+\.jpg$/i.test(base)) fs.writeFileSync(path.join(dir, base), data);
  }
  return files['local-storage.json'] ? JSON.parse(strFromU8(files['local-storage.json'])) : {};
}
