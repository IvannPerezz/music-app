// Shared by build-update.mjs and package-win.mjs: copies the app sources + production
// node_modules into a staging folder and packs them as an .asar archive.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

export async function buildAsar(outFile, stageDir) {
  const asar = require('@electron/asar');
  const app = path.join(stageDir, 'app');
  fs.rmSync(app, { recursive: true, force: true });
  fs.mkdirSync(app, { recursive: true });
  for (const f of ['loader.js', 'main.js', 'preload.cjs', 'LICENSE', 'src', 'renderer', 'build', 'assets']) {
    fs.cpSync(path.join(root, f), path.join(app, f), { recursive: true });
  }
  fs.rmSync(path.join(app, 'src', 'mock.js'), { force: true }); // test fixtures only
  const prodPkg = { name: pkg.name, productName: pkg.productName, version: pkg.version, description: pkg.description, main: pkg.main, type: pkg.type, license: pkg.license, dependencies: pkg.dependencies };
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify(prodPkg, null, 2));
  execSync('npm install --omit=dev --no-audit --no-fund --ignore-scripts', { cwd: app, stdio: 'inherit' });
  (function prune(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) prune(p);
      else if (/\.(d\.ts|d\.cts|d\.mts|map|md|ts)$/i.test(e.name) && p.includes('node_modules')) fs.rmSync(p);
    }
  })(app);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  await asar.createPackage(app, outFile);
  fs.rmSync(app, { recursive: true, force: true });
  return outFile;
}

/** CAMBIOS.txt with Windows line endings (Notepad-friendly). */
export const changelogCRLF = () => fs.readFileSync(path.join(root, 'CAMBIOS.txt'), 'utf8').replace(/\r?\n/g, '\r\n');
