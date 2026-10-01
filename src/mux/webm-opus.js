// Remux YouTube's Opus-in-WebM into a tagged .opus (Ogg) file, with cover art — no ffmpeg needed.

// ------------------------------------------------------------------ EBML reading
const IDS = {
  EBML: 0x1a45dfa3, Segment: 0x18538067, Tracks: 0x1654ae6b, TrackEntry: 0xae, CodecID: 0x86, CodecPrivate: 0x63a2,
  CodecDelay: 0x56aa, SeekPreRoll: 0x56bb, Cluster: 0x1f43b675, Timecode: 0xe7, SimpleBlock: 0xa3, BlockGroup: 0xa0,
  Block: 0xa1, Info: 0x1549a966, TimecodeScale: 0x2ad7b1, Duration: 0x4489, Cues: 0x1c53bb6b,
};
const MASTER = new Set([IDS.Segment, IDS.Tracks, IDS.TrackEntry, IDS.Cluster, IDS.BlockGroup, IDS.Info]);

function readVint(buf, pos, keepMarker) {
  const first = buf[pos];
  if (first === undefined) throw new Error('EOF');
  let len = 1, mask = 0x80;
  while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
  if (len > 8) throw new Error('bad vint');
  let value = keepMarker ? first : first & (mask - 1);
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < len; i++) { value = value * 256 + buf[pos + i]; if (buf[pos + i] !== 0xff) allOnes = false; }
  return { value, len, unknown: !keepMarker && allOnes };
}

function* elements(buf, start, end) {
  let pos = start;
  while (pos < end) {
    const id = readVint(buf, pos, true); pos += id.len;
    const size = readVint(buf, pos, false); pos += size.len;
    const dataEnd = size.unknown ? end : Math.min(end, pos + size.value);
    yield { id: id.value, start: pos, end: dataEnd, unknown: size.unknown };
    pos = dataEnd;
  }
}

const readUint = (buf, s, e) => { let v = 0; for (let i = s; i < e; i++) v = v * 256 + buf[i]; return v; };

/** Extracts OpusHead + raw Opus packets from a WebM buffer. */
export function demuxWebmOpus(buf) {
  let opusHead = null, codecDelay = 0;
  const packets = [];
  const walk = (start, end) => {
    for (const el of elements(buf, start, end)) {
      if (el.id === IDS.TrackEntry) {
        let codec = '', priv = null;
        for (const c of elements(buf, el.start, el.end)) {
          if (c.id === IDS.CodecID) codec = buf.toString('latin1', c.start, c.end);
          else if (c.id === IDS.CodecPrivate) priv = buf.subarray(c.start, c.end);
          else if (c.id === IDS.CodecDelay) codecDelay = readUint(buf, c.start, c.end);
        }
        if (codec === 'A_OPUS' && priv) opusHead = Buffer.from(priv);
      } else if (el.id === IDS.SimpleBlock || el.id === IDS.Block) {
        readBlock(buf, el.start, el.end, packets);
      } else if (MASTER.has(el.id)) {
        walk(el.start, el.end);
      }
      // everything else (Cues, SeekHead, Tags…) is skipped
    }
  };
  walk(0, buf.length);
  if (!opusHead) throw new Error('No hay pista Opus en el WebM');
  return { opusHead, packets, codecDelay };
}

function readBlock(buf, start, end, out) {
  let pos = start;
  const track = readVint(buf, pos, false); pos += track.len;
  pos += 2; // timecode (relative) — Ogg granules are computed from packet durations instead
  const flags = buf[pos++];
  const lacing = (flags >> 1) & 3;
  if (lacing === 0) { out.push(buf.subarray(pos, end)); return; }
  const count = buf[pos++] + 1;
  const sizes = [];
  if (lacing === 1) { // Xiph
    for (let i = 0; i < count - 1; i++) { let s = 0, b; do { b = buf[pos++]; s += b; } while (b === 255); sizes.push(s); }
  } else if (lacing === 3) { // EBML
    let v = readVint(buf, pos, false); pos += v.len; sizes.push(v.value);
    for (let i = 1; i < count - 1; i++) {
      v = readVint(buf, pos, false); pos += v.len;
      const bias = Math.pow(2, 7 * v.len - 1) - 1;
      sizes.push(sizes[i - 1] + (v.value - bias));
    }
  } else { // fixed
    const each = (end - pos) / count;
    for (let i = 0; i < count - 1; i++) sizes.push(each);
  }
  const used = sizes.reduce((a, b) => a + b, 0);
  sizes.push(end - pos - used);
  for (const s of sizes) { out.push(buf.subarray(pos, pos + s)); pos += s; }
}

