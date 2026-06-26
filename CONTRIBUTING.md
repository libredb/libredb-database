# Contributing to LibreDB

Thank you for considering a contribution. LibreDB is a small, readable, embeddable database, and the
whole point is that you can open the source, understand it, and improve it. This guide explains how to
get set up, what the bar for a change is, and how the trust model shapes where contributions land
fastest.

Please also read [`MANIFESTO.md`](./MANIFESTO.md) and [`docs/DESIGN.md`](./docs/DESIGN.md) — they
explain what LibreDB is, what it deliberately refuses to be, and which decisions are locked.

## Code of conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md). By participating, you agree to
uphold it.

## Trust model: where contributions land fastest

LibreDB is **open at the edges, guarded at the core**. The file boundary is the trust boundary:

- **The edges** — lenses (`src/lens/`), the query surface (`src/query/`), adapters (`src/adapter/`),
  tooling, and docs — are open to fast contribution. Bring a test and a clear rationale and it moves
  quickly.
- **The durability core** (`src/core.ts`) — storage, transactions, recovery — is open for everyone to
  read, but every line written into it passes heavy review and deterministic testing. Changes here are
  slower by design, because the core holds your data. Expect deeper review, and expect to back the
  change with the deterministic simulation suite (`src/sim/`).

If you are new, the edges are the best place to start.

## Getting set up

LibreDB uses [Bun](https://bun.com) as its runtime, package manager, and test runner. The version is
pinned in `.bun-version`.

```sh
bun install
bun run gate
```

`bun run gate` is the single command that must pass before anything is merged. It runs, in order:

```
typecheck -> format -> lint -> knip -> build -> size -> test
```

- **typecheck** — `tsc --noEmit`.
- **format** — Biome (formatter only). Run `bun run format:fix` to apply.
- **lint** — Oxlint plus a narrow type-aware typescript-eslint pass.
- **knip** — no unused files, exports, or dependencies.
- **build** — `tsc` emits `dist/` with isolated declarations.
- **size** — a byte budget on the shipped entry (`.size-limit.json`); a heavy or non-tree-shakeable
  import fails it.
- **test** — `bun test --coverage`. Coverage is held at **100%** line/function/statement
  (`bunfig.toml`); a change that drops coverage fails the gate.

## The bar for a change

- **Tests are the truth.** Every change is backed by tests. No stubs, no placeholder assertions, no
  "TODO: test later". A feature without tests is not done.
- **Readability is a design constraint.** We open code up to make it clear; we do not compress it to
  look clever. `core.ts` stays small because it is genuinely minimal — never because complexity was
  pushed elsewhere. The metric is comprehension time, not line count.
- **Nothing hidden.** Errors surface; they are not swallowed. The query, the schema, and the plan are
  visible.

## Commits and pull requests

- **Conventional Commits** are enforced locally by a `commit-msg` git hook (commitlint). Examples:
  `feat(lens): add prefix scan to the kv lens`, `fix(core): fsync the directory on first file create`,
  `docs: clarify the recovery invariant`.
- **English only**, and **no emoji** anywhere — code, comments, commits, docs.
- PRs are **squash-merged**: the individual commit messages are discarded and the PR title becomes the
  single commit (and the changelog entry), so keep the **PR title** conventional and descriptive.
- If your change is user-facing, add a changeset: `bun run changeset`. This is what generates the
  changelog and version bump at release time.
- The CI gate mirrors `bun run gate` and runs on every PR, including forks.

## Reporting bugs and proposing features

Use the issue templates. For bugs, a minimal reproduction is worth more than anything else. For
security vulnerabilities, do **not** open a public issue — see [`SECURITY.md`](./SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](./LICENSE)
that covers this project.
