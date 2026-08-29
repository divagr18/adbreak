// ssai: builds a personalized manifest per session, splicing ad segments into
// the content timeline at cue boundaries.
//
// Two deliberate design choices:
//  - Breaks are learned from the packager's manifest markers, not the cue bus,
//    so a packager that drops a cue (F02) really does starve ad insertion.
//  - Ads and content are both 4s and avails are a multiple of 4s, so segments
//    are substituted 1:1 and EXT-X-MEDIA-SEQUENCE is never rewritten.
import { startTracing } from '@adbreak/shared';
startTracing('ssai');

import {
  BEACON_EVENTS,
  METRICS,
  contextFromTraceparent,
  inSpan,
  traceparentOf,
  createService,
  impressionValueUsd,
  parseCueWindows,
  parsePlaylist,
  sampled,
  serialize,
  type CueWindow,
} from '@adbreak/shared';

const svc = createService('ssai');
const PACKAGER_URL = process.env.PACKAGER_URL ?? 'http://packager:3000';
const ORIGIN_URL = process.env.ORIGIN_URL ?? 'http://origin';
const ADS_URL = process.env.ADS_URL ?? 'http://ads:3000';
const CHANNEL = process.env.CHANNEL ?? 'sports-1';
const SEGMENT_S = Number(process.env.SEGMENT_S ?? 4);
const SLATE_ID = 'slate';
const SESSION_TTL_MS = 5 * 60_000;

/**
 * Fraction of sessions whose per-session work is traced. Every span for one
 * avail shares that avail's trace, so trace-ID ratio sampling is useless here:
 * it would keep or drop the entire break. Sampling per session instead keeps a
 * trace small enough to actually read — a handful of sessions is far more
 * legible than all 200 — and it is deterministic, so the same sessions appear
 * across breaks rather than a different random subset each time.
 */
const SPAN_SAMPLE = Number(process.env.SPAN_SAMPLE ?? 0.02);

const isTraced = (sessionId: string): boolean => sampled(sessionId, SPAN_SAMPLE);

/** Quartile offsets, matching exactly when the player fires each event. */
const EVENT_FRACTION: Record<string, number> = {
  impression: 0,
  start: 0,
  firstQuartile: 0.25,
  midpoint: 0.5,
  thirdQuartile: 0.75,
  complete: 1,
};

/** Run at a wall-clock moment; immediately if that moment has already passed. */
function schedule(atMs: number, fn: () => void): void {
  const delay = atMs - Date.now();
  if (delay <= 0) fn();
  else setTimeout(fn, delay).unref();
}

const availDecided = svc.counter(METRICS.availDecided);
const slateSeconds = svc.counter(METRICS.slateSeconds);
const stitchErrors = svc.counter(METRICS.stitchErrors);
const manifestLatency = svc.histogram(METRICS.manifestLatency);
const beaconExpected = svc.counter(METRICS.beaconExpected);
const revenueExpected = svc.counter(METRICS.revenueExpected);

interface Session {
  id: string;
  deviceClass: string;
  region: string;
  cdn: string;
  isp: string;
  lastSeen: number;
  /** availId -> decision */
  decisions: Map<string, Decision>;
}

interface PodCreative {
  id: string;
  advertiser: string;
  durationS: number;
  offsetS: number;
  tracking: Record<string, string>;
}

interface Decision {
  availId: string;
  startMs: number;
  durationS: number;
  creatives: PodCreative[];
  /** One entry per segment slot of the avail, path-absolute. */
  slots: string[];
  slateS: number;
}

const sessions = new Map<string, Session>();
let latestPlaylist = '';
let cueWindows: CueWindow[] = [];

/** Marks a decision as in-flight so a burst of polls can't double-request it. */
const PLACEHOLDER: Decision = {
  availId: '',
  startMs: 0,
  durationS: 0,
  creatives: [],
  slots: [],
  slateS: 0,
};

// ---- packager polling -----------------------------------------------------

let polling = false;

