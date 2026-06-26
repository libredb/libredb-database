# LibreDB Database - Design & Decision Record

> Status: working document. Captures the decisions locked during the founding-philosophy brainstorm.
> Pairs with [`MANIFESTO.md`](.././MANIFESTO.md): the manifesto is the public statement; this is the engineering record behind it.

## 1. What LibreDB Database is

A real database with a deliberately small, readable, hackable, and reliable core. Its primary value is comprehensibility: you can open the source and learn how a database actually works, then embed it in your own product quickly.

LibreDB Database is the third product in a single family that shares one spine:

| Product | The same access model, as... | Audience | License |
|---------|------------------------------|----------|---------|
| LibreDB Database | ...code (a library you import) | Developers | Open, free |
| LibreDB Studio | ...a visual surface (DB-GUI) | Individuals, Teams | Open, free |
| LibreDB Platform | ...a managed, team service | Organizations | Paid, closed |

## 2. The wedge

LibreDB does not compete with Postgres on features, nor with SQLite/Turso/DuckDB on production maturity. It competes on a different axis:

> **LibreDB competes with the database textbook and the "I'll just use a `Map` for now" hack — not with Postgres.**
> It is the database you read, learn from, hack on, and embed fast.

Competitive landscape that forced this framing:

- **SQLite** — the king of embedded OLTP, but closed-contribution. Our openness is the difference.
- **DuckDB** — embedded OLAP/analytics. Owns that niche.
- **Turso / libSQL** — the closest precedent: an open-contribution, readable, embedded, heavily-tested (deterministic simulation testing) SQLite successor in Rust. Must be studied closely; we differ on size discipline, multi-model intent, and the TypeScript/learnability angle.
- **SurrealDB** — multi-model, but a large, complex server. The cautionary example of multi-model going big; we are the opposite.

The empty space we claim: **small + readable + embedded + multi-model**, where the core stays comprehensible.

## 3. Locked decisions

| Decision | Lock |
|----------|------|
| Product | A real database — but a small, readable, hackable, reliable core. |
| Wedge | "Read, learn, hack, embed." Competes with the textbook and the `Map` hack, not Postgres. |
| Beachhead | Test/dev environments — but a starting point, not a ceiling. Earns production through the every-line-tested discipline. |
| Architecture | FoundationDB logic: one small storage core + thin model lenses. Multi-model, but the core stays small. |
| First lens | Key-value (`kv.ts`). The core is an ordered key-value store, so the KV lens is the thinnest possible — it proves the architecture with minimal extra surface. It is the *proof* lens, not the marketing centerpiece. |
| Language / distribution | TypeScript (`core.ts`), shipped as an npm package — the same spine as Studio and Platform. |
| Core API | Synchronous (no promises) — SQLite-faithful, readable, embedded-first. An async face can be layered later as an adapter over the sync core, so this does not foreclose async backends. Ratified by the maintainer 2026-06-24. |
| Line-count discipline | Start the core around ~1,000 lines; core ceiling ~10,000. The real metric is comprehension time, not line count. No code-golf. Tests, tooling, and docs do not count toward the budget. |
| Reliability | Every line tested, with deterministic-simulation-grade discipline. Non-negotiable. |
| Contribution model | Edges open and fast (smolagents-style); durability core open to read but guarded on merge (heavy review + deterministic tests). |
| Visibility | Query, schema, plan, and errors are all visible by default. |

## 4. Principles

1. **Conscious omission.** Not an everything-engine. One small core plus thin lenses. Strength comes from what we refuse.
2. **Visibility by default.** Query, schema, plan visible; errors not hidden. No magic, only explainable behavior.
3. **Read in one sitting.** Whoever opens the source learns how a database works. The metric is comprehension time, not line count — so we open code up rather than compress it. The limit is a discipline, not a stunt.
4. **Reliability is not negotiable.** Readable is not a toy. Every line is tested. Starts in test/dev, but has no ceiling — it earns production.
5. **No forced abstraction.** Against the experience that forces an ORM, not against ORMs. Access is direct; abstraction is a choice, not a tax.
6. **Proximity.** Data stays close to code. You import it and embed it into your product in an afternoon, without learning a whole ecosystem first.
7. **Open edges, guarded core; one spine, three faces.** Drivers, adapters, tooling, studio are open and fast; the durability core is open to read but protected on merge. Database, Studio, and Platform are three faces of one core.

## 5. Architecture: file boundary = trust boundary = comprehension boundary

The two-tier trust model is expressed physically. A single file cannot encode "these lines are guarded, those are flexible"; the file boundary makes the trust model visible and CI-enforceable.

