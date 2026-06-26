/**
 * prng.ts — the tiny seeded PRNG the DST harness is built on.
 *
 * Shared by SimFS (which uses it to tear an un-fsync'd tail at a seeded point)
 * and the workload generator (which uses it to choose operations). A seed
 * yields the same stream of floats in [0, 1) every time, which is exactly what
 * makes a simulated run replayable byte-for-byte from its seed (DESIGN.md
 * section 6.4). Kept inline (no dependency) so the harness has no moving parts
 * a reader has to trust.
 */

/**
 * mulberry32 — a small, fast, fully-deterministic PRNG. Returns a function that
 * yields the next float in [0, 1) on each call; the stream is fixed by `seed`.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
