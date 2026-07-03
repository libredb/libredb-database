/**
 * node-fs.test.ts — the default node:fs adapter: fd-based IO, directory fsync,
 * and the exclusive open lock.
 *
 * The adapter is an edge (no durability logic of its own), but it carries two
 * platform facts the kernel's guarantees stand on: a created file's directory
 * entry must be fsync'd to be durable, and the `<path>.lock` file is what turns
 * a second writer into a loud LOCKED error. Both are pinned here, alongside the
 * read/append/truncate mechanics the WAL drives.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "bun:test";

import { LibreDbError } from "../core.ts";
import { forceUnlock, fsyncDirectoryOf, isStaleLock, LOCK_SENTINEL, nodeFileSystem } from "./node-fs.ts";

const dirs: string[] = [];
const tempPath = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "libredb-nodefs-"));
  dirs.push(dir);
  return join(dir, name);
};

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** A pid above every default Linux pid_max: guaranteed not alive. */
const DEAD_PID = 4194304;
const liveLock = (): string => `${LOCK_SENTINEL}\n${process.pid}\n${hostname()}\nnonce\n`;
const deadLock = (): string => `${LOCK_SENTINEL}\n${DEAD_PID}\n${hostname()}\nnonce\n`;
const otherHostLock = (): string => `${LOCK_SENTINEL}\n${DEAD_PID}\nsome-other-host\nnonce\n`;

// --- file IO mechanics ---

