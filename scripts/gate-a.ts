/**
 * Gate A: "an ad break plays end-to-end and produces a billable impression record."
 *
 * Runs against a live `docker compose up` stack, watches a real break, then
 * injects F07 (beacon blackhole on one device class) and proves the leak is
 * visible in the money metrics while delivery stays perfectly healthy.
 *
 *   npx tsx scripts/gate-a.ts
 */

const EDGE = process.env.EDGE ?? 'http://localhost:8084';
const PACKAGER = process.env.PACKAGER ?? 'http://localhost:8081';
const SSAI = process.env.SSAI ?? 'http://localhost:8083';
const PLAYOUT = process.env.PLAYOUT ?? 'http://localhost:8087';
const COLLECTOR = process.env.COLLECTOR ?? 'http://localhost:8085';
const DEMO_SESSION = 'gate-a-probe';

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = (url: string) => fetch(url).then((r) => r.text());
const json = <T>(url: string) => fetch(url).then((r) => r.json() as Promise<T>);

/** Sum a prometheus counter across series, optionally filtering by labels. */
async function metric(base: string, name: string, want: Record<string, string> = {}): Promise<number> {
  const body = await text(`${base}/metrics`);
  let total = 0;
  for (const line of body.split('\n')) {
    if (!line.startsWith(name + '{')) continue;
    const labels = line.slice(line.indexOf('{') + 1, line.lastIndexOf('}'));
    const matches = Object.entries(want).every(([k, v]) => labels.includes(`${k}="${v}"`));
    if (matches) total += Number(line.slice(line.lastIndexOf(' ') + 1));
  }
  return total;
}

async function nextSplice(): Promise<{ startMs: number; availId: string }> {
  const state = await json<{ nextSpliceTime: string }>(`${PLAYOUT}/admin/state`);
  return { startMs: Date.parse(state.nextSpliceTime), availId: '' };
}

