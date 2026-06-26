import { describe, expect, test } from "bun:test";

import { open } from "../core.ts";
import { result, type Result, type WriteResult } from "./types.ts";

describe("Result", () => {
  test("iterates the rows it was given", () => {
    const r = result(() => [1, 2, 3]);
    expect([...r]).toEqual([1, 2, 3]);
  });

  test("toArray() materializes every row", () => {
    const r = result(() => ["a", "b"]);
    expect(r.toArray()).toEqual(["a", "b"]);
  });

  test("an empty source yields nothing", () => {
    const r = result<number>(() => []);
    expect(r.toArray()).toEqual([]);
    expect([...r]).toEqual([]);
  });

  test("is lazy: the source is not read until the result is iterated", () => {
    let calls = 0;
    const r = result(() => {
      calls++;
      return [1, 2, 3];
    });
    // Constructing a Result must not touch the source — a range scan over a
    // large store should cost nothing until something asks for a row.
    expect(calls).toBe(0);

    expect(r.toArray()).toEqual([1, 2, 3]);
    expect(calls).toBe(1);

    // Re-iterable: each pass re-runs the source. This kills the classic
    // generator footgun where a second `for..of` silently yields nothing.
    expect([...r]).toEqual([1, 2, 3]);
    expect(calls).toBe(2);
  });

  test("wraps the kernel's lazy range scan unchanged", () => {
    const db = open();
    const rows = db.transact((tx) => {
      tx.set(Uint8Array.of(1), Uint8Array.of(10));
      tx.set(Uint8Array.of(2), Uint8Array.of(20));
      tx.set(Uint8Array.of(3), Uint8Array.of(30));
      // The shared Result shape must compose with the core's Iterable<Entry>
      // without copying or eager materialization in between.
      const scan = result(() => tx.getRange(Uint8Array.of(1), Uint8Array.of(3)));
      return scan.toArray();
    });
    db.close();

    expect(rows.map((e) => [...e.key, ...e.value])).toEqual([
      [1, 10],
      [2, 20],
    ]);
  });

  test("carries its row type (compile-time contract)", () => {
    // Locks the generic contract the way the boundaries test does: if Result
    // stops being generic over Row, this stops type-checking and the gate fails.
    const typed: Result<{ id: number }> = result(() => [{ id: 1 }]);
    const [first] = typed.toArray();
    expect(first?.id).toBe(1);
  });
});

describe("WriteResult", () => {
  test("reports the number of entries a write changed", () => {
    const outcome: WriteResult = { changed: 3 };
    expect(outcome.changed).toBe(3);
  });
});
