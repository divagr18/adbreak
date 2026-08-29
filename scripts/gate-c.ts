/**
 * Gate C: the submission.
 *
 * Inject a fault without telling the agent, then check that it detected,
 * diagnosed, remediated, verified and documented it on its own — and grade the
 * diagnosis against ground-truth.jsonl, which the agent has no access to.
 *
 *   npx tsx scripts/gate-c.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHAOS = process.env.CHAOS ?? 'http://localhost:8086';
const AGENT = process.env.AGENT ?? 'http://localhost:8090';
const SSAI = process.env.SSAI ?? 'http://localhost:8083';
const COLLECTOR = process.env.COLLECTOR ?? 'http://localhost:8085';
const GROUND_TRUTH = join(ROOT, 'data', 'ground-truth.jsonl');
const VICTIM = process.env.VICTIM ?? 'roku';

function env(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}
const E = env();

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = <T>(url: string) => fetch(url).then((r) => r.json() as Promise<T>);

interface AgentRun {
  runId: string;
  outcome: string;
  failureClass?: string;
  runbookId?: string;
  tier?: string;
  verdict?: string;
  recovered?: boolean;
  costUsd: number;
  detectedAt: string;
  remediatedAt?: string;
  verifiedAt?: string;
  postmortem?: string;
  cfoBrief?: string;
  incident: { deviceClass: string };
  steps: { step: string; output: unknown }[];
}

const secs = (a?: string, b?: string): number | null =>
  a && b ? (Date.parse(b) - Date.parse(a)) / 1000 : null;

/** The answer key. Only this script may read it — never the agent. */
function groundTruth(sinceMs: number): { fault: string; params: Record<string, string> } | null {
  try {
    const lines = readFileSync(GROUND_TRUTH, 'utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const rec = JSON.parse(lines[i]) as {
        ts: string;
        action: string;
        fault: string;
        params: Record<string, string>;
      };
      if (rec.action === 'inject' && Date.parse(rec.ts) >= sinceMs) {
        return { fault: rec.fault, params: rec.params };
      }
    }
  } catch {
    /* no ground truth yet */
  }
  return null;
}

async function annotationsSince(sinceMs: number): Promise<{ text: string; tags: string[] }[]> {
  const base = (E.GRAFANA_URL ?? '').replace(/\/$/, '');
  const res = await fetch(`${base}/api/annotations?from=${sinceMs}&to=${Date.now()}&limit=100`, {
    headers: { Authorization: `Bearer ${E.GRAFANA_SERVICE_ACCOUNT_TOKEN}` },
  });
  if (!res.ok) return [];
  return (await res.json()) as { text: string; tags: string[] }[];
}

async function waitForRun(afterMs: number, timeoutMs: number): Promise<AgentRun | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = await json<AgentRun[]>(`${AGENT}/runs`).catch(() => []);
    const fresh = runs.find((r) => Date.parse(r.detectedAt) >= afterMs);
    if (fresh && (fresh.verifiedAt || fresh.outcome !== 'remediated')) return fresh;
    await sleep(10_000);
  }
  return null;
}

