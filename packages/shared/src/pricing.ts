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
