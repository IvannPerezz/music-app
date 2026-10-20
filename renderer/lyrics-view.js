// Synced lyrics drawn the way Apple Music draws them: the lines glide on springs and the ones below
// follow a moment later (a cascade), lines further from the one being sung blur and dim, and each
// word fills with light as it's sung, floats up a little and glows; held words ripple letter by
// letter. Everything moves from one clock, computed every frame, so it keeps time with the voice at
// any refresh rate. Only the lines being sung are touched word by word; the rest is CSS.

const HELD = 1;          // a word sung at least this long (s) ripples letter by letter
const LEAD = 0.12;       // a line lights up this early, so its glide starts with the voice
const ANCHOR = 0.3;      // the sung line rests this far down the view
const STEP = 0.055;      // cascade: each line below the sung one moves this much later (s, at 100 %)
const CJK = /[぀-ヿ㐀-鿿가-힯]/;

let box = null, track = null, onSeek = null, footerEl = null;
let lines = [];
let cfg = { glow: 2, spread: 1, wave: 1, lift: 1, smooth: 1.5, cascade: 1, perf: false };
let scrollIdx = -2, activeSig = '', active = [];
let userOff = 0, browseUntil = 0;
let H = 0, fontPx = 30, lastFrame = 0, mountedAt = 0;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** Wires the view to its box once; `seek(time)` is called when a line is clicked. */
export function init(el, seek) {
  box = el; onSeek = seek;
  new ResizeObserver(() => relayout(true)).observe(box);
  // Browsing: the wheel moves the lyrics freely (all lines sharp); they glide back after 3 s.
  box.addEventListener('wheel', (e) => {
    if (!lines.length || !track?.isConnected) return;
    e.preventDefault();
    userOff = clampOff(userOff + e.deltaY);
    browseUntil = performance.now() + 3000;
    box.classList.add('browsing');
    retarget('now');
  }, { passive: false });
}

/** Builds the lines of a synced lyrics result; `footer` (the credit) scrolls along at the end. */
export function mount(l, { words = true, footer = null } = {}) {
  lines = []; active = []; activeSig = ''; scrollIdx = -2; userOff = 0; browseUntil = 0;
  mountedAt = performance.now();
  box.classList.remove('browsing');
  track = document.createElement('div');
  track.className = 'lyr-track';
  l.lines.forEach((ln, i) => {
    const el = document.createElement('div');
    const gap = !!(ln.gap || !ln.text);
    el.className = 'lyr-line' + (gap ? ' gap' : '') + (ln.align === 'end' ? ' end' : '');
    const txt = document.createElement('div');
    txt.className = 'lyr-txt';
    el.append(txt);
    const L = { el, txt, start: ln.time, end: 0, words: [], dots: null, y: 0, v: 0, tgt: 0, pend: null, pendAt: 0, top: 0, h: 0, wy: null, d: -1, on: false };
    if (gap) { txt.innerHTML = '<span class="lyr-dots"><i></i><i></i><i></i></span>'; L.dots = txt.firstChild; }
    else if (words && ln.words?.length) addWords(txt, ln.words, L);
    else txt.textContent = ln.text;
    if (!gap && ln.bg?.text) {
      const bg = document.createElement('div');
      bg.className = 'lyr-bg';
      if (words && ln.bg.words?.length) addWords(bg, ln.bg.words, L); else bg.textContent = ln.bg.text;
      txt.append(bg);
    }
    const next = l.lines[i + 1];
    const sung = L.words.length ? Math.max(...L.words.map((w) => w.end)) : 0;
    L.end = gap ? (next?.time ?? ln.time + 5) : sung || ln.end || (next?.time ?? ln.time + 6);
    el.onclick = () => onSeek?.(ln.time);
    track.append(el);
    lines.push(L);
  });
  footerEl = footer;
  if (footer) track.append(footer);
  return track;
}

/** Forget the lines (plain or no lyrics are shown instead). */
export function unmount() { lines = []; active = []; track = null; footerEl = null; box?.classList.remove('browsing'); }

