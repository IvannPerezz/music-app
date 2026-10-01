// Chooses where a YouTube Music track's audio comes from (BitChord's SourceResolver, simplified):
// an enabled alternative source with a confident match wins; otherwise YouTube Music.
import * as settings from '../settings.js';
import * as jiosaavn from './jiosaavn.js';

const overrides = new Map(); // videoId -> {stream, at}
const used = new Map(); // videoId -> stream info actually used
const TTL = 30 * 60 * 1000;

/** meta: {title, artist, duration} parsed from the stream URL. */
export async function override(videoId, meta) {
  if (!settings.get('sourceJioSaavn') || !meta?.title) return null;
  const hit = overrides.get(videoId);
  if (hit && Date.now() - hit.at < TTL) return hit.stream;
  const work = (async () => {
    const m = await jiosaavn.match({ id: videoId, title: meta.title, artists: [{ name: meta.artist }], duration: meta.duration });
    if (!m) return null;
    return await jiosaavn.streamFor(m.id);
  })();
  // Never hold playback up for long: YouTube is the fallback.
  const stream = await Promise.race([work, new Promise((ok) => setTimeout(() => ok(null), 4000))]).catch(() => null);
  overrides.set(videoId, { stream, at: Date.now() });
  return stream;
}

export function invalidate(videoId) { overrides.set(videoId, { stream: null, at: Date.now() }); }
export function noteUsed(videoId, stream) { used.set(videoId, { mime: stream.mime, codec: stream.codec, bitrate: stream.bitrate, client: stream.client, size: stream.size }); }
export function usedFor(videoId) { return used.get(videoId) || null; }