async function poll(): Promise<void> {
  if (polling) return; // a decision burst can outlast the poll interval
  polling = true;
  try {
    const res = await fetch(`${PACKAGER_URL}/content/live.m3u8`);
    if (!res.ok) return;
    latestPlaylist = await res.text();
    cueWindows = parseCueWindows(latestPlaylist);
    await decideForActiveSessions();
  } catch (err) {
    svc.log.warn('packager poll failed', { err: String(err) });
  } finally {
    polling = false;
  }
}
setInterval(() => void poll(), 1000);

// ---- creative segment lists ----------------------------------------------

const creativeSegments = new Map<string, string[]>();

async function segmentsFor(creativeId: string): Promise<string[]> {
  const cached = creativeSegments.get(creativeId);
  if (cached) return cached;
  const res = await fetch(`${ORIGIN_URL}/hls/creatives/${creativeId}/playlist.m3u8`);
  const uris = parsePlaylist(await res.text()).segments.map(
    (s) => `/seg/creatives/${creativeId}/${s.uri}`,
  );
  creativeSegments.set(creativeId, uris);
  return uris;
}

// ---- ad decisioning -------------------------------------------------------

interface ParsedAd {
  id: string;
  advertiser: string;
  durationS: number;
  tracking: Record<string, string>;
}

/** Parse our own well-known VAST output; no XML dependency needed. */
function parseVast(xml: string): ParsedAd[] {
  const ads: ParsedAd[] = [];
  for (const block of xml.split(/<Ad\s/).slice(1)) {
    const id = /id="([^"]+)"/.exec(block)?.[1];
    const dur = /<Duration>(\d+):(\d+):(\d+)<\/Duration>/.exec(block);
    if (!id || !dur) continue;
    const tracking: Record<string, string> = {};
    for (const ev of BEACON_EVENTS) {
      const m = new RegExp(`<Tracking event="${ev}"><!\\[CDATA\\[([^\\]]+)\\]\\]>`).exec(block);
      if (m) tracking[ev] = m[1];
    }
    ads.push({
      id,
      advertiser: /<Advertiser><!\[CDATA\[([^\]]*)\]\]><\/Advertiser>/.exec(block)?.[1] ?? 'unknown',
      durationS: Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]),
      tracking,
    });
  }
  return ads;
}

