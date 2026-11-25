// The audio-quality pill under the artist ("FLAC · 24-bit · 48 kHz") and the "Información de audio"
// panel it opens: the source file, the signal, loudness, the real processing chain right now and,
// for local files, a spectrogram, a quality analysis and a hi-res authenticity check (worked out in
// audio-analysis-worker.js, so playback never waits on them).
import { api, h, esc, icon, state, store, streamUrl } from './core.js';
import { tr } from './i18n.js';
import { EQ_PRESETS } from './engine.js';

let engine = null, player = null;
export function initAudioInfo(deps) { ({ engine, player } = deps); }

const kHz = (hz) => `${(hz / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} kHz`;
const dB = (x, d = 1) => (Number.isFinite(x) ? `${x > 0 ? '+' : ''}${x.toFixed(d)} dB` : '−∞ dB');
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const mb = (n) => `${(n / 1048576).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;

const CODEC_NAMES = () => ({ FLAC: 'Free Lossless Audio Codec', ALAC: 'Apple Lossless', MP3: 'MPEG-1 Layer III', AAC: 'Advanced Audio Coding', PCM: tr('sin comprimir') });
function codecName(codec, mime) {
  const c = `${codec || ''} ${mime || ''}`.toLowerCase();
  if (/opus/.test(c)) return 'Opus';
  if (/mp4a|aac/.test(c)) return 'AAC';
  if (/flac/.test(c)) return 'FLAC';
  if (/alac/.test(c)) return 'ALAC';
  if (/layer 3|mp3|mpeg audio/.test(c)) return 'MP3';
  if (/vorbis/.test(c)) return 'Vorbis';
  if (/pcm|wav/.test(c)) return 'PCM';
  return codec ? String(codec).toUpperCase() : null;
}
function containerName(mime, ext) {
  if (ext) return String(ext).toUpperCase();
  const m = String(mime || '').toLowerCase();
  if (m.includes('webm')) return 'WebM';
  if (m.includes('mp4')) return 'MP4';
  if (m.includes('wav')) return 'WAV';
  if (m.includes('ogg')) return 'Ogg';
  return null;
}

/** What's known about the song that's playing (nothing made up: unknown stays null). */
async function sourceOf(t) {
  const local = !!t.local && !t.remote, f = t.file || {};
  let s = null, d = null;
  if (!t.local) { try { s = await api('streamInfo', t.id); } catch {} }
  if (local) { try { d = await api('localDetails', t.id); } catch {} }
  const codec = codecName(t.local ? f.codec || t.codec : s?.codec, s?.mime);
  const lossless = t.local ? !!f.lossless || codec === 'PCM' : /^(PCM|FLAC|ALAC)$/.test(codec || '');
  const rate = (t.local ? f.sampleRate || t.sampleRate : s?.sampleRate) || null;
  const bits = lossless && t.local ? f.bitDepth || null : null;
  return {
    t, local, remote: !!t.remote, s, d, codec, lossless, rate, bits,
    profile: d?.profile || f.profile || '',
    container: t.local ? d?.container || f.container || f.ext : containerName(s?.mime),
    kbps: (t.local ? f.bitrate || t.bitrate : s?.bitrate) || null,
    channels: (t.local ? d?.channels || f.channels : s?.channels) || null,
    size: t.local ? f.size : s?.size || null,
    duration: t.duration || engine?.duration || 0,
    client: t.local ? (t.remote ? 'WebDAV' : null) : s?.client || null,
    loudnessDb: s?.loudnessDb ?? null,
  };
}

// ---------------------------------------------------------------- the pill
let pillFor = null;
/** Draws the pill into `el` for the song that's playing. */
export async function renderPill(el) {
  const t = player.current;
  if (!t) { el.innerHTML = ''; return; }
  const src = await sourceOf(t);
  if (player.current?.id !== t.id) return;
  const parts = [src.codec?.toUpperCase(), src.bits && `${src.bits}-bit`, src.rate && kHz(src.rate)].filter(Boolean);
  const key = t.id + parts.join();
  if (pillFor === key && el.firstChild) return;
  pillFor = key;
  if (!parts.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<button class="aq-pill" title="${esc(tr('Información de audio'))}">${icon('visualizer')}<span>${esc(parts.join(' · '))}</span></button>`;
  el.querySelector('button').onclick = () => openAudioInfo();
  el.classList.remove('in'); void el.offsetWidth; el.classList.add('in');
}

// ---------------------------------------------------------------- the panel
const cache = new Map(); // track id → { analysis, verify } (the last few)
let current = null;      // the open panel