// ------------------------------------------------------------------ Opus packet duration (RFC 6716 §3.1)
export function opusSamples(packet) {
  if (!packet.length) return 0;
  const toc = packet[0];
  const config = toc >> 3;
  let frameSize; // in 48 kHz samples
  if (config < 12) frameSize = [480, 960, 1920, 2880][config & 3];
  else if (config < 16) frameSize = [480, 960][config & 1];
  else frameSize = [120, 240, 480, 960][config & 3];
  const c = toc & 3;
  let frames = c === 0 ? 1 : c === 3 ? (packet[1] & 0x3f) : 2;
  return frameSize * frames;
}

// ------------------------------------------------------------------ Ogg writing
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let r = i << 24; for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1; t[i] = r >>> 0; }
  return t;
})();
function crc(buf) { let c = 0; for (let i = 0; i < buf.length; i++) c = ((c << 8) ^ CRC_TABLE[((c >>> 24) ^ buf[i]) & 0xff]) >>> 0; return c >>> 0; }

class OggWriter {
  constructor(serial) { this.serial = serial; this.seq = 0; this.chunks = []; }
  page(segments, payload, granule, flags) {
    const h = Buffer.alloc(27 + segments.length);
    h.write('OggS', 0, 'latin1'); h[4] = 0; h[5] = flags;
    h.writeBigInt64LE(BigInt(granule), 6);
    h.writeUInt32LE(this.serial, 14); h.writeUInt32LE(this.seq++, 18); h.writeUInt32LE(0, 22);
    h[26] = segments.length; segments.forEach((s, i) => (h[27 + i] = s));
    const page = Buffer.concat([h, payload]);
    page.writeUInt32LE(crc(page), 22);
    this.chunks.push(page);
  }
  /** Writes packets; a packet may span pages (continuation flag), pages close at ~4 KB. */
  packets(list, granules, { bos = false, eos = false } = {}) {
    let segs = [], parts = [], size = 0, lastGranule = -1, contThis = false, contNext = false, first = true, lastGranuleSeen = 0;
    const emit = (isLast) => {
      const flags = (contThis ? 1 : 0) | (bos && first ? 2 : 0) | (eos && isLast ? 4 : 0);
      this.page(segs, Buffer.concat(parts), lastGranule, flags);
      first = false; segs = []; parts = []; size = 0; lastGranule = -1; contThis = contNext;
    };
    list.forEach((pkt, idx) => {
      const lac = [];
      let n = pkt.length;
      while (n >= 255) { lac.push(255); n -= 255; }
      lac.push(n);
      let off = 0;
      for (let i = 0; i < lac.length; i++) {
        segs.push(lac[i]); parts.push(pkt.subarray(off, off + lac[i])); off += lac[i]; size += lac[i];
        const done = i === lac.length - 1;
        if (done) { lastGranule = granules[idx]; lastGranuleSeen = lastGranule; }
        if (segs.length === 255) { contNext = !done; emit(false); }
      }
      if (size > 4000 && idx < list.length - 1 && segs.length) { contNext = false; emit(false); }
    });
    contNext = false;
    if (segs.length) emit(true);
    else if (eos) { lastGranule = lastGranuleSeen; emit(true); }
  }
  get buffer() { return Buffer.concat(this.chunks); }
}

/** Vorbis comment block (used by OpusTags). tags: {TITLE, ARTIST, ...}; picture: {mime, data}. */
export function opusTags(tags, picture) {
  const vendor = Buffer.from('BitChord Desktop');
  const comments = [];
  for (const [k, v] of Object.entries(tags)) {
    if (v == null || v === '') continue;
    for (const val of Array.isArray(v) ? v : [v]) comments.push(Buffer.from(`${k}=${val}`, 'utf8'));
  }
  if (picture) comments.push(Buffer.concat([Buffer.from('METADATA_BLOCK_PICTURE='), Buffer.from(flacPicture(picture).toString('base64'))]));
  const parts = [Buffer.from('OpusTags'), u32(vendor.length), vendor, u32(comments.length)];
  for (const c of comments) parts.push(u32(c.length), c);
  return Buffer.concat(parts);
}
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u32be = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

export function flacPicture({ mime = 'image/jpeg', data, width = 0, height = 0 }) {
  const m = Buffer.from(mime), d = Buffer.from('Cover');
  return Buffer.concat([u32be(3), u32be(m.length), m, u32be(d.length), d, u32be(width), u32be(height), u32be(24), u32be(0), u32be(data.length), data]);
}

/** WebM (Opus) buffer → Ogg Opus buffer with tags. */
export function webmToOggOpus(webm, tags = {}, picture = null) {
  const { opusHead, packets } = demuxWebmOpus(webm);
  const serial = (Math.random() * 0xffffffff) >>> 0;
  const w = new OggWriter(serial);
  w.packets([opusHead], [0], { bos: true });
  w.packets([opusTags(tags, picture)], [0]);
  let g = 0;
  const granules = packets.map((p) => (g += opusSamples(p)));
  w.packets(packets, granules, { eos: true });
  return w.buffer;
}
