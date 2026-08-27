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
} from 'prom-client';
import { METRICS } from './telemetry.js';
import { logger, type Logger } from './logger.js';

type MetricSpec = {
  name: string;
  help: string;
  labels: readonly string[];
  buckets?: readonly number[];
};

export interface ServiceContext {
  app: Express;
  log: Logger;
  registry: Registry;
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
  const registry = new Registry();
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
