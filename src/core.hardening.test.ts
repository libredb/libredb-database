/**
 * core.hardening.test.ts — the kernel's failure-mode contract.
 *
 * The crash model (append-only + CRC + fsync-before-visible) is pinned by
 * core.recovery.test.ts and the DST suite. THIS suite pins everything that sits
 * outside that model — the pre-announcement audit findings:
 *
 *   - a foreign file is refused, never truncated (the WAL magic header)
 *   - mid-log corruption refuses to open instead of silently truncating
 *   - an async transact() body is rejected before it can half-commit
 *   - a failed append/fsync latches the database (fsyncgate)
 *   - keys and values are copied at the API boundary (no aliasing)
 *   - getRange snapshots, so delete-while-scanning visits every entry
 *   - close() during a transaction is a named error, not a raw EBADF
 *   - double-open of one file is a loud LOCKED error
 *
 * Every error carries a stable LibreDbError code — asserted here so the codes
 * are contract, not decoration.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "bun:test";

import { LibreDbError, open, type FileSystem, type WalFile } from "./core.ts";
import { open as openNode } from "./index.ts";

const bytes = (...b: number[]): Uint8Array => new Uint8Array(b);

const dirs: string[] = [];
const tempPath = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "libredb-hard-"));
  dirs.push(dir);
  return join(dir, name);
};

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** Grab the LibreDbError a thunk throws, asserting it threw at all. */
const errorFrom = (thunk: () => unknown): LibreDbError => {
  try {
    thunk();
  } catch (error) {
    expect(error).toBeInstanceOf(LibreDbError);
    return error as LibreDbError;
  }
  throw new Error("expected the thunk to throw");
};

// --- a fault-injectable in-memory filesystem for the kernel-level tests ---

interface FaultFile {
  data: number[];
  /** When set, the next append persists only this many bytes, then throws. */
  failAppendAfter: number | undefined;
  /** When true, the next fsync throws (the bytes stay in `data`). */
  failNextFsync: boolean | undefined;
  /** When set, the next read returns this many bytes fewer than asked. */
  shortReadBy: number | undefined;
}

function faultFs(): { fs: FileSystem; file: FaultFile } {
  const file: FaultFile = { data: [], failAppendAfter: undefined, failNextFsync: undefined, shortReadBy: undefined };
  const fs: FileSystem = {
    open(): WalFile {
      return {
        size: () => file.data.length,
        read(offset, length) {
          let end = Math.min(offset + length, file.data.length);
          if (file.shortReadBy !== undefined) {
            end -= file.shortReadBy;
            file.shortReadBy = undefined;
          }
          return Uint8Array.from(file.data.slice(offset, end));
        },
        append(b) {
          if (file.failAppendAfter !== undefined) {
            const kept = file.failAppendAfter;
            file.failAppendAfter = undefined;
            for (const byte of b.subarray(0, kept)) file.data.push(byte);
            throw new Error("injected: ENOSPC");
          }
          for (const byte of b) file.data.push(byte);
        },
        fsync() {
          if (file.failNextFsync === true) {
            file.failNextFsync = undefined;
            throw new Error("injected: EIO on fsync");
          }
        },
        truncate(length) {
          file.data.length = length;
        },
        close() {},
      };
    },
  };
  return { fs, file };
}

/** CRC-32 (IEEE), duplicated here so the tests can hand-craft on-disk records
 * without borrowing the kernel's implementation (which they judge). */
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] as number;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const u32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

/** Encode one legacy (headerless, v0.1.x) record that sets `key` to `value`. */
function legacyRecord(key: number[], value: number[]): number[] {
  const payload = [1, ...u32(key.length), ...key, ...u32(value.length), ...value];
  return [...u32(payload.length), ...u32(crc32(Uint8Array.from(payload))), ...payload];
}

// --- LibreDbError: the typed error contract ---

test("kernel errors are LibreDbError instances with a stable code and libredb: prefix", () => {
  const db = open();
  db.close();
  const error = errorFrom(() => db.transact(() => 0));
  expect(error.name).toBe("LibreDbError");
  expect(error.code).toBe("CLOSED");
  expect(error.message).toMatch(/^libredb: /);
});

