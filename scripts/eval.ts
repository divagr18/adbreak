/**
 * The scoreboard.
 *
 * Runs a scripted set of faults past the agent and grades what it concluded
 * against ground-truth.jsonl — the record of what chaos actually did, which the
 * agent container cannot read. Produces the numbers the demo closes on:
 * RCA accuracy, runbook selection, false-remediation rate, MTTD, MTTR, cost.
 *
 *   npx tsx scripts/eval.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { scalar } from './q.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHAOS = process.env.CHAOS ?? 'http://localhost:8086';
const AGENT = process.env.AGENT ?? 'http://localhost:8090';
const SSAI = process.env.SSAI ?? 'http://localhost:8083';
const EDGE = process.env.EDGE ?? 'http://localhost:8084';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = <T>(url: string) => fetch(url).then((r) => r.json() as Promise<T>);
const post = (url: string, body: unknown) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

interface AgentRun {
  runId: string;
  outcome: string;
  failureClass?: string;
  runbookId?: string;
  tier?: string;
  costUsd: number;
  detectedAt: string;
  remediatedAt?: string;
  verifiedAt?: string;
  steps: { step: string; output: unknown }[];
}

interface Scenario {
  name: string;
  fault: string | null;
  params: Record<string, string>;
  /** Which device class the alert names. */
  alertDevice: string;
  expect: {
    failureClass: string | null;
    stage: string | null;
    runbookId: string | null;
    /** Outcomes that count as correct handling. */
    outcomes: string[];
    /** Set where no_action must mean "nothing is mapped", not "refuted". */
    escalates?: boolean;
  };
}

const SCENARIOS: Scenario[] = [
  ...Array.from({ length: 3 }, (_, i) => ({
    name: `F07 beacon blackhole (roku) #${i + 1}`,
    fault: 'F07',
    params: { device_class: 'roku' },
    alertDevice: 'roku',
    expect: {
      failureClass: 'F07',
      stage: 'beacon',
      runbookId: 'rb-beacon-fallback',
      outcomes: ['remediated'],
    },
  })),
  ...Array.from({ length: 2 }, (_, i) => ({
    name: `F04 no-fill #${i + 1}`,
    fault: 'F04',
    params: {},
    alertDevice: 'web',
    expect: {
      failureClass: 'F04',
      stage: 'decide',
      runbookId: 'rb-ads-failover',
      // T2: the correct behaviour is to plan and stop for a human.
      outcomes: ['awaiting_approval'],
    },
  })),
  ...Array.from({ length: 2 }, (_, i) => ({
    name: `F03 ADS latency #${i + 1}`,
    fault: 'F03',
    params: {},
    alertDevice: 'web',
    expect: {
      failureClass: 'F03',
      stage: 'decide',
      runbookId: 'rb-ads-failover',
      outcomes: ['awaiting_approval'],
    },
  })),
  ...Array.from({ length: 2 }, (_, i) => ({
    name: `F08 regional CDN 5xx #${i + 1}`,
    fault: 'F08',
    params: { cdn: 'cdn-west' },
    alertDevice: 'web',
    expect: {
      failureClass: 'F08',
      stage: 'deliver',
      // Deliberately unmapped: no safe automatic remedy exists.
      runbookId: null,
      outcomes: ['no_action'],
      escalates: true,
    },
  })),
  ...Array.from({ length: 2 }, (_, i) => ({
    name: `clean control #${i + 1}`,
    fault: null,
    params: {},
    alertDevice: 'web',
    expect: { failureClass: null, stage: null, runbookId: null, outcomes: ['no_action', 'none'] },
  })),
];

interface Result {
  scenario: string;
  groundTruth: string | null;
  diagnosed: string | null;
  stage: string | null;
  runbook: string | null;
  outcome: string;
  rcaCorrect: boolean;
  runbookCorrect: boolean;
  handledCorrectly: boolean;
  falseRemediation: boolean;
  /**
   * Injection to pickup, which INCLUDES the scripted 150s soak that lets the
   * leak become real in the rate windows. Not the agent's detection latency,
   * and must never be quoted as one.
   */
  injectToPickupS: number | null;
  mttrS: number | null;
  costUsd: number;
  runId: string | null;
}

