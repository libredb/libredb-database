/**
 * run.test.ts — the CLI dispatcher and its read commands.
 *
 * run(argv, io) is the whole CLI as a pure function: it takes an argument vector
 * and an IO sink and returns an exit code, so every command and error path is
 * testable without spawning a process. These cover the read commands (inspect,
 * stats, get, scan) against real .libredb files, plus usage and error handling.
 */
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "bun:test";

import { open } from "../index.ts";
import { doc } from "../lens/document.ts";
import { kv } from "../lens/kv.ts";
import { table } from "../lens/relational.ts";
import { acquireLock } from "./lock.ts";
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

test("an inherited object property is not a command (no prototype pollution)", () => {
  // "toString"/"__proto__" resolve to Object.prototype on a plain object; the
  // dispatch Map must reject them like any other unknown command.
  for (const name of ["toString", "constructor", "__proto__"]) {
    const r = cli(name, "x");
    expect(r.code).toBe(2);
    expect(r.err.join("\n")).toMatch(/unknown command/i);
  }
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

test("set writes a value that get reads back, and releases the lock", () => {
  const path = fixture();
  expect(cli("set", path, "color", "teal").code).toBe(0);
  expect(cli("get", path, "color").out).toEqual(["teal"]);
  expect(existsSync(`${path}.lock`)).toBe(false); // lock released after the write
});

test("set with no value is a usage error", () => {
  const r = cli("set", fixture(), "k");
  expect(r.code).toBe(2);
  expect(r.err.join("\n")).toMatch(/value/i);
});

test("delete removes an existing key, reporting one removed", () => {
  const path = fixture();
  const r = cli("delete", path, "user:1");
  expect(r.code).toBe(0);
  expect(r.out.join("\n")).toMatch(/1 removed/);
  expect(cli("get", path, "user:1").code).toBe(1); // gone
});

test("delete of an absent key succeeds and reports zero removed", () => {
  const r = cli("delete", fixture(), "user:404");
  expect(r.code).toBe(0);
  expect(r.out.join("\n")).toMatch(/0 removed/);
});

test("delete with no key is a usage error", () => {
  const r = cli("delete", fixture());
  expect(r.code).toBe(2);
  expect(r.err.join("\n")).toMatch(/key/i);
});

/** Write a JSON file next to the database and return its path. */
const jsonFile = (dbPath: string, contents: unknown): string => {
  const file = `${dbPath}.import.json`;
  writeFileSync(file, JSON.stringify(contents));
  return file;
};

test("import bulk-sets keys that get reads back", () => {
  const path = fixture();
  const file = jsonFile(path, { a: "1", b: "2", c: "3" });
  const r = cli("import", path, file);
  expect(r.code).toBe(0);
  expect(r.out.join("\n")).toMatch(/import 3 keys/);
  expect(cli("get", path, "a").out).toEqual(["1"]);
  expect(cli("get", path, "c").out).toEqual(["3"]);
});

test("import rejects a non-object JSON payload", () => {
  const path = fixture();
  const r = cli("import", path, jsonFile(path, [1, 2, 3]));
  expect(r.code).toBe(2);
  expect(r.err.join("\n")).toMatch(/object of string values/i);
});

test("import rejects a non-string value", () => {
  const path = fixture();
  const r = cli("import", path, jsonFile(path, { a: "ok", b: 5 }));
  expect(r.code).toBe(2);
  expect(r.err.join("\n")).toMatch(/object of string values/i);
});

test("import with no file is a usage error", () => {
  const r = cli("import", fixture());
  expect(r.code).toBe(2);
  expect(r.err.join("\n")).toMatch(/file/i);
});

test("import rejects malformed JSON as a usage error (exit 2)", () => {
  const path = fixture();
  const file = `${path}.bad.json`;
  writeFileSync(file, "{ not valid json");
  const r = cli("import", path, file);
  expect(r.code).toBe(2);
  expect(r.err.join("\n")).toMatch(/json/i);
});

test("a write refuses when the database is locked", () => {
  const path = fixture();
  writeFileSync(`${path}.lock`, ""); // another writer holds the lock
  const r = cli("set", path, "k", "v");
  expect(r.code).toBe(1);
  expect(r.err.join("\n")).toMatch(/locked/i);
});

test("--force overrides a stale libredb lock", () => {
  const path = fixture();
  acquireLock(path, false); // a prior writer's lock, left behind (e.g. it crashed)
  const r = cli("set", path, "k", "v", "--force");
  expect(r.code).toBe(0);
  expect(cli("get", path, "k").out).toEqual(["v"]);
});

test("set refuses to write a reserved key", () => {
  const r = cli("set", fixture(), "\u0000libredb:catalog:people", "x");
  expect(r.code).toBe(2);
  expect(r.err.join("\n")).toMatch(/reserved key/i);
});

test("import refuses a reserved key so it cannot corrupt the catalog", () => {
  const path = fixture();
  const file = jsonFile(path, { ok: "1", "\u0000libredb:catalog:people": "evil" });
  const r = cli("import", path, file);
  expect(r.code).toBe(2);
  expect(r.err.join("\n")).toMatch(/reserved key/i);
});

test("a read recovers a crash-torn file in memory without changing the bytes on disk", () => {
  const path = fixture();
  // Simulate a crash mid-append: tack a partial/garbage record onto the WAL.
  appendFileSync(path, Buffer.from([0xff, 0xff, 0xff, 0xff, 1, 2, 3]));
  const sizeBefore = Bun.file(path).size;
  const r = cli("get", path, "user:1"); // reads the intact committed prefix
  expect(r.code).toBe(0);
  expect(r.out).toEqual(["Ada"]);
  // Read-only: recovery dropped the torn tail in memory only; disk is untouched.
  expect(Bun.file(path).size).toBe(sizeBefore);
});
