/**
 * fuzz.test.ts — seeded binary round-trip fuzz of the record codec and store.
 *
 * The DST workload (workload.ts) speaks 16 short ASCII keys — deliberately
 * narrow so overwrites and deletes collide often. What it never exercises is
 * the codec's full input space: binary keys with 0x00 separators (exactly what
 * the lenses' composite keys embed), empty keys, empty values, high bytes that
 * would betray a signed-byte comparison, and payloads big enough to cross any
 * accidental buffer boundary. This suite drives seeded random byte workloads
 * through commit, crash, and recovery, and checks the recovered store against
 * an independent model — plus the SORTED invariant the kernel's binary search
 * stands on, asserted directly on the recovered entries.
 */
import { expect, test } from "bun:test";

import { open, type Database } from "../core.ts";
import { mulberry32 } from "./prng.ts";
import { SimFS } from "./simfs.ts";

const WAL = "wal";

/** An upper bound above every key the fuzz can generate (keys cap at 24 bytes;
 * this is 33 bytes of 0xff, which sorts after any shorter or equal-prefix key). */
const KEY_CEILING = new Uint8Array(33).fill(0xff);

/** A lossless string encoding of bytes, usable as a Map key for the model. */
const encodeKey = (bytes: Uint8Array): string => bytes.join(",");
const decodeKey = (encoded: string): Uint8Array =>
  encoded === "" ? new Uint8Array(0) : Uint8Array.from(encoded.split(",").map(Number));

/** Unsigned byte-lexicographic comparison, written independently of the kernel
 * (the invariant checker must not reuse the code it judges). */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const delta = (a[i] as number) - (b[i] as number);
    if (delta !== 0) return delta;
  }
  return a.length - b.length;
}

/** Read the whole store as [key, value] byte pairs, asserting sortedness. */
function dumpSorted(db: Database): [Uint8Array, Uint8Array][] {
  return db.transact((tx) => {
    const out: [Uint8Array, Uint8Array][] = [];
    for (const entry of tx.getRange(new Uint8Array(0), KEY_CEILING)) {
      out.push([entry.key, entry.value]);
    }
    for (let i = 1; i < out.length; i++) {
      // Strictly ascending: sorted AND duplicate-free.
      expect(
        compareBytes((out[i - 1] as [Uint8Array, Uint8Array])[0], (out[i] as [Uint8Array, Uint8Array])[0]),
      ).toBeLessThan(0);
    }
    return out;
  });
}

test("seeded binary workloads round-trip through commit, crash, and recovery, sorted", () => {
  for (let seed = 0; seed < 20; seed++) {
    const rng = mulberry32(seed ^ 0x9e3779b9);
    const fs = new SimFS(seed);
    const model = new Map<string, Uint8Array>();

    /** Random bytes over the FULL alphabet, length 0..maxLength inclusive. */
    const randomBytes = (maxLength: number): Uint8Array => {
      const length = Math.floor(rng() * (maxLength + 1));
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i++) out[i] = Math.floor(rng() * 256);
      return out;
    };

    let db = open({ path: WAL, fs });
    for (let cycle = 0; cycle < 3; cycle++) {
      for (let step = 0; step < 15; step++) {
        db.transact((tx) => {
          const ops = 1 + Math.floor(rng() * 4);
          for (let o = 0; o < ops; o++) {
            const key = randomBytes(24); // includes the empty key
            if (rng() < 0.75) {
              // Values span empty to multi-KB (the large tail crosses any
              // accidental 256/1024-byte assumption in the codec).
              const value = rng() < 0.1 ? randomBytes(4096) : randomBytes(64);
              tx.set(key, value);
              model.set(encodeKey(key), value.slice());
            } else {
              tx.delete(key);
              model.delete(encodeKey(key));
            }
          }
        });
      }
      // Crash without a close (every commit above was fsync'd), then recover.
      fs.crash();
      db = open({ path: WAL, fs });
      const recovered = dumpSorted(db);
      expect(recovered.length).toBe(model.size);
      for (const [key, value] of recovered) {
        expect(model.get(encodeKey(key))).toEqual(value);
      }
    }
  }
});

test("the model dump helpers are lossless for the byte alphabet they encode", () => {
  // The encodeKey/decodeKey pair is the model's foundation; a lossy encoding
  // would make the whole fuzz vacuous, so pin it on the awkward inputs.
  for (const bytes of [new Uint8Array(0), Uint8Array.from([0]), Uint8Array.from([0, 255, 1, 128])]) {
    expect(decodeKey(encodeKey(bytes))).toEqual(bytes);
  }
});
