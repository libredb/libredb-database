/**
 * core.recovery.test.ts — durability and crash recovery for the kernel.
 *
 * Durability is non-negotiable
 * (DESIGN.md section 3), so these tests are the real specification of the
 * recovery layer: committed writes must survive a reopen AND a simulated crash
 * (a process that dies without a graceful close), while anything not committed
 * — an aborted transaction, or a commit interrupted mid-write — must leave no
 * trace.
 *
 * The kernel persists with a write-ahead log: each committed transaction is one
 * checksummed, length-framed record appended and fsync'd before the commit is
 * exposed. Recovery replays the log and discards a torn or corrupt tail record
 * (the only place a crash can damage an append-only log).
 */
import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Recovery is exercised on a real disk, so it opens through the Node entry,
// whose `open` supplies the default node:fs adapter (the kernel itself carries
// no default filesystem).
import { open } from "./index.ts";

/** Build a key/value from byte numbers — keeps the tests terse and readable. */
const bytes = (...b: number[]): Uint8Array => new Uint8Array(b);

/** Encode a u32 in the same big-endian order the kernel's log uses, so the
 * crash-injection tests below can hand-craft on-disk frames. */
const u32 = (n: number): Buffer => Buffer.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);

/** Temp directories created during the run, cleaned up after each test. */
const dirs: string[] = [];
const tempPath = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "libredb-rec-"));
  dirs.push(dir);
  return join(dir, name);
};

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** Read the full store as [keyByte, valueByte] pairs in ascending key order. */
const dump = (db: ReturnType<typeof open>): number[][] =>
  db.transact((tx) => {
    const out: number[][] = [];
    for (const e of tx.getRange(bytes(0), bytes(255))) out.push([e.key[0]!, e.value[0]!]);
    return out;
  });

test("a fresh path opens as an empty, usable database", () => {
  const path = tempPath("fresh");
  const db = open({ path });
  expect(db.transact((tx) => tx.get(bytes(1)))).toBeUndefined();
  db.transact((tx) => tx.set(bytes(1), bytes(10)));
  expect(db.transact((tx) => tx.get(bytes(1)))).toEqual(bytes(10));
  db.close();
});

test("committed writes survive a graceful close and reopen", () => {
  const path = tempPath("graceful");
  const first = open({ path });
  first.transact((tx) => tx.set(bytes(7), bytes(99)));
  first.close();

  const second = open({ path });
  expect(second.transact((tx) => tx.get(bytes(7)))).toEqual(bytes(99));
  second.close();
});

test("committed writes survive a simulated crash (no graceful close)", () => {
  const path = tempPath("crash");
  const crashed = open({ path });
  crashed.transact((tx) => tx.set(bytes(1), bytes(10)));
  crashed.transact((tx) => tx.set(bytes(2), bytes(20)));
  // Simulate a crash: the process dies without ever calling close(). Because
  // each commit fsync'd before returning, the data is already durable.

  const recovered = open({ path });
  expect(dump(recovered)).toEqual([
    [1, 10],
    [2, 20],
  ]);
  recovered.close();
});

test("recovery replays overwrites and deletes so the latest committed state wins", () => {
  const path = tempPath("replay");
  const db = open({ path });
  db.transact((tx) => {
    tx.set(bytes(1), bytes(10));
    tx.set(bytes(2), bytes(20));
    tx.set(bytes(3), bytes(30));
  });
  db.transact((tx) => tx.set(bytes(2), bytes(99))); // overwrite, separate commit
  db.transact((tx) => tx.delete(bytes(3))); // delete, separate commit
  db.close();

  const reopened = open({ path });
  expect(dump(reopened)).toEqual([
    [1, 10],
    [2, 99],
  ]);
  reopened.close();
});

test("an aborted transaction leaves no trace after recovery", () => {
  const path = tempPath("abort");
  const db = open({ path });
  db.transact((tx) => tx.set(bytes(1), bytes(10)));
  expect(() =>
    db.transact((tx) => {
      tx.set(bytes(2), bytes(20));
      throw new Error("boom");
    }),
  ).toThrow("boom");
  db.close();

  const reopened = open({ path });
  expect(dump(reopened)).toEqual([[1, 10]]);
  reopened.close();
});

test("a read-only transaction does not grow the log", () => {
  const path = tempPath("readonly");
  const db = open({ path });
  db.transact((tx) => tx.set(bytes(1), bytes(10)));
  const sizeAfterWrite = statSync(path).size;

  db.transact((tx) => tx.get(bytes(1))); // no writes -> nothing to persist
  expect(statSync(path).size).toBe(sizeAfterWrite);
  db.close();
});

test("a torn tail record from a crash mid-commit is discarded on recovery", () => {
  const path = tempPath("torn");
  const db = open({ path });
  db.transact((tx) => tx.set(bytes(1), bytes(10)));
  db.transact((tx) => tx.set(bytes(2), bytes(20)));
  db.close();
  const goodSize = statSync(path).size;

  // Simulate a crash partway through appending a third commit: the frame header
  // promises 8 payload bytes, but only 3 were flushed before the power cut.
  appendFileSync(path, Buffer.concat([u32(8), u32(0), Buffer.from([1, 2, 3])]));

  const reopened = open({ path });
  expect(dump(reopened)).toEqual([
    [1, 10],
    [2, 20],
  ]);
  reopened.close();
  // The torn tail was truncated back to the last fully-committed record.
  expect(statSync(path).size).toBe(goodSize);
});

test("a tail record whose checksum fails is discarded on recovery", () => {
  const path = tempPath("corrupt");
  const db = open({ path });
  db.transact((tx) => tx.set(bytes(5), bytes(50)));
  db.close();
  const goodSize = statSync(path).size;

  // Append a fully-sized record whose checksum does not match its payload, as a
  // half-flushed disk block would produce. payload = [set, keyLen=1, key=0].
  const payload = Buffer.from([1, 0, 0, 0, 1, 0]);
  appendFileSync(path, Buffer.concat([u32(payload.length), u32(0), payload]));

  const reopened = open({ path });
  expect(dump(reopened)).toEqual([[5, 50]]);
  reopened.close();
  expect(statSync(path).size).toBe(goodSize);
});

test("keys recovered from the log keep correct byte-lexicographic order", () => {
  const path = tempPath("order");
  const db = open({ path });
  db.transact((tx) => {
    for (const b of [10, 2, 255, 0, 1]) tx.set(bytes(b), bytes(b));
  });
  db.close();

  const reopened = open({ path });
  const keys = reopened.transact((tx) => {
    const out: number[] = [];
    for (const e of tx.getRange(bytes(), bytes(255, 255))) out.push(e.key[0]!);
    return out;
  });
  expect(keys).toEqual([0, 1, 2, 10, 255]);
  reopened.close();
});

test("close is idempotent for a file-backed database", () => {
  const path = tempPath("idempotent");
  const db = open({ path });
  db.transact((tx) => tx.set(bytes(1), bytes(1)));
  db.close();
  expect(() => db.close()).not.toThrow();
});

test("using a file-backed database after close throws", () => {
  const path = tempPath("closed");
  const db = open({ path });
  db.close();
  expect(() => db.transact((tx) => tx.get(bytes(1)))).toThrow();
});
