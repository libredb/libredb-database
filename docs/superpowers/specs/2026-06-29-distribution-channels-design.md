# Distribution Channels — Research and Design

Design and research document for [issue #6](https://github.com/libredb/libredb-database/issues/6):
*Explore additional packaging/distribution channels (JSR, CDN/browser, CLI, standalone binary, Docker).*

Status: design approved (2026-06-29). Implementation deferred to per-phase specs.
This document is the research that the issue mandated before development begins.

## 1. Scope and intent

LibreDB ships today through a single channel: the npm package `@libredb/libredb`
(ESM-only, Node 22+/Bun, zero runtime dependencies, public surface is the lens API).
This document evaluates five additional channels and lays out a phased roadmap.

It is one research/design document covering all five channels — not five
implementation specs. Each channel is decomposed into its own phase; when a phase
is greenlit it gets its own spec, plan, and implementation cycle.

**Non-goal (carried from the issue and the manifesto):** no networked
client/server engine. LibreDB is an embedded, in-process library (SQLite-style),
not a server/daemon (Postgres-style). Every channel below preserves that posture —
the CLI, binary, and Docker image are all *embedded tooling shells*, never a
listening service.

## 2. Current state (verified against code)

These facts shape every decision and were verified against the source, not memory.

- **Public API.** `open({ path?, fs? }) -> Database`; lenses `kv`, `doc`, `table`,
  and the `catalog` registry sit on top (`src/index.ts`). Synchronous throughout
  (`transact`, `fsyncSync`). Sync core is a ratified DESIGN decision; an async
  face may be layered later as an adapter over the sync core.
- **node:fs coupling.** `core.ts` statically imports `node:fs` at module top
  (`import { ... } from "node:fs"`). The `FileSystem` seam already exists and the
  default `nodeFileSystem()` is only used when a `path` is given — but the static
  import means importing the package at all drags `node:fs` into the import graph,
  breaking browser use even for in-memory (`path`-less) databases. This is the
  single linchpin blocking the browser channel.
- **File format.** A `.libredb` file IS the write-ahead log; there is no separate
  data file. Record framing: `[u32 payloadLength][u32 crc32(payload)][payload]`,
  where payload is a sequence of ops (`[1 byte kind][u32 keyLen][key]`, and for a
  set `+[u32 valueLen][value]`). Recovery replays records, stops at the first
  incomplete/bad-CRC record, and truncates the torn tail. The whole file is read
  into memory on open (`readFileSync`).
- **Catalog.** `catalog(store)` returns a registry keyed by namespace with each
  namespace's kind (`kv`/`document`/`relational`) and, for a table, its schema.
  Reserved prefix `\x00libredb:catalog:`. This is what lets a tool render faithful
  per-kind views from a cold file.
- **Build / JSR readiness.** Source uses honest `.ts` import specifiers
  (`./core.ts`); the build rewrites them to `.js` via
  `rewriteRelativeImportExtensions`. `isolatedDeclarations: true` is on. This is
  ideal for JSR, which prefers explicit `.ts` specifiers and rewards explicit
  types (its "slow types" check passes cleanly).
- **Constraints.** 100% line/function/statement coverage held by the gate;
  changesets for user-facing changes; conventional commits; English-only; no emoji;
  zero runtime dependencies.

## 3. Central architectural decision: decouple node:fs

The browser channel and a genuinely runtime-agnostic core both depend on one
refactor, so it is decided up front and pulled to Phase 0.

**Chosen approach (A): split the adapter out of the core and add conditional
exports.**

- Move `nodeFileSystem()` from `core.ts` to `src/adapter/node-fs.ts`. After this,
  `core.ts` has zero `node:` imports — a genuinely runtime-agnostic kernel.
- `core.ts`'s `open` no longer imports a default filesystem. If a `path` is given
  without an `fs`, it throws a clear error ("no filesystem provided for path").
- Two entry points:
  - `src/index.ts` (default, Node): re-exports an `open` pre-bound with
    `nodeFileSystem()` as the default `fs`, so the Node experience is unchanged
    and backward compatible.
  - `src/browser.ts` (new): exposes the core `open` as-is. In-memory works
    out of the box; a `path` requires an injected `fs` (e.g. a future OPFS
    adapter).
- `package.json` `exports` gains `browser`/`import` conditions and a `./browser`
  subpath. `node:fs` leaves the browser import graph entirely.

Rejected alternatives: **(B) dynamic `await import("node:fs")`** breaks the
ratified synchronous contract; **(C) rely on bundler aliasing** is fragile,
depends on the consumer's build, and is not true browser support.

This change touches the public API (additive: a new subpath, an unchanged Node
default), so it carries a **minor** changeset. The honesty discipline holds: the
core gets smaller and purer, not more complex.

## 4. Per-channel design

### Channel 1 — JSR (`jsr.io`)

- **Effort:** low. **Risk:** low. **Value:** high.
- Add `jsr.json` (`name: "@libredb/libredb"`, `exports` mapping `.` to
  `./src/index.ts` and `./browser` to `./src/browser.ts`). JSR publishes from
  source and runs its own transpile/type generation.
- Version stays single-sourced from `package.json`: extend `scripts/sync-version.ts`
  to also write `jsr.json`, backstopped by a test as today.
- CI: add `npx jsr publish` to the publish workflow (OIDC, token-less), running in
  parallel with the npm publish on the same tag.
- Watch item: `node:` built-in imports can be flagged by JSR — already mitigated
  because, after Phase 0, only `adapter/node-fs.ts` imports `node:`.

### Channel 2 — CDN / browser

- **Effort:** low (docs) + the Phase 0 entry. **Risk:** low. **Value:** high.
- esm.sh / jsdelivr / unpkg already serve the npm package. Document a pinned-version
  browser import example (`import { open, kv } from "https://esm.sh/@libredb/libredb"`).
- True browser support is the `src/browser.ts` entry from Phase 0: in-memory fully
  works; `path` errors clearly.
- CI proof: a test asserting the browser entry's import graph contains no `node:`
  specifier, so the boundary cannot silently regress.
- **Persistence (future, Phase 5 — not in this round):** wire an OPFS adapter into
  the existing `FileSystem` seam. OPFS sync access handles (available inside a Web
  Worker) preserve the core's synchronous contract and are the recommended path.
  IndexedDB is async and would require the DESIGN-anticipated async-face adapter.
  The doc recommends OPFS-in-Worker; the final call is deferred to the Phase 5 spec.

### Channel 3 — CLI (`npx libredb`) — read + write

- **Effort:** high. **Risk:** medium-high. **Value:** high.
- New `src/cli/` entry, a thin wrapper over the public API. Zero dependencies via
  `node:util` `parseArgs`. `package.json` `bin: { "libredb": "./dist/cli/main.js" }`.
- Commands:
  - Read: `inspect` (catalog summary grouped by kind), `get <key>`, `scan <prefix>`,
    `stats` (record count, file size, per-namespace breakdown), `repl` (read).
  - Write: `set`, `delete`, `import`.
- **Data-safety design (DBA-critical):**
  - LibreDB is single-process with no file locking. Two concurrent writers corrupt
    the file. Write commands acquire an advisory lock (`.libredb.lock`); if held,
    they refuse unless `--force`.
  - `open()` truncates a torn tail during recovery, so even a read-intent command
    can mutate the file. Read commands therefore use a read-only `FileSystem`
    adapter that opens `O_RDONLY` and turns `truncate` into a no-op plus a warning.
    This is the default for `inspect`/`get`/`scan`/`stats`.
  - `import` and bulk writes commit in a single atomic transaction; a crash mid-way
    is rolled back by recovery.
- Size/packaging: the CLI bin is separate from the 4 kB library budget, but
  `dist/cli` must be included in knip/publint checks and given its own size guard.

### Channel 4 — standalone binary

- **Effort:** medium. **Risk:** low-medium. **Value:** medium.
- `bun build --compile` packages the CLI into a single self-contained executable
  (embeds the Bun runtime, ~50-90 MB). Cross-compile targets: `linux-x64`,
  `linux-arm64`, `darwin-x64`, `darwin-arm64`, `windows-x64`.
- DevOps: a CI matrix builds per target on tag and attaches artifacts to the
  GitHub Release with a `SHA256SUMS` file. SLSA provenance / cosign signing is a
  later enhancement. Not published to npm or JSR.
- The binary embeds Bun, not Node; the `node:fs` adapter runs unchanged on Bun.

### Channel 5 — Docker

- **Effort:** low. **Risk:** low. **Value:** medium.
- A minimal image wrapping the static binary (distroless or `scratch` + a static
  linux binary). Volume-mount `.libredb` files. It is a CLI shell, not a server —
  honoring the non-goal.
- DevOps: `docker buildx` multi-arch (amd64/arm64), published to GHCR
  (`ghcr.io/libredb/libredb`), tagged with the version and `latest`.
- Usage: `docker run -v $PWD:/data ghcr.io/libredb/libredb inspect /data/app.libredb`.

## 5. Dependency order and phased roadmap

The real dependency chain differs from the issue's suggested order: Phase 0 (the
node:fs refactor) is the linchpin, and the CLI is a prerequisite for the binary
and Docker.

