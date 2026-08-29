/**
 * The PromQL the deterministic steps issue. Kept in one place so detection,
 * verification and the gate script can never disagree about what "the gap" or
 * "the SLO" actually means.
 */

/** Share of billable impressions that never arrived, for one device class. */
export const impressionGap = (deviceClass: string, window = '2m'): string =>
  `1 - (sum(increase(adbreak_beacon_fired_total{event="impression",device_class="${deviceClass}"}[${window}])) ` +
  `/ clamp_min(sum(increase(adbreak_beacon_expected_total{event="impression",device_class="${deviceClass}"}[${window}])), 1))`;

/** Same, for everything except one device class — proves a fault is scoped. */
export const impressionGapOthers = (deviceClass: string, window = '2m'): string =>
  `1 - (sum(increase(adbreak_beacon_fired_total{event="impression",device_class!="${deviceClass}"}[${window}])) ` +
  `/ clamp_min(sum(increase(adbreak_beacon_expected_total{event="impression",device_class!="${deviceClass}"}[${window}])), 1))`;

/**
 * The SLO. Note the `> 0` guard rather than an epsilon floor: when nothing was
 * expected in the window the honest answer is "no data", not a ratio in the
 * millions.
 */
export const rrr = (deviceClass?: string, window = '15m'): string => {
  const sel = deviceClass ? `{device_class="${deviceClass}"}` : '';
  return (
    `sum(increase(adbreak_revenue_realized_usd_total${sel}[${window}])) / ` +
    `(sum(increase(adbreak_revenue_expected_usd_total${sel}[${window}])) > 0)`
  );
};

export const revenueLeakUsd = (window = '15m'): string =>
  `sum(increase(adbreak_revenue_expected_usd_total[${window}])) - ` +
  `sum(increase(adbreak_revenue_realized_usd_total[${window}]))`;

/** Delivery-health signals — the ones that stay green during a silent failure. */
export const cdn5xx = (window = '5m'): string =>
  `sum(increase(adbreak_cdn_requests_total{status=~"5.."}[${window}])) or vector(0)`;
export const stitchErrors = (window = '5m'): string =>
  `sum(increase(adbreak_stitch_errors_total[${window}])) or vector(0)`;
export const adsLatencyP99 = (window = '5m'): string =>
  `histogram_quantile(0.99, sum by (le) (rate(adbreak_ads_response_duration_seconds_bucket[${window}])))`;
export const adsFillRatio = (): string => `avg(adbreak_ads_fill_ratio)`;
export const availSignalChain = (window = '10m'): string =>
  `sum(increase(adbreak_avail_signaled_total[${window}])) - sum(increase(adbreak_avail_manifested_total[${window}]))`;

/** Gap broken out by device x cdn — the slice that localises F07. */
export const gapByDeviceCdn = (window = '5m'): string =>
  `1 - (sum by (device_class, cdn) (increase(adbreak_beacon_fired_total{event="impression"}[${window}])) ` +
  `/ clamp_min(sum by (device_class, cdn) (increase(adbreak_beacon_expected_total{event="impression"}[${window}])), 1))`;