async function decide(session: Session, cue: CueWindow): Promise<void> {
  const q = new URLSearchParams({
    availId: cue.availId,
    channel: CHANNEL,
    dur: String(cue.durationS),
    session: session.id,
    device_class: session.deviceClass,
    region: session.region,
  });
  // Hangs off the avail's root span, which arrived inside the manifest.
  const traced = isTraced(session.id);
  // The traceparent is passed explicitly rather than left to HTTP
  // auto-instrumentation: ESM hoists every import, so express and http are
  // already loaded by the time startTracing() runs and the patch cannot be
  // relied on. Being explicit also makes ads.respond a real child of this span.
  const fetchVast = async (traceparent?: string) =>
    parseVast(
      await fetch(`${ADS_URL}/vast?${q}`, {
        headers: traceparent ? { traceparent } : {},
      }).then((r) => r.text()),
    );
  const ads = traced
    ? await inSpan(
        'decision.request',
        { avail_id: cue.availId, session_id: session.id, device_class: session.deviceClass },
        contextFromTraceparent(cue.traceparent),
        (span) => fetchVast(traceparentOf(span)),
      )
    : await fetchVast();

  const slots: string[] = [];
  const creatives: PodCreative[] = [];
  let offsetS = 0;
  for (const ad of ads) {
    const segs = await segmentsFor(ad.id);
    slots.push(...segs);
    creatives.push({
      id: ad.id,
      advertiser: ad.advertiser,
      durationS: ad.durationS,
      offsetS,
      tracking: Object.fromEntries(
        Object.entries(ad.tracking).map(([ev, url]) => {
          const u = new URL(url);
          u.searchParams.set('device_class', session.deviceClass);
          u.searchParams.set('cdn', session.cdn);
          u.searchParams.set('isp', session.isp);
          u.searchParams.set('region', session.region);
          // Carries the avail's trace onto the billing record, so a revenue
          // gap can be followed back to the exact break that produced it.
          // Only for sampled sessions — its presence is what tells the
          // collector to emit a span at all.
          if (traced && cue.traceparent) u.searchParams.set('tp', cue.traceparent);
          return [ev, u.toString()];
        }),
      ),
    });
    offsetS += ad.durationS;
  }

  // Unsold tail of the pod is filled with slate, and booked as such.
  const totalSlots = Math.round(cue.durationS / SEGMENT_S);
  const slateS = Math.max(0, (totalSlots - slots.length) * SEGMENT_S);
  if (slots.length < totalSlots) {
    const slate = await segmentsFor(SLATE_ID);
    while (slots.length < totalSlots) slots.push(slate[slots.length % slate.length]);
    slateSeconds.inc(
      { channel: CHANNEL, region: session.region, reason: 'pod_underfill' },
      slateS,
    );
  }

  session.decisions.set(cue.availId, {
    availId: cue.availId,
    startMs: cue.startMs,
    durationS: cue.durationS,
    creatives,
    slots: slots.slice(0, totalSlots),
    slateS,
  });

  availDecided.inc({ channel: CHANNEL, region: session.region, ads: 'ads-1' });
  // Server-side truth: what this session *should* report back, and what that
  // is worth. Counting here rather than at the player keeps the number honest
  // when the client never fires at all, and when the CDN blackholes the
  // beacon (F07) — the two cases that matter most.
  //
  // Each expectation is booked at the instant the beacon is *due*, not now.
  // Booking at decision time put expected ~45s ahead of realized, so a sliding
  // SLO window caught a different number of expected and realized bursts and
  // the ratio swung +/-14% on a healthy plant — occasionally above 1.0, which
  // realized/expected can never legitimately be. Ticking both counters at the
  // same wall-clock moment is what makes the SLO readable at all.
  for (const c of creatives) {
    const creativeStartMs = cue.startMs + c.offsetS * 1000;
    for (const ev of BEACON_EVENTS) {
      const dueMs = creativeStartMs + EVENT_FRACTION[ev] * c.durationS * 1000;
      schedule(dueMs, () =>
        beaconExpected.inc({
          event: ev,
          device_class: session.deviceClass,
          cdn: session.cdn,
          isp: session.isp,
          region: session.region,
        }),
      );
    }
    schedule(creativeStartMs, () =>
      revenueExpected.inc(
        {
          channel: CHANNEL,
          region: session.region,
          advertiser: c.advertiser,
          device_class: session.deviceClass,
        },
        impressionValueUsd(c.advertiser, session.region),
      ),
    );
  }
  svc.log.info('avail decided', {
    avail_id: cue.availId,
    session_id: session.id,
    creatives: creatives.map((c) => c.id),
    slate_s: slateS,
    traced,
  });
}

/** Ad decisions are per-session, so a cue releases a burst of them. Run them
 *  with bounded concurrency: serially, 200 sessions x ~150ms would take longer
 *  than the break itself and the ads would never make it into the manifest. */
const DECISION_CONCURRENCY = Number(process.env.DECISION_CONCURRENCY ?? 25);

async function decideForActiveSessions(): Promise<void> {
  const now = Date.now();
  const pending: { session: Session; cue: CueWindow }[] = [];

  for (const session of sessions.values()) {
    if (now - session.lastSeen > SESSION_TTL_MS) {
      sessions.delete(session.id);
      continue;
    }
    for (const cue of cueWindows) {
      // Only decide for breaks that have not already ended.
      if (session.decisions.has(cue.availId)) continue;
      if (now >= cue.startMs + cue.durationS * 1000) continue;
      pending.push({ session, cue });
      session.decisions.set(cue.availId, PLACEHOLDER); // claim it; replaced on success
    }
  }
  if (pending.length === 0) return;

  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const item = pending[next++];
      if (!item) return;
      try {
        await decide(item.session, item.cue);
      } catch (err) {
        item.session.decisions.delete(item.cue.availId); // allow a retry
        stitchErrors.inc({ reason: 'decision_failed', device_class: item.session.deviceClass });
        svc.log.error('decision failed', {
          avail_id: item.cue.availId,
          session_id: item.session.id,
          err: String(err),
        });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(DECISION_CONCURRENCY, pending.length) }, worker),
  );
}