```
Phase 0: node:fs decoupling (browser.ts + exports)   <- foundation of everything
   |
   +- Phase 1: JSR + CDN docs            (depends on 0; fastest value)
   |
   +- Phase 2: CLI (read+write)          (depends on 0; independent of browser)
          |
          +- Phase 3: standalone binary  (depends on CLI)
          |     |
          |     +- Phase 4: Docker       (depends on binary)
          |
          +- Phase 5: browser persistence (OPFS)  (depends on 0+1; optional, last)
```

| Phase | Work | Why here | Changeset |
|-------|------|----------|-----------|
| 0 | Decouple `node:fs` -> `adapter/node-fs.ts`; add `src/browser.ts` + `exports` conditions | Linchpin: browser, JSR-cleanliness, and a testable pure core all depend on it | Yes (minor — additive subpath, backward-compatible) |
| 1 | JSR publish + CDN/browser docs | Lowest effort, fastest reach; free once Phase 0 lands | Browser entry shipping: yes; docs-only: no |
| 2 | CLI (read-only adapter for reads + advisory lock for writes) | Prerequisite for CI automation and the binary | Yes (ships a `bin`) |
| 3 | `bun build --compile` cross-compile + GitHub Release matrix | Meaningless without the CLI | No (not in the npm package) |
| 4 | Multi-arch Docker -> GHCR | Wraps the binary | No |
| 5 | OPFS persistence adapter (browser) | Highest architectural risk; after value is proven | Yes (minor) |

