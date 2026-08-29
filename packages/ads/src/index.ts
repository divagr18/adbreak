// ads: mock VAST 4.x ad decision server.
// The knobs here ARE the F03 (latency) and F04 (no-fill) chaos surface.
import { startTracing } from '@adbreak/shared';
startTracing('ads');

import { readFileSync } from 'node:fs';
import { Router } from 'express';
import {
  BEACON_EVENTS,
  METRICS,
  contextFromTraceparent,
  createService,
  exemplarLabels,
  tracer,
} from '@adbreak/shared';

const svc = createService('ads');
const ADS_ID = process.env.ADS_ID ?? 'ads-1';
const CATALOG_PATH = process.env.CATALOG_PATH ?? '/app/creatives/index.json';
const BEACON_BASE = process.env.BEACON_BASE ?? 'http://edge:3000';
const PUBLIC_MEDIA_BASE = process.env.PUBLIC_MEDIA_BASE ?? 'http://edge:3000';

interface Creative {
  id: string;
  advertiser: string;
  durationS: number;
  playlist: string;
}

const catalog: Creative[] = JSON.parse(readFileSync(CATALOG_PATH, 'utf8').replace(/^﻿/, ''));
svc.log.info('catalog loaded', { creatives: catalog.length });

const knobs = {
  latency_ms: Number(process.env.LATENCY_MS ?? 150),
  jitter_ms: Number(process.env.JITTER_MS ?? 50),
  fill_rate: Number(process.env.FILL_RATE ?? 1),
  /** Cap the pod at this fraction of the avail — the F09 underfill surface.
   *  Whatever is left unsold gets slated by the SSAI. */
  max_pod_ratio: Number(process.env.MAX_POD_RATIO ?? 1),
};

const adsRequest = svc.counter(METRICS.adsRequest);
const adsDuration = svc.histogram(METRICS.adsResponseDuration);
const adsPodDuration = svc.gauge(METRICS.adsPodDuration);
const adsFillRatio = svc.gauge(METRICS.adsFillRatio);
const adsNoFill = svc.counter(METRICS.adsNoFill);

/** Rolling fill accounting per region, so the gauge reflects recent behaviour. */
const fill = new Map<string, { requested: number; filled: number }>();
function recordFill(region: string, requested: number, filled: number): void {
  const acc = fill.get(region) ?? { requested: 0, filled: 0 };
  // Decay keeps the ratio responsive when a fault starts or clears.
  acc.requested = acc.requested * 0.9 + requested;
  acc.filled = acc.filled * 0.9 + filled;
  fill.set(region, acc);
  adsFillRatio.set({ ads: ADS_ID, region }, acc.requested > 0 ? acc.filled / acc.requested : 0);
}

/**
 * Greedy pack, largest first, preferring creatives not already in the pod —
 * real ad servers apply competitive separation rather than running the same
 * spot twice back to back. Any unsold tail is left for the SSAI to slate.
 */
function buildPod(availS: number): Creative[] {
  const pod: Creative[] = [];
  const used = new Set<string>();
  let remaining = availS;
  const sorted = [...catalog].sort((a, b) => b.durationS - a.durationS);
  for (;;) {
    const next =
      sorted.find((c) => c.durationS <= remaining && !used.has(c.id)) ??
      sorted.find((c) => c.durationS <= remaining);
    if (!next) break;
    pod.push(next);
    used.add(next.id);
    remaining -= next.durationS;
  }
  return pod;
}

/** No XML escaping here: these URLs are emitted inside CDATA, which is by
 *  definition unparsed. Escaping them turns every `&` into a literal `&amp;`
 *  and silently corrupts the query string the beacon collector receives. */
function trackingUrl(
  event: string,
  session: string,
  availId: string,
  creativeId: string,
  pos: number,
): string {
  const q = new URLSearchParams({
    event,
    session,
    availId,
    creative: creativeId,
    pos: String(pos),
  });
  return `${BEACON_BASE}/beacon?${q.toString()}`;
}

