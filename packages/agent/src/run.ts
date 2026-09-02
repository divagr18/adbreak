/**
 * The workflow.
 *
 * Read this file top to bottom and you can see exactly what the agent will do,
 * in what order, under what conditions. That is the point: the control flow is
 * code, not model output. The LLM fills in reasoning *inside* steps 2-5 and 9;
 * it never chooses the next step, never picks the runbook, and never decides
 * whether it is allowed to act.
 */
import { randomUUID } from 'node:crypto';
import {
  Documentation,
  Evidence,
  Falsification,
  Hypothesis,
  Triage,
  type Incident,
} from './schemas.js';
import { FLASH, PRO, runStep, type StepUsage } from './llm.js';
import * as M from './tools/metrics.js';
import { createAnnotation, createIncident, queryPrometheus, scalar } from './tools/grafana.js';
import { RUNBOOK_FOR, execute, loadRunbooks, substitute, type Runbook } from './tools/runbook.js';
import { classify, gate, type Tier, type Verdict } from './policy/blast-radius.js';
import { Supervisor, WatchdogKill } from './watchdog.js';

export interface StepRecord {
  step: string;
  kind: 'code' | 'llm';
  startedAt: string;
  durationMs: number;
  model?: string;
  tokens?: { input: number; output: number };
  costUsd?: number;
  queries?: string[];
  output: unknown;
}

export interface AgentRun {
  runId: string;
  trigger: string;
  incident: Incident;
  steps: StepRecord[];
  outcome:
    | 'remediated'
    | 'awaiting_approval'
    | 'blocked'
    /** Approved by a human, but the plant had moved on and the plan no longer applied. */
    | 'blocked_on_approval'
    | 'no_action'
    | 'failed'
    | 'killed_by_watchdog';
  /** Set when the watchdog terminated this run. */
  watchdog?: { reason: string; detail: string };
  failureClass?: string;
  runbookId?: string;
  tier?: Tier;
  verdict?: Verdict;
  recovered?: boolean;
  costUsd: number;
  detectedAt: string;
  remediatedAt?: string;
  verifiedAt?: string;
  approvedAt?: string;
  approvedBy?: string;
  postmortem?: string;
  cfoBrief?: string;
  error?: string;
}

const runbooks = loadRunbooks();

/**
 * How each runbook precondition is actually measured. Runbooks state their
 * preconditions in shorthand; this is where that shorthand becomes PromQL and
 * a threshold. An id with no entry here fails closed.
 */
const PRECONDITIONS: Record<
  string,
  { query: (device: string, window: string) => string; met: (v: number | null) => boolean }
> = {
  gap_is_real: {
    query: (device, window) => M.impressionGap(device, window),
    met: (v) => (v ?? 0) > 0.4,
  },
  scoped_not_global: {
    // The others' gap RELATIVE to the affected one, not its absolute value.
    // An in-flight break lifts every slice together, so an absolute threshold
    // reads a healthy slice at 0.25 and blocks a correct remediation whose own
    // gap is 1.0. A ratio cancels that common-mode lift. Below 0.4 means the
    // affected class is losing impressions at more than twice the rate of
    // everything else, which is what "scoped" actually means.
    query: (device, window) => M.gapScopeRatio(device, window),
    met: (v) => v !== null && v < 0.4,
  },
  fill_collapsed: {
    // No-fill rate, not the pod-seconds ratio: the latter reads 0.875 on a
    // healthy plant, so thresholding it would have been an accident waiting.
    //
    // 0.25, not 0.5. The healthy baseline is exactly 0.000 - no ad request on a
    // well plant ever returns an empty VAST - so a quarter of all requests
    // coming back empty is already an unambiguous collapse and cannot happen by
    // accident. Demanding half also raced the measurement: the rate is computed
    // over 5m, so a TOTAL no-fill only reads 0.5 after two and a half minutes,
    // and a run that evaluated at exactly 0.5 was blocked by `> 0.5`.
    // The STITCHER's unfilled rate, not the ad server's no-fill rate. The
    // runbook applies to F03 as well as F04, and on a latency spike the ad
    // server answers every request - its no-fill counter never moves, while
    // every avail still goes out empty because the answers arrive after the
    // manifest deadline. Keying off the ad server would have blocked this
    // runbook on exactly half the faults it declares itself good for.
    query: () => M.availUnfilledRate(),
    met: (v) => (v ?? 0) > 0.25,
  },
  fallback_available: {
    query: () => M.adsFallbackReady(),
    met: (v) => (v ?? 0) >= 1,
  },
  delivery_healthy: {
    query: (_d, window) => M.cdn5xx(window),
    met: (v) => (v ?? 1) === 0,
  },
};

