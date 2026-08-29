/**
 * Ask the same Prometheus the agent reads, from the host.
 *
 * Every gate failure so far has come down to one question — what did this
 * metric actually say at the time? — and answering it meant guessing from raw
 * counters or reading it out of a run record after the fact. This asks
 * directly, through the Grafana datasource proxy with the credentials in .env.
 *
 *   npx tsx scripts/q.ts 'sum(rate(adbreak_cdn_requests_total[5m]))'
 *   npx tsx scripts/q.ts health          # the named checks below
 *   npx tsx scripts/q.ts baseline roku   # what a runbook's preconditions read
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function env(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const E = env();
const GRAFANA = (E.GRAFANA_URL ?? '').replace(/\/$/, '');
const TOKEN = E.GRAFANA_SERVICE_ACCOUNT_TOKEN;
const PROM_UID = process.env.PROM_UID ?? 'grafanacloud-prom';
if (!GRAFANA || !TOKEN) throw new Error('GRAFANA_URL / GRAFANA_SERVICE_ACCOUNT_TOKEN missing from .env');

interface PromResult {
  status: string;
  data?: { result?: { metric: Record<string, string>; value: [number, string] }[] };
  error?: string;
}

export async function query(expr: string): Promise<{ metric: Record<string, string>; value: number }[]> {
  const url =
    `${GRAFANA}/api/datasources/proxy/uid/${PROM_UID}/api/v1/query` +
    `?query=${encodeURIComponent(expr)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const body = (await res.json()) as PromResult;
  if (!res.ok || body.status !== 'success') {
    throw new Error(`query failed: ${body.error ?? res.status} — ${expr}`);
  }
  return (body.data?.result ?? []).map((r) => ({ metric: r.metric, value: Number(r.value[1]) }));
}

/** A single number, or null when the series does not exist. */
export async function scalar(expr: string): Promise<number | null> {
  const rows = await query(expr);
  return rows.length ? rows[0].value : null;
}

const fmt = (v: number | null): string => (v === null ? 'no data' : v.toFixed(4));

const gap = (sel: string, window = '5m'): string =>
  `1 - (sum(increase(adbreak_beacon_fired_total{event="impression",${sel}}[${window}])) / ` +
  `clamp_min(sum(increase(adbreak_beacon_expected_total{event="impression",${sel}}[${window}])), 1))`;

/** Is the plant quiet enough to measure against? */
async function health(): Promise<void> {
  const checks: [string, string, (v: number | null) => boolean][] = [
    ['RRR (15m)',
      'sum(increase(adbreak_revenue_realized_usd_total[15m])) / (sum(increase(adbreak_revenue_expected_usd_total[15m])) > 0)',
      (v) => v !== null && v > 0.9 && v < 1.02],
    ['CDN 5xx (5m)', 'sum(increase(adbreak_cdn_requests_total{status=~"5.."}[5m])) or vector(0)', (v) => (v ?? 1) === 0],
    ['stitch errors (5m)', 'sum(increase(adbreak_stitch_errors_total[5m])) or vector(0)', (v) => (v ?? 1) === 0],
    ['no-fill rate (5m)',
      '(sum(increase(adbreak_ads_nofill_total[5m])) or vector(0)) / clamp_min(sum(increase(adbreak_ads_request_total[5m])), 1)',
      (v) => (v ?? 1) < 0.01],
    ['pod seconds filled', 'avg(adbreak_ads_fill_ratio)', (v) => v !== null && v > 0.8],
    ['impression gap, all devices', gap('device_class=~".+"'), (v) => v !== null && v < 0.1],
  ];
  let allOk = true;
  for (const [name, expr, ok] of checks) {
    const v = await scalar(expr).catch(() => null);
    const good = ok(v);
    allOk &&= good;
    console.log(`${good ? 'ok  ' : 'BAD '} ${name.padEnd(28)} ${fmt(v)}`);
  }
  console.log(allOk ? '\nplant is settled — safe to measure' : '\nplant is NOT settled — wait before measuring');
  if (!allOk) process.exitCode = 1;
}

/**
 * What rb-beacon-fallback's preconditions read right now.
 *
 * scoped_not_global has the least margin of any precondition in the system
 * (other device classes must be under 0.1), so it is worth being able to see
 * how close the healthy baseline actually sits to that line.
 */
async function baseline(device: string): Promise<void> {
  const rows: [string, string][] = [
    // 3m because that is the window the runbook declares. Reporting these at
    // the 5m default would show the operator a number the agent never reads -
    // and increase() over bursty counters is measurably window-sensitive, so
    // the difference is not cosmetic.
    [`gap for ${device} (gap_is_real, needs > 0.4)`, gap(`device_class="${device}"`, '3m')],
    [`gap for others (scoped_not_global, needs < 0.1)`, gap(`device_class!="${device}"`, '3m')],
    ['no-fill rate (fill_collapsed, needs > 0.5)',
      '(sum(increase(adbreak_ads_nofill_total[5m])) or vector(0)) / clamp_min(sum(increase(adbreak_ads_request_total[5m])), 1)'],
    ['cdn 5xx (delivery_healthy, needs == 0)', 'sum(increase(adbreak_cdn_requests_total{status=~"5.."}[5m])) or vector(0)'],
    ['ads fallback ready (needs == 1)', 'max(adbreak_ssai_ads_fallback_ready)'],
  ];
  for (const [name, expr] of rows) console.log(`${name.padEnd(48)} ${fmt(await scalar(expr).catch(() => null))}`);

  console.log('\nper device class:');
  for (const r of await query(gap('device_class=~".+"').replace('sum(', 'sum by (device_class) (').replace('sum(', 'sum by (device_class) ('))) {
    console.log(`  ${(r.metric.device_class ?? '?').padEnd(10)} ${r.value.toFixed(4)}`);
  }
}

async function main(): Promise<void> {
  const [arg, ...rest] = process.argv.slice(2);
  if (!arg) return void console.log('usage: npx tsx scripts/q.ts <promql | health | baseline [device]>');
  if (arg === 'health') return health();
  if (arg === 'baseline') return baseline(rest[0] ?? 'roku');

  for (const r of await query([arg, ...rest].join(' '))) {
    const labels = Object.entries(r.metric)
      .filter(([k]) => k !== '__name__')
      .map(([k, v]) => `${k}="${v}"`)
      .join(',');
    console.log(`${labels || '(no labels)'}  ${r.value}`);
  }
}

// Only run as a CLI. The gates import query()/scalar() from here so there is
// one definition of "ask the plant", not a copy per script.
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) void main();
