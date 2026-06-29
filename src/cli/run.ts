/**
 * cli/run.ts — the LibreDB CLI as a pure function.
 *
 * `run(argv, io)` takes an argument vector and an IO sink and returns a process
 * exit code. Keeping the whole CLI behind this seam — no direct stdout, no
 * process.exit — is what makes every command and error path unit-testable; the
 * bin shim (main.ts) is the only place that touches the real process.
 *
 * This is open-edge tooling over the public API, not kernel code: it adds no
 * durability logic. Read commands (inspect/stats/get/scan) open through the
 * read-only filesystem adapter so inspecting a file never mutates it. Write
 * commands (set/delete/import) take an advisory lock first, and import commits
 * all keys in one transaction so a bulk load is atomic.
 */
import { readFileSync, statSync } from "node:fs";
import { parseArgs } from "node:util";

import type { Database } from "../core.ts";
import { open } from "../index.ts";
import { catalog, isReservedKey } from "../lens/catalog.ts";
import { kv } from "../lens/kv.ts";
import { acquireLock } from "./lock.ts";
import { readonlyFileSystem } from "./readonly-fs.ts";

/** Where the CLI writes its output. One call is one line; the sink adds newlines. */
interface Io {
  out(line: string): void;
  err(line: string): void;
}

/** Everything a command handler needs: the file path, the command's positional
 * arguments (everything after the path), the IO sink, and the `--force` flag. */
interface Ctx {
  path: string;
  args: string[];
  io: Io;
  force: boolean;
}

const encoder = new TextEncoder();
const utf8 = (s: string): Uint8Array => encoder.encode(s);

const USAGE = [
  "libredb - inspect and edit .libredb files",
  "",
  "Usage:",
  "  libredb inspect <path>             List each namespace, its kind, and table schemas",
  "  libredb stats <path>               Summarize the file: size and namespace counts",
  "  libredb get <path> <key>           Print the value stored at a key",
  "  libredb scan <path> <prefix>       Print key=value for every key under a prefix",
  "  libredb set <path> <key> <value>   Set a key to a value",
  "  libredb delete <path> <key>        Remove a key",
  "  libredb import <path> <file.json>  Bulk-set keys from a JSON object (one atomic commit)",
  "",
  "Options:",
  "  --force                            Override an existing write lock",
].join("\n");

/** Open `path` read-only, run `fn`, and always close — so a read leaves the file
 * exactly as it was (recovery cannot truncate a torn tail through this adapter). */
const withReadDb = <T>(path: string, fn: (db: Database) => T): T => {
  const db = open({ path, fs: readonlyFileSystem() });
  try {
    return fn(db);
  } finally {
    db.close();
  }
};

/** Take the advisory lock, open `path` for writing, run `fn`, then always close
 * and release — so a crash mid-write cannot leave the lock stranded. */
const withWriteDb = <T>(path: string, force: boolean, fn: (db: Database) => T): T => {
  const lock = acquireLock(path, force);
  try {
    const db = open({ path });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } finally {
    lock.release();
  }
};

function inspect({ path, io }: Ctx): number {
  return withReadDb(path, (db) => {
    const registry = catalog(db);
    io.out(`${path}  ${statSync(path).size} bytes`);
    if (registry.size === 0) {
      io.out("  (no catalogued namespaces)");
      return 0;
    }
    for (const [name, entry] of registry) {
      const schema = entry.schema === undefined ? "" : `  ${JSON.stringify(entry.schema)}`;
      io.out(`  ${name}  ${entry.kind}${schema}`);
    }
    return 0;
  });
}

function stats({ path, io }: Ctx): number {
  return withReadDb(path, (db) => {
    const registry = catalog(db);
    const counts = { kv: 0, document: 0, relational: 0 };
    for (const entry of registry.values()) counts[entry.kind]++;
    io.out(`${path}  ${statSync(path).size} bytes  ${registry.size} namespaces`);
    io.out(`  kv: ${counts.kv}  document: ${counts.document}  relational: ${counts.relational}`);
    return 0;
  });
}