/**
 * How each runbook's success is measured.
 *
 * Both are expressed as a ratio of counter DELTAS taken since the remediation
 * landed, not as a sliding window. A window wide enough to be stable still
 * contains the incident, so it cannot show recovery until the faulty break
 * ages out of it - which made verification depend on whether the fix happened
 * to land mid-break. Deltas ask the only question that matters: of the
 * impressions expected since the fix, how many arrived?
 */
const VERIFICATION: Record<
  string,
  { numerator: (device: string) => string; denominator: (device: string) => string }
> = {
  'rb-beacon-fallback': {
    numerator: (device) => M.impressionsFired(device),
    denominator: (device) => M.impressionsExpected(device),
  },
  'rb-ads-failover': {
    // The cached pod bills like any other, so recovery reads the same way.
    numerator: () => M.impressionsFired(),
    denominator: () => M.impressionsExpected(),
  },
};

/** Expected impressions that must accrue post-fix before a verdict is credible. */
const MIN_SAMPLES = Number(process.env.VERIFY_MIN_SAMPLES ?? 20);

/**
 * How long one ad break cycle takes on this plant.
 *
 * Recovery cannot be observed faster than this, whatever the agent does: a fix
 * only proves itself on a break that runs entirely after it landed.
 */
const BREAK_CADENCE_MS = Number(process.env.BREAK_CADENCE_S ?? 120) * 1000;

/**
 * What the plant's numbers mean, stated once.
 *
 * Every step that reasons about metrics gets this same text. It used to live
 * only in the hypothesis prompt, so the falsification step was second-guessing
 * a diagnosis using a worse model of the metrics than the one that made it -
 * and twice killed a correct diagnosis on that basis: once reading a healthy
 * 0.875 pod-seconds ratio as "significant underfill", once reading a no-fill
 * rate that had climbed as a contradiction. Two prompts that disagree about
 * what a number means will disagree about what is wrong.
 */
const METRIC_SEMANTICS = [
  'Read the fill signals correctly, because they mean different things and only',
  'one of them is primary.',
  'avail_unfilled_rate is the share of ad breaks the STITCHER could not fill, by',
  'any cause. This is the primary evidence that inventory is going unsold, and it',
  'is the number to trust: it rises for an empty VAST and equally for a response',
  'that arrived after the manifest deadline.',
  'Once it is high, ads_latency_p99 says WHY. Normal latency with unfilled avails',
  'means the ad server returned nothing: F04. High latency with unfilled avails',
  'means it answered too late to use: F03. That pair is the discriminator.',
  'ads_nofill_rate corroborates F04 but must not be the deciding signal on its',
  'own - it is a windowed rate over a bursty counter and has been observed',
  'disagreeing with itself between steps of the same run.',
  'ads_pod_seconds_filled is pod seconds over avail seconds. It sits at about',
  '0.875 when everything is working, because a 28s pod fills a 32s avail. A value',
  'near 0.875 is NORMAL and is not evidence of any fault; only a sustained drop',
  'well below it with avail_unfilled_rate near zero indicates F09 duration',
  'underfill - pods that arrived, but short.',
  'Gauges and windowed rates are not comparable evidence early in an incident: a',
  'gauge bottoms out at once while a rate is still climbing, so a larger number is',
  'not automatically the stronger evidence.',
].join(' ');

const nowIso = () => new Date().toISOString();

export interface PreconditionResult {
  id: string;
  expr: string;
  promql: string | null;
  value: number | null;
  met: boolean;
  note?: string;
}

/**
 * Measure a runbook's preconditions against live telemetry.
 *
 * Shared by the autonomous path and the approval path on purpose. A plan is a
 * snapshot of a moment; by the time a human approves it the plant may have
 * moved, so approval re-measures rather than trusting what was recorded.
 */
