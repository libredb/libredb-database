/**
 * run.test.ts — the CLI dispatcher and its read commands.
 *
 * run(argv, io) is the whole CLI as a pure function: it takes an argument vector
 * and an IO sink and returns an exit code, so every command and error path is
 * testable without spawning a process. These cover the read commands (inspect,
 * stats, get, scan) against real .libredb files, plus usage and error handling.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "bun:test";

import { open } from "../index.ts";
import { doc } from "../lens/document.ts";
import { kv } from "../lens/kv.ts";
import { table } from "../lens/relational.ts";
import { run } from "./run.ts";

const dirs: string[] = [];

/** Build a real .libredb fixture with one kv pair, a document, and a table. */
const fixture = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "libredb-cli-"));
  dirs.push(dir);
  const path = join(dir, "app.libredb");
  const db = open({ path });
  kv(db).set("user:1", "Ada");
  kv(db).set("user:2", "Grace");
  doc(db, "logs").put("l1", { message: "hi" });
  table(db, "people", { primaryKey: "id", columns: { id: "string", name: "string" } });
  db.close();
  return path;
};

const missing = (): string => join(tmpdir(), "libredb-absent-xyz", "nope.libredb");

/** Run the CLI, collecting stdout/stderr lines and the exit code. */
const cli = (...argv: string[]): { code: number; out: string[]; err: string[] } => {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out, err };
};

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

test("no command prints usage and succeeds", () => {
  const r = cli();
  expect(r.code).toBe(0);
  expect(r.out.join("\n")).toMatch(/usage/i);
});

test("--help prints usage and succeeds", () => {
  const r = cli("--help");
  expect(r.code).toBe(0);
  expect(r.out.join("\n")).toMatch(/usage/i);
});

test("an unknown option is a usage error", () => {
  const r = cli("inspect", "x", "--bogus");
  expect(r.code).toBe(2);
  expect(r.err.join("\n")).toMatch(/option/i);
});

test("an unknown command is a usage error", () => {
  const r = cli("frobnicate", "x");
  expect(r.code).toBe(2);
  expect(r.err.join("\n")).toMatch(/unknown command/i);
});

test("a command with no path is a usage error", () => {
  const r = cli("inspect");
  expect(r.code).toBe(2);
  expect(r.err.join("\n")).toMatch(/path/i);
});

test("inspect lists each namespace with its kind and a table schema", () => {
  const r = cli("inspect", fixture());
  expect(r.code).toBe(0);
  const text = r.out.join("\n");
  expect(text).toMatch(/logs\s+document/);
  expect(text).toMatch(/people\s+relational/);
  expect(text).toMatch(/primaryKey/); // the table's schema is shown
});

test("inspect on a file with no catalogued namespaces says so", () => {
  const dir = mkdtempSync(join(tmpdir(), "libredb-cli-"));
  dirs.push(dir);
  const path = join(dir, "empty.libredb");
  open({ path }).close(); // a valid but empty database
  const r = cli("inspect", path);
  expect(r.code).toBe(0);
  expect(r.out.join("\n")).toMatch(/no .*namespaces/i);
});

test("stats summarizes file size and namespace counts by kind", () => {
  const r = cli("stats", fixture());
  expect(r.code).toBe(0);
  const text = r.out.join("\n");
  expect(text).toMatch(/bytes/);
  expect(text).toMatch(/document: 1/);
  expect(text).toMatch(/relational: 1/);
});

test("get prints the value at a key", () => {
  const r = cli("get", fixture(), "user:1");
  expect(r.code).toBe(0);
  expect(r.out).toEqual(["Ada"]);
});

test("get on a missing key fails with a clear error", () => {
  const r = cli("get", fixture(), "user:404");
  expect(r.code).toBe(1);
  expect(r.err.join("\n")).toMatch(/not found/i);
});

test("get with no key is a usage error", () => {
  const r = cli("get", fixture());
  expect(r.code).toBe(2);
  expect(r.err.join("\n")).toMatch(/key/i);
});

test("scan prints key=value for every key under a prefix", () => {
  const r = cli("scan", fixture(), "user:");
  expect(r.code).toBe(0);
  expect(r.out).toEqual(["user:1=Ada", "user:2=Grace"]);
});

test("scan with no prefix is a usage error", () => {
  const r = cli("scan", fixture());
  expect(r.code).toBe(2);
  expect(r.err.join("\n")).toMatch(/prefix/i);
});

test("a read command on an absent file fails cleanly (exit 1)", () => {
  const r = cli("inspect", missing());
  expect(r.code).toBe(1);
  expect(r.err.length).toBeGreaterThan(0);
});

test("reading never mutates the file (read-only open)", () => {
  const path = fixture();
  const before = Bun.file(path).size;
  cli("inspect", path);
  cli("get", path, "user:1");
  cli("scan", path, "user:");
  cli("stats", path);
  expect(Bun.file(path).size).toBe(before);
});
