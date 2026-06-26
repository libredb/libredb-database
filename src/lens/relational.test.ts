import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { open } from "../core.ts";
import { doc, type Doc } from "./document.ts";
import { table, type TableSchema, type Row } from "./relational.ts";

// A schema exercising every column type, so type validation is checked across
// the full string|number|boolean|object set, not just one.
const userSchema: TableSchema = {
  primaryKey: "id",
  columns: {
    id: "string",
    age: "number",
    active: "boolean",
    profile: "object",
  },
};

const validUser: Row = {
  id: "u1",
  age: 30,
  active: true,
  profile: { city: "London" },
};

describe("relational schema validation (table construction)", () => {
  test("rejects a schema whose primaryKey is not a declared column", () => {
    expect(() =>
      table(open(), "users", {
        primaryKey: "missing",
        columns: { id: "string" },
      }),
    ).toThrow(/primaryKey/i);
  });

  test("rejects a schema whose primaryKey column is not a string (non-string pk)", () => {
    expect(() =>
      table(open(), "users", {
        primaryKey: "id",
        columns: { id: "number" },
      }),
    ).toThrow(/string/i);
  });

  test("accepts a well-formed schema (string primaryKey that is a declared column)", () => {
    expect(() => table(open(), "users", userSchema)).not.toThrow();
  });
});

describe("relational insert-time row validation", () => {
  test("a fully valid row inserts and reports one changed entry", () => {
    const users = table(open(), "users", userSchema);
    expect(users.insert(validUser)).toEqual({ changed: 1 });
  });

  test("a valid row is stored under <table>:<pk> (readable via the document lens)", () => {
    // The relational lens stores a row exactly where the document lens would
    // store a document of the same id, proving the <table>:<pk> layout reuses
    // the document storage scheme rather than inventing a parallel one.
    const db = open();
    table(db, "users", userSchema).insert(validUser);
    expect(doc(db, "users").get("u1")).toEqual(validUser as unknown as Doc);
  });

  test("rejects a row missing a declared column", () => {
    const users = table(open(), "users", userSchema);
    const { active, ...missingActive } = validUser;
    void active;
    expect(() => users.insert(missingActive as Row)).toThrow(/missing.*active/i);
  });

  test("rejects a row with a wrong-typed column (number where string is declared)", () => {
    const users = table(open(), "users", userSchema);
    expect(() => users.insert({ ...validUser, id: 7 } as Row)).toThrow(/id.*string/i);
  });

  test("type checks every column type (boolean and object too)", () => {
    const users = table(open(), "users", userSchema);
    expect(() => users.insert({ ...validUser, active: "yes" } as Row)).toThrow(/active.*boolean/i);
    expect(() => users.insert({ ...validUser, profile: "London" } as Row)).toThrow(/profile.*object/i);
  });

  test("rejects an array for an object column (object means a plain object, not an array)", () => {
    const users = table(open(), "users", userSchema);
    expect(() => users.insert({ ...validUser, profile: [1, 2, 3] } as Row)).toThrow(/profile.*object/i);
  });

  test("rejects null for any column (no nullable columns in v1)", () => {
    const users = table(open(), "users", userSchema);
    expect(() => users.insert({ ...validUser, profile: null } as unknown as Row)).toThrow(/profile.*object/i);
  });

  test("rejects a row with an unknown (extra) field", () => {
    const users = table(open(), "users", userSchema);
    expect(() => users.insert({ ...validUser, nickname: "Ada" } as Row)).toThrow(/unknown.*nickname/i);
  });
});

