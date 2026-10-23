// Lyrics parsers (port of BitChord's LrcLib/EnhancedLrc/TtmlLyrics/KaraokeLrc/ProviderLyrics/LyricsPlus).
// Output: [{ time, text, words?: [{start, end, text, parts?: [{start, end, len}]}], end?, bg?: line, align: 'start'|'end' }] — seconds.
// (parts: the syllables of a word, len = their number of letters.)

const MIN_GAP = 5; // seconds of silence that earn a ♪ marker

const decode = (t) => (t && t.includes('&') ? t
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : t);

const lineEnd = (l) => Math.max(l.words?.length ? l.words[l.words.length - 1].end : (l.end ?? l.time), l.bg ? lineEnd(l.bg) : 0);
const hasEnd = (l) => (l.words && l.words.length) || l.end != null;

export function withGaps(lines) {
  if (!lines.length) return lines;
  const out = [];
  if (lines[0].time >= MIN_GAP) out.push({ time: 0, text: '', gap: true });
  lines.forEach((l, i) => {
    out.push(l);
    const next = lines[i + 1];
    if (!next || !hasEnd(l)) return;
    const e = lineEnd(l);
    if (next.time - e >= MIN_GAP && e > l.time) out.push({ time: e, text: '', gap: true });
  });
  return out;
}

export function parseLrc(lrc) {
  const lines = [];
  for (const raw of String(lrc).split(/\r?\n/)) {
    const tags = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
    if (!tags.length) continue;
    const text = decode(raw.replace(/\[[^\]]*\]/g, '').replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').trim());
    for (const t of tags) {
      const frac = t[3] ? parseInt(t[3], 10) / Math.pow(10, t[3].length) : 0;
      lines.push({ time: +t[1] * 60 + +t[2] + frac, text });
    }
  }
  lines.sort((a, b) => a.time - b.time);
  // Blank LRC lines are instrumental breaks already.
  return lines.map((l) => (l.text ? l : { ...l, gap: true }));
}

const stamp = (m, s, f) => +m * 60 + +s + (f.length === 3 ? +f / 1000 : +f / 100);

export function parseEnhancedLrc(lrc) {
  const LINE = /^\[(\d{1,3}):(\d{2})[.:](\d{2,3})\](.*)$/;
  const WORD = /<(\d{1,3}):(\d{2})[.:](\d{2,3})>([^<]*)/g;
  const rows = String(lrc).split(/\r?\n/).map((l) => LINE.exec(l.trim())).filter(Boolean)
    .map((m) => ({ time: stamp(m[1], m[2], m[3]), words: [...m[4].matchAll(WORD)], plain: m[4].trim() }))
    .sort((a, b) => a.time - b.time);
  if (!rows.some((r) => r.words.length)) return [];
  const out = [];
  rows.forEach((row, i) => {
    if (!row.words.length) { const text = decode(row.plain); if (text) out.push({ time: row.time, text }); return; }
    const lastWordStart = stamp(...row.words[row.words.length - 1].slice(1, 4));
    const end = rows[i + 1]?.time ?? lastWordStart + 0.8;
    const words = row.words.map((m, k) => {
      const text = decode(m[4]).trim();
      if (!text) return null;
      const start = stamp(m[1], m[2], m[3]);
      const nx = row.words[k + 1];
      const wEnd = nx ? stamp(nx[1], nx[2], nx[3]) : end;
      return { start, end: Math.max(start, wEnd), text };
    }).filter(Boolean);
    if (!words.length) return;
    out.push({ time: Math.min(row.time, words[0].start), text: words.map((w) => w.text).join(' '), words });
  });
  return withGaps(out);
}

