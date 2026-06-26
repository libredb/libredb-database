# The document lens

> Part of the [LibreDB guides](./README.md). See also: [key-value](./key-value.md) ·
> [relational](./relational.md) · [catalog](./catalog.md).

The `doc` lens is the JSON face over the same kernel: a *collection* of JSON documents, each stored
under a string `id`. Where `kv` stores strings, `doc` stores objects — numbers stay numbers, and
nested objects and arrays survive the round-trip.

```ts
import { open, doc } from "@libredb/libredb";

const db = open(); // or open({ path: "data.libredb" }) for durability

const users = doc(db, "users");

users.put("1", { name: "Ada", age: 36, active: true });
users.put("2", { name: "Grace", age: 45, active: false });

users.get("1"); // { name: "Ada", age: 36, active: true }
users.get("missing"); // undefined

db.close();
```

Documents are scoped to their collection: `doc(db, "users")` never sees a `doc(db, "orders")`
document — and the boundary is exact, so `users` and `users2` stay fully separate.

## Writes report what they changed

Like the kv lens, every write returns a `WriteResult` (`{ changed }`):

```ts
users.put("1", { name: "Ada Lovelace", age: 36 }).changed; // 1 (overwrote the existing document)

users.delete("2").changed; // 1 (it existed)
users.delete("2").changed; // 0 (already gone)
```

## Scanning and finding

`all()` returns every document in the collection as `{ id, doc }` rows, in ascending `id` (byte)
order:

```ts
const people = doc(open(), "people");

people.put("1", { name: "Ada", team: "research", active: true });
people.put("2", { name: "Grace", team: "research", active: false });
people.put("3", { name: "Edsger", team: "ops", active: true });

people.all().toArray();
// [
//   { id: "1", doc: { name: "Ada", team: "research", active: true } },
//   { id: "2", doc: { name: "Grace", team: "research", active: false } },
//   { id: "3", doc: { name: "Edsger", team: "ops", active: true } },
// ]
```

`find(predicate)` returns the documents whose top-level fields all equal the predicate's. Multiple
fields are AND'd, and equality is deep and type-sensitive — `1` does not match `"1"`:

```ts
people.find({ team: "research", active: true }).toArray();
// [{ id: "1", doc: { name: "Ada", team: "research", active: true } }]
```

`find` is an O(n) full collection scan with an in-engine predicate — there are no secondary indexes
(a deliberate v1 omission, so you can read exactly what a query costs). Like every read it returns a
lazy, re-iterable `Result`, so you can iterate it directly or call `toArray()`.
