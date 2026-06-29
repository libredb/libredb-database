/**
 * lock.test.ts — the CLI's advisory write lock.
 *
 * LibreDB is single-process with no file locking of its own, so two concurrent
 * writers would corrupt a file. Write commands take an advisory `<path>.lock`
 * to make a second writer fail loudly instead. The lock is advisory, not a
 * kernel guarantee: `--force` overrides a stale one.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "bun:test";

import { acquireLock } from "./lock.ts";

const dirs: string[] = [];
const tempPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "libredb-lock-"));
  dirs.push(dir);
  return join(dir, "db");
};

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

test("acquires a lock file and releases it", () => {
  const path = tempPath();
  const lock = acquireLock(path, false);
  expect(existsSync(`${path}.lock`)).toBe(true);
  lock.release();
  expect(existsSync(`${path}.lock`)).toBe(false);
});

test("refuses when a lock is already held", () => {
  const path = tempPath();
  writeFileSync(`${path}.lock`, ""); // another writer holds it
  expect(() => acquireLock(path, false)).toThrow(/locked/i);
});

test("--force drops a real libredb lock and re-acquires", () => {
  const path = tempPath();
  acquireLock(path, false); // a prior writer's lock, left behind (e.g. it crashed)
  const lock = acquireLock(path, true); // force clears it and takes a fresh one
  expect(existsSync(`${path}.lock`)).toBe(true);
  lock.release();
  expect(existsSync(`${path}.lock`)).toBe(false);
});

test("--force with no existing lock simply acquires", () => {
  const path = tempPath();
  const lock = acquireLock(path, true);
  expect(existsSync(`${path}.lock`)).toBe(true);
  lock.release();
});

test("--force refuses to delete a file that is not a libredb lock", () => {
  const path = tempPath();
  writeFileSync(`${path}.lock`, "this is the user's own data, not a lock");
  expect(() => acquireLock(path, true)).toThrow(/not a libredb lock/i);
  // The user's file is left intact.
  expect(existsSync(`${path}.lock`)).toBe(true);
});
