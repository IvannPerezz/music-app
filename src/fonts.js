// Optional interface font: SF Pro Display, from files the user already has (Apple's licence doesn't
// allow shipping it with BitChord, so it's never bundled: it's copied into the profile from the
// folder the user points to, and the window loads it from there).
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { tr } from './i18n.js';

const WEIGHTS = { ULTRALIGHT: 100, THIN: 200, LIGHT: 300, REGULAR: 400, MEDIUM: 500, SEMIBOLD: 600, BOLD: 700, HEAVY: 800, BLACK: 900 };
const NAME = /^SF-?PRO-?DISPLAY-?(ULTRALIGHT|THIN|LIGHT|REGULAR|MEDIUM|SEMIBOLD|BOLD|HEAVY|BLACK)(ITALIC)?\.(OTF|TTF)$/i;

let dir = null;
export function init(userData) { dir = path.join(userData, 'fonts', 'sf-pro-display'); }

const list = (folder) => { try { return fs.readdirSync(folder).filter((f) => NAME.test(f)); } catch { return []; } };
export const installed = () => list(dir).length > 0;
/** Where the user keeps it, if it's in the usual place (a "sf-pro-display" folder on the Desktop). */
export function defaultFolder() {
  const p = path.join(app.getPath('desktop'), 'sf-pro-display');
  return list(p).length ? p : null;
}

export function importFrom(folder) {
  const files = list(folder);
  if (!files.length) throw new Error(tr('En esa carpeta no hay archivos de SF Pro Display (.otf o .ttf).'));
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) fs.copyFileSync(path.join(folder, f), path.join(dir, f.toUpperCase()));
  return files.length;
}

/** Every face with its weight and style, and the file's bytes (the window builds FontFaces). */
export function faces() {
  return list(dir).map((f) => {
    const m = NAME.exec(f);
    return { weight: WEIGHTS[m[1].toUpperCase()], style: m[2] ? 'italic' : 'normal', data: new Uint8Array(fs.readFileSync(path.join(dir, f))) };
  });
}
