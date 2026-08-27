import { describe, expect, it } from 'vitest';
import { hash32, sampled } from './sampling.js';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `sess-${String(i).padStart(4, '0')}`);

describe('sampled', () => {
  // The bug this guards: a rolling hash over sequential session ids produced a
  // contiguous run of buckets, so a 5% threshold selected zero of 200 sessions
  // and silently disabled per-session tracing entirely.
  it('selects roughly the requested share of sequential ids', () => {
    for (const ratio of [0.05, 0.1, 0.25, 0.5]) {
      const hits = ids(2000).filter((id) => sampled(id, ratio)).length;
      const expected = 2000 * ratio;
      expect(hits).toBeGreaterThan(expected * 0.6);
      expect(hits).toBeLessThan(expected * 1.4);
    }
  });

  it('never selects nothing at a usable ratio', () => {
    expect(ids(200).filter((id) => sampled(id, 0.05)).length).toBeGreaterThan(0);
  });

  it('scatters adjacent ids rather than running them together', () => {
    // Adjacent keys must land far apart, or a threshold cuts the population
    // into two contiguous blocks instead of sampling it.
    const buckets = ids(50).map((id) => hash32(id) / 4294967296);
    const adjacentDeltas = buckets.slice(1).map((b, i) => Math.abs(b - buckets[i]));
    const median = adjacentDeltas.sort((a, b) => a - b)[Math.floor(adjacentDeltas.length / 2)];
    expect(median).toBeGreaterThan(0.05);
  });

  it('is stable and honours the extremes', () => {
    expect(sampled('sess-0007', 0.3)).toBe(sampled('sess-0007', 0.3));
    expect(sampled('anything', 1)).toBe(true);
    expect(sampled('anything', 0)).toBe(false);
  });
});
