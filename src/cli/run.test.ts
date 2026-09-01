/**
 * run.test.ts — the CLI dispatcher and its read commands.
 *
 * run(argv, io) is the whole CLI as a pure function: it takes an argument vector
 * and an IO sink and returns an exit code, so every command and error path is
 * testable without spawning a process. These cover the read commands (inspect,
 * stats, get, scan, export) against real .libredb files, plus usage and error
 * handling.
 */
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "bun:test";

import { LOCK_SENTINEL } from "../adapter/node-fs.ts";
import { open } from "../index.ts";
import { isReservedKey } from "../lens/catalog.ts";
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
  cli("export", path, `${path}.export.json`);
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

test("import rejects lone-surrogate keys and values (the kv lens invariant holds for bulk loads)", () => {
  const path = fixture();
  // JSON.parse happily produces lone surrogates from \uD800 escapes; without
  // validation the import would write them through the kernel directly, where
  // two distinct malformed keys collide on the same UTF-8 bytes.
  const file = `${path}.surrogate.json`;
  writeFileSync(file, String.raw`{"bad-\ud800-key": "v"}`);
  const badKey = cli("import", path, file);
  expect(badKey.code).toBe(2);
  expect(badKey.err.join("\n")).toMatch(/lone surrogate/i);

  writeFileSync(file, String.raw`{"ok": "bad-\udfff-value"}`);
  const badValue = cli("import", path, file);
  expect(badValue.code).toBe(2);
  expect(badValue.err.join("\n")).toMatch(/lone surrogate/i);
  expect(cli("get", path, "ok").code).toBe(1); // nothing was written
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

/** Read a dump written by `export` back as the object `import` would consume. */
const readDump = (file: string): Record<string, string> =>
  JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;

test("export dumps the kv layer in the shape import consumes, and the round trip restores it", () => {
  const source = fixture();
  // Widen the shared fixture into a mixed-namespace, mixed-encoding one: raw kv
  // pairs, a document row, a table row, and the serialization cases a dump has
  // to survive. "__proto__" is here because `object[key] = value` on a plain
  // object would silently drop it (the inherited setter defines no own property).
  const db = open({ path: source });
  kv(db).set("quote", '"quoted" and a \\ backslash');
  kv(db).set("control", "line\nbreak\ttab\u001b[2J");
  kv(db).set("unicode", "üñíçödé \u{1f600} \u{10ffff}");
  kv(db).set("empty-value", "");
  kv(db).set("", "the empty key is a legal key");
  kv(db).set("__proto__", "not a prototype");
  table(db, "people", { primaryKey: "id", columns: { id: "string", name: "string" } }).insert({
    id: "p1",
    name: "Ada",
  });
  db.close();

  const dump = `${source}.export.json`;
  const exported = cli("export", source, dump);
  expect(exported.code).toBe(0);
  expect(exported.out).toEqual(["export 10 keys"]);

  const dumped = readDump(dump);
  // Raw kv pairs, plus document and table rows as their internal prefixed
  // entries (v1 exports the kv layer; there is no per-lens serializer).
  expect(dumped["user:1"]).toBe("Ada");
  expect(dumped["logs:l1"]).toBe('{"message":"hi"}');
  expect(dumped["people:p1"]).toBe('{"id":"p1","name":"Ada"}');
  expect(dumped["quote"]).toBe('"quoted" and a \\ backslash');
  // Verbatim, NOT sanitized: get/scan would print that ESC as \x1b so an
  // untrusted value cannot drive a terminal, but a dump is data that has to
  // import back unchanged; JSON.stringify escapes it as \u001b in the file.
  expect(dumped["control"]).toBe("line\nbreak\ttab\u001b[2J");
  expect(dumped["unicode"]).toBe("üñíçödé \u{1f600} \u{10ffff}");
  expect(dumped["empty-value"]).toBe("");
  expect(dumped[""]).toBe("the empty key is a legal key");
  expect(dumped["__proto__"]).toBe("not a prototype");
  expect(Object.keys(dumped)).toHaveLength(10);
  expect(Object.values(dumped).every((value) => typeof value === "string")).toBe(true);
  // The reserved catalog namespace is NOT dumped: import refuses those keys, so
  // emitting them would produce a file import cannot read.
  expect(Object.keys(dumped).filter(isReservedKey)).toEqual([]);

  // The round trip: dump -> a brand-new database -> dump again. Comparing the two
  // dumps proves every exported key AND value survived, not just the exit codes.
  const restored = `${source}.restored.libredb`;
  const imported = cli("import", restored, dump);
  expect(imported.code).toBe(0);
  expect(imported.out).toEqual(["import 10 keys"]);
  const roundTripped = `${source}.round-trip.json`;
  expect(cli("export", restored, roundTripped).code).toBe(0);
  expect(readDump(roundTripped)).toEqual(dumped);
  // And the restored database really answers reads with the same values.
  expect(cli("get", restored, "user:1").out).toEqual(["Ada"]);
  expect(cli("get", restored, "people:p1").out).toEqual(['{"id":"p1","name":"Ada"}']);
});

test("export leaves the database byte-identical and creates no lock file", () => {
  const path = fixture();
  const before = new Uint8Array(readFileSync(path));
  const r = cli("export", path, `${path}.export.json`);
  expect(r.code).toBe(0);
  // Byte-for-byte, not merely the same size: export opens through the read-only
  // filesystem adapter, which has no lock() at all, so a read can neither write
  // nor announce itself.
  expect(new Uint8Array(readFileSync(path))).toEqual(before);
  expect(existsSync(`${path}.lock`)).toBe(false);
});

test("export refuses a database holding raw non-UTF-8 bytes instead of dumping replacement characters", () => {
  const dir = mkdtempSync(join(tmpdir(), "libredb-cli-"));
  dirs.push(dir);
  const path = join(dir, "raw.libredb");
  const db = open({ path });
  // Only reachable by writing through the kernel directly: 0x80 is a bare UTF-8
  // continuation byte. Decoded loosely it becomes U+FFFD, which would import
  // back as a different key — so export refuses the whole dump instead.
  db.transact((tx) => tx.set(new Uint8Array([0x80]), new TextEncoder().encode("v")));
  db.close();
  const r = cli("export", path, `${path}.export.json`);
  expect(r.code).toBe(1);
  expect(r.err.join("\n")).toMatch(/not valid UTF-8/i);
});

test("export overwrites an existing output file rather than appending to it", () => {
  const path = fixture();
  const dump = `${path}.export.json`;
  writeFileSync(dump, "stale bytes from an earlier dump");
  expect(cli("export", path, dump).code).toBe(0);
  expect(readDump(dump)["user:1"]).toBe("Ada"); // it parses at all: the old bytes are gone
});

test("export with no file is a usage error", () => {
  const r = cli("export", fixture());
  expect(r.code).toBe(2);
  expect(r.err.join("\n")).toMatch(/file/i);
});

/** A lock file naming a live holder: this very test process. */
const liveLock = (): string => `${LOCK_SENTINEL}\n${process.pid}\n${hostname()}\nnonce\n`;

test("a write refuses when a live writer holds the lock", () => {
  const path = fixture();
  writeFileSync(`${path}.lock`, liveLock()); // a live holder (this process)
  const r = cli("set", path, "k", "v");
  expect(r.code).toBe(1);
  expect(r.err.join("\n")).toMatch(/locked/i);
});

test("a stale lock (verifiably dead holder) is reclaimed automatically, no --force needed", () => {
  const path = fixture();
  // A crashed writer's leftover, naming a pid above every default pid_max.
  writeFileSync(`${path}.lock`, `${LOCK_SENTINEL}\n4194304\n${hostname()}\nnonce\n`);
  const r = cli("set", path, "k", "v");
  expect(r.code).toBe(0);
  expect(cli("get", path, "k").out).toEqual(["v"]);
  expect(existsSync(`${path}.lock`)).toBe(false);
});

test("an anonymous (empty) lock is NOT auto-reclaimed; --force removes it", () => {
  const path = fixture();
  // An empty lock carries no liveness info — it may even be a concurrent
  // writer between its exclusive create and its sentinel write, so stealing
  // it automatically could admit two live writers.
  writeFileSync(`${path}.lock`, "");
  expect(cli("set", path, "k", "v").code).toBe(1); // locked
  const forced = cli("set", path, "k", "v", "--force");
  expect(forced.code).toBe(0);
  expect(cli("get", path, "k").out).toEqual(["v"]);
});

test("--force refuses to remove a live holder's lock", () => {
  const path = fixture();
  writeFileSync(`${path}.lock`, liveLock());
  const r = cli("set", path, "k", "v", "--force");
  expect(r.code).toBe(1);
  expect(r.err.join("\n")).toMatch(/alive/i);
});

test("--force removes a lock from another host (liveness unverifiable)", () => {
  const path = fixture();
  writeFileSync(`${path}.lock`, `${LOCK_SENTINEL}\n99999\nsome-other-host\nnonce\n`);
  expect(cli("set", path, "k", "v").code).toBe(1); // without --force: locked
  const r = cli("set", path, "k", "v", "--force");
  expect(r.code).toBe(0);
  expect(cli("get", path, "k").out).toEqual(["v"]);
});

test("--force refuses to delete a file that is not a libredb lock", () => {
  const path = fixture();
  writeFileSync(`${path}.lock`, "this is the user's own data, not a lock");
  const r = cli("set", path, "k", "v", "--force");
  expect(r.code).toBe(1);
  expect(r.err.join("\n")).toMatch(/not a libredb lock/i);
  expect(existsSync(`${path}.lock`)).toBe(true); // the user's file is intact
});

test("set refuses to write a reserved key", () => {
  const r = cli("set", fixture(), "\u0000libredb:catalog:people", "x");
  expect(r.code).toBe(2);
  expect(r.err.join("\n")).toMatch(/reserved key/i);
});

test("delete refuses a reserved key so it cannot corrupt the catalog", () => {
  const r = cli("delete", fixture(), "\u0000libredb:catalog:people");
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

test("get and scan escape control characters so stored data cannot drive the terminal", () => {
  const path = fixture();
  cli("set", path, "evil", "\u001b[2Jcleared\u0007bell");
  const got = cli("get", path, "evil");
  expect(got.code).toBe(0);
  expect(got.out).toEqual(["\\x1b[2Jcleared\\x07bell"]); // no raw ESC/BEL reaches the sink
  const scanned = cli("scan", path, "evil");
  expect(scanned.out).toEqual(["evil=\\x1b[2Jcleared\\x07bell"]);
});

test("inspect escapes control characters in namespace names", () => {
  const dir = mkdtempSync(join(tmpdir(), "libredb-cli-"));
  dirs.push(dir);
  const path = join(dir, "evil.libredb");
  const db = open({ path });
  // The lens validator rejects ":" and surrogates, but control characters are
  // legal name bytes — so inspect must escape them on the way to a terminal.
  doc(db, "evil\u001b[2Jns").put("d1", {});
  db.close();
  const r = cli("inspect", path);
  expect(r.code).toBe(0);
  expect(r.out.join("\n")).toContain("evil\\x1b[2Jns");
  expect(r.out.join("\n")).not.toContain("\u001b");
  // --raw opts out, matching get/scan.
  expect(cli("inspect", path, "--raw").out.join("\n")).toContain("evil\u001b[2Jns");
});

test("--raw prints the stored bytes verbatim for callers that want them", () => {
  const path = fixture();
  cli("set", path, "evil", "\u001b[31mred");
  const r = cli("get", path, "evil", "--raw");
  expect(r.out).toEqual(["\u001b[31mred"]);
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
