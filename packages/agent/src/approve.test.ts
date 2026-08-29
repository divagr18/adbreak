import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AgentRun } from './run.js';

// The approval path is about ordering and refusal, not about talking to
// Grafana or Vertex. Stub the edges so the decisions themselves are under test.
const scalar = vi.fn<(expr: string) => Promise<number | null>>();
const execute = vi.fn(async () => [{ action: 'stub', ok: true }]);

vi.mock('./tools/grafana.js', () => ({
  scalar: (expr: string) => scalar(expr),
  createAnnotation: vi.fn(async () => {}),
  createIncident: vi.fn(async () => {}),
  queryPrometheus: vi.fn(async () => []),
}));
vi.mock('./llm.js', () => ({
  FLASH: 'flash',
  PRO: 'pro',
  runStep: vi.fn(),
}));
vi.mock('./tools/runbook.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tools/runbook.js')>();
  return { ...actual, execute: (...a: unknown[]) => execute(...(a as [])) };
});

// run.ts loads the runbooks at import time from the container's path.
process.env.RUNBOOK_DIR = new URL('../../../runbooks', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');

const { approveRun } = await import('./run.js');

/** A run parked exactly where the blast-radius gate leaves a T2 plan. */
function awaitingRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    runId: 'test-run',
    trigger: 'grafana_alert',
    incident: { deviceClass: 'web', region: 'us-east', channel: 'sports-1' } as never,
    steps: [
      {
        step: 'plan',
        kind: 'code',
        startedAt: new Date().toISOString(),
        durationMs: 1,
        output: { runbookId: 'rb-ads-failover', params: { device: 'web', region: 'us-east' } },
      },
    ],
    outcome: 'awaiting_approval',
    costUsd: 0.01,
    detectedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('approveRun', () => {
  beforeEach(() => {
    scalar.mockReset();
    execute.mockClear();
  });

  it('refuses a run that is not awaiting approval', async () => {
    const res = await approveRun(awaitingRun({ outcome: 'remediated' }), 'operator');
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('not awaiting_approval');
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses when the stored plan names a runbook it does not have', async () => {
    const run = awaitingRun();
    (run.steps[0].output as { runbookId: string }).runbookId = 'rb-does-not-exist';
    const res = await approveRun(run, 'operator');
    expect(res.ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a stale plan whose preconditions no longer hold, and executes nothing', async () => {
    // The plant recovered while the plan sat waiting: no-fill is back to zero,
    // so rb-ads-failover no longer applies.
    scalar.mockResolvedValue(0);
    const run = awaitingRun();
    const res = await approveRun(run, 'operator');

    expect(res.ok).toBe(false);
    expect(res.reason).toContain('preconditions no longer hold');
    expect(res.run.outcome).toBe('blocked_on_approval');
    expect(execute).not.toHaveBeenCalled();
    // The refusal is recorded, not swallowed.
    const approveStep = res.run.steps.find((s) => s.step === 'approve');
    expect(approveStep).toBeDefined();
    expect((approveStep!.output as { stale: string[] }).stale.length).toBeGreaterThan(0);
  });

  it('records who approved before it does anything else', async () => {
    scalar.mockResolvedValue(0);
    const res = await approveRun(awaitingRun(), 'sre-oncall');
    expect(res.run.approvedBy).toBe('sre-oncall');
    expect(res.run.approvedAt).toBeTruthy();
  });
});
