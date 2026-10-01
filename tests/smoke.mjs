// UI smoke test with offline fixtures: opens the main views and fails on any page error.
//   npm test            (screenshots go to tests/shots/)
import { _electron } from 'playwright-core';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.join(root, 'tests', 'shots');
fs.mkdirSync(shots, { recursive: true });
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bitchord-test-'));
const app = await _electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: [root],
  env: { ...process.env, BITCHORD_MOCK: '1', BITCHORD_MOCK_ACCOUNT: '1', BITCHORD_USERDATA: userData },
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(e.message));
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await win.setViewportSize({ width: 1400, height: 860 });
await win.waitForTimeout(1500);
const shot = (n) => win.screenshot({ path: path.join(shots, `${n}.png`) });

await shot('01-home');
await win.click('.row >> nth=0'); await win.waitForTimeout(1200);
await win.click('#btn-lyrics'); await win.waitForTimeout(900); await shot('02-now-playing');
await win.click('#np-close'); await win.waitForTimeout(500);
await win.click('#btn-queue'); await win.waitForTimeout(500); await shot('03-queue');
await win.click('#btn-queue'); await win.waitForTimeout(400);
await win.click('#btn-eq'); await win.waitForTimeout(400); await shot('04-eq');
await win.click('#btn-eq'); await win.waitForTimeout(300);
await win.click('#account-btn'); await win.waitForTimeout(400); await shot('05-account');
await win.mouse.click(700, 400); await win.waitForTimeout(200);
await win.click('#nav-library'); await win.waitForTimeout(900); await shot('06-library');
await win.click('#settings-btn'); await win.waitForTimeout(900); await shot('07-settings');

await app.close();
fs.rmSync(userData, { recursive: true, force: true });
if (errors.length) { console.error('Errores en la interfaz:\n' + errors.join('\n')); process.exit(1); }
console.log(`OK — capturas en ${shots}`);
