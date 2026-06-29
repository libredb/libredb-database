/**
 * main.test.ts — an end-to-end smoke test of the `libredb` bin shim.
 *
 * main.ts is pure process glue and excluded from line coverage; this test proves
 * the glue actually works by running the source entry as a real subprocess and
 * checking that argv, stdout/stderr and the exit code are wired to run().
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "bun:test";

import { open } from "../index.ts";
import { kv } from "../lens/kv.ts";

const dirs: string[] = [];
const main = join(import.meta.dir, "main.ts");

const fixture = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "libredb-bin-"));
  dirs.push(dir);
  const path = join(dir, "app.libredb");
  const db = open({ path });
  kv(db).set("k", "v");
  db.close();
  return path;
};

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

test("the bin runs end-to-end and prints a value with exit code 0", () => {
  const proc = Bun.spawnSync(["bun", main, "get", fixture(), "k"]);
  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString().trim()).toBe("v");
});

test("the bin sets a non-zero exit code and writes to stderr on error", () => {
  const proc = Bun.spawnSync(["bun", main, "get", fixture(), "absent"]);
  expect(proc.exitCode).toBe(1);
  expect(proc.stderr.toString()).toMatch(/not found/i);
});
