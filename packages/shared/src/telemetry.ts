/**
 * The frozen telemetry contract (VISION.md §8).
 * Metric names and label sets are defined ONCE here. Never inline a metric
 * name in a service — import it, so the pipeline and the agent always agree.
 */

export const METRICS = {
  // Signal chain integrity
  availSignaled: {
    name: 'adbreak_avail_signaled_total',
    help: 'Avails signaled by playout (SCTE-35 cues emitted)',
    labels: ['channel', 'region', 'break_type'] as const,
  },
  availManifested: {
    name: 'adbreak_avail_manifested_total',
    help: 'Avails whose markers reached the content manifest',
    labels: ['channel', 'region', 'packager'] as const,
  },
  availDecided: {
    name: 'adbreak_avail_decided_total',
    help: 'Avails for which the ADS returned a usable pod',
    labels: ['channel', 'region', 'ads'] as const,
  },
  availUnfilled: {
    /**
     * Avails the stitcher could not fill, by cause. The operator-relevant
     * signal, and the only one that covers every way an ad break comes up
     * empty: an empty VAST (F04), a response that arrived after the deadline
     * (F03), or an outright error. adbreak_ads_nofill_total sees only the
     * first, because on a latency spike the ad server does eventually answer -
     * just too late to be of any use.
     */
    name: 'adbreak_avail_unfilled_total',
    help: 'Avails the stitcher could not fill with a usable pod, by cause',
    labels: ['channel', 'region', 'reason'] as const,
  },

  // Ad decisioning
  adsRequest: {
    name: 'adbreak_ads_request_total',
    help: 'VAST requests made to the ad decision server',
    labels: ['ads', 'region', 'device_class'] as const,
  },
  adsResponseDuration: {
    name: 'adbreak_ads_response_duration_seconds',
    help: 'ADS response latency',
    labels: ['ads', 'region'] as const,
    buckets: [0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1, 1.5, 2, 3, 5],
    // Exemplars: a p99 spike here links to the trace of the offending avail.
    enableExemplars: true,
  },
  adsFillRatio: {
    name: 'adbreak_ads_fill_ratio',
    // Seconds, not decisions. A healthy 28s pod against a 32s avail sits at
    // 0.875 forever, so this is the F09 underfill signal and must never be
    // read as a no-fill rate - see adsNoFill.
    help: 'Fraction of requested pod SECONDS filled by the ADS (duration underfill; healthy baseline is below 1)',
    labels: ['ads', 'region'] as const,
  },
  adsNoFill: {
    // The unambiguous F04 signal. Without it the only evidence of no-fill was
    // adsFillRatio, which is below 1 even on a perfectly healthy plant - and
    // the agent duly refuted its own correct diagnosis on the strength of it.
    name: 'adbreak_ads_nofill_total',
    help: 'Ad requests answered with an empty VAST (no-fill)',
    labels: ['ads', 'region'] as const,
  },
  adsPodDuration: {
    name: 'adbreak_ads_pod_duration_seconds',
    help: 'Returned pod duration vs requested avail duration',
    labels: ['ads', 'region'] as const,
  },

  // Stitch & delivery
  stitchErrors: {
    name: 'adbreak_stitch_errors_total',
    help: 'SSAI manifest stitch failures',
    labels: ['reason', 'device_class'] as const,
  },
  slateSeconds: {
    name: 'adbreak_slate_seconds_total',
    help: 'Seconds of slate inserted instead of paid ads',
    labels: ['channel', 'region', 'reason'] as const,
  },
  cdnRequests: {
    name: 'adbreak_cdn_requests_total',
    help: 'Requests through the CDN edge',
    labels: ['pop', 'status', 'path_class'] as const,
  },
  manifestLatency: {
    name: 'adbreak_manifest_latency_seconds',
    help: 'Personalized manifest generation latency',
    labels: ['pop', 'device_class'] as const,
    buckets: [0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1],
  },

  // The money
  beaconExpected: {
    name: 'adbreak_beacon_expected_total',
    help: 'Tracking beacons the fleet should fire (per quartile event)',
    labels: ['event', 'device_class', 'cdn', 'isp', 'region'] as const,
  },
  beaconFired: {
    name: 'adbreak_beacon_fired_total',
    help: 'Tracking beacons actually received by the collector',
    labels: ['event', 'device_class', 'cdn', 'isp', 'region'] as const,
    // Exemplars: a revenue gap links to the trace of the break behind it.
    enableExemplars: true,
  },
  impressionGapRatio: {
    name: 'adbreak_impression_gap_ratio',
    help: '1 - fired/expected impressions over the rolling window',
    labels: ['device_class', 'cdn', 'region'] as const,
  },
  // device_class is on both sides deliberately: without it the RRR SLO cannot
  // see a single device class collapse, which is the entire F07 detection story.
  revenueExpected: {
    name: 'adbreak_revenue_expected_usd_total',
    help: 'Expected revenue from signaled avails (deterministic)',
    labels: ['channel', 'region', 'advertiser', 'device_class'] as const,
  },
  revenueRealized: {
    name: 'adbreak_revenue_realized_usd_total',
    help: 'Realized revenue from confirmed billable impressions',
    labels: ['channel', 'region', 'advertiser', 'device_class'] as const,
  },
  revenueLeak: {
    name: 'adbreak_revenue_leak_usd_total',
    help: 'Dollars leaked, attributed to a failure class',
    labels: ['channel', 'region', 'failure_class'] as const,
  },

  // THE SLO
  rrr: {
    name: 'adbreak_rrr',
    help: 'Revenue Realization Ratio: realized/expected, 5m rolling',
    labels: ['channel', 'region', 'device_class'] as const,
  },
} as const;

export const DEVICE_CLASSES = ['roku', 'firetv', 'ios', 'android', 'web', 'smarttv'] as const;
export type DeviceClass = (typeof DEVICE_CLASSES)[number];

export const REGIONS = ['us-east', 'us-west', 'eu'] as const;
export type Region = (typeof REGIONS)[number];

export const CDNS = ['cdn-east', 'cdn-west'] as const;
export type Cdn = (typeof CDNS)[number];

export const BEACON_EVENTS = [
  'impression',
  'start',
  'firstQuartile',
  'midpoint',
  'thirdQuartile',
  'complete',
] as const;
export type BeaconEvent = (typeof BEACON_EVENTS)[number];

/** Beacon events that are billable when quartile-verified. */
export const BILLABLE_EVENT: BeaconEvent = 'impression';