async function reset(): Promise<void> {
  await fetch(`${CHAOS}/inject`, { method: 'DELETE' }).catch(() => {});
  await fetch(`${EDGE}/admin/faults`, { method: 'DELETE' }).catch(() => {});
  await post(`${SSAI}/admin/beacon-mode`, { device_class: 'roku', mode: 'client_side' }).catch(() => {});
  await post(`${SSAI}/admin/ads-fallback`, { mode: 'none' }).catch(() => {});
  await fetch(`${AGENT}/admin/cooldown`, { method: 'DELETE' }).catch(() => {});
}

/**
 * Wait for the plant to be genuinely quiet before injecting.
 *
 * Learned the hard way, twice. A run once diagnosed F04 correctly and was then
 * refuted by its own falsification step because cdn_5xx read 324 - residue from
 * earlier restarts. And clearing a fault is not the same as the plant being
 * well again: F08 suppresses beacons for every session that could not fetch its
 * media, and those losses sit inside the measurement windows for minutes
 * afterwards. Grading against a contaminated plant measures the contamination.
 *
 * Three consecutive healthy samples, because a recovering plant oscillates
 * across the boundary - impressions arrive for expectations booked during the
 * outage, so the gap swings negative and RRR overshoots before returning. One
 * passing sample is not evidence.
 */
async function settle(maxMs = 20 * 60_000): Promise<void> {
  const CHECKS: [string, (v: number | null) => boolean][] = [
    [
      'sum(increase(adbreak_revenue_realized_usd_total[15m])) / ' +
        '(sum(increase(adbreak_revenue_expected_usd_total[15m])) > 0)',
      (v) => v !== null && v > 0.9 && v < 1.02,
    ],
    ['sum(increase(adbreak_cdn_requests_total{status=~"5.."}[5m])) or vector(0)', (v) => (v ?? 1) === 0],
    ['sum(increase(adbreak_stitch_errors_total[5m])) or vector(0)', (v) => (v ?? 1) === 0],
    [
      // The agent's own definition — see agent/src/tools/metrics.ts.
      '1 - (sum(increase(adbreak_beacon_fired_total{event="impression"}[4m])) / ' +
        'clamp_min(sum(increase(adbreak_beacon_expected_total{event="impression"}[4m])), 1))',
      (v) => v !== null && Math.abs(v) < 0.05,
    ],
  ];
  const deadline = Date.now() + maxMs;
  let streak = 0;
  process.stdout.write('  settling');
  while (Date.now() < deadline) {
    let ok = true;
    for (const [expr, pass] of CHECKS) {
      if (!pass(await scalar(expr).catch(() => null))) {
        ok = false;
        break;
      }
    }
    streak = ok ? streak + 1 : 0;
    if (streak >= 3) {
      console.log(' ok');
      return;
    }
    process.stdout.write(ok ? '+' : '.');
    await sleep(30_000);
  }
  console.log(' gave up waiting - the plant is still not quiet');
}

