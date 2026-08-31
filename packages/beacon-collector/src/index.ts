// beacon-collector: the billing record.
// A confirmed, deduplicated impression here is the only thing that earns money —
// no beacon, no revenue, regardless of whether a human watched the ad.
import { startTracing } from '@adbreak/shared';
startTracing('beacon-collector');

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  BILLABLE_EVENT,
  METRICS,
  contextFromTraceparent,
  createService,
  exemplarLabels,
  impressionValueUsd,
  tracer,
} from '@adbreak/shared';

const svc = createService('beacon-collector');
const LEDGER_PATH = process.env.LEDGER_PATH ?? '/data/beacons.jsonl';
const CATALOG_PATH = process.env.CATALOG_PATH ?? '/app/creatives/index.json';
const CHANNEL = process.env.CHANNEL ?? 'sports-1';
mkdirSync(dirname(LEDGER_PATH), { recursive: true });

const beaconFired = svc.counter(METRICS.beaconFired);
const revenueRealized = svc.counter(METRICS.revenueRealized);

/** creative id -> advertiser, so a confirmed impression can be priced. */
const advertiserOf = new Map<string, string>();
try {
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8').replace(/^﻿/, '')) as {
    id: string;
    advertiser: string;
  }[];
  for (const c of catalog) advertiserOf.set(c.id, c.advertiser);
  svc.log.info('catalog loaded', { creatives: advertiserOf.size });
} catch (err) {
  svc.log.error('catalog load failed — realized revenue will not be priced', { err: String(err) });
}

/**
 * Per-avail state, evicted once the avail is far enough in the past.
 *
 * Both the dedupe set and the stats used to grow without bound - one entry per
 * session, avail, pod position, creative and event, forever. At 200 sessions
 * and a break every two minutes that is well over a million strings a day, and
 * this process was found holding 1.5 GB after 42 hours, with the edge
 * intermittently failing to reach it. A component whose whole job is counting
 * money must not fall over from having counted a lot of it.
 *
 * Keying the dedupe per avail rather than globally means eviction drops both at
 * once. Every beacon for an avail arrives within about a minute of it, so
 * retaining the last few dozen is far more history than correctness needs.
 */
const RETAIN_AVAILS = Number(process.env.RETAIN_AVAILS ?? 40);

interface AvailStats {
  byEvent: Record<string, number>;
  byDeviceEvent: Record<string, Record<string, number>>;
  sessions: Set<string>;
  /** Booked already, keyed by session|pod position|creative|event. Position is
   *  part of the key because one pod may legitimately carry the same creative
   *  twice, and those are two separate billable impressions. */
  seen: Set<string>;
}
const stats = new Map<string, AvailStats>();

const retainedAvails = svc.gauge({
  name: 'adbreak_collector_retained_avails',
  help: 'Avails currently held in memory for dedupe and per-break stats',
  labels: [] as const,
});

/** Map preserves insertion order, so the oldest avail is simply the first key. */
function evictOldAvails(): void {
  while (stats.size > RETAIN_AVAILS) {
    const oldest = stats.keys().next().value;
    if (oldest === undefined) break;
    stats.delete(oldest);
  }
  retainedAvails.set({}, stats.size);
}

