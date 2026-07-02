import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Persistence cases use a real path, so open through the Node entry (which
// defaults the node:fs adapter); the kernel carries no default filesystem.
import { open } from "../index.ts";
import { CATALOG_PREFIX, RESERVED_MARKER, assertUserName, catalog, isReservedKey } from "./catalog.ts";
import * as publicSurface from "../index.ts";
import { doc } from "./document.ts";
import { kv } from "./kv.ts";
import { table, type TableSchema } from "./relational.ts";
import { prefixRange } from "../query/range.ts";

const utf8 = new TextEncoder();

/** Temp directories created for the file-reopen tests, cleaned up after each. */
const tmpDirs: string[] = [];
const tempFile = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "libredb-cat-"));
  tmpDirs.push(dir);
  return join(dir, "db.libre");
};
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Unsigned byte-lexicographic comparison — the kernel's ordering. Returns a
 * negative number when `a` sorts before `b`, positive when after, 0 when equal. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (a[i] as number) - (b[i] as number);
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}

describe("catalog reserved-prefix policy", () => {
  test("assertUserName accepts a normal name", () => {
    expect(() => assertUserName("users")).not.toThrow();
    expect(() => assertUserName("orders_2026")).not.toThrow();
    // An empty name is no longer a user name: it cannot be isolated in the
    // <name>:<id> key layout (issue #20), so it throws below instead.
    expect(() => assertUserName("")).toThrow(/empty/i);
  });

  test("assertUserName rejects a name starting with the reserved marker", () => {
    expect(() => assertUserName(`${RESERVED_MARKER}users`)).toThrow(/reserved catalog marker/);
    // Even a name that mimics the catalog namespace is rejected — it starts with
    // the marker byte.
    expect(() => assertUserName(CATALOG_PREFIX)).toThrow(/reserved catalog marker/);
    // The bare marker is itself a reserved-prefixed (zero-length tail) name.
    expect(() => assertUserName(RESERVED_MARKER)).toThrow(/reserved catalog marker/);
  });

  test("doc() accepts a normal collection name and round-trips", () => {
    const db = open();
    const users = doc(db, "users");
    users.put("u1", { name: "Ada" });
    expect(users.get("u1")).toEqual({ name: "Ada" });
  });

  test("doc() rejects a collection name starting with the reserved marker", () => {
    const db = open();
    expect(() => doc(db, `${RESERVED_MARKER}evil`)).toThrow(/reserved catalog marker/);
  });

  test("table() accepts a normal table name and round-trips", () => {
    const db = open();
    const schema: TableSchema = { primaryKey: "id", columns: { id: "string" } };
    const users = table(db, "users", schema);
    users.insert({ id: "u1" });
    expect(users.get("u1")).toEqual({ id: "u1" });
  });

  test("table() rejects a table name starting with the reserved marker", () => {
    const db = open();
    const schema: TableSchema = { primaryKey: "id", columns: { id: "string" } };
    expect(() => table(db, `${RESERVED_MARKER}evil`, schema)).toThrow(/reserved catalog marker/);
  });

  test("the catalog namespace begins with the reserved low byte", () => {
    const prefixBytes = utf8.encode(CATALOG_PREFIX);
    expect(prefixBytes[0]).toBe(0x00);
    // A non-reserved user name never starts with 0x00, so its first byte is at
    // least 0x01 — strictly above the catalog namespace's leading byte.
    expect(utf8.encode("users")[0] as number).toBeGreaterThan(0x00);
  });

  test("catalog keys sort outside user-data prefix ranges", () => {
    // A catalog entry's key for the "users" namespace, and the byte range a
    // `users` collection/table scan walks.
    const catalogKey = utf8.encode(`${CATALOG_PREFIX}users`);
    const userRange = prefixRange(utf8.encode("users:"));
    const userKey = utf8.encode("users:u1");

    // The catalog key sorts strictly before the start of the user range, so it
    // can never fall inside [start, end) — catalog and user data are disjoint.
    expect(compareBytes(catalogKey, userRange.start)).toBeLessThan(0);
    expect(compareBytes(catalogKey, userKey)).toBeLessThan(0);

    // Even a user namespace whose name sorts very low (but is still allowed,
    // i.e. does not start with the marker) stays above the catalog namespace.
    const lowUserKey = utf8.encode("\x01weird:x");
    expect(compareBytes(catalogKey, lowUserKey)).toBeLessThan(0);
  });
});