describe("relational typed-table CRUD (get / delete / all)", () => {
  test("get returns the row stored under its primary key", () => {
    const users = table(open(), "users", userSchema);
    users.insert(validUser);
    expect(users.get("u1")).toEqual(validUser);
  });

  test("get returns undefined for an absent primary key", () => {
    const users = table(open(), "users", userSchema);
    expect(users.get("nope")).toBeUndefined();
  });

  test("get preserves JSON type fidelity (number stays number, object stays object)", () => {
    const users = table(open(), "users", userSchema);
    users.insert(validUser);
    const row = users.get("u1");
    expect(typeof row?.age).toBe("number");
    expect(row?.profile).toEqual({ city: "London" });
  });

  test("delete of an existing row reports one change and removes it", () => {
    const users = table(open(), "users", userSchema);
    users.insert(validUser);
    expect(users.delete("u1")).toEqual({ changed: 1 });
    expect(users.get("u1")).toBeUndefined();
  });

  test("delete of an absent row reports zero changes", () => {
    const users = table(open(), "users", userSchema);
    expect(users.delete("nope")).toEqual({ changed: 0 });
  });

  test("all returns every row in ascending primary-key (byte) order", () => {
    const users = table(open(), "users", userSchema);
    // Inserted out of order; "u1" < "u10" < "u2" in byte order.
    users.insert({ ...validUser, id: "u2" });
    users.insert({ ...validUser, id: "u1" });
    users.insert({ ...validUser, id: "u10" });
    expect(
      users
        .all()
        .toArray()
        .map((r) => r.id),
    ).toEqual(["u1", "u10", "u2"]);
  });

  test("all over an empty table is an empty result", () => {
    const users = table(open(), "users", userSchema);
    expect(users.all().toArray()).toEqual([]);
  });

  test("all returns whole rows including the primary-key column", () => {
    const users = table(open(), "users", userSchema);
    users.insert(validUser);
    expect(users.all().toArray()).toEqual([validUser]);
  });

  test("all is lazy and re-iterable (a second pass observes a later insert)", () => {
    const users = table(open(), "users", userSchema);
    users.insert({ ...validUser, id: "u1" });
    const rows = users.all();
    expect(rows.toArray().map((r) => r.id)).toEqual(["u1"]);
    users.insert({ ...validUser, id: "u2" });
    expect(rows.toArray().map((r) => r.id)).toEqual(["u1", "u2"]);
  });

  // MANDATORY: table isolation. "users" must not see
  // "users2" rows, and vice versa — the <table>: byte prefix is a sound boundary
  // even when one table name is a prefix of the other.
  test("tables are isolated: users does not see users2 rows (and vice versa)", () => {
    const db = open();
    const users = table(db, "users", userSchema);
    const users2 = table(db, "users2", userSchema);
    users.insert({ ...validUser, id: "a" });
    users2.insert({ ...validUser, id: "b" });

    expect(
      users
        .all()
        .toArray()
        .map((r) => r.id),
    ).toEqual(["a"]);
    expect(
      users2
        .all()
        .toArray()
        .map((r) => r.id),
    ).toEqual(["b"]);
    expect(users.get("b")).toBeUndefined();
    expect(users2.get("a")).toBeUndefined();
    // Deleting from one table leaves the other untouched.
    expect(users.delete("b")).toEqual({ changed: 0 });
    expect(users2.get("b")).toEqual({ ...validUser, id: "b" });
  });
});

