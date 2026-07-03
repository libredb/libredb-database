# Code Metrics

Real numbers for LibreDB's **production source code**, so you can judge the
"small enough to read in one sitting" claim against the actual code, not a slogan.

Excluded: all `*.test.ts` files, documentation (`*.md`), configuration
(`package.json`, `tsconfig.json`, etc.), `node_modules/`, and `dist/`.

For each file:
- **Total** — raw line count (`wc -l`).
- **Code** — non-blank, non-comment lines, via the reproducible heuristic in
  the Notes. Close to exact, not a line-by-line guarantee.

## Shipped engine

The code that ships in the published package: the durability core, the thin
model lenses on top of it, the file-system adapters, the browser entry, and the CLI.

| File | Responsibility | Total | Code |
|---|---|---:|---:|
| `src/core.ts` | Durability core (ordered KV, transactions, WAL/recovery, on-disk format) | 950 | 449 |
| `src/lens/relational.ts` | Relational lens (CRUD, query, joins) | 369 | 160 |
| `src/cli/run.ts` | CLI command implementations | 317 | 245 |
| `src/lens/document.ts` | Document lens | 311 | 137 |
| `src/adapter/node-fs.ts` | Node/Bun file-system adapter (fd reads, fsync, lock) | 302 | 184 |
| `src/lens/catalog.ts` | Catalog / reserved-namespace contract | 286 | 115 |
| `src/lens/kv.ts` | KV lens (the proof layer) | 133 | 65 |
| `src/adapter/opfs.ts` | Browser OPFS adapter | 96 | 45 |
| `src/query/range.ts` | Range-query helpers | 70 | 19 |
| `src/lens/types.ts` | Shared types | 69 | 16 |
| `src/browser.ts` | Browser entry / export surface | 61 | 19 |
| `src/index.ts` | Public entry / export surface | 51 | 19 |
| `src/cli/readonly-fs.ts` | Read-only file system for CLI reads | 47 | 27 |
| `src/adapter/store.ts` | FS/store adapter interface | 32 | 4 |
| `src/cli/main.ts` | CLI entry point | 16 | 6 |
| **Subtotal** | | **3110** | **1510** |

## Simulation / test-running harness (DST)

Not `*.test.ts` files, but deterministic-simulation infrastructure that does not
ship in the product. Kept separate from the shipped engine.

| File | Responsibility | Total | Code |
|---|---|---:|---:|
| `src/sim/simfs.ts` | Simulated file system (fault injection, crash, corruption) | 174 | 97 |
| `src/sim/workload.ts` | Workload generator | 159 | 88 |
| `src/sim/dst.ts` | Crash/recovery oracle runner | 157 | 69 |
| `src/sim/prng.ts` | Deterministic PRNG | 24 | 9 |
| **Subtotal** | | **514** | **263** |

## Grand total

| Category | Total | Code |
|---|---:|---:|
| Shipped engine | 3110 | 1510 |
| Simulation harness | 514 | 263 |
| **All production source** | **3624** | **1773** |

## Shipped size

The source is small to *read*; the published artifact is small to *install and
embed*. Same proof, different axis. (Measured at the version in `package.json`.)

| What | Size | Meaning |
|---|---:|---|
| Public entry, bundled | **5.08 kB** | What a consumer's app pays after their bundler tree-shakes, minifies, and brotli-compresses `import ... from "@libredb/libredb"`. Node built-ins (`node:fs`) are runtime-provided, not counted. |
| npm tarball | ~53 kB | The download (`bun pm pack`): 33 files including `.js`, `.d.ts` types, README, and LICENSE. |
| Unpacked `dist/` | ~157 kB | On disk after install — readable (unminified) JS plus full type declarations. |

The bundled figure is **machine-enforced**: `size-limit` holds the public entry
under a **6 kB** budget (and the browser entry under **5 kB**) as part of
`bun run gate`, so an accidental heavy dependency or a non-tree-shakeable
import fails the build. Raising the budget has to be a conscious edit — the
byte-level analog of the core line-count discipline.

## Notes

- The entire durability core lives in a single file (`src/core.ts`, 449 lines of
  code), with everything else being thin lenses, adapters, and tooling layered
  on top — consistent with the FoundationDB-style architecture described in
  `DESIGN.md`.
- **Code heuristic (reproducible).** The Code column is produced by:
  `grep -cvE '^\s*($|//|/\*|\*/?\s*$|\*\s)' <file>` — it strips blank lines, `//`
  line comments, `/*` and `*/` block delimiters, and ` * ` JSDoc continuation
  lines. It is close to exact but not a per-line guarantee.
- **Methodology note (2026-06-26).** These figures were recomputed after the
  `lineWidth: 120` formatter rollout and with the heuristic above, which excludes
  JSDoc body lines from Code. Earlier revisions counted some comment lines as
  code, so the Code figures here are lower than before **without any code having
  been removed** — the difference is a tighter, now-reproducible heuristic.
