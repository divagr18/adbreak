/**
 * Day 4 verification: every fault injects, changes the target's real state,
 * auto-reverts on schedule, and lands exactly two lines in the ground-truth log.
 *
 *   npx tsx scripts/chaos-smoke.ts
 */
import { readFileSync } from 'node:fs';

const CHAOS = process.env.CHAOS ?? 'http://localhost:8086';
const ADS = process.env.ADS ?? 'http://localhost:8082';
const EDGE = process.env.EDGE ?? 'http://localhost:8084';
const PLAYOUT = process.env.PLAYOUT ?? 'http://localhost:8087';
const GROUND_TRUTH = process.env.GROUND_TRUTH ?? 'D:/AdBreak/data/ground-truth.jsonl';

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = <T>(url: string) => fetch(url).then((r) => r.json() as Promise<T>);

const groundTruthLines = (): number => {
  try {
    return readFileSync(GROUND_TRUTH, 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
};

async function inject(fault: string, params: Record<string, unknown>, durationS: number) {
  const res = await fetch(`${CHAOS}/inject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fault, params, duration_s: durationS }),
  });
  if (!res.ok) throw new Error(`inject ${fault} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as { injectionId: number };
}

/**
 * Inject, assert the target actually changed, wait for auto-revert, assert it
 * changed back, and assert the ground-truth log gained exactly two lines.
 */
async function cycle(
  fault: string,
  params: Record<string, unknown>,
  probe: () => Promise<unknown>,
  changed: (before: unknown, during: unknown) => boolean,
): Promise<void> {
  const before = await probe();
  const linesBefore = groundTruthLines();

  await inject(fault, params, 3);
  const during = await probe();
  check(`${fault}: target state changes on inject`, changed(before, during), `${JSON.stringify(before)} -> ${JSON.stringify(during)}`);

  await sleep(4000);
  const after = await probe();
  check(
    `${fault}: auto-reverts when the injection expires`,
    JSON.stringify(after) === JSON.stringify(before),
    `back to ${JSON.stringify(after)}`,
  );
  check(
    `${fault}: ground truth records inject + expire`,
    groundTruthLines() - linesBefore === 2,
    `${groundTruthLines() - linesBefore} line(s) appended`,
  );
}

async function main(): Promise<void> {
  const catalog = await json<{ id: string }[]>(`${CHAOS}/faults`);
  check('catalog is self-describing', catalog.length >= 7, `${catalog.map((f) => f.id).join(', ')}`);

  const adsKnob = (k: string) => async () => ((await json<Record<string, number>>(`${ADS}/admin/knobs`))[k]);
  const edgeFaultCount = async () => (await json<unknown[]>(`${EDGE}/admin/faults`)).length;

  await cycle('F03', { latency_ms: 4000 }, adsKnob('latency_ms'), (a, b) => a !== b && b === 4000);
  await cycle('F04', { fill_rate: 0 }, adsKnob('fill_rate'), (a, b) => a !== b && b === 0);
  await cycle('F09', { max_pod_ratio: 0.5 }, adsKnob('max_pod_ratio'), (a, b) => a !== b && b === 0.5);
  await cycle('F07', { device_class: 'roku' }, edgeFaultCount, (a, b) => (b as number) > (a as number));
  await cycle('F08', { cdn: 'cdn-west' }, edgeFaultCount, (a, b) => (b as number) > (a as number));

  // F01/F02 are one-shot (a cue is simply never emitted), so they have no
  // revert; assert the counter was armed rather than a state round-trip.
  const before = (await json<{ suppressRemaining: number }>(`${PLAYOUT}/admin/state`)).suppressRemaining;
  await inject('F01', { count: 1 }, 0);
  const during = (await json<{ suppressRemaining: number }>(`${PLAYOUT}/admin/state`)).suppressRemaining;
  check('F01: playout suppression armed', during === before + 1, `suppressRemaining ${before} -> ${during}`);

  // Leave the plant clean.
  await fetch(`${CHAOS}/inject`, { method: 'DELETE' });
  await fetch(`${EDGE}/admin/faults`, { method: 'DELETE' });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('CHAOS SMOKE: FAILED');
    process.exit(1);
  }
  console.log('CHAOS SMOKE: PASSED');
}

void main();