describe("relational where / select (chainable, lazy)", () => {
  // A small fixture table with a few rows that differ in the queryable columns.
  function seeded(): ReturnType<typeof table> {
    const users = table(open(), "users", userSchema);
    users.insert({
      id: "u1",
      age: 30,
      active: true,
      profile: { city: "London" },
    });
    users.insert({
      id: "u2",
      age: 30,
      active: false,
      profile: { city: "Paris" },
    });
    users.insert({
      id: "u3",
      age: 41,
      active: true,
      profile: { city: "London" },
    });
    return users;
  }

  test("where filters by a single top-level field equality", () => {
    const users = seeded();
    expect(
      users
        .where({ age: 30 })
        .toArray()
        .map((r) => r.id),
    ).toEqual(["u1", "u2"]);
  });

  test("where ANDs multiple fields", () => {
    const users = seeded();
    expect(
      users
        .where({ age: 30, active: true })
        .toArray()
        .map((r) => r.id),
    ).toEqual(["u1"]);
  });

  test("where matching nothing yields an empty result", () => {
    const users = seeded();
    expect(users.where({ age: 99 }).toArray()).toEqual([]);
  });

  test('where is type-sensitive (1 is not "1")', () => {
    const users = seeded();
    expect(users.where({ age: "30" } as unknown as Row).toArray()).toEqual([]);
  });

  test("where matches a nested-object field by deep equality (key order irrelevant)", () => {
    const users = seeded();
    expect(
      users
        .where({ profile: { city: "London" } })
        .toArray()
        .map((r) => r.id),
    ).toEqual(["u1", "u3"]);
  });

  test("an empty where predicate matches every row (like all)", () => {
    const users = seeded();
    expect(
      users
        .where({})
        .toArray()
        .map((r) => r.id),
    ).toEqual(
      users
        .all()
        .toArray()
        .map((r) => r.id),
    );
  });

  test("where chains: each where narrows the previous result (implicit AND)", () => {
    const users = seeded();
    expect(
      users
        .where({ active: true })
        .where({ age: 41 })
        .toArray()
        .map((r) => r.id),
    ).toEqual(["u3"]);
  });

  test("select projects each row to only the named columns", () => {
    const users = seeded();
    expect(users.select("id", "age").toArray()).toEqual([
      { id: "u1", age: 30 },
      { id: "u2", age: 30 },
      { id: "u3", age: 41 },
    ]);
  });

  test("select with a single column projects to that column only", () => {
    const users = seeded();
    expect(users.where({ id: "u1" }).select("age").toArray()).toEqual([{ age: 30 }]);
  });

  test("select omits a requested column that the row does not have", () => {
    const users = seeded();
    expect(users.where({ id: "u1" }).select("id", "nope").toArray()).toEqual([{ id: "u1" }]);
  });

  test("where and select compose in either order", () => {
    const users = seeded();
    // filter then project
    expect(users.where({ active: true }).select("id").toArray()).toEqual([{ id: "u1" }, { id: "u3" }]);
    // project then filter (filtering on a still-present projected column)
    expect(users.select("id", "age").where({ age: 41 }).toArray()).toEqual([{ id: "u3", age: 41 }]);
  });

  test("all() is itself chainable (returns a Query supporting where/select)", () => {
    const users = seeded();
    expect(users.all().where({ active: false }).select("id").toArray()).toEqual([{ id: "u2" }]);
  });

  test("where/select are lazy and re-iterable (a second pass observes a later insert)", () => {
    const users = table(open(), "users", userSchema);
    users.insert({ id: "u1", age: 30, active: true, profile: {} });
    const q = users.where({ age: 30 }).select("id");
    expect(q.toArray()).toEqual([{ id: "u1" }]);
    users.insert({ id: "u2", age: 30, active: true, profile: {} });
    expect(q.toArray()).toEqual([{ id: "u1" }, { id: "u2" }]);
  });

  test("where supports direct iteration (it is a Result), not just toArray", () => {
    const users = seeded();
    const ids: string[] = [];
    for (const row of users.where({ active: true })) ids.push(row.id as string);
    expect(ids).toEqual(["u1", "u3"]);
  });
});

