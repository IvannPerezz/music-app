// "Círculo" mode of the cover and lyrics view, Trap Nation style: the round cover (or the animated
// cover, when the song has one) in the middle beats with the bass, a ring of spectrum waves around
// it (mirrored left/right) and particles flying outwards that speed up on each kick. Plain 2D
// canvas in the main window, over the view's blurred background. Options in Ajustes del círculo.
import { state } from './core.js';

const BARS = 72;      // points per half of the ring
const PARTICLES = 140;
// The sound is read and the motion worked out 60 times a second, whatever the screen's refresh
// rate: on a 144 or 360 Hz screen every kick used to fade out several times sooner (and the jump
// that tells a kick was split into tiny steps), so the circle barely moved.
const STEP = 1000 / 60;
// The ring's trail, Trap Nation style: the same waves a few moments late, bigger and fainter behind.
const TRAIL = [[9, 1.2, 0.24], [6, 1.12, 0.36], [3, 1.04, 0.52], [0, 0.95, 0.8]]; // [steps late, size, opacity]
const HIST = 10;

let canvas = null, ctx = null, analyser = null, freq = null, raf = 0;
let bassAn = null, bassBuf = null;
let w = 0, h = 0, dpr = 1;
const smooth = new Float32Array(BARS);
const hist = Array.from({ length: HIST }, () => new Float32Array(BARS)); // the last moments of `smooth`
let histAt = 0, lastT = 0, acc = 0, shx = 0, shy = 0;
const peak = new Float32Array(BARS).fill(0.3); // each band's recent maximum (evens out bass and treble)
let bassAvg = 0.2, prevBass = 0, kick = 0, pulse = 0;
let cover = null, coverSrc = '', accent = '#ff5a36', accentAt = 0;
// Song change: the last picture shown (frozen) while the next cover loads, then a quick spin from
// it to the new one. The animated cover, if the song has one, fades in once the spin is over.
const SPIN_MS = 950;
let held = null, trans = null, vid = null, vidAt = 0, lastDrawn = null;
const parts = [];

export function mountCircle(host, ctxAudio, tapNode) {
  if (canvas) return;
  // A second analyser, with finer bass bins and almost no smoothing, catches the moment each kick
  // lands (the ring's analyser is smoother on purpose).
  bassAn = ctxAudio.createAnalyser();
  bassAn.fftSize = 4096;
  bassAn.smoothingTimeConstant = 0.15;
  tapNode.connect(bassAn);
  bassBuf = new Uint8Array(bassAn.frequencyBinCount);
  analyser = ctxAudio.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.72;
  tapNode.connect(analyser);
  freq = new Uint8Array(analyser.frequencyBinCount);
  canvas = document.createElement('canvas');
  canvas.id = 'np-vis-circle';
  canvas.setAttribute('aria-hidden', 'true');
  ctx = canvas.getContext('2d');
  // Over the view's blurred background, under the song details and the controls.
  const inner = host.querySelector('.np-inner');
  if (inner) inner.before(canvas); else host.prepend(canvas);
  for (let i = 0; i < PARTICLES; i++) parts.push(newPart(true));
  const loop = () => { raf = requestAnimationFrame(loop); drawCircle(); };
  raf = requestAnimationFrame(loop);
}

export function unmountCircle() {
  cancelAnimationFrame(raf); raf = 0;
  try { analyser?.disconnect(); } catch {}
  try { bassAn?.disconnect(); } catch {}
  canvas?.remove();
  canvas = ctx = analyser = bassAn = null;
  cover = held = trans = vid = lastDrawn = null;
  coverSrc = '';
  lastT = acc = 0;
  parts.length = 0;
}

function newPart(anywhere) {
  const a = Math.random() * Math.PI * 2;
  return { a, d: anywhere ? Math.random() : 0, v: 0.0012 + Math.random() * 0.0028, s: 0.6 + Math.random() * 1.8, o: 0.25 + Math.random() * 0.6 };
}

function resize() {
  const r = canvas.getBoundingClientRect();
  dpr = Math.min(2, devicePixelRatio || 1);
  if (r.width * dpr !== w || r.height * dpr !== h) {
    w = canvas.width = Math.round(r.width * dpr);
    h = canvas.height = Math.round(r.height * dpr);
  }
}

