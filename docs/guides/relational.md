# The relational lens

> Part of the [LibreDB guides](./README.md). See also: [key-value](./key-value.md) ·
> [document](./document.md) · [catalog](./catalog.md).

The `table` lens is the *typed* face over the same kernel: a table is a schema-validated collection of
rows. Where `doc` accepts any JSON object, `table` declares its columns and their types up front and
enforces them at insert. A row is stored under `<table>:<pk>`, so a table is literally a
schema-validated document collection — it reuses the document codec and the same collection-isolation
boundary.

You declare a schema (the columns, their types, and which one is the primary key) when you open the
table:

```ts
import { open, table } from "@libredb/libredb";

const db = open(); // or open({ path: "data.libredb" }) for durability

const users = table(db, "users", {
  primaryKey: "id",
  columns: { id: "string", name: "string", age: "number", active: "boolean" },
});

users.insert({ id: "1", name: "Ada", age: 36, active: true });
users.insert({ id: "2", name: "Grace", age: 45, active: false });

users.get("1"); // { id: "1", name: "Ada", age: 36, active: true }
users.get("missing"); // undefined

db.close();
```

A column type is one of `"string"`, `"number"`, `"boolean"`, or `"object"` (a plain JSON object). The
`primaryKey` must name a declared `"string"` column — it becomes the kernel key.

## Validation is strict at insert

Insert rejects a row that is missing a declared column, has a wrong-typed value, or carries a field
the schema does not declare — there is no silent coercion or field-dropping:

```ts
users.insert({ id: "3", name: "Edsger" });
// throws: missing required column "age"

users.insert({ id: "3", name: "Edsger", age: "old", active: true });
// throws: column "age" expected number, got string

users.insert({ id: "3", name: "Edsger", age: 40, active: true, role: "ops" });
// throws: unknown column "role" (not declared in the table schema)
```

## Writes report what they changed

Like the other lenses, every write returns a `WriteResult` (`{ changed }`):

```ts
users.insert({ id: "1", name: "Ada Lovelace", age: 36, active: true }).changed; // 1 (overwrote)

users.delete("2").changed; // 1 (it existed)
users.delete("2").changed; // 0 (already gone)
```

## Querying — where, select, join

Reads return a chainable `Query` (which is itself a lazy, re-iterable `Result`). `where(predicate)`
keeps the rows whose top-level fields all equal the predicate's — deep and type-sensitive, just like
document `find`, so `36` does not match `"36"`. `select(...columns)` projects each row down to the
named columns. They compose in any order:

```ts
const people = table(open(), "people", {
  primaryKey: "id",
  columns: { id: "string", name: "string", team: "string", active: "boolean" },
});

people.insert({ id: "1", name: "Ada", team: "research", active: true });
people.insert({ id: "2", name: "Grace", team: "research", active: false });
people.insert({ id: "3", name: "Edsger", team: "ops", active: true });

people.where({ team: "research", active: true }).select("name").toArray();
// [{ name: "Ada" }]
```

`join(other, leftField, rightField)` is an inner equi-join via nested loop: it pairs each left row
with every right row whose `rightField` equals the left row's `leftField`. The result rows carry every
column of both sides, qualified as `table.column`, so the two sides never collide — and `select`/`where`
name a qualified column the same way as any other:

```ts
const orders = table(db, "orders", {
  primaryKey: "id",
  columns: { id: "string", userId: "string", total: "number" },
});

orders.insert({ id: "o1", userId: "1", total: 42 });
orders.insert({ id: "o2", userId: "1", total: 7 });

users.join(orders, "id", "userId").select("users.name", "orders.total").toArray();
// [
//   { "users.name": "Ada Lovelace", "orders.total": 42 },
//   { "users.name": "Ada Lovelace", "orders.total": 7 },
// ]
```

`where` is O(n) in the table size and `join` is O(n*m) — nested-loop, no indexes (the same deliberate
v1 omission as the document lens). Unmatched rows on either side are dropped (inner join), and a left
key matching several right rows fans out to several result rows.