function addWords(parent, ws, L) {
  ws.forEach((w, k) => {
    const chars = [...w.text];
    const el = document.createElement('span');
    el.className = 'w';
    const parts = w.parts?.length ? w.parts : [{ start: w.start, end: w.end, len: chars.length }];
    const W = {
      el, start: w.start, end: Math.max(w.end, w.start + 0.05), parts,
      len: parts.reduce((s, p) => s + p.len, 0) || 1, letters: null, held: false, pk: '', tk: '', gk: '',
    };
    W.held = W.end - W.start >= HELD && chars.length >= 2 && chars.length <= 14 && !CJK.test(w.text);
    if (W.held) {
      el.classList.add('held');
      W.letters = chars.map((c) => { const s = document.createElement('span'); s.className = 'ch'; s.textContent = c; el.append(s); s._k = ''; return s; });
    } else el.textContent = w.text;
    parent.append(el);
    if (k < ws.length - 1) parent.append(' ');
    L.words.push(W);
  });
}

/** Settings → CSS variables (look) and motion parameters, applied live. */
export function style(s) {
  const n = (k, d) => (typeof s[k] === 'number' ? s[k] : d);
  cfg = {
    glow: n('lyricsGlow', 200) / 100, spread: n('lyricsGlowSpread', 100) / 100, wave: n('lyricsWave', 100) / 100,
    lift: n('lyricsLift', 100) / 100, smooth: Math.max(0.3, n('lyricsSmooth', 150) / 100), cascade: n('lyricsCascade', 100) / 100,
    perf: document.body.classList.contains('perf'),
  };
  if (!box) return;
  const v = box.style;
  v.setProperty('--lyr-size', n('lyricsFontSize', 30) + 'px');
  v.setProperty('--lyr-unsung', n('lyricsUnsung', 30) / 100);
  v.setProperty('--lyr-other', n('lyricsOtherSize', 97) / 100);
  v.setProperty('--lyr-blur', (0.9 * n('lyricsBlur', 100) / 100).toFixed(3) + 'px');
  v.setProperty('--lyr-fade', (0.14 * n('lyricsDistFade', 0) / 100).toFixed(3));
  v.setProperty('--lyr-gap', n('lyricsSpacing', 100) / 100);
  v.setProperty('--lyr-soft', (22 * n('lyricsFillSoft', 100) / 100).toFixed(1) + '%');
  v.setProperty('--lyr-bg-size', n('lyricsBgSize', 62) / 100);
  v.setProperty('--lyr-bg-bright', n('lyricsBgBright', 80) / 100);
  for (const L of lines) for (const W of L.words) { W.tk = W.gk = W.pk = ''; }
  relayout(true);
}

/** Measures the lines (after mounting, a resize or a size change) and puts them in place. */
export function relayout(snap = false) {
  if (!lines.length || !track?.isConnected) return;
  H = box.clientHeight;
  fontPx = parseFloat(getComputedStyle(lines[0].el).fontSize) || 30;
  for (const L of lines) { L.top = L.el.offsetTop; L.h = L.el.offsetHeight; }
  userOff = clampOff(userOff);
  retarget(snap ? 'snap' : 'now');
}

const anchorTop = () => lines[Math.max(0, scrollIdx)]?.top ?? 0;
// While browsing, the first line can come down to the resting place and the last one up to it.
function clampOff(off) {
  if (!lines.length) return 0;
  const base = anchorTop();
  return clamp(off, lines[0].top - base, lines[lines.length - 1].top - base);
}

function retarget(mode) {
  const T = -(anchorTop() - H * ANCHOR) - userOff;
  const now = performance.now() / 1000;
  const step = STEP * cfg.cascade;
  const from = Math.max(0, scrollIdx);
  // Moving up (the song goes on), the lines below trail behind; moving down (going back), the ones
  // above do. Either way the gaps open up instead of the lines running into each other.
  const down = lines[from] && T > lines[from].y;
  lines.forEach((L, i) => {
    if (mode === 'snap') { L.tgt = L.y = T; L.v = 0; L.pend = null; L.wy = null; return; }
    const n = mode === 'cascade' ? clamp(down ? from - i : i - from, 0, 12) : 0;
    if (n && step > 0) { L.pend = T; L.pendAt = now + n * step; }
    else { L.tgt = T; L.pend = null; }
  });
}