```
@libredb/core
|-- core.ts          KERNEL: storage + transactions + recovery. Starts ~1k lines.
|                    Strictest line budget. Heavy tests. CODEOWNERS-guarded.
|                    Reading this file teaches "how a database works."
|-- lens/
|   |-- kv.ts            First lens (natural fit: the core is an ordered key-value store)
|   |-- document.ts      Later
|   |-- relational.ts    Later
|-- adapter/ , query/    Edges: flexible, fast, open contribution
```

**The honesty discipline (critical):** `core.ts` must be small because it is genuinely minimal — not because complexity was swept into other files. The file boundary must simultaneously be:

1. The trust boundary (core: heavy tests + guarded review).
2. The comprehension boundary (`core.ts` alone conveys the whole mental model).
3. The architecture boundary (core = storage substrate + transactions + recovery; lenses sit on top).

If `core.ts` is small only because the hard parts were pushed elsewhere, the wedge collapses.

**Repo enforcement (rule, not slogan):**
- `core.ts` -> high coverage gate (deterministic simulation testing), mandatory CODEOWNERS review.
- `lens/`, `adapter/` -> lighter gate, fast merge.
- Future option: ship `core` as its own npm package so the trust boundary becomes a package boundary. Not required for v1.

Naming note: prefer `core` over `engine`. "Engine" carries heavyweight connotations in the database world; "core" matches the small-core pitch. Avoid having both `core.ts` and `engine.ts` — it blurs which is which.

## 6. Lens roadmap

Locked order, each chosen for a distinct job:

1. **`kv.ts` (key-value) — the proof lens.** Ships first. The core is already an ordered key-value store, so this lens is the thinnest possible: it proves the architecture honestly with minimal extra surface ("here is the ordered KV core, usable directly"). It is *not* the product centerpiece — KV as a product is crowded (RocksDB, LMDB, BoltDB, Badger) and undifferentiated.
2. **`document.ts` (document) — the differentiator lens.** Where the product story actually wins users: the anti-thesis to heavy, opaque MongoDB, and the strongest fit for the anti-ORM, schemaless, "close to the developer" narrative. This is the marketing centerpiece even though KV ships first.
3. **`relational.ts` (relational) — the reach lens.** Last. Directly overlaps SQLite/Turso's decades of hardening, so it is the least urgent and the hardest to differentiate.

## 6.1 Document lens — v1 locked design (ratified 2026-06-24)

The document lens is the differentiator milestone. Locked decisions:

