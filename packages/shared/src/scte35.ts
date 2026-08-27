/**
 * Minimal binary-valid SCTE-35 splice_insert encoder (SCTE 35, splice_info_section).
 * Produces the payload carried in EXT-X-DATERANGE SCTE35-OUT/IN attributes.
 * Scope: program-level splice_insert with pts splice_time, optional break_duration
 * (auto_return), no encryption, no descriptors — the shape real playout emits for
 * a simple avail.
 */

class BitWriter {
  private bits: number[] = [];

  write(value: number | bigint, n: number): void {
    const v = BigInt(value);
    for (let i = n - 1; i >= 0; i--) this.bits.push(Number((v >> BigInt(i)) & 1n));
  }

  toBytes(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((b, i) => {
      if (b) out[i >> 3] |= 0x80 >> (i & 7);
    });
    return out;
  }
}

/** MPEG-2 CRC-32 (poly 0x04C11DB7, init 0xFFFFFFFF, MSB-first, no final xor). */
export function crc32Mpeg(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b << 24;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
    }
  }
  return crc >>> 0;
}

export interface SpliceInsertParams {
  eventId: number;
  /** Splice point in 90kHz ticks (33-bit wrap applied internally). */
  pts90k: bigint;
  /** Break duration in seconds; omit for a CUE-IN (return to network). */
  durationS?: number;
  /** true = out of network (ad start), false = return (ad end). */
  out: boolean;
}

const PTS_MASK = (1n << 33n) - 1n;

export function encodeSpliceInsert(p: SpliceInsertParams): string {
  const hasDuration = p.out && p.durationS !== undefined;

  // splice_insert command body
  const cmd = new BitWriter();
  cmd.write(p.eventId >>> 0, 32);
  cmd.write(0, 1); // splice_event_cancel_indicator
  cmd.write(0x7f, 7); // reserved
  cmd.write(p.out ? 1 : 0, 1); // out_of_network_indicator
  cmd.write(1, 1); // program_splice_flag
  cmd.write(hasDuration ? 1 : 0, 1); // duration_flag
  cmd.write(0, 1); // splice_immediate_flag
  cmd.write(0xf, 4); // reserved
  // splice_time()
  cmd.write(1, 1); // time_specified_flag
  cmd.write(0x3f, 6); // reserved
  cmd.write(p.pts90k & PTS_MASK, 33);
  if (hasDuration) {
    // break_duration()
    cmd.write(1, 1); // auto_return
    cmd.write(0x3f, 6); // reserved
    cmd.write(BigInt(Math.round(p.durationS! * 90_000)) & PTS_MASK, 33);
  }
  cmd.write(1, 16); // unique_program_id
  cmd.write(0, 8); // avail_num
  cmd.write(0, 8); // avails_expected
  const cmdBytes = cmd.toBytes();

  // section_length counts everything after the section_length field, CRC included:
  // 11 fixed header bytes + command + 2 (descriptor_loop_length) + 4 (CRC)
  const sectionLength = 11 + cmdBytes.length + 2 + 4;

  const w = new BitWriter();
  w.write(0xfc, 8); // table_id
  w.write(0, 1); // section_syntax_indicator
  w.write(0, 1); // private_indicator
  w.write(0x3, 2); // reserved
  w.write(sectionLength, 12);
  w.write(0, 8); // protocol_version
  w.write(0, 1); // encrypted_packet
  w.write(0, 6); // encryption_algorithm
  w.write(0n, 33); // pts_adjustment
  w.write(0, 8); // cw_index
  w.write(0xfff, 12); // tier
  w.write(cmdBytes.length, 12); // splice_command_length
  w.write(0x05, 8); // splice_command_type = splice_insert
  for (const b of cmdBytes) w.write(b, 8);
  w.write(0, 16); // descriptor_loop_length

  const withoutCrc = w.toBytes();
  const crc = crc32Mpeg(withoutCrc);
  const out = new Uint8Array(withoutCrc.length + 4);
  out.set(withoutCrc);
  new DataView(out.buffer).setUint32(withoutCrc.length, crc);

  return Array.from(out, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 90kHz PTS derived from a wall-clock ms timestamp (33-bit wrapped). */
export function pts90kFromMs(epochMs: number): bigint {
  return (BigInt(Math.round(epochMs * 90)) & PTS_MASK);
}
