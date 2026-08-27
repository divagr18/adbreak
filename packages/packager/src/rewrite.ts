/**
 * Pure manifest rewrite engine: inserts EXT-X-DATERANGE (SCTE35-OUT/IN) and
 * CUE-OUT/CUE-IN marker lines into a live media playlist at the segment
 * boundaries matching each cue's splice time. No I/O; rebuilt from the origin
 * playlist on every call, so it is idempotent by construction. Segment lines
 * and EXT-X-MEDIA-SEQUENCE are never modified — markers are inserted only.
 */

import { parsePlaylist } from '@adbreak/shared';

export interface CueState {
  availId: string;
  spliceTimeMs: number;
  durationS: number;
  scte35Out: string;
  scte35In: string;
  /** W3C traceparent, carried to downstream SSAI inside the manifest. */
  traceparent?: string;
}

export interface RewriteResult {
  playlist: string;
  /** availIds whose OUT marker is present in this rendition of the playlist. */
  manifested: string[];
}

const iso = (ms: number) => new Date(ms).toISOString();

const dateRangeOut = (cue: CueState): string =>
  `#EXT-X-DATERANGE:ID="${cue.availId}",START-DATE="${iso(cue.spliceTimeMs)}",` +
  `PLANNED-DURATION=${cue.durationS.toFixed(3)},SCTE35-OUT=0x${cue.scte35Out.toUpperCase()}` +
  // HLS permits X-prefixed client attributes on a DATERANGE, so the avail's
  // trace context rides the manifest exactly as the SCTE-35 payload does.
  (cue.traceparent ? `,X-ADBREAK-TRACE="${cue.traceparent}"` : '');

export function injectMarkers(playlist: string, cues: CueState[]): RewriteResult {
  const { header, segments, trailer } = parsePlaylist(playlist);
  if (segments.length === 0 || segments[0].pdtMs === null) {
    return { playlist, manifested: [] };
  }
  const firstPdt = segments[0].pdtMs;
  const lastPdt = segments[segments.length - 1].pdtMs ?? firstPdt;

  // boundary index: first segment whose PDT >= t, or -1 when t is outside the
  // window (not yet arrived, or already slid out).
  const boundary = (t: number): number => {
    if (t < firstPdt) return -1; // slid out of the window — stale, skip
    return segments.findIndex((s) => s.pdtMs !== null && s.pdtMs >= t);
  };

  const before = new Map<number, string[]>();
  const manifested: string[] = [];
  const insert = (idx: number, lines: string[]) => {
    before.set(idx, [...(before.get(idx) ?? []), ...lines]);
  };

  const announcements: string[] = [];

  for (const cue of cues) {
    const endMs = cue.spliceTimeMs + cue.durationS * 1000;
    const outIdx = boundary(cue.spliceTimeMs);
    const inIdx = boundary(endMs);

    if (outIdx < 0 && cue.spliceTimeMs > lastPdt) {
      // The break hasn't reached the live window yet. Announce it with a
      // future START-DATE (HLS allows this) so downstream SSAI gets the same
      // lead time real ad decisioning depends on; CUE-OUT still waits for the
      // actual segment boundary.
      announcements.push(dateRangeOut(cue));
      continue;
    }

    if (outIdx >= 0) {
      insert(outIdx, [dateRangeOut(cue), `#EXT-X-CUE-OUT:${cue.durationS.toFixed(3)}`]);
      manifested.push(cue.availId);
    }
    if (inIdx >= 0) {
      insert(inIdx, [
        `#EXT-X-DATERANGE:ID="${cue.availId}-in",START-DATE="${iso(endMs)}",` +
          `SCTE35-IN=0x${cue.scte35In.toUpperCase()}`,
        '#EXT-X-CUE-IN',
      ]);
    }
  }

  const out: string[] = [...header, ...announcements];
  segments.forEach((seg, i) => {
    const extra = before.get(i);
    if (extra) out.push(...extra);
    out.push(...seg.lines);
  });
  out.push(...trailer);
  return { playlist: out.join('\n'), manifested };
}
