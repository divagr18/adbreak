// The AdBreak agent: watches the revenue SLO, and when it breaks, diagnoses
// and repairs it without waiting for a human.
import { startTracing } from '@adbreak/shared';
startTracing('agent');

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createService } from '@adbreak/shared';
import { Incident } from './schemas.js';
import { runIncident, type AgentRun } from './run.js';
import { renderRunList, renderRun } from './trace-ui.js';

const svc = createService('agent');
const GRAFANA_URL = (process.env.GRAFANA_URL ?? '').replace(/\/$/, '');
const GRAFANA_TOKEN = process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN ?? '';
const RUN_DIR = process.env.RUN_DIR ?? '/agent-data/agent-runs';
const POLL_MS = Number(process.env.ALERT_POLL_MS ?? 15_000);
const ALERT_NAME = process.env.ALERT_NAME ?? 'RRR burn rate';

mkdirSync(RUN_DIR, { recursive: true });

// ---- self-telemetry -------------------------------------------------------
// The agent is observed by the same stack it operates. Phase D's watchdog and
// fleet dashboard are built on exactly these series.
const runTotal = svc.counter({
  name: 'adbreak_agent_run_total',
  help: 'Agent runs by trigger and outcome',
  labels: ['trigger', 'outcome'] as const,
});
const stepDuration = svc.histogram({
  name: 'adbreak_agent_step_duration_seconds',
  help: 'Wall-clock duration of each agent step',
  labels: ['step', 'kind'] as const,
  buckets: [0.5, 1, 2, 5, 10, 20, 40, 80, 160],
});
const tokensTotal = svc.counter({
  name: 'adbreak_agent_tokens_total',
  help: 'Tokens consumed by the agent',
  labels: ['model', 'step', 'kind'] as const,
});
const costTotal = svc.counter({
  name: 'adbreak_agent_cost_usd_total',
  help: 'Model spend attributable to agent runs',
  labels: ['model'] as const,
});
const remediationTotal = svc.counter({
  name: 'adbreak_agent_remediation_total',
  help: 'Remediations attempted, by runbook, tier and outcome',
  labels: ['runbook', 'tier', 'outcome'] as const,
});
const mttd = svc.histogram({
  name: 'adbreak_agent_mttd_seconds',
  help: 'Alert fired to agent detection',
  labels: [] as const,
  buckets: [5, 15, 30, 60, 120, 300],
});
const mttr = svc.histogram({
  name: 'adbreak_agent_mttr_seconds',
  help: 'Detection to verified recovery',
  labels: [] as const,
  buckets: [30, 60, 90, 120, 180, 300, 600],
});

// ---- run store ------------------------------------------------------------

function saveRun(run: AgentRun): void {
  writeFileSync(join(RUN_DIR, `${run.runId}.json`), JSON.stringify(run, null, 2));
}

function listRuns(): AgentRun[] {
  return readdirSync(RUN_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(RUN_DIR, f), 'utf8')) as AgentRun)
    .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
}

// ---- step 1: detect -------------------------------------------------------
// Grafana Cloud cannot reach a laptop, so polling is the primary trigger; the
// webhook below is what a hosted deployment would use instead.

interface AlertInstance {
  labels: Record<string, string>;
  state: string;
  activeAt?: string;
}

async function firingInstances(): Promise<AlertInstance[]> {
  const res = await fetch(`${GRAFANA_URL}/api/prometheus/grafana/api/v1/rules`, {
    headers: { Authorization: `Bearer ${GRAFANA_TOKEN}` },
  });
  if (!res.ok) throw new Error(`grafana rules -> ${res.status}`);
  const body = (await res.json()) as {
    data?: { groups?: { rules?: { name?: string; alerts?: AlertInstance[] }[] }[] };
  };
  const out: AlertInstance[] = [];
  for (const g of body.data?.groups ?? []) {
    for (const rule of g.rules ?? []) {
      if (!rule.name?.startsWith(ALERT_NAME)) continue;
      for (const a of rule.alerts ?? []) if (a.state === 'Alerting') out.push(a);
    }
  }
  return out;
}