async function reset(): Promise<void> {
  await fetch(`${CHAOS}/inject`, { method: 'DELETE' }).catch(() => {});
  await fetch(`${SSAI}/admin/beacon-mode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_class: VICTIM, mode: 'client_side' }),
  }).catch(() => {});
}

async function main(): Promise<void> {
  console.log('Gate C — the agent handles a live incident on its own.\n');
  await reset();

  // The agent suppresses a device class for 10 minutes after remediating it,
  // so a clean gate run needs that window to have elapsed.
  console.log('waiting out any remediation cooldown, then injecting...\n');
  await sleep(Number(process.env.PRE_WAIT_MS ?? 60_000));

  const t0 = Date.now();
  const injected = await fetch(`${CHAOS}/inject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fault: 'F07', params: { device_class: VICTIM }, duration_s: 1200 }),
  }).then((r) => r.json() as Promise<{ injectionId: number }>);
  console.log(`F07 injected on ${VICTIM} (injection ${injected.injectionId}). The agent has not been told.\n`);

  const run = await waitForRun(t0, 12 * 60_000);
  if (!run) {
    check('agent produced a run', false, 'no run appeared within 12 minutes');
    await reset();
    process.exit(1);
  }
  check('agent detected and ran autonomously', true, `run ${run.runId}, outcome ${run.outcome}`);

  // --- RCA graded against the answer key --------------------------------
  const truth = groundTruth(t0);
  const hypothesis = run.steps.find((s) => s.step === 'hypothesize')?.output as
    | { failureClass?: string; stage?: string; scope?: { deviceClass?: string | null } }
    | undefined;
  check(
    'root cause matches ground truth',
    truth?.fault === run.failureClass,
    `ground truth ${truth?.fault ?? '?'} vs diagnosed ${run.failureClass ?? '?'}`,
  );
  check(
    'fault localised to the right stage and device class',
    hypothesis?.stage === 'beacon' && hypothesis?.scope?.deviceClass === truth?.params?.device_class,
    `stage=${hypothesis?.stage}, device=${hypothesis?.scope?.deviceClass}, truth device=${truth?.params?.device_class}`,
  );

  // --- runbook selection and the policy gate ----------------------------
  check(
    'correct runbook selected by lookup table',
    run.runbookId === 'rb-beacon-fallback',
    `runbook ${run.runbookId ?? 'none'}`,
  );
  check(
    'blast radius classified T1 and auto-approved',
    run.tier === 'T1' && run.verdict === 'ALLOW',
    `tier ${run.tier}, verdict ${run.verdict}`,
  );
  const act = run.steps.find((s) => s.step === 'act')?.output as { executed?: boolean } | undefined;
  check('remediation actually executed', act?.executed === true, `act.executed=${act?.executed}`);

  // --- the outcome, not the action --------------------------------------
  check(
    'recovery verified against live telemetry',
    run.recovered === true && run.outcome === 'remediated',
    `recovered=${run.recovered}, outcome=${run.outcome}`,
  );
  const stillBlackholed = await json<{ id: number }[]>(`http://localhost:8084/admin/faults`).catch(
    () => [],
  );
  check(
    'revenue recovered while the fault was still injected',
    stillBlackholed.length > 0,
    `${stillBlackholed.length} edge fault(s) still active — the fix routed around it rather than removing it`,
  );

  // --- artifacts --------------------------------------------------------
  const anns = await annotationsSince(t0);
  const agentAnns = anns.filter((a) => (a.tags ?? []).includes('adbreak'));
  check(
    'wrote its audit trail back into Grafana',
    agentAnns.length >= 2,
    `${agentAnns.length} annotations, incl. the plan posted before the change`,
  );
  check(
    'produced a postmortem and a CFO brief',
    Boolean(run.postmortem && run.postmortem.length > 50 && run.cfoBrief && run.cfoBrief.length > 30),
    `postmortem ${run.postmortem?.length ?? 0} chars, CFO brief ${run.cfoBrief?.length ?? 0} chars`,
  );

  // --- budget -----------------------------------------------------------
  const toRemediate = secs(run.detectedAt, run.remediatedAt);
  const toVerified = secs(run.detectedAt, run.verifiedAt);
  check(
    'detect to remediate under 90s',
    toRemediate !== null && toRemediate < 90,
    `${toRemediate?.toFixed(1)}s`,
  );
  check(
    'detect to verified recovery under 150s',
    toVerified !== null && toVerified < 150,
    `${toVerified?.toFixed(1)}s`,
  );
  check('cost under $0.25 per incident', run.costUsd < 0.25, `$${run.costUsd.toFixed(4)}`);

  // --- the clean control ------------------------------------------------
  console.log('\nclearing the fault and watching a healthy plant for false remediations...\n');
  await reset();
  const controlStart = Date.now();
  await sleep(Number(process.env.CONTROL_MS ?? 4 * 60_000));
  const after = await json<AgentRun[]>(`${AGENT}/runs`).catch(() => [] as AgentRun[]);
  const falseRemediations = after.filter(
    (r) => Date.parse(r.detectedAt) >= controlStart && r.outcome === 'remediated',
  );
  check(
    'no false remediation on a healthy plant',
    falseRemediations.length === 0,
    `${falseRemediations.length} remediation(s) during the control window`,
  );

  await reset();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  console.log(
    `\nMTTD→remediate ${toRemediate?.toFixed(1)}s · →verified ${toVerified?.toFixed(1)}s · $${run.costUsd.toFixed(4)} per incident`,
  );
  if (failed.length) {
    console.log('GATE C: FAILED');
    process.exit(1);
  }
  console.log('GATE C: PASSED — the agent detected, diagnosed, repaired and documented it alone.');
}

void main();