async function main(): Promise<void> {
  console.log('Gate A — waiting for a live ad break...\n');

  const { startMs } = await nextSplice();
  const durationS = 32;
  const untilStart = startMs - Date.now();
  console.log(`next break at ${new Date(startMs).toISOString()} (${Math.round(untilStart / 1000)}s)\n`);

  // Keep the probe session alive so SSAI decides an ad pod for it too.
  const probe = setInterval(() => {
    void fetch(`${EDGE}/session/${DEMO_SESSION}/playlist.m3u8?device_class=web&region=us-east&cdn=cdn-east`, {
      headers: { 'X-Session': DEMO_SESSION, 'X-Device-Class': 'web', 'X-Cdn': 'cdn-east' },
    }).catch(() => {});
  }, 3000);

  // Cues are emitted 8s ahead of the splice, so sample after that, not before.
  await sleep(Math.max(0, untilStart - 4_000));

  // --- 1. the packager announced/marked the break -------------------------
  const marked = await text(`${PACKAGER}/content/live.m3u8`);
  check(
    'packager marks the avail (DATERANGE + SCTE35-OUT)',
    marked.includes('#EXT-X-DATERANGE') && marked.includes('SCTE35-OUT'),
    marked.split('\n').find((l) => l.includes('SCTE35-OUT'))?.slice(0, 96) ?? 'no marker found',
  );

  // --- 2. sample the personalized manifest across the whole break ---------
  const adUris = new Set<string>();
  let sawEnterBoundary = false;
  let sawReturnBoundary = false;
  let worstSeqSkew = 0;
  const seqOf = (p: string) => {
    const m = /#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(p);
    return m ? Number(m[1]) : undefined;
  };

  // Sample past the end of the break: the final ad segment only enters the live
  // window once the encoder has finished writing it, ~4s after its start time.
  const endMs = startMs + durationS * 1000;
  while (Date.now() < endMs + 12_000) {
    const [session, content] = await Promise.all([
      text(`${EDGE}/session/${DEMO_SESSION}/playlist.m3u8`),
      text(`${PACKAGER}/content/live.m3u8`),
    ]);
    // Both transitions need a discontinuity. A missing one on the way back to
    // content is what actually rebuffers players at the end of a break.
    const uris = session.split('\n').filter((l) => l.startsWith('/seg/') || l === '#EXT-X-DISCONTINUITY');
    for (const line of uris) if (line.startsWith('/seg/creatives/')) adUris.add(line);
    for (let i = 1; i < uris.length; i++) {
      if (uris[i - 1] !== '#EXT-X-DISCONTINUITY') continue;
      if (uris[i].startsWith('/seg/creatives/')) sawEnterBoundary = true;
      if (uris[i].startsWith('/seg/content/')) sawReturnBoundary = true;
    }
    const [a, b] = [seqOf(session), seqOf(content)];
    if (a !== undefined && b !== undefined) worstSeqSkew = Math.max(worstSeqSkew, Math.abs(a - b));
    await sleep(2000);
  }
  clearInterval(probe);

  check(
    'SSAI stitched a full pod (8 x 4s slots)',
    adUris.size === 8,
    `${adUris.size} distinct ad segments: ${[...adUris].map((u) => u.split('/').slice(-2).join('/')).join(', ')}`,
  );
  check(
    'discontinuity marked on both break boundaries',
    sawEnterBoundary && sawReturnBoundary,
    `content->ad ${sawEnterBoundary ? 'ok' : 'MISSING'}, ad->content ${sawReturnBoundary ? 'ok' : 'MISSING'}`,
  );
  // SSAI and the packager poll independently, so the personalized manifest can
  // legitimately sit one segment behind. Anything beyond that means the stitcher
  // is rewriting the sequence rather than substituting segments in place.
  check(
    'media sequence preserved (1:1 substitution)',
    worstSeqSkew <= 1,
    `worst MEDIA-SEQUENCE skew vs content manifest: ${worstSeqSkew} segment(s)`,
  );

  // --- 3. the billing record ---------------------------------------------
  await sleep(6000);
  const stats = await json<{ avails: { availId: string; sessions: number; byEvent: Record<string, number> }[] }>(
    `${COLLECTOR}/stats`,
  );
  const latest = stats.avails.at(-1);
  const fleetSessions = await metric(SSAI, 'adbreak_beacon_expected_total', { event: 'impression' });
  const events = latest?.byEvent ?? {};
  const six = ['impression', 'start', 'firstQuartile', 'midpoint', 'thirdQuartile', 'complete'];
  const complete = six.every((e) => (events[e] ?? 0) > 0 && events[e] === events.impression);

  check(
    'BILLABLE IMPRESSION RECORD exists for the avail',
    (latest?.sessions ?? 0) >= 190 && complete,
    `${latest?.availId}: ${latest?.sessions} sessions, ${events.impression ?? 0} impressions, all six events ${complete ? 'complete' : 'INCOMPLETE'}`,
  );

  // --- 4. steady-state gap -------------------------------------------------
  const expected = await metric(SSAI, 'adbreak_beacon_expected_total');
  const fired = await metric(COLLECTOR, 'adbreak_beacon_fired_total');
  const gap = expected > 0 ? 1 - fired / expected : 1;
  check(
    'impression gap < 5% with no fault injected',
    gap < 0.05,
    `expected ${expected}, fired ${fired}, gap ${(gap * 100).toFixed(1)}%`,
  );

  // --- 5. F07: beacon blackhole on roku ------------------------------------
  console.log('\ninjecting F07 (beacon blackhole, device_class=roku)...\n');
  await fetch(`${EDGE}/admin/faults`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pathClass: 'beacon', deviceClass: 'roku', action: 'blackhole' }),
  });

  const before = {
    rokuExpected: await metric(SSAI, 'adbreak_beacon_expected_total', { device_class: 'roku' }),
    rokuFired: await metric(COLLECTOR, 'adbreak_beacon_fired_total', { device_class: 'roku' }),
    otherExpected: await metric(SSAI, 'adbreak_beacon_expected_total'),
    otherFired: await metric(COLLECTOR, 'adbreak_beacon_fired_total'),
    cdn5xx: await metric(EDGE, 'adbreak_cdn_requests_total', { status: '503' }),
  };

  const nextBreak = (await nextSplice()).startMs;
  await sleep(Math.max(0, nextBreak - Date.now()) + durationS * 1000 + 12_000);

  const after = {
    rokuExpected: await metric(SSAI, 'adbreak_beacon_expected_total', { device_class: 'roku' }),
    rokuFired: await metric(COLLECTOR, 'adbreak_beacon_fired_total', { device_class: 'roku' }),
    otherExpected: await metric(SSAI, 'adbreak_beacon_expected_total'),
    otherFired: await metric(COLLECTOR, 'adbreak_beacon_fired_total'),
    cdn5xx: await metric(EDGE, 'adbreak_cdn_requests_total', { status: '503' }),
  };

  const dRokuExp = after.rokuExpected - before.rokuExpected;
  const dRokuFired = after.rokuFired - before.rokuFired;
  const rokuGap = dRokuExp > 0 ? 1 - dRokuFired / dRokuExp : 0;

  const dAllExp = after.otherExpected - before.otherExpected;
  const dAllFired = after.otherFired - before.otherFired;
  const dOtherExp = dAllExp - dRokuExp;
  const dOtherFired = dAllFired - dRokuFired;
  const otherGap = dOtherExp > 0 ? 1 - dOtherFired / dOtherExp : 1;

  check(
    'F07: roku impressions vanish',
    rokuGap > 0.9,
    `roku expected ${dRokuExp}, fired ${dRokuFired}, gap ${(rokuGap * 100).toFixed(1)}%`,
  );
  check(
    'F07: every other device class unaffected',
    otherGap < 0.1,
    `other expected ${dOtherExp}, fired ${dOtherFired}, gap ${(otherGap * 100).toFixed(1)}%`,
  );
  check(
    'F07: delivery health stays green (the whole point)',
    after.cdn5xx === before.cdn5xx,
    `CDN 5xx unchanged at ${after.cdn5xx} — every delivery dashboard would read healthy`,
  );

  await fetch(`${EDGE}/admin/faults`, { method: 'DELETE' });
  console.log('\nfaults cleared.\n');

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('GATE A: FAILED');
    process.exit(1);
  }
  console.log('GATE A: PASSED — an ad break plays end to end and produces a billable impression record.');
}

void main();
