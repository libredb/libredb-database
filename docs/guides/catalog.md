# The catalog — what a database holds

> Part of the [LibreDB guides](./README.md). See also: [key-value](./key-value.md) ·
> [document](./document.md) · [relational](./relational.md).

Open a LibreDB file cold and the bytes alone don't say which lens each namespace belongs to. The
catalog records that as you write: a `table` registers `{ kind: "relational", schema }` when its
handle is built, and a `doc` collection registers `{ kind: "document" }` on its first write.
`catalog(db)` reads the whole registry — a `Map` from namespace name to its entry — so a tool can
render faithful per-kind views without guessing:

```ts
import { open, table, doc, catalog } from "@libredb/libredb";

const db = open();

table(db, "users", { primaryKey: "id", columns: { id: "string", age: "number" } });
doc(db, "logs").put("l1", { message: "hello" });

const registry = catalog(db);
registry.get("users");
// { kind: "relational", schema: { primaryKey: "id", columns: { id: "string", age: "number" } } }
registry.get("logs");
// { kind: "document" }
[...registry.keys()].sort();
// ["logs", "users"]
```

The catalog lives under a reserved key prefix that sorts below all user data, so its entries never
appear in a `kv`, `doc`, or `table` scan — and no user row leaks into the registry. `kv` namespaces
are deliberately not cataloged: `kv` is the raw layer with full keyspace access.

A tool that renders the raw `kv` layer (so it sees everything, including the catalog) should hide
those engine-internal keys. Rather than hardcode the byte layout, import the contract:
`isReservedKey(key)` is true for any key in the reserved namespace, and `RESERVED_MARKER` /
`CATALOG_PREFIX` are the underlying constants if you need to build a range.

```ts
import { open, kv, isReservedKey } from "@libredb/libredb";

const db = open();
// ... user writes through doc/table, which also write catalog entries ...

// range is half-open [start, end). "" encodes to the lowest bytes, and
// "\u{10FFFF}" (the highest Unicode code point) encodes above any UTF-8 text key
// the lenses produce, so this interval covers the whole keyspace. (kv.prefix
// cannot scan everything — it rejects an empty prefix.) This is the same
// full-keyspace pattern LibreDB Studio's provider uses.
const visible = kv(db)
  .range("", "\u{10FFFF}")
  .toArray()
  .filter((e) => !isReservedKey(e.key));
// only user keys; catalog entries (under the reserved marker) are filtered out
```
