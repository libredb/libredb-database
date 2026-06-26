/**
 * core.boundaries.test.ts — locks the kernel's PUBLIC CONTRACT.
 *
 * This suite defines the kernel's boundaries as types; behavior is exercised in
 * the sibling suites. So the real gate here is
 * the TYPECHECKER: the conforming mock below fails to compile the moment an
 * interface drifts from its documented shape. `bun run typecheck` (part of the
 * commit gate) is therefore the assertion that the contract is well-formed.
 *
 * On top of that, the mock encodes the contract's SEMANTICS as an executable
 * specification (half-open ranges, read-your-writes, abort-on-throw). The real
 * `open()` implementation in the next iteration must satisfy these same
 * semantics, so this file doubles as the seed of the behavioral suite.
 */
import { expect, test } from "bun:test";

import type { Database, Entry, Key, Transaction, Value } from "./core.ts";

/**
 * A minimal in-memory implementation used purely to prove the boundary types
 * are coherent and usable, and to pin the documented semantics. It is NOT the
 * kernel — it has no durability and no isolation beyond read-your-writes.
 */
function mockOpen(): Database {
  // Byte-ordered map keyed by a lossless string encoding of the bytes.
  const store = new Map<string, Uint8Array>();
  const encode = (key: Key): string => key.join(",");
  const lexLess = (a: Uint8Array, b: Uint8Array): boolean => {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const ai = a[i] as number;
      const bi = b[i] as number;
      if (ai !== bi) return ai < bi;
    }
    return a.length < b.length;
  };

  const makeTx = (): Transaction => ({
    get(key: Key): Value | undefined {
      return store.get(encode(key));
    },
    set(key: Key, value: Value): void {
      store.set(encode(key), value);
    },
    delete(key: Key): void {
      store.delete(encode(key));
    },
    *getRange(start: Key, end: Key): Iterable<Entry> {
      const entries: Entry[] = [];
      for (const [encoded, value] of store) {
        const key = Uint8Array.from(encoded.split(",").map(Number));
        // Half-open [start, end): start inclusive, end exclusive.
        if (!lexLess(key, start) && lexLess(key, end)) {
          entries.push({ key, value });
        }
      }
      entries.sort((x, y) => (lexLess(x.key, y.key) ? -1 : 1));
      yield* entries;
    },
  });

  return {
    transact<T>(run: (tx: Transaction) => T): T {
      // Atomic apply: a real kernel buffers and applies on success. The throw
      // path below documents abort-on-error; the mock's store is shared so we
      // snapshot to honor it.
      const snapshot = new Map(store);
      try {
        return run(makeTx());
      } catch (error) {
        store.clear();
        for (const [k, v] of snapshot) store.set(k, v);
        throw error;
      }
    },
    close(): void {
      store.clear();
    },
  };
}

test("a value satisfies the Key/Value byte types", () => {
  const key: Key = new Uint8Array([1, 2, 3]);
  const value: Value = new Uint8Array([42]);
  expect(key).toBeInstanceOf(Uint8Array);
  expect(value).toBeInstanceOf(Uint8Array);
});

test("transact exposes get/set/delete with read-your-writes", () => {
  const db = mockOpen();
  const k = new Uint8Array([7]);
  const v = new Uint8Array([99]);

  db.transact((tx) => {
    expect(tx.get(k)).toBeUndefined();
    tx.set(k, v);
    // Read-your-writes: a transaction sees its own pending writes.
    expect(tx.get(k)).toEqual(v);
    tx.delete(k);
    expect(tx.get(k)).toBeUndefined();
  });
  db.close();
});

test("getRange is ordered and half-open [start, end)", () => {
  const db = mockOpen();
  db.transact((tx) => {
    for (const b of [1, 2, 3, 4]) tx.set(new Uint8Array([b]), new Uint8Array([b]));
  });

  const seen = db.transact((tx) => {
    const keys: number[] = [];
    for (const entry of tx.getRange(new Uint8Array([2]), new Uint8Array([4]))) {
      keys.push(entry.key[0] as number);
    }
    return keys;
  });

  // 2 included, 4 excluded, ordered ascending.
  expect(seen).toEqual([2, 3]);
  db.close();
});

test("transact aborts (applies nothing) when the body throws", () => {
  const db = mockOpen();
  const k = new Uint8Array([5]);

  expect(() =>
    db.transact((tx) => {
      tx.set(k, new Uint8Array([1]));
      throw new Error("boom");
    }),
  ).toThrow("boom");

  const after = db.transact((tx) => tx.get(k));
  expect(after).toBeUndefined();
  db.close();
});