// The animated cover (a looping video, see updateCanvas in app.js) when the song has one.
function liveVideo() {
  const v = document.getElementById('np-canvas');
  return v && v.readyState >= 2 && v.videoWidth ? v : null;
}
/** A still, square copy of what was on screen (the animated cover's video goes away with its song). */
function snapshot(p) {
  const pw = p && (p.videoWidth || p.naturalWidth || p.width), ph = p && (p.videoHeight || p.naturalHeight || p.height);
  if (!pw || !ph) return null;
  const o = document.createElement('canvas');
  o.width = o.height = 640;
  const s = Math.max(640 / pw, 640 / ph);
  try { o.getContext('2d').drawImage(p, (640 - pw * s) / 2, (640 - ph * s) / 2, pw * s, ph * s); } catch { return null; }
  return o;
}
function readCover() {
  const src = document.querySelector('#np-art')?.currentSrc || document.querySelector('#np-art')?.src || '';
  if (src === coverSrc) return;
  const first = !coverSrc;
  coverSrc = src;
  if (!src) { cover = null; return; }
  if (!first) { held = snapshot(lastDrawn) || held; trans = null; }
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => {
    if (coverSrc !== src) return;
    cover = img;
    if (held) trans = { from: held, at: performance.now() };
    held = null;
  };
  img.src = src;
}

/** One frame. */
function drawCircle() {
  if (!canvas || !canvas.isConnected) return;
  resize();
  if (!w || !h) return;
  if (performance.now() - accentAt > 1000) {
    accentAt = performance.now();
    accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || accent;
  }
  readCover();
  const st = state.settings;
  const gain = st.circleGain ?? 1, size = st.circleSize ?? 1, beat = st.circlePulse ?? 1;
  const color = st.circleColor === 'white' ? '#fff' : accent;
  const now = performance.now();
  const dt = lastT ? Math.min(100, now - lastT) : STEP;
  lastT = now;
  acc += dt;
  for (let n = 0; acc >= STEP; n++) {
    if (n === 6) { acc = 0; break; } // (back from a pause: don't catch up)
    acc -= STEP;
    listen(beat);
  }
  draw(dt / STEP, gain, size, beat, color, now);
}

/** One step of the motion (1/60 s): the sound now, the kick and the ring's waves. */
function listen(beat) {
  analyser.getByteFrequencyData(freq);
  const hz = analyser.context.sampleRate / analyser.fftSize;

  // Bass (≈ 30–150 Hz): its level against a slow running average gives the kick…
  const b0 = Math.max(1, Math.floor(30 / hz)), b1 = Math.ceil(150 / hz);
  let bass = 0;
  for (let i = b0; i <= b1; i++) bass += freq[i];
  bass /= (b1 - b0 + 1) * 255;
  bassAvg += (bass - bassAvg) * 0.02;
  // …plus how much the low end jumped since the last frame (sharp analyser): that catches kicks
  // landing on top of a bass line that's loud all the time, which the level alone missed.
  bassAn.getByteFrequencyData(bassBuf);
  const bhz = bassAn.context.sampleRate / bassAn.fftSize;
  const k0 = Math.max(1, Math.floor(40 / bhz)), k1 = Math.ceil(120 / bhz);
  let low = 0;
  for (let i = k0; i <= k1; i++) low += bassBuf[i];
  low /= (k1 - k0 + 1) * 255;
  const rise = Math.max(0, low - prevBass);
  prevBass = low;
  const hit = Math.max(0, Math.min(1, (bass - bassAvg * 0.95) * 4 + bass * 0.35 + rise * 4));
  kick = hit > kick ? hit : kick * 0.86;         // fast attack, smooth release
  pulse += (kick - pulse) * 0.35;

  // Ring: log-spaced bands from ~40 Hz to ~6 kHz, fast up and slower down.
  const lo = Math.log(40), hi = Math.log(5000);
  for (let i = 0; i < BARS; i++) {
    const f0 = Math.exp(lo + (hi - lo) * (i / BARS)), f1 = Math.exp(lo + (hi - lo) * ((i + 1) / BARS));
    const a = Math.floor(f0 / hz), z = Math.max(a, Math.floor(f1 / hz));
    let v = 0;
    for (let k = a; k <= z; k++) v = Math.max(v, freq[k] || 0);
    v /= 255;
    // Each band against its own recent peak, so the treble side moves as much as the bass side.
    peak[i] = Math.max(peak[i] * 0.997, v, 0.12);
    v = Math.pow(v / peak[i], 2.2) * (0.35 + v * 0.65);
    smooth[i] = v > smooth[i] ? smooth[i] + (v - smooth[i]) * 0.6 : smooth[i] * 0.9 + v * 0.1;
  }
  histAt = (histAt + 1) % HIST;
  hist[histAt].set(smooth);
  // The shake moves at the same pace (a new offset every step, not on every screen refresh).
  const shake = state.settings.circleShake !== false && pulse > 0.5 ? (pulse - 0.5) * 20 * dpr * beat : 0;
  shx = (Math.random() - 0.5) * shake; shy = (Math.random() - 0.5) * shake;
}

