/**
 * The PromQL the deterministic steps issue. Kept in one place so detection,
 * verification and the gate script can never disagree about what "the gap" or
 * "the SLO" actually means.
 */

/**
 * Share of billable impressions that never arrived, over a window.
 *
 * Built from an exact counter delta (`now - offset`) rather than `increase()`,
 * and the difference is not academic. `increase()` extrapolates the rate to the
 * window edges, which is fine for smooth counters and badly wrong for these:
 * impressions land in a burst every 120s, so a 3m window that happens to catch
 * two bursts of expected against one of fired swings the ratio by a third. It
 * was measured reading 0.000 for healthy device classes and 0.285 two minutes
 * later with nothing wrong, which is more than enough to block a correct
 * remediation on the scoped_not_global precondition.
 *
 * An offset delta does no extrapolation at all. Numerator and denominator are
 * booked at the same instants - the impression beacon fires at the spot
 * boundary the expectation was booked against - so what edge effect remains
 * cancels between them.
 */
const gapExpr = (selector: string, window: string): string =>
  `1 - ((sum(adbreak_beacon_fired_total{event="impression"${selector}}) - ` +
  `sum(adbreak_beacon_fired_total{event="impression"${selector}} offset ${window})) / ` +
  `clamp_min(sum(adbreak_beacon_expected_total{event="impression"${selector}}) - ` +
  `sum(adbreak_beacon_expected_total{event="impression"${selector}} offset ${window}), 1))`;

export const impressionGap = (deviceClass: string, window = '2m'): string =>
  gapExpr(`,device_class="${deviceClass}"`, window);

/** Same, for everything except one device class — proves a fault is scoped. */
export const impressionGapOthers = (deviceClass: string, window = '2m'): string =>
  gapExpr(`,device_class!="${deviceClass}"`, window);

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
/**
 * Pod SECONDS filled. Below 1 on a healthy plant (a 28s pod in a 32s avail),
 * so this is the underfill signal - not evidence that the ad server is failing
 * to return ads. For that, use adsNoFillRate.
 */
export const adsFillRatio = (): string => `avg(adbreak_ads_fill_ratio)`;

/** Fraction of ad requests answered with an empty VAST. Zero on a healthy plant. */
export const adsNoFillRate = (window = '5m'): string =>
  // An exact counter delta, for the same reason as the impression gap:
  // increase() extrapolates, and needs two points in the window before it says
  // anything useful. The ads service publishes this series at zero on startup
  // so the offset side always exists, which is what makes a fault visible from
  // the first scrape after it begins rather than two minutes later.
  `((sum(adbreak_ads_nofill_total) or vector(0)) - ` +
  `(sum(adbreak_ads_nofill_total offset ${window}) or vector(0))) / ` +
  `clamp_min(sum(adbreak_ads_request_total) - sum(adbreak_ads_request_total offset ${window}), 1)`;
export const availSignalChain = (window = '10m'): string =>
  `sum(increase(adbreak_avail_signaled_total[${window}])) - sum(increase(adbreak_avail_manifested_total[${window}]))`;

/** Gap broken out by device x cdn — the slice that localises F07. */
/** The slice table the agent localises a fault from. Same delta, grouped. */
export const gapByDeviceCdn = (window = '5m'): string =>
  `1 - ((sum by (device_class, cdn) (adbreak_beacon_fired_total{event="impression"}) - ` +
  `sum by (device_class, cdn) (adbreak_beacon_fired_total{event="impression"} offset ${window})) / ` +
  `clamp_min(sum by (device_class, cdn) (adbreak_beacon_expected_total{event="impression"}) - ` +
  `sum by (device_class, cdn) (adbreak_beacon_expected_total{event="impression"} offset ${window}), 1))`;

/** Slate seconds per second — how fast unsold inventory is accumulating. */
export const slateSecondsRate = (window = '2m'): string =>
  `sum(rate(adbreak_slate_seconds_total[${window}]))`;

/** 1 when the SSAI holds a cached pod it could fall back to. */
export const adsFallbackReady = (): string => `max(adbreak_ssai_ads_fallback_ready) or vector(0)`;

/**
 * Raw counters, for delta-based verification.
 *
 * A sliding-window gap still contains the incident for the length of the
 * window, so it cannot show recovery until the bad break ages out. Comparing
 * counter deltas taken since the moment of remediation measures only what has
 * happened SINCE the fix, which is the actual question being asked.
 */
export const impressionsFired = (deviceClass?: string): string => {
  const sel = deviceClass ? `,device_class="${deviceClass}"` : '';
  return `sum(adbreak_beacon_fired_total{event="impression"${sel}})`;
};
export const impressionsExpected = (deviceClass?: string): string => {
  const sel = deviceClass ? `,device_class="${deviceClass}"` : '';
  return `sum(adbreak_beacon_expected_total{event="impression"${sel}})`;
};
