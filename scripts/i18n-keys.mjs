// Lists every text passed to tr('…') in the app (interface and main process) and checks that the
// English dictionary has all of them.
//   node scripts/i18n-keys.mjs           → missing translations (exit 1 if any)
//   node scripts/i18n-keys.mjs --all     → every key, as JSON
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'main.js',
  ...fs.readdirSync(path.join(root, 'renderer')).filter((f) => f.endsWith('.js')).map((f) => 'renderer/' + f),
  ...fs.readdirSync(path.join(root, 'src')).filter((f) => f.endsWith('.js') && f !== 'mock.js').map((f) => 'src/' + f),
  ...fs.readdirSync(path.join(root, 'src', 'sources')).filter((f) => f.endsWith('.js')).map((f) => 'src/sources/' + f),
];

const unescape = (s, q) => s.replace(/\\(.)/g, (m, c) => (c === 'n' ? '\n' : c === q || c === '\\' || c === '"' || c === "'" || c === '`' ? c : m));

/** String literals in the first argument of every tr( … ) call (both sides of a ternary too). */
export function keysIn(src) {
  const keys = [];
  const re = /(?<![\w$.])tr\(/g;
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + 3, depth = 0, firstArgDone = false;
    while (i < src.length) {
      const c = src[i];
      if (c === "'" || c === '"' || c === '`') {
        let j = i + 1, raw = '';
        while (j < src.length && src[j] !== c) { if (src[j] === '\\') { raw += src[j] + src[j + 1]; j += 2; continue; } raw += src[j]; j++; }
        // Skip literals that are only compared against (tr(x === 'yt' ? 'a' : 'b')).
        const before = src.slice(Math.max(0, i - 5), i).trimEnd();
        const compared = /[=!]==?$/.test(before);
        if (!firstArgDone && !compared && !(c === '`' && raw.includes('${'))) keys.push(unescape(raw, c));
        i = j + 1; continue;
      }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; }
      else if (c === ',' && depth === 0) firstArgDone = true;
      i++;
    }
  }
  return keys;
}

export function allKeys() {
  const set = new Set();
  for (const f of files) for (const k of keysIn(fs.readFileSync(path.join(root, f), 'utf8'))) if (k) set.add(k);
  return [...set];
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const keys = allKeys();
  if (process.argv.includes('--all')) { console.log(JSON.stringify(keys, null, 1)); process.exit(0); }
  const EN = (await import(pathToFileURL(path.join(root, 'renderer', 'i18n', 'en.js')).href)).default;
  const missing = keys.filter((k) => !(k in EN));
  if (missing.length) { console.error(`Sin traducir al inglés (${missing.length}):\n` + missing.map((k) => '  ' + JSON.stringify(k)).join('\n')); process.exit(1); }
  console.log(`Traducciones al inglés completas (${keys.length} textos).`);
}
