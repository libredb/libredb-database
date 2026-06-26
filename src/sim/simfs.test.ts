/**
 * simfs.test.ts — tests for SimFS, the crash-injecting filesystem (plan S2).
 *
 * SimFS is the foundation of deterministic simulation testing (DESIGN.md
 * section 6.4): a seeded, in-memory filesystem that implements the kernel's
 * FileSystem/WalFile seam and can simulate a crash by keeping only durable
 * bytes plus a seeded-length torn tail of the last un-fsync'd append, and can
 * inject CRC corruption and short reads. These tests pin SimFS's OWN behaviour
 * (the workload + the crash/recovery torture runner are later phases, S3/S4):
 * fsync'd data survives a crash, an un-fsync'd tail is torn at a seeded point,
 * a given seed is replayable, and injected corruption/short-reads surface.
 */
import { expect, test } from "bun:test";

import { open } from "../core.ts";
import { SimFS } from "./simfs.ts";

const bytes = (...b: number[]): Uint8Array => new Uint8Array(b);
const arr = (u: Uint8Array): number[] => Array.from(u);

test("fsync'd bytes always survive a crash; the surviving file is a prefix of all appended bytes", () => {
  const durable = [1, 2, 3, 4];
  const tail = [5, 6, 7, 8, 9, 10];

  const sim = new SimFS(98765);
  const file = sim.open("db");
  file.append(bytes(...durable));
  file.fsync(); // these four bytes are now durable
  file.append(bytes(...tail)); // appended but NOT fsync'd
  sim.crash();

  const survived = arr(sim.durableBytes("db"));
  // The fsync'd prefix is always intact.
  expect(survived.slice(0, durable.length)).toEqual(durable);
  // Nothing beyond the appended bytes ever appears, and at most the torn tail
  // is kept: the survivor is a prefix of durable ++ tail.
  const all = [...durable, ...tail];
  expect(survived).toEqual(all.slice(0, survived.length));
  expect(survived.length).toBeGreaterThanOrEqual(durable.length);
  expect(survived.length).toBeLessThanOrEqual(all.length);
});

test("an un-fsync'd tail is genuinely torn at a seeded point (not all-or-nothing)", () => {
  const durable = [1, 2, 3, 4];
  const tail = [5, 6, 7, 8, 9, 10];

  // Run the same scenario under many seeds; at least one must keep a STRICT
  // partial prefix of the tail (more than zero, fewer than all) — proof the
  // crash tears the last append at a seeded boundary rather than dropping or
  // keeping it whole every time.
  let sawStrictlyTorn = false;
  for (let seed = 0; seed < 64; seed++) {
    const sim = new SimFS(seed);
    const file = sim.open("db");
    file.append(bytes(...durable));
    file.fsync();
    file.append(bytes(...tail));
    sim.crash();
    const len = sim.durableBytes("db").length;
    if (len > durable.length && len < durable.length + tail.length) {
      sawStrictlyTorn = true;
    }
  }
  expect(sawStrictlyTorn).toBe(true);
});

test("a crash is deterministic: the same seed tears the same tail", () => {
  const run = (seed: number): number[] => {
    const sim = new SimFS(seed);
    const file = sim.open("db");
    file.append(bytes(10, 11, 12));
    file.fsync();
    file.append(bytes(20, 21, 22, 23, 24));
    sim.crash();
    return arr(sim.durableBytes("db"));
  };
  // Same seed, two independent runs -> byte-for-byte identical crash outcome
  // (the replay property DST depends on).
  expect(run(424242)).toEqual(run(424242));
});

test("fsync'd commits survive a crash and a reopen through the WAL", () => {
  const sim = new SimFS(7);
  const db = open({ path: "db", fs: sim });
  db.transact((tx) => tx.set(bytes(1), bytes(10)));
  db.transact((tx) => tx.set(bytes(2), bytes(20)));
  db.close();

  // Every commit was fsync'd, so nothing is in the un-fsync'd tail; a crash
  // loses nothing.
  sim.crash();

  const reopened = open({ path: "db", fs: sim });
  expect(reopened.transact((tx) => tx.get(bytes(1)))).toEqual(bytes(10));
  expect(reopened.transact((tx) => tx.get(bytes(2)))).toEqual(bytes(20));
  reopened.close();
});

test("injected CRC corruption surfaces as a dropped tail on recovery", () => {
  const sim = new SimFS(3);
  const db = open({ path: "db", fs: sim });
  db.transact((tx) => tx.set(bytes(1), bytes(10))); // record 1
  db.transact((tx) => tx.set(bytes(2), bytes(20))); // record 2 (the tail)
  db.close();

  // Flip a byte in the last record's payload so its CRC no longer matches.
  const size = sim.durableBytes("db").length;
  sim.corrupt("db", size - 1);

  const reopened = open({ path: "db", fs: sim });
  // Recovery trusts the valid prefix (record 1) and drops the corrupt tail.
  expect(reopened.transact((tx) => tx.get(bytes(1)))).toEqual(bytes(10));
  expect(reopened.transact((tx) => tx.get(bytes(2)))).toBeUndefined();
  reopened.close();
});

test("a short read returns fewer bytes than requested, once, then reads recover", () => {
  const sim = new SimFS(55);
  const file = sim.open("db");
  file.append(bytes(1, 2, 3, 4, 5));
  file.fsync();

  sim.armShortRead();
  const short = file.read(0, 5);
  expect(short.length).toBeLessThan(5); // the read came up short
  // Whatever it returned is a true prefix of the file (a short read, not garbage).
  expect(arr(short)).toEqual([1, 2, 3, 4, 5].slice(0, short.length));

  // The short read is one-shot: the next read sees the whole file again.
  expect(arr(file.read(0, 5))).toEqual([1, 2, 3, 4, 5]);
});

test("corrupt rejects an out-of-range offset and an unknown path", () => {
  const sim = new SimFS(1);
  const file = sim.open("db");
  file.append(bytes(1, 2, 3));
  file.fsync();

  expect(() => sim.corrupt("db", 99)).toThrow();
  expect(() => sim.corrupt("db", -1)).toThrow();
  expect(() => sim.corrupt("missing", 0)).toThrow();
});

test("truncate shrinks across the durable/pending boundary and is a no-op past EOF", () => {
  const sim = new SimFS(1);
  const file = sim.open("db");
  file.append(bytes(1, 2, 3, 4));
  file.fsync(); // 4 durable bytes
  file.append(bytes(5, 6)); // 2 pending bytes, size now 6

  // Truncating into the pending region keeps the durable bytes plus part of
  // the pending tail.
  file.truncate(5);
  expect(file.size()).toBe(5);
  expect(arr(file.read(0, 5))).toEqual([1, 2, 3, 4, 5]);

  // Truncating into the durable region drops pending entirely.
  file.truncate(2);
  expect(file.size()).toBe(2);
  expect(arr(file.read(0, 2))).toEqual([1, 2]);

  // Truncating at or past the current size changes nothing.
  file.truncate(99);
  expect(file.size()).toBe(2);
});
