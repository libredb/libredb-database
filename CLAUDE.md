# CLAUDE.md

Guidance for Claude Code (and any contributor) working in the **LibreDB** database repository.

## What LibreDB is

LibreDB is a small, readable, embeddable, multi-model database. The bet: a database can be powerful
and still be understood by opening its source. The full vision is in [`MANIFESTO.md`](./MANIFESTO.md);
the locked engineering decisions behind it are in [`docs/DESIGN.md`](./docs/DESIGN.md).

- **Architecture (FoundationDB-style):** one small ordered key-value core (`src/core.ts`) plus thin
  model *lenses* on top of it — not three separate engines. Lens order: **kv (proof) -> document
  (differentiator) -> relational (reach)**.
- **Language / dist:** TypeScript, shipped on npm as `@libredb/libredb`.
- **Trust model:** open at the edges (drivers, lenses, tooling — fast contribution), guarded at the
  durability core (`src/core.ts`: heavy review + deterministic tests). The file boundary IS the trust
  boundary.
- **Honesty discipline:** `core.ts` stays small because it is genuinely minimal — never because
  complexity was swept into other files. The metric is comprehension time, not line count. No
  code-golf.

## Where to read first

1. [`MANIFESTO.md`](./MANIFESTO.md) — what LibreDB is and refuses to be.
2. [`docs/DESIGN.md`](./docs/DESIGN.md) — the locked engineering decisions.
3. [`ARCHITECTURE.md`](./ARCHITECTURE.md) — a guided tour of the structure, the algorithms, and the
   reasoning under the hood.
4. [`docs/TOOLCHAIN.md`](./docs/TOOLCHAIN.md) — the per-tool decisions behind the build/lint/test gate.

The authoritative state of the project is always the **code, the tests, and git history** — not any
document's prose. If a document ever disagrees with the code, the code wins; fix the document.

Do not re-litigate decisions already settled in `docs/DESIGN.md`. If you believe one is wrong, say so
explicitly and explain why — do not silently reopen it.

## The gate

Everything is enforced by one command:

```
bun run gate
```

It runs `typecheck -> format -> lint -> knip -> build -> size -> test` (in that order; `build` must
precede `size` because `size` reads `dist/`). Coverage is held at 100% line/function/statement by
`bunfig.toml`, so a change that drops coverage fails the gate. Nothing is "done" until the gate is
green. Tests are the truth: no stubs, no hidden complexity, no commented-out assertions.

## Conventions

The maintainer's working rules. They always apply.

- **English only** for all repo / public artifacts (code, comments, commits, docs). Chat may be in
  Turkish — the maintainer (cevheri) is Turkish; match their language in conversation, but write
  English in the repo.
- **No emoji** anywhere — code, comments, commits, docs. Plain text.
- **Conventional commits**, enforced by commitlint (`commit-msg` hook). PRs are squash-merged, so the
  PR title becomes the changelog entry — keep it conventional.
- **No `Co-Authored-By` / AI-attribution trailer** in commit messages unless explicitly asked.
- **Commit only when asked**, and never add a git remote or push unless asked.
- This is a separate repo from `../libredb-studio` and `../libredb-platform`. Never mix commits across
  them.

## Family context

LibreDB is the database in a three-product family sharing one access-model spine:

- **LibreDB** (this repo) — the database.
- **LibreDB Studio** (`../libredb-studio`) — the open-source universal IDE for every database; LibreDB
  is one it supports, not a requirement. Keep it positioned as universal, never as "LibreDB's UI".
- **LibreDB Platform** (`../libredb-platform`) — the managed, team-oriented, paid product (closed
  source).
