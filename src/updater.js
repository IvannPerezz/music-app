// Updates published as GitHub releases (the public repo IvannPerezz/music-app, `npm run release`):
// the latest release's tag is compared with this version; its installer (the .exe asset) is
// downloaded to the temp folder, checked against the SHA-256 GitHub lists for it, and run with
// --auto (it installs by itself and opens BitChord again) while BitChord closes.
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tr } from './i18n.js';

export const REPO = 'IvannPerezz/music-app';
const UA = 'BitChord-Desktop (updater)';

let latest = null;   // the release found by check()
let ready = null;    // path of the downloaded, verified installer
let aborter = null;

/** 1 if a is newer than b, -1 if older, 0 if equal ("0.6.55.2" style, any number of parts). */
export function compare(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0), pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** The newest release, if it's newer than `current`: { available, version, changes, size, page }.
 *  `changes` lists every version since `current` (newest first), so someone a few versions
 *  behind sees all of what's new, not just the last one. */
export async function check(current) {
  if (process.env.BITCHORD_MOCK) return mockCheck(current);
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': UA }, signal: AbortSignal.timeout(10000),
  });
  if (r.status === 404) return { available: false, current }; // nothing published yet
  if (!r.ok) throw new Error(tr('GitHub respondió {s} al buscar actualizaciones.', { s: r.status }));
  const newer = (await r.json())
    .filter((x) => !x.draft && !x.prerelease)
    .map((x) => ({ x, version: String(x.tag_name || '').replace(/^v/i, ''), asset: (x.assets || []).find((a) => /\.exe$/i.test(a.name)) }))
    .filter((e) => e.version && compare(e.version, current) > 0)
    .sort((a, b) => compare(b.version, a.version));
  const top = newer.find((e) => e.asset);
  if (!top) return { available: false, current };
  const changes = newer.map((e) => ({ version: e.version, notes: String(e.x.body || '').trim() }));
  latest = {
    version: top.version, url: top.asset.browser_download_url, size: top.asset.size || 0,
    sha256: /^sha256:([0-9a-f]{64})$/i.exec(top.asset.digest || '')?.[1]?.toLowerCase() || null, page: top.x.html_url,
  };
  if (ready && !ready.includes(`-${top.version}.exe`)) ready = null;
  return { available: true, current, version: top.version, changes, size: latest.size, page: latest.page };
}

/** Downloads the installer, reporting (received, total) bytes; resolves once it's verified. */
export async function download(onProgress) {
  if (!latest) throw new Error(tr('Busca antes las actualizaciones.'));
  if (process.env.BITCHORD_MOCK) return mockDownload(onProgress);
  const file = path.join(app.getPath('temp'), `BitChord-Instalar-${latest.version}.exe`);
  const part = file + '.part';
  aborter = new AbortController();
  try {
    const r = await fetch(latest.url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: aborter.signal });
    if (!r.ok || !r.body) throw new Error(tr('No se pudo descargar la actualización (HTTP {s}).', { s: r.status }));
    const total = +r.headers.get('content-length') || latest.size;
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(part);
    let got = 0, sent = 0;
    try {
      for await (const chunk of r.body) {
        hash.update(chunk);
        if (!out.write(chunk)) await once(out, 'drain');
        got += chunk.length;
        if (got - sent > 256 * 1024 || got === total) { sent = got; onProgress?.(got, total); }
      }
    } finally { await new Promise((ok) => out.end(ok)); }
    if (total && got !== total) throw new Error(tr('La descarga se ha cortado. Vuelve a intentarlo.'));
    if (latest.sha256 && hash.digest('hex') !== latest.sha256) throw new Error(tr('La descarga no coincide con la publicada en GitHub. Vuelve a intentarlo.'));
    fs.rmSync(file, { force: true });
    fs.renameSync(part, file);
    ready = file;
    console.log('[update] descargada la v' + latest.version, latest.sha256 ? '(SHA-256 comprobado)' : '(sin SHA-256 publicado)');
    return true;
  } catch (e) {
    fs.rmSync(part, { force: true });
    if (aborter?.signal.aborted) throw new Error(tr('Descarga cancelada.'));
    throw e;
  } finally { aborter = null; }
}

export function cancel() { aborter?.abort(); return true; }

/** Starts the downloaded installer on its own (it outlives BitChord); the caller then quits. */
export function install() {
  if (!ready || !fs.existsSync(ready)) throw new Error(tr('Descarga antes la actualización.'));
  if (process.env.BITCHORD_MOCK) { console.log('[update] (prueba) se ejecutaría', ready); return true; }
  // (From the temp folder: started from BitChord's own folder, it couldn't empty it.)
  const p = spawn(ready, ['--auto'], { cwd: path.dirname(ready), detached: true, stdio: 'ignore', windowsHide: false });
  p.unref();
  console.log('[update] instalador lanzado:', ready);
  return true;
}

// ---- test data (npm run mock with BITCHORD_MOCK_UPDATE=1): a fake newer release
function mockCheck(current) {
  if (!process.env.BITCHORD_MOCK_UPDATE) return { available: false, current };
  const many = +process.env.BITCHORD_MOCK_UPDATE > 1;
  latest = { version: '9.9.9', url: '', size: 140 * 1048576, sha256: null, page: '' };
  const changes = [{ version: '9.9.9', notes: '- Una novedad de prueba con una explicación que ocupa más de una línea en el\n  archivo de cambios, para ver que se lee entera.\n- Y un arreglo pequeño.' }];
  if (many) {
    changes.push({ version: '9.9.8', notes: Array.from({ length: 6 }, (_, i) => `- Cambio ${i + 1} de la versión anterior, contado con algo de detalle.`).join('\n') });
    changes.push({ version: '9.9.7', notes: Array.from({ length: 5 }, (_, i) => `- Otro cambio (${i + 1}).`).join('\n') });
  }
  return { available: true, current, version: latest.version, changes, size: latest.size, page: '' };
}
async function mockDownload(onProgress) {
  const total = latest.size;
  for (let got = 0; got <= total; got += total / 20) { onProgress?.(Math.min(got, total), total); await new Promise((ok) => setTimeout(ok, 60)); }
  ready = path.join(app.getPath('temp'), 'mock-update.exe');
  fs.writeFileSync(ready, '');
  return true;
}
