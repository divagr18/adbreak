/**
 * Ask the same Prometheus the agent reads, from the host.
 *
 * Every gate failure so far has come down to one question — what did this
 * metric actually say at the time? — and answering it meant guessing from raw
 * counters or reading it out of a run record after the fact. This asks
 * directly, through the Grafana datasource proxy with the credentials in .env.
 *
 * Every expression here is the one the agent itself issues (see
 * agent/src/tools/metrics.ts). A diagnostic tool that measures something
 * slightly different from the thing under test is worse than none: it sends
 * you looking for faults that exist only in the gap between the two.
 *
 *   npx tsx scripts/q.ts 'sum(rate(adbreak_cdn_requests_total[5m]))'
 *   npx tsx scripts/q.ts health          # is the plant safe to measure against
 *   npx tsx scripts/q.ts baseline roku   # what each runbook precondition reads
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// The agent's own expressions, imported rather than restated. Duplicating this
// PromQL as strings let the harness and the agent drift apart three times in
// one session - most recently the settle checks were still computing the gap as
// an offset delta hours after the agent had moved back to increase().
import {
  cdn5xx,
  impressionGap,
  impressionGapAll,
  impressionGapOthers,
  adsNoFillRate,
  availUnfilledRate,
  adsFallbackReady,
  adsFillRatio,
  gapByDeviceCdn,
  rrr,
  stitchErrors,
} from '../packages/agent/src/tools/metrics.js';

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
if (!GRAFANA || !TOKEN) {
  throw new Error('GRAFANA_URL / GRAFANA_SERVICE_ACCOUNT_TOKEN missing from .env');
}

interface PromResult {
  status: string;
  data?: { result?: { metric: Record<string, string>; value: [number, string] }[] };
  error?: string;
}

export async function query(
  expr: string,
): Promise<{ metric: Record<string, string>; value: number }[]> {
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


/** Is the plant quiet enough to measure against? */
function healthChecks(): [string, string, (v: number | null) => boolean][] {
  return [
    [
      'RRR (15m)',
      rrr(),
      (v) => v !== null && v > 0.9 && v < 1.02,
    ],
    ['CDN 5xx (5m)', cdn5xx(), (v) => (v ?? 1) === 0],
    ['stitch errors (5m)', stitchErrors(), (v) => (v ?? 1) === 0],
    ['no-fill rate', adsNoFillRate(), (v) => (v ?? 1) < 0.01],
    ['avails unfilled', availUnfilledRate(), (v) => (v ?? 1) < 0.05],
    ['pod seconds filled', adsFillRatio(), (v) => v !== null && v > 0.8],
    // 10m: five whole breaks, and the steadiest window measured. A settle
    // check that flaps on a healthy plant is how the last Gate D run sat in
    // its own wait loop for fifteen minutes.
    // 10m: five whole breaks, the steadiest window measured.
    ['impression gap, all devices', impressionGapAll('10m'), (v) => v !== null && Math.abs(v) < 0.05],
  ];
}

/** The same checks, silently — for the wait loop. */
async function isHealthy(): Promise<boolean> {
  for (const [, expr, ok] of healthChecks()) {
    if (!ok(await scalar(expr).catch(() => null))) return false;
  }
  return true;
}

async function health(): Promise<void> {
  let allOk = true;
  for (const [name, expr, ok] of healthChecks()) {
    const v = await scalar(expr).catch(() => null);
    const good = ok(v);
    allOk &&= good;
    console.log(`${good ? 'ok  ' : 'BAD '} ${name.padEnd(28)} ${fmt(v)}`);
  }
  console.log(
    allOk ? '\nplant is settled — safe to measure' : '\nplant is NOT settled — wait before measuring',
  );
  if (!allOk) process.exitCode = 1;
}

/**
 * What each runbook precondition reads right now.
 *
 * At the window the runbook itself declares (4m), not a convenient default —
 * showing the operator a number the agent never reads is how you end up
 * debugging the difference between two measurements instead of the system.
 */
async function baseline(device: string): Promise<void> {
  const rows: [string, string][] = [
    [`gap for ${device} (gap_is_real, needs > 0.4)`, impressionGap(device)],
    ['gap for others', impressionGapOthers(device)],
    ['avails unfilled (fill_collapsed, needs > 0.25)', availUnfilledRate()],
    ['no-fill rate (corroborates F04)', adsNoFillRate()],
    ['cdn 5xx (delivery_healthy, needs == 0)', cdn5xx()],
    ['ads fallback ready (needs == 1)', adsFallbackReady()],
  ];
  for (const [name, expr] of rows) {
    console.log(`${name.padEnd(48)} ${fmt(await scalar(expr).catch(() => null))}`);
  }

  console.log('\nper device class:');
  // The agent's own slice table, grouped by device and cdn.
  for (const r of (await query(gapByDeviceCdn())).sort((a, b) => b.value - a.value)) {
    const label = `${r.metric.device_class ?? '?'}/${r.metric.cdn ?? '?'}`;
    console.log(`  ${label.padEnd(20)} ${r.value.toFixed(4)}`);
  }
}

/**
 * Wait until the plant reads healthy CONSECUTIVELY, not once.
 *
 * A plant recovering from a fault oscillates across the boundary - impressions
 * arrive for expectations booked during the outage, so the gap swings negative
 * and RRR overshoots above 1 before settling. A settle loop that stops at the
 * first passing sample will happily start a gate on that, and one sample of a
 * periodic system is not evidence.
 */
async function waitHealthy(needed = 3, maxMinutes = 25): Promise<void> {
  const deadline = Date.now() + maxMinutes * 60_000;
  let streak = 0;
  while (Date.now() < deadline) {
    const ok = await isHealthy();
    streak = ok ? streak + 1 : 0;
    console.log(`  ${new Date().toISOString().slice(11, 19)}  ${ok ? 'healthy' : 'not yet'}  (${streak}/${needed})`);
    if (streak >= needed) {
      console.log('plant is settled — safe to measure');
      return;
    }
    await new Promise((r) => setTimeout(r, 45_000));
  }
  console.log('gave up waiting — the plant never settled');
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const [arg, ...rest] = process.argv.slice(2);
  if (!arg) {
    console.log('usage: npx tsx scripts/q.ts <promql | health | wait | baseline [device]>');
    return;
  }
  if (arg === 'health') return health();
  if (arg === 'wait') return waitHealthy(Number(rest[0] ?? 3));
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
