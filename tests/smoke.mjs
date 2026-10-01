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
// Animated background: shown in the full-screen view and only moving while a song plays.
const amb = () => win.evaluate(() => ({ np: getComputedStyle(document.querySelector('.np-amb')).display, paused: document.body.classList.contains('ambient-paused') }));
let a = await amb();
if (a.np !== 'block' || a.paused) errors.push('Fondo animado en pantalla completa: ' + JSON.stringify(a));
await win.click('#play'); await win.waitForTimeout(300);
a = await amb(); if (!a.paused) errors.push('El fondo animado no se para al pausar');
await win.click('#play'); await win.waitForTimeout(300);
await win.click('#np-close'); await win.waitForTimeout(500);
await win.click('#btn-queue'); await win.waitForTimeout(500); await shot('03-queue');
await win.click('#btn-queue'); await win.waitForTimeout(400);
await win.click('#btn-eq'); await win.waitForTimeout(400); await shot('04-eq');
await win.click('#btn-eq'); await win.waitForTimeout(300);
await win.click('#account-btn'); await win.waitForTimeout(400); await shot('05-account');
await win.mouse.click(700, 400); await win.waitForTimeout(200);
await win.click('#nav-library'); await win.waitForTimeout(900); await shot('06-library');
await win.click('#settings-btn'); await win.waitForTimeout(900); await shot('07-settings');
// Custom CSS theme: "+" tile → editor → save; then back to the original BitChord theme.
await win.click('.theme-add'); await win.waitForTimeout(300);
await win.fill('.theme-editor textarea', ':root { --bg: #102030; --surface: #18304a; --accent: #3d9bff; --mica-rgb: 20, 40, 70; }');
await win.fill('.theme-editor input', 'Prueba azul');
await win.click('.theme-editor [data-a=preview]'); await win.waitForTimeout(400); await shot('08-theme-editor');
await win.click('.theme-editor [data-a=ok]'); await win.waitForTimeout(400);
const bgOf = () => win.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
if ((await bgOf()) !== '#102030') errors.push('El tema personalizado no se aplica: ' + await bgOf());
await win.click('.theme-opt >> nth=0'); await win.waitForTimeout(300);
if ((await bgOf()) !== '#0d0d0f') errors.push('No se vuelve al tema BitChord: ' + await bgOf());
// Efecto Mica: section in Personalización, then the queue and player bar with Mica switched off.
const micaRow = (label) => win.locator('.set-row', { hasText: label }).locator('.switch');
await win.locator('h3.set-sub', { hasText: 'Efecto Mica' }).scrollIntoViewIfNeeded(); await win.waitForTimeout(400); await shot('09-mica');
await micaRow('Cola (barra lateral derecha)').click(); await micaRow('Controles de reproducción (abajo)').click(); await win.waitForTimeout(300);
const off = await win.evaluate(() => ['queue', 'player', 'sidebar'].map((k) => document.body.classList.contains('no-mica-' + k)));
if (off.join() !== 'true,true,false') errors.push('Los interruptores de Mica no se aplican: ' + off.join());
await win.click('#btn-queue'); await win.waitForTimeout(500); await shot('10-mica-off');

await app.close();
fs.rmSync(userData, { recursive: true, force: true });
if (errors.length) { console.error('Errores en la interfaz:\n' + errors.join('\n')); process.exit(1); }
console.log(`OK — capturas en ${shots}`);