export function parseKaraokeLrc(raw) {
  const content = (/LyricContent\s*=\s*"([^"]*)"/i.exec(raw)?.[1] ?? raw)
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const LINE = /^\[(\d{1,8}),(\d{1,8})\](.*)$/;
  const PRE = /\((\d{1,8}),(\d{1,8})(?:,\d{1,8})?\)([^()]*)/g;
  const SUF = /([^()]*)\((\d{1,8}),(\d{1,8})(?:,\d{1,8})?\)/g;
  const out = [];
  for (const src of content.split(/\r?\n/)) {
    const m = LINE.exec(src.trim());
    if (!m) continue;
    const ls = +m[1] / 1000, ld = +m[2] / 1000, body = m[3];
    const w = (text, s, d) => { const t = decode(text).trim(); return t ? { start: +s / 1000, end: (+s + +d) / 1000, text: t } : null; };
    const pre = [...body.matchAll(PRE)].map((x) => w(x[3], x[1], x[2])).filter(Boolean);
    const suf = [...body.matchAll(SUF)].map((x) => w(x[1], x[2], x[3])).filter(Boolean);
    const len = (a) => a.reduce((s, x) => s + x.text.length, 0);
    const words = len(pre) >= len(suf) ? pre : suf;
    if (!words.length) continue;
    const text = decode(body.replace(/\(\d{1,8},\d{1,8}(?:,\d{1,8})?\)/g, '')).trim();
    if (!text) continue;
    out.push({ time: Math.min(ls, words[0].start), text, words, end: ld > 0 ? ls + ld : undefined });
  }
  return withGaps(out.sort((a, b) => a.time - b.time));
}
const looksKaraoke = (raw) => /^\[\d{1,8},\d{1,8}\].*\(\d{1,8},\d{1,8}/m.test(raw);

function ttmlTime(v) {
  if (!v) return null;
  v = v.trim();
  if (v.endsWith('ms')) return parseFloat(v) / 1000;
  const p = v.replace(/s$/, '').split(':').map(parseFloat);
  if (p.some(isNaN)) return null;
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : p[0];
}

export function parseTtml(xml) {
  let doc;
  try { doc = new DOMParser().parseFromString(xml, 'application/xml'); } catch { return []; }
  if (doc.getElementsByTagName('parsererror').length) return [];
  const attr = (el, name) => {
    if (el.getAttribute(name)) return el.getAttribute(name);
    const local = name.split(':').pop();
    for (const a of el.attributes) if (a.name === name || a.localName === local) return a.value;
    return '';
  };
  // Agents: person/group/other; duets put the second voice on the right.
  const agentTypes = {};
  for (const a of [...doc.getElementsByTagName('ttm:agent'), ...doc.getElementsByTagName('agent')]) {
    const id = attr(a, 'xml:id'); const type = a.getAttribute('type');
    if (id && type) agentTypes[id] = type;
  }
  const hasTimedChild = (el) => [...el.children].some((c) => c.getAttribute('begin') || hasTimedChild(c));
  const collect = (node, out, bg) => {
    for (const ch of node.childNodes) {
      if (ch.nodeType === 1) {
        const role = attr(ch, 'ttm:role');
        if (role === 'x-translation' || role === 'x-roman') continue;
        const sink = role === 'x-bg' ? bg : out;
        const b = ttmlTime(ch.getAttribute('begin')), e = ttmlTime(ch.getAttribute('end'));
        if (b != null && e != null && !hasTimedChild(ch)) sink.push({ t: ch.textContent || '', b, e });
        else collect(ch, sink, bg);
      } else if (ch.nodeType === 3 && ch.textContent) out.push({ t: ch.textContent });
    }
  };
  const merge = (pieces) => {
    // Syllables are joined into words; each keeps its own timing (parts) so the fill follows it.
    const words = []; let cur = '', s = 0, e = 0, timed = false, parts = [];
    const flush = () => { const t = cur.trim(); cur = ''; if (t && timed) words.push({ start: s, end: e, text: t, parts }); timed = false; parts = []; };
    for (const p of pieces) {
      if (p.b == null) { if (!p.t.trim()) flush(); else if (timed) cur += p.t; continue; }
      if (!p.t.trim()) continue;
      if (/^\s/.test(p.t)) flush();
      if (!cur) s = p.b;
      cur += p.t.trim(); e = p.e; timed = true;
      parts.push({ start: p.b, end: p.e, len: [...p.t.trim()].length });
      if (/\s$/.test(p.t)) flush();
    }
    flush();
    return words;
  };
  const lines = [];
  const agents = [];
  for (const p of doc.getElementsByTagName('p')) {
    const main = [], bgp = [];
    collect(p, main, bgp);
    const words = merge(main), bgw = merge(bgp);
    const agent = attr(p, 'ttm:agent');
    let line;
    if (!words.length) {
      const text = (p.textContent || '').trim();
      const b = ttmlTime(p.getAttribute('begin'));
      if (!text || b == null) continue;
      const e = ttmlTime(p.getAttribute('end'));
      line = { time: b, text, end: e > b ? e : undefined };
    } else {
      const b = ttmlTime(p.getAttribute('begin')) ?? words[0].start;
      line = { time: Math.min(b, words[0].start), text: words.map((w) => w.text).join(' '), words };
    }
    if (bgw.length) line.bg = { time: bgw[0].start, text: bgw.map((w) => w.text).join(' '), words: bgw };
    lines.push(line); agents.push(agent);
  }
  const order = lines.map((l, i) => i).sort((a, b) => lines[a].time - lines[b].time);
  const sorted = order.map((i) => lines[i]);
  const sortedAgents = order.map((i) => agents[i]);
  alignByAgents(sorted, sortedAgents, agentTypes);
  return withGaps(sorted);
}

function alignByAgents(lines, agents, types) {
  const persons = [...new Set(agents.filter((a) => a && types[a] !== 'group' && types[a] !== 'other'))];
  if (persons.length < 2) return;
  const second = persons[1];
  lines.forEach((l, i) => { if (agents[i] === second) l.align = 'end'; });
}

export function parseLyricsPlus(r) {
  const out = [];
  const singers = [];
  for (const line of r.lyrics || []) {
    if (line.time == null) continue;
    const t = line.time / 1000;
    const words = [];
    let cur = '', s = 0, e = 0, parts = [];
    for (const syl of line.syllabus || []) {
      if (!syl.text || !syl.text.trim() || syl.time == null) continue;
      if (!cur) s = syl.time / 1000;
      cur += syl.text.trim();
      e = (syl.time + (syl.duration || 0)) / 1000;
      parts.push({ start: syl.time / 1000, end: e, len: [...syl.text.trim()].length });
      if (/\s$/.test(syl.text)) { words.push({ start: s, end: e, text: cur, parts }); cur = ''; parts = []; }
    }
    if (cur) words.push({ start: s, end: e, text: cur, parts });
    let l;
    if (words.length) l = { time: Math.min(t, words[0].start), text: words.map((w) => w.text).join(' '), words };
    else if (line.text && line.text.trim()) l = { time: t, text: line.text.trim(), end: line.duration > 0 ? t + line.duration / 1000 : undefined };
    else continue;
    const el = line.element;
    if (Array.isArray(el) && el.some((x) => x === 'opposite' || x === 'right')) l.align = 'end';
    out.push(l);
    singers.push(el && !Array.isArray(el) ? el.singer : null);
  }
  const types = {};
  for (const [id, a] of Object.entries(r.metadata?.agents || {})) if (a?.type) types[a.alias || id] = a.type;
  const order = out.map((_, i) => i).sort((a, b) => out[a].time - out[b].time);
  const sorted = order.map((i) => out[i]);
  alignByAgents(sorted, order.map((i) => singers[i]), types);
  return withGaps(sorted);
}

const CONTENT_KEYS = ['ttml', 'ttmlContent', 'lyrics', 'lrc', 'content', 'text', 'plainLyrics', 'syncedLyrics', 'line', 'lines', 'lyric', 'data', 'result', 'response'];
function extract(el) {
  if (el == null) return null;
  if (typeof el === 'string') {
    const t = el.trim();
    try { const n = JSON.parse(t); if (n && typeof n === 'object') return extract(n); } catch {}
    return t;
  }
  if (typeof el !== 'object') return null;
  if (Array.isArray(el)) { const j = el.map(extract).filter(Boolean).join('\n'); return j.trim() ? j : null; }
  if (el.isError === true || el.ok === false || (el.error && el.error !== false && el.error !== '')) return null;
  for (const k of CONTENT_KEYS) { if (k in el) { const v = extract(el[k]); if (v) return v; } }
  if (el.metadata && typeof el.metadata === 'object') { const v = extract(el.metadata); if (v) return v; }
  return el.words ? extract(el.words) : null;
}

export function parseProvider(raw) {
  let v = String(raw).replace(/﻿/g, '').trim();
  if (v.startsWith('```')) v = v.split('\n').slice(1).join('\n').replace(/```\s*$/, '').trim();
  if (!v) return [];
  try { const j = JSON.parse(v); v = extract(j)?.trim() || ''; } catch {}
  if (!v) return [];
  if (/&lt;tt/i.test(v)) v = v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
  let lines;
  if (/<tt(\s|>)/i.test(v) || /http:\/\/www\.w3\.org\/ns\/ttml/i.test(v)) lines = parseTtml(v);
  else if (looksKaraoke(v)) lines = parseKaraokeLrc(v);
  else if (v.trimStart().startsWith('<')) lines = [];
  else {
    lines = parseEnhancedLrc(v);
    if (!lines.length) lines = parseLrc(v);
    if (!lines.length) {
      if (/\b(lyrics? (not found|unavailable)|error)\b/i.test(v)) return [];
      return { plain: v.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !/^\[[A-Za-z]+:.*\]$/.test(s)).join('\n') };
    }
  }
  return lines.some((l) => l.text && l.text.trim()) ? lines : [];
}

/** {format, data} from the main process → { synced, lines, plain, word } | null */
export function parseResult(res) {
  const r = parseInner(res);
  if (r && res?.attribution) r.attribution = res.attribution;
  return r;
}
function parseInner(res) {
  if (!res) return null;
  let out = null;
  switch (res.format) {
    case 'lrc': out = parseLrc(res.data); break;
    case 'elrc': out = parseEnhancedLrc(res.data); if (!out.length && res.fallback) return parseInner(res.fallback); break;
    case 'ttml': out = parseTtml(res.data); break;
    case 'lyricsplus': out = parseLyricsPlus(res.data); break;
    case 'lines': out = withGaps((res.data || []).filter((l) => l && l.text && l.time != null).sort((a, b) => a.time - b.time)); break; // built by the main process
    case 'provider': out = parseProvider(res.data); break;
    case 'plain': return res.data?.trim() ? { synced: false, lines: [], plain: res.data.trim() } : null;
  }
  if (!out) return null;
  if (!Array.isArray(out)) return out.plain ? { synced: false, lines: [], plain: out.plain } : null;
  if (!out.some((l) => l.text)) return null;
  // Some providers send "synced" lyrics whose lines all have the same time (usually 0): they'd
  // all count as already sung and the view would sit on the last line. Treat them as plain
  // text, so a properly synced source is looked for instead.
  const sung = out.filter((l) => l.text);
  const distinct = new Set(sung.map((l) => Math.round(l.time * 10))).size;
  if (sung.length > 2 && distinct < Math.max(2, sung.length * 0.25)) {
    return { synced: false, lines: [], plain: sung.map((l) => l.text).join('\n') };
  }
  return { synced: true, lines: out, word: out.some((l) => l.words?.length) };
}
