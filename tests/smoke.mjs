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
// Full-screen mode: player controls under the artwork, no title bar or window buttons.
await win.click('#btn-fs'); await win.waitForTimeout(1200);
const fsState = () => win.evaluate(() => ({
  fs: document.body.classList.contains('fs'),
  inside: !!document.querySelector('#np-fs-slot .p-center'),
  titlebar: getComputedStyle(document.querySelector('#titlebar')).display,
}));
const winFs = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen());
let fsx = { ...(await fsState()), window: await winFs() };
if (!fsx.fs || !fsx.inside || fsx.titlebar !== 'none' || !fsx.window) errors.push('Pantalla completa: ' + JSON.stringify(fsx));
await shot('02b-fullscreen');
const from = await win.evaluate(() => document.querySelector('#np-from').innerText.replace(/\s+/g, ' ').trim());
if (!/desde|radio/i.test(from)) errors.push('Falta «Reproduciendo desde…»: ' + from);
// The volume bar slides away after a moment and comes back near the left edge.
const volShown = () => win.evaluate(() => document.body.classList.contains('fs-vol-show'));
await win.mouse.move(700, 400); await win.waitForTimeout(3200);
if (await volShown()) errors.push('La barra de volumen no se esconde');
await shot('02c-fullscreen-vol-hidden');
// Favourite, shuffle and repeat switched on: Mica disc; the minimise arrow has Mica too.
for (const id of ['#fs-like', '#shuffle', '#repeat']) await win.click(id);
await win.waitForTimeout(300);
const micaOn = await win.evaluate(() => ['#fs-like', '#shuffle', '#repeat', '#np-close'].map((q) => getComputedStyle(document.querySelector(q)).backdropFilter !== 'none'));
if (micaOn.includes(false)) errors.push('Falta el efecto Mica en favorito/aleatorio/repetir/minimizar: ' + micaOn.join());
await shot('02c2-fullscreen-active');
await win.click('#fs-like'); await win.click('#shuffle'); await win.click('#repeat'); await win.click('#repeat');
await win.waitForTimeout(200);
await win.mouse.move(40, 430); await win.waitForTimeout(500);
if (!(await volShown())) errors.push('La barra de volumen no vuelve al acercar el ratón');
// Menus open as a side panel from the right (like the queue) and the button column moves too.
const panel = () => win.evaluate(() => { const p = document.querySelector('#fs-panel'), c = document.querySelector('.np-corner').getBoundingClientRect(); return { open: !p.hidden && !p.classList.contains('closing'), title: p.querySelector('h3').textContent, cornerRight: Math.round(c.right), panelLeft: Math.round(p.getBoundingClientRect().left), fs: document.body.classList.contains('fs') }; });
await win.click('#fs-eq'); await win.waitForTimeout(500);
let pn = await panel();
if (!pn.open || pn.title !== 'Ecualizador' || pn.cornerRight > pn.panelLeft) errors.push('Ecualizador en pantalla completa: ' + JSON.stringify(pn));
await shot('02d-fullscreen-eq');
// The equalizer and the lyrics source only take the height they need.
const panelH = () => win.evaluate(() => document.querySelector('#fs-panel').offsetHeight / innerHeight);
if ((await panelH()) > 0.75) errors.push('El panel del ecualizador ocupa todo el alto');
await win.click('#lyrics-source'); await win.waitForTimeout(500);
pn = await panel();
if (!pn.open || pn.title !== 'Letra' || (await panelH()) > 0.75 || pn.cornerRight > pn.panelLeft) errors.push('Panel de la letra: ' + JSON.stringify(pn));
await shot('02d1-fullscreen-lyrics-source');
const bottoms = await win.evaluate(() => ({ panel: Math.round(document.querySelector('#fs-panel').getBoundingClientRect().bottom), h: innerHeight }));
if (bottoms.panel < bottoms.h - 30) errors.push('El panel de la letra no está abajo junto a los botones: ' + JSON.stringify(bottoms));
await win.click('#fs-panel-close'); await win.waitForTimeout(400);
await win.click('#fs-more'); await win.waitForTimeout(500);
// "Más opciones" is the usual pop-up menu next to its button, not a side panel.
const moreState = await win.evaluate(() => ({ menu: !document.querySelector('#menu').hidden, panel: !document.querySelector('#fs-panel').hidden && !document.querySelector('#fs-panel').classList.contains('closing') }));
if (!moreState.menu || moreState.panel) errors.push('Más opciones en pantalla completa: ' + JSON.stringify(moreState));
await shot('02d2-fullscreen-more');
await win.keyboard.press('Escape'); await win.waitForTimeout(200);
if (!(await win.evaluate(() => document.body.classList.contains('fs')))) errors.push('Esc con el menú abierto sale de pantalla completa');
await win.click('#fs-eq'); await win.waitForTimeout(500);
await win.keyboard.press('Escape'); await win.waitForTimeout(450);
pn = await panel();
if (pn.open || !pn.fs) errors.push('Esc debería cerrar el panel sin salir de pantalla completa: ' + JSON.stringify(pn));
// The right-hand column moves left with the queue panel instead of staying under it.
const cornerRight = () => win.evaluate(() => Math.round(document.querySelector('.np-corner').getBoundingClientRect().right));
const r0 = await cornerRight();
await win.click('#fs-queue'); await win.waitForTimeout(50);
// Opening the queue must not scroll the window sideways (it did while the panel slid in).
const sideways = await win.evaluate(() => ['#layout', '#nowplaying', 'body', 'html'].map((q) => document.querySelector(q).scrollLeft).filter(Boolean));
if (sideways.length) errors.push('Al abrir la cola se desplaza la ventana: ' + sideways.join(', '));
await win.waitForTimeout(550);
const r1 = await cornerRight(), qLeft = await win.evaluate(() => document.querySelector('#queue').getBoundingClientRect().left);
const qPos = await win.evaluate(() => ({ right: Math.round(document.querySelector('#queue').getBoundingClientRect().right), w: innerWidth, scrolled: ['#layout', '#nowplaying', 'body', 'html'].some((q) => document.querySelector(q).scrollLeft) }));
if (qPos.scrolled || qPos.right < qPos.w - 20) errors.push('La cola no queda pegada a la derecha: ' + JSON.stringify(qPos));
if (!(r1 < r0 && r1 <= qLeft)) errors.push(`Los botones no se apartan de la cola: ${r0} → ${r1}, cola en ${qLeft}`);
await shot('02e-fullscreen-queue');
await win.click('#fs-queue'); await win.waitForTimeout(400);
// Full-screen settings: switching off "Aleatorio" hides it under the artwork.
await win.click('#fs-settings'); await win.waitForTimeout(400); await shot('02f-fullscreen-settings');
await win.locator('.fs-opt', { hasText: 'Aleatorio' }).click(); await win.waitForTimeout(300);
if (await win.isVisible('#shuffle')) errors.push('Ocultar «Aleatorio» en pantalla completa no funciona');
await win.locator('.fs-opt', { hasText: 'Aleatorio' }).click(); await win.waitForTimeout(300);
await win.click('.fs-set [data-a=ok]'); await win.waitForTimeout(300);
if (!(await win.isVisible('#shuffle'))) errors.push('«Aleatorio» no vuelve a aparecer');
// MilkDrop visualizer: sandboxed iframe that reports its presets, a presets panel, and off again.
await win.click('#np-vis-toggle');
try { await win.waitForFunction(() => document.body.dataset.vis === 'ready', null, { timeout: 8000 }); }
catch { errors.push('El visualizador no arranca'); }
await win.waitForTimeout(1500); await shot('02g-visualizer');
await win.click('#np-vis-presets'); await win.waitForTimeout(500);
const vis = await win.evaluate(() => ({ title: document.querySelector('#fs-panel h3').textContent, presets: document.querySelectorAll('.vis-list button').length, checked: document.querySelectorAll('.vis-list button.checked').length }));
if (vis.title !== 'Visualizador' || vis.presets < 200 || vis.checked !== 1) errors.push('Panel del visualizador: ' + JSON.stringify(vis));
await win.click('.vis-list button >> nth=3'); await win.waitForTimeout(1500); await shot('02h-visualizer-presets');
await win.click('#fs-panel-close'); await win.waitForTimeout(400);
await win.click('#np-vis-toggle'); await win.waitForTimeout(300);
if (await win.$('#np-vis')) errors.push('El visualizador no se quita al apagarlo');
await win.keyboard.press('Escape'); await win.waitForTimeout(1200);
fsx = { ...(await fsState()), window: await winFs() };
if (fsx.fs || fsx.inside || fsx.window || !(await win.$('#player .p-center'))) errors.push('Al salir de pantalla completa: ' + JSON.stringify(fsx));
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