export async function checkPreconditions(
  runbook: Runbook,
  vars: Record<string, string>,
): Promise<PreconditionResult[]> {
  const out: PreconditionResult[] = [];
  for (const p of runbook.preconditions) {
    const check = PRECONDITIONS[p.id];
    if (!check) {
      // Fail closed. A runbook naming a precondition this agent cannot
      // evaluate must not be executed on the assumption it would have passed.
      out.push({
        id: p.id,
        expr: substitute(p.expr, vars),
        promql: null,
        value: null,
        met: false,
        note: 'unknown precondition id - failing closed',
      });
      continue;
    }
    const promql = check.query(vars.device, p.window);
    const value = await scalar(promql);
    out.push({ id: p.id, expr: substitute(p.expr, vars), promql, value, met: check.met(value) });
  }
  return out;
}

export interface VerifyResult {
  recovered: boolean;
  residualGap: number | null;
  query: string;
  samples: { at: string; gap: number | null }[];
}

/** Poll live telemetry until recovery is observed or the runbook's budget runs out. */
export async function verifyRecovery(
  runbook: Runbook,
  device: string,
  supervisor?: Supervisor,
): Promise<VerifyResult> {
  const verifier = VERIFICATION[runbook.id] ?? {
    numerator: (d: string) => M.impressionsFired(d),
    denominator: (d: string) => M.impressionsExpected(d),
  };
  const numQuery = verifier.numerator(device);
  const denQuery = verifier.denominator(device);
  const query = `(${numQuery}) / (${denQuery})  [delta from the first whole break after remediation]`;

  // Let the break that was already in flight finish before baselining.
  //
  // A fix landing mid-break cannot repair that break: its expectations were
  // booked at the spot boundary and its impressions were already lost. Baseline
  // at the instant of the fix and those losses sit inside the delta forever, so
  // the ratio converges as 1/N - measured descending 1, 0.5, 0.33, 0.25 and
  // stalling there - and never reaches the recovery threshold. An earlier run
  // verified in 145s only because its fix happened to land between breaks.
  // Waiting one cadence makes the measurement independent of that coin flip.
  const deadline = Date.now() + runbook.verification.timeout_s * 1000;
  await new Promise((r) => setTimeout(r, BREAK_CADENCE_MS));
  supervisor?.assertAlive();

  const firedAtFix = (await scalar(numQuery)) ?? 0;
  const expectedAtFix = (await scalar(denQuery)) ?? 0;

  let residualGap: number | null = null;
  let recovered = false;
  const samples: { at: string; gap: number | null }[] = [];
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10_000));
    supervisor?.assertAlive();
    const dFired = ((await scalar(numQuery)) ?? 0) - firedAtFix;
    const dExpected = ((await scalar(denQuery)) ?? 0) - expectedAtFix;
    // Wait for enough post-fix inventory to judge on; a ratio over three
    // impressions is noise, not evidence.
    if (dExpected < MIN_SAMPLES) {
      samples.push({ at: nowIso(), gap: null });
      continue;
    }
    residualGap = 1 - dFired / dExpected;
    samples.push({ at: nowIso(), gap: residualGap });
    if (residualGap < 0.05) {
      recovered = true;
      break;
    }
  }
  return { recovered, residualGap, query, samples };
}

const usageFields = (u: StepUsage, costMultiplier = 1) => ({
  model: u.model,
  tokens: { input: u.inputTokens, output: u.outputTokens },
  costUsd: u.costUsd * costMultiplier,
});

/** Everything the model is allowed to see about the current state of the plant. */
async function snapshot(deviceClass: string): Promise<Record<string, unknown>> {
  const queries: Record<string, string> = {
    impression_gap_affected: M.impressionGap(deviceClass, '4m'),
    impression_gap_others: M.impressionGapOthers(deviceClass, '4m'),
    cdn_5xx: M.cdn5xx(),
    stitch_errors: M.stitchErrors(),
    ads_latency_p99: M.adsLatencyP99(),
    ads_pod_seconds_filled: M.adsFillRatio(),
    ads_nofill_rate: M.adsNoFillRate(),
    avail_unfilled_rate: M.availUnfilledRate(),
    signal_chain_divergence: M.availSignalChain(),
    revenue_leak_usd: M.revenueLeakUsd(),
  };
  const out: Record<string, unknown> = { _queries: queries };
  for (const [k, expr] of Object.entries(queries)) out[k] = await scalar(expr);
  return out;
}

