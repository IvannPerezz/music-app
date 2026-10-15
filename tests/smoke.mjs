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
  env: { ...process.env, BITCHORD_MOCK: '1', BITCHORD_MOCK_ACCOUNT: '1', BITCHORD_USERDATA: userData, BITCHORD_TEST_EXPORT: path.join(userData, 'prueba.bitchord') },
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(e.message));
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await win.setViewportSize({ width: 1400, height: 860 });
await win.waitForTimeout(1500);
const openSettings = async () => { await win.waitForTimeout(250); await win.click('#account-btn'); await win.waitForTimeout(250); await win.locator('#acct-pop .acct-item', { hasText: /Ajustes|Settings/ }).click(); };
const shot = (n) => win.screenshot({ path: path.join(shots, `${n}.png`) });

await shot('01-home');
if (!(await win.isVisible('#titlebar .traffic'))) errors.push('Faltan los botones de ventana estilo macOS');
if (!/, Prueba$/.test(await win.textContent('#home-greet'))) errors.push('El saludo no lleva el nombre de la cuenta: ' + await win.textContent('#home-greet'));
await win.click('.row >> nth=0'); await win.waitForTimeout(1200);
// The queue is open by default. The cover/lyrics view covers it (it stays open underneath, like the
// left sidebar) until its button brings it up over the view; closing the view leaves it as it was.
const qOpen = () => win.evaluate(() => !document.querySelector('#queue').hidden && !document.querySelector('#queue').classList.contains('closing'));
const qOnTop = () => win.evaluate(() => { const r = document.querySelector('#queue').getBoundingClientRect(); return !!document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('#queue'); });
if (!(await qOpen())) errors.push('La cola no está abierta por defecto');
await win.click('#btn-lyrics'); await win.waitForTimeout(900); await shot('02-now-playing');
if (!(await qOpen())) errors.push('La cola se cierra al abrir portada y letra');
if (await qOnTop()) errors.push('Portada y letra no queda por encima de la cola');
await win.click('#btn-queue'); await win.waitForTimeout(500);
if (!(await qOpen()) || !(await qOnTop())) errors.push('El botón de cola no la saca por encima de portada y letra');
await win.click('#btn-queue'); await win.waitForTimeout(500); // and closes it again
await win.click('#btn-queue'); await win.waitForTimeout(500);
await win.click('#np-close'); await win.waitForTimeout(800);
if (!(await qOpen()) || !(await qOnTop())) errors.push('La cola no sigue abierta al salir de portada y letra');
// Open under the view, closing the view: it's simply there again (it didn't close and reopen).
await win.click('#btn-lyrics'); await win.waitForTimeout(900);
await win.click('#np-close'); await win.waitForTimeout(800);
if (!(await qOpen()) || !(await qOnTop()) || await win.evaluate(() => document.body.classList.contains('queue-under'))) errors.push('La cola no se queda como estaba al cerrar portada y letra');
await win.click('#btn-lyrics'); await win.waitForTimeout(900);
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
await win.mouse.move(700, 400);
// It hides a moment after the window has gone full screen, which can take a while to report.
try { await win.waitForFunction(() => !document.body.classList.contains('fs-vol-show'), null, { timeout: 6000 }); }
catch { errors.push('La barra de volumen no se esconde'); }
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
const moreState = await win.evaluate(() => ({ right: document.querySelector('#menu').getBoundingClientRect().left >= document.querySelector('#fs-more').getBoundingClientRect().left - 1, menu: !document.querySelector('#menu').hidden, panel: !document.querySelector('#fs-panel').hidden && !document.querySelector('#fs-panel').classList.contains('closing') }));
if (!moreState.menu || moreState.panel || !moreState.right) errors.push('Más opciones en pantalla completa: ' + JSON.stringify(moreState));
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
const corner = await win.evaluate(() => ['#lyrics-source', '#np-lyrics-toggle', '#np-vis-presets'].map((q) => { const s = getComputedStyle(document.querySelector(q)); return +s.opacity > 0.5 && parseFloat(s.height) > 20; }));
if (corner.join() !== 'false,false,true') errors.push('Con el visualizador, los botones de la letra deberían salir y el de presets entrar: ' + corner.join());
await win.click('#np-vis-presets'); await win.waitForTimeout(500);
const vis = await win.evaluate(() => ({ title: document.querySelector('#fs-panel h3').textContent, presets: document.querySelectorAll('.vis-item').length, checked: document.querySelectorAll('.vis-item.checked').length }));
if (vis.title !== 'Visualizador' || vis.presets < 200 || vis.checked !== 1) errors.push('Panel del visualizador: ' + JSON.stringify(vis));
await win.click('.vis-pick >> nth=3'); await win.waitForTimeout(1500);
// Favourites: star two more presets, then the "Favoritos" tab lists exactly the starred ones
// (some come starred by default).
const favs = () => win.evaluate(() => window.__bc.state.settings.visFavorites.length);
const favBefore = await favs();
for (const n of [3, 5]) { await win.hover(`.vis-item >> nth=${n}`); await win.click(`.vis-item >> nth=${n} >> .vis-fav`); await win.waitForTimeout(150); }
await shot('02h-visualizer-presets');
const favAfter = await favs();
if (favAfter === favBefore) errors.push('La estrella de favoritos del visualizador no hace nada');
await win.click('.vis-tabs [data-t=fav]'); await win.waitForTimeout(300);
const favCount = await win.evaluate(() => document.querySelectorAll('.vis-item').length);
if (favCount !== favAfter) errors.push('La pestaña de favoritos del visualizador muestra ' + favCount + ' presets en vez de ' + favAfter);
await shot('02i-visualizer-favorites');
await win.click('.vis-tabs [data-t=all]'); await win.waitForTimeout(200);
await win.click('#fs-panel-close'); await win.waitForTimeout(400);
await win.click('#np-vis-toggle'); await win.waitForTimeout(700); // it blurs away first
if (await win.$('#np-vis')) errors.push('El visualizador no se quita al apagarlo');
// "Círculo" mode: its own button; the lyrics buttons leave and its options button comes in.
await win.click('#np-circle-toggle'); await win.waitForTimeout(1500);
if (!(await win.evaluate(() => { const c = document.querySelector('#np-vis-circle'); return c && c.width > 0 && !document.querySelector('#np-vis'); }))) errors.push('No sale el modo círculo');
const ccorner = await win.evaluate(() => ['#np-lyrics-toggle', '#np-vis-presets', '#np-circle-opts'].map((q) => { const s = getComputedStyle(document.querySelector(q)); return +s.opacity > 0.5 && parseFloat(s.height) > 20; }));
if (ccorner.join() !== 'false,false,true') errors.push('Con el círculo, botones de la esquina: ' + ccorner.join());
await win.click('#np-circle-opts'); await win.waitForTimeout(500);
await win.locator('#fs-panel [data-k=circleGain]').fill('2'); await win.waitForTimeout(300);
if (!(await win.evaluate(() => window.__bc.state.settings.circleGain === 2))) errors.push('La intensidad del aura no cambia');
await shot('02j-circle');
await win.click('#fs-panel-close'); await win.waitForTimeout(400);
await win.click('#np-circle-toggle'); await win.waitForTimeout(900);
if (await win.$('#np-vis-circle')) errors.push('El círculo no se quita al apagarlo');
await win.keyboard.press('Escape'); await win.waitForTimeout(1200);
fsx = { ...(await fsState()), window: await winFs() };
if (fsx.fs || fsx.inside || fsx.window || !(await win.$('#player .p-center'))) errors.push('Al salir de pantalla completa: ' + JSON.stringify(fsx));
// Lyrics-source menu with the size/offset sliders; right-click on the bar's artwork → song menu.
await win.click('#lyrics-source'); await win.waitForTimeout(400);
const sliders = await win.evaluate(() => document.querySelectorAll('#menu .menu-sliders input').length);
if (sliders !== 2) errors.push('Faltan los controles de la letra en su menú: ' + sliders);
await win.locator('#menu [data-k=lyricsFontSize]').fill('40'); await win.waitForTimeout(200);
if (!(await win.evaluate(() => getComputedStyle(document.querySelector('#lyrics')).getPropertyValue('--lyr-size').trim() === '40px'))) errors.push('El tamaño de la letra no cambia en directo');
await shot('02a-lyrics-menu');
await win.keyboard.press('Escape'); await win.waitForTimeout(200);
// A song without lyrics: the lyrics hide by themselves.
await win.evaluate(() => { const p = window.__bc.player; const { _k, ...cur } = p.current; p.playNext({ ...cur, id: 'mockvideo03', title: 'Paper Planes' }); p.next(); });
await win.waitForTimeout(1500);
if (!(await win.evaluate(() => document.querySelector('#nowplaying').classList.contains('no-lyrics')))) errors.push('La letra no se oculta sola si no hay');
await win.click('#prev'); await win.waitForTimeout(1500);
await win.click('#np-close'); await win.waitForTimeout(500);
await win.click('#p-art', { button: 'right' }); await win.waitForTimeout(300);
if (!(await win.evaluate(() => !document.querySelector('#menu').hidden && document.querySelector('#menu').textContent.includes('Reproducir a continuación')))) errors.push('Click derecho en la portada no abre el menú de la canción');
await shot('02z-art-menu');
await win.keyboard.press('Escape'); await win.waitForTimeout(200);
await win.click('#btn-queue'); await win.waitForTimeout(500); await shot('03-queue');
// The queue sits beside the content (doesn't cover it) and has its own close button.
const dock = await win.evaluate(() => ({ content: document.querySelector('#content').getBoundingClientRect().right, queue: document.querySelector('#queue').getBoundingClientRect().left }));
if (dock.content > dock.queue + 1) errors.push('La cola tapa el contenido: ' + JSON.stringify(dock));
await win.click('#btn-queue'); await win.waitForTimeout(400);
await win.click('#btn-eq'); await win.waitForTimeout(400); await shot('04-eq');
await win.click('#btn-eq'); await win.waitForTimeout(60);
if (!(await win.evaluate(() => document.querySelector('#eq-pop').classList.contains('closing')))) errors.push('El ecualizador no hace la animación de cierre');
await win.waitForTimeout(300);
await win.click('#account-btn'); await win.waitForTimeout(400); await shot('05-account');
await win.mouse.click(700, 400); await win.waitForTimeout(200);
// "Buscar" in the sidebar: the search box moves to the middle and grows; it goes back after searching.
await win.click('#nav-search'); await win.waitForTimeout(700);
const hero = await win.evaluate(() => { const r = document.querySelector('.search-wrap').getBoundingClientRect(); return { top: r.top, h: document.querySelector('#search').offsetHeight }; });
if (hero.top < 80 || hero.h < 50) errors.push('La búsqueda no baja al centro: ' + JSON.stringify(hero));
await win.fill('#search', 'lua'); await win.waitForTimeout(500); await shot('06a0-search-hero');
// Recent searches have an × to delete them.
await win.evaluate(() => localStorage.setItem('bc.recentSearches', JSON.stringify(['uno', 'dos'])));
await win.fill('#search', ''); await win.waitForTimeout(300);
await win.locator('#suggest li', { hasText: 'uno' }).locator('.sg-del').click(); await win.waitForTimeout(450);
if (await win.evaluate(() => JSON.parse(localStorage.getItem('bc.recentSearches')).join() !== 'dos')) errors.push('La × no borra la búsqueda reciente');
// Search: the top result is a card (here an artist) with its songs, without «» around the query.
await win.fill('#search', 'lua vegaa'); await win.keyboard.press('Enter'); await win.waitForTimeout(900);
if (!(await win.isVisible('.did-you-mean'))) errors.push('Falta el «¿Querías decir…?»');
await shot('06a-did-you-mean');
await win.click('.did-you-mean a'); await win.waitForTimeout(900);
const sr = await win.evaluate(() => ({ card: !!document.querySelector('.top-card.artist'), title: document.querySelector('.search-head h1')?.textContent }));
if (!sr.card || sr.title !== '"lua vega"') errors.push('Búsqueda: ' + JSON.stringify(sr));
await shot('06b-search');
// Sidebar highlight: with "Playlists" pinned, clicking "Biblioteca" keeps "Biblioteca" lit;
// the pinned shortcut lights up only when it's the one clicked.
await win.evaluate(async () => { const sb = (await window.bc.settingsGet()).data.sidebar.map((x) => (x.id === 'lib:playlists' ? { ...x, on: true } : x)); await window.__bc.saveSidebar?.(sb); });
await win.click('#nav-library'); await win.waitForTimeout(900); await shot('06-library');
// Import → Spotify account: sign in (mock), sync a playlist.
await win.evaluate(() => window.__bc.go({ name: 'spotify-import' })); await win.waitForTimeout(700);
if (await win.locator('.import .chip').count()) errors.push('Aún se puede importar el .zip de Spotify');
if (!(await win.isVisible('.sp-how'))) errors.push('Falta la explicación de la vinculación con Spotify');
await shot('06c-spotify-guide');
await win.click('.sp-connect .btn.primary'); await win.waitForTimeout(900);
if (await win.locator('.sp-row .seg').count()) errors.push('Aún se puede elegir «Solo BitChord» al vincular Spotify');
await win.locator('.sp-row', { hasText: 'Rock en español' }).locator('input').check();
await win.locator('.sp-row', { hasText: 'Para correr' }).locator('input').check();
await win.click('.sp-actions .btn.primary'); await win.waitForTimeout(300);
if (!(await win.isVisible('.sp-busy'))) errors.push('No sale la barra de progreso al sincronizar con Spotify');
await shot('06d0-spotify-progress');
await win.waitForFunction(() => /[1-9] canciones/.test(document.querySelector('.sp-row.linked')?.textContent || '') && document.querySelectorAll('.sp-row.linked').length === 2 && !document.querySelector('.sp-busy'), null, { timeout: 15000 }).catch(() => errors.push('La playlist de Spotify no se sincroniza'));
await shot('06d-spotify-linked');
// The copy of a linked playlist has «Actualizar desde Spotify», which checks Spotify right away.
{
  // (The copy lives in YouTube Music; opened with the "VL" YouTube sometimes puts in front.)
  const pid = await win.evaluate(async () => (await window.bc.spotifyStatus()).data.links.find((l) => l.name === 'Rock en español')?.target);
  await win.evaluate((id) => window.__bc.go({ name: 'playlist', id: 'VL' + id }), pid); await win.waitForTimeout(800);
  const btn = win.locator('.detail-head .btn.spotify', { hasText: 'Spotify Sync' });
  if (!(await btn.count())) errors.push('Falta el botón «Spotify Sync» en la playlist vinculada');
  else if (!(await win.evaluate(() => document.querySelector('.detail-head [data-a=play]').nextElementSibling?.classList.contains('spotify')))) errors.push('«Spotify Sync» no está junto a Reproducir');
  else {
    // A song is added in Spotify (which still answers with the old version id): the button must
    // find it anyway.
    await app.evaluate(() => { globalThis.__mockSpotifyExtra = { sp1: 1 }; });
    await win.evaluate(() => { document.querySelector('#toast').textContent = ''; }); // forget the previous notice
    await btn.click();
    await win.waitForFunction(() => { const t = document.querySelector('#toast'); return !t.hidden && /Spotify/.test(t.textContent); }, null, { timeout: 15000 })
      .catch(() => {});
    const msg = await win.textContent('#toast');
    if (!/Una canción nueva desde Spotify/.test(msg)) errors.push('«Spotify Sync» no trae la canción nueva: ' + msg + ' ' + JSON.stringify(await win.evaluate(async () => (await window.bc.spotifyStatus()).data.links.find((l) => l.name === 'Rock en español'))));
    await win.waitForTimeout(600); await shot('06d1-spotify-refresh');
  }
}
// Settings → backup: export, then read it back (without applying: that restarts the app).
{
  const r = await win.evaluate(async () => { const e = await window.bc.configExport({ 'bc.volume': '0.5', 'bc.queue': '[]' }); const o = await window.bc.configOpen(); return { e, o }; });
  if (!r.e.ok || !r.o.ok || r.o.data.app !== 'BitChord' || !r.o.data.spotifyLinks || !r.o.data.covers) errors.push('Copia de configuración: ' + JSON.stringify(r).slice(0, 300));
}
if (!(await win.evaluate(async () => { const st = (await window.bc.spotifyStatus()).data; const covers = (await window.bc.ytCovers()).data; return st.links.some((l) => covers[l.target]); }))) errors.push('La playlist de Spotify no trae su portada');
if (await win.evaluate(() => typeof window.bc.playlistsList === 'function')) errors.push('Siguen existiendo las playlists solo de BitChord');
await win.click('.brand img'); await win.waitForTimeout(700);
if (!(await win.isVisible('#home-greet'))) errors.push('El logo no lleva a Inicio');
// Home recommendation → ⋮ → "No me interesa": the song disappears from the page.
const quick = win.locator('.section', { hasText: 'Selección rápida' }).locator('.row >> nth=1');
const qid = await quick.getAttribute('data-id');
await quick.click({ button: 'right' }); await win.waitForTimeout(300);
await win.locator('#menu button', { hasText: 'No me interesa' }).click(); await win.waitForTimeout(600);
if (await win.locator(`.section:has-text("Selección rápida") .row[data-id="${qid}"]`).count()) errors.push('«No me interesa» no quita la canción');
await win.click('#nav-library'); await win.waitForTimeout(900);
// Inside a playlist: search by artist, sort by title, hide the album column.
await win.locator('.card.playlist >> nth=0').click(); await win.waitForTimeout(900);
const rows = () => win.evaluate(() => [...document.querySelectorAll('.track-list .row .ttl')].map((t) => t.textContent));
const all = await rows();
await win.fill('.list-search input', 'night owls'); await win.waitForTimeout(200);
const owls = await win.evaluate(() => [...document.querySelectorAll('.track-list .row .sub')].map((s) => s.textContent));
if (!owls.length || owls.some((a) => !/Night Owls/.test(a))) errors.push('El buscador de la playlist no filtra por artista: ' + owls.join(' | '));
await win.fill('.list-search input', ''); await win.waitForTimeout(150);
await win.click('.list-head [data-s=title]'); await win.waitForTimeout(150);
const sorted = await rows();
if (sorted.join() !== [...all].sort((a, b) => a.localeCompare(b)).join()) errors.push('Ordenar por título no funciona');
await shot('06e-playlist-tools');
await win.click('.list-head [data-s=title]'); await win.click('.list-head [data-s=title]'); await win.waitForTimeout(150);
await win.click('#nav-library'); await win.waitForTimeout(900);
const lit = await win.evaluate(() => [...document.querySelectorAll('#nav-items .nav-item.active')].map((b) => b.id).join(','));
if (!(await win.$('#nav-lib-playlists'))) errors.push('No se pudo anclar Playlists para la prueba');
if (lit !== 'nav-library') errors.push('Al pulsar Biblioteca se resalta: ' + lit);
// "Playlists" unfolds the playlists as a grid of covers.
await win.click('#nav-lib-playlists .nav-fold'); await win.waitForTimeout(700);
if (!(await win.evaluate(() => document.querySelector('.sb-pl-grid.open') && document.querySelector('#nav-home').offsetHeight >= 36))) errors.push('El desplegable de playlists de la barra lateral no se abre bien');
await shot('06c-sidebar-playlists');
// Drag a playlist to another place: the new order is kept after redrawing.
const firstTitles = () => win.evaluate(() => [...document.querySelectorAll('.cards.wrap')[0].querySelectorAll('.card .t')].map((t) => t.textContent));
const t0 = await firstTitles();
await win.locator('.cards.wrap >> nth=0').locator('.card >> nth=1').dragTo(win.locator('.cards.wrap >> nth=0').locator('.card >> nth=3'), { targetPosition: { x: 150, y: 60 } });
await win.waitForTimeout(500);
await win.click('#nav-home'); await win.waitForTimeout(500); await win.click('#nav-library'); await win.waitForTimeout(900);
const t1 = await firstTitles();
if (t1[1] === t0[1] || !t1.includes(t0[1])) errors.push('Reordenar playlists arrastrando no funciona: ' + t0.join(',') + ' → ' + t1.join(','));
// Right click on a playlist in Biblioteca → Playlists: its menu, with "Eliminar playlist".
await win.click('.card.playlist >> nth=1', { button: 'right' }); await win.waitForTimeout(300);
if (!(await win.evaluate(() => !document.querySelector('#menu').hidden && document.querySelector('#menu').textContent.includes('Eliminar playlist')))) errors.push('Falta el menú de la playlist con click derecho');
await win.keyboard.press('Escape'); await win.waitForTimeout(200);
// A playlist YouTube won't delete: explanation + "Ocultar" hides it from Biblioteca.
const before = await win.locator('.card.playlist').count();
await win.locator('.card.playlist', { hasText: 'Paper Planes' }).first().click({ button: 'right' }); await win.waitForTimeout(300);
await win.locator('#menu button', { hasText: 'Eliminar playlist' }).click(); await win.waitForTimeout(300);
await win.click('.modal [data-a=ok]'); await win.waitForTimeout(600);
if (!(await win.evaluate(() => document.querySelector('.modal h3')?.textContent === 'No se puede eliminar'))) errors.push('Falta el aviso de playlist que no se puede eliminar');
await shot('06d-cannot-delete');
await win.click('.modal [data-a=ok]'); await win.waitForTimeout(900);
if ((await win.locator('.card.playlist').count()) !== before - 1) errors.push('La playlist no se ha ocultado');
// "Me gusta" can be hidden too, from its right-click menu.
await win.click('.card.playlist >> nth=0', { button: 'right' }); await win.waitForTimeout(300);
await win.locator('#menu button', { hasText: 'Ocultar en BitChord' }).click(); await win.waitForTimeout(900);
if (await win.evaluate(() => [...document.querySelectorAll('.card.playlist .t')].some((t) => t.textContent === 'Me gusta'))) errors.push('«Me gusta» no se ha ocultado');
await win.click('#nav-lib-playlists .nav-fold'); await win.waitForTimeout(400);
await openSettings(); await win.waitForTimeout(900); await shot('07-settings');
if (await win.evaluate(() => document.querySelector('#sidebar').offsetWidth > 10)) errors.push('La barra lateral no se oculta en Ajustes');
// Custom CSS theme: "+" tile → editor → save; then back to the original BitChord theme.
// Ajustes is split in categories (left column): Tema and Personalización are in «Apariencia».
if ((await win.locator('.set-nav-item').count()) !== 6) errors.push('Faltan las categorías de Ajustes');
await win.click('.set-nav-item[data-cat=appearance]'); await win.waitForTimeout(400);
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