describe("public reserved-namespace contract (for tools)", () => {
  test("the marker, the catalog prefix, and isReservedKey are on the public surface", () => {
    // A raw-KV tool (e.g. the LibreDB Studio provider) imports these from the
    // package instead of hardcoding the byte layout. Pin them so any change is a
    // deliberate, semver-visible act rather than a silent drift that would make a
    // consumer stop filtering reserved keys.
    expect(publicSurface.RESERVED_MARKER).toBe("\x00");
    expect(publicSurface.CATALOG_PREFIX).toBe("\x00libredb:catalog:");
    expect(publicSurface.isReservedKey).toBe(isReservedKey);
  });

  test("isReservedKey partitions reserved keys from user keys", () => {
    // Reserved: the catalog namespace, the bare marker, and any future reserved
    // sub-namespace under the marker — all hidden by a raw-KV tool.
    expect(isReservedKey(`${CATALOG_PREFIX}users`)).toBe(true);
    expect(isReservedKey(RESERVED_MARKER)).toBe(true);
    expect(isReservedKey(`${RESERVED_MARKER}future:x`)).toBe(true);
    // User keys never start with the marker (assertUserName enforces it), so they
    // are never hidden.
    expect(isReservedKey("users:u1")).toBe(false);
    expect(isReservedKey("")).toBe(false);
  });
});

describe("relational schema catalog and validate-on-reopen (C2)", () => {
  const userSchema: TableSchema = {
    primaryKey: "id",
    columns: { id: "string", age: "number" },
  };

  test("table() records its schema in the catalog on creation", () => {
    const db = open();
    table(db, "users", userSchema);
    // The catalog entry is an ordinary KV value at the reserved key; the raw kv
    // lens (unguarded) reads it back. Its value is JSON of { kind, schema }.
    const raw = kv(db).get(`${CATALOG_PREFIX}users`);
    expect(raw).toBeDefined();
    expect(JSON.parse(raw as string)).toEqual({
      kind: "relational",
      schema: userSchema,
    });
  });

  test("reopening a table with the same schema is accepted (column order irrelevant)", () => {
    const db = open();
    table(db, "users", userSchema);
    // A second handle for the same name with an equal schema validates and is
    // fine; equality is structural, so declared column order does not matter.
    expect(() =>
      table(db, "users", {
        primaryKey: "id",
        columns: { age: "number", id: "string" },
      }),
    ).not.toThrow();
  });

  test("reopening a table with a different schema throws (no migration in v1)", () => {
    const db = open();
    table(db, "users", userSchema);
    // A changed column type is a schema mismatch.
    expect(() =>
      table(db, "users", {
        primaryKey: "id",
        columns: { id: "string", age: "string" },
      }),
    ).toThrow(/schema|migration/i);
    // A different column set (here a dropped column) is a mismatch too.
    expect(() => table(db, "users", { primaryKey: "id", columns: { id: "string" } })).toThrow(/schema|migration/i);
  });

  test("the catalog entry survives a real file reopen (WAL)", () => {
    const path = tempFile();
    const first = open({ path });
    table(first, "users", userSchema);
    first.close();

    // Reopen the file: recovery replays the WAL, so the catalog entry persists.
    const second = open({ path });
    const raw = kv(second).get(`${CATALOG_PREFIX}users`);
    expect(JSON.parse(raw as string)).toEqual({
      kind: "relational",
      schema: userSchema,
    });
    // Validate-on-reopen then works across a real file: the persisted schema is
    // re-checked, so a different one throws and an equal one is accepted.
    expect(() => table(second, "users", { primaryKey: "id", columns: { id: "string" } })).toThrow(/schema|migration/i);
    expect(() => table(second, "users", userSchema)).not.toThrow();
    second.close();
  });
});

