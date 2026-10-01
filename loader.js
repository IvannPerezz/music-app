// BitChord Desktop — startup loader.
//
// Updates are delivered as resources\update.bin. A running Windows process (BitChord itself, or
// any other program that peeked into the archive) can keep app.asar locked, so instead of
// replacing it we give every version its own archive name (app-<time>.asar), point
// resources\current.txt at it and load the app from there. Nothing that is in use ever has to be
// overwritten, and the app.asar shipped by the installer stays as the fallback.
import { app } from 'electron';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const bundled = path.join(here, 'main.js');
let entry = bundled;
let note = '';

const testRes = process.env.BITCHORD_TEST_RESOURCES; // automated tests only
if (app.isPackaged || testRes) {
  const ofs = require('original-fs'); // plain file system, no asar magic
  const res = testRes || process.resourcesPath;
  const ptr = path.join(res, 'current.txt');
  try {
    const pending = path.join(res, 'update.bin');
    if (ofs.existsSync(pending) && ofs.statSync(pending).size > 1_000_000) {
      const name = `app-${Date.now()}.asar`;
      ofs.renameSync(pending, path.join(res, name));
      ofs.writeFileSync(ptr, name);
      note = `actualización instalada (${name})`;
    }
    const cur = ofs.existsSync(ptr) ? ofs.readFileSync(ptr, 'utf8').trim() : '';
    if (/^app-\d+\.asar$/.test(cur) && ofs.existsSync(path.join(res, cur))) {
      entry = path.join(res, cur, 'main.js');
      for (const f of ofs.readdirSync(res)) {
        if (/^app-\d+\.asar$/.test(f) && f !== cur) { try { ofs.unlinkSync(path.join(res, f)); } catch {} }
      }
    }
  } catch (e) { note = 'no se pudo preparar la actualización: ' + (e?.message || e); }
}

globalThis.__bitchordLoader = { entry, note };
try {
  await import(pathToFileURL(entry).href);
} catch (e) {
  if (entry === bundled) throw e;
  // A broken update must never leave BitChord unable to start: forget it and use the bundled app.
  try { require('original-fs').writeFileSync(path.join(testRes || process.resourcesPath, 'current.txt'), ''); } catch {}
  globalThis.__bitchordLoader = { entry: bundled, note: 'la actualización no arrancó, se usa la versión instalada: ' + (e?.stack || e) };
  await import(pathToFileURL(bundled).href);
}
