import { expect, test } from "bun:test";

import { version } from "./core.ts";
import { catalog, doc, kv, open, table, version as exportedVersion } from "./index.ts";

test("core exposes a version string", () => {
  expect(typeof version).toBe("string");
  expect(version.length).toBeGreaterThan(0);
});

test("the package version matches package.json", async () => {
  const pkg = (await import("../package.json")) as { version: string };
  expect(version).toBe(pkg.version);
});

test("the public entry re-exports the kernel version", () => {
  expect(exportedVersion).toBe(version);
});

test("the public entry exposes a usable kv lens over an opened database", () => {
  const db = open();
  const store = kv(db);
  store.set("k", "v");
  expect(store.get("k")).toBe("v");
  db.close();
});

test("the public entry exposes a usable document lens over an opened database", () => {
  const db = open();
  const users = doc(db, "users");

  // open -> doc -> put/get
  users.put("1", { name: "Ada", active: true });
  users.put("2", { name: "Grace", active: false });
  expect(users.get("1")).toEqual({ name: "Ada", active: true });
  expect(users.get("missing")).toBeUndefined();

  // find by top-level field equality
  expect(users.find({ active: true }).toArray()).toEqual([{ id: "1", doc: { name: "Ada", active: true } }]);

  db.close();
});

test("the public entry exposes a usable relational lens over an opened database", () => {
  const db = open();

  // open -> table -> insert (schema-validated)
  const users = table(db, "users", {
    primaryKey: "id",
    columns: { id: "string", name: "string", active: "boolean" },
  });
  users.insert({ id: "1", name: "Ada", active: true });
  users.insert({ id: "2", name: "Grace", active: false });

  // where + select chain
  expect(users.where({ active: true }).select("name").toArray()).toEqual([{ name: "Ada" }]);

  // join produces qualified table.column rows
  const orders = table(db, "orders", {
    primaryKey: "id",
    columns: { id: "string", userId: "string", total: "number" },
  });
  orders.insert({ id: "o1", userId: "1", total: 42 });

  expect(users.join(orders, "id", "userId").select("users.name", "orders.total").toArray()).toEqual([
    { "users.name": "Ada", "orders.total": 42 },
  ]);

  db.close();
});

test("the public entry exposes the catalog of an opened database", () => {
  const db = open();

  // open -> table + doc -> catalog reflects each namespace's kind (and the
  // table's schema), which is the faithful view a cold-opening tool needs.
  const schema = { primaryKey: "id", columns: { id: "string" } } as const;
  table(db, "users", schema);
  doc(db, "logs").put("l1", { message: "hi" });

  const registry = catalog(db);
  expect(registry.get("users")).toEqual({ kind: "relational", schema });
  expect(registry.get("logs")).toEqual({ kind: "document" });

  db.close();
});