function record(
  q: Record<string, string>,
  exemplar?: { traceId: string; spanId: string },
): boolean {
  const avail = stats.get(q.availId) ?? {
    byEvent: {},
    byDeviceEvent: {},
    sessions: new Set<string>(),
    seen: new Set<string>(),
  };
  // availId is the map key, so it need not be repeated inside the entry key.
  const key = `${q.session}|${q.pos}|${q.creative}|${q.event}`;
  if (avail.seen.has(key)) return false;
  avail.seen.add(key);

  const entry = {
    ts: new Date().toISOString(),
    event: q.event,
    session_id: q.session,
    avail_id: q.availId,
    creative: q.creative,
    pos: q.pos,
    device_class: q.device_class,
    cdn: q.cdn,
    isp: q.isp,
    region: q.region,
  };
  appendFileSync(LEDGER_PATH, JSON.stringify(entry) + '\n');

  const firedLabels = {
    event: q.event,
    device_class: q.device_class,
    cdn: q.cdn,
    isp: q.isp,
    region: q.region,
  };
  // With an exemplar attached, a gap on the impression panel links straight to
  // the trace of the break that produced it.
  // Never let exemplar bookkeeping cost us a billing record: the impression is
  // already written to the ledger above, and dropping the counter increment
  // would understate realized revenue.
  // ALWAYS the object form: enabling exemplars rebinds inc() to the exemplar
  // variant, which reads its first argument as a config object. Passing a bare
  // labels object there silently drops every label — 95% of beacons landed on
  // one unlabelled series, leaving the impression-gap panel reading the traced
  // 5% only.
  try {
    beaconFired.inc({
      labels: firedLabels,
      value: 1,
      ...(exemplar ? { exemplarLabels: exemplar } : {}),
    });
  } catch (err) {
    svc.log.warn('beacon counter failed', { err: String(err) });
  }

  // The impression beacon is the billing record: this line, and only this
  // line, is where money is recognised as earned.
  if (q.event === BILLABLE_EVENT) {
    const advertiser = advertiserOf.get(q.creative) ?? 'unknown';
    revenueRealized.inc(
      {
        channel: CHANNEL,
        region: q.region,
        advertiser,
        device_class: q.device_class,
      },
      impressionValueUsd(advertiser, q.region),
    );
  }

  avail.byEvent[q.event] = (avail.byEvent[q.event] ?? 0) + 1;
  const dev = (avail.byDeviceEvent[q.device_class] ??= {});
  dev[q.event] = (dev[q.event] ?? 0) + 1;
  avail.sessions.add(q.session);
  stats.set(q.availId, avail);
  evictOldAvails();
  return true;
}

const REQUIRED = ['event', 'session', 'availId', 'creative'] as const;

svc.app.all('/beacon', (req, res) => {
  const q = req.query as Record<string, string>;
  const missing = REQUIRED.filter((k) => !q[k]);
  if (missing.length) {
    res.status(400).json({ error: 'missing', missing });
    return;
  }
  // Only sampled sessions carry a traceparent (the SSAI decides); its absence
  // is the signal not to trace, which keeps a break's trace readable.
  let exemplar: { traceId: string; spanId: string } | undefined;
  if (q.tp) {
    const span = tracer().startSpan(
      'beacon.fire',
      {
        attributes: {
          event: q.event,
          avail_id: q.availId,
          creative: q.creative,
          device_class: q.device_class ?? 'unknown',
          ack_status: 204,
        },
      },
      contextFromTraceparent(q.tp),
    );
    exemplar = exemplarLabels(span);
    span.end();
  }

  const fresh = record(
    {
      event: q.event,
      session: q.session,
      availId: q.availId,
      creative: q.creative,
      pos: q.pos ?? '0',
      device_class: q.device_class ?? 'unknown',
      cdn: q.cdn ?? 'unknown',
      isp: q.isp ?? 'unknown',
      region: q.region ?? 'unknown',
    },
    exemplar,
  );
  res.status(fresh ? 204 : 200).end();
});

svc.app.get('/stats', (req, res) => {
  const availId = req.query.availId as string | undefined;
  const render = (id: string, s: AvailStats) => ({
    availId: id,
    sessions: s.sessions.size,
    byEvent: s.byEvent,
    byDeviceEvent: s.byDeviceEvent,
  });
  if (availId) {
    const s = stats.get(availId);
    res.json(s ? render(availId, s) : { availId, sessions: 0, byEvent: {}, byDeviceEvent: {} });
    return;
  }
  res.json({
    avails: [...stats.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-5)
      .map(([id, s]) => render(id, s)),
  });
});

svc.start(Number(process.env.PORT ?? 3000));
