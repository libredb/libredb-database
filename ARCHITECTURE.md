# LibreDB Architecture

A guided tour of what is under the hood: the structure, the algorithms, and the
reasoning. If you are about to use LibreDB or read its source, this document is
the map. It explains *how the system works*; the locked decisions and their
rationale live in [`DESIGN.md`](./docs/DESIGN.md), and what LibreDB refuses to be is
in [`MANIFESTO.md`](./MANIFESTO.md).

LibreDB is a small, readable, embeddable, multi-model database written in
TypeScript. The bet behind it: a database can be powerful and still be understood
by opening its source.

---

## 1. The core idea

LibreDB follows the FoundationDB pattern: **one small ordered key-value core, with
thin model "lenses" on top of it.**

- The core (`core.ts`) is the only place that touches durability. It is an
  ordered byte key-value store with atomic transactions and a write-ahead log.
- Everything else is a *lens*: a typed view that puts an ergonomic face on the
  core without adding storage, transactions, or recovery of its own.

There are three lenses, and their order is itself an argument:

```
  kv          the proof          "the ordered KV core, usable directly"
  document    the differentiator JSON documents
  relational  the reach          schemas, queries, joins
```

The key fact to internalize: **all three lenses sit on top of the same core and
add nothing to it.** A relational table is physically a document collection,
which is physically a set of ordered key-value entries. One storage primitive
carries three data models, with no duplication.

---

## 2. The layered map

```
                        +-------------------+
                        |     index.ts      |   public npm surface
                        +-------------------+
                                  |
        +-------------------------+--------------------------+
        |                         |                          |
   +---------+             +--------------+           +---------------+
   |   kv    |             |   document   |           |  relational   |    lenses
   +---------+             +--------------+           +---------------+    (open edge)
        |                    |        |                 |    |
        |          +---------+        +-----------------+    |
        |          |                                         |
        |    +-----------+    +-------------+    +-----------------+
        +----| query/    |    |  catalog    |    | types (Result,  |     shared edges
             | range     |    | (reserved   |    | WriteResult)    |
             +-----------+    |  namespace) |    +-----------------+
                              +-------------+
                                  |
                          +---------------+
                          | adapter/store |   the narrow `transact` port
                          +---------------+
                                  |
        ===================================================  TRUST BOUNDARY
                                  |
                          +---------------+
                          |    core.ts    |   the kernel: ordered KV +
                          |  (the kernel) |   transactions + WAL + recovery
                          +---------------+
                                  |
                          +---------------+
                          |  FileSystem   |   the one IO seam
                          |  (node:fs or  |   (real disk, or a simulated
                          |   simulated)  |    filesystem for crash tests)
                          +---------------+
```

The dependency arrow always points **down**: lenses depend on the core, never the
reverse. The catalog never imports a lens (only an erased `import type`), so there
is no cycle.

### The trust boundary

The horizontal line above is not just a diagram nicety. It is the project's trust
model, and it maps exactly to the file boundary:

- **Below the line (`core.ts`):** guarded. Everything that can corrupt data lives
  here. Changes get heavy review and deterministic crash tests. It stays small
  because it is genuinely minimal.
- **Above the line (lenses, query, catalog):** open. New drivers, lenses, and
  tooling can be contributed fast, because a bug there cannot corrupt the durable
  store; the worst it can do is present a bad view.

A lens reaches the store only through one narrow port, `adapter/store.ts`:

```ts
interface Store {
  transact<T>(run: (tx: Transaction) => T): T;
}
```

That is the entire contract. A lens can run a transaction; it cannot open, close,
or recover the store. The kernel's `Database` satisfies this port structurally, so
the real durable path runs through it, but a test fake or a future remote core
could satisfy it too.

---

## 3. The kernel: an ordered byte key-value store

Everything rests on one decision: **keys are bytes (`Uint8Array`), kept sorted by
unsigned byte-lexicographic order.**

Keys are bytes, not strings, on purpose:

