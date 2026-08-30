// The AdBreak agent: watches the revenue SLO, and when it breaks, diagnoses
// and repairs it without waiting for a human.
import { startTracing } from '@adbreak/shared';
startTracing('agent');

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createService } from '@adbreak/shared';
import { Incident } from './schemas.js';
import { approveRun, runIncident, type AgentRun } from './run.js';
import { scalar } from './tools/grafana.js';
import { impressionGap } from './tools/metrics.js';
import { renderRunList, renderRun } from './trace-ui.js';
import { Supervisor, historyFrom } from './watchdog.js';
import { Router } from 'express';

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
const watchdogInterventions = svc.counter({
  name: 'adbreak_agent_watchdog_intervention_total',
  help: 'Runs terminated by the watchdog, by reason',
  labels: ['reason'] as const,
});
const mttr = svc.histogram({
  name: 'adbreak_agent_mttr_seconds',
  help: 'Detection to verified recovery',
  labels: [] as const,
  buckets: [30, 60, 90, 120, 180, 300, 600],
});

// ---- agent-side chaos -----------------------------------------------------
// The plant has a chaos injector; so does the agent. Breaking the agent on
// purpose is the only honest way to show its own supervisor catching it.
const agentChaos: { mode: 'off' | 'stall' | 'loop' | 'cost'; step?: string } = { mode: 'off' };

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
/**
 * After a successful remediation, hold off on that device class for a while.
 * The rate windows that detect a leak still contain the leak for minutes after
 * it stops, so without this the agent re-opens an incident it just closed.
 */
const remediatedUntil = new Map<string, number>();
const COOLDOWN_MS = Number(process.env.REMEDIATION_COOLDOWN_MS ?? 10 * 60_000);
let busy = false;

