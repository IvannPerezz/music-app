// "Círculo" mode of the cover and lyrics view, Trap Nation style: the round cover (or the animated
// cover, when the song has one) in the middle beats with the bass, a ring of spectrum waves around
// it (mirrored left/right) and particles flying outwards that speed up on each kick. Plain 2D
// canvas in the main window, over the view's blurred background. Options in Ajustes del círculo.
import { state } from './core.js';

const BARS = 72;      // points per half of the ring
const PARTICLES = 140;

let canvas = null, ctx = null, analyser = null, freq = null, raf = 0;
let bassAn = null, bassBuf = null, playing = () => true;
let w = 0, h = 0, dpr = 1;
const smooth = new Float32Array(BARS);
const slow = new Float32Array(BARS); // a lagging copy for the second, softer layer
const peak = new Float32Array(BARS).fill(0.3); // each band's recent maximum (evens out bass and treble)
let bassAvg = 0.2, bassPeak = 0.4, kick = 0, pulse = 0;
// Turntable: angle of the cover, its speed (eases to a stop when paused) and the cross-fade
// from the previous cover to the next one.
let angle = 0, spin = 0, lastT = 0, shownPic = null, prevPic = null, fadeAt = 0;
let cover = null, coverSrc = '', accent = '#ff5a36', accentAt = 0;
const parts = [];

export function mountCircle(host, ctxAudio, tapNode, isPlaying) {
  if (canvas) return;
  if (isPlaying) playing = isPlaying;
  // The kick is read from its own analyser: finer bass bins and almost no smoothing, so each hit
  // comes through sharp (the ring's analyser is smoother on purpose).
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
export const circleMounted = () => !!canvas;

export function unmountCircle() {
  cancelAnimationFrame(raf); raf = 0;
  try { analyser?.disconnect(); } catch {}
  try { bassAn?.disconnect(); } catch {}
  canvas?.remove();
  canvas = ctx = analyser = bassAn = null;
  shownPic = prevPic = null;
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
function readCover() {
  const src = document.querySelector('#np-art')?.currentSrc || document.querySelector('#np-art')?.src || '';
  if (src === coverSrc) return;
  coverSrc = src;
  if (!src) { cover = null; return; }
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => { if (coverSrc === src) cover = img; };
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
  analyser.getByteFrequencyData(freq);
  const hz = analyser.context.sampleRate / analyser.fftSize;
  const st = state.settings;
  const gain = st.circleGain ?? 1, size = st.circleSize ?? 1, beat = st.circlePulse ?? 1;
  const color = st.circleColor === 'white' ? '#fff' : accent;

  // Kick (≈ 40–120 Hz): where the bass is between its recent average and its recent peak, so it
  // hits just as hard in a quiet song as in a loud one.
  bassAn.getByteFrequencyData(bassBuf);
  const bhz = bassAn.context.sampleRate / bassAn.fftSize;
  const b0 = Math.max(1, Math.floor(40 / bhz)), b1 = Math.ceil(120 / bhz);
  let bass = 0;
  for (let i = b0; i <= b1; i++) bass += bassBuf[i];
  bass = Math.pow(bass / ((b1 - b0 + 1) * 255), 1.4);
  bassAvg += (bass - bassAvg) * 0.025;
  bassPeak = Math.max(bassPeak * 0.996, bass, bassAvg + 0.04);
  const hit = Math.max(0, Math.min(1, (bass - bassAvg) / (bassPeak - bassAvg)));
  kick = hit > kick ? hit : kick * 0.82;         // instant attack, quick release: a thump
  pulse = Math.pow(kick, 1.5);

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
    slow[i] += (smooth[i] - slow[i]) * 0.18;
  }

  const c = ctx;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, w, h);
  const base = Math.min(w, h) * 0.16 * size;
  const R = base * (1 + pulse * 0.26 * beat);
  const shake = st.circleShake !== false && pulse > 0.45 ? (pulse - 0.45) * 22 * dpr * beat : 0;
  const cx = w / 2 + (Math.random() - 0.5) * shake, cy = h * 0.44 + (Math.random() - 0.5) * shake;

  // Particles: drift outwards, faster with the bass.
  const far = Math.hypot(w, h) / 2;
  c.fillStyle = '#fff';
  if (st.circleParticles !== false) for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    p.d += p.v * (1 + pulse * 9);
    if (p.d > 1) { parts[i] = newPart(false); continue; }
    const r = R + p.d * (far - R);
    c.globalAlpha = p.o * Math.min(1, p.d * 6) * (1 - p.d * 0.6);
    c.beginPath();
    c.arc(cx + Math.cos(p.a) * r, cy + Math.sin(p.a) * r, p.s * dpr * (1 + pulse * 0.6), 0, Math.PI * 2);
    c.fill();
  }
  c.globalAlpha = 1;

  // Wave layers (back to front): accent glow, softer accent, white.
  const layer = (vals, scale, fill, glow) => {
    c.beginPath();
    const pts = [];
    for (let s = 0; s < 2; s++) for (let i = 0; i < BARS; i++) {
      // Right half top→bottom, then left half bottom→top: a symmetric ring, bass at the top.
      const j = s ? BARS - 1 - i : i;
      const t = (s ? BARS + i : i) / (BARS * 2);
      const ang = -Math.PI / 2 + t * Math.PI * 2;
      const ext = R * 1.02 + Math.min(1.6, vals[j] * gain) * base * scale * (1 + pulse * 0.45 * beat);
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
  c.globalAlpha = 0.55; layer(slow, 1.25, color, color);
  c.globalAlpha = 0.8; layer(smooth, 0.95, color, '');
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
  // Like a record on a turntable: it turns while the music plays and eases to a stop on pause.
  const now = performance.now(), dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 0;
  lastT = now;
  const want = st.circleSpin !== false && playing() ? (Math.PI * 2) / 8 * (st.circleSpinSpeed ?? 1) : 0;
  spin += (want - spin) * Math.min(1, dt * 2.5);
  angle = (angle + spin * dt) % (Math.PI * 2);
  if (st.circleSpin === false && spin < 0.01) angle *= 0.9; // back upright
  const pic = liveVideo() || cover;
  if (pic !== shownPic) { prevPic = shownPic; shownPic = pic; fadeAt = now; }
  const fade = prevPic ? Math.min(1, (now - fadeAt) / 900) : 1;
  if (fade >= 1) prevPic = null;
  c.translate(cx, cy);
  c.rotate(angle);
  const paint = (p, alpha) => {
    c.globalAlpha = alpha;
    if (!p) { c.fillStyle = accent; c.fillRect(-R, -R, R * 2, R * 2); return; }
    const pw = p.videoWidth || p.naturalWidth, ph = p.videoHeight || p.naturalHeight;
    const s = Math.max((R * 2) / pw, (R * 2) / ph);
    c.drawImage(p, -pw * s / 2, -ph * s / 2, pw * s, ph * s);
  };
  if (prevPic) paint(prevPic, 1);
  paint(shownPic, fade * fade * (3 - 2 * fade)); // the next cover fades in over the last one
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
