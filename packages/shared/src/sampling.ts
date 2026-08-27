/**
 * Deterministic per-key sampling.
 *
 * The avalanche step is the whole point. Keys in this system differ only in
 * their trailing characters (`sess-0000`, `sess-0001`, ...), and a plain
 * rolling hash maps those to a near-contiguous run of buckets — so a threshold
 * test either takes almost all of them or, as happened here, none at all.
 */
export function hash32(key: string): number {
  let h = 2166136261 >>> 0; // FNV-1a offset basis
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  // murmur3 finalizer: scatters near-identical inputs across the whole range
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** Stable decision: the same key is always in or out for a given ratio. */
export function sampled(key: string, ratio: number): boolean {
  if (ratio >= 1) return true;
  if (ratio <= 0) return false;
  return hash32(key) / 4294967296 < ratio;
}
