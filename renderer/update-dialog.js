// "There's a new version" dialog: Mica glass like the rest of the app, zooming in with a little
// bounce. It shows the release notes, downloads the installer with a progress bar and hands over to
// it (BitChord closes; the installer puts the new version in and opens it again).
import { api, bc, h, esc, state, saveSettings, toast } from './core.js';
import { tr } from './i18n.js';

const mb = (n) => (n / 1048576).toLocaleString(undefined, { maximumFractionDigits: n < 10 * 1048576 ? 1 : 0 });
let open = null;
let onProgress = null, listening = false; // (one listener for the app's life: bc.on can't remove one)

/** Looks for a new version. On start (`manual` false) it stays quiet unless there's one not skipped. */
export async function checkForUpdates({ manual = false } = {}) {
  let info;
  try { info = await api('updateCheck'); }
  catch (e) { if (manual) toast(e.message || tr('No se pudo buscar actualizaciones.'), true); else console.warn('[update]', e?.message); return; }
  if (!info?.available) { if (manual) toast(tr('Tienes la última versión (v{v}).', { v: info?.current || '' })); return; }
  if (!manual && state.settings.updateSkip === info.version) return;
  showDialog(info);
}

/** The release notes (CAMBIOS.txt style: "- " items with indented continuation lines) as a list. */
function notesHtml(text) {
  const items = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim() || /^-{5,}$/.test(line.trim()) || /^v?\d+(\.\d+)+$/.test(line.trim())) continue;
    if (/^\s*[-·•*]\s+/.test(line) && !/^\s{2,}/.test(line)) items.push(line.replace(/^\s*[-·•*]\s+/, ''));
    else if (/^\s+[·•]\s+/.test(line) && items.length) items.push('· ' + line.replace(/^\s+[·•]\s+/, ''));
    else if (items.length) items[items.length - 1] += ' ' + line.trim();
    else items.push(line.trim());
  }
  return items.length ? `<ul>${items.map((t) => `<li${t.startsWith('· ') ? ' class="sub"' : ''}>${esc(t.replace(/^· /, ''))}</li>`).join('')}</ul>` : `<p class="muted">${esc(tr('Sin notas para esta versión.'))}</p>`;
}

/** Every version since the installed one, newest first; with more than one, each under its number. */
function changesHtml(changes) {
  if (changes.length === 1) return notesHtml(changes[0].notes);
  return changes.map((c) => `<div class="upd-v">v${esc(c.version)}</div>${notesHtml(c.notes)}`).join('');
}

function showDialog(info) {
  if (open) return;
  const m = h(`<div class="modal-back fade upd-back"><div class="modal mica upd">
    <div class="upd-head">
      <img src="logo.png" alt="">
      <div><h3>${esc(tr('Hay una versión nueva de BitChord'))}</h3>
      <div class="muted upd-ver">v${esc(info.version)} · ${esc(tr('tienes la v{v}', { v: info.current }))}${info.size ? ` · ${mb(info.size)} MB` : ''}</div></div>
    </div>
    <div class="upd-notes">${changesHtml(info.changes || [{ version: info.version, notes: info.notes }])}</div>
    <div class="upd-progress" hidden><div class="upd-bar"><i></i></div><div class="upd-status muted"></div></div>
    <div class="btn-row upd-buttons">
      <button class="btn ghost small upd-skip" data-a="skip">${esc(tr('Omitir esta versión'))}</button>
      <button class="btn ghost small" data-a="later">${esc(tr('Más tarde'))}</button>
      <button class="btn primary small" data-a="go">${esc(tr('Descargar e instalar'))}</button>
    </div>
  </div></div>`);
  const box = m.querySelector('.upd');
  const $ = (s) => m.querySelector(s);
  let busy = false;

  const close = () => {
    if (busy) return;
    document.removeEventListener('keydown', key, true);
    onProgress = null;
    open = null;
    const a = box.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.94)' }], { duration: 160, easing: 'ease-in' });
    m.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: 'ease-in' });
    a.onfinish = () => m.remove();
  };
  const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const progress = (got, total) => {
    const p = total ? got / total : 0;
    $('.upd-bar i').style.transform = `scaleX(${p.toFixed(4)})`;
    $('.upd-status').textContent = tr('Descargando… {p} % · {a} de {b} MB', { p: Math.floor(p * 100), a: mb(got), b: mb(total) });
  };
  const buttons = (html) => { $('.upd-buttons').innerHTML = html; };

  async function start() {
    busy = true;
    $('.upd-progress').hidden = false;
    progress(0, info.size || 0);
    buttons(`<button class="btn ghost small" data-a="cancel">${esc(tr('Cancelar'))}</button>`);
    $('[data-a=cancel]').onclick = () => api('updateCancel').catch(() => {});
    try {
      await api('updateDownload');
      $('.upd-bar i').style.transform = 'scaleX(1)';
      $('.upd-status').textContent = tr('Instalando… BitChord se cerrará y volverá a abrirse solo.');
      buttons('');
      await new Promise((ok) => setTimeout(ok, 900));
      await api('updateInstall');
    } catch (e) {
      busy = false;
      $('.upd-status').textContent = e.message || tr('No se pudo descargar la actualización.');
      $('.upd-status').classList.add('err');
      buttons(`<button class="btn ghost small" data-a="later">${esc(tr('Más tarde'))}</button><button class="btn primary small" data-a="go">${esc(tr('Reintentar'))}</button>`);
      wire();
    }
  }
  function wire() {
    m.querySelector('[data-a=later]')?.addEventListener('click', close);
    m.querySelector('[data-a=go]')?.addEventListener('click', () => { $('.upd-status').classList.remove('err'); start(); });
    m.querySelector('[data-a=skip]')?.addEventListener('click', () => { saveSettings({ updateSkip: info.version }); close(); });
  }
  wire();
  if (!listening) { listening = true; bc.on('update-progress', (d) => onProgress?.(d)); }
  onProgress = (d) => { if (busy) progress(d.got, d.total); };
  m.addEventListener('mousedown', (e) => { if (e.target === m) close(); });
  document.addEventListener('keydown', key, true);
  document.body.append(m);
  open = m;
  // Zoom in with a little bounce: overshoots, settles back and comes to rest.
  box.animate([
    { opacity: 0, transform: 'scale(.6)' },
    { opacity: 1, transform: 'scale(1.045)', offset: 0.45 },
    { transform: 'scale(.985)', offset: 0.68 },
    { transform: 'scale(1.006)', offset: 0.86 },
    { opacity: 1, transform: 'none' },
  ], { duration: 640, easing: 'cubic-bezier(.25,.8,.35,1)' });
  setTimeout(() => $('[data-a=go]')?.focus(), 50);
}