## 6. Risk / effort / value matrix

| Phase | Effort | Risk | Value | Primary risk item |
|-------|--------|------|-------|-------------------|
| 0 node:fs decouple | Medium | Medium | High | Backward compatibility — Node `open({path})` must behave identically; 100% coverage across two entry points |
| 1 JSR + CDN | Low | Low | High | JSR slow-types / built-in import warnings (likely none); CDN version-pinning hygiene |
| 2 CLI | High | Medium-High | High | Advisory-lock races; read-only recovery suppression; `parseArgs` UX; 100% coverage |
| 3 binary | Medium | Low-Medium | Medium | Cross-compile matrix fragility; ~50-90 MB size expectations; signing/provenance |
| 4 Docker | Low | Low | Medium | Multi-arch buildx; GHCR permissions; preserving "not a server" positioning |
| 5 OPFS persistence | High | High | Medium | Sync access handles are Worker-only; sync contract vs IndexedDB async; browser matrix |

**Three points needing the most care:**

1. **Phase 2 — CLI data safety.** The single-writer rule, advisory lock, and
   read-only recovery suppression. Done wrong, the CLI can corrupt a live
   `.libredb`. The highest "do no harm" risk in the project.
2. **Phase 0 — 100% coverage across two entry points.** The gate holds coverage at
   100%; the node-free browser path and the "path but no fs" error branch must be
   fully tested.
3. **Phase 5 — sync/async impedance mismatch.** OPFS-in-Worker vs an async-face
   adapter. The doc recommends OPFS-in-Worker and leaves the final decision to the
   Phase 5 spec.

## 7. Execution model (autonomous loop)

Implementation will run as a six-phase autonomous development loop:

1. Implement one phase's first step.
2. Wait for GitHub Actions; resolve every problem until all checks are green.
3. Only then advance to the next step/phase.
4. As a software architect, make decisions on ambiguous points and proceed.
5. When everything is complete, do not merge the PR — stop for final human review.
