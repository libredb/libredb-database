/**
 * dst.test.ts — the deterministic-simulation crash/recovery torture suite (plan S4).
 *
 * This IS the test: the DST runner's whole purpose is to be exercised across
 * many seeds. Each seed builds a fresh crash-injecting {@link SimFS}, opens the
 * WAL on it, runs a seeded workload, simulates a power-loss crash, reopens, and
 * checks THE INVARIANT:
 *
 *   the recovered committed state equals the committed state after SOME prefix
 *   of the successfully-committed transactions — never a partial transaction,
 *   never fabricated data.
 *
 * For a clean crash (committed data is already fsync'd-durable, only an
 * un-fsync'd torn tail is lost) that prefix is the FULL workload. The explicit
 * torn-tail, CRC-corruption and short-read cases below damage the log on
 * purpose and prove recovery still lands on a valid committed prefix.
 *
 * Everything is seed-driven, so any failure replays byte-for-byte: re-run
 * `runSeed(seed)` (or set LIBREDB_DST_SEEDS for a longer soak).
 */
import { expect, test } from "bun:test";

import { open } from "../core.ts";
import { SimFS } from "./simfs.ts";
import {
  committedPrefixStates,
  describeFailure,
  isCommittedPrefix,
  mapEqual,
  runSeed,
  type SeedResult,
} from "./dst.ts";
import { dump, generateWorkload, modelAfter, runWorkload, type WorkloadStep } from "./workload.ts";

/** Read a big-endian u32 from a byte array (mirrors the kernel's framing) so a
 * test can find a record boundary to corrupt. */
const readU32 = (b: Uint8Array, at: number): number =>
  (b[at] ?? 0) * 0x1000000 + ((b[at + 1] ?? 0) << 16) + ((b[at + 2] ?? 0) << 8) + (b[at + 3] ?? 0);

const WAL = "wal";

// --- the seeded crash/recovery loop (the heart of the DST suite) ---

const SEED_BASE = Number(process.env.LIBREDB_DST_BASE ?? 0) || 0;
const SEED_COUNT = Number(process.env.LIBREDB_DST_SEEDS ?? 50) || 50;

test(`the crash/recovery invariant holds across ${SEED_COUNT} seeds`, () => {
  for (let i = 0; i < SEED_COUNT; i++) {
    const result = runSeed(SEED_BASE + i);
    // A clean crash loses only the un-fsync'd torn tail, so the recovered state
    // must equal the FULL committed model, and must be a valid committed prefix.
    expect(result.passed, describeFailure(result)).toBe(true);
    const states = committedPrefixStates(generateWorkload(result.seed));
    expect(isCommittedPrefix(result.recovered, states)).toBe(true);
  }
});

test("runSeed is deterministic: the same seed yields the same recovery", () => {
  const a = runSeed(424242);
  const b = runSeed(424242);
  expect(mapEqual(a.recovered, b.recovered)).toBe(true);
  expect(mapEqual(a.expected, b.expected)).toBe(true);
});

test("a clean crash (no in-flight write) recovers the full committed model", () => {
  const fs = new SimFS(99);
  const steps = generateWorkload(99);
  const db = open({ path: WAL, fs });
  runWorkload(db, steps);
  // Every commit fsync'd, so there is nothing un-fsync'd for the crash to tear.
  fs.crash();
  const recovered = dump(open({ path: WAL, fs }));
  expect(mapEqual(recovered, modelAfter(steps))).toBe(true);
});

// --- explicit torn-tail case ---

test("a torn in-flight append is discarded; committed state survives the crash", () => {
  const fs = new SimFS(7);
  const steps: WorkloadStep[] = [
    { ops: [{ kind: "set", key: "k1", value: "committed" }], abort: false },
    { ops: [{ kind: "set", key: "k2", value: "alsocommitted" }], abort: false },
  ];
  const db = open({ path: WAL, fs });
  runWorkload(db, steps);

  // Simulate power loss partway through appending the next commit: a record
  // header promising 0xffff payload bytes, but only 3 reached the buffer, and
  // NO fsync — so it lives in the un-fsync'd tail a crash can tear.
  fs.open(WAL).append(Uint8Array.from([0, 0, 0xff, 0xff, 0, 0, 0, 0, 1, 2, 3]));
  fs.crash();

  const recovered = dump(open({ path: WAL, fs }));
  // The torn record never lands, no matter where the crash tore it.
  expect(mapEqual(recovered, modelAfter(steps))).toBe(true);
  expect([...recovered.keys()].sort()).toEqual(["k1", "k2"]);
});

// --- explicit CRC-corruption case ---

test("corruption of the first record drops the whole log on recovery", () => {
  const fs = new SimFS(3);
  const steps: WorkloadStep[] = [
    { ops: [{ kind: "set", key: "k0", value: "a" }], abort: false },
    { ops: [{ kind: "set", key: "k1", value: "b" }], abort: false },
    { ops: [{ kind: "set", key: "k2", value: "c" }], abort: false },
  ];
  const db = open({ path: WAL, fs });
  runWorkload(db, steps);

  // Flip a byte inside the FIRST record's payload (offset 8 = just past its
  // 8-byte header). Its checksum then fails, so recovery stops at record 0.
  fs.corrupt(WAL, 8);

  const recovered = dump(open({ path: WAL, fs }));
  expect(recovered.size).toBe(0); // nothing before the first record to keep
  expect(isCommittedPrefix(recovered, committedPrefixStates(steps))).toBe(true);
});