- Byte order is unambiguous and stable. JavaScript string order is UTF-16 and
  disagrees with byte order above U+FFFF; byte order is what a sorted file uses.
- Only bytes let the lenses build **composite keys** by concatenation
  (`users:42`) and scan them as **ranges**. This is the move the whole
  multi-model design rests on.

### The data structure

The committed store is a single array of `{ key, value }` entries, kept sorted by
key. That is the whole structure. Three operations work on it:

```
compareKeys(a, b)   unsigned byte comparison: first differing byte wins;
                    if one is a prefix of the other, the shorter sorts first.

locate(entries, k)  binary search. Returns the index if found, otherwise the
                    index where inserting k keeps the array sorted.

applySet / applyDelete   insert/overwrite or remove, keeping the array sorted.
```

`locate` doing double duty (found-index or insertion-point) is what makes a range
scan trivial: "find where `start` would go, then walk forward until a key reaches
`end`."

```
sorted committed[]:   [ aardvark | apple | banana | cherry | mango ]
                                      ^                  ^
getRange("apple",                  start              first key >= "mango"
         "mango")                 (included)            (stop, excluded)
                          yields:  apple, banana, cherry   ->  [start, end)
```

Why a sorted array and not a hash map? A hash map gives O(1) point lookups but no
order. Order is not an implementation detail to hide here -- it *is* the kernel's
defining property, because range and prefix scans are built on it, and the entire
multi-model architecture is built on those. Point lookups become O(log n), and
that trade is accepted on purpose: the budget is comprehension, not throughput
(`DESIGN.md`).

### The interface

```ts
interface Transaction {
  get(key: Key): Value | undefined;
  set(key: Key, value: Value): void;
  delete(key: Key): void;
  getRange(start: Key, end: Key): Iterable<Entry>;   // half-open [start, end)
}

interface Database {
  transact<T>(run: (tx: Transaction) => T): T;
  close(): void;
}

const open: (options?: { path?: string; fs?: FileSystem }) => Database;
```