/** One frame on screen; `k` is how many 1/60 s it covers (the particles move by it). */
function draw(k, gain, size, beat, color, now) {
  const c = ctx;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, w, h);
  const base = Math.min(w, h) * 0.16 * size;
  const R = base * (1 + pulse * 0.2 * beat);
  const cx = w / 2 + shx, cy = h * 0.44 + shy;

  // Particles: drift outwards, faster with the bass.
  const far = Math.hypot(w, h) / 2;
  c.fillStyle = '#fff';
  if (state.settings.circleParticles !== false) for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    p.d += p.v * (1 + pulse * 9) * k;
    if (p.d > 1) { parts[i] = newPart(false); continue; }
    const r = R + p.d * (far - R);
    c.globalAlpha = p.o * Math.min(1, p.d * 6) * (1 - p.d * 0.6);
    c.beginPath();
    c.arc(cx + Math.cos(p.a) * r, cy + Math.sin(p.a) * r, p.s * dpr * (1 + pulse * 0.6), 0, Math.PI * 2);
    c.fill();
  }
  c.globalAlpha = 1;

  // Wave layers (back to front): the trail in the aura colour, then white.
  const layer = (vals, scale, fill, glow) => {
    c.beginPath();
    const pts = [];
    for (let s = 0; s < 2; s++) for (let i = 0; i < BARS; i++) {
      // Right half top→bottom, then left half bottom→top: a symmetric ring, bass at the top.
      const j = s ? BARS - 1 - i : i;
      const t = (s ? BARS + i : i) / (BARS * 2);
      const ang = -Math.PI / 2 + t * Math.PI * 2;
      const ext = R * 1.02 + Math.min(1.6, vals[j] * gain) * base * scale;
      pts.push([cx + Math.cos(ang) * ext, cy + Math.sin(ang) * ext]);
    }
    // Smooth closed curve through the points.
    const n = pts.length;
    c.moveTo((pts[n - 1][0] + pts[0][0]) / 2, (pts[n - 1][1] + pts[0][1]) / 2);
    for (let i = 0; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      c.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
    }
    c.closePath();
    c.shadowColor = glow; c.shadowBlur = glow ? 30 * dpr : 0;
    c.fillStyle = fill;
    c.fill();
  };
  TRAIL.forEach(([late, scale, alpha], n) => {
    c.globalAlpha = alpha;
    layer(hist[(histAt - late + HIST) % HIST], scale, color, n ? '' : color);
  });
  c.globalAlpha = 1; layer(smooth, 0.55, '#fff', 'rgba(255,255,255,.6)');
  c.shadowBlur = 0;

  // The cover, round, with a white rim.
  c.save();
  c.beginPath();
  c.arc(cx, cy, R, 0, Math.PI * 2);
  c.closePath();
  c.fillStyle = '#111';
  c.fill();
  c.clip();
  const t = trans ? Math.min(1, (now - trans.at) / SPIN_MS) : 1;
  if (t >= 1) trans = null;
  // The animated cover only once the spin is over (and fading in, not popping).
  const v = !trans && !held ? liveVideo() : null;
  if (v !== vid) { vid = v; vidAt = now; }
  c.translate(cx, cy);
  const paint = (p, alpha) => {
    c.globalAlpha = alpha;
    if (!p) { c.fillStyle = accent; c.fillRect(-R, -R, R * 2, R * 2); return; }
    const pw = p.videoWidth || p.naturalWidth || p.width, ph = p.videoHeight || p.naturalHeight || p.height;
    const s = Math.max((R * 2) / pw, (R * 2) / ph);
    c.drawImage(p, -pw * s / 2, -ph * s / 2, pw * s, ph * s);
  };
  if (held) paint(held, 1); // (the next cover is still loading)
  else if (trans) {
    // One fast turn, speeding up and braking, with the new cover fading in around the middle.
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    c.rotate(e * Math.PI * 2);
    paint(trans.from, 1);
    const f = Math.max(0, Math.min(1, (t - 0.3) / 0.4));
    paint(cover, f * f * (3 - 2 * f));
  } else {
    paint(cover, 1);
    if (vid) paint(vid, Math.min(1, (now - vidAt) / 500));
  }
  lastDrawn = held || (vid && now - vidAt > 500 ? vid : cover);
  c.globalAlpha = 1;
  c.restore();
  c.lineWidth = Math.max(2, R * 0.035);
  c.strokeStyle = 'rgba(255,255,255,.95)';
  c.shadowColor = 'rgba(255,255,255,.7)';
  c.shadowBlur = 18 * dpr * (0.4 + pulse);
  c.beginPath();
  c.arc(cx, cy, R, 0, Math.PI * 2);
  c.stroke();
  c.shadowBlur = 0;
}