/** One frame at lyrics time `t` (seconds, already offset and latency-corrected). */
export function frame(t) {
  if (!lines.length || !track?.isConnected) return;
  const now = performance.now();
  const dt = clamp((now - (lastFrame || now)) / 1000, 0, 0.05);
  lastFrame = now;
  if (browseUntil && now > browseUntil) {
    browseUntil = 0; userOff = 0; box.classList.remove('browsing');
    retarget('cascade');
  }

  // Which lines are being sung: the latest one started, plus any earlier one still going (duets,
  // background vocals that overlap the next line).
  let anchor = -1;
  for (let i = 0; i < lines.length; i++) { if (lines[i].start <= t + LEAD) anchor = i; else break; }
  const act = [];
  for (let i = Math.max(0, anchor - 3); i <= anchor; i++) if (i === anchor || t < lines[i].end) act.push(i);
  const sig = act.join(',');
  if (sig !== activeSig) {
    activeSig = sig;
    const was = active; active = act;
    const first = act.length ? act[0] : -1;
    lines.forEach((L, i) => {
      const on = act.includes(i);
      let d = 0;
      if (!on) { d = 6; for (const a of act) d = Math.min(d, Math.abs(i - a)); if (!act.length) d = Math.min(6, i + 1); }
      if (L.on !== on) { L.on = on; L.el.classList.toggle('on', on); if (!on && was.includes(i)) rest(L); }
      if (L.d !== d) { L.d = d; L.el.style.setProperty('--d', d); }
      L.el.classList.toggle('past', !on && i < first);
    });
  }
  const idx = act.length ? act[0] : anchor;
  if (idx !== scrollIdx) {
    // (Just after building, the clock may still be on the previous song: no glide yet.)
    const before = anchorTop(), firstTime = scrollIdx === -2 || now - mountedAt < 600;
    scrollIdx = idx;
    if (browseUntil) userOff += before - anchorTop(); // keep still what the user is looking at
    else retarget(firstTime ? 'snap' : 'cascade');
  }

  // Springs (slightly under-damped, sub-stepped so a long frame doesn't make them jump).
  const w = 11 / cfg.smooth, z = 0.9;
  const sec = now / 1000;
  for (const L of lines) {
    if (L.pend != null && sec >= L.pendAt) { L.tgt = L.pend; L.pend = null; }
    if (L.y !== L.tgt || L.v) {
      let n = Math.max(1, Math.ceil(dt / 0.008));
      const step = dt / n;
      while (n--) { const a = w * w * (L.tgt - L.y) - 2 * z * w * L.v; L.v += a * step; L.y += L.v * step; }
      if (Math.abs(L.tgt - L.y) < 0.05 && Math.abs(L.v) < 0.5) { L.y = L.tgt; L.v = 0; }
    }
    // (Lines far off screen are only moved once they come near.)
    const near = L.top + L.y < H + 400 && L.top + L.h + L.y > -400;
    if (L.wy !== L.y && (near || L.wy === null)) { L.el.style.transform = `translate3d(0,${L.y.toFixed(2)}px,0)`; L.wy = L.y; }
  }
  // The credit goes along with the last line.
  if (footerEl) { const y = lines[lines.length - 1].y; if (footerEl._y !== y) { footerEl._y = y; footerEl.style.transform = `translate3d(0,${y.toFixed(2)}px,0)`; } }

  for (const i of act) sing(lines[i], t);
}