- **Document** = a JSON-serializable object, stored as UTF-8 JSON bytes (the value) in the kernel. The lens is the JSON-ergonomic face over the byte kernel, exactly as `kv` is the string face.
- **Identity & storage** = an explicit string `id` per document; the kernel key is `<collection>:<id>` (UTF-8). A `doc(db, "<collection>")` handle scopes one collection. A collection scan is a prefix scan of `<collection>:` over the ordered-KV core (reuses `query/range`'s `prefixRange`).
- **API** = `put(id, obj)`, `get(id)`, `delete(id)`, `all()`, and `find(predicate)`. `find` matches **top-level field equality**; multiple fields are an implicit AND; each value compared by deep (structural) equality. Reads return a lazy, re-iterable `Result<{ id, doc }>`; writes return `WriteResult { changed }`. No unified query language — only the shared envelope from `lens/types.ts` is reused.
- **Querying** = `find` is a full collection scan with an in-engine predicate (no indexes). It is O(n) per query, by design and documented. This is the honest minimal that still delivers real document querying (the anti-MongoDB story).
- **Collection isolation (correctness, not nicety)** = a `<collection>:` prefix scan must select exactly that collection's documents and nothing from a collection whose name shares a prefix (e.g. `users` vs `users2`). The prefix upper bound is computed on raw bytes — the same soundness rule `query/range` already enforces.
- **Atomicity** = each operation auto-commits in its own kernel transaction (a file-backed write is fsync'd before returning); multi-document atomicity is a conscious omission — drop to the kernel's `transact`.
- **Honest deferrals (later, not v1):** secondary indexes, nested / dot-path field queries, query operators (`$gt`, `$in`, ...), and auto-generated ids.
- The kernel is **unchanged**; the lens is `lens/document.ts` reusing `lens/types.ts`, `adapter/store.ts`, and `query/`.

## 6.2 Relational lens — v1 locked design (ratified 2026-06-24)

The relational lens is the reach lens. It is the identity-risk lens: a SQL engine would betray "small, readable, conscious omission" and put LibreDB head-to-head with SQLite, which DESIGN section 2 explicitly refuses. So v1 is a deliberately minimal **relational view**, not a SQL engine. Locked decisions:

- **Programmatic, typed tables — NO SQL.** `table(db, name, schema)`. There is no SQL lexer/parser/planner; SQL text is a deliberate omission (it is "Level 3", refused).
- **Schema (the relational value over documents)** = `{ primaryKey, columns: { name: type } }`, `type` in `string | number | boolean | object`. `insert` strictly validates: declared columns required, types checked, unknown fields rejected. The `primaryKey` column must be a string (it becomes the kernel key).
- **Storage** = a row is a JSON object under `<table>:<pk>`, reusing the document lens's JSON codec, `query/range` prefix scan, and the collection-isolation soundness rule. Primary-key lookup is free (it is the kernel key).
- **Operations (chainable, lazy, returning the shared `Result`)**: `insert(row)`, `get(pk)`, `delete(pk)`, `all()`, `where(predicate)` (top-level field equality, reusing the document lens's matcher), `select(...columns)` (projection; qualified `table.column` after a join), and `join(other, leftField, rightField)` — an **inner equi-join, nested-loop, O(n*m), documented, no index**. `toArray()` / iteration are the terminals.
- **No unified query language** — it is a programmatic builder over the shared envelope, not parsed text.
- **Honest deferrals (later, not v1):** SQL, secondary indexes, outer / non-equi joins, foreign keys, unique constraints, nullable/optional columns, aggregation / group-by, and order-by beyond primary-key order.
- The kernel is **unchanged**; the lens is `lens/relational.ts`, built on top of the document lens and reusing `lens/types.ts`, `adapter/store.ts`, and `query/`.

## 6.3 Catalog — design for a future milestone (NOT built yet)

**Motivation.** A LibreDB file is raw ordered key-value bytes. Which lens a key belongs to (kv / document / relational) and a relational table's schema live in *application code* (`table(db, name, schema)`), NOT on disk. So a tool that opens a file cold — e.g. the LibreDB Studio provider — can only show the raw KV store grouped by key prefix; it cannot know that `orders:` is a relational table with schema X. The catalog persists that interpretation so tools can offer richer, faithful views. (Studio's raw-KV browser, "Option A", ships without this; the richer "Option B" views depend on it.)

**Locked-by-default design (ratify before building):**

- **A lens-level convention, NOT a kernel feature.** The kernel stays pure ordered-KV and unchanged. The catalog is just additional KV entries written by the lenses under a reserved key prefix. Honesty discipline: do not grow `core.ts` for this.
- **Reserved prefix.** Catalog entries live under a reserved namespace (e.g. a low-byte prefix like `\x00libredb:catalog:`, sorting before user data). User collection/table names starting with the reserved marker are rejected — a correctness rule, like the prefix-soundness rule already enforced.
- **What is recorded** = a registry mapping each user namespace to `{ kind: "kv" | "document" | "relational", schema?: TableSchema }`:
  - `table(db, name, schema)` records `{ kind: "relational", schema }` on creation — the relational schema is the valuable, otherwise-unrecoverable information.
  - `doc(db, name)` records `{ kind: "document" }` on first write (documents are schemaless; only kind/existence is recorded).
  - `kv` namespaces are NOT cataloged — kv is the raw layer.
- **Validate-on-reopen.** Opening `table(db, name, schema)` against a name already in the catalog validates the passed schema equals the persisted one; a mismatch is a loud error. No schema migration in v1.
- **A read API for tools:** `catalog(db)` returns the registry so Studio (and any tool) can enumerate tables/collections with their kinds and schemas.
- **Honest deferrals:** schema migration/evolution, a secondary-index catalog, a constraints catalog, per-collection statistics.

**Scope-creep guard.** A catalog is the doorway to "real DBMS" features (system tables, DDL, migrations). Keep v1 to the minimum that unblocks faithful tooling views — registry + validate-on-reopen — and resist the rest. If it cannot stay a thin reserved-prefix convention over the unchanged kernel, it does not belong in v1.

## 6.4 Deterministic simulation testing (DST) — v1 locked design (ratified 2026-06-24)

The real reliability bar (DESIGN principle 4). The first lens shipped on standard TDD + 100% coverage; DST is the next layer, scoped to **crash/recovery torture** of the WAL — the trust-critical durability path.

**Key simplification:** the kernel is synchronous and single-threaded, so there is NO concurrency/scheduler to simulate (unlike FoundationDB). DST here is **storage-fault simulation**, not interleaving simulation.

**Locked design:**

- **Scope = crash/recovery torture only** (ratified). Property-based lens testing and a full FoundationDB-style scheduler sim are out of scope (the latter is N/A for a single-threaded sync engine).
- **Injectable FS seam in the kernel (the one guarded-core change).** `open()` gains an optional filesystem dependency — `open({ path, fs? })` — where `fs` is a small interface covering exactly what the WAL uses (append, read, fsync, truncate, size, open/close). The default is a thin real-`node:fs` adapter, so production behaviour is unchanged. Honesty discipline: keep the seam small and readable; it makes the IO boundary explicit (a readability gain) and also opens the door to alternative backends later. `core.ts` may grow modestly (~481 -> ~520) — legitimate functionality, not hidden complexity.
- **SimFS** (in the test/sim harness, not shipped): a seeded, in-memory filesystem that records writes and can simulate a crash by keeping only the bytes durably present — fsync'd data always survives; the tail of the last un-fsync'd append is truncated at a seeded point (a torn record). Also injects CRC corruption / short reads on demand.
- **Workload + oracle:** a seeded PRNG drives a random sequence of `put`/`set`/`delete`/`transact` across keys; a model (committed map, updated only on a successful commit) is the oracle.
- **The invariant (what every seed asserts):** after crash + reopen, the recovered committed state EQUALS the model's committed state — it includes every transaction that returned successfully (was fsync'd) and NEVER a torn or un-committed one. A corrupt/torn tail is dropped, never surfaced as committed.
- **Determinism + replay:** everything is seed-driven; on failure the seed is logged and a replay entry point reruns that seed byte-for-byte. The suite runs a bounded number of seeds in `bun run test` (CI), with a longer soak mode available.
- **Lives in a `test/`/`sim/` harness** — it does not ship and does not count against the core LOC budget; only the FS seam is in `core.ts`.
- **Honest deferrals:** directory-fsync / power-loss-of-directory-entry modelling, multi-file scenarios, performance/throughput simulation.

## 7. Open questions

- **Line-count target. (RESOLVED 2026-06-24 — all three lenses complete.)** With the `kv.ts` scope now
  drafted and shipped, the §3 targets stand and are validated against real code: `core.ts` is 481 lines
  (ordered-KV kernel + transactions + WAL crash recovery), comfortably under the ~1,000-line starting
  target and far under the ~10,000-line ceiling. Comprehension time, not line count, remains the governing
  metric. The "lenses land on top of (not inside) the core" bet is VERIFIED, not predicted: the
  document (229 lines) and relational (339 lines) lenses, and the entire catalog (`lens/catalog.ts`,
  194 lines), all landed ON TOP of the kernel. `core.ts` grew only once — the S1 injectable-FS seam for
  DST (see §6.4) took it from 481 to 548 lines (+67, against an estimated ~520), the one guarded-core
  change the DST work sanctioned; it is still far under the ~1,000-line starting target. The DST harness
  (`src/sim/`, 675 lines) is test-only and never ships, so it does not count against the budget. The
  budget held with headroom.
- **Reliability tooling. (RESOLVED 2026-06-24 — DST built and green.)** The open question "how is
  deterministic simulation testing actually implemented in a TS project" is now answered by shipped,
  green code, exactly per the §6.4 locked design: an injectable FS seam in `core.ts` (S1), a seeded
  crash-injecting in-memory `SimFS` (S2), a seeded workload generator + an independent committed-map model
  oracle (S3), and a crash/recovery torture runner asserting THE INVARIANT — recovered state is always a
  valid committed prefix, never a torn or un-committed transaction (S4). Every run is seed-driven and
  replayable (`runSeed(seed)`); `bun run test` runs a bounded 50 seeds, with a longer soak available (see
  README "Reliability"). The harness lives in `src/sim/` and is excluded from the npm build. This is the
  DST layer §6.4 and DESIGN principle 4 promised, no longer hand-waved.
- **Production arc.** Still open. Define the concrete bar that moves LibreDB from "test/dev" to "earns
  production." The deterministic-simulation-testing dependency is now DISCHARGED (resolved above); what
  remains is a hardening checklist (e.g. directory fsync on first file creation, WAL
  compaction/checkpointing — both known limitations, and DST's own short-read
  recovery note from S4), all of which are tracked-later tasks.

## 8. Lineage of the idea

The founding analysis drew on three references:
- **SQLite** — power through omission; reliability through obsessive testing; "competes with `fopen()`, not Oracle."
- **smolagents** — readability as a feature; a core small enough to read in an afternoon.
- **Nothing** — the lesson taken is sequencing, not branding: build community on a lower-risk product first (Studio), then move to the hard product (Database).
