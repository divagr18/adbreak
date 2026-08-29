/**
 * The agent's own SRE.
 *
 * Deliberately not an LLM. Three arithmetic rules decide whether a run has
 * stopped making progress, started going in circles, or begun burning money —
 * and any of them terminates it. A model cannot be asked to judge whether it
 * has itself gone wrong; that is exactly the state in which its judgement is
 * least trustworthy.
 *
 * We have a live reason to want this. Earlier in this build, exemplar
 * instrumentation returned HTTP 500 from the ad server for precisely the
 * sampled sessions, emptying their ad pods, while throughput, dashboards and
 * the revenue ledger all read healthy. Observability quietly broke the thing
 * it was measuring, and nothing in the aggregate signals said so.
 */

export type InterventionReason = 'stall' | 'loop' | 'runaway';

export class WatchdogKill extends Error {
  constructor(
    readonly reason: InterventionReason,
    readonly detail: string,
  ) {
    super(`watchdog terminated the run: ${reason} — ${detail}`);
    this.name = 'WatchdogKill';
  }
}

export interface WatchdogConfig {
  /** Floor for the stall threshold, covering a cold start with no history. */
  stallFloorMs: number;
  /** Multiple of a step's typical duration that counts as stalled. */
  stallTypicalMultiple: number;
  /** Identical tool calls in one run before it is judged to be looping. */
  loopThreshold: number;
  /** Hard ceiling on model spend for a single run. */
  costCeilingUsd: number;
}

export const DEFAULTS: WatchdogConfig = {
  stallFloorMs: 90_000,
  stallTypicalMultiple: 6,
  loopThreshold: 3,
  costCeilingUsd: 0.5,
};

/**
 * The typical duration of a step, in ms. Null when there is no history.
 *
 * The median, deliberately, and this used to be p95 - which was exactly the
 * wrong statistic. p95 SELECTS the outliers, so every stall the watchdog was
 * meant to catch raised the bar for catching the next one. Two 220s stall
 * tests in a history of otherwise 13-41s runs pushed the triage p95 to 242s
 * and the threshold to 726s, and a subsequent 242s stall sailed through
 * unnoticed. The failure is self-reinforcing: a handful of pathological runs
 * blinds the detector permanently.
 *
 * A central statistic cannot be dragged by the tail it is trying to detect.
 */