test("a nested transact carries the NESTED_TRANSACTION code", () => {
  const db = open();
  expect(errorFrom(() => db.transact(() => db.transact(() => 0))).code).toBe("NESTED_TRANSACTION");
  db.close();
});

test("an empty path and a missing filesystem carry INVALID_ARGUMENT", () => {
  expect(errorFrom(() => open({ path: "" })).code).toBe("INVALID_ARGUMENT");
  expect(errorFrom(() => open({ path: "x" })).code).toBe("INVALID_ARGUMENT");
});

// --- issue #16: async transact() bodies are rejected before commit ---

test("an async transact() callback throws ASYNC_TRANSACTION and commits nothing", () => {
  const path = tempPath("async");
  const db = openNode({ path });
  db.transact((tx) => tx.set(bytes(1), bytes(10)));

  const error = errorFrom(() =>
    db.transact(async (tx) => {
      tx.set(bytes(2), bytes(20));
      await Promise.resolve();
      tx.set(bytes(3), bytes(30));
    }),
  );
  expect(error.code).toBe("ASYNC_TRANSACTION");

  // Nothing from the async body was committed — not even the pre-await write —
  // in memory or on disk.
  expect(db.transact((tx) => tx.get(bytes(2)))).toBeUndefined();
  db.close();
  const reopened = openNode({ path });
  expect(reopened.transact((tx) => tx.get(bytes(2)))).toBeUndefined();
  expect(reopened.transact((tx) => tx.get(bytes(1)))).toEqual(bytes(10));
  reopened.close();
});

test("a thenable (non-Promise) return value is rejected the same way", () => {
  const db = open();
  const thenable = { then: () => {} };
  expect(errorFrom(() => db.transact(() => thenable)).code).toBe("ASYNC_TRANSACTION");
  db.close();
});

test("returning a plain object or function from transact() still works", () => {
  const db = open();
  expect(db.transact(() => ({ answer: 42 }))).toEqual({ answer: 42 });
  const fn = (): number => 7;
  expect(db.transact(() => fn)).toBe(fn);
  db.close();
});

// --- issue #31: close() during a transaction is a named error ---

test("close() inside a transaction throws CLOSE_IN_TRANSACTION and the db stays usable", () => {
  const db = open();
  expect(
    errorFrom(() =>
      db.transact(() => {
        db.close();
      }),
    ).code,
  ).toBe("CLOSE_IN_TRANSACTION");
  // The database survived the misuse: it is neither closed nor wedged.
  db.transact((tx) => tx.set(bytes(1), bytes(1)));
  expect(db.transact((tx) => tx.get(bytes(1)))).toEqual(bytes(1));
  db.close();
});

// --- issue #13: foreign files are refused, never truncated ---

test("open() on a non-LibreDB file throws NOT_A_DATABASE and leaves every byte in place", () => {
  const path = tempPath("notes.txt");
  const contents = "these are the user's notes, not a database\n";
  writeFileSync(path, contents);

  expect(errorFrom(() => openNode({ path })).code).toBe("NOT_A_DATABASE");
  expect(readFileSync(path, "utf8")).toBe(contents);
  // The refusal also released the open lock.
  expect(existsSync(`${path}.lock`)).toBe(false);
});

test("a new database writes the LRDB file header with its first commit", () => {
  const path = tempPath("fresh");
  const db = openNode({ path });
  db.transact((tx) => tx.set(bytes(1), bytes(10)));
  db.close();

  const disk = new Uint8Array(readFileSync(path));
  expect([...disk.subarray(0, 4)]).toEqual([0x4c, 0x52, 0x44, 0x42]); // "LRDB"
  expect(((disk[4] as number) << 8) | (disk[5] as number)).toBe(1); // format version
});

