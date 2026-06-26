# The key-value lens

> Part of the [LibreDB guides](./README.md). See also: [document](./document.md) ·
> [relational](./relational.md) · [catalog](./catalog.md).

The first lens is `kv`: a durable, ordered, string-keyed map over the kernel. You `open` a kernel
database and put a `kv` lens over it.

```ts
import { open, kv } from "@libredb/libredb";

// In-memory: the natural fit for tests and ephemeral use.
const db = open();

// Or file-backed and durable. Every write is appended to a write-ahead
// log and fsync'd before it returns, so a committed write survives a
// crash; reopening the same path reconstructs exactly the committed state:
//
//   const db = open({ path: "data.libredb" });

const store = kv(db);

store.set("user:1", "Ada");
store.set("user:2", "Grace");

store.get("user:1"); // "Ada"
store.get("missing"); // undefined

db.close();
```

## Writes report what they changed

Every write returns a `WriteResult` (`{ changed }`), so a caller can always see what the write
actually did:

```ts
store.set("user:1", "Ada Lovelace").changed; // 1 (overwrote the existing value)

store.delete("user:2").changed; // 1 (it existed)
store.delete("user:2").changed; // 0 (already gone)
```

## Ordered scans

Keys are ordered by byte order, so reads come back in ascending key order. `range(start, end)` scans
the half-open interval `[start, end)` — `start` included, `end` excluded:

```ts
store.set("a", "1");
store.set("b", "2");
store.set("c", "3");

store.range("a", "c").toArray();
// [{ key: "a", value: "1" }, { key: "b", value: "2" }] — "c" is excluded
```

`prefix(p)` scans every key beginning with `p` — the canonical ordered-KV query:

```ts
store.prefix("user:").toArray();
// [{ key: "user:1", value: "Ada Lovelace" }]
```

A read returns a `Result`, which is **lazy and re-iterable**: nothing runs until you iterate it (or
call `toArray()`), and each pass re-runs the scan against the current state. Iterate it directly or
materialize it:

```ts
for (const { key, value } of store.prefix("user:")) {
  console.log(key, value);
}
```

## Multi-key atomicity

Each `kv` operation auto-commits in its own transaction. When you need several writes to apply
atomically, drop to the kernel's `transact` directly — it commits all of the body's writes together,
or nothing if the body throws:

```ts
const encode = new TextEncoder();

db.transact((tx) => {
  tx.set(encode.encode("from"), encode.encode("90"));
  tx.set(encode.encode("to"), encode.encode("110"));
}); // both writes commit together, or neither does
```

The kernel speaks raw bytes on purpose; the `kv` lens is the string-ergonomic face over it.
