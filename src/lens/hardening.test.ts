/**
 * lens/hardening.test.ts — the lens boundary's rejection rules.
 *
 * The lenses' key layout is `<name>:<id>` over the kernel's byte order, and the
 * catalog records each namespace's kind. Both only hold if the inputs cannot
 * lie: a name containing ":" forges namespace boundaries, a lone surrogate
 * collides distinct strings onto one key, a doc() handle on a relational table
 * writes around its schema, and NaN validates as a "number" JSON cannot store.
 * This suite pins the loud errors that keep those inputs out (pre-announcement
 * audit findings B7 and section-2/4 lens items).
 */
import { expect, test } from "bun:test";

import { LibreDbError } from "../core.ts";
import { open } from "../index.ts";
import { catalog } from "./catalog.ts";
import { doc } from "./document.ts";
import { kv } from "./kv.ts";
import { table } from "./relational.ts";

/** Grab the LibreDbError a thunk throws, asserting it threw at all. */
const errorFrom = (thunk: () => unknown): LibreDbError => {
  try {
    thunk();
  } catch (error) {
    expect(error).toBeInstanceOf(LibreDbError);
    return error as LibreDbError;
  }
  throw new Error("expected the thunk to throw");
};

const SCHEMA = { primaryKey: "id", columns: { id: "string", n: "number" } } as const;

// --- issue #20: names that break the key layout are rejected ---

test("a collection name containing ':' is rejected (namespace isolation)", () => {
  const db = open();
  const error = errorFrom(() => doc(db, "tenant:42"));
  expect(error.code).toBe("INVALID_ARGUMENT");
  expect(error.message).toMatch(/may not contain ":"/);
  db.close();
});

test("an empty collection or table name is rejected", () => {
  const db = open();
  expect(errorFrom(() => doc(db, "")).code).toBe("INVALID_ARGUMENT");
  expect(errorFrom(() => table(db, "", SCHEMA)).code).toBe("INVALID_ARGUMENT");
  db.close();
});

test("a table name containing ':' is rejected before it can shadow the catalog", () => {
  const db = open();
  expect(errorFrom(() => table(db, "users:admin", SCHEMA)).code).toBe("INVALID_ARGUMENT");
  db.close();
});

test("colliding names the old layout allowed are now impossible", () => {
  const db = open();
  // Without the guard, doc(db, "tenant:1") with id "x" and doc(db, "tenant")
  // with id "1:x" would share the kernel key "tenant:1:x". The first form is
  // rejected; the safe encoding (tenant in the id) works and stays isolated.
  const tenants = doc(db, "tenant");
  tenants.put("1:x", { from: "tenant 1" });
  tenants.put("2:x", { from: "tenant 2" });
  expect(tenants.get("1:x")).toEqual({ from: "tenant 1" });
  expect(tenants.all().toArray().length).toBe(2);
  db.close();
});

test("ids may contain ':' freely — only the namespace name is structural", () => {
  const db = open();
  const logs = doc(db, "logs");
  logs.put("2026:07:03", { level: "info" });
  expect(logs.get("2026:07:03")).toEqual({ level: "info" });
  db.close();
});

// --- issue #26: NaN and Infinity are not numbers a schema can store ---

test("NaN and the infinities are rejected by number column validation", () => {
  const db = open();
  const t = table(db, "metrics", SCHEMA);
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    expect(() => t.insert({ id: "m1", n: bad })).toThrow(/expected number/);
  }
  // Nothing was stored by the rejected inserts.
  expect(t.get("m1")).toBeUndefined();
  // Ordinary numbers (including zero and negatives) still pass.
  t.insert({ id: "m2", n: -12.5 });
  expect(t.get("m2")).toEqual({ id: "m2", n: -12.5 });
  db.close();
});

// --- issue #30: a name belongs to one lens ---

test("doc() operations refuse a name cataloged as a relational table", () => {
  const db = open();
  table(db, "accounts", SCHEMA).insert({ id: "a1", n: 1 });
  // Construction succeeds (the guard is lazy so handles can be built inside a
  // transaction); every OPERATION refuses, so schema validation cannot be
  // bypassed through a doc() handle.
  const handle = doc(db, "accounts");
  for (const op of [
    () => handle.put("a2", { rogue: true }),
    () => handle.get("a1"),
    () => handle.delete("a1"),
    () => handle.all().toArray(),
    () => handle.find({}).toArray(),
  ]) {
    const error = errorFrom(op);
    expect(error.code).toBe("INVALID_ARGUMENT");
    expect(error.message).toMatch(/use table\(\)/);
  }
  // The catalog's faithful view survived: still relational, schema intact,
  // and no rogue row landed.
  expect(catalog(db).get("accounts")).toEqual({ kind: "relational", schema: SCHEMA });
  expect(table(db, "accounts", SCHEMA).get("a2")).toBeUndefined();
  db.close();
});

