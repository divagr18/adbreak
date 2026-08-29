import { describe, expect, it } from 'vitest';

/**
 * Mirrors the retarget helper in index.ts. Kept as a standalone copy because
 * importing index.ts would boot the whole service (tracing, Redis, timers).
 */
function retarget(
  tracking: Record<string, string>,
  availId: string,
  sessionId: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(tracking).map(([ev, url]) => {
      const u = new URL(url);
      u.searchParams.set('availId', availId);
      u.searchParams.set('session', sessionId);
      return [ev, u.toString()];
    }),
  );
}

/** The collector's dedupe key, from beacon-collector/src/index.ts. */
const dedupeKey = (url: string): string => {
  const q = new URL(url).searchParams;
  return ['session', 'availId', 'pos', 'creative', 'event'].map((k) => q.get(k)).join('|');
};

const cached = {
  impression:
    'http://edge:3000/beacon?event=impression&session=sess-0001&availId=avail-OLD&creative=ad-b&pos=0',
  complete:
    'http://edge:3000/beacon?event=complete&session=sess-0001&availId=avail-OLD&creative=ad-b&pos=0',
};

describe('retargeting a cached pod', () => {
  it('points the beacons at the break being served now', () => {
    const out = retarget(cached, 'avail-NEW', 'sess-0042');
    const q = new URL(out.impression).searchParams;
    expect(q.get('availId')).toBe('avail-NEW');
    expect(q.get('session')).toBe('sess-0042');
  });

  it('preserves everything the billing record is keyed on besides those two', () => {
    const out = retarget(cached, 'avail-NEW', 'sess-0042');
    const q = new URL(out.impression).searchParams;
    expect(q.get('creative')).toBe('ad-b');
    expect(q.get('pos')).toBe('0');
    expect(q.get('event')).toBe('impression');
  });

  /**
   * The trap: replaying a cached pod verbatim collides with the dedupe key of
   * the break it was cached from, so every beacon is discarded and the
   * remediation earns nothing while appearing to work.
   */
  it('produces a dedupe key that does not collide with the cached break', () => {
    expect(dedupeKey(cached.impression)).toBe('sess-0001|avail-OLD|0|ad-b|impression');
    const out = retarget(cached, 'avail-NEW', 'sess-0042');
    expect(dedupeKey(out.impression)).toBe('sess-0042|avail-NEW|0|ad-b|impression');
    expect(dedupeKey(out.impression)).not.toBe(dedupeKey(cached.impression));
  });

  it('keeps distinct events distinct after retargeting', () => {
    const out = retarget(cached, 'avail-NEW', 'sess-0042');
    expect(dedupeKey(out.impression)).not.toBe(dedupeKey(out.complete));
  });
});