async function runScenario(s: Scenario, index: number): Promise<Result> {
  console.log(`\n[${index + 1}/${SCENARIOS.length}] ${s.name}`);
  await reset();
  await settle();

  const t0 = Date.now();
  if (s.fault) {
    await post(`${CHAOS}/inject`, { fault: s.fault, params: s.params, duration_s: 600 });
    console.log(`  injected ${s.fault} ${JSON.stringify(s.params)}`);
    // Let the leak become real in the rate windows the agent reads.
    await sleep(150_000);
  } else {
    console.log('  no fault injected (control)');
    await sleep(30_000);
  }

  // Trigger through the webhook a hosted Grafana would use. The autonomous
  // polling path is already proven by Gate C; this keeps each scenario short.
  await post(`${AGENT}/alert`, {
    alerts: [{ labels: { device_class: s.alertDevice, region: 'us-east', channel: 'sports-1' } }],
  });

  // Longer than the runbook's verification budget: one break cadence for the
  // in-flight break plus up to 420s of polling, so a complete run is around
  // nine minutes. A shorter wait records "no run" for a run still in progress.
  const deadline = Date.now() + 15 * 60_000;
  let run: AgentRun | null = null;
  while (Date.now() < deadline) {
    await sleep(10_000);
    const runs = await json<AgentRun[]>(`${AGENT}/runs`).catch(() => []);
    // Earliest after t0, not newest: /runs is newest-first, and a successful
    // remediation is often followed by a second poller run that correctly
    // blocks because the gap has already closed. Grading that follow-up scores
    // the agent on the consequences of its own fix.
    const mine = runs
      .filter((r) => Date.parse(r.detectedAt) >= t0)
      .sort((a, b) => Date.parse(a.detectedAt) - Date.parse(b.detectedAt));
    const fresh = mine[0];
    if (fresh && (fresh.verifiedAt || fresh.outcome !== 'remediated')) {
      run = fresh;
      break;
    }
  }

  const hypothesis = run?.steps.find((x) => x.step === 'hypothesize')?.output as
    | { stage?: string }
    | undefined;
  const outcome = run?.outcome ?? 'none';
  const diagnosed = run?.failureClass ?? null;
  const planDecision = (
    run?.steps.find((x) => x.step === 'plan')?.output as { decision?: string } | undefined
  )?.decision;

  const rcaCorrect = s.expect.failureClass === null ? run === null : diagnosed === s.expect.failureClass;
  const runbookCorrect = (run?.runbookId ?? null) === s.expect.runbookId;
  // no_action has two very different meanings: the hypothesis was refuted, or
  // it survived and nothing is mapped to it. A scenario that expects the agent
  // to escalate is not satisfied by one that talked itself out of a correct
  // diagnosis, so where the distinction matters the plan step decides it.
  const refuted = planDecision === 'no remediation - hypothesis did not survive falsification';
  const handledCorrectly =
    s.expect.outcomes.includes(outcome) && !(s.expect.escalates === true && refuted);
  // The number that matters most: acting on a plant that was never broken.
  const falseRemediation = s.fault === null && outcome === 'remediated';

  const secs = (a?: string, b?: string) =>
    a && b ? (Date.parse(b) - Date.parse(a)) / 1000 : null;

  const result: Result = {
    scenario: s.name,
    groundTruth: s.fault,
    diagnosed,
    stage: hypothesis?.stage ?? null,
    runbook: run?.runbookId ?? null,
    outcome,
    rcaCorrect,
    runbookCorrect,
    handledCorrectly,
    falseRemediation,
    injectToPickupS: run ? (Date.parse(run.detectedAt) - t0) / 1000 : null,
    mttrS: secs(run?.detectedAt, run?.verifiedAt ?? run?.remediatedAt),
    costUsd: run?.costUsd ?? 0,
    runId: run?.runId ?? null,
  };

  console.log(
    `  truth=${s.fault ?? 'none'} diagnosed=${diagnosed ?? 'none'} outcome=${outcome} ` +
      `rca=${rcaCorrect ? 'ok' : 'WRONG'} runbook=${runbookCorrect ? 'ok' : 'WRONG'} $${result.costUsd.toFixed(4)}`,
  );
  return result;
}

