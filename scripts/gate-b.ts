/**
 * Gate B: inject F07 and prove, from Grafana Cloud rather than from the box,
 * that revenue collapses for one device class while every delivery signal
 * stays green.
 *
 * Every read goes through the Grafana MCP server — the same path the agent
 * will use in Phase C, so this also proves that integration end to end.
 *
 *   npx tsx scripts/gate-b.ts
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHAOS = process.env.CHAOS ?? 'http://localhost:8086';
const PROM_UID = 'grafanacloud-prom';
const VICTIM = process.env.VICTIM ?? 'roku';

function env(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}
const E = env();

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run a batch of PromQL through the Grafana MCP server over stdio. */
function mcpQuery(exprs: string[]): Promise<(number | null)[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      [
        'run', '--rm', '-i',
        '-e', `GRAFANA_URL=${(E.GRAFANA_URL ?? '').replace(/\/$/, '')}`,
        '-e', `GRAFANA_SERVICE_ACCOUNT_TOKEN=${E.GRAFANA_SERVICE_ACCOUNT_TOKEN}`,
        'mcp/grafana', '-t', 'stdio',
      ],
      { stdio: ['pipe', 'pipe', 'ignore'] },
    );

    let buf = '';
    const values = new Map<number, number | null>();
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      for (const line of buf.split('\n')) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const msg = JSON.parse(line) as {
            id?: number;
            result?: { content?: { text?: string }[] };
          };
          if (typeof msg.id === 'number' && msg.id >= 2 && msg.result?.content) {
            const text = msg.result.content.map((c) => c.text ?? '').join('');
            const parsed = JSON.parse(text) as { data?: { value?: [number, string] }[] };
            const v = parsed.data?.[0]?.value?.[1];
            values.set(msg.id, v === undefined ? null : Number(v));
          }
        } catch {
          /* partial line */
        }
      }
      if (values.size === exprs.length) {
        child.kill();
        resolve(exprs.map((_, i) => values.get(i + 2) ?? null));
      }
    });
    child.on('error', reject);
    child.on('close', () => {
      if (values.size !== exprs.length) resolve(exprs.map((_, i) => values.get(i + 2) ?? null));
    });

    const msgs = [
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"gate-b","version":"1"}}}',
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
      ...exprs.map((expr, i) =>
        JSON.stringify({
          jsonrpc: '2.0',
          id: i + 2,
          method: 'tools/call',
          params: {
            name: 'query_prometheus',
            arguments: {
              datasourceUid: PROM_UID,
              expr,
              queryType: 'instant',
              startTime: 'now',
              endTime: 'now',
            },
          },
        }),
      ),
    ];
    child.stdin.write(msgs.join('\n') + '\n');
  });
}

// `> 0` on the denominator, never clamp_min with an epsilon: when nothing was
// expected in the window, the honest answer is "no data", not a ratio in the
// millions. An epsilon floor silently turns a quiet period into a fake spike.
const RRR = (dc: string) =>
  `sum(increase(adbreak_revenue_realized_usd_total{device_class="${dc}"}[5m])) / (sum(increase(adbreak_revenue_expected_usd_total{device_class="${dc}"}[5m])) > 0)`;
/**
 * The unaffected classes are judged over the SLO's own 15m window, not 5m.
 * Expected revenue is booked when a pod is decided; the matching impressions
 * land over the following ~45s. A 5m window holding a partial break therefore
 * reads ~0.85 on a perfectly healthy plant, which is noise, not a breach.
 * The victim is still measured at 5m because "did it collapse" is a detector
 * question and a short window answers it unambiguously.
 */
const RRR_OTHERS = `sum(increase(adbreak_revenue_realized_usd_total{device_class!="${VICTIM}"}[15m])) / (sum(increase(adbreak_revenue_expected_usd_total{device_class!="${VICTIM}"}[15m])) > 0)`;
const CDN_5XX = 'sum(increase(adbreak_cdn_requests_total{status=~"5.."}[5m])) or vector(0)';
const STITCH_ERR = 'sum(increase(adbreak_stitch_errors_total[5m])) or vector(0)';
const LEAK = 'sum(increase(adbreak_revenue_expected_usd_total[5m])) - sum(increase(adbreak_revenue_realized_usd_total[5m]))';

const fmt = (v: number | null) => (v === null ? 'no data' : v.toFixed(4));