With a `path`, the database is file-backed and durable. Without one, it is purely
in-memory -- the natural fit for tests and ephemeral use. The API is synchronous
on purpose: LibreDB is embedded and single-process, and a synchronous core (like
SQLite's) is both correct and far easier to read than one colored by promises
everywhere.

---

## 4. Transactions and isolation

Every read and write happens inside a transaction. It is the kernel's one
atomicity primitive, and its isolation level is **SERIALIZABLE** -- achieved
without locks or MVCC, almost for free.

### Copy-on-write commit

```
transact(run):
    working  = committed.slice()          # a copy of the committed array
    journal  = []                          # the redo records to persist
    result   = run( transaction over working, journal )   # body runs here

    # reached only if the body did NOT throw:
    if file-backed and journal not empty:
        log.append(journal); fsync()       # durability point (see section 5)
    committed = working                    # commit == one atomic reference swap
    return result
```

Three ideas are folded together here:

1. **Copy-on-write.** Each transaction works on a copy of the committed array.
   Success is `committed = working` -- a single reference assignment. An abort is
   simply never reaching that line, so there is *no rollback code*: the discarded
   copy is just garbage-collected. Read-your-writes is free, because the body
   reads and writes the same `working` copy.

2. **Serializable by construction.** The API is synchronous and single-threaded,
   so one transaction body runs to completion before the next begins. The schedule
   is therefore always serial, and a serial schedule is serializable by
   definition. This is not a proof obligation; it is a runtime fact.

3. **Re-entrancy is forbidden.** The only way to overlap two transactions would be
   to call `transact` from inside another. That would let the inner snapshot miss
   the outer's pending writes, and the outer's later commit clobber the inner's --
   a silent lost update. So nested `transact` throws. With that guard, the
   serializable guarantee is real.

Contrast with what you know: in Postgres or Oracle, SERIALIZABLE is a large
machine (MVCC + snapshots + serialization-failure retries). Here the same
isolation falls out of an architectural constraint -- single process, synchronous
API. That is a deliberate scope choice, not a trick; concurrent writers are a
future that would reopen this decision.

---

## 5. Durability: the write-ahead log

If you give `open` a `path`, durability is a **write-ahead log (WAL)**: a redo log.

A WAL is the standard way databases survive crashes. The rule is one sentence:
*before treating a change as durable, first append a description of it to a
sequential, append-only log file and fsync that file.* Appending to the end of one
file and fsyncing is a simple, near-atomic step; updating complex structures
in place is not. After a crash, the log is replayed to rebuild state.

### The single-file model

Most databases keep the WAL in a separate file from the main data (Postgres has
`pg_wal/` plus heap files; SQLite has `db` plus `db-wal`). **LibreDB does not.**

> In LibreDB, the WAL *is* the database. There is no separate data file.

The file you open *is* the sequence of every committed transaction's redo records,
back to back. On open, the entire state is reconstructed by replaying that log into
the in-memory sorted array. There is no second on-disk representation.

### The memory model: three boxes, collapsed to two

The single-file model is best understood by what it *removes*. Reach for your
mental model of a production database -- Postgres, Oracle, MySQL/InnoDB, MongoDB
(WiredTiger), Cassandra. They all have a WAL, and they all arrange storage in
**three** distinct places:

```
  POPULAR SYSTEMS (Postgres / Oracle / InnoDB / WiredTiger / Cassandra ...)

   in memory:  +------------------------------+
               |  buffer pool / page cache    |   a SUBSET of the data -- the
               |  (hot pages, some dirty)     |   hot pages, held as a cache
               +------------------------------+
                     |  dirty pages flushed lazily, at checkpoints
                     v
   on disk:    +------------------------------+
               |  DATA FILES (heap, B-tree)   |   the authoritative store; far
               |  -- the real data, > RAM     |   larger than memory
               +------------------------------+
               |  WAL / redo log              |   the durability journal that makes
               |                              |   a commit safe before pages flush
               +------------------------------+
```

Why three? Because in those systems **the data is larger than RAM.** So the
authoritative copy lives on disk in the data files; memory holds only a *cache* of
hot pages (the buffer pool); and the WAL exists to make a commit durable in the gap
before those cached, dirty pages are written back. A checkpoint periodically
flushes dirty pages into the data files and trims the WAL. Three boxes, each
solving a piece of the "bigger than memory" problem.

LibreDB collapses this to **two**:

```
  LibreDB

   in memory:  +------------------------------+
               |  committed[]  -- the WHOLE    |   NOT a cache. This is the
               |  dataset, sorted              |   authoritative store, in full.
               +------------------------------+
                     ^  reference swap, AFTER fsync (the commit point)
                     |
   on disk:    +------------------------------+
               |  WAL = the single file        |   the ONLY on-disk representation.
               |  (replayed on open)           |   No separate data file.
               +------------------------------+
```

Two differences, and they are the whole story:

- **There is no separate data file.** The WAL is the only thing on disk. State is
  reconstructed by replaying it on open (section 4 of the lifecycle), not by
  reading a data file.
- **The in-memory store is not a buffer pool.** A buffer pool is a *cache* -- a
  subset of pages, with the truth living on disk. LibreDB's `committed` array is
  the *authoritative, complete* dataset. Reads never touch disk; the only disk I/O
  on the whole write path is the WAL append-and-fsync at commit.

### This is a deliberate choice, not a missing piece

It is tempting to read "no data file, no buffer pool" as immaturity. It is the
opposite -- it is a design decision, and a well-established one:

- **Redis (AOF mode)** is exactly this shape: the entire dataset in memory, an
  append-only file for durability, replayed on restart, with a periodic rewrite to
  bound its size. LibreDB is essentially "Redis AOF" in lineage; the rewrite step
  (compaction) is the piece not yet built (section 10.3).
- **H2's in-memory mode**, and most embedded/test databases, sit in the same
  family.

The three-box architecture is not free: a buffer pool, page eviction, dirty-page
tracking, and checkpoint coordination are a large amount of the complexity (and the
line count) of a production engine -- and that complexity exists *to serve the
larger-than-RAM case*. LibreDB's beachhead is test/dev, where datasets fit in
memory, so paying for that machinery would buy nothing here while making the engine
far harder to read. Collapsing to two boxes is how the kernel stays small enough to
understand in one sitting.

The honest trade is named plainly elsewhere in this document: the in-memory store
is **bounded by RAM** (section 10.1), and the append-only log **grows with write
history** until compaction is added (sections 5 and 10.3). Those are the costs of
the two-box model. They are scope limits of the v1 beachhead, not flaws in the
design -- and both are addressed *above or within* the existing structure when the
time comes, without the three-box machinery becoming mandatory.

### On-disk record format

Each committed transaction is one length-framed, checksummed record:

```
  record = [ u32 payloadLength ] [ u32 crc32(payload) ] [ payload ]
                  4 bytes              4 bytes

  payload = one or more ops, back to back:
      set    = [ u8 1 ] [ u32 keyLen ] [ key ] [ u32 valLen ] [ value ]
      delete = [ u8 0 ] [ u32 keyLen ] [ key ]

  all integers are big-endian.
```

A real record from a live file, decoded (the first write of a relational table --
its schema, before any row):

```
  00 00 00 9d                         payloadLength = 157
  ea 44 78 48                         crc32
  01                                  op = SET
  00 00 00 16                         keyLen = 22
  00 6c 69 62 72 65 64 62 3a ...      key = "\x00libredb:catalog:users"
  00 00 00 7e                         valLen = 126
  7b 22 6b 69 6e 64 22 ...            value = {"kind":"relational","schema":{...}}
```

Note the leading `00` byte in the key -- the reserved catalog marker (section 7).

### The commit ordering, and why it is safe

The fsync happens *before* the in-memory commit becomes visible:

```
  append(record)  ->  fsync()  ->  committed = working
  \________________________/       \_______________/
   on disk, survives a crash         now visible in memory
```

So when `transact()` returns, the change is on disk. If the append fails, the code
throws with memory and disk still agreeing on the *prior* state. A read-only
transaction writes nothing to the log.

### Recovery and torn writes

Because the log is append-only and fsynced, a crash can only ever damage the
**last** record. Recovery exploits this:

```
  recover(file):
      replay each intact record in order, rebuilding the sorted array
      stop at the first record that is:
          - torn   (header promises more bytes than exist), or
          - corrupt (crc32 of payload does not match)
      truncate the file at that point   # next append starts from a clean boundary
```

```
  [ record 1 ][ record 2 ][ record 3 ][ half-written record 4 ]
   ^valid      ^valid      ^valid      ^crc fails or bytes missing
                                       |
                              replay stops here, tail is truncated away
```

The CRC-32 is computed without a lookup table, on purpose: the mechanism stays in
plain sight in the source rather than hiding behind a precomputed table.

### A consequence: the log only grows

The log is append-only, so an update or delete does **not** erase old bytes -- it
appends a new record that supersedes the old one during replay. Reads stay correct
(the later record wins), but the file grows with history. Real databases solve this
with **checkpointing / compaction** (fold the log into the main store, then trim
it). LibreDB v1 has none -- a deliberate omission. For its test/dev beachhead this
is acceptable; it is one of the decisions that production scale would reopen.

---

## 6. The lenses

A lens is a typed view over the kernel. Each one is deliberately thin.

### kv -- the proof lens

The kernel is already an ordered byte KV store, so this is the thinnest lens
possible. It adds only:

- **String ergonomics** -- UTF-8 encode on the way in, decode on the way out, so
  it reads like the `Map<string, string>` it replaces.
- **Auto-commit** -- each operation runs in its own transaction, so a write is
  atomic and (file-backed) fsynced before it returns.
- **`prefix(p)`** -- the one ordered-KV query the kernel lacks, computed on bytes
  by `query/range.ts` so the bound agrees with the kernel's order (the naive
  `prefix + "￿"` string trick is unsound across UTF-16 vs byte order).

