/**
 * core.fs.test.ts — the injectable filesystem seam (DESIGN.md section 6.4 / plan S1).
 *
 * The WAL reaches the disk only through OpenOptions.fs. These tests prove the
 * seam is real: a database can run entirely on an injected, in-memory
 * filesystem with no node:fs involved, and the kernel drives that filesystem
 * through exactly the documented operations (open/size/read/append/fsync/
 * truncate/close). The full crash-injecting SimFS is a later phase (S2); this is
 * the trivial-fake check the seam must satisfy first.
 */
import { expect, test } from "bun:test";

import { open, type FileSystem, type WalFile } from "./core.ts";

const bytes = (...b: number[]): Uint8Array => new Uint8Array(b);

/**
 * A trivial in-memory filesystem: one byte buffer per path, shared across every
 * handle opened on that path. NOT the SimFS (no crash model, no fault
 * injection) — just enough to prove the kernel never reaches for node:fs. It
 * records the method names it was asked to perform so a test can assert the WAL
 * went through the seam.
 */
function memFs(): {
  fs: FileSystem;
  files: Map<string, number[]>;
  calls: string[];
} {
  const files = new Map<string, number[]>();
  const calls: string[] = [];
  const fs: FileSystem = {
    open(path) {
      calls.push("open");
      let buf = files.get(path);
      if (buf === undefined) {
        buf = [];
        files.set(path, buf);
      }
      const backing = buf;
      const file: WalFile = {
        size() {
          calls.push("size");
          return backing.length;
        },
        read(offset, length) {
          calls.push("read");
          return Uint8Array.from(backing.slice(offset, offset + length));
        },
        append(b) {
          calls.push("append");
          for (const x of b) backing.push(x);
        },
        fsync() {
          calls.push("fsync");
        },
        truncate(length) {
          calls.push("truncate");
          backing.length = length;
        },
        close() {
          calls.push("close");
        },
      };
      return file;
    },
  };
  return { fs, files, calls };
}

test("a database runs entirely on an injected filesystem (no node:fs)", () => {
  const mem = memFs();
  const db = open({ path: "db", fs: mem.fs });
  db.transact((tx) => tx.set(bytes(1), bytes(10)));
  db.close();

  // The data lives in the injected filesystem, not on a real disk.
  expect(mem.files.has("db")).toBe(true);
  expect((mem.files.get("db") as number[]).length).toBeGreaterThan(0);
  // The commit went through the WAL's durability point.
  expect(mem.calls).toContain("append");
  expect(mem.calls).toContain("fsync");
  expect(mem.calls).toContain("close");
});

test("committed state recovers from the injected filesystem after a reopen", () => {
  const mem = memFs();
  const first = open({ path: "db", fs: mem.fs });
  first.transact((tx) => {
    tx.set(bytes(1), bytes(10));
    tx.set(bytes(2), bytes(20));
  });
  first.close();

  // Reopen on the SAME backing filesystem: recovery replays the log via the seam.
  const second = open({ path: "db", fs: mem.fs });
  expect(second.transact((tx) => tx.get(bytes(2)))).toEqual(bytes(20));
  expect(second.transact((tx) => tx.get(bytes(1)))).toEqual(bytes(10));
  // Reopen read the file through the seam (size + read), never node:fs.
  expect(mem.calls).toContain("size");
  expect(mem.calls).toContain("read");
  second.close();
});

test("an in-memory database (no path) never touches the filesystem seam", () => {
  // A trivial filesystem whose open() throws: if the kernel touched it for a
  // pathless database, this would blow up. It must not.
  const exploding: FileSystem = {
    open() {
      throw new Error("the filesystem seam must not be used without a path");
    },
  };
  const db = open({ fs: exploding });
  db.transact((tx) => tx.set(bytes(1), bytes(10)));
  expect(db.transact((tx) => tx.get(bytes(1)))).toEqual(bytes(10));
  db.close();
});
