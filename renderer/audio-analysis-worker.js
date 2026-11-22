// Heavy analysis of a decoded local file, off the main thread (audio-info.js sends the samples).
//   'analyze': spectrogram per channel (stereo mix, channel 1, channel 2), levels, LUFS, true peak,
//              clipping and spectral cut-off.
//   'verify':  hi-res authenticity: real bit depth, frequency range, traces of lossy coding and
//              integrity (for FLAC, the MD5 of the audio that the file itself stores).
// The samples stay here between the two, so verifying doesn't send them again.

let chans = null, rate = 0;

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.cmd === 'analyze') { chans = m.channels; rate = m.sampleRate; post({ type: 'analysis', result: analyze() }); }
    else if (m.cmd === 'verify') post({ type: 'verify', result: verify(m) });
  } catch (err) { post({ type: 'error', message: String(err?.message || err) }); }
};
const post = (x, transfer) => self.postMessage(x, transfer || []);
const progress = (stage, p) => post({ type: 'progress', stage, p });
const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

// ---------------------------------------------------------------- FFT (radix 2, in place)
function fftSetup(n) {
  const rev = new Uint32Array(n), bits = Math.log2(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(-2 * Math.PI * i / n); sin[i] = Math.sin(-2 * Math.PI * i / n); }
  return { n, rev, cos, sin, re: new Float64Array(n), im: new Float64Array(n) };
}
function fft(f) {
  const { n, rev, cos, sin, re, im } = f;
  for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let s = 0; s < n; s += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step], wi = sin[k * step], a = s + k, b = a + half;
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
}

// ---------------------------------------------------------------- analysis
function analyze() {
  const N = 2048, bins = N / 2, cols = 900;
  const len = chans[0].length, nch = chans.length;
  const hann = new Float64Array(N);
  for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
  const norm = N / 4; // a full-scale sine through the Hann window: |X| = N/4 → 0 dBFS
  const f = fftSetup(N);
  // Views: the stereo mix and each channel (a mono file has only one).
  const views = nch > 1 ? [null, 0, 1] : [0];
  const images = views.map(() => new Uint8Array(cols * bins)); // dB −120…0 → 0…255, column-major
  const avg = new Float64Array(bins);
  for (let c = 0; c < cols; c++) {
    const start = Math.max(0, Math.floor(c * (len - N) / (cols - 1)));
    views.forEach((v, vi) => {
      for (let i = 0; i < N; i++) {
        const k = start + i;
        const s = k < len ? (v === null ? (chans[0][k] + chans[1][k]) / 2 : chans[v][k]) : 0;
        f.re[i] = s * hann[i]; f.im[i] = 0;
      }
      fft(f);
      const img = images[vi], base = c * bins;
      for (let b = 0; b < bins; b++) {
        const p = (f.re[b] * f.re[b] + f.im[b] * f.im[b]) / (norm * norm);
        if (vi === 0) avg[b] += p;
        const d = p > 0 ? 10 * Math.log10(p) : -200;
        img[base + b] = Math.max(0, Math.min(255, Math.round((d + 120) / 120 * 255)));
      }
    });
    if (c % 30 === 0) progress('spectrum', c / cols * 0.45);
  }
  const avgDb = Array.from(avg, (p) => (p > 0 ? 10 * Math.log10(p / cols) : -200));

  // Levels per channel.
  const per = [];
  for (let ch = 0; ch < nch; ch++) {
    const x = chans[ch];
    let peak = 0, sum = 0, clips = 0;
    for (let i = 0; i < len; i++) { const a = Math.abs(x[i]); if (a > peak) peak = a; sum += x[i] * x[i]; if (a >= 0.99997) clips++; }
    const rms = Math.sqrt(sum / len);
    per.push({ peak: db(peak), rms: db(rms), dr: db(peak) - db(rms), clips });
    progress('levels', 0.45 + (ch + 1) / nch * 0.1);
  }
  const truePeak = Math.max(...chans.map((x, i) => { const t = truePeakOf(x); progress('truepeak', 0.55 + (i + 1) / nch * 0.25); return t; }));
  const lufs = integratedLoudness();
  progress('loudness', 1);
  const peak = Math.max(...per.map((p) => p.peak));
  let sumAll = 0; for (const x of chans) for (let i = 0; i < len; i++) sumAll += x[i] * x[i];
  const rms = db(Math.sqrt(sumAll / (len * nch)));
  return {
    sampleRate: rate, channels: nch, samples: len, duration: len / rate,
    peak, rms, dr: peak - rms, lufs, truePeak: db(truePeak), clips: per.reduce((a, p) => a + p.clips, 0),
    cutoff: cutoffOf(avgDb, rate / N), perChannel: per,
    spectrogram: { cols, bins, views: views.map((v) => (v === null ? 'mix' : v)), images },
  };
}

