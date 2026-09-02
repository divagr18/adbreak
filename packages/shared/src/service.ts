/**
 * Common service bootstrap: Express app with /healthz and /metrics,
 * a per-service prom-client registry pre-loaded with the §8 contract,
 * and a structured logger. Every plant service starts from this.
 */

import express, { type Express, type Router } from 'express';
import {
  Registry,
  Counter,
  Gauge,
  Histogram,
  collectDefaultMetrics,
  type OpenMetricsContentType,
} from 'prom-client';
import { METRICS } from './telemetry.js';
import { logger, type Logger } from './logger.js';

type MetricSpec = {
  name: string;
  help: string;
  labels: readonly string[];
  buckets?: readonly number[];
  /**
   * Opt in per metric. Without this, prom-client binds inc()/observe() to the
   * non-exemplar variants, and passing the {labels, value, exemplarLabels}
   * form is then read as a *labels object* — which throws.
   */
  enableExemplars?: boolean;
};

export interface ServiceContext {
  app: Express;
  log: Logger;
  registry: Registry<OpenMetricsContentType>;
  counter(spec: MetricSpec): Counter<string>;
  gauge(spec: MetricSpec): Gauge<string>;
  histogram(spec: MetricSpec): Histogram<string>;
  /** Mount an admin router under /admin (knobs, fault rules, ...). */
  admin(router: Router): void;
  start(port: number): void;
}

export function createService(component: string): ServiceContext {
  const app = express();
  app.use(express.json());
  const log = logger(component);

  // A plant service must not die on a transport hiccup.
  //
  // The edge proxies upstream with fetch, and when a connection is severed
  // mid-response undici's HTTP parser raises ERR_ASSERTION from inside Node -
  // not a rejected promise anyone can catch, an uncaught exception that took
  // the whole process down. The deployed CDN edge was dead for exactly that
  // reason while its container still reported healthy.
  //
  // Registered once here so every service gets it rather than each remembering.
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception - staying up', { err: String(err) });
  });
  process.on('unhandledRejection', (err) => {
    log.error('unhandled rejection - staying up', { err: String(err) });
  });
  // OpenMetrics, not the classic Prometheus text format: exemplars are only
  // exposed in OpenMetrics, and exemplars are what let a metric spike in
  // Grafana jump straight to the trace of the avail that caused it.
  const registry = new Registry<OpenMetricsContentType>();
  registry.setContentType(Registry.OPENMETRICS_CONTENT_TYPE);
  registry.setDefaultLabels({ service: component });
  collectDefaultMetrics({ register: registry });

  const made = new Map<string, Counter<string> | Gauge<string> | Histogram<string>>();
  const memo = <T>(spec: MetricSpec, make: () => T): T => {
    const existing = made.get(spec.name);
    if (existing) return existing as T;
    const m = make();
    made.set(spec.name, m as never);
    return m;
  };

  const ctx: ServiceContext = {
    app,
    log,
    registry,
    counter: (spec) =>
      memo(spec, () =>
        new Counter({
          name: spec.name,
          help: spec.help,
          labelNames: [...spec.labels],
          registers: [registry],
          enableExemplars: spec.enableExemplars ?? false,
        }),
      ),
    gauge: (spec) =>
      memo(spec, () =>
        new Gauge({
          name: spec.name,
          help: spec.help,
          labelNames: [...spec.labels],
          registers: [registry],
        }),
      ),
    histogram: (spec) =>
      memo(spec, () =>
        new Histogram({
          name: spec.name,
          help: spec.help,
          labelNames: [...spec.labels],
          buckets: spec.buckets ? [...spec.buckets] : undefined,
          registers: [registry],
          enableExemplars: spec.enableExemplars ?? false,
        }),
      ),
    admin: (router) => app.use('/admin', router),
    start: (port) => {
      app.get('/healthz', (_req, res) => res.json({ ok: true, component }));
      app.get('/metrics', async (_req, res) => {
        res.set('Content-Type', registry.contentType);
        res.send(await registry.metrics());
      });
      app.listen(port, () => log.info('listening', { port }));
    },
  };
  return ctx;
}

export { METRICS };
