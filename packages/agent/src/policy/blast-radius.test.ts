import { describe, expect, it } from 'vitest';
import { classify, gate } from './blast-radius.js';

const ok = { eventMode: false, preconditionsMet: true, errorBudgetRemaining: 1 };

describe('classify', () => {
  it('scopes one device class in one region to T1', () => {
    expect(classify({ deviceClass: 'roku', cdn: 'cdn-east', region: 'us-east' })).toBe('T1');
  });
  it('escalates a device class across all regions to T2', () => {
    expect(classify({ deviceClass: 'roku', cdn: null, region: null })).toBe('T2');
  });
  it('escalates a whole region to T2', () => {
    expect(classify({ deviceClass: null, cdn: null, region: 'eu' })).toBe('T2');
  });
  it('treats an unscoped change as channel-wide T3', () => {
    expect(classify({ deviceClass: null, cdn: null, region: null })).toBe('T3');
  });
  it('treats any content-path change as T3 however narrow it looks', () => {
    expect(classify({ deviceClass: 'roku', cdn: null, region: 'eu', contentPath: true })).toBe('T3');
  });
});

describe('gate', () => {
  it('auto-allows T0 and T1', () => {
    expect(gate({ ...ok, tier: 'T0' }).verdict).toBe('ALLOW');
    expect(gate({ ...ok, tier: 'T1' }).verdict).toBe('ALLOW');
  });
  it('requires a human for T2', () => {
    expect(gate({ ...ok, tier: 'T2' }).verdict).toBe('APPROVE');
  });
  it('blocks T3 outright during a live event', () => {
    expect(gate({ ...ok, tier: 'T3', eventMode: true }).verdict).toBe('BLOCK');
    expect(gate({ ...ok, tier: 'T3', eventMode: false }).verdict).toBe('APPROVE');
  });

  // The property that matters most: a misdiagnosis must not be actionable.
  it('blocks every tier when preconditions fail', () => {
    for (const tier of ['T0', 'T1', 'T2', 'T3'] as const) {
      expect(gate({ ...ok, tier, preconditionsMet: false }).verdict).toBe('BLOCK');
    }
  });
  it('blocks on an exhausted error budget except for a single session', () => {
    expect(gate({ ...ok, tier: 'T1', errorBudgetRemaining: 0 }).verdict).toBe('BLOCK');
    expect(gate({ ...ok, tier: 'T0', errorBudgetRemaining: 0 }).verdict).toBe('ALLOW');
  });
});
