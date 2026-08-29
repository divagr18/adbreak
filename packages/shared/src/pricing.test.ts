import { describe, expect, it } from 'vitest';
import { blendedEcpm, ecpm, expectedSpotValueUsd, impressionValueUsd, nominalSpots } from './pricing.js';

describe('nominal spot capacity', () => {
  it('scores a 32s break as two spots', () => {
    expect(nominalSpots(32)).toBe(2);
  });
  it('never scores an avail as carrying nothing', () => {
    expect(nominalSpots(4)).toBe(1);
  });
});

describe('blended pricing', () => {
  it('sits between the cheapest and dearest advertiser', () => {
    const blended = blendedEcpm('us-west');
    expect(blended).toBeGreaterThan(ecpm('Northwind Beverages', 'us-west'));
    expect(blended).toBeLessThan(ecpm('Contoso Motors', 'us-west'));
  });

  /**
   * The property that keeps a healthy plant at RRR 1.0: expected is priced
   * blended across the avail's spots, realized is priced per advertiser, and a
   * pod carrying one spot from each must reconcile exactly.
   */
  it('reconciles exactly with a pod of one spot per advertiser', () => {
    for (const region of ['us-east', 'us-west', 'eu']) {
      const expected = nominalSpots(32) * expectedSpotValueUsd(region);
      const realized =
        impressionValueUsd('Contoso Motors', region) +
        impressionValueUsd('Northwind Beverages', region);
      expect(expected).toBeCloseTo(realized, 10);
    }
  });

  it('carries the regional multiplier through the blend', () => {
    expect(blendedEcpm('us-east')).toBeGreaterThan(blendedEcpm('eu'));
  });
});