test("a headerless v0.1.x database still opens, reads, and accepts writes", () => {
  const path = tempPath("legacy");
  writeFileSync(path, Uint8Array.from([...legacyRecord([1], [10]), ...legacyRecord([2], [20])]));

  const db = openNode({ path });
  expect(db.transact((tx) => tx.get(bytes(1)))).toEqual(bytes(10));
  db.transact((tx) => tx.set(bytes(3), bytes(30)));
  db.close();

  // The legacy file stays headerless (a header cannot be inserted mid-file);
  // reopening replays all three records through the legacy read path.
  const reopened = openNode({ path });
  expect(reopened.transact((tx) => tx.get(bytes(2)))).toEqual(bytes(20));
  expect(reopened.transact((tx) => tx.get(bytes(3)))).toEqual(bytes(30));
  reopened.close();
});

test("a file written by a NEWER format version is refused with UNSUPPORTED_VERSION", () => {
  const path = tempPath("future");
  writeFileSync(path, Uint8Array.from([0x4c, 0x52, 0x44, 0x42, 0, 2, 0, 0]));
  expect(errorFrom(() => openNode({ path })).code).toBe("UNSUPPORTED_VERSION");
});

test("a header torn mid-write (first commit interrupted) restarts the database from empty", () => {
  const path = tempPath("torn-header");
  writeFileSync(path, Uint8Array.from([0x4c, 0x52])); // "LR": a magic prefix, cut short
  const truncations: number[] = [];
  const db = openNode({ path, onRecovery: (info) => truncations.push(info.truncatedBytes) });
  expect(truncations).toEqual([2]); // the torn header was reported, not silent
  db.transact((tx) => tx.set(bytes(1), bytes(10)));
  db.close();
  const reopened = openNode({ path });
  expect(reopened.transact((tx) => tx.get(bytes(1)))).toEqual(bytes(10));
  reopened.close();
});

// --- issue #22: corruption classification ---

test("mid-log corruption refuses to open with CORRUPT_WAL and truncates nothing", () => {
  const { fs, file } = faultFs();
  const db = open({ path: "wal", fs });
  db.transact((tx) => tx.set(bytes(1), bytes(10)));
  db.transact((tx) => tx.set(bytes(2), bytes(20)));
  db.close();

  // Flip a payload byte of the FIRST record (offset: 8 header + 8 record
  // header = 16). Intact record 2 sits after it, so this is damage to
  // once-durable bytes, not a crash artifact.
  file.data[16] = (file.data[16] as number) ^ 0xff;
  const sizeBefore = file.data.length;

  expect(errorFrom(() => open({ path: "wal", fs })).code).toBe("CORRUPT_WAL");
  expect(file.data.length).toBe(sizeBefore); // refuse means refuse: no truncate
});

test("a CRC-valid record with a malformed payload is corruption, not ops", () => {
  const path = tempPath("malformed");
  // A legacy-framed record whose payload has a valid checksum but a bogus op
  // tag (7): structurally impossible output of this kernel, so it must refuse
  // rather than misread garbage into the store. Probed at offset 0 with no
  // valid record before it, the file is simply not a database we recognize.
  const payload = [7, 0, 0, 0, 1, 0];
  const record = [...u32(payload.length), ...u32(crc32(Uint8Array.from(payload))), ...payload];
  writeFileSync(path, Uint8Array.from(record));
  expect(errorFrom(() => openNode({ path })).code).toBe("NOT_A_DATABASE");

  // The same malformed record BEHIND a valid one (a recognized database) is
  // named for what it is: a corrupt WAL.
  const path2 = tempPath("malformed-2");
  writeFileSync(path2, Uint8Array.from([...legacyRecord([1], [10]), ...record]));
  expect(errorFrom(() => openNode({ path: path2 })).code).toBe("CORRUPT_WAL");
});