```ts
const store = kv(open({ path: "data.libredb" }));
store.set("config:theme", "dark");
store.get("config:theme");              // "dark"
store.prefix("config:").toArray();      // every key under "config:"
```

### document -- the differentiator lens

A document is a JSON object stored as UTF-8 JSON bytes under a `<collection>:<id>`
key. The lens adds a JSON codec and by-id CRUD, plus two scans:

- `all()` -- every document in the collection, via a prefix scan over
  `<collection>:`. The colon is a sound byte boundary, so a sibling collection
  like `users2` never leaks into `users`.
- `find(predicate)` -- documents whose top-level fields match the predicate by
  **deep structural equality** (type-sensitive: `1` is not `"1"`). This is an
  **O(n) full scan with an in-engine predicate** -- there are no secondary indexes
  in v1.

```ts
const people = doc(open({ path: "data.libredb" }), "people");
people.put("1", { name: "Ada", team: "research", active: true });
people.find({ team: "research" }).toArray();
```

### relational -- the reach lens

This is a relational *view*, not a SQL engine: no SQL text, no parser, no planner.
A table is a **schema-validated document collection** stored at `<table>:<pk>` --
the exact storage scheme the document lens uses.

```
  relational table  ==  schema-validated document collection
                    ==  ordered KV entries at <table>:<pk>
```