// ---- stitching ------------------------------------------------------------

function stitch(session: Session): string {
  const pl = parsePlaylist(latestPlaylist);
  const decisions = [...session.decisions.values()];
  let previousWasAd = false;

  for (const seg of pl.segments) {
    // Signalling tags were addressed to us, not to the player.
    seg.lines = seg.lines.filter(
      (l) =>
        !l.startsWith('#EXT-X-DATERANGE') &&
        !l.startsWith('#EXT-X-CUE-OUT') &&
        !l.startsWith('#EXT-X-CUE-IN'),
    );

    const d =
      seg.pdtMs === null
        ? undefined
        : decisions.find(
            (x) => seg.pdtMs! >= x.startMs && seg.pdtMs! < x.startMs + x.durationS * 1000,
          );

    let uri: string;
    if (d) {
      const slot = Math.floor((seg.pdtMs! - d.startMs) / (SEGMENT_S * 1000));
      uri = d.slots[Math.min(slot, d.slots.length - 1)];
    } else {
      uri = `/seg/content/${seg.uri}`;
    }

    // A discontinuity is required on every content<->ad transition.
    const isAd = Boolean(d);
    const prefix = isAd !== previousWasAd ? ['#EXT-X-DISCONTINUITY'] : [];
    previousWasAd = isAd;

    seg.lines = [...prefix, ...seg.lines.slice(0, -1), uri];
    seg.uri = uri;
  }
  return serialize(pl);
}

// ---- endpoints ------------------------------------------------------------

function touch(req: { params: { id: string }; query: Record<string, unknown> }): Session {
  const id = req.params.id;
  const existing = sessions.get(id);
  if (existing) {
    existing.lastSeen = Date.now();
    return existing;
  }
  const q = req.query as Record<string, string | undefined>;
  const session: Session = {
    id,
    deviceClass: q.device_class ?? 'web',
    region: q.region ?? 'us-east',
    cdn: q.cdn ?? 'cdn-east',
    isp: q.isp ?? 'comcast',
    lastSeen: Date.now(),
    decisions: new Map(),
  };
  sessions.set(id, session);
  svc.log.info('session registered', {
    session_id: id,
    device_class: session.deviceClass,
    region: session.region,
    cdn: session.cdn,
  });
  return session;
}

svc.app.get('/session/:id/playlist.m3u8', (req, res) => {
  const started = process.hrtime.bigint();
  const session = touch(req);
  try {
    const body = stitch(session);
    manifestLatency.observe(
      { pop: session.cdn, device_class: session.deviceClass },
      Number(process.hrtime.bigint() - started) / 1e9,
    );
    res.type('application/vnd.apple.mpegurl').set('Cache-Control', 'no-cache').send(body);
  } catch (err) {
    stitchErrors.inc({ reason: 'stitch_failed', device_class: session.deviceClass });
    svc.log.error('stitch failed', { session_id: session.id, err: String(err) });
    res.status(500).end();
  }
});

svc.app.get('/session/:id/master.m3u8', (req, res) => {
  touch(req);
  const q = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  res
    .type('application/vnd.apple.mpegurl')
    .set('Cache-Control', 'no-cache')
    .send(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"',
        `playlist.m3u8${q}`,
      ].join('\n'),
    );
});

/** What the player must report back, and when. */
svc.app.get('/session/:id/tracking', (req, res) => {
  const session = touch(req);
  res.json(
    [...session.decisions.values()]
      .filter((d) => d.availId !== '')
      .map((d) => ({
        availId: d.availId,
        startTime: new Date(d.startMs).toISOString(),
        durationS: d.durationS,
        creatives: d.creatives,
      })),
  );
});

svc.app.get('/admin/state', (_req, res) =>
  res.json({
    sessions: sessions.size,
    cueWindows,
    sample: [...sessions.values()].slice(0, 3).map((s) => ({
      id: s.id,
      deviceClass: s.deviceClass,
      cdn: s.cdn,
      decisions: [...s.decisions.keys()],
    })),
  }),
);

await poll();
svc.start(Number(process.env.PORT ?? 3000));