test("table() refuses a name cataloged as a document collection", () => {
  const db = open();
  doc(db, "notes").put("n1", { text: "hi" });
  const error = errorFrom(() => table(db, "notes", SCHEMA));
  expect(error.code).toBe("INVALID_ARGUMENT");
  expect(error.message).toMatch(/document namespace/);
  db.close();
});

test("the relational lens itself still reads and writes its rows (the guard is for outsiders)", () => {
  const db = open();
  const t = table(db, "people", SCHEMA);
  t.insert({ id: "p1", n: 7 });
  expect(t.get("p1")).toEqual({ id: "p1", n: 7 });
  expect(t.where({ n: 7 }).toArray()).toEqual([{ id: "p1", n: 7 }]);
  t.delete("p1");
  expect(t.get("p1")).toBeUndefined();
  db.close();
});

// --- issue #35: lone surrogates cannot round-trip through UTF-8 keys ---

test("kv keys with a lone surrogate are rejected instead of silently colliding", () => {
  const db = open();
  const store = kv(db);
  const malformedA = "key-\ud800"; // lone high surrogate
  const malformedB = "key-\udfff"; // lone low surrogate — distinct string, same UTF-8
  expect(errorFrom(() => store.set(malformedA, "a")).code).toBe("INVALID_ARGUMENT");
  expect(errorFrom(() => store.get(malformedB)).code).toBe("INVALID_ARGUMENT");
  expect(errorFrom(() => store.delete(malformedA)).code).toBe("INVALID_ARGUMENT");
  expect(errorFrom(() => store.prefix(malformedA).toArray()).code).toBe("INVALID_ARGUMENT");
  expect(errorFrom(() => store.range(malformedA, "z").toArray()).code).toBe("INVALID_ARGUMENT");
  db.close();
});

test("kv values with a lone surrogate are rejected (they would read back altered)", () => {
  const db = open();
  expect(errorFrom(() => kv(db).set("k", "broken-\ud800")).code).toBe("INVALID_ARGUMENT");
  db.close();
});

test("document ids and namespace names with a lone surrogate are rejected", () => {
  const db = open();
  expect(errorFrom(() => doc(db, "users").put("id-\ud800", {})).code).toBe("INVALID_ARGUMENT");
  expect(errorFrom(() => doc(db, "users-\ud800")).code).toBe("INVALID_ARGUMENT");
  db.close();
});

test("well-formed non-ASCII keys, ids, and values round-trip exactly", () => {
  const db = open();
  const store = kv(db);
  store.set("anahtar-ğüşöçİ", "değer-🚀");
  expect(store.get("anahtar-ğüşöçİ")).toBe("değer-🚀");
  const col = doc(db, "kayıtlar");
  col.put("belge-🎯", { başlık: "merhaba" });
  expect(col.get("belge-🎯")).toEqual({ başlık: "merhaba" });
  db.close();
});

// --- issue #36: an undefined predicate value is an error, not match-nothing/-everything ---

test("find() with an explicitly-undefined predicate field throws instead of inverting meaning", () => {
  const db = open();
  const users = doc(db, "users");
  users.put("1", { name: "Ada" }); // no `status` field
  const predicate = { status: undefined } as unknown as { [key: string]: never };
  const error = errorFrom(() => users.find(predicate));
  expect(error.code).toBe("INVALID_ARGUMENT");
  expect(error.message).toMatch(/undefined/);
  db.close();
});

test("find() validation is eager: it throws even against an empty collection", () => {
  const db = open();
  const empty = doc(db, "empty");
  const predicate = { flag: undefined } as unknown as { [key: string]: never };
  expect(errorFrom(() => empty.find(predicate)).code).toBe("INVALID_ARGUMENT");
  db.close();
});

test("where() on a table rejects an undefined predicate value the same way", () => {
  const db = open();
  const t = table(db, "rows", SCHEMA);
  t.insert({ id: "r1", n: 1 });
  const predicate = { n: undefined } as unknown as { [key: string]: never };
  expect(errorFrom(() => t.where(predicate)).code).toBe("INVALID_ARGUMENT");
  db.close();
});

test("find({}) still matches every document (an empty predicate names no fields)", () => {
  const db = open();
  const users = doc(db, "users");
  users.put("1", { name: "Ada" });
  users.put("2", { name: "Grace" });
  expect(users.find({}).toArray().length).toBe(2);
  db.close();
});
