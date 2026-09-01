/**
 * cli/run.ts — the LibreDB CLI as a pure function.
 *
 * `run(argv, io)` takes an argument vector and an IO sink and returns a process
 * exit code. Keeping the whole CLI behind this seam — no direct stdout, no
 * process.exit — is what makes every command and error path unit-testable; the
 * bin shim (main.ts) is the only place that touches the real process.
 *
 * This is open-edge tooling over the public API, not kernel code: it adds no
 * durability logic. Read commands (inspect/stats/get/scan/export) open through
 * the read-only filesystem adapter so inspecting a file never mutates it. Write
 * commands (set/delete/import) rely on the kernel's exclusive open lock (a
 * second writer fails loudly; --force clears a lock whose holder is gone), and
 * import commits all keys in one transaction so a bulk load is atomic — export
 * is its inverse, reading the whole dump back out in one transaction.
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { forceUnlock } from "../adapter/node-fs.ts";
import { LibreDbError, type Database } from "../core.ts";
import { open } from "../index.ts";
import { assertWellFormedText, catalog, isReservedKey } from "../lens/catalog.ts";
import { kv } from "../lens/kv.ts";
import { readonlyFileSystem } from "./readonly-fs.ts";

/** Where the CLI writes its output. One call is one line; the sink adds newlines. */
interface Io {
  out(line: string): void;
  err(line: string): void;
}

/** Everything a command handler needs: the file path, the command's positional
 * arguments (everything after the path), the IO sink, and the flags. */
interface Ctx {
  path: string;
  args: string[];
  io: Io;
  force: boolean;
  raw: boolean;
}

/**
 * Escape control characters for terminal output. A stored value is arbitrary
 * user data; printed verbatim it could carry ANSI/OSC sequences that move the
 * cursor, retitle the window, or write the clipboard of whoever inspects the
 * file — the classic escape-injection gap in tools that dump untrusted bytes.
 * Every C0 control (including newline — output here is line-oriented), DEL,
 * and C1 control renders as its \xNN escape instead. `--raw` opts out.
 */