async function handle(instance: AlertInstance): Promise<void> {
  const labels = instance.labels ?? {};
  const key = `${labels.device_class ?? '?'}|${labels.region ?? '?'}`;
  if (inFlight.has(key)) return;

  // The SLO alert is computed over 15 minutes, so it keeps firing long after a
  // fault is fixed. Acting on a lagging alert would make the agent remediate
  // the same incident over and over. Confirm the leak is still happening right
  // now, on a short window, before doing anything about it.
  const deviceClass = labels.device_class ?? 'unknown';
  const until = remediatedUntil.get(deviceClass) ?? 0;
  if (Date.now() < until) {
    svc.log.info('within the cooldown of a successful remediation, standing down', {
      device_class: deviceClass,
      cooldown_ends: new Date(until).toISOString(),
    });
    return;
  }

  // 4m, not 3m. The gap must be read over a whole number of 120s break
  // cadences or it is unusable: measured on a healthy plant, 3m ranged 0.759
  // across seven samples while 4m ranged 0.009. This guard was left on 3m when
  // the other windows were aligned, so the agent's decision to engage at all
  // was riding on the noisiest measurement in the system - and a real F07 was
  // waved through as "the leak has stopped".
  const liveGap = await scalar(impressionGap(deviceClass, '4m'));
  if (liveGap === null || liveGap < 0.2) {
    svc.log.info('alert still firing but the leak has stopped, standing down', {
      device_class: deviceClass,
      live_gap: liveGap,
    });
    return;
  }

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
    const supervisor = new Supervisor(historyFrom(listRuns()), undefined, (reason, detail) => {
      watchdogInterventions.inc({ reason });
      svc.log.error('watchdog terminated the run', { reason, detail });
    });

    const run = await runIncident(
      incident,
      (rec) => {
        stepDuration.observe({ step: rec.step, kind: rec.kind }, rec.durationMs / 1000);
        if (rec.model && rec.tokens) {
          tokensTotal.inc({ model: rec.model, step: rec.step, kind: 'input' }, rec.tokens.input);
          tokensTotal.inc({ model: rec.model, step: rec.step, kind: 'output' }, rec.tokens.output);
          costTotal.inc({ model: rec.model }, rec.costUsd ?? 0);
        }
      },
      supervisor,
      agentChaos,
    );

    saveRun(run);
    runTotal.inc({ trigger: run.trigger, outcome: run.outcome });
    if (run.runbookId) {
      remediationTotal.inc({
        runbook: run.runbookId,
        tier: run.tier ?? 'unknown',
        outcome: run.outcome,
      });
    }
    if (run.outcome === 'remediated') {
      remediatedUntil.set(incident.deviceClass, Date.now() + COOLDOWN_MS);
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

/**
 * Autonomous polling can be paused at runtime.
 *
 * Not a demo cheat - Gate C proves the polling path end to end, and it stays on
 * everywhere else. But the SLO alert is windowed over 15 minutes, so it keeps
 * firing long after a fault clears, and the poller then opens runs every 15
 * seconds that consume the post-remediation cooldown. A harness testing the
 * safety machinery cannot tell its own alert apart from that traffic: Gate D
 * spent three runs reporting "no run" for scenarios whose alerts the agent had
 * quite correctly stood down from.
 */
let pollingEnabled = process.env.AGENT_POLL !== 'off';

async function poll(): Promise<void> {
  if (!pollingEnabled || busy) return;
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

setInterval(() => void poll(), POLL_MS);

// ---- endpoints ------------------------------------------------------------

/** What a hosted Grafana would call instead of us polling it. */
svc.app.post('/alert', (req, res) => {
  const alerts = (req.body?.alerts ?? []) as { labels?: Record<string, string> }[];
  for (const a of alerts) void handle({ labels: a.labels ?? {}, state: 'Alerting' });
  res.json({ accepted: alerts.length });
});

const admin = Router();
/**
 * Clear post-remediation suppression. An operator needs this when a fault
 * recurs inside the cooldown and they want the agent to look again; the eval
 * harness needs it so back-to-back scenarios are not silently skipped.
 */
admin.delete('/cooldown', (_req, res) => {
  const cleared = remediatedUntil.size;
  remediatedUntil.clear();
  svc.log.warn('remediation cooldown cleared', { cleared });
  res.json({ cleared });
});
admin.get('/cooldown', (_req, res) =>
  res.json(
    Object.fromEntries([...remediatedUntil].map(([k, v]) => [k, new Date(v).toISOString()])),
  ),
);
admin.get('/polling', (_req, res) => res.json({ enabled: pollingEnabled }));
admin.post('/polling', (req, res) => {
  pollingEnabled = req.body?.enabled !== false;
  svc.log.warn('autonomous polling toggled', { enabled: pollingEnabled });
  res.json({ enabled: pollingEnabled });
});

admin.get('/agent-chaos', (_req, res) => res.json(agentChaos));
admin.post('/agent-chaos', (req, res) => {
  const mode = req.body?.mode;
  if (!['off', 'stall', 'loop', 'cost'].includes(mode)) {
    res.status(400).json({ error: 'mode must be off|stall|loop|cost' });
    return;
  }
  agentChaos.mode = mode;
  agentChaos.step = req.body?.step;
  svc.log.warn('agent chaos armed', { ...agentChaos });
  res.json(agentChaos);
});
svc.admin(admin);

svc.app.get('/runs', (_req, res) => res.json(listRuns()));
svc.app.get('/runs/:id', (req, res) => {
  const run = listRuns().find((r) => r.runId === req.params.id);
  if (!run) return res.status(404).json({ error: 'no such run' });
  res.json(run);
});

/**
 * Approve a plan the gate held for a human.
 *
 * Deliberately not on the admin router: approving a T2 remediation is an
 * operator action on a specific incident, not a chaos/debug control, and the
 * demo shows a human clicking it on the run's own trace page.
 */
svc.app.post('/runs/:id/approve', async (req, res) => {
  const run = listRuns().find((r) => r.runId === req.params.id);
  if (!run) return res.status(404).json({ error: 'no such run' });

  const approvedBy = String(
    (req.body as { approved_by?: string } | undefined)?.approved_by ?? 'operator',
  );
  svc.log.info('approval received', { run_id: run.runId, approved_by: approvedBy });

  const result = await approveRun(run, approvedBy);
  saveRun(result.run);
  remediationTotal.inc({
    runbook: result.run.runbookId ?? 'none',
    tier: result.run.tier ?? 'none',
    outcome: result.run.outcome === 'remediated' ? 'approved_remediated' : result.run.outcome,
  });
  if (result.run.verifiedAt) {
    mttr.observe({}, (Date.parse(result.run.verifiedAt) - Date.parse(result.run.detectedAt)) / 1000);
  }
  // A refusal on stale preconditions is a correct outcome, not a server error.
  res.status(result.ok ? 200 : 409).json({
    ok: result.ok,
    reason: result.reason,
    outcome: result.run.outcome,
    recovered: result.run.recovered ?? false,
  });
});

/** The form target behind the Approve button on a run's trace page. */
svc.app.post('/trace/:id/approve', async (req, res) => {
  const run = listRuns().find((r) => r.runId === req.params.id);
  if (!run) return res.status(404).type('html').send('<p>no such run</p>');
  const result = await approveRun(run, 'operator (trace UI)');
  saveRun(result.run);
  remediationTotal.inc({
    runbook: result.run.runbookId ?? 'none',
    tier: result.run.tier ?? 'none',
    outcome: result.run.outcome === 'remediated' ? 'approved_remediated' : result.run.outcome,
  });
  res.redirect(`/trace/${run.runId}`);
});

svc.app.get('/trace', (_req, res) => res.type('html').send(renderRunList(listRuns())));
svc.app.get('/trace/:id', (req, res) => {
  const run = listRuns().find((r) => r.runId === req.params.id);
  if (!run) return res.status(404).type('html').send('<p>no such run</p>');
  res.type('html').send(renderRun(run));
});

svc.log.info('agent started', { pollMs: POLL_MS, runDir: RUN_DIR });
svc.start(Number(process.env.PORT ?? 3000));
