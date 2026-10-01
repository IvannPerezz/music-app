// Builds the app archive and, with --deploy, hands it to the installed BitChord as an update.
//
//   node scripts/build-update.mjs            -> dist/update.bin
//   node scripts/build-update.mjs --deploy   -> also copies it to the installation:
//        %LOCALAPPDATA%\Programs\BitChord\resources\update.bin  (+ CAMBIOS.txt next to BitChord.exe)
//
// The installed loader.js renames update.bin to resources\app-<time>.asar the next time BitChord
// starts and points resources\current.txt at it. Never overwrite resources\app.asar directly:
// Windows keeps it locked while BitChord (or any Electron app that looked inside it) is open.
import fs from 'node:fs';
import path from 'node:path';
import { root, pkg, buildAsar, changelogCRLF } from './stage-app.mjs';

const out = path.join(root, 'dist', 'update.bin');
await buildAsar(out, path.join(root, 'dist', '.stage'));
console.log(`OK ${out} (v${pkg.version}, ${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);

if (process.argv.includes('--deploy')) {
  const inst = process.env.BITCHORD_INSTALL_DIR || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'BitChord');
  if (!fs.existsSync(path.join(inst, 'BitChord.exe'))) throw new Error(`No encuentro BitChord instalado en ${inst}`);
  fs.copyFileSync(out, path.join(inst, 'resources', 'update.bin'));
  fs.writeFileSync(path.join(inst, 'CAMBIOS.txt'), changelogCRLF());
  console.log(`Actualización v${pkg.version} copiada a ${inst}. Cierra y abre BitChord para aplicarla.`);
}