The relational lens holds a document handle for the same name and reads/writes
rows through it, inheriting the JSON codec and collision-safe prefix scan for free.
What it *adds* over the document lens is the **schema**:

- `TableSchema` declares the columns, their types
  (`string | number | boolean | object`), and the primary-key column (which must
  be a declared `string` column, since the PK becomes the kernel key).
- `validateRow` is strict: missing column, wrong type, or unknown field is a loud
  error on insert -- no silent coercion or dropping.

On top of that it offers a small chainable query surface, all evaluated in-engine
over materialized rows:

- `where(predicate)` -- field-equality filter (reuses the document lens's matcher).
- `select(...columns)` -- column projection.
- `join(other, leftField, rightField)` -- inner equi-join by **nested loop**,
  O(n*m), producing rows with columns qualified as `table.column`.

```ts
const db = open({ path: "data.libredb" });
const users = table(db, "users", {
  primaryKey: "id",
  columns: { id: "string", name: "string", age: "number", active: "boolean" },
});
users.insert({ id: "1", name: "Ada", age: 36, active: true });
users.where({ active: true }).select("id", "name").toArray();
```

---

## 7. The catalog: a reserved namespace

When a tool (for example, the LibreDB Studio provider) opens a LibreDB file cold,
it needs to know which lens each namespace belongs to, and a table's schema. That
interpretation is not otherwise recoverable from raw bytes, so the lenses persist
it -- as **ordinary KV entries under a reserved key prefix**. It is a lens-level
convention; the kernel stays pure ordered-KV and unchanged.

### The boundary trick

The reserved marker is `U+0000`, the single byte `0x00` -- the lowest possible
byte. A user namespace name may not start with it (enforced by `assertUserName`,
which `doc` and `table` call). That one rule keeps every catalog key sorted
strictly below every user key:

```
  in-memory sorted keyspace:

    \x00libredb:catalog:people   ┐
    \x00libredb:catalog:users    ┘  reserved: all catalog entries, contiguous,
    ----------------------------    below every user key
    config:locale                ┐
    config:theme                 |
    people:1                     |  user data
    users:1                      |
    users:2                      ┘
```

So `catalog()` reads the whole registry with a single prefix scan over
`[\x00libredb:catalog:, ...)`, disjoint from all user data by construction. On
disk the catalog records are scattered through the WAL in write order; in memory
they cluster together. The sorted keyspace reconciles the two.

### What gets cataloged, and when

Each lens registers differently, and that shows up directly in the WAL:

```
  relational   eager.  Written at table() construction, in its own transaction,
                       BEFORE any row. Value: {"kind":"relational","schema":{...}}

  document     lazy.   Written on the first put(), write-if-absent, riding the
                       SAME transaction as that first document (one fsync).
                       Value: {"kind":"document"}   (schemaless -- kind only)

  kv           never.  kv is the raw layer with full keyspace access; it does
                       not register. A namespace absent from the catalog is
                       understood to be raw kv.
```

The write-if-absent rule for documents is load-bearing: a relational table routes
its inserts through an internal document `put`, but its `{"kind":"relational"}`
entry was already recorded at construction, so the document registration no-ops
there and never downgrades it.

### Validate-on-reopen (no migration in v1)

Opening a table whose name is already cataloged validates the schema instead of
overwriting it:

```
  table(db, "users", schema):
      existing = catalog entry for "users"
      if none:                  record { kind: "relational", schema }    # first time
      else if schemas equal:    accept (no-op)                           # column order ignored
      else:                     throw "no schema migration in v1"        # fail fast
```

The mismatch throws at *handle construction*, before any data operation -- you
never get a `Table` with a schema that disagrees with the bytes on disk. This is a
guard, not a missing feature: the engine refuses to silently reinterpret existing
data under a new schema. Changing a schema in v1 means using a new name or
rewriting the data by hand (the raw kv lens can even reach the catalog key
directly, since it is unguarded).

---

## 8. The query and result model

Lenses differ wildly in *how* you ask for data -- a kv range, a document filter, a
relational select. That is on purpose: a single unified query *language* is
rejected as a lowest-common-denominator trap. What the lenses share is not the
query syntax but the **result envelope**:

```ts
interface Result<Row> extends Iterable<Row> {
  toArray(): Row[];
}

interface WriteResult {
  readonly changed: number;   // entries created, overwritten, or removed
}
```

`Result` is **lazy and re-iterable**. Lazy: nothing runs until you iterate, so
wrapping a scan does not force it to materialize. Re-iterable: iterating twice runs
the read twice against current state, instead of the classic generator footgun
where the second pass silently yields nothing. Because of that, the `Result` *is*
the deferred query -- there is no separate query object. The relational `Query`
extends `Result` with `where`/`select`/`join`, so a chain stays lazy end to end.

`WriteResult.changed` keeps writes visible by default: a caller can always see what
a write actually did (a set is 1, deleting an absent key is 0).

---

## 9. The IO seam and deterministic simulation testing

The kernel never calls `node:fs` directly. Every byte to disk goes through one
small interface:

```ts
interface FileSystem { open(path: string): WalFile; }

interface WalFile {
  size(): number;
  read(offset: number, length: number): Uint8Array;
  append(bytes: Uint8Array): void;
  fsync(): void;
  truncate(length: number): void;
  close(): void;
}
```

The default is a thin real-`node:fs` adapter, so production behavior is unchanged.
But because the seam exists, a test can inject a **simulated filesystem**
(`src/sim/`) and torture crash recovery without a real disk: cut the file at an
arbitrary offset, flip bytes, simulate a crash between append and fsync, and assert
that recovery always reopens with consistent committed state. This is the
FoundationDB-style deterministic simulation testing (DST) approach, and it is how
the durability claims are kept honest.

---

## 10. Limits, deliberate omissions, and the road to production

LibreDB v1 is missing a great deal that a mature database has. Almost none of it
is an oversight. LibreDB does not compete with Postgres on features, nor with
SQLite / Turso / DuckDB on production maturity -- it competes on a different axis,
comprehension, and most "missing" features are cut precisely to protect that. This
section is honest about three different things, because they are not the same:

- **10.1 Current limits** -- the operational cost of the design as it stands.
- **10.2 Deliberate omissions** -- features left out on purpose, with the reason.
- **10.3 The road to production** -- what must still be added, split into
  *durability hardening* (required, and already tracked) and *scaling features*
  (which would reopen a locked decision).

A note on sourcing: 10.1 and 10.2 are the locked "honest deferrals" recorded in
[`DESIGN.md`](./docs/DESIGN.md). 10.3's hardening checklist is the open "production arc"
from that same document; the scaling discussion is architectural reasoning about
what reopening each decision would entail, not a committed roadmap.

### 10.1 Current limits (the cost of the design today)

| Area                | v1 behavior                          | Consequence                              |
| ------------------- | ------------------------------------ | ---------------------------------------- |
| Secondary indexes   | none                                 | `find` / `where` are O(n) full scans     |
| Joins               | nested loop                          | a join is O(n*m)                         |
| Query ordering      | primary-key (byte) order only        | no `ORDER BY` on arbitrary columns       |
| Concurrency         | single process, synchronous, serial   | one writer; no concurrent transactions   |
| Working set         | the whole store lives in memory      | bounded by RAM, not disk                 |
| Log growth          | append-only, no compaction           | the file grows with write *history*      |
| Multi-key atomicity | lenses auto-commit per operation     | for atomic multi-writes use `transact`   |
| Durability edge     | no directory fsync on first create   | see 10.3 -- a known hardening gap        |

None of these are hidden. The cost is concentrated where it is cheapest to reason
about, and the throughline is that **every one of them could be addressed above the
trust boundary, without growing the kernel.** That is the property worth
protecting.

### 10.2 Deliberate omissions (and why)

These are features deliberately left out of v1. They are grouped by where they
would live, and each group has a single governing reason.

**Document lens.** Omitted: secondary indexes, nested / dot-path field queries
(`a.b.c`), query operators (`$gt`, `$in`, ...), and auto-generated ids.
*Why:* the v1 promise is "real document querying, honestly minimal" -- a full
scan with an in-engine equality predicate. Each operator or index is real value,
but also real surface area; they are deferred so the lens stays small enough to
read, not because they are unwanted.

**Relational lens.** Omitted: SQL (text, lexer, planner), secondary indexes,
outer / non-equi joins, foreign keys, unique constraints, nullable / optional
columns, aggregation / group-by, and order-by beyond primary-key order.
*Why:* this is the **identity-risk lens**. A SQL engine would betray "small,
readable, conscious omission" and put LibreDB head-to-head with SQLite -- a
competition the project explicitly refuses. So v1 is a relational *view*, not a
SQL engine, on purpose. The line is deliberately drawn before SQL.

**Catalog.** Omitted: schema migration / evolution, a secondary-index catalog, a
constraints catalog, per-collection statistics.
*Why:* a catalog is the doorway to "real DBMS" features (system tables, DDL,
migrations), and that is exactly the scope creep to resist. v1 keeps it to the
minimum that unblocks faithful tooling views -- a registry plus validate-on-reopen
-- and nothing that requires growing the kernel. If a catalog feature cannot stay
a thin reserved-prefix convention over the unchanged kernel, it does not belong in
v1.

**Crash-test scope (DST).** Modeled: storage faults, torn writes, crash between
append and fsync. Not modeled: directory-fsync / power-loss-of-directory-entry,
multi-file scenarios, throughput simulation.
*Why:* the kernel is synchronous and single-threaded, so there is no concurrency
schedule to simulate (the hard part of FoundationDB-style DST is simply absent
here). The crash/recovery torture is the part that matters for a single-file WAL,
and that is what is built.

### 10.3 The road to production

The beachhead is test/dev, but the stated intent is that this is "a starting
point, not a ceiling" -- LibreDB is meant to *earn* production through its
every-line-tested discipline, not to be capped at toy status. Getting there splits
cleanly into two kinds of work.

**Durability hardening (required; does not change the architecture).**
These close real correctness gaps on the existing design. They are tracked as
known limitations, not new directions:

- **Directory fsync on first file creation.** Creating a file durably requires
  fsyncing the *directory*, not just the file -- otherwise a power loss can lose
  the directory entry for a freshly created database. Currently not done.
- **WAL compaction / checkpointing.** Today the log only grows (section 5). A
  checkpoint -- fold the committed state into a compact snapshot, then trim the
  log -- bounds file size and speeds recovery. This is the single most important
  hardening item for any long-lived database.
- **Short-read recovery robustness.** A note carried out of the crash-recovery
  work: make sure a partial read at the tail is always treated as a torn record,
  never as data.

**Scaling features (each reopens a locked decision).**
These are not on the v1 path and would each force a deliberate decision to be
revisited. They are listed so the trade is visible, not as promises:

- **Concurrent writers** would reopen the isolation model. Today serializability
  is free because execution is serial (section 4). Real concurrency means MVCC or
  optimistic concurrency control with conflict detection and retry -- a genuinely
  larger kernel. This is the highest-impact, highest-cost reopening.
- **Secondary indexes** would reopen the storage model. They fit the ordered
  keyspace naturally (an index is just another key range mapping an indexed value
  to primary keys), and could largely live in a lens -- but they add write-time
  index maintenance and a real query-planning question (when to use which index).
- **An async API** is explicitly *not* foreclosed: the synchronous core can carry
  an async face layered on top as an adapter, opening the door to async or remote
  backends without rewriting the kernel.
- **A larger-than-RAM store** would reopen the in-memory sorted array, replacing
  it with an on-disk paged structure (a B-tree or LSM tree) -- the deepest change,
  touching the one data structure everything rests on.
- **Packaging the trust boundary.** A future option is to ship `core` as its own
  npm package so the trust boundary becomes a package boundary. Not required, but
  it would make the "guarded core vs open edge" split physical.

The unifying rule across all of this: **durability hardening lands inside the
guarded core under heavy review; scaling features should be pushed above the trust
boundary wherever the ordered-KV substrate allows it.** The kernel earns production
by staying small and correct, not by absorbing every feature.

---

## 11. File map

| File                  | Layer        | Responsibility                                       |
| --------------------- | ------------ | ---------------------------------------------------- |
| `core.ts`             | kernel       | ordered KV, transactions, WAL, recovery, IO seam     |
| `adapter/store.ts`    | edge         | the narrow `transact` port a lens depends on         |
| `query/range.ts`      | edge         | byte-correct prefix-range computation                |
| `lens/types.ts`       | edge         | shared `Result` / `WriteResult` envelope             |
| `lens/kv.ts`          | lens         | string-keyed ordered map (proof lens)                |
| `lens/document.ts`    | lens         | JSON documents, by-id CRUD, scan and find            |
| `lens/relational.ts`  | lens         | schema-validated tables, where/select/join           |
| `lens/catalog.ts`     | edge         | reserved namespace, registry, validate-on-reopen     |
| `index.ts`            | public        | the npm export surface                               |
| `sim/`                | test harness | simulated filesystem and crash-recovery oracle (DST) |

---

## 12. End to end: one insert, from API to disk and back

Putting it together -- what happens when you insert a row into a file-backed table:

```
  table(db, "users", schema)
      -> catalog: record {"kind":"relational", schema}  (own txn, fsynced)

  users.insert({ id: "1", name: "Ada", age: 36, active: true })
      -> validateRow(schema, row)                 # strict: types, required, no extras
      -> document put at key "users:1"
           -> transact:
                recordDocument (write-if-absent)  # no-op: relational entry exists
                set "users:1" = JSON(row)
                ----------------------------------
                encode ops -> WAL record
                append + fsync                    # durable here
                committed = working               # visible here

  on disk (demo.libredb), now two records:
      [ \x00libredb:catalog:users -> {relational, schema} ]
      [ users:1 -> {"id":"1","name":"Ada","age":36,"active":true} ]

  reopen the file:
      recover() replays both records into the sorted in-memory array
      catalog() prefix-scans the reserved range -> { users: relational }
      users.where({ active: true }).select("id","name") -> [{ id:"1", name:"Ada" }]
```

That is the whole system: an ordered byte store, made durable by an append-only
log, viewed through thin typed lenses, with a reserved corner of the same keyspace
describing itself. Open the source -- it is meant to be read.
```
