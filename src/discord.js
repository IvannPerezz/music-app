// Discord Rich Presence over the local IPC pipe of the Discord desktop app ("Escuchando BitChord").
// On desktop this doesn't need your Discord login — Discord itself must be running.
import net from 'node:net';
import path from 'node:path';

// Discord shows the *application's* name ("Escuchando …"), so it has to be a Discord application
// called BitChord. The one inherited from the Android port is registered under another name: the
// user can create their own (Ajustes → Integraciones) and its ID is used instead.
const DEFAULT_ID = '1411019391843172514';
let CLIENT_ID = DEFAULT_ID;
let sock = null, ready = false, connecting = false, enabled = false, pending = null, retryTimer = null;

function pipePath(i) {
  if (process.platform === 'win32') return `\\\\?\\pipe\\discord-ipc-${i}`;
  const base = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || '/tmp';
  return path.join(base, `discord-ipc-${i}`);
}

function frame(op, data) {
  const json = Buffer.from(JSON.stringify(data));
  const h = Buffer.alloc(8); h.writeInt32LE(op, 0); h.writeInt32LE(json.length, 4);
  return Buffer.concat([h, json]);
}

function tryConnect(i = 0) {
  if (!enabled || ready || (connecting && i === 0)) return;
  connecting = true;
  if (i > 9) { connecting = false; scheduleRetry(); return; }
  const s = net.createConnection(pipePath(i));
  s.once('error', () => { s.destroy(); tryConnect(i + 1); });
  s.once('connect', () => {
    sock = s;
    s.write(frame(0, { v: 1, client_id: CLIENT_ID }));
    let buf = Buffer.alloc(0);
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 8) {
        const op = buf.readInt32LE(0), len = buf.readInt32LE(4);
        if (buf.length < 8 + len) break;
        let msg = {}; try { msg = JSON.parse(buf.subarray(8, 8 + len).toString()); } catch {}
        buf = buf.subarray(8 + len);
        if (op === 1 && msg.evt === 'READY') { ready = true; connecting = false; if (pending) send(pending); }
        if (op === 2) { close(); scheduleRetry(); }
        if (msg.evt === 'ERROR') console.warn('[discord]', msg.data?.message);
      }
    });
    s.on('close', () => { sock = null; ready = false; connecting = false; scheduleRetry(); });
    s.removeAllListeners('error');
    s.on('error', () => {});
  });
}

function scheduleRetry() {
  if (!enabled || retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = null; tryConnect(); }, 15000);
}

function close() { try { sock?.destroy(); } catch {} sock = null; ready = false; }

function send(activity) {
  if (!sock || !ready) return;
  sock.write(frame(1, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity }, nonce: String(Date.now()) + Math.random() }));
}

/** A different Discord application (its "Application ID"): reconnects with it. */
export function setClientId(id) {
  const next = /^\d{15,25}$/.test(String(id || '').trim()) ? String(id).trim() : DEFAULT_ID;
  if (next === CLIENT_ID) return;
  CLIENT_ID = next;
  if (!enabled) return;
  close();
  clearTimeout(retryTimer); retryTimer = null;
  setTimeout(() => tryConnect(), 300);
}

export function setEnabled(on) {
  enabled = on;
  if (on) tryConnect();
  else { if (ready) send(null); setTimeout(close, 200); clearTimeout(retryTimer); retryTimer = null; }
}

/** state: {track, playing, position, duration} */
export function update(st) {
  if (!enabled) return;
  let activity = null;
  if (st?.track && st.playing) {
    const t = st.track;
    const now = Date.now();
    const artists = (t.artists || []).map((a) => a.name).join(', ');
    activity = {
      type: 2, // Listening
      details: (t.title || '').slice(0, 128) || 'BitChord',
      state: (artists || 'BitChord').slice(0, 128),
      timestamps: st.duration ? { start: Math.round(now - st.position * 1000), end: Math.round(now + (st.duration - st.position) * 1000) } : undefined,
      assets: {
        large_image: t.thumb && /^https:/.test(t.thumb) ? t.thumb : 'logo',
        large_text: (t.album?.name || t.title || '').slice(0, 128),
      },
      buttons: t.local ? undefined : [{ label: 'Escuchar en YouTube Music', url: `https://music.youtube.com/watch?v=${t.id}` }],
      instance: false,
    };
  }
  pending = activity;
  if (ready) send(activity); else tryConnect();
}