test("read() honors offset and length through the file descriptor", () => {
  const path = tempPath("io");
  const file = nodeFileSystem().open(path);
  file.append(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
  expect(file.read(2, 4)).toEqual(new Uint8Array([3, 4, 5, 6]));
  expect(file.size()).toBe(8);
  file.close();
});

test("read() past the end returns only the bytes that exist", () => {
  const path = tempPath("short");
  const file = nodeFileSystem().open(path);
  file.append(new Uint8Array([1, 2, 3]));
  expect(file.read(1, 100)).toEqual(new Uint8Array([2, 3]));
  file.close();
});

test("truncate() shrinks the file through the same descriptor", () => {
  const path = tempPath("trunc");
  const file = nodeFileSystem().open(path);
  file.append(new Uint8Array([1, 2, 3, 4]));
  file.truncate(2);
  file.fsync();
  expect(file.size()).toBe(2);
  expect(file.read(0, 2)).toEqual(new Uint8Array([1, 2]));
  file.close();
  expect(new Uint8Array(readFileSync(path))).toEqual(new Uint8Array([1, 2]));
});

test("fsyncDirectoryOf tolerates a directory that cannot be opened", () => {
  // Platforms without directory fsync (Windows) throw on the open; the helper
  // must swallow that, since directory-entry durability is best-effort there.
  expect(() => fsyncDirectoryOf(join(tmpdir(), "libredb-no-such-dir-xyz", "file"))).not.toThrow();
});

test("fsyncDirectoryOf fsyncs an existing parent directory without error", () => {
  const path = tempPath("synced");
  writeFileSync(path, "x");
  expect(() => fsyncDirectoryOf(path)).not.toThrow();
});

// --- the exclusive open lock ---

test("lock() creates <path>.lock and the release function removes it", () => {
  const path = tempPath("db");
  const fs = nodeFileSystem();
  const release = fs.lock?.(path) as () => void;
  expect(existsSync(`${path}.lock`)).toBe(true);
  const contents = readFileSync(`${path}.lock`, "utf8");
  expect(contents.startsWith(LOCK_SENTINEL)).toBe(true);
  expect(contents).toContain(String(process.pid));
  release();
  expect(existsSync(`${path}.lock`)).toBe(false);
});

test("a second lock() against a live holder throws LOCKED", () => {
  const path = tempPath("db");
  const fs = nodeFileSystem();
  const release = fs.lock?.(path) as () => void;
  let caught: unknown;
  try {
    fs.lock?.(path);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(LibreDbError);
  expect((caught as LibreDbError).code).toBe("LOCKED");
  release();
});

test("a stale lock (dead pid) is reclaimed and locking proceeds", () => {
  const path = tempPath("db");
  writeFileSync(`${path}.lock`, deadLock());
  const release = nodeFileSystem().lock?.(path) as () => void;
  expect(readFileSync(`${path}.lock`, "utf8")).toContain(String(process.pid));
  release();
});

test("a legacy sentinel-only lock (no owner recorded) is NOT auto-reclaimed", () => {
  // It may belong to a live 0.1.x CLI (that format recorded no pid), or be a
  // concurrent lock() caught between create and write. No liveness info means
  // no automatic stealing; forceUnlock is the explicit escape hatch.
  const path = tempPath("db");
  writeFileSync(`${path}.lock`, `${LOCK_SENTINEL}\n`); // v0.1.x CLI format
  let caught: unknown;
  try {
    nodeFileSystem().lock?.(path);
  } catch (error) {
    caught = error;
  }
  expect((caught as LibreDbError).code).toBe("LOCKED");
  forceUnlock(path);
  expect(existsSync(`${path}.lock`)).toBe(false);
});

test("a sentineled lock with a mangled pid is anonymous, never auto-stale", () => {
  // Corruption that keeps the sentinel line but garbles the owner must not
  // read as a dead holder: pid=NaN would probe as "dead" and let a LIVE
  // holder's lock be auto-reclaimed. Unparseable owner info means no
  // liveness info — locked until --force.
  const path = tempPath("db");
  const lockPath = `${path}.lock`;
  for (const mangled of ["garbage", "-5", "3.14", ""]) {
    writeFileSync(lockPath, `${LOCK_SENTINEL}\n${mangled}\n${hostname()}\nnonce\n`);
    expect(isStaleLock(lockPath)).toBe(false);
  }
  let caught: unknown;
  try {
    nodeFileSystem().lock?.(path);
  } catch (error) {
    caught = error;
  }
  expect((caught as LibreDbError).code).toBe("LOCKED");
  forceUnlock(path); // the explicit escape hatch still works
  expect(existsSync(lockPath)).toBe(false);
});

test("a file that merely starts with the sentinel text is foreign, not a lock", () => {
  const path = tempPath("db");
  writeFileSync(`${path}.lock`, `${LOCK_SENTINEL}smith\ndata\n`); // "libredb-locksmith..."
  let caught: unknown;
  try {
    forceUnlock(path); // must refuse: exact first-line match required
  } catch (error) {
    caught = error;
  }
  expect((caught as LibreDbError).code).toBe("LOCKED");
  expect(readFileSync(`${path}.lock`, "utf8")).toBe(`${LOCK_SENTINEL}smith\ndata\n`);
});

test("a lock held on another host is not reclaimed (liveness unverifiable)", () => {
  const path = tempPath("db");
  writeFileSync(`${path}.lock`, otherHostLock());
  let caught: unknown;
  try {
    nodeFileSystem().lock?.(path);
  } catch (error) {
    caught = error;
  }
  expect((caught as LibreDbError).code).toBe("LOCKED");
  expect(existsSync(`${path}.lock`)).toBe(true);
});

test("a foreign file named <path>.lock is never treated as a stale lock", () => {
  const path = tempPath("db");
  writeFileSync(`${path}.lock`, "user data that merely shares the name");
  let caught: unknown;
  try {
    nodeFileSystem().lock?.(path);
  } catch (error) {
    caught = error;
  }
  expect((caught as LibreDbError).code).toBe("LOCKED");
  expect(readFileSync(`${path}.lock`, "utf8")).toBe("user data that merely shares the name");
});

test("a non-EEXIST failure creating the lock surfaces unchanged (not LOCKED)", () => {
  const bogus = join(tmpdir(), "libredb-no-such-dir-xyz", "db");
  let caught: unknown;
  try {
    nodeFileSystem().lock?.(bogus);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as { code?: string }).code).toBe("ENOENT");
});

test("release() does not delete a lock someone else re-acquired after a force", () => {
  const path = tempPath("db");
  const fs = nodeFileSystem();
  const release = fs.lock?.(path) as () => void;
  // Simulate: our lock was force-removed and another writer locked the file.
  const theirs = `${LOCK_SENTINEL}\n${DEAD_PID}\n${hostname()}\ntheir-nonce\n`;
  writeFileSync(`${path}.lock`, theirs);
  release(); // must notice the nonce mismatch and leave their lock alone
  expect(readFileSync(`${path}.lock`, "utf8")).toBe(theirs);
});

test("release() tolerates the lock file already being gone", () => {
  const path = tempPath("db");
  const release = nodeFileSystem().lock?.(path) as () => void;
  rmSync(`${path}.lock`);
  expect(() => release()).not.toThrow();
});

// --- staleness rules, pinned directly ---

test("isStaleLock: a vanished lock file counts as stale (retryable)", () => {
  expect(isStaleLock(join(tmpdir(), "libredb-vanished-xyz.lock"))).toBe(true);
});

test("isStaleLock: ONLY a verifiably dead holder is stale", () => {
  const path = tempPath("db");
  const lockPath = `${path}.lock`;
  writeFileSync(lockPath, deadLock());
  expect(isStaleLock(lockPath)).toBe(true); // same host, pid verifiably gone
  // Everything without verified death is non-stale: anonymity carries no
  // liveness info (and could be a concurrent create-then-write in flight).
  writeFileSync(lockPath, "");
  expect(isStaleLock(lockPath)).toBe(false);
  writeFileSync(lockPath, `${LOCK_SENTINEL}\n`);
  expect(isStaleLock(lockPath)).toBe(false);
  writeFileSync(lockPath, liveLock());
  expect(isStaleLock(lockPath)).toBe(false);
  writeFileSync(lockPath, otherHostLock());
  expect(isStaleLock(lockPath)).toBe(false);
  writeFileSync(lockPath, "not a lock at all");
  expect(isStaleLock(lockPath)).toBe(false);
});

// --- forceUnlock: the CLI's --force ---

test("forceUnlock removes dead-holder and unverifiable locks, refuses live and foreign ones", () => {
  const path = tempPath("db");
  const lockPath = `${path}.lock`;

  forceUnlock(path); // no lock at all: a quiet no-op

  writeFileSync(lockPath, deadLock());
  forceUnlock(path);
  expect(existsSync(lockPath)).toBe(false);

  writeFileSync(lockPath, otherHostLock());
  forceUnlock(path); // unverifiable holder: force takes it, risk on the caller
  expect(existsSync(lockPath)).toBe(false);

  writeFileSync(lockPath, liveLock());
  let live: unknown;
  try {
    forceUnlock(path);
  } catch (error) {
    live = error;
  }
  expect((live as LibreDbError).code).toBe("LOCKED");
  expect(existsSync(lockPath)).toBe(true);

  writeFileSync(lockPath, "the user's own bytes");
  let foreign: unknown;
  try {
    forceUnlock(path);
  } catch (error) {
    foreign = error;
  }
  expect((foreign as LibreDbError).code).toBe("LOCKED");
  expect(readFileSync(lockPath, "utf8")).toBe("the user's own bytes");
});
