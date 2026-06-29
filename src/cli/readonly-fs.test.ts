/**
 * readonly-fs.test.ts — the CLI's read-only filesystem adapter.
 *
 * Inspection commands (inspect/get/scan/stats) must never mutate the file they
 * read. That matters because open() runs recovery, which would truncate a torn
 * tail and so write to a "read-only" target. This adapter satisfies the kernel's
 * FileSystem seam for reads only: size and read work; append and fsync refuse;
 * truncate is a deliberate no-op so recovery can drop a torn tail in memory
 * while the file on disk is left exactly as it was found.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "bun:test";

import { readonlyFileSystem } from "./readonly-fs.ts";

const dirs: string[] = [];
const tempFile = (contents: Uint8Array): string => {
  const dir = mkdtempSync(join(tmpdir(), "libredb-ro-"));
  dirs.push(dir);
  const path = join(dir, "db");
  writeFileSync(path, contents);
  return path;
};

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

test("size and read reflect the file on disk", () => {
  const path = tempFile(new Uint8Array([1, 2, 3, 4, 5]));
  const file = readonlyFileSystem().open(path);
  expect(file.size()).toBe(5);
  expect(file.read(1, 3)).toEqual(new Uint8Array([2, 3, 4]));
  file.close();
});

test("append and fsync refuse, so a read can never write", () => {
  const path = tempFile(new Uint8Array([1]));
  const file = readonlyFileSystem().open(path);
  expect(() => file.append(new Uint8Array([9]))).toThrow(/read-only/i);
  expect(() => file.fsync()).toThrow(/read-only/i);
  file.close();
});

test("truncate is a no-op: the file on disk is left untouched", () => {
  const original = new Uint8Array([1, 2, 3, 4]);
  const path = tempFile(original);
  const file = readonlyFileSystem().open(path);
  file.truncate(2); // recovery dropping a torn tail must not reach the disk here
  file.close();
  expect(new Uint8Array(readFileSync(path))).toEqual(original);
});

test("opening an absent file throws", () => {
  expect(() => readonlyFileSystem().open(join(tmpdir(), "libredb-does-not-exist-xyz"))).toThrow();
});