describe("relational join (inner equi, nested-loop)", () => {
  const ordersSchema: TableSchema = {
    primaryKey: "id",
    columns: { id: "string", userId: "string", total: "number" },
  };

  // Two tables to join on users.id = orders.userId. Returned together so each
  // test can drive the join from a freshly seeded, shared database.
  function seededPair(): {
    users: ReturnType<typeof table>;
    orders: ReturnType<typeof table>;
  } {
    const db = open();
    const users = table(db, "users", userSchema);
    const orders = table(db, "orders", ordersSchema);
    users.insert({ id: "u1", age: 30, active: true, profile: {} });
    users.insert({ id: "u2", age: 41, active: true, profile: {} });
    orders.insert({ id: "o1", userId: "u1", total: 50 });
    orders.insert({ id: "o2", userId: "u2", total: 75 });
    return { users, orders };
  }

  test("joins matching pairs and qualifies columns as table.column", () => {
    const { users, orders } = seededPair();
    expect(users.join(orders, "id", "userId").toArray()).toEqual([
      {
        "users.id": "u1",
        "users.age": 30,
        "users.active": true,
        "users.profile": {},
        "orders.id": "o1",
        "orders.userId": "u1",
        "orders.total": 50,
      },
      {
        "users.id": "u2",
        "users.age": 41,
        "users.active": true,
        "users.profile": {},
        "orders.id": "o2",
        "orders.userId": "u2",
        "orders.total": 75,
      },
    ]);
  });

  test("drops rows with no match on either side (inner join)", () => {
    const db = open();
    const users = table(db, "users", userSchema);
    const orders = table(db, "orders", ordersSchema);
    users.insert({ id: "u1", age: 30, active: true, profile: {} }); // has an order
    users.insert({ id: "u2", age: 41, active: true, profile: {} }); // no order -> dropped
    orders.insert({ id: "o1", userId: "u1", total: 50 });
    orders.insert({ id: "o9", userId: "u3", total: 5 }); // no such user -> dropped
    expect(
      users
        .join(orders, "id", "userId")
        .toArray()
        .map((r) => [r["users.id"], r["orders.id"]]),
    ).toEqual([["u1", "o1"]]);
  });

  test("fans out to multiple rows when a key matches several rows", () => {
    const db = open();
    const users = table(db, "users", userSchema);
    const orders = table(db, "orders", ordersSchema);
    users.insert({ id: "u1", age: 30, active: true, profile: {} });
    orders.insert({ id: "o1", userId: "u1", total: 50 });
    orders.insert({ id: "o2", userId: "u1", total: 75 });
    const rows = users.join(orders, "id", "userId").toArray();
    expect(rows.map((r) => r["orders.id"])).toEqual(["o1", "o2"]);
    expect(rows.every((r) => r["users.id"] === "u1")).toBe(true);
  });

  test("where before join filters the left side first", () => {
    const { users, orders } = seededPair();
    expect(
      users
        .where({ id: "u1" })
        .join(orders, "id", "userId")
        .toArray()
        .map((r) => r["orders.id"]),
    ).toEqual(["o1"]);
  });

  test("select understands qualified table.column names on a joined result", () => {
    const { users, orders } = seededPair();
    expect(users.join(orders, "id", "userId").select("users.id", "orders.total").toArray()).toEqual([
      { "users.id": "u1", "orders.total": 50 },
      { "users.id": "u2", "orders.total": 75 },
    ]);
  });

  test('is type-sensitive on the join key (number 1 does not match string "1")', () => {
    const db = open();
    const users = table(db, "users", userSchema);
    const orders = table(db, "orders", ordersSchema);
    users.insert({ id: "1", age: 30, active: true, profile: {} });
    // age is a number; joining users.age = orders.userId pairs number 30 against
    // string userIds, so the type-sensitive matcher finds nothing.
    orders.insert({ id: "o1", userId: "30", total: 50 });
    expect(users.join(orders, "age", "userId").toArray()).toEqual([]);
  });

  test("a join key absent from a row never matches (no cartesian on missing keys)", () => {
    const { users, orders } = seededPair();
    // "ghost" is not a column on the left rows, so every comparison sees
    // undefined on the left and must drop, rather than producing a cross product.
    expect(users.join(orders, "ghost", "userId").toArray()).toEqual([]);
  });

  test("is lazy and re-iterable (a second pass observes a later insert)", () => {
    const db = open();
    const users = table(db, "users", userSchema);
    const orders = table(db, "orders", ordersSchema);
    users.insert({ id: "u1", age: 30, active: true, profile: {} });
    orders.insert({ id: "o1", userId: "u1", total: 50 });
    const joined = users.join(orders, "id", "userId");
    expect(joined.toArray().map((r) => r["orders.id"])).toEqual(["o1"]);
    orders.insert({ id: "o2", userId: "u1", total: 75 });
    expect(joined.toArray().map((r) => r["orders.id"])).toEqual(["o1", "o2"]);
  });
});

describe("relational insert durability", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("a validated insert is durable across a reopen (goes through the kernel WAL)", () => {
    dir = mkdtempSync(join(tmpdir(), "libredb-relational-"));
    const path = join(dir, "db");

    const db = open({ path });
    table(db, "users", userSchema).insert(validUser);
    db.close();

    const reopened = open({ path });
    expect(doc(reopened, "users").get("u1")).toEqual(validUser as unknown as Doc);
    reopened.close();
  });
});
