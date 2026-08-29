import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULTS,
  Supervisor,
  WatchdogKill,
  checkLoop,
  checkRunaway,
  checkStall,
  historyFrom,
  typicalMs,
  stallThresholdMs,
} from './watchdog.js';

describe('stall detection', () => {
  it('falls back to the floor when a step has no history', () => {
    expect(stallThresholdMs([])).toBe(DEFAULTS.stallFloorMs);
  });

  it('judges a step against a multiple of its own typical duration', () => {
    const history = Array.from({ length: 20 }, () => 60_000);
    expect(stallThresholdMs(history)).toBe(60_000 * DEFAULTS.stallTypicalMultiple);
  });

  /**
   * The regression that let a 242s stall through unnoticed on the live agent.
   *
   * The baseline used to be p95, which selects the very outliers the rule
   * exists to catch: two earlier stall tests in an otherwise 13-41s history
   * pushed the triage p95 to 242s and the threshold to 726s. Each stall raised
   * the bar for detecting the next, so the detector blinded itself.
   */
  it('is not desensitised by the stalls it is meant to detect', () => {
    const normal = Array.from({ length: 18 }, () => 25_000);
    const poisoned = [...normal, 220_000, 242_000];
    // A central statistic cannot be dragged by the tail it is detecting.
    expect(stallThresholdMs(poisoned)).toBeLessThan(200_000);
    expect(checkStall('triage', 242_000, poisoned).kill).toBe(true);
  });

  it('never lets a fast step produce an absurdly tight budget', () => {
    // A step that normally takes 2s must not be killed at 6s.
    const history = Array.from({ length: 20 }, () => 2_000);
    expect(stallThresholdMs(history)).toBe(DEFAULTS.stallFloorMs);
    expect(checkStall('triage', 30_000, history).kill).toBe(false);
  });

  it('kills a step that overruns its budget', () => {
    const v = checkStall('correlate', 500_000, Array.from({ length: 20 }, () => 60_000));
    expect(v.kill).toBe(true);
    expect(v.reason).toBe('stall');
  });

  it('computes the typical duration from an empty, odd and even set', () => {
    expect(typicalMs([])).toBeNull();
    expect(typicalMs([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(5.5);
    expect(typicalMs([1, 2, 3, 4, 5])).toBe(3);
  });
});

describe('history', () => {
  it('does not learn normal durations from runs the watchdog stopped', () => {
    const h = historyFrom([
      { outcome: 'remediated', steps: [{ step: 'triage', durationMs: 25_000 }] },
      { outcome: 'killed_by_watchdog', steps: [{ step: 'triage', durationMs: 240_000 }] },
      { outcome: 'remediated', steps: [{ step: 'triage', durationMs: 30_000 }] },
    ]);
    expect(h.get('triage')).toEqual([25_000, 30_000]);
  });
});

describe('loop detection', () => {
  it('allows a call repeated fewer times than the threshold', () => {
    expect(checkLoop(new Map([['query_prometheus({"expr":"up"})', 2]])).kill).toBe(false);
  });

  it('kills a run issuing the identical call three times', () => {
    const v = checkLoop(new Map([['query_prometheus({"expr":"up"})', 3]]));
    expect(v.kill).toBe(true);
    expect(v.reason).toBe('loop');
  });

  it('does not confuse different arguments for a repeat', () => {
    const counts = new Map([
      ['query_prometheus({"expr":"a"})', 2],
      ['query_prometheus({"expr":"b"})', 2],
    ]);
    expect(checkLoop(counts).kill).toBe(false);
  });
});

describe('cost ceiling', () => {
  it('permits spend up to the ceiling', () => {
    expect(checkRunaway(DEFAULTS.costCeilingUsd).kill).toBe(false);
  });
  it('kills a run past the ceiling', () => {
    const v = checkRunaway(DEFAULTS.costCeilingUsd + 0.01);
    expect(v.kill).toBe(true);
    expect(v.reason).toBe('runaway');
  });
});

describe('Supervisor', () => {
  it('leaves a healthy run alone', () => {
    const sup = new Supervisor(new Map());
    sup.beginStep('triage');
    sup.endStep('triage', 0.01);
    sup.noteToolCall('query_prometheus', { expr: 'up' });
    expect(() => sup.assertAlive()).not.toThrow();
    expect(sup.intervention).toBeNull();
  });

  it('trips on a loop and then fails every later checkpoint', () => {
    const onKill = vi.fn();
    const sup = new Supervisor(new Map(), DEFAULTS, onKill);
    for (let i = 0; i < 3; i++) sup.noteToolCall('query_prometheus', { expr: 'up' });
    expect(onKill).toHaveBeenCalledWith('loop', expect.stringContaining('3 times'));
    expect(() => sup.assertAlive()).toThrow(WatchdogKill);
  });

  it('trips on cost accumulated across steps, not just one', () => {
    const sup = new Supervisor(new Map());
    for (let i = 0; i < 6; i++) {
      sup.beginStep(`s${i}`);
      sup.endStep(`s${i}`, 0.1);
    }
    expect(() => sup.assertAlive()).toThrow(/runaway/);
  });

  it('reports only the first intervention, not the last', () => {
    const sup = new Supervisor(new Map());
    for (let i = 0; i < 3; i++) sup.noteToolCall('a', {});
    for (let i = 0; i < 3; i++) sup.noteToolCall('b', {});
    expect(sup.intervention?.reason).toBe('loop');
    expect(sup.intervention?.detail).toContain('a(');
  });
});

describe('historyFrom', () => {
  it('groups durations by step name across runs', () => {
    const h = historyFrom([
      { steps: [{ step: 'triage', durationMs: 100 }] },
      { steps: [{ step: 'triage', durationMs: 200 }, { step: 'verify', durationMs: 300 }] },
    ]);
    expect(h.get('triage')).toEqual([100, 200]);
    expect(h.get('verify')).toEqual([300]);
  });
});

describe('declared budgets', () => {
  it('respects a step that declares a longer bound than the floor', () => {
    // Verification polls for up to 150s by runbook; killing it at the 90s
    // floor would terminate remediations that are succeeding.
    expect(stallThresholdMs([], DEFAULTS, 180_000)).toBe(180_000);
    expect(checkStall('verify', 111_000, [], DEFAULTS, 180_000).kill).toBe(false);
  });

  it('still kills a declared-budget step that overruns its own bound', () => {
    expect(checkStall('verify', 200_000, [], DEFAULTS, 180_000).kill).toBe(true);
  });

  it('never lets a declared budget shrink the threshold below the floor', () => {
    expect(stallThresholdMs([], DEFAULTS, 1_000)).toBe(DEFAULTS.stallFloorMs);
  });
});