export async function openAudioInfo() {
  const t = player.current;
  if (!t || current) return;
  const src = await sourceOf(t);
  const narrow = innerWidth <= 640;
  const pillText = [src.codec?.toUpperCase(), src.bits && `${src.bits}-bit`, src.rate && kHz(src.rate)].filter(Boolean).join(' · ');
  const m = h(`<div class="modal-back fade ai-back${narrow ? ' sheet' : ''}"><div class="modal mica ai">
    <div class="ai-head"><div><h3>${esc(tr('Información de audio'))}</h3>${pillText ? `<div class="ai-sub">${icon('visualizer')}<span>${esc(pillText)}</span></div>` : ''}</div>
      <button class="icon-btn ai-close" title="${esc(tr('Cerrar'))}">${icon('close')}</button></div>
    <div class="ai-body"></div>
  </div></div>`);
  const body = m.querySelector('.ai-body');
  body.append(...sections(src));
  if (src.local) body.append(...localSections(src));
  const box = m.querySelector('.ai');
  const close = () => {
    if (!current) return;
    current.worker?.terminate();
    current = null;
    document.removeEventListener('keydown', key, true);
    const a = box.animate(narrow ? [{ transform: 'none' }, { transform: 'translateY(100%)' }] : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.96)' }], { duration: 200, easing: 'ease-in' });
    m.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, easing: 'ease-in' });
    a.onfinish = () => m.remove();
  };
  const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  m.querySelector('.ai-close').onclick = close;
  m.addEventListener('mousedown', (e) => { if (e.target === m) close(); });
  document.addEventListener('keydown', key, true);
  current = { t, src, m, worker: null };
  document.body.append(m);
  box.animate(narrow
    ? [{ transform: 'translateY(100%)' }, { transform: 'none' }]
    : [{ opacity: 0, transform: 'scale(.94)' }, { opacity: 1, transform: 'none' }], { duration: narrow ? 320 : 260, easing: 'cubic-bezier(.2,.85,.25,1)' });
  if (src.local) startAnalysis();
}

const row = (label, value, cls = '') => `<div class="ai-row"><span>${esc(label)}</span><b class="${cls}">${esc(value)}</b></div>`;
const group = (title, rows) => h(`<section class="ai-sec"><h4>${esc(title)}</h4><div class="ai-g">${rows.filter(Boolean).join('')}</div></section>`);

