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

// A version's entry in CAMBIOS.txt: everything between its dashed header and the next version's.
const log = fs.readFileSync(path.join(root, 'CAMBIOS.txt'), 'utf8').replace(/\r\n/g, '\n');
const DASHES = '-'.repeat(60);
function notesFor(t) {
  const head = `${DASHES}\n${t}\n${DASHES}\n`;
  const at = log.indexOf(head);
  if (at < 0) return null;
  const rest = log.slice(at + head.length);
  const next = rest.search(/^-{20,}\nv\d/m);
  return (next >= 0 ? rest.slice(0, next) : rest).trim();
}

// npm run release -- --fix-notes v0.6.56 v0.6.56.1 …: only rewrites the notes of published releases.
const fix = process.argv.indexOf('--fix-notes');
if (fix >= 0) {
  for (const t of process.argv.slice(fix + 1)) {
    const n = notesFor(t);
    if (!n) { console.error(`No encuentro la entrada de ${t} en CAMBIOS.txt.`); continue; }
    const f = path.join(os.tmpdir(), `bitchord-notes-${t}.md`);
    fs.writeFileSync(f, n);
    try { gh('release', 'edit', t, '--repo', REPO, '--notes-file', f); console.log(`Notas de ${t} corregidas.`); } finally { fs.rmSync(f, { force: true }); }
  }
  process.exit(0);
}

try { gh('release', 'view', tag, '--repo', REPO); console.error(`La release ${tag} ya existe en ${REPO}.`); process.exit(1); } catch {}

const notes = notesFor(tag);
if (!notes) { console.error(`No encuentro la entrada de ${tag} en CAMBIOS.txt.`); process.exit(1); }

execFileSync(process.execPath, [path.join(root, 'scripts', 'build-installer.mjs')], { cwd: root, stdio: 'inherit' });
const exe = path.join(root, `BitChord-Instalar-${v}.exe`);
if (!fs.existsSync(exe)) { console.error('No se generó el instalador.'); process.exit(1); }

const notesFile = path.join(os.tmpdir(), `bitchord-notes-${v}.md`);
fs.writeFileSync(notesFile, notes);
try {
  gh('release', 'create', tag, exe, '--repo', REPO, '--title', `BitChord ${tag}`, '--notes-file', notesFile, '--target', 'main');
} finally { fs.rmSync(notesFile, { force: true }); }
console.log(`Publicada ${tag}: https://github.com/${REPO}/releases/tag/${tag}`);