export async function runIncident(
  incident: Incident,
  onStep?: (r: StepRecord) => void,
  supervisor?: Supervisor,
  chaos?: { mode: string; step?: string },
): Promise<AgentRun> {
  const run: AgentRun = {
    runId: randomUUID().slice(0, 8),
    trigger: 'grafana_alert',
    incident,
    steps: [],
    outcome: 'failed',
    costUsd: 0,
    detectedAt: nowIso(),
  };

  const step = (
    name: string,
    kind: 'code' | 'llm',
    startedAt: number,
    output: unknown,
    extra: Partial<StepRecord> = {},
  ): void => {
    const rec: StepRecord = {
      step: name,
      kind,
      startedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      output,
      ...extra,
    };
    run.steps.push(rec);
    run.costUsd += rec.costUsd ?? 0;
    onStep?.(rec);
    supervisor?.endStep(name, rec.costUsd ?? 0);
  };

  /**
   * Every step passes through here before doing any work. An aborted run then
   * stops at the next boundary even when the call already in flight cannot
   * itself be cancelled.
   */
  const begin = (name: string, declaredBudgetMs?: number): number => {
    supervisor?.assertAlive();
    supervisor?.beginStep(name, declaredBudgetMs);
    return Date.now();
  };

  /** Agent-side fault injection, so the watchdog can be seen doing its job. */
  const injectChaos = async (stepName: string): Promise<void> => {
    if (!chaos || chaos.mode === 'off') return;
    if (chaos.step && !stepName.startsWith(chaos.step)) return;
    if (chaos.mode === 'stall') {
      // Long enough to breach any stall budget; the watchdog fires while we wait.
      await new Promise((r) => setTimeout(r, 200_000));
    }
  };

  // Cost chaos inflates what each step reports, so the runaway rule trips.
  const costMul = chaos?.mode === 'cost' ? 500 : 1;

  try {
    // --- 2. Triage --------------------------------------------------------
    let t0 = begin('triage');
    await injectChaos('triage');
    const snap = await snapshot(incident.deviceClass);
    const triage = await runStep({
      name: 'triage',
      model: FLASH,
      schema: Triage,
      instruction: [
        'You are an SRE triaging a live revenue incident on a video ad-insertion pipeline.',
        'The SLO is revenue realization (realized/expected impressions), not uptime.',
        'Given the incident and a metric snapshot, classify severity and name the',
        'pipeline stages worth investigating. Stages: signal, package, decide,',
        'condition, stitch, deliver, play, beacon.',
        'Be precise about which dimensions look affected. Return JSON only.',
      ].join(' '),
      input: { incident, snapshot: snap },
    });
    step('triage', 'llm', t0, triage.output, {
      ...usageFields(triage.usage, costMul),
      queries: Object.values(snap._queries as Record<string, string>),
    });

    // --- 3. Correlate (parallel branches) ---------------------------------
    t0 = begin('correlate');
    await injectChaos('correlate');
    supervisor?.noteToolCall('query_prometheus', { expr: M.gapByDeviceCdn('4m') });
    const gapRows = await queryPrometheus(M.gapByDeviceCdn('4m'));
    if (chaos?.mode === 'loop') {
      // Re-issue the identical query so the loop rule has something to catch.
      for (let i = 0; i < 3; i++) {
        supervisor?.noteToolCall('query_prometheus', { expr: M.gapByDeviceCdn('4m') });
        supervisor?.assertAlive();
      }
    }
    // Name the field for what it means and state the direction. Handed a bare
    // "gap: 0.6", a model read it as an impression *gain* and concluded the
    // failing device class was the healthy one.
    const sliceTable = gapRows.map((r) => ({
      device_class: r.metric.device_class,
      cdn: r.metric.cdn,
      fraction_of_impressions_lost: Number(r.value.toFixed(4)),
    }));

    const [signalBranch, sliceBranch] = await Promise.all([
      runStep({
        name: 'correlate_signal_chain',
        model: FLASH,
        schema: Evidence,
        instruction: [
          'You are correlating the ad-insertion SIGNAL CHAIN for a revenue incident.',
          'Given metric values covering cue signalling, packaging, ad decisioning,',
          'stitching and delivery, state what the data shows and what it rules out.',
          'A healthy signal chain with a revenue loss points downstream, at billing.',
          'Set branch to "signal_chain". Return JSON only.',
        ].join(' '),
        input: { incident, snapshot: snap },
      }),
      runStep({
        name: 'correlate_dimensions',
        model: FLASH,
        schema: Evidence,
        instruction: [
          'You are localising a revenue incident across dimensions.',
          'Every value named fraction_of_impressions_lost is the share of billable impressions that never reached the collector: 0.0 means healthy, 1.0 means total loss. A HIGH value is BAD. ',
          'Given impression loss broken out by device class and CDN, identify exactly',
          'which slice is losing impressions and which are healthy. State whether the',
          'fault is scoped to a device class, a CDN, both, or neither.',
          'Set branch to "dimensional_slice". Return JSON only.',
        ].join(' '),
        input: { incident, gap_by_device_and_cdn: sliceTable },
      }),
    ]);
    const evidence = [signalBranch.output, sliceBranch.output];
    step('correlate:signal_chain', 'llm', t0, signalBranch.output, {
      ...usageFields(signalBranch.usage, costMul),
      queries: [M.availSignalChain(), M.cdn5xx(), M.adsLatencyP99()],
    });
    step('correlate:dimensional_slice', 'llm', t0, sliceBranch.output, {
      ...usageFields(sliceBranch.usage, costMul),
      queries: [M.gapByDeviceCdn('4m')],
    });

    // --- 4. Hypothesize ---------------------------------------------------
    t0 = begin('hypothesize');
    await injectChaos('hypothesize');
    const hypothesis = await runStep({
      name: 'hypothesize',
      model: PRO,
      schema: Hypothesis,
      instruction: [
        'You are the root-cause analyst for a live ad-insertion pipeline.',
        'Every value named fraction_of_impressions_lost is the share of billable impressions that never reached the collector: 0.0 means healthy, 1.0 means total loss. A HIGH value is BAD. ',
        'Failure classes: F01 cue suppressed at playout; F02 cue dropped by packager;',
        'F03 ad-server latency spike; F04 empty VAST / no-fill; F07 beacon blackhole at',
        'the CDN edge for one device class; F08 regional CDN 5xx on segments;',
        'F09 ad pod duration underfill.',
        'Key discriminator: if delivery is healthy (no CDN 5xx, no stitch errors, normal',
        'ad latency, no-fill rate at zero) but billable impressions are missing for a',
        'specific slice, the failure is at the beacon stage, not upstream.',
        METRIC_SEMANTICS,
        'Scope the fault to the narrowest dimensions the evidence supports.',
        'Return JSON only.',
      ].join(' '),
      input: { incident, snapshot: snap, evidence, gap_by_device_and_cdn: sliceTable },
    });
    step('hypothesize', 'llm', t0, hypothesis.output, usageFields(hypothesis.usage, costMul));
    run.failureClass = hypothesis.output.failureClass;

    // --- 5. Falsify -------------------------------------------------------
    t0 = begin('falsify');
    await injectChaos('falsify');
    const probes = {
      other_device_classes_gap: await scalar(M.impressionGapOthers(incident.deviceClass, '4m')),
      cdn_5xx: await scalar(M.cdn5xx()),
      stitch_errors: await scalar(M.stitchErrors()),
      ads_pod_seconds_filled: await scalar(M.adsFillRatio()),
      ads_nofill_rate: await scalar(M.adsNoFillRate()),
      avail_unfilled_rate: await scalar(M.availUnfilledRate()),
      signal_chain_divergence: await scalar(M.availSignalChain()),
    };
    const falsification = await runStep({
      name: 'falsify',
      model: PRO,
      schema: Falsification,
      instruction: [
        'You are trying to REFUTE the stated hypothesis, not confirm it.',
        'The failure taxonomy is fixed - use these exact meanings and never invent',
        'your own mapping: F01 cue suppressed at playout; F02 cue dropped by the',
        'packager; F03 ad-server latency spike; F04 empty VAST / no-fill; F07 beacon',
        'blackhole at the CDN edge for one device class; F08 regional CDN 5xx on',
        'segment delivery; F09 ad pod duration underfill.',
        'For each competing failure class, name the signal that would have to be present',
        'if that class were the true cause, then check the probe values supplied.',
        'Refer to a class only by an id from that list, with its correct meaning.',
        METRIC_SEMANTICS,
        'A probe sitting at its healthy baseline is not evidence of anything. Before',
        'calling any value a contradiction, check it against the baselines above -',
        'a run was refuted once for a pod-seconds ratio of 0.875, which is exactly',
        'what a healthy plant reads.',
        'The probes are re-read live, seconds to minutes after the hypothesis was',
        'formed, and every rate here is computed over a sliding window. A probe that',
        'has MOVED since the hypothesis quoted it is not by itself a contradiction:',
        'a fault that is still ramping makes its own signal climb, so a no-fill rate',
        'quoted at 0.33 and now reading 0.5, or a gap quoted at 0.4 and now at 0.8,',
        'CORROBORATES the hypothesis rather than refuting it. Only a probe that has',
        'moved AGAINST what the hypothesis predicts - the signal collapsing back',
        'toward its healthy baseline, or the evidence pointing at a different stage -',
        'counts as a contradiction. Judge the direction and the meaning, never the',
        'mere fact that a number differs from the one quoted.',
        'If a probe genuinely contradicts the hypothesis, say so and set survived=false.',
        'Only set survived=true if you genuinely could not kill it. Return JSON only.',
      ].join(' '),
      input: { hypothesis: hypothesis.output, probes, evidence },
    });
    step('falsify', 'llm', t0, falsification.output, {
      ...usageFields(falsification.usage, costMul),
      queries: [M.impressionGapOthers(incident.deviceClass, '4m'), M.cdn5xx(), M.stitchErrors()],
    });

    if (!falsification.output.survived) {
      run.outcome = 'no_action';
      step('plan', 'code', Date.now(), {
        decision: 'no remediation - hypothesis did not survive falsification',
        contradictions: falsification.output.contradictions,
      });
      await createAnnotation(
        `AdBreak ${run.runId}: hypothesis ${hypothesis.output.failureClass} refuted, no action taken`,
        ['adbreak', 'agent', 'no-action'],
      );
      return run;
    }

    // --- 6. Plan (lookup table - never the model) -------------------------
    t0 = begin('plan');
    const runbookId = RUNBOOK_FOR[hypothesis.output.failureClass];
    const runbook = runbookId ? runbooks.get(runbookId) : undefined;
    const scope = hypothesis.output.scope;
    const tier = runbook ? runbook.blast_radius : classify(scope);
    run.runbookId = runbookId;
    run.tier = tier;

    if (!runbook) {
      step('plan', 'code', t0, {
        decision: 'no runbook mapped to this failure class',
        failureClass: hypothesis.output.failureClass,
      });
      run.outcome = 'no_action';
      await createAnnotation(
        `AdBreak ${run.runId}: ${hypothesis.output.failureClass} has no mapped runbook, escalating to a human`,
        ['adbreak', 'agent', 'no-runbook'],
      );
      return run;
    }

    const vars = {
      device: scope.deviceClass ?? incident.deviceClass,
      region: scope.region ?? incident.region,
    };

    // Preconditions are the runbook's own statement of when it is safe to run.
    const preconditionResults = await checkPreconditions(runbook, vars);
    const preconditionsMet = preconditionResults.every((p) => p.met);
    const verdict = gate({ tier, eventMode: false, preconditionsMet, errorBudgetRemaining: 1 });
    run.verdict = verdict.verdict;

    const plan = {
      runbookId: runbook.id,
      version: runbook.version,
      title: runbook.title,
      params: vars,
      blastRadiusTier: tier,
      verdict,
      preconditions: preconditionResults,
      predictedImpact: runbook.predicted_impact,
      actions: runbook.actions.map((a) => substitute(a, vars)),
      rollback: runbook.rollback.map((a) => substitute(a, vars)),
    };
    step('plan', 'code', t0, plan);

    // The dry run is annotated BEFORE anything executes, so the audit trail
    // always precedes the change.
    await createAnnotation(
      `AdBreak ${run.runId}: plan ${runbook.id} (${tier}, ${verdict.verdict}) for ` +
        `${hypothesis.output.failureClass} on ${vars.device} - ${verdict.reason}`,
      ['adbreak', 'agent', 'plan'],
    );

    if (verdict.verdict !== 'ALLOW') {
      run.outcome = verdict.verdict === 'APPROVE' ? 'awaiting_approval' : 'blocked';
      step('act', 'code', Date.now(), { executed: false, reason: verdict.reason });
      return run;
    }

    // --- 7. Act -----------------------------------------------------------
    t0 = begin('act');
    const executed = await execute(runbook.actions, vars);
    run.remediatedAt = nowIso();
    step('act', 'code', t0, { executed: true, steps: executed });

    // --- 8. Verify (the outcome, not the action) --------------------------
    // Verification declares its own bound: it polls live telemetry for as long
    // as the runbook allows, plus a margin for the final query.
    t0 = begin('verify', runbook.verification.timeout_s * 1000 + 30_000);
    const v = await verifyRecovery(runbook, vars.device, supervisor);
    const { recovered, residualGap: gapNow, query: verifyQuery, samples } = v;
    run.recovered = recovered;
    run.verifiedAt = nowIso();
    step('verify', 'code', t0, {
      recovered,
      residualGap: gapNow,
      window: runbook.verification.window,
      query: verifyQuery,
      samples,
    });

    if (!recovered) {
      // Verification is what makes remediation safe to automate: if the fix did
      // not work, put it back rather than leaving the plant in a changed state.
      await execute(runbook.rollback, vars);
      step('rollback', 'code', Date.now(), { rolledBack: true, reason: 'recovery not observed' });
    }
    run.outcome = recovered ? 'remediated' : 'failed';

    // --- 9. Document ------------------------------------------------------
    //
    // Best effort, deliberately. Writing the incident up is valuable but it is
    // not the remediation: a transient error here once marked a run `failed`
    // whose fix had executed and whose recovery had been verified, which is a
    // far worse thing to tell an operator than "fixed, but I could not write it
    // up". The outcome is already decided above and nothing below may change it.
    try {
      t0 = begin('document');
      const leak = await scalar(M.revenueLeakUsd('15m')).catch(() => null);
      const doc = await runStep({
        name: 'document',
        model: PRO,
        schema: Documentation,
        instruction: [
          'Write the incident record for a revenue-loss incident that has just been',
          'auto-remediated. Produce two things: a technical postmortem for the NOC',
          '(timeline, root cause, evidence, action taken, verification) and a short CFO',
          'brief in plain business language stating dollars at risk and dollars recovered.',
          'Be specific and factual, use the numbers supplied, and do not speculate.',
          'Return JSON only.',
        ].join(' '),
        input: {
          incident,
          hypothesis: hypothesis.output,
          falsification: falsification.output,
          plan,
          executed,
          recovered,
          residualGap: gapNow,
          revenueLeakUsd: leak,
        },
      });
      step('document', 'llm', t0, doc.output, usageFields(doc.usage, costMul));
      run.postmortem = doc.output.postmortem;
      run.cfoBrief = doc.output.cfoBrief;

      await createAnnotation(
        `AdBreak ${run.runId}: ${hypothesis.output.failureClass} on ${vars.device} - ` +
          `${runbook.id} executed, ${recovered ? 'recovery verified' : 'NOT recovered, rolled back'}`,
        ['adbreak', 'agent', recovered ? 'remediated' : 'rollback'],
      );
      await createIncident(doc.output.incidentTitle, 'critical', doc.output.cfoBrief);
    } catch (err) {
      // The incident is resolved either way; say so, and record that the
      // write-up is missing rather than losing the outcome with it.
      run.postmortem = `Documentation step failed: ${String(err)}. The remediation itself ` +
        `${recovered ? 'executed and recovery was verified.' : 'did not achieve recovery and was rolled back.'}`;
      step('document', 'code', Date.now(), { failed: true, err: String(err) });
    }

    return run;
  } catch (err) {
    if (err instanceof WatchdogKill) {
      // The partial trace is kept deliberately: a human inheriting this run
      // should get the work done so far, not a blank page.
      run.outcome = 'killed_by_watchdog';
      run.watchdog = { reason: err.reason, detail: err.detail };
      run.error = err.message;
      await createAnnotation(
        `AdBreak ${run.runId}: watchdog terminated the run (${err.reason}) - ${err.detail}`,
        ['adbreak', 'agent', 'watchdog'],
      ).catch(() => {});
      return run;
    }
    run.outcome = 'failed';
    run.error = String(err);
    return run;
  }
}