function get({ path, args, io }: Ctx): number {
  const [key] = args;
  if (key === undefined) {
    io.err("missing <key>");
    return 2;
  }
  return withReadDb(path, (db) => {
    const value = kv(db).get(key);
    if (value === undefined) {
      io.err(`key not found: ${key}`);
      return 1;
    }
    io.out(value);
    return 0;
  });
}

function scan({ path, args, io }: Ctx): number {
  const [prefix] = args;
  if (prefix === undefined) {
    io.err("missing <prefix>");
    return 2;
  }
  return withReadDb(path, (db) => {
    for (const entry of kv(db).prefix(prefix)) io.out(`${entry.key}=${entry.value}`);
    return 0;
  });
}

function set({ path, args, io, force }: Ctx): number {
  const [key, value] = args;
  if (key === undefined || value === undefined) {
    io.err("missing <key> <value>");
    return 2;
  }
  if (isReservedKey(key)) {
    io.err(`refusing to write a reserved key: ${key}`);
    return 2;
  }
  return withWriteDb(path, force, (db) => {
    const { changed } = kv(db).set(key, value);
    io.out(`set ${key} (${changed} changed)`);
    return 0;
  });
}

function remove({ path, args, io, force }: Ctx): number {
  const [key] = args;
  if (key === undefined) {
    io.err("missing <key>");
    return 2;
  }
  return withWriteDb(path, force, (db) => {
    const { changed } = kv(db).delete(key);
    io.out(`delete ${key} (${changed} removed)`);
    return 0;
  });
}

function importKeys({ path, args, io, force }: Ctx): number {
  const [file] = args;
  if (file === undefined) {
    io.err("missing <file>");
    return 2;
  }
  const raw = readFileSync(file, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Malformed JSON is bad input, not a runtime fault — report it like the other
    // usage errors (exit 2) instead of letting it fall through to exit 1.
    io.err("import expects a file containing a JSON object of string values");
    return 2;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    io.err("import expects a JSON object of string values");
    return 2;
  }
  const pairs: [string, string][] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      io.err("import expects a JSON object of string values");
      return 2;
    }
    if (isReservedKey(key)) {
      io.err(`import: refusing to write a reserved key: ${key}`);
      return 2;
    }
    pairs.push([key, value]);
  }
  return withWriteDb(path, force, (db) => {
    // One transaction for the whole load: a bulk import either lands entirely or,
    // on a crash mid-write, not at all (recovery discards the torn record).
    db.transact((tx) => {
      for (const [key, value] of pairs) tx.set(utf8(key), utf8(value));
    });
    io.out(`import ${pairs.length} keys`);
    return 0;
  });
}

/** The commands, keyed by name. A Map (not a plain object) so an inherited
 * property name like "toString" or "__proto__" can never resolve to a handler. */
const commands = new Map<string, (ctx: Ctx) => number>([
  ["inspect", inspect],
  ["stats", stats],
  ["get", get],
  ["scan", scan],
  ["set", set],
  ["delete", remove],
  ["import", importKeys],
]);

export function run(argv: string[], io: Io): number {
  let positionals: string[];
  let values: { help?: boolean; force?: boolean };
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { help: { type: "boolean", short: "h" }, force: { type: "boolean" } },
    });
    positionals = parsed.positionals;
    values = parsed.values;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 2;
  }

  if (values.help === true || positionals.length === 0) {
    io.out(USAGE);
    return 0;
  }

  const command = positionals[0] as string;
  const handler = commands.get(command);
  if (handler === undefined) {
    io.err(`unknown command: ${command}`);
    return 2;
  }

  const path = positionals[1];
  if (path === undefined) {
    io.err("missing <path>");
    return 2;
  }

  try {
    return handler({ path, args: positionals.slice(2), io, force: values.force === true });
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
