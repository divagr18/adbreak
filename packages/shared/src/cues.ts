/** Cue bus contract: playout → packager over Redis pub/sub. */

export const CUE_CHANNEL = 'adbreak:cues';

export type BreakType = 'mid_roll' | 'pre_roll';

export interface CueMessage {
  kind: 'splice_insert';
  availId: string;
  channel: string;
  /** ISO timestamp when the break should start (wall clock). */
  spliceTime: string;
  /** Break duration in seconds. */
  durationS: number;
  breakType: BreakType;
}

export function availId(channel: string, spliceTime: Date): string {
  // Deterministic: same schedule slot → same id. Also the future trace_id seed.
  return `avail-${channel}-${spliceTime.toISOString().replace(/[:.]/g, '-')}`;
}
