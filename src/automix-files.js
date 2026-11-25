// Automix's AI models and the ONNX runtime's WebAssembly are fetched by the analysis worker, which
// can't read file:// URLs, so the local proxy serves them at /automix/ (shared by proxy.js and the
// mock server). Only these files, nothing else under the app folder.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'automix');
const FILE = /^[\w.-]+\.(onnx|wasm)$/;

/** Handles /automix/<file>; returns false for any other path. */
export function serveAutomix(pathname, res) {
  if (!pathname.startsWith('/automix/')) return false;
  const rel = pathname.slice('/automix/'.length);
  const file = path.join(DIR, rel);
  if (!FILE.test(rel) || !fs.existsSync(file)) { res.writeHead(404).end(); return true; }
  res.writeHead(200, {
    'Content-Type': rel.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream',
    'Content-Length': fs.statSync(file).size,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'max-age=86400',
  });
  fs.createReadStream(file).pipe(res);
  return true;
}