/** One run per (device class, region) at a time; incidents are not re-entrant. */
const inFlight = new Set<string>();
let busy = false;

async function handle(instance: AlertInstance): Promise<void> {
  const labels = instance.labels ?? {};
  const key = `${labels.device_class ?? '?'}|${labels.region ?? '?'}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);

  const firedAt = instance.activeAt ? Date.parse(instance.activeAt) : Date.now();
  mttd.observe({}, Math.max(0, (Date.now() - firedAt) / 1000));

  const incident = Incident.parse({
    id: `inc-${Date.now()}`,
    channel: labels.channel ?? 'sports-1',
    region: labels.region ?? 'unknown',
    deviceClass: labels.device_class ?? 'unknown',
    startedAt: instance.activeAt ?? new Date().toISOString(),
    rrr: 0,
  });

  svc.log.warn('incident detected', {
    device_class: incident.deviceClass,
    region: incident.region,
  });

  try {
    const run = await runIncident(incident, (rec) => {
      stepDuration.observe({ step: rec.step, kind: rec.kind }, rec.durationMs / 1000);
      if (rec.model && rec.tokens) {
        tokensTotal.inc({ model: rec.model, step: rec.step, kind: 'input' }, rec.tokens.input);
        tokensTotal.inc({ model: rec.model, step: rec.step, kind: 'output' }, rec.tokens.output);
        costTotal.inc({ model: rec.model }, rec.costUsd ?? 0);
      }
    });

    saveRun(run);
    runTotal.inc({ trigger: run.trigger, outcome: run.outcome });
    if (run.runbookId) {
      remediationTotal.inc({
        runbook: run.runbookId,
        tier: run.tier ?? 'unknown',
        outcome: run.outcome,
      });
    }
    if (run.verifiedAt) {
      mttr.observe({}, (Date.parse(run.verifiedAt) - Date.parse(run.detectedAt)) / 1000);
    }
    svc.log.warn('run complete', {
      run_id: run.runId,
      outcome: run.outcome,
      failure_class: run.failureClass,
      recovered: run.recovered,
      cost_usd: Number(run.costUsd.toFixed(4)),
    });
  } catch (err) {
    svc.log.error('run threw', { err: String(err) });
    runTotal.inc({ trigger: 'grafana_alert', outcome: 'failed' });
  } finally {
    inFlight.delete(key);
  }
}

async function poll(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const alerting = await firingInstances();
    // De-duplicate to one incident per device class: an alert firing across
    // three regions for the same class is one fault, not three.
    const seen = new Set<string>();
    for (const a of alerting) {
      const dc = a.labels?.device_class ?? '?';
      if (seen.has(dc)) continue;
      seen.add(dc);
      await handle(a);
    }
  } catch (err) {
    svc.log.warn('alert poll failed', { err: String(err) });
  } finally {
    busy = false;
  }
}

if (process.env.AGENT_POLL !== 'off') setInterval(() => void poll(), POLL_MS);

// ---- endpoints ------------------------------------------------------------

/** What a hosted Grafana would call instead of us polling it. */
svc.app.post('/alert', (req, res) => {
  const alerts = (req.body?.alerts ?? []) as { labels?: Record<string, string> }[];
  for (const a of alerts) void handle({ labels: a.labels ?? {}, state: 'Alerting' });
  res.json({ accepted: alerts.length });
});

svc.app.get('/runs', (_req, res) => res.json(listRuns()));
svc.app.get('/runs/:id', (req, res) => {
  const run = listRuns().find((r) => r.runId === req.params.id);
  if (!run) return res.status(404).json({ error: 'no such run' });
  res.json(run);
});

svc.app.get('/trace', (_req, res) => res.type('html').send(renderRunList(listRuns())));
svc.app.get('/trace/:id', (req, res) => {
  const run = listRuns().find((r) => r.runId === req.params.id);
  if (!run) return res.status(404).type('html').send('<p>no such run</p>');
  res.type('html').send(renderRun(run));
});

svc.log.info('agent started', { pollMs: POLL_MS, runDir: RUN_DIR });
svc.start(Number(process.env.PORT ?? 3000));
