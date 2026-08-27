/**
 * Pure manifest rewrite engine: inserts EXT-X-DATERANGE (SCTE35-OUT/IN) and
 * CUE-OUT/CUE-IN marker lines into a live media playlist at the segment
 * boundaries matching each cue's splice time. No I/O; rebuilt from the origin
 * playlist on every call, so it is idempotent by construction. Segment lines
 * and EXT-X-MEDIA-SEQUENCE are never modified — markers are inserted only.
 */

export interface CueState {
  availId: string;
  spliceTimeMs: number;
  durationS: number;
  scte35Out: string;
  scte35In: string;
}

interface Segment {
  /** All source lines for this segment (EXTINF, PDT, URI), in order. */
  lines: string[];
  pdtMs: number | null;
}

export interface RewriteResult {
  playlist: string;
  /** availIds whose OUT marker is present in this rendition of the playlist. */
  manifested: string[];
}

function parse(playlist: string): { header: string[]; segments: Segment[]; trailer: string[] } {
  const lines = playlist.split(/\r?\n/);
  const header: string[] = [];
  const segments: Segment[] = [];
  const trailer: string[] = [];
  let current: Segment | null = null;
  let inSegments = false;

  for (const line of lines) {
    if (line.startsWith('#EXTINF')) {
      inSegments = true;
      current = { lines: [line], pdtMs: null };
      continue;
    }
    if (!inSegments) {
      header.push(line);
      continue;
    }
    if (current === null) {
      // Lines after the last segment URI (e.g. EXT-X-ENDLIST on VOD).
      trailer.push(line);
      continue;
    }
    current.lines.push(line);
    if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      current.pdtMs = Date.parse(line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length));
    }
    if (!line.startsWith('#')) {
      // URI line closes the segment.
      segments.push(current);
      current = null;
    }
  }
  if (current) segments.push(current);
  return { header, segments, trailer };
}

const iso = (ms: number) => new Date(ms).toISOString();

export function injectMarkers(playlist: string, cues: CueState[]): RewriteResult {
  const { header, segments, trailer } = parse(playlist);
  if (segments.length === 0 || segments[0].pdtMs === null) {
    return { playlist, manifested: [] };
  }
  const firstPdt = segments[0].pdtMs;

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

  for (const cue of cues) {
    const endMs = cue.spliceTimeMs + cue.durationS * 1000;
    const outIdx = boundary(cue.spliceTimeMs);
    const inIdx = boundary(endMs);
    if (outIdx >= 0) {
      insert(outIdx, [
        `#EXT-X-DATERANGE:ID="${cue.availId}",START-DATE="${iso(cue.spliceTimeMs)}",` +
          `PLANNED-DURATION=${cue.durationS.toFixed(3)},SCTE35-OUT=0x${cue.scte35Out.toUpperCase()}`,
        `#EXT-X-CUE-OUT:${cue.durationS.toFixed(3)}`,
      ]);
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

  const out: string[] = [...header];
  segments.forEach((seg, i) => {
    const extra = before.get(i);
    if (extra) out.push(...extra);
    out.push(...seg.lines);
  });
  out.push(...trailer);
  return { playlist: out.join('\n'), manifested };
}