/** True peak: the signal rebuilt 4× finer (windowed-sinc interpolation, 32 taps per phase). */
function truePeakOf(x) {
  const P = 4, T = 32, h = [];
  for (let ph = 1; ph < P; ph++) {
    const taps = new Float64Array(T);
    for (let k = 0; k < T; k++) {
      const t = k - T / 2 + 1 - ph / P; // distance to the sample
      const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      const w = 0.42 + 0.5 * Math.cos(Math.PI * t / (T / 2)) + 0.08 * Math.cos(2 * Math.PI * t / (T / 2)); // Blackman
      taps[k] = sinc * w;
    }
    h.push(taps);
  }
  let peak = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > peak) peak = a; }
  const near = peak * 0.5; // between-sample peaks only happen next to large samples
  for (let i = T / 2; i < x.length - T / 2; i++) {
    if (Math.abs(x[i]) < near && Math.abs(x[i + 1]) < near) continue;
    for (const taps of h) {
      let s = 0;
      for (let k = 0; k < T; k++) s += x[i - T / 2 + 1 + k] * taps[k];
      const a = Math.abs(s);
      if (a > peak) peak = a;
    }
  }
  return peak;
}

/** Integrated loudness (ITU-R BS.1770-4 / EBU R128): K-weighting, 400 ms blocks, −70 LUFS and −10 LU gates. */
function integratedLoudness() {
  const fs = rate;
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan(Math.PI * f0 / fs);
  const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const pb = [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0];
  const pa = [2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
  f0 = 38.13547087602444; Q = 0.5003270373238773; K = Math.tan(Math.PI * f0 / fs);
  a0 = 1 + K / Q + K * K;
  const ra = [2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
  const block = Math.round(0.4 * fs), hop = Math.round(0.1 * fs), len = chans[0].length;
  const nBlocks = Math.max(0, Math.floor((len - block) / hop) + 1);
  const energy = new Float64Array(nBlocks);
  for (const x of chans) {
    // K-weighted squares, summed per 100 ms step; a block is 4 consecutive steps.
    const steps = new Float64Array(Math.ceil(len / hop));
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, z1 = 0, z2 = 0;
    for (let i = 0; i < len; i++) {
      const xi = x[i];
      const y = pb[0] * xi + pb[1] * x1 + pb[2] * x2 - pa[0] * y1 - pa[1] * y2;
      x2 = x1; x1 = xi;
      const z = y - 2 * y1 + y2 - ra[0] * z1 - ra[1] * z2;
      y2 = y1; y1 = y; z2 = z1; z1 = z;
      steps[(i / hop) | 0] += z * z;
    }
    for (let b = 0; b < nBlocks; b++) energy[b] += (steps[b] + steps[b + 1] + steps[b + 2] + steps[b + 3]) / block;
  }
  const L = (e) => -0.691 + 10 * Math.log10(e);
  const abs = [...energy].filter((e) => L(e) > -70);
  if (!abs.length) return -Infinity;
  const rel = L(abs.reduce((a, e) => a + e, 0) / abs.length) - 10;
  const gated = abs.filter((e) => L(e) > rel);
  return L(gated.reduce((a, e) => a + e, 0) / gated.length);
}

/** Where the spectrum ends: the highest frequency well above the noise floor, and how sharply it drops. */
function cutoffOf(avgDb, hz) {
  const n = avgDb.length;
  const sm = avgDb.map((_, i) => { let s = 0, c = 0; for (let k = Math.max(0, i - 3); k <= Math.min(n - 1, i + 3); k++) { s += avgDb[k]; c++; } return s / c; });
  const median = (a, b) => { const v = sm.slice(a, b).sort((x, y) => x - y); return v[v.length >> 1]; };
  // Just under Nyquist vs. the midrange (1–8 kHz): if there's real sound up there, the spectrum runs
  // to the end. If not, that top band is the floor, and the edge is where the sound sinks into it.
  const top = median(Math.floor(n * 0.97), n);
  const mid = median(Math.floor(1000 / hz), Math.ceil(8000 / hz));
  let cut = n - 1;
  if (mid - top > 50) {
    for (let i = n - 1; i >= 0; i--) if (sm[i] > top + 20) { cut = i; break; }
  }
  const band = Math.max(1, Math.round(500 / hz));
  const below = sm[Math.max(0, cut - band)], above = sm[Math.min(n - 1, cut + band)];
  return { hz: (cut + 1) * hz, drop: below - above, nyquist: n * hz };
}

// ---------------------------------------------------------------- authenticity
function verify(m) {
  if (!chans) throw new Error('no samples');
  const checks = [];
  const declared = m.bitDepth || null, nch = chans.length, len = chans[0].length;
  progress('bits', 0);
  // Real bit depth: the finest step actually used. A 24-bit file whose values are all multiples of
  // 256 is really 16-bit. Decoded samples are floats; ×2^(bits−1) gives the original integers back.
  let realBits = null, floatData = false;
  if (declared && declared <= 24) {
    const scale = Math.pow(2, declared - 1);
    let acc = 0;
    for (const x of chans) {
      for (let i = 0; i < len; i++) {
        const v = x[i] * scale, r = Math.round(v);
        if (r !== v) { floatData = true; break; }
        acc |= r;
      }
      if (floatData) break;
    }
    if (!floatData) {
      let tz = 0;
      if (acc === 0) tz = declared; else while (((acc >> tz) & 1) === 0 && tz < declared) tz++;
      realBits = declared - tz;
    }
  }
  progress('bits', 0.4);
  if (declared && realBits != null) {
    const ok = realBits >= declared;
    checks.push({ key: 'bits', ok, declared, real: realBits });
  } else if (declared && floatData) checks.push({ key: 'bits', ok: null, declared, float: true });

  // Frequency range and traces of lossy coding, from the spectrum worked out in 'analyze'.
  const cut = m.cutoff;
  if (cut) {
    const nyq = rate / 2;
    const lossy = cut.hz < nyq * 0.93 && cut.drop > 25 && cut.hz >= 11000 && cut.hz <= 21000;
    checks.push({ key: 'lossy', ok: !lossy, hz: cut.hz, drop: cut.drop });
    const upsampled = rate > 48000 && cut.hz <= 24500;
    checks.push({ key: 'range', ok: !upsampled, hz: cut.hz, nyquist: nyq, upsampled });
  }
  progress('md5', 0.5);

  // Integrity: the whole file decoded; for FLAC, the MD5 of the decoded audio against the one stored
  // in the file (STREAMINFO), computed over the samples as integers, little-endian, interleaved.
  const integrity = { key: 'integrity', decoded: true, samples: len, expected: m.numberOfSamples || null };
  if (m.flacMd5 && declared && !floatData && /^[0-9a-f]{32}$/.test(m.flacMd5) && !/^0+$/.test(m.flacMd5)) {
    const md5 = md5Samples(chans, declared, len, (p) => progress('md5', 0.5 + p * 0.5));
    integrity.md5 = { stored: m.flacMd5, computed: md5, ok: md5 === m.flacMd5 };
    integrity.ok = integrity.md5.ok;
  } else integrity.ok = !integrity.expected || Math.abs(integrity.expected - len) <= rate * 0.05;
  checks.push(integrity);
  progress('md5', 1);
  return { checks, realBits, declared };
}

// ---------------------------------------------------------------- MD5 (RFC 1321), fed in chunks
function md5Samples(chs, bits, len, onProgress) {
  const bytes = bits / 8, scale = Math.pow(2, bits - 1), n = chs.length;
  const st = md5Init();
  const CH = 1 << 16, buf = new Uint8Array(CH * bytes * n);
  for (let i0 = 0; i0 < len; i0 += CH) {
    const end = Math.min(len, i0 + CH);
    let o = 0;
    for (let i = i0; i < end; i++) {
      for (let c = 0; c < n; c++) {
        let v = Math.round(chs[c][i] * scale);
        for (let b = 0; b < bytes; b++) { buf[o++] = v & 255; v >>= 8; }
      }
    }
    md5Update(st, buf.subarray(0, o));
    if ((i0 / CH) % 16 === 0) onProgress(i0 / len);
  }
  return md5Final(st);
}
const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const KK = Array.from({ length: 64 }, (_, i) => (Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
function md5Init() { return { h: [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476], buf: new Uint8Array(64), n: 0, total: 0 }; }
function md5Block(h, b, o) {
  const M = new Array(16);
  for (let i = 0; i < 16; i++) M[i] = b[o + i * 4] | (b[o + i * 4 + 1] << 8) | (b[o + i * 4 + 2] << 16) | (b[o + i * 4 + 3] << 24);
  let [a, bb, c, d] = h;
  for (let i = 0; i < 64; i++) {
    let f, g;
    if (i < 16) { f = (bb & c) | (~bb & d); g = i; }
    else if (i < 32) { f = (d & bb) | (~d & c); g = (5 * i + 1) % 16; }
    else if (i < 48) { f = bb ^ c ^ d; g = (3 * i + 5) % 16; }
    else { f = c ^ (bb | ~d); g = (7 * i) % 16; }
    const t = d; d = c; c = bb;
    const x = (a + f + KK[i] + M[g]) | 0;
    bb = (bb + ((x << S[i]) | (x >>> (32 - S[i])))) | 0;
    a = t;
  }
  h[0] = (h[0] + a) | 0; h[1] = (h[1] + bb) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
}
function md5Update(st, data) {
  let i = 0;
  st.total += data.length;
  if (st.n) { while (st.n < 64 && i < data.length) st.buf[st.n++] = data[i++]; if (st.n === 64) { md5Block(st.h, st.buf, 0); st.n = 0; } }
  for (; i + 64 <= data.length; i += 64) md5Block(st.h, data, i);
  while (i < data.length) st.buf[st.n++] = data[i++];
}
function md5Final(st) {
  const bitLen = st.total * 8;
  const pad = new Uint8Array(((st.n < 56 ? 56 : 120) - st.n) + 8);
  pad[0] = 0x80;
  const lo = bitLen >>> 0, hi = Math.floor(bitLen / 2 ** 32);
  for (let k = 0; k < 4; k++) { pad[pad.length - 8 + k] = (lo >>> (8 * k)) & 255; pad[pad.length - 4 + k] = (hi >>> (8 * k)) & 255; }
  st.total -= pad.length; // (padding doesn't count)
  md5Update(st, pad);
  return st.h.map((w) => [0, 1, 2, 3].map((k) => ((w >>> (8 * k)) & 255).toString(16).padStart(2, '0')).join('')).join('');
}
