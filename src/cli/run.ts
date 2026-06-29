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
 * read-only filesystem adapter so inspecting a file never mutates it.
 */
import { statSync } from "node:fs";
import { parseArgs } from "node:util";

import type { Database } from "../core.ts";
import { open } from "../index.ts";
import { catalog } from "../lens/catalog.ts";
import { kv } from "../lens/kv.ts";
import { readonlyFileSystem } from "./readonly-fs.ts";

/** Where the CLI writes its output. One call is one line; the sink adds newlines. */
interface Io {
  out(line: string): void;
  err(line: string): void;
}

const USAGE = [
  "libredb - inspect and edit .libredb files",
  "",
  "Usage:",
  "  libredb inspect <path>          List each namespace, its kind, and table schemas",
  "  libredb stats <path>            Summarize the file: size and namespace counts",
  "  libredb get <path> <key>        Print the value stored at a key",
  "  libredb scan <path> <prefix>    Print key=value for every key under a prefix",
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

function inspect(path: string, _arg: string | undefined, io: Io): number {
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

function stats(path: string, _arg: string | undefined, io: Io): number {
  return withReadDb(path, (db) => {
    const registry = catalog(db);
    const counts = { kv: 0, document: 0, relational: 0 };
    for (const entry of registry.values()) counts[entry.kind]++;
    io.out(`${path}  ${statSync(path).size} bytes  ${registry.size} namespaces`);
    io.out(`  kv: ${counts.kv}  document: ${counts.document}  relational: ${counts.relational}`);
    return 0;
  });
}

function get(path: string, key: string | undefined, io: Io): number {
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

function scan(path: string, prefix: string | undefined, io: Io): number {
  if (prefix === undefined) {
    io.err("missing <prefix>");
    return 2;
  }
  return withReadDb(path, (db) => {
    for (const entry of kv(db).prefix(prefix)) io.out(`${entry.key}=${entry.value}`);
    return 0;
  });
}

/** The read commands, keyed by name. Each takes (path, optional arg, io). */
const commands: Record<string, (path: string, arg: string | undefined, io: Io) => number> = {
  inspect,
  stats,
  get,
  scan,
};

export function run(argv: string[], io: Io): number {
  let positionals: string[];
  let help: boolean | undefined;
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { help: { type: "boolean", short: "h" } },
    });
    positionals = parsed.positionals;
    help = parsed.values.help;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 2;
  }

  if (help === true || positionals.length === 0) {
    io.out(USAGE);
    return 0;
  }

  const command = positionals[0] as string;
  const handler = commands[command];
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
    return handler(path, positionals[2], io);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
