// edge: CDN simulator and the single ingress for every client.
// Proxies manifests, segments and beacons, and owns the fault table that makes
// F07 (beacon blackhole) and F08 (regional 5xx) possible.
import { startTracing } from '@adbreak/shared';
startTracing('edge');

import { Readable } from 'node:stream';
import { Router, type Request, type Response } from 'express';
import { METRICS, createService } from '@adbreak/shared';

const svc = createService('edge');
const SSAI_URL = process.env.SSAI_URL ?? 'http://ssai:3000';
const ORIGIN_URL = process.env.ORIGIN_URL ?? 'http://origin';
const COLLECTOR_URL = process.env.COLLECTOR_URL ?? 'http://beacon-collector:3000';

type PathClass = 'manifest' | 'segment' | 'beacon';
type FaultAction = 'blackhole' | 'error';

interface Fault {
  id: number;
  pathClass?: PathClass;
  deviceClass?: string;
  cdn?: string;
  region?: string;
  action: FaultAction;
  status?: number;
}

const cdnRequests = svc.counter(METRICS.cdnRequests);

let faultSeq = 0;
const faults: Fault[] = [];

interface ClientId {
  session: string;
  deviceClass: string;
  cdn: string;
  region: string;
}

/** A real CDN derives these from UA/geo/PoP; the fleet states them explicitly. */
function identify(req: Request): ClientId {
  const q = req.query as Record<string, string | undefined>;
  const h = (name: string) => (req.get(name) ?? '').trim();
  return {
    session: h('X-Session') || q.session || 'unknown',
    deviceClass: h('X-Device-Class') || q.device_class || 'unknown',
    cdn: h('X-Cdn') || q.cdn || 'unknown',
    region: h('X-Region') || q.region || 'unknown',
  };
}

function matchFault(pathClass: PathClass, id: ClientId): Fault | undefined {
  return faults.find(
    (f) =>
      (f.pathClass === undefined || f.pathClass === pathClass) &&
      (f.deviceClass === undefined || f.deviceClass === id.deviceClass) &&
      (f.cdn === undefined || f.cdn === id.cdn) &&
      (f.region === undefined || f.region === id.region),
  );
}

async function proxy(
  req: Request,
  res: Response,
  target: string,
  pathClass: PathClass,
): Promise<void> {
  const id = identify(req);
  const done = (status: number) => {
    cdnRequests.inc({ pop: id.cdn, status: String(status), path_class: pathClass });
  };

  const fault = matchFault(pathClass, id);
  if (fault) {
    if (fault.action === 'blackhole') {
      // The request never reaches the origin, but the client is told it did.
      // This is F07: perfectly healthy delivery, silently lost billing data.
      done(204);
      res.status(204).end();
      return;
    }
    const status = fault.status ?? 503;
    done(status);
    res.status(status).json({ error: 'edge fault injected', fault: fault.id });
    return;
  }

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: { accept: req.get('accept') ?? '*/*' },
    });
    done(upstream.status);
    res.status(upstream.status);
    const ct = upstream.headers.get('content-type');
    if (ct) res.type(ct);
    res.set('Cache-Control', pathClass === 'manifest' ? 'no-cache' : 'max-age=60');
    if (upstream.body) Readable.fromWeb(upstream.body as never).pipe(res);
    else res.end();
  } catch (err) {
    done(502);
    svc.log.error('proxy failed', { target, err: String(err) });
    res.status(502).json({ error: 'bad gateway' });
  }
}

const qs = (req: Request) => {
  const i = req.originalUrl.indexOf('?');
  return i === -1 ? '' : req.originalUrl.slice(i);
};

svc.app.all('/session/:id/:file', (req, res) =>
  void proxy(req, res, `${SSAI_URL}/session/${req.params.id}/${req.params.file}${qs(req)}`, 'manifest'),
);

svc.app.get('/seg/content/:seg', (req, res) =>
  void proxy(req, res, `${ORIGIN_URL}/hls/content/${req.params.seg}`, 'segment'),
);

svc.app.get('/seg/creatives/:creative/:seg', (req, res) =>
  void proxy(
    req,
    res,
    `${ORIGIN_URL}/hls/creatives/${req.params.creative}/${req.params.seg}`,
    'segment',
  ),
);

svc.app.all('/beacon', (req, res) =>
  void proxy(req, res, `${COLLECTOR_URL}/beacon${qs(req)}`, 'beacon'),
);

// Convenience for demos: play the live stream through the edge without a session.
svc.app.get('/hls/creatives/:creative/:file', (req, res) =>
  void proxy(
    req,
    res,
    `${ORIGIN_URL}/hls/creatives/${req.params.creative}/${req.params.file}`,
    'segment',
  ),
);

const admin = Router();
admin.get('/faults', (_req, res) => res.json(faults));
admin.post('/faults', (req, res) => {
  const fault: Fault = {
    id: ++faultSeq,
    pathClass: req.body?.pathClass,
    deviceClass: req.body?.deviceClass,
    cdn: req.body?.cdn,
    region: req.body?.region,
    action: req.body?.action === 'error' ? 'error' : 'blackhole',
    status: req.body?.status ? Number(req.body.status) : undefined,
  };
  faults.push(fault);
  svc.log.warn('fault injected', { ...fault });
  res.json(fault);
});
admin.delete('/faults', (_req, res) => {
  const cleared = faults.splice(0, faults.length).length;
  svc.log.warn('faults cleared', { cleared });
  res.json({ cleared });
});
// Per-fault removal so concurrent injections can revert independently.
admin.delete('/faults/:id', (req, res) => {
  const id = Number(req.params.id);
  const i = faults.findIndex((f) => f.id === id);
  if (i === -1) {
    res.status(404).json({ error: 'no such fault', id });
    return;
  }
  faults.splice(i, 1);
  svc.log.warn('fault cleared', { id });
  res.json({ cleared: id });
});
svc.admin(admin);

svc.start(Number(process.env.PORT ?? 3000));
