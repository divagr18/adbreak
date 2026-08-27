import { describe, expect, it } from 'vitest';
import { crc32Mpeg, encodeSpliceInsert, pts90kFromMs } from './scte35.js';

const hexToBytes = (hex: string) =>
  new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)));

describe('encodeSpliceInsert', () => {
  it('emits a structurally valid OUT section', () => {
    const hex = encodeSpliceInsert({ eventId: 42, pts90k: 123456789n, durationS: 30, out: true });
    const bytes = hexToBytes(hex);
    expect(bytes[0]).toBe(0xfc); // table_id
    const sectionLength = ((bytes[1] & 0x0f) << 8) | bytes[2];
    expect(bytes.length).toBe(3 + sectionLength);
    // OUT with duration: 11 header + 20 cmd + 2 loop + 4 crc
    expect(sectionLength).toBe(37);
    expect(bytes[13]).toBe(0x05); // splice_command_type
  });

  it('emits a shorter IN section (no break_duration)', () => {
    const hex = encodeSpliceInsert({ eventId: 42, pts90k: 1n, out: false });
    const bytes = hexToBytes(hex);
    const sectionLength = ((bytes[1] & 0x0f) << 8) | bytes[2];
    expect(sectionLength).toBe(32);
  });

  it('carries a correct MPEG CRC-32', () => {
    const bytes = hexToBytes(
      encodeSpliceInsert({ eventId: 7, pts90k: 999999n, durationS: 15, out: true }),
    );
    const body = bytes.slice(0, -4);
    const crc = new DataView(bytes.buffer).getUint32(bytes.length - 4);
    expect(crc32Mpeg(body)).toBe(crc);
  });

  it('is deterministic', () => {
    const a = encodeSpliceInsert({ eventId: 1, pts90k: 90000n, durationS: 30, out: true });
    const b = encodeSpliceInsert({ eventId: 1, pts90k: 90000n, durationS: 30, out: true });
    expect(a).toBe(b);
  });

  it('wraps pts to 33 bits', () => {
    expect(pts90kFromMs(2 ** 45)).toBeLessThanOrEqual((1n << 33n) - 1n);
  });
});
