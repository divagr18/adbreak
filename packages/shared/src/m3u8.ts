/**
 * HLS media-playlist parsing shared by the packager (marker injection) and the
 * SSAI (per-session stitching). One implementation so the two can never drift
 * in how they read the same manifest.
 */

export interface Segment {
  /** All source lines for this segment (EXTINF, PDT, URI), in order. */
  lines: string[];
  /** The media URI line. */
  uri: string;
  pdtMs: number | null;
}

export interface Playlist {
  header: string[];
  segments: Segment[];
  trailer: string[];
}

const PDT_TAG = '#EXT-X-PROGRAM-DATE-TIME:';

export function parsePlaylist(text: string): Playlist {
  const lines = text.split(/\r?\n/);
  const header: string[] = [];
  const segments: Segment[] = [];
  const trailer: string[] = [];
  let current: Segment | null = null;
  let inSegments = false;
  /** Tags sitting between one segment's URI and the next EXTINF — e.g. the
   *  DATERANGE/CUE-OUT markers the packager injects. They belong to the
   *  segment that follows, not to the trailer, or serialization would move
   *  every ad marker to the bottom of the playlist. */
  let pending: string[] = [];

  for (const line of lines) {
    if (line.startsWith('#EXTINF')) {
      inSegments = true;
      current = { lines: [...pending, line], uri: '', pdtMs: null };
      pending = [];
      continue;
    }
    if (!inSegments) {
      header.push(line);
      continue;
    }
    if (current === null) {
      pending.push(line);
      continue;
    }
    current.lines.push(line);
    if (line.startsWith(PDT_TAG)) {
      current.pdtMs = Date.parse(line.slice(PDT_TAG.length));
    }
    if (!line.startsWith('#')) {
      current.uri = line;
      segments.push(current);
      current = null;
    }
  }
  if (current) segments.push(current);
  // Anything left over followed the final segment (e.g. EXT-X-ENDLIST on VOD).
  trailer.push(...pending);
  return { header, segments, trailer };
}

export function serialize(p: Playlist): string {
  return [...p.header, ...p.segments.flatMap((s) => s.lines), ...p.trailer].join('\n');
}

export interface CueWindow {
  availId: string;
  startMs: number;
  durationS: number;
}

const attr = (line: string, name: string): string | undefined =>
  new RegExp(`${name}=("([^"]*)"|([^,]*))`).exec(line)?.slice(2).find((v) => v !== undefined);

/**
 * Ad-break windows as advertised in the manifest itself (SCTE35-OUT dateranges).
 * The SSAI deliberately learns about breaks this way rather than from the cue
 * bus, so a packager that drops a cue (F02) really does starve ad insertion.
 */
export function parseCueWindows(text: string): CueWindow[] {
  const out: CueWindow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('#EXT-X-DATERANGE:') || !line.includes('SCTE35-OUT')) continue;
    const availId = attr(line, 'ID');
    const startDate = attr(line, 'START-DATE');
    const planned = attr(line, 'PLANNED-DURATION');
    if (!availId || !startDate || !planned) continue;
    const startMs = Date.parse(startDate);
    const durationS = Number(planned);
    if (Number.isNaN(startMs) || Number.isNaN(durationS)) continue;
    out.push({ availId, startMs, durationS });
  }
  return out;
}
