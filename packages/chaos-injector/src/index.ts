// chaos-injector: one API in front of every fault hook in the plant.
//
// INTEGRITY PROPERTY — READ BEFORE CHANGING ANYTHING HERE:
// This service writes ground-truth.jsonl, the record of what was actually
// broken and when. The agent must NEVER be able to read it, directly or
// indirectly: it is the answer key. Only the eval harness reads it. Do not
// expose it over any endpoint this service serves, do not log its contents,
// and do not mount its directory into the agent.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createService } from '@adbreak/shared';

const svc = createService('chaos-injector');
const GROUND_TRUTH_PATH = process.env.GROUND_TRUTH_PATH ?? '/data/ground-truth.jsonl';
mkdirSync(dirname(GROUND_TRUTH_PATH), { recursive: true });

const PLAYOUT_URL = process.env.PLAYOUT_URL ?? 'http://playout:3000';
const PACKAGER_URL = process.env.PACKAGER_URL ?? 'http://packager:3000';
const ADS_URL = process.env.ADS_URL ?? 'http://ads:3000';
const EDGE_URL = process.env.EDGE_URL ?? 'http://edge:3000';

type Params = Record<string, string | number | undefined>;

interface FaultSpec {
  id: string;
  title: string;
  target: string;
  params: string;
  /** Applies the fault; returns a revert function capturing prior state. */
  apply(params: Params): Promise<() => Promise<void>>;
}