test("recovery reports a torn tail through onRecovery instead of dropping it silently", () => {
  const path = tempPath("reported");
  const db = openNode({ path });
  db.transact((tx) => tx.set(bytes(1), bytes(10)));
  db.close();
  // A crash mid-append: the header promises more bytes than follow.
  const torn = Uint8Array.from([...u32(0xffff), ...u32(0), 1, 2, 3]);
  writeFileSync(path, Uint8Array.from([...readFileSync(path), ...torn]));

  const truncations: number[] = [];
  const reopened = openNode({ path, onRecovery: (info) => truncations.push(info.truncatedBytes) });
  expect(truncations).toEqual([torn.length]);
  expect(reopened.transact((tx) => tx.get(bytes(1)))).toEqual(bytes(10));
  reopened.close();
});

// --- issue #23/#10: a short read is an IO fault, never a truncation ---

test("a read that returns fewer bytes than the file holds throws INCOMPLETE_READ", () => {
  const { fs, file } = faultFs();
  const db = open({ path: "wal", fs });
  db.transact((tx) => tx.set(bytes(1), bytes(10)));
  db.close();

  file.shortReadBy = 3;
  expect(errorFrom(() => open({ path: "wal", fs })).code).toBe("INCOMPLETE_READ");
  // Transient fault: the next open (full read) succeeds.
  const reopened = open({ path: "wal", fs });
  expect(reopened.transact((tx) => tx.get(bytes(1)))).toEqual(bytes(10));
  reopened.close();
});

// --- issue #19: a failed append/fsync latches the database (fsyncgate) ---

test("a partially-written append latches the database; the torn tail cannot poison later commits", () => {
  const { fs, file } = faultFs();
  const db = open({ path: "wal", fs });
  db.transact((tx) => tx.set(bytes(1), bytes(10))); // commit A: durable

  file.failAppendAfter = 5; // commit B tears after 5 bytes, then ENOSPC
  expect(() => db.transact((tx) => tx.set(bytes(2), bytes(20)))).toThrow(/ENOSPC/);

  // The database is latched: it refuses commit C outright instead of appending
  // it after the torn bytes (where the next recovery would destroy it).
  expect(errorFrom(() => db.transact((tx) => tx.set(bytes(3), bytes(30)))).code).toBe("FAILED");
  // Reads-in-memory are also refused: the instance is done until reopen.
  expect(errorFrom(() => db.transact((tx) => tx.get(bytes(1)))).code).toBe("FAILED");
  db.close();

  // Reopen repairs the tail: commit A survives, B and C never happened.
  const reopened = open({ path: "wal", fs });
  expect(reopened.transact((tx) => tx.get(bytes(1)))).toEqual(bytes(10));
  expect(reopened.transact((tx) => tx.get(bytes(2)))).toBeUndefined();
  reopened.close();
});

test("after a failed fsync the database refuses further work until reopened", () => {
  const { fs, file } = faultFs();
  const db = open({ path: "wal", fs });
  db.transact((tx) => tx.set(bytes(1), bytes(10)));

  file.failNextFsync = true;
  expect(() => db.transact((tx) => tx.set(bytes(2), bytes(20)))).toThrow(/EIO/);
  expect(errorFrom(() => db.transact((tx) => tx.set(bytes(3), bytes(30)))).code).toBe("FAILED");
  db.close();

  // After fsyncgate, the un-acknowledged bytes of commit B may or may not have
  // reached the disk — both are legal outcomes. What is NOT legal is losing
  // commit A, whose transact() returned success.
  const reopened = open({ path: "wal", fs });
  expect(reopened.transact((tx) => tx.get(bytes(1)))).toEqual(bytes(10));
  reopened.close();
});

// --- issue #14: keys and values are copied at the API boundary ---

test("mutating a caller buffer after set() cannot corrupt the committed store", () => {
  const path = tempPath("aliasing");
  const db = openNode({ path });
  const key = bytes(1);
  const value = bytes(10);
  db.transact((tx) => tx.set(key, value));

  key[0] = 99; // the scratch-buffer-reuse pattern
  value[0] = 88;

  expect(db.transact((tx) => tx.get(bytes(1)))).toEqual(bytes(10));
  expect(db.transact((tx) => tx.get(bytes(99)))).toBeUndefined();
  db.close();
  // Disk agrees with memory: the journal held copies too.
  const reopened = openNode({ path });
  expect(reopened.transact((tx) => tx.get(bytes(1)))).toEqual(bytes(10));
  reopened.close();
});