function hhmmss(totalS: number): string {
  const h = Math.floor(totalS / 3600);
  const m = Math.floor((totalS % 3600) / 60);
  const s = Math.floor(totalS % 60);
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

function renderVast(pod: Creative[], session: string, availId: string): string {
  if (pod.length === 0) return '<?xml version="1.0" encoding="UTF-8"?>\n<VAST version="4.0"/>';
  const ads = pod
    .map((c, i) => {
      const tracking = BEACON_EVENTS.map(
        (e) =>
          `          <Tracking event="${e}"><![CDATA[${trackingUrl(e, session, availId, c.id, i)}]]></Tracking>`,
      ).join('\n');
      return `  <Ad id="${c.id}" sequence="${i + 1}">
    <InLine>
      <AdSystem version="1.0">adbreak-ads</AdSystem>
      <AdTitle><![CDATA[${c.advertiser}]]></AdTitle>
      <Advertiser><![CDATA[${c.advertiser}]]></Advertiser>
      <Creatives>
        <Creative id="${c.id}" adId="${c.id}">
          <Linear>
            <Duration>${hhmmss(c.durationS)}</Duration>
            <TrackingEvents>
${tracking}
            </TrackingEvents>
            <MediaFiles>
              <MediaFile delivery="streaming" type="application/x-mpegURL" width="1280" height="720">
                <![CDATA[${PUBLIC_MEDIA_BASE}${c.playlist}]]>
              </MediaFile>
            </MediaFiles>
          </Linear>
        </Creative>
      </Creatives>
    </InLine>
  </Ad>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<VAST version="4.0">\n${ads}\n</VAST>`;
}

svc.app.get('/vast', async (req, res) => {
  const started = process.hrtime.bigint();
  const availId = String(req.query.availId ?? 'unknown');
  const session = String(req.query.session ?? 'unknown');
  const region = String(req.query.region ?? 'unknown');
  const deviceClass = String(req.query.device_class ?? 'unknown');
  const availS = Number(req.query.dur ?? 30);

  adsRequest.inc({ ads: ADS_ID, region, device_class: deviceClass });

  const delay = knobs.latency_ms + Math.random() * knobs.jitter_ms;
  await new Promise((r) => setTimeout(r, delay));

  const noFill = Math.random() >= knobs.fill_rate;
  const sellableS = availS * knobs.max_pod_ratio;
  const pod = noFill ? [] : buildPod(sellableS);
  const podS = pod.reduce((sum, c) => sum + c.durationS, 0);
  if (noFill) adsNoFill.inc({ ads: ADS_ID, region });

  adsPodDuration.set({ ads: ADS_ID, region }, podS);
  recordFill(region, availS, podS);
  // Exemplar on the latency histogram: a p99 spike on the dashboard becomes a
  // click through to the trace of the avail that caused it. This is the jump
  // an F03 investigation starts with. The span is built from the inbound
  // traceparent rather than from an ambient context, because ESM import
  // hoisting makes HTTP auto-instrumentation unreliable here.
  const elapsedS = Number(process.hrtime.bigint() - started) / 1e9;
  const inbound = req.get('traceparent');
  let exemplar: { traceId: string; spanId: string } | undefined;
  if (inbound) {
    const span = tracer().startSpan(
      'ads.respond',
      {
        attributes: {
          avail_id: availId,
          fill: pod.length > 0,
          pod_duration_s: podS,
          creative_ids: pod.map((c) => c.id).join(','),
        },
      },
      contextFromTraceparent(inbound),
    );
    exemplar = exemplarLabels(span);
    span.end();
  }
  // Telemetry must never be able to fail the request it is measuring. This
  // exact call once threw inside the handler and returned 500 for every
  // sampled session — the instrumentation broke ad serving for the sessions
  // it was meant to observe. Record the observation, swallow anything else.
  // ALWAYS the object form — see the beacon collector for the same trap: with
  // exemplars enabled, observe(labels, value) is read as observe(config) and
  // the observation lands unlabelled.
  try {
    adsDuration.observe({
      labels: { ads: ADS_ID, region },
      value: elapsedS,
      ...(exemplar ? { exemplarLabels: exemplar } : {}),
    });
  } catch (err) {
    svc.log.warn('latency observation failed', { err: String(err) });
  }

  svc.log.info(noFill ? 'no-fill (F04)' : 'pod returned', {
    avail_id: availId,
    session_id: session,
    pod_duration_s: podS,
    avail_duration_s: availS,
    creatives: pod.map((c) => c.id),
  });

  res.type('application/xml').send(renderVast(pod, session, availId));
});

const admin = Router();
admin.get('/knobs', (_req, res) => res.json(knobs));
admin.post('/knobs', (req, res) => {
  for (const k of ['latency_ms', 'jitter_ms', 'fill_rate', 'max_pod_ratio'] as const) {
    if (req.body?.[k] !== undefined) knobs[k] = Number(req.body[k]);
  }
  svc.log.warn('knobs updated', { ...knobs });
  res.json(knobs);
});
svc.admin(admin);

svc.start(Number(process.env.PORT ?? 3000));
