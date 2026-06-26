/**
 * core.tx.test.ts — transaction semantics: atomic apply and isolation.
 *
 * The kv suite (core.kv.test.ts)
 * already covers single-transaction read-your-writes and the simple
 * abort-on-throw case; this file pins the cross-transaction guarantees that the
 * boundary suite (core.boundaries.test.ts) deliberately left open.
 *
 * Isolation level: SERIALIZABLE, achieved by construction rather than by
 * conflict detection. The kernel API is synchronous and single-threaded, so a
 * transaction body always runs to completion before any other transaction
 * begins — the execution is therefore equivalent to a serial schedule. The one
 * way two transactions could overlap is re-entrancy (a `transact` call nested
 * inside another), so the kernel forbids that explicitly; without the guard the
 * serializable guarantee would be a claim, not a fact. (An async face layered
 * over the sync core later must supply its own concurrency control.)
 */
import { expect, test } from "bun:test";

import { open } from "./core.ts";

/** Build a key/value from byte numbers — keeps the tests terse and readable. */
const bytes = (...b: number[]): Uint8Array => new Uint8Array(b);

test("sequential transactions compose as a serial schedule", () => {
  const db = open();
  // Each transaction commits in order; a later one observes every earlier
  // commit and nothing of any uncommitted work. This is the serial schedule.
  db.transact((tx) => tx.set(bytes(1), bytes(10)));
  db.transact((tx) => {
    expect(tx.get(bytes(1))).toEqual(bytes(10)); // sees the first commit
    tx.set(bytes(2), bytes(20));
  });
  const both = db.transact((tx) => ({
    one: tx.get(bytes(1)),
    two: tx.get(bytes(2)),
  }));
  expect(both.one).toEqual(bytes(10));
  expect(both.two).toEqual(bytes(20));
  db.close();
});

test("a nested transact is rejected, so transactions cannot overlap", () => {
  const db = open();
  // Re-entrancy is the only way to start a transaction while another is live.
  // Allowing it would let the inner commit clobber the outer's pending writes
  // (a silent lost update), breaking serializability — so it must throw.
  expect(() =>
    db.transact(() => {
      db.transact((inner) => inner.set(bytes(1), bytes(1)));
    }),
  ).toThrow();
  db.close();
});

test("the database stays usable after a rejected nested transact", () => {
  const db = open();
  // The re-entrancy guard must reset on the way out (even though the outer
  // body threw), or the database would be wedged for every later transaction.
  expect(() =>
    db.transact(() => {
      db.transact((inner) => inner.set(bytes(9), bytes(9)));
    }),
  ).toThrow();

  // The outer aborted, so nothing from it (or the inner) was applied...
  expect(db.transact((tx) => tx.get(bytes(9)))).toBeUndefined();
  // ...and a fresh transaction still works.
  db.transact((tx) => tx.set(bytes(5), bytes(50)));
  expect(db.transact((tx) => tx.get(bytes(5)))).toEqual(bytes(50));
  db.close();
});

test("an aborted transaction restores the exact prior state (set, overwrite, delete)", () => {
  const db = open();
  db.transact((tx) => {
    tx.set(bytes(1), bytes(1)); // will be overwritten in the doomed tx
    tx.set(bytes(2), bytes(2)); // will be deleted in the doomed tx
  });

  expect(() =>
    db.transact((tx) => {
      tx.set(bytes(1), bytes(99)); // overwrite an existing key
      tx.delete(bytes(2)); // delete an existing key
      tx.set(bytes(3), bytes(3)); // insert a new key
      throw new Error("boom");
    }),
  ).toThrow("boom");

  // Failure atomicity: every change rolls back together to the prior state.
  const after = db.transact((tx) => ({
    one: tx.get(bytes(1)),
    two: tx.get(bytes(2)),
    three: tx.get(bytes(3)),
  }));
  expect(after.one).toEqual(bytes(1)); // overwrite undone
  expect(after.two).toEqual(bytes(2)); // delete undone
  expect(after.three).toBeUndefined(); // insert undone
  db.close();
});

test("a committed snapshot is not mutated by a later transaction overwriting the same key", () => {
  const db = open();
  const original = bytes(1);
  db.transact((tx) => tx.set(bytes(1), original));

  // A later transaction replaces the value for the same key.
  db.transact((tx) => tx.set(bytes(1), bytes(2)));

  // The committed store now holds the new value, and the value object the
  // first transaction stored was never mutated in place (no aliasing).
  expect(db.transact((tx) => tx.get(bytes(1)))).toEqual(bytes(2));
  expect(original).toEqual(bytes(1));
  db.close();
});