function sanitize(text: string, raw: boolean): string {
  if (raw) return text;
  // Control characters in this regex are the entire point (they are what gets
  // escaped). Only oxlint's no-control-regex fires here, so the suppression
  // targets it specifically — an eslint-disable would be an unused directive.
  // oxlint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
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
  "  libredb export <path> <file.json>  Dump every key to a JSON object (the shape import reads)",
  "  libredb set <path> <key> <value>   Set a key to a value",
  "  libredb delete <path> <key>        Remove a key",
  "  libredb import <path> <file.json>  Bulk-set keys from a JSON object (one atomic commit)",
  "",
  "Options:",
  "  --force                            Remove a write lock whose holder is no longer alive",
  "  --raw                              Print values verbatim (default escapes control characters)",
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

/** Open `path` for writing (the kernel takes the exclusive lock), run `fn`,
 * then always close — which releases the lock. With `force`, a LOCKED open
 * removes the lock first when its holder is not verifiably alive; a live
 * holder still refuses, so --force cannot create two live writers. */
const withWriteDb = <T>(path: string, force: boolean, fn: (db: Database) => T): T => {
  let db: Database;
  try {
    db = open({ path });
  } catch (error) {
    if (!force || !(error instanceof LibreDbError) || error.code !== "LOCKED") throw error;
    forceUnlock(path);
    db = open({ path });
  }
  try {
    return fn(db);
  } finally {
    db.close();
  }
};

function inspect({ path, io, raw }: Ctx): number {
  return withReadDb(path, (db) => {
    const registry = catalog(db);
    io.out(`${path}  ${statSync(path).size} bytes`);
    if (registry.size === 0) {
      io.out("  (no catalogued namespaces)");
      return 0;
    }
    for (const [name, entry] of registry) {
      // Namespace names are user data too: the lens validator rejects ":" and
      // surrogates but not control characters, so a name could otherwise carry
      // terminal escapes into whoever inspects the file. Schemas are safe as
      // JSON.stringify output (it escapes control characters itself).
      const schema = entry.schema === undefined ? "" : `  ${JSON.stringify(entry.schema)}`;
      io.out(`  ${sanitize(name, raw)}  ${entry.kind}${schema}`);
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

function get({ path, args, io, raw }: Ctx): number {
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
    io.out(sanitize(value, raw));
    return 0;
  });
}

function scan({ path, args, io, raw }: Ctx): number {
  const [prefix] = args;
  if (prefix === undefined) {
    io.err("missing <prefix>");
    return 2;
  }
  return withReadDb(path, (db) => {
    for (const entry of kv(db).prefix(prefix)) {
      io.out(`${sanitize(entry.key, raw)}=${sanitize(entry.value, raw)}`);
    }
    return 0;
  });
}

/**
 * The byte range `export` scans: the whole keyspace a UTF-8 string can occupy.
 *
 * The kernel orders arbitrary byte keys with no maximum, so a half-open
 * `[start, end)` cannot literally say "everything" — and it does not need to. A
 * JSON dump can only carry keys that are UTF-8 TEXT, and no valid UTF-8 encoding
 * begins with a byte above 0xF4 (the lead byte of U+10FFFF), so 0xF5 is above
 * every key a lens or a CLI command can write. The start is the EMPTY key: it
 * sorts before everything (including the reserved namespace, which is why
 * reserved keys are filtered by predicate below rather than excluded by bound)
 * and is itself a legal key.
 */
const EXPORT_START = new Uint8Array();
const EXPORT_END = new Uint8Array([0xf5]);

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Decode one stored byte string for the dump, refusing bytes that are not valid
 * UTF-8. Every lens and every CLI command writes well-formed UTF-8, so this can
 * only fire for a key or value written as raw bytes straight through the kernel
 * — and there a lossy decode would put U+FFFD in the dump, which imports back as
 * DIFFERENT data (two distinct raw keys would collapse onto one JSON key).
 * Export reads through the kernel directly, exactly as import writes through it,
 * so it holds the same line import does with `assertWellFormedText`.
 */
const decodeText = (bytes: Uint8Array, what: string): string => {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    throw new Error(
      `libredb: a stored ${what} is not valid UTF-8 text (only reachable by writing raw bytes through the kernel ` +
        `API); export refuses rather than emit replacement characters that would import back as different data`,
    );
  }
};

function exportKeys({ path, args, io }: Ctx): number {
  const [file] = args;
  if (file === undefined) {
    io.err("missing <file>");
    return 2;
  }
  const pairs = withReadDb(path, (db) =>
    // ONE transaction for the whole dump, so the file is a single consistent
    // snapshot — the read counterpart of import's one-transaction write. It
    // reads the kernel range directly because the kv lens cannot express this
    // scan: its range() takes STRING bounds, and no string encodes EXPORT_END.
    db.transact((tx) => {
      const rows: [string, string][] = [];
      for (const entry of tx.getRange(EXPORT_START, EXPORT_END)) {
        const key = decodeText(entry.key, "key");
        // Skip LibreDB's reserved namespace (the catalog): import refuses those
        // keys, so dumping them would produce a file import cannot read. Testing
        // the published isReservedKey predicate rather than a hardcoded prefix is
        // what keeps export correct if the reserved namespace ever grows.
        if (isReservedKey(key)) continue;
        rows.push([key, decodeText(entry.value, "value")]);
      }
      return rows;
    }),
  );
  // Object.fromEntries, never `object[key] = value`: assigning "__proto__" on a
  // plain object hits the inherited setter and defines NO own property, so that
  // one key would silently vanish from the dump. fromEntries defines own
  // properties, and JSON.parse does too — so the key survives the round trip.
  // JSON.stringify does every bit of the escaping (quotes, backslashes, control
  // characters, and it can never emit a lone surrogate); nothing here builds
  // JSON text by hand. Indented with a trailing newline because a dump is a file
  // humans read and diff. The write TRUNCATES an existing file, like a shell
  // redirect; this is the only thing export writes.
  writeFileSync(file, `${JSON.stringify(Object.fromEntries(pairs), null, 2)}\n`);
  io.out(`export ${pairs.length} keys`);
  return 0;
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
  if (isReservedKey(key)) {
    io.err(`refusing to delete a reserved key: ${key}`);
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
    try {
      // The same invariant the kv lens enforces: a lone-surrogate string
      // cannot round-trip through UTF-8, so two distinct malformed keys would
      // silently collide on one stored key (and a malformed value would read
      // back altered). Import writes through the kernel directly (one atomic
      // transaction), so it must hold the line itself.
      assertWellFormedText(key, "import key");
      assertWellFormedText(value, "import value");
    } catch (error) {
      io.err(error instanceof Error ? error.message : String(error));
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
  ["export", exportKeys],
  ["set", set],
  ["delete", remove],
  ["import", importKeys],
]);

export function run(argv: string[], io: Io): number {
  let positionals: string[];
  let values: { help?: boolean; force?: boolean; raw?: boolean };
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h" },
        force: { type: "boolean" },
        raw: { type: "boolean" },
      },
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
    return handler({ path, args: positionals.slice(2), io, force: values.force === true, raw: values.raw === true });
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