/** Share of a word's letters lit at `t`, following its syllables' own timings. */
function lit(W, t) {
  if (t <= W.start) return 0;
  if (t >= W.end) return 1;
  let done = 0;
  for (const p of W.parts) {
    if (t >= p.end) { done += p.len; continue; }
    if (t > p.start) done += p.len * (t - p.start) / Math.max(0.02, p.end - p.start);
    break;
  }
  return clamp(done / W.len, 0, 1);
}

function sing(L, t) {
  if (L.dots) return breathe(L, t);
  const lift = 0.06 * cfg.lift, wave = cfg.wave, G = cfg.perf ? 0 : cfg.glow;
  for (const W of L.words) {
    const f = lit(W, t);
    if (W.letters) {
      // The light runs through the letters one by one; each rises and swells as it's reached.
      const n = W.letters.length, x = f * n;
      const fade = t <= W.end ? 1 : Math.exp(-(t - W.end) / 0.3);
      W.letters.forEach((c, k) => {
        const q = clamp(x - k, 0, 1);
        const b = f > 0 ? wave * fade * Math.exp(-((((x - k) - 0.5) / 1.2) ** 2)) : 0;
        const key = q.toFixed(3) + '|' + b.toFixed(3);
        if (c._k === key) return;
        c._k = key;
        c.style.setProperty('--p', q.toFixed(3));
        c.style.transform = b > 0.003 ? `translateY(${(-0.07 * b).toFixed(4)}em) scale(${(1 + 0.07 * b).toFixed(4)})` : '';
      });
    } else {
      const pk = f.toFixed(3);
      if (W.pk !== pk) { W.pk = pk; W.el.style.setProperty('--p', pk); }
    }
    // Sung words float up a little (and stay up while the line lasts).
    const e = 1 - (1 - f) ** 3;
    const tk = e > 0.001 ? `translateY(${(-lift * e).toFixed(4)}em)` : '';
    if (W.tk !== tk) { W.tk = tk; W.el.style.transform = tk; }
    // Glow: brief on quick words, full on held ones; it fades out once the word is over.
    let g = 0;
    if (G > 0 && f > 0) {
      const dur = W.end - W.start;
      const emph = W.held ? 1 : clamp((dur - 0.15) / 0.8, 0.25, 0.75);
      const env = t < W.end ? Math.min(1, f / 0.25) : Math.exp(-(t - W.end) / 0.4);
      g = G * emph * env;
    }
    const gk = g < 0.01 ? '' : `drop-shadow(0 0 ${(fontPx * (0.16 + 0.1 * Math.min(g, 2)) * cfg.spread).toFixed(1)}px rgba(255,255,255,${Math.min(0.95, 0.5 * g).toFixed(3)}))`;
    if (W.gk !== gk) { W.gk = gk; W.el.style.filter = gk; }
  }
}

/** A line that's no longer sung: its words settle back (CSS transitions take them down). */
function rest(L) {
  for (const W of L.words) {
    W.el.style.transform = ''; W.el.style.filter = ''; W.el.style.removeProperty('--p');
    W.tk = W.gk = W.pk = '';
    W.letters?.forEach((c) => { c.style.transform = ''; c.style.removeProperty('--p'); c._k = ''; });
  }
  if (L.dots) { L.dots.style.transform = ''; L.dots.style.opacity = ''; [...L.dots.children].forEach((d) => (d.style.opacity = '')); }
}

/** Interlude: the three dots fill one after another over the pause and shrink away as the voice returns. */
function breathe(L, t) {
  const span = Math.max(0.5, L.end - L.start);
  const g = clamp((t - L.start) / span, 0, 1);
  const out = clamp((L.end - t) / 0.45, 0, 1);
  const s = (1 + 0.08 * Math.sin(t * Math.PI / 1.1)) * (0.35 + 0.65 * out);
  L.dots.style.transform = `scale(${s.toFixed(3)})`;
  L.dots.style.opacity = out.toFixed(3);
  [...L.dots.children].forEach((d, k) => (d.style.opacity = (0.3 + 0.7 * clamp(g * 3 - k, 0, 1)).toFixed(3)));
}