test("corruption mid-log keeps the valid prefix and drops the rest", () => {
  const fs = new SimFS(5);
  const steps: WorkloadStep[] = [
    { ops: [{ kind: "set", key: "k0", value: "a" }], abort: false },
    { ops: [{ kind: "set", key: "k1", value: "b" }], abort: false },
    { ops: [{ kind: "set", key: "k2", value: "c" }], abort: false },
  ];
  const db = open({ path: WAL, fs });
  runWorkload(db, steps);

  // Corrupt a byte inside the SECOND record's payload. Record 0 has payload
  // length len0 (header at 0, payload at 8); record 1's header starts at
  // 8 + len0 and its payload at (8 + len0) + 8. Same-shape rows => same size.
  const durable = fs.durableBytes(WAL);
  const len0 = readU32(durable, 0);
  fs.corrupt(WAL, 8 + len0 + 8);

  const recovered = dump(open({ path: WAL, fs }));
  // Record 0 survives; record 1 (corrupt) and everything after are dropped.
  expect(mapEqual(recovered, new Map([["k0", "a"]]))).toBe(true);
  expect(isCommittedPrefix(recovered, committedPrefixStates(steps))).toBe(true);
});

// --- explicit short-read case ---

test("a short read during recovery still lands on a valid committed prefix", () => {
  const fs = new SimFS(11);
  const steps = generateWorkload(11);
  const db = open({ path: WAL, fs });
  runWorkload(db, steps);

  // The next read (recovery's single read of the whole log) returns a seeded
  // short prefix. Recovery must not fabricate state from the truncated bytes.
  fs.armShortRead();
  const recovered = dump(open({ path: WAL, fs }));

  // A short read may lose a SUFFIX of committed records, but the result is
  // still a valid committed prefix — never a torn or fabricated state. (It can
  // even hold MORE keys than the final model if later deletes were cut off, so
  // the only honest assertion is prefix membership.)
  const states = committedPrefixStates(steps);
  expect(isCommittedPrefix(recovered, states)).toBe(true);
});

// --- the oracle helpers themselves ---

test("committedPrefixStates enumerates the per-commit prefixes, skipping aborts", () => {
  const steps: WorkloadStep[] = [
    { ops: [{ kind: "set", key: "k1", value: "a" }], abort: false },
    { ops: [{ kind: "set", key: "k9", value: "ghost" }], abort: true }, // skipped
    { ops: [{ kind: "set", key: "k2", value: "b" }], abort: false },
    { ops: [{ kind: "delete", key: "k1" }], abort: false },
  ];
  const states = committedPrefixStates(steps);
  // One state per committed transaction, plus the empty starting state.
  expect(states.length).toBe(4);
  expect(states[0]?.size).toBe(0);
  expect(mapEqual(states[1] as Map<string, string>, new Map([["k1", "a"]]))).toBe(true);
  expect(
    mapEqual(
      states[2] as Map<string, string>,
      new Map([
        ["k1", "a"],
        ["k2", "b"],
      ]),
    ),
  ).toBe(true);
  expect(mapEqual(states[3] as Map<string, string>, new Map([["k2", "b"]]))).toBe(true);
  // The last prefix state is the full model.
  expect(mapEqual(states[states.length - 1] as Map<string, string>, modelAfter(steps))).toBe(true);
});

test("isCommittedPrefix rejects a state that is not any committed prefix", () => {
  const states = committedPrefixStates([{ ops: [{ kind: "set", key: "k1", value: "a" }], abort: false }]);
  expect(isCommittedPrefix(new Map([["k1", "a"]]), states)).toBe(true);
  expect(isCommittedPrefix(new Map([["k1", "WRONG"]]), states)).toBe(false);
  expect(isCommittedPrefix(new Map([["kX", "a"]]), states)).toBe(false);
});

test("mapEqual distinguishes size, keys, and values", () => {
  expect(mapEqual(new Map(), new Map())).toBe(true);
  expect(mapEqual(new Map([["a", "1"]]), new Map([["a", "1"]]))).toBe(true);
  expect(mapEqual(new Map([["a", "1"]]), new Map())).toBe(false); // size
  expect(mapEqual(new Map([["a", "1"]]), new Map([["b", "1"]]))).toBe(false); // key
  expect(mapEqual(new Map([["a", "1"]]), new Map([["a", "2"]]))).toBe(false); // value
});

test("describeFailure names the seed and is a runnable replay hint", () => {
  const result: SeedResult = {
    seed: 1234,
    recovered: new Map([["k1", "x"]]),
    expected: new Map([["k1", "y"]]),
    passed: false,
  };
  const message = describeFailure(result);
  expect(message).toContain("seed 1234");
  expect(message).toContain("runSeed(1234)");
});