export function typicalMs(durationsMs: number[]): number | null {
  if (durationsMs.length === 0) return null;
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * How long this step is allowed to take. A step with history is judged against
 * its own past; one without falls back to the floor. The floor is also a lower
 * bound, so a historically fast step cannot produce an absurdly tight budget.
 */
export function stallThresholdMs(
  history: number[],
  cfg: WatchdogConfig = DEFAULTS,
  /**
   * A step that knows its own bound declares it. Verification polls live
   * telemetry for as long as its runbook allows, so judging it against a
   * generic floor kills remediations that are working correctly - a watchdog
   * that stops healthy runs is worse than no watchdog.
   */
  declaredBudgetMs?: number,
): number {
  const base = typicalMs(history);
  const fromHistory =
    base === null ? cfg.stallFloorMs : Math.max(cfg.stallFloorMs, base * cfg.stallTypicalMultiple);
  return declaredBudgetMs ? Math.max(fromHistory, declaredBudgetMs) : fromHistory;
}

export interface Verdict {
  kill: boolean;
  reason?: InterventionReason;
  detail?: string;
}

const ALIVE: Verdict = { kill: false };

export function checkStall(
  stepName: string,
  elapsedMs: number,
  history: number[],
  cfg: WatchdogConfig = DEFAULTS,
  declaredBudgetMs?: number,
): Verdict {
  const limit = stallThresholdMs(history, cfg, declaredBudgetMs);
  if (elapsedMs <= limit) return ALIVE;
  return {
    kill: true,
    reason: 'stall',
    detail: `step "${stepName}" ran ${(elapsedMs / 1000).toFixed(1)}s, over its ${(
      limit / 1000
    ).toFixed(1)}s budget`,
  };
}

export function checkLoop(
  callCounts: Map<string, number>,
  cfg: WatchdogConfig = DEFAULTS,
): Verdict {
  for (const [signature, count] of callCounts) {
    if (count >= cfg.loopThreshold) {
      return {
        kill: true,
        reason: 'loop',
        detail: `the same call was issued ${count} times: ${signature.slice(0, 160)}`,
      };
    }
  }
  return ALIVE;
}

export function checkRunaway(costUsd: number, cfg: WatchdogConfig = DEFAULTS): Verdict {
  if (costUsd <= cfg.costCeilingUsd) return ALIVE;
  return {
    kill: true,
    reason: 'runaway',
    detail: `run cost $${costUsd.toFixed(4)} exceeded the $${cfg.costCeilingUsd.toFixed(2)} ceiling`,
  };
}

/**
 * Tracks one run. Steps report when they start and finish, tool calls are
 * counted by signature, and assertAlive() is the checkpoint every step passes
 * through — so an aborted run halts at the next boundary even when the call
 * already in flight cannot itself be cancelled.
 */
export class Supervisor {
  private stepStartedAt: number | null = null;
  private stepName = '';
  private readonly callCounts = new Map<string, number>();
  private readonly declaredBudgets = new Map<string, number | undefined>();
  private costUsd = 0;
  private killed: WatchdogKill | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly history: Map<string, number[]>,
    private readonly cfg: WatchdogConfig = DEFAULTS,
    private readonly onKill?: (reason: InterventionReason, detail: string) => void,
  ) {}

  beginStep(name: string, declaredBudgetMs?: number): void {
    this.stepName = name;
    this.stepStartedAt = Date.now();
    this.declaredBudgets.set(name, declaredBudgetMs);
    // Fire even while a step is blocked, so a stall is caught in real time
    // rather than only being noticed once the step eventually returns.
    const limit = stallThresholdMs(this.history.get(name) ?? [], this.cfg, declaredBudgetMs);
    this.timer = setTimeout(() => {
      this.trip('stall', `step "${name}" exceeded its ${(limit / 1000).toFixed(1)}s budget`);
    }, limit + 250);
    this.timer.unref?.();
  }

  endStep(name: string, costUsd = 0): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const elapsed = this.stepStartedAt ? Date.now() - this.stepStartedAt : 0;
    const verdict = checkStall(
      name,
      elapsed,
      this.history.get(name) ?? [],
      this.cfg,
      this.declaredBudgets.get(name),
    );
    if (verdict.kill) this.trip(verdict.reason!, verdict.detail!);

    this.costUsd += costUsd;
    const runaway = checkRunaway(this.costUsd, this.cfg);
    if (runaway.kill) this.trip(runaway.reason!, runaway.detail!);

    this.stepStartedAt = null;
  }

  noteToolCall(name: string, args: unknown): void {
    const signature = `${name}(${JSON.stringify(args)})`;
    const next = (this.callCounts.get(signature) ?? 0) + 1;
    this.callCounts.set(signature, next);
    const verdict = checkLoop(this.callCounts, this.cfg);
    if (verdict.kill) this.trip(verdict.reason!, verdict.detail!);
  }

  /** Throws if the watchdog has terminated this run. */
  assertAlive(): void {
    if (this.killed) throw this.killed;
  }

  get intervention(): WatchdogKill | null {
    return this.killed;
  }

  private trip(reason: InterventionReason, detail: string): void {
    if (this.killed) return;
    this.killed = new WatchdogKill(reason, detail);
    this.onKill?.(reason, detail);
  }
}

/** Rolling step durations from previous runs, for the stall threshold. */
export function historyFrom(
  runs: { outcome?: string; steps: { step: string; durationMs: number }[] }[],
  keep = 20,
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const run of runs) {
    // A run the supervisor had to stop is not a sample of normal behaviour.
    // Learning from it teaches the detector that the thing it just caught is
    // ordinary, and a sustained run of stalls would otherwise raise the
    // baseline until nothing trips at all - the same self-blinding the switch
    // from p95 to the median fixes from the other side.
    if (run.outcome === 'killed_by_watchdog') continue;
    for (const s of run.steps) {
      const list = out.get(s.step) ?? [];
      list.push(s.durationMs);
      out.set(s.step, list);
    }
  }
  for (const [k, v] of out) out.set(k, v.slice(-keep));
  return out;
}
