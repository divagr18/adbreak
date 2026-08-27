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

/** Everything already booked, keyed by session|avail|pod position|creative|event.
 *  Position is part of the key because one pod may legitimately carry the same
 *  creative twice, and those are two separate billable impressions. */
const seen = new Set<string>();

interface AvailStats {
  byEvent: Record<string, number>;
  byDeviceEvent: Record<string, Record<string, number>>;
  sessions: Set<string>;
}
const stats = new Map<string, AvailStats>();

function record(
  q: Record<string, string>,
  exemplar?: { traceId: string; spanId: string },
): boolean {
  const key = `${q.session}|${q.availId}|${q.pos}|${q.creative}|${q.event}`;
  if (seen.has(key)) return false;
  seen.add(key);

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
  if (exemplar) {
    beaconFired.inc({ labels: firedLabels, value: 1, exemplarLabels: exemplar });
  } else {
    beaconFired.inc(firedLabels);
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

  const s = stats.get(q.availId) ?? { byEvent: {}, byDeviceEvent: {}, sessions: new Set() };
  s.byEvent[q.event] = (s.byEvent[q.event] ?? 0) + 1;
  const dev = (s.byDeviceEvent[q.device_class] ??= {});
  dev[q.event] = (dev[q.event] ?? 0) + 1;
  s.sessions.add(q.session);
  stats.set(q.availId, s);
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
