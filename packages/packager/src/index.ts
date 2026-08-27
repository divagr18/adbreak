// packager: consumes the cue bus, owns the content manifest, injects
// EXT-X-DATERANGE (SCTE35-OUT/IN) + CUE-OUT/CUE-IN at segment boundaries.
import { Router } from 'express';
import { createClient } from 'redis';
import {
  CUE_CHANNEL,
  METRICS,
  createService,
  encodeSpliceInsert,
  pts90kFromMs,
  type CueMessage,
} from '@adbreak/shared';
import { injectMarkers, type CueState } from './rewrite.js';

const svc = createService('packager');
const ORIGIN_URL = process.env.ORIGIN_URL ?? 'http://origin';
/** Host-reachable origin, used for segment redirects a real player must follow. */
const PUBLIC_ORIGIN_URL = process.env.PUBLIC_ORIGIN_URL ?? ORIGIN_URL;
const PACKAGER_ID = process.env.PACKAGER_ID ?? 'pkg-1';
const POLL_MS = Number(process.env.POLL_MS ?? 1000);
/** Keep a cue this long past its cue-in before forgetting it. */
const CUE_TTL_MS = 120_000;

const availManifested = svc.counter(METRICS.availManifested);

interface TrackedCue extends CueState {
  channel: string;
  manifested: boolean;
}

const cues = new Map<string, TrackedCue>();
let latestPlaylist = '';
/** Marked playlist, recomputed each poll tick so manifestation is observed
 *  even when no player is pulling (otherwise the metric would depend on
 *  request traffic and a quiet period would look like an F02 drop). */
let markedPlaylist = '';
let dropRemaining = 0;

// ---- origin polling -------------------------------------------------------

async function pollOrigin(): Promise<void> {
  try {
    const res = await fetch(`${ORIGIN_URL}/hls/content/live.m3u8`);
    if (res.ok) {
      latestPlaylist = await res.text();
      markedPlaylist = render();
    } else svc.log.warn('origin poll non-200', { status: res.status });
  } catch (err) {
    svc.log.warn('origin poll failed', { err: String(err) });
  }
}
setInterval(() => void pollOrigin(), POLL_MS);

// ---- cue bus --------------------------------------------------------------

const redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
redis.on('error', (err) => svc.log.error('redis error', { err: String(err) }));
await redis.connect();

await redis.subscribe(CUE_CHANNEL, (raw) => {
  let cue: CueMessage;
  try {
    cue = JSON.parse(raw) as CueMessage;
  } catch (err) {
    svc.log.warn('malformed cue ignored', { err: String(err) });
    return;
  }
  if (dropRemaining > 0) {
    dropRemaining -= 1;
    svc.log.warn('cue DROPPED (F02)', { avail_id: cue.availId, remaining: dropRemaining });
    return;
  }
  const spliceTimeMs = Date.parse(cue.spliceTime);
  cues.set(cue.availId, {
    availId: cue.availId,
    channel: cue.channel,
    spliceTimeMs,
    durationS: cue.durationS,
    scte35Out: cue.scte35Out,
    scte35In: encodeSpliceInsert({
      eventId: spliceTimeMs % 0xffff,
      pts90k: pts90kFromMs(spliceTimeMs + cue.durationS * 1000),
      out: false,
    }),
    manifested: false,
  });
  svc.log.info('cue received', { avail_id: cue.availId, splice_time: cue.spliceTime });
});

setInterval(() => {
  const now = Date.now();
  for (const [id, cue] of cues) {
    if (now > cue.spliceTimeMs + cue.durationS * 1000 + CUE_TTL_MS) {
      cues.delete(id);
      svc.log.info('cue expired', { avail_id: id });
    }
  }
}, 10_000);

// ---- manifest serving -----------------------------------------------------

function render(): string {
  const list = [...cues.values()];
  const { playlist, manifested } = injectMarkers(latestPlaylist, list);
  for (const availId of manifested) {
    const cue = cues.get(availId);
    if (cue && !cue.manifested) {
      cue.manifested = true;
      availManifested.inc({ channel: cue.channel, region: 'all', packager: PACKAGER_ID });
      svc.log.info('avail manifested', { avail_id: availId });
    }
  }
  return playlist;
}

await pollOrigin();

svc.app.get('/content/live.m3u8', (_req, res) => {
  res.type('application/vnd.apple.mpegurl').set('Cache-Control', 'no-cache').send(markedPlaylist);
});

svc.app.get('/content/master.m3u8', async (_req, res) => {
  // Serve the origin master with the variant pointed at our marked playlist.
  const master = await fetch(`${ORIGIN_URL}/hls/content/master.m3u8`).then((r) => r.text());
  res
    .type('application/vnd.apple.mpegurl')
    .set('Cache-Control', 'no-cache')
    .send(master.replace(/^live\.m3u8$/m, '/content/live.m3u8'));
});

// Segments still come from the origin; redirect so a player following our
// manifest resolves media without us proxying bytes.
svc.app.get('/content/:seg', (req, res) => {
  const { seg } = req.params;
  if (!/^seg_\d+\.ts$/.test(seg)) return res.status(404).end();
  res.redirect(302, `${PUBLIC_ORIGIN_URL}/hls/content/${seg}`);
});

const admin = Router();
admin.post('/drop', (req, res) => {
  dropRemaining += Number(req.body?.count ?? 1);
  svc.log.warn('cue drop armed (F02)', { total: dropRemaining });
  res.json({ dropRemaining });
});
admin.get('/state', (_req, res) =>
  res.json({
    dropRemaining,
    cues: [...cues.values()].map((c) => ({
      availId: c.availId,
      spliceTime: new Date(c.spliceTimeMs).toISOString(),
      durationS: c.durationS,
      manifested: c.manifested,
    })),
  }),
);
svc.admin(admin);

svc.start(Number(process.env.PORT ?? 3000));
