/**
 * range.test.ts — behavioral suite for the key-range query surface.
 *
 * The minimal query surface for the KV lens. The one piece of genuine query logic an ordered key-value store
 * needs beyond an explicit [start, end) scan is the PREFIX scan, and the only
 * tricky part of that is computing the exclusive upper bound correctly. These
 * tests are written first and pin two things: (1) the bound is computed on raw
 * BYTES, so it agrees with the kernel's unsigned byte-lexicographic order (the
 * naive string `prefix + "￿"` would be wrong); (2) a prefix with no finite
 * upper bound is rejected loudly rather than silently scanning the wrong range.
 */
import { expect, test } from "bun:test";

import { open } from "../core.ts";
import { prefixRange, type KeyRange } from "./range.ts";

const bytes = (...b: number[]): Uint8Array => Uint8Array.from(b);

test("prefixRange starts at the prefix itself, inclusive", () => {
  const range = prefixRange(bytes(0x61, 0x62)); // "ab"
  expect([...range.start]).toEqual([0x61, 0x62]);
});

test("prefixRange ends one past the prefix: the last byte is incremented", () => {
  const range = prefixRange(bytes(0x61, 0x62)); // "ab" -> end "ac"
  expect([...range.end]).toEqual([0x61, 0x63]);
});

test("the upper bound drops a trailing 0xFF and increments the byte before it", () => {
  // [0x61, 0xFF] cannot increment its last byte (already max), so the bound is
  // [0x62]: the first key not beginning with [0x61, 0xFF].
  const range = prefixRange(bytes(0x61, 0xff));
  expect([...range.end]).toEqual([0x62]);
});

test("the upper bound drops every trailing 0xFF byte", () => {
  const range = prefixRange(bytes(0x61, 0xff, 0xff));
  expect([...range.end]).toEqual([0x62]);
});

test("a prefix of all 0xFF bytes has no finite upper bound and is rejected", () => {
  expect(() => prefixRange(bytes(0xff))).toThrow(/no finite upper bound/);
  expect(() => prefixRange(bytes(0xff, 0xff))).toThrow(/no finite upper bound/);
});

test("an empty prefix has no finite upper bound and is rejected", () => {
  expect(() => prefixRange(bytes())).toThrow(/no finite upper bound/);
});

test("the computed range selects exactly the prefixed keys against the real kernel", () => {
  // The point of computing the bound on bytes: it must agree with the kernel's
  // own ordering. Drive the kernel's getRange with the computed range and prove
  // it returns every key beginning with the prefix and excludes the next sibling.
  const db = open();
  const keys = ["a", "ab", "abc", "ab￿", "ac", "b"];
  db.transact((tx) => {
    for (const k of keys) tx.set(new TextEncoder().encode(k), bytes(0));
  });

  const range: KeyRange = prefixRange(new TextEncoder().encode("ab"));
  const scanned = db.transact((tx) => {
    const out: string[] = [];
    for (const entry of tx.getRange(range.start, range.end)) {
      out.push(new TextDecoder().decode(entry.key));
    }
    return out;
  });

  // Byte order, not UTF-16: "abc" (third byte 0x63) sorts before "ab￿" (0xEF).
  expect(scanned).toEqual(["ab", "abc", "ab￿"]); // "a", "ac", "b" excluded
  db.close();
});
