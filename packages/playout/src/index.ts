// playout: owns the avail schedule; emits SCTE-35 cues on the Redis cue bus.
import { startTracing } from '@adbreak/shared';
startTracing('playout');

import { readFileSync } from 'node:fs';
import { Router } from 'express';
import { createClient } from 'redis';
import { parse } from 'yaml';
import {
  CUE_CHANNEL,
  METRICS,
  availId,
  contextFromTraceparent,
  createService,
  encodeSpliceInsert,
  pts90kFromMs,
  traceparentOf,
  tracer,
  type BreakType,
  type CueMessage,
} from '@adbreak/shared';

interface Schedule {
  channel: string;
  periodic: {
    every_s: number;
    duration_s: number;
    break_type: BreakType;
    lead_time_s: number;
  };
}

const svc = createService('playout');
const schedulePath = process.env.SCHEDULE_PATH ?? '/app/schedules/sports-1.yaml';
const schedule = parse(readFileSync(schedulePath, 'utf8')) as Schedule;
const { channel } = schedule;
const { every_s, duration_s, break_type, lead_time_s } = schedule.periodic;

const availSignaled = svc.counter(METRICS.availSignaled);

const redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
redis.on('error', (err) => svc.log.error('redis error', { err: String(err) }));

let suppressRemaining = 0;
let eventId = 0;
let nextSpliceMs = 0;
/** Guards against re-scheduling a splice already handled: setTimeout can fire
 *  a few ms early, which would otherwise recompute the same splice and emit
 *  the cue twice (double-counting avail_signaled_total). */
let lastScheduledSpliceMs = 0;

function scheduleNextCue(): void {
  const nowMs = Date.now();
  const everyMs = every_s * 1000;
  let splice = Math.ceil(nowMs / everyMs) * everyMs;
  // Next unhandled splice that still leaves the full cue lead time.
  while (splice <= lastScheduledSpliceMs || splice - lead_time_s * 1000 <= nowMs) {
    splice += everyMs;
  }
  lastScheduledSpliceMs = splice;
  nextSpliceMs = splice;
  setTimeout(
    () => {
      void emitCue(new Date(splice));
      scheduleNextCue();
    },
    splice - lead_time_s * 1000 - nowMs,
  );
}

async function emitCue(spliceTime: Date): Promise<void> {
  eventId += 1;
  const id = availId(channel, spliceTime);
  if (suppressRemaining > 0) {
    suppressRemaining -= 1;
    svc.log.warn('cue SUPPRESSED (F01)', {
      avail_id: id,
      splice_time: spliceTime.toISOString(),
      remaining: suppressRemaining,
    });
    return;
  }
  // Root of this avail's lifecycle trace. It is created here, at the true
  // origin of the ad signal, and every later stage hangs off it.
  const root = tracer().startSpan('avail.lifecycle', {
    attributes: {
      avail_id: id,
      channel,
      duration_s,
      break_type,
      splice_time: spliceTime.toISOString(),
    },
  });
  const traceparent = traceparentOf(root);

  const cue: CueMessage = {
    kind: 'splice_insert',
    availId: id,
    channel,
    spliceTime: spliceTime.toISOString(),
    durationS: duration_s,
    breakType: break_type,
    scte35Out: encodeSpliceInsert({
      eventId,
      pts90k: pts90kFromMs(spliceTime.getTime()),
      durationS: duration_s,
      out: true,
    }),
    traceparent,
  };
  await redis.publish(CUE_CHANNEL, JSON.stringify(cue));
  tracer()
    .startSpan('signal.emit', { attributes: { avail_id: id } }, contextFromTraceparent(traceparent))
    .end();
  // The root stays open across the break so late stages (stitch, beacons)
  // attach to a live trace; close it once the break plus its beacons are done.
  setTimeout(() => root.end(), (lead_time_s + duration_s + 30) * 1000);
  availSignaled.inc({ channel, region: 'all', break_type });
  svc.log.info('cue emitted', {
    avail_id: id,
    splice_time: cue.spliceTime,
    duration_s,
  });
}

const admin = Router();
admin.post('/suppress', (req, res) => {
  const count = Number(req.body?.count ?? 1);
  suppressRemaining += count;
  svc.log.warn('suppression armed', { count, total: suppressRemaining });
  res.json({ suppressRemaining });
});
admin.get('/state', (_req, res) =>
  res.json({
    channel,
    nextSpliceTime: new Date(nextSpliceMs).toISOString(),
    suppressRemaining,
  }),
);
svc.admin(admin);

await redis.connect();
scheduleNextCue();
svc.log.info('schedule loaded', { channel, every_s, duration_s, lead_time_s });
svc.start(Number(process.env.PORT ?? 3000));