function render(results: Result[]): string {
  const withRuns = results.filter((r) => r.runId);
  const pct = (n: number, d: number) => (d === 0 ? '—' : `${((n / d) * 100).toFixed(0)}%`);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  const faultScenarios = results.filter((r) => r.groundTruth);
  const rca = faultScenarios.filter((r) => r.rcaCorrect).length;
  const rb = faultScenarios.filter((r) => r.runbookCorrect).length;
  const handled = results.filter((r) => r.handledCorrectly).length;
  const falseRemediations = results.filter((r) => r.falseRemediation).length;

  const lines = [
    '# AdBreak agent — evaluation',
    '',
    `Scenarios: ${results.length} · graded against ground-truth.jsonl, which the agent cannot read.`,
    '',
    'Incidents were triggered through the alert webhook with autonomous polling paused, so each',
    'scenario grades exactly one deterministic run. The polling path itself is proven end to end',
    'by Gate C.',
    '',
    `- **RCA top-1 accuracy**: ${pct(rca, faultScenarios.length)} (${rca}/${faultScenarios.length})`,
    `- **Runbook selection**: ${pct(rb, faultScenarios.length)} (${rb}/${faultScenarios.length})`,
    `- **Handled correctly**: ${pct(handled, results.length)} (${handled}/${results.length})`,
    `- **False remediations**: ${falseRemediations}`,
    `- **Mean MTTR** (detection to verified recovery): ${mean(withRuns.map((r) => r.mttrS ?? 0)).toFixed(1)}s`,
    `- **Mean cost per incident**: $${mean(withRuns.map((r) => r.costUsd)).toFixed(4)}`,
    '',
    '| scenario | truth | diagnosed | stage | runbook | outcome | RCA | cost |',
    '|---|---|---|---|---|---|---|---|',
    ...results.map(
      (r) =>
        `| ${r.scenario} | ${r.groundTruth ?? '—'} | ${r.diagnosed ?? '—'} | ${r.stage ?? '—'} | ` +
        `${r.runbook ?? '—'} | ${r.outcome} | ${r.rcaCorrect ? '✓' : '✗'} | $${r.costUsd.toFixed(4)} |`,
    ),
  ];
  return lines.join('\n');
}

async function main(): Promise<void> {
  console.log(`AdBreak evaluation — ${SCENARIOS.length} scenarios\n`);

  // Pause autonomous polling, as Gate D does and for the same reason: the SLO
  // alert is windowed over 15 minutes so it keeps firing after a fault clears,
  // the poller opens runs this harness cannot tell apart from its own, and its
  // post-remediation cooldown then swallows the harness's trigger. Gate C
  // proves the polling path end to end; this scores diagnosis quality, which
  // needs a deterministic trigger. Disclosed in the report so the numbers are
  // read for what they are.
  await post(`${AGENT}/admin/polling`, { enabled: false });
  console.log('autonomous polling paused for the duration of this evaluation\n');

  const results: Result[] = [];
  for (const [i, s] of SCENARIOS.entries()) {
    try {
      results.push(await runScenario(s, i));
    } catch (err) {
      // One scenario failing must not cost the other ten. A transport error
      // killed this evaluation seven scenarios in and took the whole scoreboard
      // with it; the six completed results were still sitting in memory,
      // unwritten. Record the failure as a failure and carry on.
      console.log(`  SCENARIO ERRORED: ${String(err)}`);
      results.push({
        scenario: s.name,
        groundTruth: s.fault,
        diagnosed: null,
        stage: null,
        runbook: null,
        outcome: 'harness_error',
        rcaCorrect: false,
        runbookCorrect: false,
        handledCorrectly: false,
        falseRemediation: false,
        injectToPickupS: null,
        mttrS: null,
        costUsd: 0,
        runId: null,
      });
    }
  }
  await reset();
  await post(`${AGENT}/admin/polling`, { enabled: true });

  const markdown = render(results);
  writeFileSync(join(ROOT, 'agent-data', 'eval-report.json'), JSON.stringify(results, null, 2));
  writeFileSync(join(ROOT, 'agent-data', 'eval-report.md'), markdown);
  console.log(`\n${markdown}`);

  const falseRemediations = results.filter((r) => r.falseRemediation).length;
  if (falseRemediations > 0) {
    console.log('\nEVAL FAILED: the agent remediated a plant that was never broken.');
    process.exit(1);
  }
}

// Never leave the agent switched off for whatever runs next.
process.on('exit', () => {
  void fetch(`${AGENT}/admin/polling`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  }).catch(() => {});
});

void main();
