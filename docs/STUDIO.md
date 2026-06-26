# Using LibreDB from LibreDB Studio

[LibreDB Studio](https://github.com/libredb/libredb-studio) is the open-source web IDE for databases
(Postgres, MySQL, MongoDB, Redis, and more). It speaks to a LibreDB file the same way it speaks to
SQLite: there is no server and no wire protocol, so Studio imports the `@libredb/libredb` package and
opens the file **in-process on the Studio server**, then lets you browse and edit it from the editor.

This page explains the integration from the *database* side — how Studio's editor commands map onto
this package's lens API, and how to create catalog-aware tables and collections that Studio renders
faithfully. The full, version-matched command reference (grammar, quoting, result shaping, error
messages) is maintained in Studio's own repository and is the authoritative source:

> **Authoritative provider reference:**
> [`libredb-studio/docs/providers/libredb.md`](https://github.com/libredb/libredb-studio/blob/main/docs/providers/libredb.md)

## The connection

A LibreDB connection is just a path to a `.libredb` file on the Studio server's filesystem:

```jsonc
{ "type": "libredb", "database": "/data/app.libredb" }
```

The `database` field carries the file path (reused exactly like SQLite — there is no separate `path`
field). The file is opened with `open({ path })`; a path that does not exist yet is created on the
first write. Connecting without a path is rejected — there is no in-memory mode for a connection.

## How editor commands map to the lens API

LibreDB has no SQL. Studio's editor exposes a small command grammar over the **key-value lens**
(`kv`) — each command is a thin wrapper over one lens method:

| Command | What it does | Lens call |
| --- | --- | --- |
| `get <key>` | Read one key | [`kv.get(key)`](./guides/key-value.md) |
| `put <key> <value>` | Write or overwrite a key (durable, fsync'd) | `kv.set(key, value)` |
| `delete <key>` | Remove a key | `kv.delete(key)` |
| `prefix <p>` | Every key beginning with `<p>`, ascending | `kv.prefix(p)` |
| `range <start> <end>` | The half-open interval `[start, end)` — `end` excluded | `kv.range(start, end)` |

The editor works only at the `kv` level — there is intentionally no `select`, full-keyspace scan,
`CREATE TABLE`, or multi-key `transact` in v1. For the exact grammar (case-insensitivity, JSON
quoting, comments, error messages, result shaping), see the
[authoritative Studio reference](https://github.com/libredb/libredb-studio/blob/main/docs/providers/libredb.md).

## Creating catalog-aware tables and collections

The editor reads and writes at the `kv` level, so it has no DDL. To create a relational table or
document collection that Studio shows with **real columns** (or as a real collection), use the lens
API in code — the [catalog](./guides/catalog.md) records the namespace's kind on write:

```ts
import { open, table, doc } from "@libredb/libredb";

const db = open({ path: "/data/app.libredb" });

// A typed table -> Studio shows real columns (id, name, age, active).
const users = table(db, "users", {
  primaryKey: "id",
  columns: { id: "string", name: "string", age: "number", active: "boolean" },
});
users.insert({ id: "1", name: "Ada", age: 36, active: true });

// A document collection -> Studio shows it as id + document.
doc(db, "people").put("1", { name: "Ada", team: "research" });

db.close();
```

Reopen the connection (or refresh the schema) in Studio and the new `users` table and `people`
collection appear alongside any raw `kv` prefix groups. You still read and edit their rows from the
editor through their underlying keys (`users:1`, `people:1`, …) with the usual `get` / `put` /
`prefix` / `range` commands.

## How the sidebar tree is built

A `.libredb` file is raw ordered key-value bytes; the bytes alone do not say which lens a namespace
belongs to. Studio renders the tree from the **catalog** (`catalog(db)`):

- A namespace registered as a **relational table** (the `table` lens) shows its real columns and
  types, primary key marked.
- A namespace registered as a **document collection** (the `doc` lens) shows as an `id` + `document`
  pair.
- Everything else is **raw `kv`**, grouped by the `:`-prefix into pseudo-tables
  (`user:1`, `user:2` -> the group `user:*`); a key with no colon is its own group.

Engine-internal keys (the catalog itself) are hidden using the package's `isReservedKey` contract, so
they never appear in any view. See the [catalog guide](./guides/catalog.md) for the underlying API.

## See also

- [Lens guides](./guides/) — the `kv`, `doc`, and `table` APIs these commands sit on top of.
- [`DESIGN.md`](./DESIGN.md) — why the kernel is one ordered key-value core with thin lenses.
- [Studio provider reference](https://github.com/libredb/libredb-studio/blob/main/docs/providers/libredb.md)
  — the authoritative, version-matched command grammar.