const post = async (url: string, body: unknown): Promise<unknown> => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status}`);
  return res.json().catch(() => ({}));
};

const del = async (url: string): Promise<void> => {
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new Error(`DELETE ${url} -> ${res.status}`);
};

/** Set ADS knobs, returning a revert that restores exactly what was there. */
async function withAdsKnobs(patch: Params): Promise<() => Promise<void>> {
  const before = (await fetch(`${ADS_URL}/admin/knobs`).then((r) => r.json())) as Params;
  const restore = Object.fromEntries(Object.keys(patch).map((k) => [k, before[k]]));
  await post(`${ADS_URL}/admin/knobs`, patch);
  return async () => {
    await post(`${ADS_URL}/admin/knobs`, restore);
  };
}

/** Register an edge fault, returning a revert that removes only that fault. */
async function withEdgeFault(body: Params): Promise<() => Promise<void>> {
  const created = (await post(`${EDGE_URL}/admin/faults`, body)) as { id: number };
  return async () => {
    await del(`${EDGE_URL}/admin/faults/${created.id}`);
  };
}

const noRevert = async (): Promise<void> => {};

const FAULTS: FaultSpec[] = [
  {
    id: 'F01',
    title: 'Cue suppressed at playout',
    target: 'playout',
    params: 'count (default 1)',
    // One-shot: the cue is simply never emitted. Nothing to revert.
    apply: async (p) => {
      await post(`${PLAYOUT_URL}/admin/suppress`, { count: Number(p.count ?? 1) });
      return noRevert;
    },
  },
  {
    id: 'F02',
    title: 'Cue dropped by the packager',
    target: 'packager',
    params: 'count (default 1)',
    apply: async (p) => {
      await post(`${PACKAGER_URL}/admin/drop`, { count: Number(p.count ?? 1) });
      return noRevert;
    },
  },
  {
    id: 'F03',
    title: 'Ad decision server latency spike',
    target: 'ads',
    params: 'latency_ms (default 4000), jitter_ms',
    apply: (p) =>
      withAdsKnobs({
        latency_ms: Number(p.latency_ms ?? 4000),
        jitter_ms: Number(p.jitter_ms ?? 500),
      }),
  },
  {
    id: 'F04',
    title: 'Empty VAST / no-fill',
    target: 'ads',
    params: 'fill_rate (default 0)',
    apply: (p) => withAdsKnobs({ fill_rate: Number(p.fill_rate ?? 0) }),
  },
  {
    id: 'F07',
    title: 'Beacon blackhole at the CDN edge for one device class',
    target: 'edge',
    params: 'device_class (required), cdn (optional)',
    apply: (p) =>
      withEdgeFault({
        pathClass: 'beacon',
        deviceClass: p.device_class,
        cdn: p.cdn,
        action: 'blackhole',
      }),
  },
  {
    id: 'F08',
    title: 'Regional CDN 5xx on segment delivery',
    target: 'edge',
    params: 'cdn or region (one required), status (default 503)',
    apply: (p) =>
      withEdgeFault({
        pathClass: 'segment',
        cdn: p.cdn,
        region: p.region,
        action: 'error',
        status: Number(p.status ?? 503),
      }),
  },
  {
    id: 'F09',
    title: 'Ad pod duration underfill',
    target: 'ads',
    params: 'max_pod_ratio (default 0.5)',
    apply: (p) => withAdsKnobs({ max_pod_ratio: Number(p.max_pod_ratio ?? 0.5) }),
  },
];

const byId = new Map(FAULTS.map((f) => [f.id, f]));

interface Injection {
  injectionId: number;
  fault: string;
  params: Params;
  startedAt: string;
  expiresAt: string | null;
  revert: () => Promise<void>;
  timer: NodeJS.Timeout | null;
}

let seq = 0;
const active = new Map<number, Injection>();

function recordGroundTruth(
  action: 'inject' | 'revert' | 'expire',
  injection: Pick<Injection, 'injectionId' | 'fault' | 'params'>,
): void {
  appendFileSync(
    GROUND_TRUTH_PATH,
    JSON.stringify({
      ts: new Date().toISOString(),
      action,
      injectionId: injection.injectionId,
      fault: injection.fault,
      params: injection.params,
    }) + '\n',
  );
}

async function revert(injection: Injection, action: 'revert' | 'expire'): Promise<void> {
  if (!active.has(injection.injectionId)) return;
  active.delete(injection.injectionId);
  if (injection.timer) clearTimeout(injection.timer);
  try {
    await injection.revert();
  } catch (err) {
    svc.log.error('revert failed', { injectionId: injection.injectionId, err: String(err) });
  }
  recordGroundTruth(action, injection);
  svc.log.warn('fault reverted', { injectionId: injection.injectionId, fault: injection.fault, action });
}

svc.app.get('/faults', (_req, res) =>
  res.json(FAULTS.map(({ id, title, target, params }) => ({ id, title, target, params }))),
);

svc.app.get('/inject', (_req, res) =>
  res.json(
    [...active.values()].map(({ injectionId, fault, params, startedAt, expiresAt }) => ({
      injectionId,
      fault,
      params,
      startedAt,
      expiresAt,
    })),
  ),
);

svc.app.post('/inject', (req, res) => {
  void (async () => {
    const faultId = String(req.body?.fault ?? '').toUpperCase();
    const spec = byId.get(faultId);
    if (!spec) {
      res.status(400).json({ error: 'unknown fault', fault: faultId, known: [...byId.keys()] });
      return;
    }
    const params: Params = req.body?.params ?? {};
    const durationS = Number(req.body?.duration_s ?? 300);

    try {
      const revertFn = await spec.apply(params);
      const injectionId = ++seq;
      const injection: Injection = {
        injectionId,
        fault: spec.id,
        params,
        startedAt: new Date().toISOString(),
        expiresAt: durationS > 0 ? new Date(Date.now() + durationS * 1000).toISOString() : null,
        revert: revertFn,
        timer: null,
      };
      if (durationS > 0) {
        injection.timer = setTimeout(() => void revert(injection, 'expire'), durationS * 1000);
      }
      active.set(injectionId, injection);
      recordGroundTruth('inject', injection);
      svc.log.warn('fault injected', { injectionId, fault: spec.id, params, duration_s: durationS });
      res.json({
        injectionId,
        fault: spec.id,
        title: spec.title,
        params,
        expiresAt: injection.expiresAt,
      });
    } catch (err) {
      svc.log.error('inject failed', { fault: faultId, err: String(err) });
      res.status(502).json({ error: 'inject failed', detail: String(err) });
    }
  })();
});

svc.app.delete('/inject/:id', (req, res) => {
  void (async () => {
    const injection = active.get(Number(req.params.id));
    if (!injection) {
      res.status(404).json({ error: 'no such injection' });
      return;
    }
    await revert(injection, 'revert');
    res.json({ reverted: injection.injectionId });
  })();
});

svc.app.delete('/inject', (_req, res) => {
  void (async () => {
    const all = [...active.values()];
    for (const injection of all) await revert(injection, 'revert');
    res.json({ reverted: all.length });
  })();
});

svc.start(Number(process.env.PORT ?? 3000));
