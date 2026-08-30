/**
 * The PromQL the deterministic steps issue. Kept in one place so detection,
 * verification and the gate script can never disagree about what "the gap" or
 * "the SLO" actually means.
 */

/**
 * Share of billable impressions that never arrived, over a window.
 *
 * Two properties here were chosen from measurement on a settled plant, not
 * from reasoning - an earlier round of reasoning about this got it wrong twice.
 *
 * First, an exact counter delta rather than `increase()`. increase()
 * extrapolates to the window edges, which is fine for smooth counters and
 * wrong for these: impressions arrive in a burst every 120s. Sampled ten times
 * on a healthy plant, increase() never once read zero, drifting between -0.41
 * and +0.22; the delta form read exactly zero in five of eight samples.
 *
 * Second, the window must be a whole multiple of the 120s break cadence.
 * Measured over seven samples with nothing wrong: 4m ranged 0.009 and 10m
 * ranged 0.025, while 3m ranged 0.759 and 5m ranged 0.405. A partial break at
 * the window edge contributes its expectations before its impressions land.
 * The old 3m precondition window was the worst available choice.
 *
 * The `or vector(0)` guards matter after a restart: a bare subtraction against
 * a series that did not exist one window ago yields no data, and a null gap
 * reads as "no fault" - which would silently block a correct remediation.
 */
const gapExpr = (selector: string, window: string): string =>
  `1 - (((sum(adbreak_beacon_fired_total{event="impression"${selector}}) or vector(0)) - ` +
  `(sum(adbreak_beacon_fired_total{event="impression"${selector}} offset ${window}) or vector(0))) / ` +
  `clamp_min((sum(adbreak_beacon_expected_total{event="impression"${selector}}) or vector(0)) - ` +
  `(sum(adbreak_beacon_expected_total{event="impression"${selector}} offset ${window}) or vector(0)), 1))`;

export const impressionGap = (deviceClass: string, window = '4m'): string =>
  gapExpr(`,device_class="${deviceClass}"`, window);

/** Same, for everything except one device class — proves a fault is scoped. */
export const impressionGapOthers = (deviceClass: string, window = '4m'): string =>
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
/**
 * Window is 2m, not 5m, and that is a diagnosis-critical choice.
 *
 * ads_fill_ratio is a gauge: when the ad server stops filling, it collapses to
 * zero instantly. This is a windowed rate, so over 5m a TOTAL no-fill still
 * reads only 0.33 after 100 seconds. Presented side by side, the model
 * reasonably weights the signal that already looks extreme and calls a total
 * no-fill "underfill" - it diagnosed F09 instead of F04 twice for exactly this
 * reason. Two minutes is one whole break's worth of ad requests, around 200
 * samples, and reaches the true rate while the incident is still young.
 */
export const adsNoFillRate = (window = '2m'): string =>
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
export const gapByDeviceCdn = (window = '4m'): string =>
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

/**
 * Is this fault scoped to one device class, or is everything bleeding?
 *
 * A ratio, not a threshold on the others' absolute gap, because scoping is a
 * comparison and only a comparison survives common-mode error. A break still in
 * flight at the window edge has booked its expectations but not yet landed its
 * impressions, which lifts EVERY slice at once - it pushed the healthy slices
 * to 0.25 and blocked a correct F07 remediation whose own gap was 1.0. Dividing
 * cancels exactly that: the numerator and denominator are lifted together.
 *
 * Near 0 means the fault is confined to the affected class. Near 1 means every
 * class is losing impressions equally, which is not a scoped fault and must not
 * be treated as one.
 */
export const gapScopeRatio = (deviceClass: string, window = '4m'): string =>
  `(${impressionGapOthers(deviceClass, window)}) / clamp_min(${impressionGap(deviceClass, window)}, 0.01)`;
