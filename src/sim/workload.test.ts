/**
 * workload.test.ts — tests for the DST workload generator and its model oracle
 * (plan S3).
 *
 * The workload is a seeded, deterministic sequence of transactions
 * (set/delete ops, some aborted) driven against the kernel; the model is a
 * plain committed map updated ONLY when a transaction commits — the oracle the
 * crash/recovery runner (S4) will compare the recovered state against. These
 * tests pin the oracle's faithfulness: for a known sequence the model tracks
 * exactly the committed state, an aborted transaction never reaches the model,
 * the generator is replayable from its seed, and a genuine error is never
 * mistaken for an intended abort.
 */
import { expect, test } from "bun:test";

import { open } from "../core.ts";
import { dump, generateWorkload, modelAfter, runWorkload, type WorkloadStep } from "./workload.ts";

const mapEqual = (a: Map<string, string>, b: Map<string, string>): boolean => {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
};

test("for a hand-built sequence, the model is exactly the committed state", () => {
  // Overwrite, delete, and an aborted transaction whose writes must NOT land.
  const steps: WorkloadStep[] = [
    { ops: [{ kind: "set", key: "k1", value: "a" }], abort: false },
    { ops: [{ kind: "set", key: "k2", value: "b" }], abort: false },
    { ops: [{ kind: "set", key: "k1", value: "a2" }], abort: false }, // overwrite
    { ops: [{ kind: "delete", key: "k2" }], abort: false }, // remove k2
    { ops: [{ kind: "set", key: "k3", value: "ghost" }], abort: true }, // aborted
  ];

  const expected = new Map([
    ["k1", "a2"],
    // k2 deleted, k3 never committed (its transaction aborted).
  ]);

  // The model computed from the steps matches the hand-traced expectation,
  expect(mapEqual(modelAfter(steps), expected)).toBe(true);

  // and running the same steps against the real kernel produces that state.
  const db = open();
  runWorkload(db, steps);
  expect(mapEqual(dump(db), expected)).toBe(true);
});

test("a generated workload's committed state equals its model oracle", () => {
  const steps = generateWorkload(20260624, { steps: 200, keys: 16, maxOps: 4 });

  const db = open();
  runWorkload(db, steps);

  // The model is a faithful oracle of the kernel's committed state.
  expect(mapEqual(dump(db), modelAfter(steps))).toBe(true);
});

test("a generated workload exercises sets, deletes, and aborts", () => {
  // The oracle's branches only matter if the workload actually hits them, so a
  // realistic seed must produce all three. This guards against a generator that
  // silently stops emitting deletes or aborts.
  const steps = generateWorkload(7, { steps: 200, keys: 8, maxOps: 4 });
  const ops = steps.flatMap((s) => s.ops);
  expect(ops.some((o) => o.kind === "set")).toBe(true);
  expect(ops.some((o) => o.kind === "delete")).toBe(true);
  expect(steps.some((s) => s.abort)).toBe(true);
});

test("the generator is deterministic: the same seed yields the same workload", () => {
  const a = generateWorkload(123, { steps: 50 });
  const b = generateWorkload(123, { steps: 50 });
  expect(a).toEqual(b);
  // A different seed yields a different sequence (sanity: it is seed-driven).
  const c = generateWorkload(124, { steps: 50 });
  expect(a).not.toEqual(c);
});

test("an aborted transaction commits nothing against the real kernel", () => {
  const db = open();
  // Commit k1, then attempt to overwrite it and write k2 in a transaction that
  // aborts: the kernel must roll the whole transaction back, so k1 keeps its
  // first value and k2 never appears.
  runWorkload(db, [
    { ops: [{ kind: "set", key: "k1", value: "keep" }], abort: false },
    {
      ops: [
        { kind: "set", key: "k1", value: "lost" },
        { kind: "set", key: "k2", value: "lost" },
      ],
      abort: true,
    },
  ]);
  expect(mapEqual(dump(db), new Map([["k1", "keep"]]))).toBe(true);
});

test("dump of an empty database is an empty map", () => {
  expect(dump(open()).size).toBe(0);
});

test("runWorkload surfaces a genuine error instead of swallowing it as an abort", () => {
  const db = open();
  db.close(); // any later transact throws "database is closed"
  // The step does not abort, so the thrown error is real and must propagate —
  // proving only the typed intended-abort is swallowed, never a true fault.
  expect(() => runWorkload(db, [{ ops: [{ kind: "set", key: "k1", value: "x" }], abort: false }])).toThrow(
    "database is closed",
  );
});