function sections(src) {
  const st = state.settings, ctx = engine.ctx, out = [];
  const quality = src.lossless ? (src.bits > 16 || src.rate > 48000 ? tr('Alta resolución sin pérdida') : tr('Sin pérdida')) : tr('Con pérdida');
  out.push(group(tr('Archivo de origen'), [
    row(tr('Calidad'), quality, src.lossless ? 'accent' : ''),
    src.container && row(tr('Formato'), src.container),
    src.codec && row(tr('Códec'), src.codec + (src.profile ? ` (${src.profile})` : '')),
    src.rate && row(tr('Frecuencia de muestreo'), kHz(src.rate)),
    row(tr('Profundidad de bits'), src.bits ? `${src.bits}-bit` : src.lossless ? tr('Desconocida') : tr('No aplica (con pérdida)')),
    src.kbps && row(tr('Tasa de bits'), `${src.kbps.toLocaleString()} kbps`),
    src.channels && row(tr('Canales'), src.channels === 2 ? tr('2 (estéreo)') : src.channels === 1 ? tr('1 (mono)') : String(src.channels)),
    src.duration && row(tr('Duración'), fmtTime(src.duration)),
    src.size && row(tr('Tamaño'), mb(src.size)),
    src.d?.tool && row(tr('Codificador'), src.d.tool),
    row(tr('Origen'), src.local ? tr('Archivo de este equipo') : src.remote ? 'WebDAV' : `YouTube Music${src.client ? ' · ' + src.client : ''}`),
  ]));
  out.push(group(tr('Señal'), [
    src.rate && row(tr('Rango de frecuencias'), src.codec === 'Opus' ? tr('Hasta 20 kHz (límite de Opus)') : tr('Hasta {f} (Nyquist)', { f: kHz(src.rate / 2) })),
    row(tr('Rango dinámico teórico'), src.bits ? `${Math.round(6.02 * src.bits)} dB` : src.lossless ? tr('Desconocido') : tr('No aplica (con pérdida)')),
  ]));
  // Loudness: what the file or YouTube says, and what the normaliser is actually doing.
  const deck = engine.cur;
  const normOn = engine.normalize !== false;
  const applied = deck?.norm ? 20 * Math.log10(deck.norm.gain.value || 1) : 0;
  let gain;
  if (src.local) gain = src.d?.trackGain != null ? `${dB(src.d.trackGain, 2)} (ReplayGain)` : tr('Sin etiquetas ReplayGain');
  else gain = src.loudnessDb != null ? tr('{d} sobre la referencia de YouTube', { d: dB(src.loudnessDb) }) : tr('YouTube no la indica');
  out.push(group(tr('Sonoridad'), [
    row(tr('Ganancia de la pista'), gain),
    row(tr('Normalización de volumen'), !normOn ? tr('Desactivada') : Math.abs(applied) >= 0.05 ? tr('Activada · {d} aplicados', { d: dB(applied) }) : deck?.lastNormDb == null ? tr('Activada · sin dato de sonoridad, no cambia nada') : tr('Activada · sin cambio')),
  ]));
  // Processing: the chain this song goes through right now.
  const rate = src.rate, outRate = ctx.sampleRate;
  const speed = deck?.audio?.playbackRate || 1;
  const preset = EQ_PRESETS[st.eqPreset];
  const eqOn = st.eqEnabled !== false && ((st.eqBands || []).some((b) => b) || st.preamp);
  const latency = ((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000;
  const an = engine.analysisFor?.(src.t.id);
  const bpm = an?.bpm;
  // What Automix knows of this song (its AI analysis) and the mix it has planned out of it.
  const camelot = an?.camelot ? `${an.camelot.num}${an.camelot.letter}` : null;
  const mixStyle = { blend: tr('mezcla a ritmo'), filter: tr('mezcla con filtros'), crossfade: tr('fundido'), loop: tr('mezcla con bucles') }[engine.mixWindow?.style];
  const automixInfo = [
    tr('Activado · hasta {n} compases', { n: engine.automixBars }),
    bpm ? `${Math.round(bpm)} BPM` : null,
    camelot ? tr('tono {k}', { k: camelot }) : null,
    an?.gridConfidence != null && an.headBeats !== undefined ? tr('ritmo {p} % fiable', { p: Math.round(an.gridConfidence * 100) }) : null,
    mixStyle ? tr('próxima: {s}', { s: mixStyle }) : null,
  ].filter(Boolean).join(' · ');
  out.push(group(tr('Procesamiento'), [
    row(tr('Reproductor'), tr('BitChord (Chromium + Web Audio)')),
    row(tr('Decodificación'), tr('{c} → coma flotante de 32 bits', { c: src.codec || tr('Audio') })),
    row(tr('Remuestreo'), rate && rate !== outRate ? `${kHz(rate)} → ${kHz(outRate)}` : rate ? tr('No') : tr('A {f}', { f: kHz(outRate) })),
    row(tr('Velocidad'), Math.abs(speed - 1) < 0.001 ? tr('Normal') : tr('{x}× (con corrección de tono)', { x: speed.toFixed(2) })),
    row(tr('Ecualizador'), !eqOn ? tr('Desactivado') : `${tr('Activado')} · ${preset ? tr(preset.label) : tr('Personalizado')}${st.preamp ? ` · ${tr('preamplificador')} ${dB(st.preamp)}` : ''}`, eqOn ? 'accent' : ''),
    row(tr('Limitador'), tr('Activo · techo {d}', { d: `${engine.limiter.threshold.value} dBFS` })),
    row(tr('Volumen'), `${Math.round(store.get('volume', 0.8) * 100)} %`),
    row('AutoMix', engine.automix ? automixInfo : tr('Desactivado')),
    row(tr('Fundido'), engine.automix ? tr('Lo hace AutoMix') : engine.crossfade > 0 ? tr('{n} s', { n: engine.crossfade }) : engine.gapless ? tr('Sin pausas entre canciones') : tr('Desactivado')),
    row(tr('Ruta de la señal'), tr('Web Audio ({f}, coma flotante) → mezclador de Windows', { f: kHz(outRate) })),
    row(tr('Latencia de salida'), `${Math.round(latency)} ms`),
    row('Bit-perfect', tr('No: se procesa en coma flotante y Windows lo mezcla con el resto del sistema')),
  ]));
  return out;
}

// ---------------------------------------------------------------- local files: spectrogram and analysis
function localSections(src) {
  const spec = h(`<section class="ai-sec"><h4>${esc(tr('Espectrograma'))}</h4><div class="ai-card ai-spec">
    <div class="ai-spec-bar"><div class="seg ai-tabs"></div><button class="icon-btn ai-dl" title="${esc(tr('Descargar imagen'))}" disabled>${icon('download')}</button></div>
    <div class="ai-canvas-wrap"><canvas></canvas><div class="ai-wait"><div class="ai-prog"><i></i></div><span>${esc(tr('Decodificando el archivo…'))}</span></div></div>
  </div></section>`);
  const auth = h(`<section class="ai-sec"><div class="ai-card">
    <h5>${esc(tr('Autenticidad en alta resolución'))}</h5>
    <p class="muted">${esc(tr('Lee el archivo completo y comprueba su integridad, la profundidad de bits real, el rango de frecuencias y si tiene rastros de compresión con pérdida.'))}</p>
    <div class="ai-verify-out"></div>
    <button class="btn primary small ai-verify">${icon('search')}${esc(tr('Verificar'))}</button>
  </div></section>`);
  const qa = h(`<section class="ai-sec"><div class="ai-card"><h5>${esc(tr('Análisis de calidad'))}</h5><div class="ai-qa"><div class="ai-prog"><i></i></div></div></div></section>`);
  auth.querySelector('.ai-verify').onclick = () => runVerify();
  return [spec, qa, auth]; // (the authenticity check goes last)
}

function setProgress(p, label) {
  if (!current) return;
  current.m.querySelectorAll('.ai-prog i').forEach((i) => (i.style.transform = `scaleX(${Math.max(0.02, p).toFixed(3)})`));
  if (label) { const w = current.m.querySelector('.ai-wait span'); if (w) w.textContent = label; }
}
const STAGES = () => ({ spectrum: tr('Calculando el espectrograma…'), levels: tr('Midiendo niveles…'), truepeak: tr('Calculando el pico real…'), loudness: tr('Midiendo la sonoridad (LUFS)…') });

async function startAnalysis() {
  const cur = current, { t, src } = cur;
  const done = cache.get(t.id);
  if (done?.analysis) { showAnalysis(done.analysis); return; }
  try {
    // The file at its own sample rate (an OfflineAudioContext at that rate decodes without resampling).
    const buf = await (await fetch(streamUrl(t))).arrayBuffer();
    if (current !== cur) return;
    cur.head = new Uint8Array(buf.slice(0, 65536));
    setProgress(0.05, tr('Decodificando el archivo…'));
    const ab = await new OfflineAudioContext(1, 1, src.rate || 48000).decodeAudioData(buf);
    if (current !== cur) return;
    const channels = Array.from({ length: Math.min(2, ab.numberOfChannels) }, (_, i) => ab.getChannelData(i).slice());
    cur.decoded = { length: ab.length, rate: ab.sampleRate, channels: ab.numberOfChannels };
    const w = new Worker(new URL('./audio-analysis-worker.js', import.meta.url));
    cur.worker = w;
    w.onmessage = (e) => {
      const d = e.data;
      if (current !== cur) return;
      if (d.type === 'progress') { if (d.stage === 'md5' || d.stage === 'bits') verifyProgress(d.p); else setProgress(0.1 + d.p * 0.9, STAGES()[d.stage]); }
      if (d.type === 'analysis') { remember(t.id, { analysis: d.result }); showAnalysis(d.result); cur.analysis = d.result; cur.onAnalysis?.(); }
      if (d.type === 'verify') showVerify(d.result);
      if (d.type === 'error') fail(d.message);
    };
    w.postMessage({ cmd: 'analyze', channels, sampleRate: ab.sampleRate }, channels.map((c) => c.buffer));
  } catch (e) { if (current === cur) fail(tr('No se pudo decodificar este archivo aquí ({e}).', { e: e?.message || e })); }
}
function remember(id, data) {
  cache.set(id, { ...cache.get(id), ...data });
  while (cache.size > 3) cache.delete(cache.keys().next().value);
}
function fail(msg) {
  if (!current) return;
  current.m.querySelectorAll('.ai-wait span, .ai-qa').forEach((el) => (el.textContent = msg));
  current.m.querySelectorAll('.ai-prog').forEach((el) => el.remove());
}

function showAnalysis(a) {
  if (!current) return;
  const m = current.m;
  current.analysis = a;
  // Spectrogram with its tabs (stereo mix / channel 1 / channel 2).
  const tabs = m.querySelector('.ai-tabs');
  const names = a.spectrogram.views.map((v) => (v === 'mix' ? tr('Estéreo') : tr('Canal {n}', { n: v + 1 })));
  tabs.innerHTML = names.map((n, i) => `<button class="${i ? '' : 'on'}" data-i="${i}">${esc(n)}</button>`).join('');
  const canvas = m.querySelector('.ai-spec canvas');
  const draw = (i) => { drawSpectrogram(canvas, a, i); tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', +b.dataset.i === i)); };
  tabs.onclick = (e) => { const b = e.target.closest('button'); if (b) draw(+b.dataset.i); };
  draw(0);
  m.querySelector('.ai-wait')?.remove();
  const dl = m.querySelector('.ai-dl');
  dl.disabled = false;
  dl.onclick = () => canvas.toBlob((b) => { const u = URL.createObjectURL(b); const x = document.createElement('a'); x.href = u; x.download = `${current?.t.title || 'audio'} - ${tr('espectrograma')}.png`; x.click(); setTimeout(() => URL.revokeObjectURL(u), 5000); }, 'image/png');
  // Quality analysis: "icon Label: value" pairs that flow onto as many lines as they need.
  const src = current.src, cut = a.cutoff;
  const it = (ic, label, v) => `<span class="ai-q">${icon(ic)}<span>${esc(label)}:</span><b>${esc(v)}</b></span>`;
  const num = (x, d) => x.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  const long = CODEC_NAMES()[src.codec];
  m.querySelector('.ai-qa').innerHTML = `<div class="ai-qrow">
    ${it('ms-memory', tr('Códec'), src.codec + (long ? ` (${long})` : '') + (src.profile ? ` · ${src.profile}` : ''))}
    ${it('ms-graphic-eq', tr('Frecuencia de muestreo'), `${num(a.sampleRate / 1000, 1)} kHz`)}
    ${src.bits ? it('ms-description', tr('Profundidad de bits'), `${src.bits}-bit`) : ''}
    ${it('ms-data-object', tr('Formato decodificado'), 'f32')}
    ${src.kbps ? it('ms-speed', tr('Tasa de bits media del archivo'), `${num(src.kbps / 1000, 2)} Mbps`) : ''}
    ${it('ms-surround-sound', tr('Canales'), a.channels === 2 ? tr('2 (estéreo)') : a.channels === 1 ? tr('1 (mono)') : String(a.channels))}
    ${it('ms-timer', tr('Duración'), fmtTime(a.duration))}
    ${it('ms-ssid-chart', 'Nyquist', `${num(a.sampleRate / 2000, 1)} kHz`)}
    ${src.size ? it('ms-storage', tr('Tamaño'), mb(src.size)) : ''}
  </div>
  ${src.kbps ? `<p class="ai-note">${esc(tr('Incluye las etiquetas y el contenedor del archivo: puede no coincidir con la tasa del audio en sí.'))}</p>` : ''}
  <hr><div class="ai-qrow">
    ${it('ms-trending-up', tr('Rango dinámico'), `${num(a.dr, 2)} dB`)}
    ${it('ms-show-chart', tr('Pico'), `${num(a.peak, 2)} dB`)}
    ${it('ms-bar-chart', 'RMS', `${num(a.rms, 2)} dB`)}
    ${it('ms-volume-up', 'LUFS', Number.isFinite(a.lufs) ? `${num(a.lufs, 1)} LUFS` : '—')}
    ${it('ms-warning', tr('Pico real'), `${num(a.truePeak, 2)} dBTP`)}
    ${it('ms-error', tr('Recorte'), a.clips.toLocaleString())}
    ${it('ms-filter-alt', tr('Corte espectral'), `${num(cut.hz / 1000, 1)} kHz`)}
    ${it('ms-tag', tr('Muestras'), a.samples >= 1e6 ? `${num(a.samples / 1e6, 1)} M` : a.samples.toLocaleString())}
  </div>
  <hr><div class="ai-per-h">${esc(tr('Estadísticas por canal'))}</div><div class="ai-qrow">
    ${a.perChannel.map((c, i) => it('ms-surround-sound', tr('Canal {n}', { n: i + 1 }), `P ${num(c.peak, 1)} / R ${num(c.rms, 1)} / DR ${num(c.dr, 1)} / Clip ${c.clips}`)).join('')}
  </div>`;
  const done = cache.get(current.t.id);
  if (done?.verify) showVerify(done.verify);
}

// ---- spectrogram drawing (inferno-like colours, linear frequency like the reference)
const LUT = (() => {
  const stops = [[0, 0, 0, 4], [0.25, 87, 16, 110], [0.5, 188, 55, 84], [0.75, 249, 142, 9], [1, 252, 255, 164]];
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const x = i / 255; let k = 0;
    while (k < stops.length - 2 && x > stops[k + 1][0]) k++;
    const [x0, ...a] = stops[k], [x1, ...b] = stops[k + 1], f = (x - x0) / (x1 - x0);
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = Math.round(a[c] + (b[c] - a[c]) * f);
  }
  return lut;
})();
function drawSpectrogram(canvas, a, view) {
  // Drawn at the size it's shown and at the screen's pixel density, so the labels stay legible.
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(300, canvas.parentElement.clientWidth || 560), H = Math.round(Math.min(360, Math.max(250, W * 0.52)));
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); canvas.style.height = H + 'px';
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const L = 44, T = 8, PW = W - L - 10, PH = H - T - 66;
  const { cols, bins, images } = a.spectrogram, img = images[view];
  const font = getComputedStyle(document.body).fontFamily;
  g.fillStyle = '#0b0b0d'; g.fillRect(0, 0, W, H);
  // Plot: each pixel takes the loudest bin it covers (so thin tones don't vanish).
  const pw = Math.round(PW * dpr), ph = Math.round(PH * dpr);
  const data = g.createImageData(pw, ph);
  for (let x = 0; x < pw; x++) {
    const c = Math.min(cols - 1, Math.floor(x * cols / pw)), base = c * bins;
    for (let y = 0; y < ph; y++) {
      const b0 = Math.floor((ph - 1 - y) * bins / ph), b1 = Math.max(b0 + 1, Math.floor((ph - y) * bins / ph));
      let v = 0; for (let b = b0; b < b1; b++) if (img[base + b] > v) v = img[base + b];
      const o = (y * pw + x) * 4;
      data.data[o] = LUT[v * 3]; data.data[o + 1] = LUT[v * 3 + 1]; data.data[o + 2] = LUT[v * 3 + 2]; data.data[o + 3] = 255;
    }
  }
  g.putImageData(data, Math.round(L * dpr), Math.round(T * dpr));
  // Axes.
  g.font = `11px ${font}`; g.fillStyle = 'rgba(255,255,255,.7)'; g.strokeStyle = 'rgba(255,255,255,.12)';
  const nyq = a.sampleRate / 2, stepF = nyq > 30000 ? 10000 : 5000;
  g.textAlign = 'right'; g.textBaseline = 'middle';
  for (let f = 0; f <= nyq; f += stepF) { const y = T + PH - f / nyq * PH; g.fillText(f ? `${f / 1000}k` : '0', L - 6, y); g.beginPath(); g.moveTo(L, y); g.lineTo(L + PW, y); g.stroke(); }
  const dur = a.duration, stepT = dur > 600 ? 120 : dur > 240 ? 60 : dur > 90 ? 30 : 10;
  g.textAlign = 'center'; g.textBaseline = 'top';
  for (let s = 0; s <= dur; s += stepT) {
    const x = L + s / dur * PW;
    g.textAlign = x > L + PW - 16 ? 'right' : 'center'; // (the last mark stays inside)
    g.fillText(fmtTime(s), Math.min(x, L + PW), T + PH + 6);
  }
  // dBFS colour bar.
  const by = T + PH + 28, bw = PW * 0.6, bx = L + (PW - bw) / 2;
  const grad = g.createLinearGradient(bx, 0, bx + bw, 0);
  for (let i = 0; i <= 8; i++) { const v = Math.round(i / 8 * 255); grad.addColorStop(i / 8, `rgb(${LUT[v * 3]},${LUT[v * 3 + 1]},${LUT[v * 3 + 2]})`); }
  g.fillStyle = grad; g.beginPath(); g.roundRect(bx, by, bw, 10, 5); g.fill();
  g.fillStyle = 'rgba(255,255,255,.7)'; g.textBaseline = 'middle';
  g.textAlign = 'right'; g.fillText('−120 dBFS', bx - 8, by + 5);
  g.textAlign = 'left'; g.fillText('0 dBFS', bx + bw + 8, by + 5);
  g.textAlign = 'left'; g.textBaseline = 'bottom'; g.fillStyle = 'rgba(255,255,255,.55)';
  g.fillText(W < 460 ? `${a.sampleRate.toLocaleString()} Hz` : tr('Frecuencia de muestreo: {f} Hz', { f: a.sampleRate.toLocaleString() }), L, H - 6);
  g.textAlign = 'right'; g.fillText(`Nyquist: ${kHz(nyq)}`, L + PW, H - 6);
}

// ---- authenticity
function verifyProgress(p) {
  const out = current?.m.querySelector('.ai-verify-out');
  const bar = out?.querySelector('.ai-prog i');
  if (bar) bar.style.transform = `scaleX(${Math.max(0.02, p).toFixed(3)})`;
}
function runVerify() {
  const cur = current;
  if (!cur) return;
  const out = cur.m.querySelector('.ai-verify-out'), btn = cur.m.querySelector('.ai-verify');
  btn.disabled = true;
  out.innerHTML = `<div class="ai-prog"><i></i></div><span class="muted">${esc(tr('Comprobando…'))}</span>`;
  const go = () => {
    if (current !== cur) return;
    const head = cur.head || new Uint8Array();
    let flacMd5 = null, total = null;
    // FLAC: STREAMINFO is the first metadata block; its last 16 bytes are the MD5 of the audio.
    if (head[0] === 0x66 && head[1] === 0x4c && head[2] === 0x61 && head[3] === 0x43 && (head[4] & 0x7f) === 0) {
      flacMd5 = [...head.subarray(26, 42)].map((b) => b.toString(16).padStart(2, '0')).join('');
      total = (head[21] & 0x0f) * 2 ** 32 + ((head[22] << 24) >>> 0) + (head[23] << 16) + (head[24] << 8) + head[25];
    }
    cur.worker.postMessage({ cmd: 'verify', bitDepth: cur.src.bits, cutoff: cur.analysis.cutoff, flacMd5, numberOfSamples: total || cur.src.d?.numberOfSamples || null });
  };
  if (cur.analysis && cur.worker) go();
  else if (cache.get(cur.t.id)?.analysis && !cur.worker) { out.innerHTML = `<span class="muted">${esc(tr('Vuelve a abrir el panel para verificar este archivo.'))}</span>`; btn.disabled = false; }
  else cur.onAnalysis = go;
}
function showVerify(r) {
  if (!current) return;
  remember(current.t.id, { verify: r });
  const a = current.analysis, src = current.src;
  const out = current.m.querySelector('.ai-verify-out'), btn = current.m.querySelector('.ai-verify');
  if (btn) { btn.disabled = false; btn.lastChild.textContent = tr('Volver a verificar'); }
  const by = Object.fromEntries(r.checks.map((c) => [c.key, c]));
  const mark = (ok) => icon(ok === false ? 'ms-warning' : ok == null ? 'ms-info' : 'ms-check-circle');
  const head = (ok, title) => `<div class="ai-vh ${ok === false ? 'bad' : ok == null ? 'meh' : 'ok'}">${mark(ok)}<b>${esc(title)}</b></div>`;
  const kv = (k, v) => `<div class="ai-kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`;
  const kHz1 = (hz) => `${(hz / 1000).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} kHz`;
  const parts = [];
  const fails = r.checks.filter((c) => c.ok === false);

  // Verdict and the average spectrum.
  parts.push(`${head(!fails.length, fails.length ? tr('Se han encontrado problemas') : tr('No se han encontrado problemas'))}
    <p>${esc(fails.length ? tr('Hay indicios en el audio de que no es lo que dice ser: mira los apartados marcados.') : tr('Nada en el audio apunta a daños, reescalado ni compresión con pérdida.'))}</p>
    ${a?.spectrum ? `<div class="ai-chart-h">${esc(tr('Espectro medio'))}</div><canvas class="ai-chart"></canvas>` : ''}`);

  // Integrity.
  const g = by.integrity;
  if (g) {
    const text = g.md5 ? (g.md5.ok ? tr('El audio coincide con la huella que guarda el archivo.') : tr('El audio NO coincide con la huella que guarda el archivo: puede estar dañado.'))
      : g.ok ? tr('Se decodifica entero y sin errores. Este formato no guarda una huella con la que comprobarlo más a fondo.') : tr('Le faltan muestras respecto a lo que indica su cabecera.');
    parts.push(`${head(g.md5 ? g.md5.ok : g.ok, tr('Integridad'))}<p>${esc(text)}</p>
      ${g.md5 ? kv(tr('Huella (MD5)'), g.md5.computed) : ''}`);
  }

  // Bit depth.
  const b = by.bits;
  if (b) {
    const text = b.float ? tr('Las muestras no son números enteros: el audio se guardó desde coma flotante.')
      : b.ok ? tr('Los {n} bits llevan audio.', { n: b.declared }) : tr('Solo {r} de los {d} bits llevan audio: el resto es relleno.', { r: b.real, d: b.declared });
    parts.push(`${head(b.float ? null : b.ok, tr('Profundidad de bits'))}<p>${esc(text)}</p>
      ${b.float ? '' : kv(tr('Bits activos / almacenados'), `${b.real} / ${b.declared}`) + kv(tr('Resolución medida'), tr('{n} bits', { n: b.real }))}`);
  }

  // Frequency range.
  const rg = by.range, cut = a?.cutoff;
  if (rg && cut) {
    const full = cut.hz >= cut.nyquist * 0.98;
    const text = rg.upsampled ? tr('El sonido termina en {f}, muy por debajo de los {n} que permite el archivo: probablemente se remuestreó desde 44,1 o 48 kHz.', { f: kHz1(cut.hz), n: kHz1(cut.nyquist) })
      : full ? tr('El espectro llega hasta el final sin ningún corte brusco.') : tr('El sonido se apaga cerca de {f}, sin un corte brusco.', { f: kHz1(cut.hz) });
    parts.push(`${head(rg.ok, tr('Rango de frecuencias'))}<p>${esc(text)}</p>
      ${kv(tr('Frecuencia de muestreo'), kHz1(a.sampleRate))}${kv('Nyquist', kHz1(cut.nyquist))}
      ${kv(tr('Corte estimado'), full ? tr('No hay (llega hasta Nyquist)') : `~${kHz1(cut.hz)}`)}
      ${full ? '' : kv(tr('Paso bajo'), tr('{f}, caída de {d} dB', { f: kHz1(cut.hz), d: Math.round(cut.drop) }))}`);
  }

  // Lossy compression.
  const l = by.lossy;
  if (l) {
    const text = l.ok ? tr('El espectro no tiene el corte brusco que dejan MP3 y AAC. Opus y un remuestreo posterior no siempre dejan esa huella, así que esto no descarta del todo un origen con pérdida.')
      : tr('Corte brusco a {f} (caída de {d} dB): es la huella típica de MP3 o AAC.', { f: kHz1(l.hz), d: Math.round(l.drop) });
    const hasCut = cut && cut.hz < cut.nyquist * 0.98; // (with no cut-off there's no drop to show)
    parts.push(`${head(l.ok, tr('Compresión con pérdida'))}<p>${esc(text)}</p>${hasCut ? kv(tr('Caída en el corte'), `${Math.round(l.drop)} dB`) : ''}`);
  }

  parts.push(`<p class="ai-foot">${esc(tr('Se ha leído todo el audio ({d}). Ningún análisis puede certificar el máster original.', { d: fmtTime(a?.duration || src.duration || 0) }))}</p>`);
  out.innerHTML = parts.map((x) => `<div class="ai-vblock">${x}</div>`).join('');
  const chart = out.querySelector('.ai-chart');
  if (chart) drawSpectrumChart(chart, a);
}

/** The average spectrum as an area, with a mark where the sound is cut off (if it is). */
function drawSpectrumChart(canvas, a) {
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(260, canvas.parentElement.clientWidth || 500), H = 150;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); canvas.style.height = H + 'px';
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const PH = H - 22, spec = a.spectrum, n = spec.length, nyq = a.sampleRate / 2;
  const top = Math.max(...spec), lo = top - 100;
  const y = (d) => Math.min(PH, Math.max(0, (top - d) / (top - lo) * PH));
  const accent = getComputedStyle(document.body).getPropertyValue('--accent-light').trim() || '#ff8a8a';
  const font = getComputedStyle(document.body).fontFamily;
  g.clearRect(0, 0, W, H);
  g.strokeStyle = 'rgba(255,255,255,.1)'; g.lineWidth = 1;
  for (const f of [1 / 3, 2 / 3]) { g.beginPath(); g.moveTo(0, PH * f); g.lineTo(W, PH * f); g.stroke(); }
  g.fillStyle = 'rgba(255,255,255,.55)'; g.font = `11px ${font}`; g.textAlign = 'center'; g.textBaseline = 'top';
  const step = nyq > 30000 ? 10000 : 5000;
  for (let f = step; f < nyq; f += step) { const x = f / nyq * W; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, PH); g.stroke(); g.fillText(`${f / 1000}k`, x, PH + 6); }
  g.beginPath(); g.moveTo(0, PH);
  for (let i = 0; i < n; i++) g.lineTo(i / (n - 1) * W, y(spec[i]));
  g.lineTo(W, PH); g.closePath();
  g.fillStyle = 'rgba(255,255,255,.08)'; g.fill();
  g.beginPath();
  for (let i = 0; i < n; i++) { const X = i / (n - 1) * W; i ? g.lineTo(X, y(spec[i])) : g.moveTo(X, y(spec[i])); }
  g.strokeStyle = accent; g.lineWidth = 1.6; g.stroke();
  const cut = a.cutoff;
  if (cut && cut.hz < cut.nyquist * 0.98) {
    const x = cut.hz / nyq * W;
    g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(x, 6); g.lineTo(x, PH); g.stroke();
    g.fillStyle = 'rgba(255,255,255,.85)'; g.beginPath(); g.moveTo(x - 5, 0); g.lineTo(x + 5, 0); g.lineTo(x, 7); g.closePath(); g.fill();
  }
}