test("mutating a value returned by get() cannot corrupt the committed store", () => {
  const db = open();
  db.transact((tx) => tx.set(bytes(1), bytes(10)));
  const returned = db.transact((tx) => tx.get(bytes(1))) as Uint8Array;
  returned[0] = 77;
  expect(db.transact((tx) => tx.get(bytes(1)))).toEqual(bytes(10));
  db.close();
});

test("mutating entries yielded by getRange() cannot corrupt the committed store", () => {
  const db = open();
  db.transact((tx) => tx.set(bytes(1), bytes(10)));
  db.transact((tx) => {
    for (const entry of tx.getRange(bytes(0), bytes(255))) {
      (entry.key as Uint8Array)[0] = 66;
      (entry.value as Uint8Array)[0] = 66;
    }
  });
  expect(db.transact((tx) => tx.get(bytes(1)))).toEqual(bytes(10));
  db.close();
});

test("a buffer reused across a whole loop leaves every committed key intact and sorted", () => {
  const db = open();
  const scratch = new Uint8Array(1);
  db.transact((tx) => {
    for (const b of [5, 3, 9, 1]) {
      scratch[0] = b;
      tx.set(scratch, scratch);
    }
  });
  const keys = db.transact((tx) => [...tx.getRange(bytes(0), bytes(255))].map((e) => e.key[0]));
  expect(keys).toEqual([1, 3, 5, 9]); // sorted invariant survived the reuse
  db.close();
});

// --- issue #17: getRange snapshots, so scans and writes compose ---

test("delete-while-scanning visits and deletes every entry in the range", () => {
  const db = open();
  db.transact((tx) => {
    for (const b of [1, 2, 3, 4, 5]) tx.set(bytes(b), bytes(b));
  });
  const visited: number[] = [];
  db.transact((tx) => {
    for (const entry of tx.getRange(bytes(0), bytes(255))) {
      visited.push(entry.key[0] as number);
      tx.delete(entry.key);
    }
  });
  expect(visited).toEqual([1, 2, 3, 4, 5]); // no skips
  expect(db.transact((tx) => [...tx.getRange(bytes(0), bytes(255))])).toEqual([]);
  db.close();
});

test("insert-while-scanning does not duplicate or surprise the running scan", () => {
  const db = open();
  db.transact((tx) => {
    tx.set(bytes(1), bytes(1));
    tx.set(bytes(3), bytes(3));
  });
  const visited: number[] = [];
  db.transact((tx) => {
    for (const entry of tx.getRange(bytes(0), bytes(255))) {
      visited.push(entry.key[0] as number);
      tx.set(bytes(2), bytes(2)); // lands between the two — invisible to THIS scan
    }
  });
  expect(visited).toEqual([1, 3]);
  // ...but visible to the next scan, as documented.
  const after = db.transact((tx) => [...tx.getRange(bytes(0), bytes(255))].map((e) => e.key[0]));
  expect(after).toEqual([1, 2, 3]);
  db.close();
});

// --- issue #21: exclusive open lock ---

test("a second open() of the same live path throws LOCKED; close() releases it", () => {
  const path = tempPath("locked");
  const first = openNode({ path });
  expect(errorFrom(() => openNode({ path })).code).toBe("LOCKED");
  first.close();
  const second = openNode({ path }); // released: reopen succeeds
  second.close();
});

test("a stale lock from a dead process is reclaimed automatically", () => {
  const path = tempPath("stale");
  // Pid 2^22 is above every default Linux pid_max, so it cannot be alive.
  writeFileSync(`${path}.lock`, `libredb-lock\n4194304\n${hostname()}\nnonce\n`);
  const db = openNode({ path });
  db.transact((tx) => tx.set(bytes(1), bytes(1)));
  db.close();
  expect(existsSync(`${path}.lock`)).toBe(false);
});