// Interface language: switch to English (the window reloads) and check a few texts.
await openSettings(); await win.waitForTimeout(600);
await win.click('.set-nav-item[data-cat=general]'); await win.waitForTimeout(400);
await win.locator('#set-general select').first().selectOption('en');
await win.waitForTimeout(2500);
await win.waitForSelector('#nav-items .nav-item');
const en = await win.evaluate(() => ({
  nav: [...document.querySelectorAll('#nav-items .nav-label')].map((e) => e.textContent).join(','),
  settings: document.querySelector('#account-btn').title,
  search: document.querySelector('#search').placeholder,
  lang: document.documentElement.lang,
}));
if (!en.nav.includes('Home') || !/Google|Prueba/.test(en.settings) || en.lang !== 'en') errors.push('Interfaz en inglés: ' + JSON.stringify(en));
await shot('11-english-home');
await openSettings(); await win.waitForTimeout(900); await shot('12-english-settings');
// Leaving settings brings the sidebar and the queue back.
await win.click('#back'); await win.waitForTimeout(900);
if (await win.evaluate(() => document.querySelector('#sidebar').offsetWidth < 100 || document.querySelector('#queue').hidden)) errors.push('Al salir de Ajustes no vuelven la barra lateral y la cola');
await win.click('#content .row >> nth=0'); await win.waitForTimeout(800);
await win.click('#btn-lyrics'); await win.waitForTimeout(900); await shot('13-english-now-playing');
// Performance mode (title bar button): no glass or moving backgrounds, no visualizer; off again,
// everything is back.
{
  const perf = () => win.evaluate(() => ({ on: document.body.classList.contains('perf'), glass: getComputedStyle(document.body).getPropertyValue('--mica-filter').trim(), amb: getComputedStyle(document.querySelector('#ambient')).display }));
  await win.click('#btn-perf'); await win.waitForTimeout(500);
  const p = await perf();
  if (!p.on || p.glass !== 'none' || p.amb !== 'none') errors.push('Modo rendimiento: ' + JSON.stringify(p));
  await win.keyboard.press('v'); await win.waitForTimeout(800);
  if (await win.$('#np-vis')) errors.push('El visualizador se enciende en el modo rendimiento');
  await shot('14-performance-mode');
  await win.click('#btn-perf'); await win.waitForTimeout(500);
  const q = await perf();
  if (q.on || q.glass === 'none') errors.push('Al quitar el modo rendimiento no vuelven los efectos: ' + JSON.stringify(q));
}
await app.close();
fs.rmSync(userData, { recursive: true, force: true });
if (errors.length) { console.error('Errores en la interfaz:\n' + errors.join('\n')); process.exit(1); }
console.log(`OK — capturas en ${shots}`);
