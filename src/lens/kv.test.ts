/**
 * kv.test.ts — behavioral suite for the key-value lens (the proof lens).
 *
 * The kernel (core.ts) is already an
 * ordered byte key-value store, so this lens is the thinnest possible face over
 * it: it adds string ergonomics (UTF-8 in, UTF-8 out) and wraps reads/writes in
 * the shared envelope from lens/types.ts (a {@link Result} for scans, a
 * {@link WriteResult} for mutations). These tests are written first and pin that
 * behavior — including that writes through the lens are durable (they reach the
 * kernel's write-ahead log and survive a reopen) and that a range scan is the
 * kernel's ordered, half-open [start, end) scan, decoded to strings.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { open } from "../core.ts";
import { kv, type KvEntry } from "./kv.ts";

/** Temp directories created during the run, cleaned up after each test. */
const dirs: string[] = [];
const tempPath = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "libredb-kv-"));
  dirs.push(dir);
  return join(dir, name);
};

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

test("set then get returns the stored value", () => {
  const db = open();
  const store = kv(db);
  store.set("greeting", "hello");
  expect(store.get("greeting")).toBe("hello");
  db.close();
});

test("get returns undefined for a key that was never set", () => {
  const db = open();
  const store = kv(db);
  expect(store.get("missing")).toBeUndefined();
  db.close();
});

test("set reports one changed entry, even when overwriting", () => {
  const db = open();
  const store = kv(db);
  expect(store.set("k", "v1")).toEqual({ changed: 1 });
  expect(store.set("k", "v2")).toEqual({ changed: 1 });
  expect(store.get("k")).toBe("v2");
  db.close();
});

test("delete of an existing key removes it and reports one change", () => {
  const db = open();
  const store = kv(db);
  store.set("k", "v");
  expect(store.delete("k")).toEqual({ changed: 1 });
  expect(store.get("k")).toBeUndefined();
  db.close();
});

test("delete of an absent key is a no-op and reports zero changes", () => {
  const db = open();
  const store = kv(db);
  expect(store.delete("never-set")).toEqual({ changed: 0 });
  db.close();
});

test("range scans the half-open [start, end) interval in key order", () => {
  const db = open();
  const store = kv(db);
  store.set("a", "1");
  store.set("b", "2");
  store.set("c", "3");
  store.set("d", "4");

  // start ("b") is included, end ("d") is excluded.
  const rows = store.range("b", "d").toArray();
  expect(rows).toEqual([
    { key: "b", value: "2" },
    { key: "c", value: "3" },
  ]);
  db.close();
});

test("range returns rows in ascending key order regardless of insertion order", () => {
  const db = open();
  const store = kv(db);
  for (const k of ["m", "a", "z", "f"]) store.set(k, k.toUpperCase());

  const keys = store
    .range("a", "z")
    .toArray()
    .map((e) => e.key);
  expect(keys).toEqual(["a", "f", "m"]); // "z" excluded by the half-open end
  db.close();
});

test("range over an interval with no keys yields nothing", () => {
  const db = open();
  const store = kv(db);
  store.set("a", "1");
  expect(store.range("x", "z").toArray()).toEqual([]);
  db.close();
});

test("range is lazy and re-iterable: a second pass sees writes made in between", () => {
  const db = open();
  const store = kv(db);
  store.set("a", "1");

  const scan = store.range("a", "z");
  expect(scan.toArray().map((e) => e.key)).toEqual(["a"]);

  // The Result stands for the query, not a one-shot snapshot: writing a new key
  // in range and re-iterating re-runs the scan and observes it.
  store.set("b", "2");
  expect(scan.toArray().map((e) => e.key)).toEqual(["a", "b"]);
  db.close();
});

test("keys and values round-trip arbitrary UTF-8 through the lens", () => {
  const db = open();
  const store = kv(db);
  store.set("anahtar", "değer — 日本語 — 🎉");
  expect(store.get("anahtar")).toBe("değer — 日本語 — 🎉");
  db.close();
});

test("writes through the lens are durable and survive a reopen", () => {
  const path = tempPath("durable");
  const first = open({ path });
  kv(first).set("persisted", "yes");
  first.close();

  const second = open({ path });
  expect(kv(second).get("persisted")).toBe("yes");
  second.close();
});

test("prefix scans exactly the keys beginning with the prefix, in key order", () => {
  const db = open();
  const store = kv(db);
  for (const k of ["user", "user:1", "user:2", "user:30", "uses", "v"]) {
    store.set(k, k.toUpperCase());
  }

  const keys = store
    .prefix("user:")
    .toArray()
    .map((e) => e.key);
  // "user" (no colon), "uses" and "v" all sort outside the prefix range.
  expect(keys).toEqual(["user:1", "user:2", "user:30"]);
  db.close();
});

test("prefix is lazy and re-iterable: a second pass sees a newly added match", () => {
  const db = open();
  const store = kv(db);
  store.set("item:a", "1");

  const scan = store.prefix("item:");
  expect(scan.toArray().map((e) => e.key)).toEqual(["item:a"]);

  store.set("item:b", "2");
  expect(scan.toArray().map((e) => e.key)).toEqual(["item:a", "item:b"]);
  db.close();
});

test("prefix rejects an empty prefix rather than silently scanning everything", () => {
  const db = open();
  const store = kv(db);
  // An empty prefix has no finite upper bound; the query surface refuses it.
  expect(() => store.prefix("")).toThrow(/no finite upper bound/);
  db.close();
});

test("range exposes the shared Result type carrying decoded string entries", () => {
  const db = open();
  const store = kv(db);
  store.set("a", "1");
  // Locks the compile-time contract: range yields the shared Result<KvEntry>.
  const rows: KvEntry[] = store.range("a", "z").toArray();
  const [first] = rows;
  expect(first?.value).toBe("1");
  db.close();
});
