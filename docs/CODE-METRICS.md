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

The code that ships in the published package: the durability core plus the thin
model lenses on top of it.

| File | Responsibility | Total | Code |
|---|---|---:|---:|
| `src/core.ts` | Durability core (ordered KV, transactions, WAL/recovery) | 548 | 273 |
| `src/lens/relational.ts` | Relational lens (CRUD, query, joins) | 361 | 159 |
| `src/lens/document.ts` | Document lens | 235 | 99 |
| `src/lens/catalog.ts` | Catalog / reserved-namespace contract | 210 | 70 |
| `src/lens/kv.ts` | KV lens (the proof layer) | 124 | 61 |
| `src/query/range.ts` | Range-query helpers | 70 | 19 |
| `src/lens/types.ts` | Shared types | 69 | 16 |
| `src/adapter/store.ts` | FS/store adapter interface | 32 | 4 |
| `src/index.ts` | Public entry / export surface | 28 | 11 |
| **Subtotal** | | **1677** | **712** |

## Simulation / test-running harness (DST)

Not `*.test.ts` files, but deterministic-simulation infrastructure that does not
ship in the product. Kept separate from the shipped engine.

| File | Responsibility | Total | Code |
|---|---|---:|---:|
| `src/sim/workload.ts` | Workload generator | 159 | 88 |
| `src/sim/dst.ts` | Crash/recovery oracle runner | 156 | 69 |
| `src/sim/simfs.ts` | Simulated file system | 142 | 79 |
| `src/sim/prng.ts` | Deterministic PRNG | 24 | 9 |
| **Subtotal** | | **481** | **245** |

## Grand total

| Category | Total | Code |
|---|---:|---:|
| Shipped engine | 1677 | 712 |
| Simulation harness | 481 | 245 |
| **All production source** | **2158** | **957** |

## Shipped size

The source is small to *read*; the published artifact is small to *install and
embed*. Same proof, different axis. (Measured at the version in `package.json`.)

| What | Size | Meaning |
|---|---:|---|
| Public entry, bundled | **2.83 kB** | What a consumer's app pays after their bundler tree-shakes, minifies, and brotli-compresses `import ... from "@libredb/libredb"`. Node built-ins (`node:fs`) are runtime-provided, not counted. |
| npm tarball | ~29 kB | The download (`bun pm pack`): 21 files including `.js`, `.d.ts` types, README, and LICENSE. |
| Unpacked `dist/` | ~136 kB | On disk after install — readable (unminified) JS plus full type declarations. |

The bundled figure is **machine-enforced**: `size-limit` holds the public entry
under a **4 kB** budget as part of `bun run gate`, so an accidental heavy
dependency or a non-tree-shakeable import fails the build. Raising the budget has
to be a conscious edit — the byte-level analog of the core line-count discipline.

## Notes

- The entire durability core lives in a single file (`src/core.ts`, 273 lines of
  code), with everything else being thin lenses layered on top — consistent with
  the FoundationDB-style architecture described in `DESIGN.md`.
- **Code heuristic (reproducible).** The Code column is produced by:
  `grep -cvE '^\s*($|//|/\*|\*/?\s*$|\*\s)' <file>` — it strips blank lines, `//`
  line comments, `/*` and `*/` block delimiters, and ` * ` JSDoc continuation
  lines. It is close to exact but not a per-line guarantee.
- **Methodology note (2026-06-26).** These figures were recomputed after the
  `lineWidth: 120` formatter rollout and with the heuristic above, which excludes
  JSDoc body lines from Code. Earlier revisions counted some comment lines as
  code, so the Code figures here are lower than before **without any code having
  been removed** — the difference is a tighter, now-reproducible heuristic.
