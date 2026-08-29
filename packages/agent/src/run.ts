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
import { RUNBOOK_FOR, execute, loadRunbooks, substitute } from './tools/runbook.js';
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
  postmortem?: string;
  cfoBrief?: string;
  error?: string;
}

const runbooks = loadRunbooks();

const nowIso = () => new Date().toISOString();

const usageFields = (u: StepUsage, costMultiplier = 1) => ({
  model: u.model,
  tokens: { input: u.inputTokens, output: u.outputTokens },
  costUsd: u.costUsd * costMultiplier,
});

/** Everything the model is allowed to see about the current state of the plant. */
async function snapshot(deviceClass: string): Promise<Record<string, unknown>> {
  const queries: Record<string, string> = {
    impression_gap_affected: M.impressionGap(deviceClass, '5m'),
    impression_gap_others: M.impressionGapOthers(deviceClass, '5m'),
    cdn_5xx: M.cdn5xx(),
    stitch_errors: M.stitchErrors(),
    ads_latency_p99: M.adsLatencyP99(),
    ads_fill_ratio: M.adsFillRatio(),
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
    supervisor?.noteToolCall('query_prometheus', { expr: M.gapByDeviceCdn('5m') });
    const gapRows = await queryPrometheus(M.gapByDeviceCdn('5m'));
    if (chaos?.mode === 'loop') {
      // Re-issue the identical query so the loop rule has something to catch.
      for (let i = 0; i < 3; i++) {
        supervisor?.noteToolCall('query_prometheus', { expr: M.gapByDeviceCdn('5m') });
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
      queries: [M.gapByDeviceCdn('5m')],
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
        'ad latency and fill) but billable impressions are missing for a specific slice,',
        'the failure is at the beacon stage, not upstream.',
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
      other_device_classes_gap: await scalar(M.impressionGapOthers(incident.deviceClass, '5m')),
      cdn_5xx: await scalar(M.cdn5xx()),
      stitch_errors: await scalar(M.stitchErrors()),
      ads_fill_ratio: await scalar(M.adsFillRatio()),
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
        'If a probe contradicts the hypothesis, say so and set survived=false.',
        'Only set survived=true if you genuinely could not kill it. Return JSON only.',
      ].join(' '),
      input: { hypothesis: hypothesis.output, probes, evidence },
    });
    step('falsify', 'llm', t0, falsification.output, {
      ...usageFields(falsification.usage, costMul),
      queries: [M.impressionGapOthers(incident.deviceClass, '5m'), M.cdn5xx(), M.stitchErrors()],
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
    const preconditionResults = [];
    for (const p of runbook.preconditions) {
      const promql =
        p.id === 'gap_is_real'
          ? M.impressionGap(vars.device, p.window)
          : M.impressionGapOthers(vars.device, p.window);
      const value = await scalar(promql);
      const met = p.id === 'gap_is_real' ? (value ?? 0) > 0.4 : (value ?? 1) < 0.1;
      preconditionResults.push({ id: p.id, expr: substitute(p.expr, vars), promql, value, met });
    }
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
    const deadline = Date.now() + runbook.verification.timeout_s * 1000;
    let gapNow: number | null = null;
    let recovered = false;
    const samples: { at: string; gap: number | null }[] = [];
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10_000));
      gapNow = await scalar(M.impressionGap(vars.device, runbook.verification.window));
      samples.push({ at: nowIso(), gap: gapNow });
      if (gapNow !== null && gapNow < 0.05) {
        recovered = true;
        break;
      }
    }
    run.recovered = recovered;
    run.verifiedAt = nowIso();
    step('verify', 'code', t0, {
      recovered,
      residualGap: gapNow,
      window: runbook.verification.window,
      query: M.impressionGap(vars.device, runbook.verification.window),
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
    t0 = begin('document');
    const leak = await scalar(M.revenueLeakUsd('15m'));
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
