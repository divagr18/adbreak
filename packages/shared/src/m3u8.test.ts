import { describe, expect, it } from 'vitest';
import { parseCueWindows, parsePlaylist, serialize } from './m3u8.js';

const MARKED = [
  '#EXTM3U',
  '#EXT-X-VERSION:6',
  '#EXT-X-MEDIA-SEQUENCE:100',
  '#EXTINF:4.000000,',
  '#EXT-X-PROGRAM-DATE-TIME:2026-08-27T12:00:00.000Z',
  'seg_000100.ts',
  '#EXT-X-DATERANGE:ID="avail-1",START-DATE="2026-08-27T12:00:04.000Z",PLANNED-DURATION=32.000,SCTE35-OUT=0xFC3025',
  '#EXT-X-CUE-OUT:32.000',
  '#EXTINF:4.000000,',
  '#EXT-X-PROGRAM-DATE-TIME:2026-08-27T12:00:04.000Z',
  'seg_000101.ts',
].join('\n');

describe('parsePlaylist', () => {
  it('keeps tags between segments attached to the following segment', () => {
    // Otherwise serialize() moves every ad marker to the bottom of the playlist.
    const pl = parsePlaylist(MARKED);
    expect(pl.segments).toHaveLength(2);
    expect(pl.trailer).toEqual([]);
    expect(pl.segments[1].lines[0]).toContain('#EXT-X-DATERANGE');
    expect(pl.segments[1].lines[1]).toBe('#EXT-X-CUE-OUT:32.000');
    expect(pl.segments[1].uri).toBe('seg_000101.ts');
  });

  it('round-trips a marked playlist byte for byte', () => {
    expect(serialize(parsePlaylist(MARKED))).toBe(MARKED);
  });

  it('captures PDT and URI per segment', () => {
    const pl = parsePlaylist(MARKED);
    expect(pl.segments[0].uri).toBe('seg_000100.ts');
    expect(pl.segments[0].pdtMs).toBe(Date.parse('2026-08-27T12:00:00.000Z'));
  });

  it('treats trailing tags after the last segment as trailer', () => {
    const vod = ['#EXTM3U', '#EXTINF:4.000000,', 'seg_000.ts', '#EXT-X-ENDLIST'].join('\n');
    const pl = parsePlaylist(vod);
    expect(pl.segments).toHaveLength(1);
    expect(pl.trailer).toEqual(['#EXT-X-ENDLIST']);
    expect(serialize(pl)).toBe(vod);
  });
});

describe('parseCueWindows', () => {
  it('reads avail windows from SCTE35-OUT dateranges', () => {
    expect(parseCueWindows(MARKED)).toEqual([
      {
        availId: 'avail-1',
        startMs: Date.parse('2026-08-27T12:00:04.000Z'),
        durationS: 32,
      },
    ]);
  });

  it('ignores IN dateranges and malformed lines', () => {
    const text = [
      '#EXT-X-DATERANGE:ID="avail-1-in",START-DATE="2026-08-27T12:00:36.000Z",SCTE35-IN=0xFC3020',
      '#EXT-X-DATERANGE:ID="broken",SCTE35-OUT=0xFC',
    ].join('\n');
    expect(parseCueWindows(text)).toEqual([]);
  });
});