async function main(): Promise<void> {
  console.log('Gate B — reading everything back out of Grafana Cloud via MCP.\n');

  // Clear anything a previous run left behind, then wait for the 5m rate
  // window to flush it out. Without this, a stale fault poisons the baseline
  // and the gate reports a collapse that was already there.
  await fetch(`${CHAOS}/inject`, { method: 'DELETE' }).catch(() => {});

  console.log('baseline (waiting for a clean 5m window)...');
  let rrrVictim0: number | null = null;
  let rrrOthers0: number | null = null;
  let cdn5xx0: number | null = null;
  // Wait for the whole plant to be healthy, not just the victim. A service
  // restart resets its counters while its peers keep climbing, so any window
  // straddling one undercounts and reads as a false breach — the 15m SLO
  // window needs a full 15m of undisturbed data before it means anything.
  const deadline = Date.now() + 20 * 60_000;
  for (;;) {
    [rrrVictim0, rrrOthers0, cdn5xx0] = await mcpQuery([RRR(VICTIM), RRR_OTHERS, CDN_5XX]);
    // Bound the ratio on BOTH sides. Realized can never legitimately exceed
    // expected, so anything above ~1.02 is proof the window is inconsistent —
    // typically a restart that dropped scheduled expectations while the
    // beacons they were paired with still arrived. Accepting it once let the
    // gate measure a corrupt baseline and report a negative revenue leak.
    const settled = (v: number | null) => v !== null && v > 0.9 && v < 1.02;
    const healthy = settled(rrrVictim0) && settled(rrrOthers0) && (cdn5xx0 ?? 1) === 0;
    if (healthy || Date.now() > deadline) break;
    console.log(
      `  ${VICTIM} RRR ${fmt(rrrVictim0)}, others ${fmt(rrrOthers0)}, 5xx ${fmt(cdn5xx0)} — waiting for a settled window...`,
    );
    await sleep(30_000);
  }

  check(
    'baseline: metrics are queryable from Grafana Cloud',
    rrrVictim0 !== null && rrrOthers0 !== null,
    `RRR ${VICTIM}=${fmt(rrrVictim0)}, others=${fmt(rrrOthers0)}, cdn 5xx=${fmt(cdn5xx0)}`,
  );
  check(
    'baseline: revenue is being realized, window consistent',
    (rrrVictim0 ?? 0) > 0.9 && (rrrVictim0 ?? 9) < 1.02,
    `${VICTIM} RRR ${fmt(rrrVictim0)} before any fault (must sit in 0.9..1.02)`,
  );

  console.log(`\ninjecting F07 (beacon blackhole, device_class=${VICTIM})...`);
  const injected = await fetch(`${CHAOS}/inject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fault: 'F07', params: { device_class: VICTIM }, duration_s: 420 }),
  }).then((r) => r.json() as Promise<{ injectionId: number }>);

  // Two breaks plus scrape and rate-window lag.
  console.log('waiting ~5m for two breaks to pass through the 5m rate window...\n');
  await sleep(300_000);

  const [rrrVictim, rrrOthers, cdn5xx, stitchErr, leak] = await mcpQuery([
    RRR(VICTIM),
    RRR_OTHERS,
    CDN_5XX,
    STITCH_ERR,
    LEAK,
  ]);

  check(
    `F07: RRR for ${VICTIM} collapses`,
    (rrrVictim ?? 1) < 0.2,
    `${VICTIM} RRR ${fmt(rrrVictim0)} -> ${fmt(rrrVictim)}`,
  );
  check(
    'F07: every other device class holds the SLO',
    (rrrOthers ?? 0) >= 0.98,
    `others RRR ${fmt(rrrOthers)} over the 15m SLO window (SLO 0.98)`,
  );
  check(
    'F07: delivery health stays green — zero CDN 5xx',
    (cdn5xx ?? 0) === 0,
    `cdn 5xx in the last 5m: ${fmt(cdn5xx)} — every delivery dashboard reads healthy`,
  );
  check('F07: no stitch errors', (stitchErr ?? 0) === 0, `stitch errors ${fmt(stitchErr)}`);
  check(
    'F07: the ledger counts the loss in dollars',
    (leak ?? 0) > 0,
    `revenue leaked in the last 5m: $${(leak ?? 0).toFixed(2)}`,
  );

  await fetch(`${CHAOS}/inject/${injected.injectionId}`, { method: 'DELETE' });
  console.log('\nfault cleared.');

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('GATE B: FAILED');
    process.exit(1);
  }
  console.log(
    'GATE B: PASSED — the stream is healthy in Grafana, and the money is gone in Grafana.',
  );
}

void main();
