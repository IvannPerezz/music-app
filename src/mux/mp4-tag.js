// Writes iTunes-style metadata (title, artist, album, cover…) into an .m4a (MP4) buffer.
// Works for both regular and fragmented (DASH) MP4, fixing chunk offsets that move.

function boxes(buf, start, end) {
  const out = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    let header = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(pos + 8)); header = 16; }
    else if (size === 0) size = end - pos;
    if (size < header || pos + size > end) break;
    out.push({ type, start: pos, end: pos + size, header });
    pos += size;
  }
  return out;
}

const box = (type, ...payload) => {
  const body = Buffer.concat(payload.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  const h = Buffer.alloc(8);
  h.writeUInt32BE(body.length + 8); h.write(type, 4, 'latin1');
  return Buffer.concat([h, body]);
};
const fullBox = (type, version, flags, ...payload) => {
  const vf = Buffer.alloc(4); vf.writeUInt32BE(((version & 0xff) << 24) | (flags & 0xffffff));
  return box(type, vf, ...payload);
};
const dataAtom = (typeCode, value) => {
  const h = Buffer.alloc(8); h.writeUInt32BE(typeCode); h.writeUInt32BE(0, 4);
  return box('data', h, value);
};
const textItem = (name, text) => box(name, dataAtom(1, Buffer.from(String(text), 'utf8')));

function buildIlst(tags, cover) {
  const items = [];
  const map = { title: '©nam', artist: '©ART', album: '©alb', albumArtist: 'aART', date: '©day', genre: '©gen', comment: '©cmt', lyrics: '©lyr', encoder: '©too' };
  for (const [k, atom] of Object.entries(map)) if (tags[k]) items.push(textItem(Buffer.from(atom, 'latin1').toString('latin1'), tags[k]));
  if (tags.track) {
    const b = Buffer.alloc(8); b.writeUInt16BE(tags.track, 2); b.writeUInt16BE(tags.trackTotal || 0, 4);
    items.push(box('trkn', dataAtom(0, b)));
  }
  if (cover?.data) items.push(box('covr', dataAtom(cover.mime === 'image/png' ? 14 : 13, cover.data)));
  return box('ilst', ...items);
}

function buildMeta(tags, cover) {
  const hdlr = fullBox('hdlr', 0, 0, Buffer.alloc(4), Buffer.from('mdir'), Buffer.from('appl'), Buffer.alloc(8), Buffer.from([0]));
  return fullBox('meta', 0, 0, hdlr, buildIlst(tags, cover));
}

/** Adds `delta` to every absolute file offset inside moov (stco/co64) that points past `from`. */
function shiftOffsets(buf, start, end, delta, from) {
  for (const b of boxes(buf, start, end)) {
    const inner = b.start + b.header;
    if (['trak', 'mdia', 'minf', 'stbl', 'moov', 'mvex', 'edts'].includes(b.type)) shiftOffsets(buf, inner, b.end, delta, from);
    else if (b.type === 'stco') {
      const n = buf.readUInt32BE(inner + 4);
      for (let i = 0; i < n; i++) { const p = inner + 8 + i * 4; const v = buf.readUInt32BE(p); if (v >= from) buf.writeUInt32BE(v + delta, p); }
    } else if (b.type === 'co64') {
      const n = buf.readUInt32BE(inner + 4);
      for (let i = 0; i < n; i++) { const p = inner + 8 + i * 8; const v = buf.readBigUInt64BE(p); if (v >= BigInt(from)) buf.writeBigUInt64BE(v + BigInt(delta), p); }
    }
  }
}

/** Fragmented files: tfhd base_data_offset (when present) and sidx/mfra are absolute-ish; fix tfhd. */
function shiftFragments(buf, delta, from) {
  for (const top of boxes(buf, 0, buf.length)) {
    if (top.type !== 'moof') continue;
    for (const traf of boxes(buf, top.start + top.header, top.end)) {
      if (traf.type !== 'traf') continue;
      for (const b of boxes(buf, traf.start + traf.header, traf.end)) {
        if (b.type !== 'tfhd') continue;
        const flags = buf.readUInt32BE(b.start + b.header) & 0xffffff;
        if (flags & 1) {
          const p = b.start + b.header + 8;
          const v = buf.readBigUInt64BE(p);
          if (v >= BigInt(from)) buf.writeBigUInt64BE(v + BigInt(delta), p);
        }
      }
    }
  }
}

export function tagMp4(input, tags = {}, cover = null) {
  const buf = Buffer.from(input);
  const top = boxes(buf, 0, buf.length);
  const moov = top.find((b) => b.type === 'moov');
  if (!moov) throw new Error('MP4 sin moov');
  // Rebuild moov without any existing udta, then append ours.
  const children = boxes(buf, moov.start + moov.header, moov.end).filter((b) => b.type !== 'udta');
  const udta = box('udta', buildMeta(tags, cover));
  const newMoovBody = Buffer.concat([...children.map((c) => buf.subarray(c.start, c.end)), udta]);
  const newMoov = box('moov', newMoovBody);
  const delta = newMoov.length - (moov.end - moov.start);
  const out = Buffer.concat([buf.subarray(0, moov.start), newMoov, buf.subarray(moov.end)]);
  if (delta !== 0) {
    // Everything after the old moov moved by delta.
    const nm = boxes(out, 0, out.length).find((b) => b.type === 'moov');
    shiftOffsets(out, nm.start + nm.header, nm.end, delta, moov.end);
    shiftFragments(out, delta, moov.end);
  }
  return out;
}