describe("document collection registration (C3)", () => {
  test("doc().put registers a document catalog entry on first write", () => {
    const db = open();
    const users = doc(db, "users");
    users.put("u1", { name: "Ada" });
    // The catalog entry is an ordinary KV value at the reserved key; the raw kv
    // lens (unguarded) reads it back. Documents are schemaless, so only the kind
    // is recorded (no schema).
    const raw = kv(db).get(`${CATALOG_PREFIX}users`);
    expect(raw).toBeDefined();
    expect(JSON.parse(raw as string)).toEqual({ kind: "document" });
  });

  test("building a doc() handle without writing registers nothing", () => {
    const db = open();
    // Registration is on first WRITE, not on handle construction or read: a
    // handle that only reads leaves the catalog empty.
    const empty = doc(db, "empty");
    expect(empty.get("nope")).toBeUndefined();
    expect(empty.all().toArray()).toEqual([]);
    expect(kv(db).prefix(CATALOG_PREFIX).toArray()).toEqual([]);
  });

  test("registration is idempotent across repeated and multi-id puts", () => {
    const db = open();
    const users = doc(db, "users");
    users.put("u1", { name: "Ada" });
    users.put("u1", { name: "Ada Lovelace" }); // overwrite same id
    users.put("u2", { name: "Alan" }); // a second id
    // Exactly one catalog entry exists for the collection, still { kind:
    // "document" } — repeated writes neither duplicate nor error.
    const entries = kv(db).prefix(CATALOG_PREFIX).toArray();
    expect(entries.length).toBe(1);
    expect(entries[0]?.key).toBe(`${CATALOG_PREFIX}users`);
    expect(JSON.parse(entries[0]?.value as string)).toEqual({
      kind: "document",
    });
  });

  test("a kv write leaves no catalog entry (kv is the raw layer)", () => {
    const db = open();
    kv(db).set("foo", "bar");
    kv(db).set("users:u1", "not a document");
    // kv namespaces are NOT cataloged (DESIGN.md section 6.3): no entry appears
    // under the reserved prefix for any kv key.
    expect(kv(db).prefix(CATALOG_PREFIX).toArray()).toEqual([]);
  });

  test("a document put does not clobber a relational table's catalog entry", () => {
    const db = open();
    const schema: TableSchema = {
      primaryKey: "id",
      columns: { id: "string", age: "number" },
    };
    // table() routes its inserts through an internal doc().put. Registration is
    // write-if-absent, and the relational entry was recorded at table() build
    // time, so the insert's document registration must NOT downgrade it.
    const users = table(db, "users", schema);
    users.insert({ id: "u1", age: 36 });
    const raw = kv(db).get(`${CATALOG_PREFIX}users`);
    expect(JSON.parse(raw as string)).toEqual({ kind: "relational", schema });
  });

  test("the document catalog entry survives a real file reopen (WAL)", () => {
    const path = tempFile();
    const first = open({ path });
    doc(first, "users").put("u1", { name: "Ada" });
    first.close();

    // Reopen the file: recovery replays the WAL, so the registration persists.
    const second = open({ path });
    const raw = kv(second).get(`${CATALOG_PREFIX}users`);
    expect(JSON.parse(raw as string)).toEqual({ kind: "document" });
    second.close();
  });
});

describe("catalog read API (C4)", () => {
  const userSchema: TableSchema = {
    primaryKey: "id",
    columns: { id: "string", age: "number" },
  };

  test("an empty database has an empty registry", () => {
    expect(catalog(open()).size).toBe(0);
  });

  test("enumerates a database holding a table and a collection", () => {
    const db = open();
    table(db, "users", userSchema);
    doc(db, "logs").put("l1", { message: "hello" });

    const registry = catalog(db);
    // Namespace -> { kind, schema? }: the table carries its schema, the
    // schemaless document carries only its kind.
    expect(registry.size).toBe(2);
    expect(registry.get("users")).toEqual({
      kind: "relational",
      schema: userSchema,
    });
    expect(registry.get("logs")).toEqual({ kind: "document" });
  });

  // MANDATORY (plan C4): catalog entries never leak into user-facing scans, and
  // conversely user data never leaks into the registry. The reserved 0x00 prefix
  // sorts the whole catalog namespace below every user key, so the two are
  // disjoint in both directions.
  test("catalog entries never leak into user-facing kv/doc/table scans", () => {
    const db = open();
    const users = table(db, "users", userSchema);
    users.insert({ id: "u1", age: 36 });
    users.insert({ id: "u2", age: 41 });
    const logs = doc(db, "logs");
    logs.put("l1", { message: "hello" });

    // A relational scan yields only its rows — the catalog entry, stored under
    // the reserved prefix, is far below the "users:" range and never appears.
    expect(users.all().toArray()).toEqual([
      { id: "u1", age: 36 },
      { id: "u2", age: 41 },
    ]);

    // A document scan yields only its documents.
    expect(logs.all().toArray()).toEqual([{ id: "l1", doc: { message: "hello" } }]);

    // A user-facing kv prefix scan over a namespace sees only its user keys.
    expect(
      kv(db)
        .prefix("users:")
        .toArray()
        .map((e) => e.key),
    ).toEqual(["users:u1", "users:u2"]);

    // Conversely, the registry holds exactly the two namespaces — no document or
    // table row keys (e.g. "users:u1") leak in, because the scan is bounded to
    // the reserved namespace.
    expect([...catalog(db).keys()].sort()).toEqual(["logs", "users"]);
  });

  test("the registry is read back from a real file after reopen (WAL)", () => {
    const path = tempFile();
    const first = open({ path });
    table(first, "users", userSchema);
    doc(first, "logs").put("l1", { message: "hello" });
    first.close();

    // Recovery replays the WAL, so the registry is reconstructed from disk.
    const second = open({ path });
    const registry = catalog(second);
    expect(registry.get("users")).toEqual({
      kind: "relational",
      schema: userSchema,
    });
    expect(registry.get("logs")).toEqual({ kind: "document" });
    second.close();
  });
});
