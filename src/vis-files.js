// The MilkDrop visualizer runs in a sandboxed iframe, which can't load file:// scripts, so the
// local proxy serves it at /vis/ (shared by proxy.js and the mock server). Only these files,
// nothing else under the app folder.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VIS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'renderer', 'visualizer');
const VIS_FILE = /^(visualizer\.html|vis\.js|vendor\/[\w-]+\.min\.js)$/;

/** Handles /vis/<file>; returns false for any other path. */
export function serveVisualizer(pathname, res) {
  if (!pathname.startsWith('/vis/')) return false;
  const rel = pathname.slice('/vis/'.length);
  if (!VIS_FILE.test(rel)) { res.writeHead(404).end(); return true; }
  res.writeHead(200, { 'Content-Type': rel.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
  fs.createReadStream(path.join(VIS_DIR, rel)).pipe(res);
  return true;
}
