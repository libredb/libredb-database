/**
 * store.test.ts — the storage seam (port) a lens depends on.
 *
 * The minimal storage seam a lens needs, kept deliberately thin. These tests
 * pin two things:
 *
 *   1. The kernel's {@link Database} satisfies {@link Store}, so the real,
 *      durable path runs through the seam (not around it).
 *   2. A NON-kernel store that implements only `transact` can drive the kv lens
 *      end to end. That is the whole point of the seam: the lens needs nothing
 *      from storage but `transact`, so anything providing it — a fake here, an
 *      async-wrapped remote core later — composes with the lenses unchanged.
 *
 * The second test deliberately reimplements a tiny store from scratch (no kernel
 * involvement) so a passing run proves the decoupling is real, not the kernel in
 * disguise.
 */
import { expect, test } from "bun:test";

import { open, type Transaction } from "../core.ts";
import { kv } from "../lens/kv.ts";
import type { Store } from "./store.ts";

test("the kernel Database is usable as a Store and drives the kv lens", () => {
  // open() returns a Database; it flows in wherever a Store is expected because
  // it structurally provides transact(). This is the production path.
  const db = open();
  const store: Store = db;
  const map = kv(store);
  map.set("k", "v");
  expect(map.get("k")).toBe("v");
  db.close();
});

/**
 * A minimal in-memory {@link Store} built without the kernel. It keys entries by
 * fixed-width hex of their bytes, whose lexicographic string order equals the
 * unsigned byte-lexicographic order the kernel and lenses rely on, so range
 * scans come out in the same order a real store would yield.
 */
function fakeStore(): Store {
  const data = new Map<string, { key: Uint8Array; value: Uint8Array }>();
  const hex = (k: Uint8Array): string => Array.from(k, (b) => b.toString(16).padStart(2, "0")).join("");

  return {
    transact<T>(run: (tx: Transaction) => T): T {
      const tx: Transaction = {
        get(key) {
          return data.get(hex(key))?.value;
        },
        set(key, value) {
          data.set(hex(key), { key, value });
        },
        delete(key) {
          data.delete(hex(key));
        },
        *getRange(start, end) {
          const lo = hex(start);
          const hi = hex(end);
          for (const hk of Array.from(data.keys()).sort()) {
            if (hk < lo) continue;
            if (hk >= hi) break;
            yield data.get(hk) as { key: Uint8Array; value: Uint8Array };
          }
        },
      };
      return run(tx);
    },
  };
}

test("a non-kernel Store drives the kv lens through get/set/delete", () => {
  const map = kv(fakeStore());
  expect(map.set("greeting", "hello")).toEqual({ changed: 1 });
  expect(map.get("greeting")).toBe("hello");
  expect(map.delete("greeting")).toEqual({ changed: 1 });
  expect(map.get("greeting")).toBeUndefined();
  expect(map.delete("greeting")).toEqual({ changed: 0 });
});

test("a non-kernel Store yields range scans in key order over [start, end)", () => {
  const map = kv(fakeStore());
  for (const k of ["m", "a", "z", "f"]) map.set(k, k.toUpperCase());

  const keys = map
    .range("a", "z")
    .toArray()
    .map((e) => e.key);
  expect(keys).toEqual(["a", "f", "m"]); // "z" excluded by the half-open end
});
