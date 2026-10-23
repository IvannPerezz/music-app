// Publishes this version as a GitHub release of the public repo the app looks for updates in:
// builds BitChord-Instalar-<version>.exe (build-installer.mjs) and uploads it with that version's
// CAMBIOS.txt entry as its notes. Needs the GitHub CLI (gh) signed in.
// Usage: npm run release
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { root, pkg } from './stage-app.mjs';

const REPO = 'IvannPerezz/music-app';
const v = pkg.version;
const tag = 'v' + v;
const gh = (...args) => execFileSync('gh', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

try { gh('release', 'view', tag, '--repo', REPO); console.error(`La release ${tag} ya existe en ${REPO}.`); process.exit(1); } catch {}

// This version's entry in CAMBIOS.txt (between its dashed header and the next version's).
const log = fs.readFileSync(path.join(root, 'CAMBIOS.txt'), 'utf8').replace(/\r\n/g, '\n');
const m = new RegExp(`^-{20,}\\n${tag.replace(/\./g, '\\.')}\\n-{20,}\\n([\\s\\S]*?)(?=\\n-{20,}\\nv\\d|$)`, 'm').exec(log);
if (!m) { console.error(`No encuentro la entrada de ${tag} en CAMBIOS.txt.`); process.exit(1); }
const notes = m[1].trim();

execFileSync(process.execPath, [path.join(root, 'scripts', 'build-installer.mjs')], { cwd: root, stdio: 'inherit' });
const exe = path.join(root, `BitChord-Instalar-${v}.exe`);
if (!fs.existsSync(exe)) { console.error('No se generó el instalador.'); process.exit(1); }

const notesFile = path.join(os.tmpdir(), `bitchord-notes-${v}.md`);
fs.writeFileSync(notesFile, notes);
try {
  gh('release', 'create', tag, exe, '--repo', REPO, '--title', `BitChord ${tag}`, '--notes-file', notesFile, '--target', 'main');
} finally { fs.rmSync(notesFile, { force: true }); }
console.log(`Publicada ${tag}: https://github.com/${REPO}/releases/tag/${tag}`);
