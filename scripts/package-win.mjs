// Builds a portable Windows x64 folder + zip: BitChord/BitChord.exe
// Usage: node scripts/package-win.mjs <outDir>
// (Uses the devDependencies @electron/get, @electron/asar and resedit.)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import { root, pkg, buildAsar, changelogCRLF } from './stage-app.mjs';

const require = createRequire(import.meta.url);
const { downloadArtifact } = require('@electron/get');
const ResEdit = require('resedit');
const electronVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/electron/package.json'), 'utf8')).version;

// Cross-platform zip helpers (no unzip/zip binaries needed on Windows).
function unzipTo(zipFile, dir) {
  const files = unzipSync(new Uint8Array(fs.readFileSync(zipFile)));
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith('/')) continue;
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
  }
}
function zipDir(dir, zipFile) {
  const base = path.dirname(dir), tree = {};
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else tree[path.relative(base, p).split(path.sep).join('/')] = new Uint8Array(fs.readFileSync(p));
    }
  })(dir);
  fs.writeFileSync(zipFile, zipSync(tree, { level: 9 }));
}

const outDir = path.resolve(process.argv[2] || path.join(root, 'dist'));
const appDir = path.join(outDir, 'BitChord');
const stage = path.join(outDir, '.stage');

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

console.log(`Electron ${electronVersion} win32-x64…`);
const zip = await downloadArtifact({ version: electronVersion, platform: 'win32', arch: 'x64', artifactName: 'electron' });
unzipTo(zip, appDir);
fs.renameSync(path.join(appDir, 'electron.exe'), path.join(appDir, 'BitChord.exe'));
fs.rmSync(path.join(appDir, 'resources', 'default_app.asar'), { force: true });
// Trim: only Spanish/English UI locales; no WebGPU shader compiler (unused by an audio app).
for (const f of fs.readdirSync(path.join(appDir, 'locales'))) {
  if (!/^(es|es-419|en-US|en-GB)\.pak$/.test(f)) fs.rmSync(path.join(appDir, 'locales', f));
}
for (const f of ['dxcompiler.dll', 'dxil.dll']) fs.rmSync(path.join(appDir, f), { force: true });

// App payload: sources + production node_modules.
await buildAsar(path.join(appDir, 'resources', 'app.asar'), stage);

// Icon + version info on the exe.
const exePath = path.join(appDir, 'BitChord.exe');
const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath));
const res = ResEdit.NtExecutableResource.from(exe);
const ico = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(root, 'build', 'icon.ico')));
const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
const iconId = groups.length ? groups[0].id : 1;
const lang = groups.length ? groups[0].lang : 1033;
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, iconId, lang, ico.icons.map((i) => i.data));
const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
const [ma, mi, pa, bu = 0] = pkg.version.split('.').map(Number);
vi.setFileVersion(ma, mi, pa, bu, 1033);
vi.setProductVersion(ma, mi, pa, bu, 1033);
vi.setStringValues({ lang: 1033, codepage: 1200 }, {
  FileDescription: 'BitChord', ProductName: 'BitChord', InternalName: 'BitChord', OriginalFilename: 'BitChord.exe',
  CompanyName: 'BitChord Desktop', LegalCopyright: 'GPL-3.0',
});
vi.outputToResourceEntries(res.entries);
res.outputResource(exe);
fs.writeFileSync(exePath, Buffer.from(exe.generate()));

fs.writeFileSync(path.join(appDir, 'LEEME.txt'), [
  `BitChord para Windows v${pkg.version}`,
  '',
  'Cómo abrirlo: doble clic en BitChord.exe',
  '',
  'Si Windows muestra "Windows protegió su PC", pulsa "Más información" y luego "Ejecutar de todas formas"',
  '(la app no está firmada digitalmente).',
  '',
  'Atajos: Espacio = play/pausa · Ctrl+←/→ = anterior/siguiente · ←/→ = ±5 s · ↑/↓ = volumen',
  '        L = letra · Q = cola · S = aleatorio · R = repetir · M = silenciar · Ctrl+F = buscar',
  '',
  'Registro para diagnosticar problemas: %APPDATA%\\BitChord\\bitchord.log (o "Ver registro" en la barra lateral).',
  '',
  'Basado en BitChord (https://github.com/kushagrasinghx/BitChord), licencia GPL-3.0.',
  'No está afiliado a YouTube ni a Google.',
].join('\r\n'));

fs.rmSync(stage, { recursive: true, force: true });
zipDir(appDir, path.join(outDir, 'BitChord-Windows-x64.zip'));
console.log('OK', path.join(outDir, 'BitChord-Windows-x64.zip'));

// Light installer (< 30 MB): app.asar + scripts that download Electron on the user's PC.
const inst = path.join(outDir, 'BitChord-Instalador');
fs.mkdirSync(inst, { recursive: true });
for (const f of fs.readdirSync(path.join(root, 'installer'))) fs.copyFileSync(path.join(root, 'installer', f), path.join(inst, f));
fs.copyFileSync(path.join(appDir, 'resources', 'app.asar'), path.join(inst, 'app.asar'));
fs.copyFileSync(path.join(root, 'build', 'icon.ico'), path.join(inst, 'icon.ico'));
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(inst, 'LICENSE'));
fs.writeFileSync(path.join(inst, 'CAMBIOS.txt'), changelogCRLF());
const ps = fs.readFileSync(path.join(inst, 'instalar.ps1'), 'utf8');
if (!ps.includes(`$ElectronVersion = '${electronVersion}'`)) throw new Error('installer/instalar.ps1 targets a different Electron version');
zipDir(inst, path.join(outDir, 'BitChord-Instalador.zip'));
console.log('OK', path.join(outDir, 'BitChord-Instalador.zip'));
