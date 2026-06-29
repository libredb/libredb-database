/**
 * core.kv.test.ts — behavioral suite for the ordered key-value kernel.
 *
 * Where core.boundaries.test.ts locks the CONTRACT against a throwaway mock,
 * this file exercises the REAL `open()` kernel: get / set / delete and the
 * ordered, half-open range scan.
 *
 * The defining property under test is unsigned byte-lexicographic key order —
 * the property every later lens encodes its indexes against. Several cases
 * deliberately distinguish byte order from JavaScript string order (e.g. the
 * byte 2 sorts before the byte 10, though "10" < "2" as strings).
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The path-backed durability case opens through the Node entry for the default
// node:fs adapter; the in-memory cases work the same through it.
import { open } from "./index.ts";

/** Build a key/value from byte numbers — keeps the tests terse and readable. */
const bytes = (...b: number[]): Uint8Array => new Uint8Array(b);

test("get returns undefined for a key that was never set", () => {
  const db = open();
  const seen = db.transact((tx) => tx.get(bytes(1)));
  expect(seen).toBeUndefined();
  db.close();
});

test("set then get returns the stored value", () => {
  const db = open();
  const value = db.transact((tx) => {
    tx.set(bytes(1), bytes(42));
    return tx.get(bytes(1));
  });
  expect(value).toEqual(bytes(42));
  db.close();
});

test("set overwrites an existing value", () => {
  const db = open();
  const value = db.transact((tx) => {
    tx.set(bytes(1), bytes(10));
    tx.set(bytes(1), bytes(20));
    return tx.get(bytes(1));
  });
  expect(value).toEqual(bytes(20));
  db.close();
});

test("writes are durable across transactions on the same instance", () => {
  const db = open();
  db.transact((tx) => tx.set(bytes(7), bytes(99)));
  const value = db.transact((tx) => tx.get(bytes(7)));
  expect(value).toEqual(bytes(99));
  db.close();
});

test("delete removes a key", () => {
  const db = open();
  const value = db.transact((tx) => {
    tx.set(bytes(1), bytes(1));
    tx.delete(bytes(1));
    return tx.get(bytes(1));
  });
  expect(value).toBeUndefined();
  db.close();
});

test("delete of an absent key is a no-op", () => {
  const db = open();
  expect(() => db.transact((tx) => tx.delete(bytes(123)))).not.toThrow();
  db.close();
});

test("getRange yields entries in ascending byte order, regardless of insert order", () => {
  const db = open();
  db.transact((tx) => {
    for (const b of [3, 1, 4, 1, 5, 9, 2, 6]) tx.set(bytes(b), bytes(b));
  });
  const keys = db.transact((tx) => {
    const out: number[] = [];
    for (const e of tx.getRange(bytes(0), bytes(255))) out.push(e.key[0]!);
    return out;
  });
  // Sorted, de-duplicated by the overwrite of repeated keys (1 appears once).
  expect(keys).toEqual([1, 2, 3, 4, 5, 6, 9]);
  db.close();
});

test("byte order is unsigned and uses length as the tiebreaker, unlike string order", () => {
  const db = open();
  // The byte 2 must sort before the byte 10 (2 < 10), even though "10" < "2".
  // 255 must sort after 0 (unsigned). A prefix sorts before its extension.
  db.transact((tx) => {
    tx.set(bytes(10), bytes(0));
    tx.set(bytes(2), bytes(0));
    tx.set(bytes(255), bytes(0));
    tx.set(bytes(0), bytes(0));
    tx.set(bytes(1, 0), bytes(0)); // [1,0]
    tx.set(bytes(1), bytes(0)); // [1] is a prefix of [1,0]
  });
  const order = db.transact((tx) => {
    const out: string[] = [];
    for (const e of tx.getRange(bytes(), bytes(255, 255))) out.push(e.key.join("."));
    return out;
  });
  expect(order).toEqual(["0", "1", "1.0", "2", "10", "255"]);
  db.close();
});

test("getRange is half-open: start is included, end is excluded", () => {
  const db = open();
  db.transact((tx) => {
    for (const b of [1, 2, 3, 4]) tx.set(bytes(b), bytes(b));
  });
  const keys = db.transact((tx) => {
    const out: number[] = [];
    for (const e of tx.getRange(bytes(2), bytes(4))) out.push(e.key[0]!);
    return out;
  });
  expect(keys).toEqual([2, 3]);
  db.close();
});

test("getRange over an empty range (start >= end) yields nothing", () => {
  const db = open();
  db.transact((tx) => tx.set(bytes(5), bytes(5)));
  const keys = db.transact((tx) => [...tx.getRange(bytes(5), bytes(5))]);
  expect(keys).toEqual([]);
  db.close();
});

test("read-your-writes: a transaction sees its own pending writes before commit", () => {
  const db = open();
  const observed = db.transact((tx) => {
    const before = tx.get(bytes(1));
    tx.set(bytes(1), bytes(1));
    const afterSet = tx.get(bytes(1));
    tx.delete(bytes(1));
    const afterDelete = tx.get(bytes(1));
    return { before, afterSet, afterDelete };
  });
  expect(observed.before).toBeUndefined();
  expect(observed.afterSet).toEqual(bytes(1));
  expect(observed.afterDelete).toBeUndefined();
  db.close();
});

test("transact passes through the value returned by its body", () => {
  const db = open();
  const result = db.transact(() => 1234);
  expect(result).toBe(1234);
  db.close();
});

test("a transaction that throws applies nothing (atomic abort)", () => {
  const db = open();
  db.transact((tx) => tx.set(bytes(1), bytes(1)));

  expect(() =>
    db.transact((tx) => {
      tx.set(bytes(1), bytes(2)); // would overwrite
      tx.set(bytes(2), bytes(2)); // would insert
      throw new Error("boom");
    }),
  ).toThrow("boom");

  const after = db.transact((tx) => ({
    one: tx.get(bytes(1)),
    two: tx.get(bytes(2)),
  }));
  expect(after.one).toEqual(bytes(1)); // unchanged
  expect(after.two).toBeUndefined(); // never inserted
  db.close();
});

test("using a database after close throws", () => {
  const db = open();
  db.close();
  expect(() => db.transact((tx) => tx.get(bytes(1)))).toThrow();
});

test("close is safe to call more than once", () => {
  const db = open();
  db.close();
  expect(() => db.close()).not.toThrow();
});

test("a path-backed open is durable (full crash/recovery suite in core.recovery.test.ts)", () => {
  // Durability/recovery has landed, so the
  // former "rejected until durability lands" assertion is replaced by its
  // positive form: a path-backed open works and round-trips a value. The
  // crash/recovery guarantees are exercised in detail in core.recovery.test.ts.
  const dir = mkdtempSync(join(tmpdir(), "libredb-kv-"));
  try {
    const db = open({ path: join(dir, "db") });
    db.transact((tx) => tx.set(bytes(1), bytes(42)));
    expect(db.transact((tx) => tx.get(bytes(1)))).toEqual(bytes(42));
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
