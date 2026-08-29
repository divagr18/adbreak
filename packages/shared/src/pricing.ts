/**
 * What an impression is worth. This is the only place money is defined, so the
 * expected side (SSAI, at ad-decision time) and the realized side (the beacon
 * collector, on a confirmed impression) can never disagree about the rate.
 */

/** Base effective CPM per advertiser, in USD per thousand impressions. */
const BASE_ECPM: Record<string, number> = {
  'Northwind Beverages': 28,
  'Contoso Motors': 36,
};

const DEFAULT_ECPM = 30;

/** Inventory in a premium market clears higher; this is normal rate-card shape. */
const REGION_MULTIPLIER: Record<string, number> = {
  'us-east': 1.15,
  'us-west': 1.0,
  eu: 0.85,
};

export function ecpm(advertiser: string, region: string): number {
  const base = BASE_ECPM[advertiser] ?? DEFAULT_ECPM;
  return base * (REGION_MULTIPLIER[region] ?? 1);
}

/** Revenue in USD for a single impression. */
export function impressionValueUsd(advertiser: string, region: string): number {
  return ecpm(advertiser, region) / 1000;
}

/**
 * What a spot is worth before we know who bought it.
 *
 * Expected revenue is booked against the avail the playout signalled, which is
 * known before any ad server has replied - so it cannot be priced per
 * advertiser. The blend is the mean of the rate card, which lands exactly on
 * the realized figure for a healthy pod carrying one spot from each
 * advertiser, keeping a well-behaved plant at RRR 1.0.
 */
export function blendedEcpm(region: string): number {
  const rates = Object.values(BASE_ECPM);
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
  return mean * (REGION_MULTIPLIER[region] ?? 1);
}

/** Value of one expected (not yet sold) spot, in USD. */
export function expectedSpotValueUsd(region: string): number {
  return blendedEcpm(region) / 1000;
}

/**
 * How many spots an avail of this length should carry. Expected revenue is
 * denominated in spots rather than seconds so that a pod which fills its slots
 * but runs slightly short is not scored as a revenue failure - that is
 * duration underfill, and slate_seconds is the signal for it.
 */
export const NOMINAL_SPOT_S = Number(process.env.NOMINAL_SPOT_S ?? 16);
export const nominalSpots = (availSeconds: number): number =>
  Math.max(1, Math.round(availSeconds / NOMINAL_SPOT_S));
