import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { injectMarkers, type CueState } from './rewrite.js';

const T0 = Date.parse('2026-08-27T12:00:00.000Z');

function makePlaylist(startMs: number, count: number, seq = 100): string {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    '#EXT-X-TARGETDURATION:4',
    `#EXT-X-MEDIA-SEQUENCE:${seq}`,
    '#EXT-X-INDEPENDENT-SEGMENTS',
  ];
  for (let i = 0; i < count; i++) {
    lines.push('#EXTINF:4.000000,');
    lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(startMs + i * 4000).toISOString()}`);
    lines.push(`seg_${String(seq + i).padStart(6, '0')}.ts`);
  }
  return lines.join('\n');
}

function cue(spliceTimeMs: number, durationS = 12): CueState {
  return {
    availId: `avail-test-${spliceTimeMs}`,
    spliceTimeMs,
    durationS,
    scte35Out: 'fc0025aa',
    scte35In: 'fc0020bb',
  };
}

const lineAfter = (lines: string[], pred: (l: string) => boolean, offset = 1) => {
  const i = lines.findIndex(pred);
  expect(i).toBeGreaterThanOrEqual(0);
  return lines[i + offset];
};

describe('injectMarkers', () => {
  it('places OUT marker directly before the boundary segment', () => {
    // splice exactly at segment 2's PDT
    const { playlist, manifested } = injectMarkers(makePlaylist(T0, 10), [cue(T0 + 8000)]);
    const lines = playlist.split('\n');
    expect(manifested).toEqual([`avail-test-${T0 + 8000}`]);
    expect(lineAfter(lines, (l) => l.startsWith('#EXT-X-CUE-OUT'), 1)).toBe('#EXTINF:4.000000,');
    expect(lineAfter(lines, (l) => l.startsWith('#EXT-X-CUE-OUT'), 2)).toContain(
      new Date(T0 + 8000).toISOString(),
    );
    expect(lines.find((l) => l.startsWith('#EXT-X-DATERANGE'))).toContain('SCTE35-OUT=0xFC0025AA');
  });

  it('rounds a mid-segment splice forward to the next segment boundary', () => {
    const { playlist } = injectMarkers(makePlaylist(T0, 10), [cue(T0 + 6000)]);
    const lines = playlist.split('\n');
    expect(lineAfter(lines, (l) => l.startsWith('#EXT-X-CUE-OUT'), 2)).toContain(
      new Date(T0 + 8000).toISOString(),
    );
  });

  it('places CUE-IN duration seconds later', () => {
    const { playlist } = injectMarkers(makePlaylist(T0, 10), [cue(T0 + 8000, 12)]);
    const lines = playlist.split('\n');
    expect(lineAfter(lines, (l) => l === '#EXT-X-CUE-IN', 1)).toBe('#EXTINF:4.000000,');
    expect(lineAfter(lines, (l) => l === '#EXT-X-CUE-IN', 2)).toContain(
      new Date(T0 + 20000).toISOString(),
    );
    expect(lines.find((l) => l.includes('SCTE35-IN'))).toContain('SCTE35-IN=0xFC0020BB');
  });

  it('is idempotent for the same window', () => {
    const src = makePlaylist(T0, 10);
    const a = injectMarkers(src, [cue(T0 + 8000)]);
    const b = injectMarkers(src, [cue(T0 + 8000)]);
    expect(a.playlist).toBe(b.playlist);
  });

  it('ignores a cue that has not entered the window', () => {
    const src = makePlaylist(T0, 10);
    const { playlist, manifested } = injectMarkers(src, [cue(T0 + 100_000)]);
    expect(playlist).toBe(src);
    expect(manifested).toEqual([]);
  });

  it('ignores a cue that has slid out of the window', () => {
    const src = makePlaylist(T0, 10);
    const { playlist, manifested } = injectMarkers(src, [cue(T0 - 60_000, 12)]);
    expect(playlist).toBe(src);
    expect(manifested).toEqual([]);
  });

  it('keeps markers on the same boundary as the window rolls forward', () => {
    const rolled = makePlaylist(T0 + 4000, 10, 101); // window advanced one segment
    const { playlist } = injectMarkers(rolled, [cue(T0 + 8000)]);
    const lines = playlist.split('\n');
    expect(lineAfter(lines, (l) => l.startsWith('#EXT-X-CUE-OUT'), 2)).toContain(
      new Date(T0 + 8000).toISOString(),
    );
  });

  it('renders multiple concurrent cues', () => {
    const { playlist, manifested } = injectMarkers(makePlaylist(T0, 15), [
      cue(T0 + 8000),
      cue(T0 + 40_000),
    ]);
    const lines = playlist.split('\n');
    expect(manifested.length).toBe(2);
    expect(lines.filter((l) => l.startsWith('#EXT-X-CUE-OUT')).length).toBe(2);
  });

  it('never touches media-sequence or segment lines', () => {
    const src = makePlaylist(T0, 10);
    const { playlist } = injectMarkers(src, [cue(T0 + 8000)]);
    expect(playlist).toContain('#EXT-X-MEDIA-SEQUENCE:100');
    const segs = (s: string) => s.split('\n').filter((l) => l.endsWith('.ts'));
    expect(segs(playlist)).toEqual(segs(src));
  });

  it('handles the real captured origin playlist', () => {
    const fixture = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../fixtures/live-sample.m3u8'),
      'utf8',
    );
    const firstPdt = Date.parse(
      fixture
        .split(/\r?\n/)
        .find((l) => l.startsWith('#EXT-X-PROGRAM-DATE-TIME:'))!
        .slice('#EXT-X-PROGRAM-DATE-TIME:'.length),
    );
    expect(Number.isNaN(firstPdt)).toBe(false);
    const { playlist, manifested } = injectMarkers(fixture, [cue(firstPdt + 12_000, 8)]);
    expect(manifested.length).toBe(1);
    const lines = playlist.split('\n');
    expect(lines.filter((l) => l.startsWith('#EXT-X-CUE-OUT')).length).toBe(1);
    expect(lines.filter((l) => l === '#EXT-X-CUE-IN').length).toBe(1);
    // segment lines unchanged vs source
    expect(lines.filter((l) => l.endsWith('.ts'))).toEqual(
      fixture.split(/\r?\n/).filter((l) => l.endsWith('.ts')),
    );
  });
});