/**
 * Approve a plan the blast-radius gate stopped for a human.
 *
 * T2 exists so that a channel-wide change gets a person's judgement before it
 * lands. That tier is decorative unless approving is actually possible, which
 * is what this closes.
 *
 * The order of operations is the point. A plan is a snapshot of a moment, and
 * the plant keeps moving while it waits for a human. So approval re-measures
 * the runbook's preconditions against live telemetry BEFORE executing, and
 * refuses if they no longer hold. Refusing is a first-class outcome, not an
 * error: it means the agent noticed the world had changed and declined to
 * apply a stale plan to it - exactly the recklessness the gate exists to stop.
 */
export async function approveRun(
  run: AgentRun,
  approvedBy: string,
): Promise<{ ok: boolean; reason: string; run: AgentRun }> {
  if (run.outcome !== 'awaiting_approval') {
    return { ok: false, reason: `run is ${run.outcome}, not awaiting_approval`, run };
  }
  const planStep = run.steps.find((s) => s.step === 'plan');
  const plan = planStep?.output as { runbookId?: string; params?: Record<string, string> } | undefined;
  const runbook = plan?.runbookId ? runbooks.get(plan.runbookId) : undefined;
  if (!runbook || !plan?.params) {
    return { ok: false, reason: 'the stored plan names no runbook this agent knows', run };
  }
  const vars = plan.params;
  run.approvedAt = nowIso();
  run.approvedBy = approvedBy;

  const stepAt = (name: string, startedAt: number, output: unknown): void => {
    run.steps.push({
      step: name,
      kind: 'code',
      startedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      output,
    });
  };

  // --- Re-check against the plant as it is now, not as it was when planned ---
  let t0 = Date.now();
  const preconditions = await checkPreconditions(runbook, vars);
  const stale = preconditions.filter((p) => !p.met);
  stepAt('approve', t0, { approvedBy, preconditions, stale: stale.map((p) => p.id) });

  if (stale.length > 0) {
    run.outcome = 'blocked_on_approval';
    await createAnnotation(
      `AdBreak ${run.runId}: approval by ${approvedBy} REFUSED - preconditions no longer hold ` +
        `(${stale.map((p) => p.id).join(', ')}); the plant has moved since the plan was written`,
      ['adbreak', 'agent', 'approval-refused'],
    ).catch(() => {});
    return {
      ok: false,
      reason: `preconditions no longer hold: ${stale.map((p) => p.id).join(', ')}`,
      run,
    };
  }

  // --- Act, then verify the outcome on the same registry the agent uses ---
  t0 = Date.now();
  const executed = await execute(runbook.actions, vars);
  run.remediatedAt = nowIso();
  stepAt('act', t0, { executed: true, approvedBy, steps: executed });

  t0 = Date.now();
  const v = await verifyRecovery(runbook, vars.device);
  run.recovered = v.recovered;
  run.verifiedAt = nowIso();
  stepAt('verify', t0, {
    recovered: v.recovered,
    residualGap: v.residualGap,
    query: v.query,
    samples: v.samples,
  });

  if (!v.recovered) {
    await execute(runbook.rollback, vars);
    stepAt('rollback', Date.now(), { rolledBack: true, reason: 'recovery not observed' });
  }
  run.outcome = v.recovered ? 'remediated' : 'failed';

  await createAnnotation(
    `AdBreak ${run.runId}: approved by ${approvedBy} - ${runbook.id} executed, ` +
      `${v.recovered ? 'recovery verified' : 'NOT recovered, rolled back'}`,
    ['adbreak', 'agent', v.recovered ? 'approved-remediated' : 'rollback'],
  ).catch(() => {});

  return {
    ok: v.recovered,
    reason: v.recovered ? 'remediated and verified' : 'executed but recovery was not observed; rolled back',
    run,
  };
}
