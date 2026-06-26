# LibreDB Toolchain - 2026 Decision Record

> Status: implemented (local phases done and committed; the committed CI workflows activate automatically
> once the repo is on GitHub). Captures the per-tool decisions from a researched-then-adversarially-verified evaluation of
> 2026 gold-standard OSS-TypeScript tooling, judged against LibreDB's manifesto and `DESIGN.md`. Every
> adopted tool plugs into `bun run gate` or a documented CI phase.

## How this was decided

Each tool category was researched for the mid-2026 gold standard, then a second pass adversarially
verified the recommendation (do the versions exist, is the config valid for Bun + ESM + TS6, does it
conflict with the existing eslint/typescript-eslint/knip/tsc setup). The verification pass caught real
errors in the first-pass research; the corrections are baked into the configs below. Nothing here is
"green" until it passes the gate during implementation - tests are truth.

## Fit rubric (from MANIFESTO.md + DESIGN.md)

1. Serves reliability or honesty (every line tested, nothing hidden).
2. Minimal dependency / maintenance surface; dev-only preferred; never bloats the shipped package or the readable core. (Tooling does not count against the LOC budget - DESIGN section 3.)
3. Bun-native or Bun-compatible. `bun test` is the locked test runner (DESIGN section 6.4).
4. Minimal ceremony at the contribution edges.
5. Machine-enforced by the gate or CI, not a slogan.
6. English-only, no emoji (including commit/changelog configs - no gitmoji).

## Decision summary

| Category | Decision | Package(s) | One-line reason |
|----------|----------|-----------|-----------------|
| Formatter | ADOPT | `@biomejs/biome` (format-only) | Repo has no formatter today - the one unambiguous gap |
| Linter (syntactic) | ADOPT | `oxlint` | Fast Rust linter, more correctness rules; sub-second |
| Linter (type-aware) | KEEP (narrow) | `typescript-eslint` + `eslint` | Real TS-checker safety net for the durability core |
| Linter (replacement) | REJECT | ~~`biome`~~ | Re-implemented inference with drift risk vs the real TS checker |
| Unused code/deps | KEEP | `knip` | Already wired into the gate |
| Type-resolution check | ADOPT | `@arethetypeswrong/cli` | Validates shipped `.d.ts` resolve across module modes |
| Package correctness | ADOPT | `publint` | Validates the published `exports`/`types` are consistent |
| Bundle size budget | ADOPT | `size-limit` + `@size-limit/preset-small-lib` | Byte budget = runtime analog of the LOC discipline |
| Build | KEEP + extend | `tsc` + `isolatedDeclarations` | No bundler needed; fast, honest `.d.ts` emit |
| Test runner | KEEP | `bun test` | Locked; Bun-native; DST harness depends on it |
| Git hooks | ADOPT (zero-dep) | `.githooks/` + `core.hooksPath` | No dependency, no Bun postinstall footgun |
| Commit quality | ADOPT | `@commitlint/cli` + `@commitlint/config-conventional` | Conventional commits feed the changelog; cz-git rejected |
| Release | ADOPT | `@changesets/cli` | Human-curated changelog; local now, CI later |
| License hygiene | ADOPT | `license-checker-rseidelsohn` | Dev-only allowlist; fails on non-permissive deps |
| Security (local) | ADOPT | `bun audit` + `secretlint` | Dependency audit + secret scan at the edge (npm-native) |
| Security (CI) | DEFER-TO-CI | CodeQL, Scorecard, provenance, osv-scanner, dependency-review | Need GitHub Actions |
| Dependency updates | DEFER-TO-CI | Renovate (or Dependabot) | Need GitHub; `bun outdated` is the manual local stand-in |
| Code quality (CI) | DEFER-TO-CI (prepared) | SonarCloud | Cloud SAST + coverage; workflow committed, inert until SONAR_TOKEN |
| CI gate | DEFER-TO-CI (prepared) | GitHub Actions | Mirrors `bun run gate`; workflow committed, activates on push |

## Cross-cutting integration realities (verifier-surfaced)

These bite more than one tool and must be handled during implementation:

- **knip vs script-only tools.** knip fails the gate on tools it cannot see used: anything invoked only
  from a shell git-hook (commitlint) or whose binary name differs from its package name (`attw` for
  `@arethetypeswrong/cli`) gets flagged as an unused dependency or an unlisted binary. Fix per tool:
  give it a real `package.json` script and/or add a justified `ignoreDependencies` / `ignoreBinaries`
  entry to `knip.json`. Verified: without this, adding publint + attw makes `bun run knip` exit 1.
- **Gate ordering (done).** `size-limit` reads `dist/`, so `build` must run before `size`. The gate was
  reordered to `typecheck -> format -> lint -> knip -> build -> size -> test`.
- **Bun blocks postinstall by default.** This is why lefthook (downloads a Go binary via postinstall) is
  rejected in favor of the zero-dependency `.githooks` approach - no `trustedDependencies` dance, no
  silent "hooks never installed" footgun.
- **Removing `@eslint/js`.** Once ESLint is reduced to a type-aware-only config, `@eslint/js` is unused
  and knip will flag it - it must be removed from devDependencies.

## Adopt now (local)

### Linter + formatter stack

Recommended stack: **Biome** (formatter only, fills the gap) + **Oxlint** (primary syntactic linter) +
**typescript-eslint** kept as a narrow type-aware-only gate + **knip** (unchanged).

Formatter choice (re-decided): Biome formatter over Oxfmt. The formatter is pure developer experience -
it has no bearing on type-aware correctness or runtime reliability - so it is judged independently of
the oxc-based linter, on maturity, IDE support, deterministic output, and long-term maintenance. On all
four, Biome's formatter (production-ready since 2023, v2.5; first-party VS Code / JetBrains / Zed; frozen
opinionated output) beats Oxfmt (beta, Feb 2026; "the API may shift slightly, pin versions" - a churn
risk across upgrades). Oxfmt is faster and supports more languages, but for a database that values frozen
output and clean diffs, a mature formatter wins. Biome is configured formatter-only (`linter` and
`assist` disabled); all linting stays with Oxlint + typescript-eslint.

`lineWidth` is 120, not the Prettier/Biome default of 80. The 80 default is terminal-era inertia and,
for code (scanned, not read like prose - the 50-75 char "optimal" rule is a prose-typography finding),
it forces a single logical statement to fragment across lines, which the manifesto's "open code up
rather than compress it" stance argues against. Reformatting this repo from 80 to 120 was a net -245
lines: width-80 had over-wrapped signatures and calls that fit cleanly on one line at 120. 120 is the
JetBrains default and the modern wide-but-still-review-friendly choice (140 was rejected: it strains
side-by-side review and drifts furthest from the ~80-wrapped prose comments, which Biome does not reflow).

Why not Biome: Biome's type-aware rules use a re-implemented inference engine that its own authors say
"cannot guarantee full coverage or alignment with TS." For a project whose ethos is reliability +
honesty, type-aware checks on `core.ts` should use the genuine TypeScript checker. Why not
`oxlint --type-aware` yet: it wraps `tsgolint` (tsgo), which is still alpha in mid-2026. Revisit when it
stabilizes; at that point typescript-eslint can be retired and the stack collapses to one `oxlint` call.

LibreDB-specific note: the core is synchronous - verified zero `async`/`await`/`Promise`/`any` in
non-test `src/`. The flagship type-aware rules (promise misuse, no-unsafe-*) cannot fire today, so
keeping typescript-eslint is cheap insurance for the guarded core and against future async drift, not a
hot path. (This is the genuine sub-decision below: keep it, or drop ESLint entirely for now.)

`.oxlintrc.json`:
```json
{
  "$schema": "https://raw.githubusercontent.com/oxc-project/oxc/main/npm/oxlint/configuration_schema.json",
  "plugins": ["typescript", "oxc"],
  "categories": { "correctness": "error", "suspicious": "error", "perf": "warn", "pedantic": "off", "style": "off" },
  "rules": { "oxc/approx-constant": "off", "no-shadow": "off" },
  "ignorePatterns": ["dist/**", "coverage/**", "node_modules/**", ".remember/**"]
}
```

The `unicorn` plugin was dropped after the first run: it is noisy on this codebase (style opinions on
test helpers, `toSorted` over `sort`) and would force rewrites of tested code to satisfy taste, not
correctness. `no-shadow` is off because the lens factories are deliberately named `doc`/`kv`/`table`,
making those collide with the natural variable names for what they create - shadowing is idiomatic here,
not a bug, and correctness is guarded by tsc + tests. `oxc/approx-constant` is off because it
false-flags `3.14` used as plain test data as an approximation of `Math.PI`.

`eslint.config.js` (reduced to type-aware only; **corrected** to register the TS parser - the first-pass
config omitted it and would have failed to parse every `.ts` file):
```js
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "node_modules/**", ".remember/**", "eslint.config.js"] },
  {
    files: ["src/**/*.ts"],
    extends: [tseslint.configs.base], // registers tseslint.parser (the omitted piece)
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/no-unnecessary-condition": "warn",
      "@typescript-eslint/restrict-template-expressions": ["error", { "allowNumber": true }]
    },
  },
);
```

Scripts: `"format": "biome format src eslint.config.js"`, `"format:fix": "biome format --write src eslint.config.js"`, `"lint": "oxlint && eslint ."`. A `biome.json` enables the formatter only (`linter` and `assist` disabled).
Remove `@eslint/js` from devDependencies.

Packages: `oxlint@^1.71`, `@biomejs/biome@^2.5` (formatter only), `typescript-eslint@^8.62`, `eslint@^10.5`.

### Packaging correctness: attw + publint

Run both against the **packed tarball**, not the source tree, so you test exactly what npm ships.
publint packs with `bun pm pack` natively (no flag needed); attw's own `--pack` uses `npm pack` only (a
hidden npm-on-PATH dependency), so pack explicitly with Bun and point attw at the tarball. Use attw's
`--profile esm-only` so the (correctly fired) `CJSResolvesToESM` warning is ignored for this
intentionally ESM-only package. As implemented and verified: attw esm-only is node16-from-ESM green +
bundler green (exit 0), publint reports "All good!" (exit 0).

```jsonc
// package.json scripts
// rm runs FIRST (not trailing): a trailing `&& rm` would mask attw's exit code,
// and pre-cleaning drops a stale tarball from a previous version bump.
"attw": "rm -rf .attw && bun pm pack --quiet --destination .attw && attw .attw/*.tgz --profile esm-only",
"publint": "publint",
"prepublishOnly": "bun run build && bun run attw && bun run publint"
```
No `knip.json` change was needed: because `attw` and `publint` each have their own `package.json` script,
knip resolves the binaries to their packages and counts them as used. (The earlier worry that knip would
flag them as unlisted binaries did not materialize once they had scripts.) `.attw/` and `*.tgz` are
git-ignored (packaging scratch). Also set `"sideEffects": false` (a publint suggestion): LibreDB has no
import-time side effects, so this lets consumer bundlers tree-shake unused exports. Packages:
`@arethetypeswrong/cli@^0.18.4`, `publint@^0.3.21`.

### Bundle size budget: size-limit

The runtime analog of the line-count discipline: a checked-in byte ceiling on the shipped public entry.
size-limit bundles + treeshakes + minifies + brotli-compresses exactly as a consumer's bundler would and
exits non-zero on regression. As implemented, the public entry measures **2.83 kB** (min+brotli, all
deps); the budget is set to **4 kB** - meaningful headroom for active development while still catching a
real regression (an accidental heavy dep or a non-treeshakeable import). Raising the limit must be a
conscious edit, the same discipline as the core LOC budget.

```jsonc
// .size-limit.json
[
  {
    "name": "public entry (min+brotli)",
    "path": "dist/index.js",
    // node builtins are runtime-provided, not shipped; esbuild must not try to
    // bundle them. Only node:fs is in the shipped graph today; os/path are
    // listed defensively.
    "ignore": ["node:fs", "node:os", "node:path"],
    "limit": "4 kB"
  }
]
```
Scripts: `"size": "size-limit"`. Gate reordered to `typecheck -> format -> lint -> knip -> build -> size
-> test` (build before size - mandatory, since size reads `dist/`). knip 6's built-in size-limit plugin
auto-discovers `.size-limit.json`, so size-limit is counted as used with no `knip.json` change.
Packages: `size-limit@^12.1`, `@size-limit/preset-small-lib@^12.1`.

### Build: keep tsc, add isolatedDeclarations

No bundler (tsdown/tsup/bunup) is justified: LibreDB is ESM-only, single-package, one-to-one file
output, no dual-format/treeshake need. tsc is zero-dependency and honest. Enable
`isolatedDeclarations` for fast, inference-independent `.d.ts` emit and as a "visible explicit export
types" discipline. **Correction:** it must go in `tsconfig.build.json` (which has `declaration: true`),
not the base `tsconfig.json` (which has `noEmit: true` and would error TS5069). Consequence: only
`bun run build` enforces explicit export types, not `bun run typecheck`. Expect one TS9010 at
`src/lens/catalog.ts:45` needing an explicit return-type annotation.

### Reproducible environment

Deliberately tiny, as implemented: `.editorconfig` (2-space, LF, UTF-8, final newline, trim trailing
whitespace; markdown exempted from the trim since hard breaks use trailing spaces); `.bun-version`
pinning the toolchain to `1.3.14` (corepack does NOT support Bun, so a `packageManager` field is omitted
- it would be a false signal); `bunfig.toml [install] exact = true` for reproducible installs. The CI
workflows read `.bun-version` via `setup-bun`'s `bun-version-file`.

**Preinstall engine guard - dropped (deviation from the first-pass plan).** A `node -e` guard requires
Node on PATH for a Bun-first project (the verification pass flagged this) and can break `bun install`;
its value is marginal because the `engines` field already declares the bar, `.bun-version` pins the
toolchain for version-manager users, and CI enforces reproducibility with `--frozen-lockfile`. Adding a
fragile guard that can break installs is anti-minimal, so it was deliberately not added.

`.npmrc` is npm-specific and mostly inert under Bun (Bun reads `bunfig.toml`; `save-exact` is covered by
`[install] exact`). It stays git-ignored because it holds the publish auth token - see the Security
finding for token remediation (advised, not auto-applied). Env-var validation (zod/t3-env) is N/A:
LibreDB is a library with no runtime env vars.

### License hygiene

A dev-only allowlist check, run via `bunx` so it adds NO dependency to the tree (the tool's own
dependencies, e.g. arborist, would otherwise bloat devDependencies). The original `license-checker` is
abandoned; use the maintained `license-checker-rseidelsohn@5.0.1`.

**Scope: `--production` only (a refinement of the first-pass plan).** License risk lives only in
*distributed* code, and LibreDB ships ZERO runtime dependencies, so a consumer inherits no third-party
licenses. Gating on all deps (dev included) would be low-signal and high-maintenance noise (a new
transitive devDep with an unusual-but-permissive license would false-alarm). So the check gates only the
runtime tree: trivially green today, and it fails the moment a shipped dependency carries a
non-permissive (e.g. copyleft) license. The full installed tree was confirmed all-permissive once
(MIT/ISC/Apache-2.0/BSD/Artistic-2.0/BlueOak/WTFPL/CC0/Python-2.0), but only the runtime subset is
enforced. SPDX per-file headers: skipped - unnecessary noise for a small readable repo with one LICENSE.

The command lives in `scripts/license-check.sh`, not inline in the package.json script, because knip's
script parser treats the `;` separators in `--onlyAllow 'MIT;ISC;...'` as shell command separators and
false-flags each license id as an "unlisted binary" (verified: it failed the gate). Moving the
`;`-list into a `.sh` file (which knip does not parse) keeps `bun run license:check` working and the gate
green.

```jsonc
// package.json - runs in CI (and on demand); bunx adds no devDependency
"license:check": "sh scripts/license-check.sh"
```
```sh
# scripts/license-check.sh
exec bunx license-checker-rseidelsohn@5.0.1 --production \
  --onlyAllow 'MIT;ISC;Apache-2.0;BSD-2-Clause;BSD-3-Clause;0BSD;BlueOak-1.0.0;CC0-1.0;Python-2.0' \
  --excludePrivatePackages
```

### Security (local)

- `bun audit` (built into Bun 1.3, zero new dependency). Kept OUT of the inner `gate` (which must stay
  offline/deterministic - a newly published CVE should not fail a build mid-edit for unchanged code) and
  run instead in the `pre-push` hook and CI, where network access is expected. Run via the
  `audit` package.json script (so the hook and CI share one policy), which carries one **documented
  ignore**: `--ignore GHSA-h67p-54hq-rp68` (js-yaml moderate ReDoS in merge-key handling). It is a
  dev-only transitive dependency (`@changesets/cli -> @manypkg/get-packages -> read-yaml-file@1 ->
  js-yaml@3`), never shipped (LibreDB has zero runtime deps), and the trigger requires
  attacker-controlled YAML - but these tools only parse the project's own trusted config. There is no
  upstream fix yet (the fixed `js-yaml >= 4.2` cannot be forced into `read-yaml-file@1`, which uses the
  removed 3.x API). Remove the ignore once `@manypkg/get-packages` bumps `read-yaml-file`.
- **Secret scanning: secretlint, not gitleaks (deviation from the first-pass plan).** Both were installed
  and compared on the same planted secrets: detection was equal (each caught the Slack + Stripe keys,
  each correctly ignored the AWS doc example key), gitleaks was ~10x faster and can scan git history.
  But gitleaks is a system binary (not on npm): every contributor would have to install it separately,
  and a missing binary makes the pre-commit hook silently no-op - the exact silent-failure footgun the
  manifesto's reliability stance rejects (and it was not installed on the maintainer's machine, proving
  the point). secretlint (`secretlint` + `@secretlint/secretlint-rule-preset-recommend`) is an npm
  devDep: `bun install` sets it up for everyone, cross-platform, zero friction. Detection parity plus
  "fewer dependencies is better" settles it. Config: `.secretlintrc.json` (the recommend preset) +
  `.secretlintignore`. Script: `"secrets": "secretlint '**/*'"` (respects `.gitignore`, so the
  git-ignored `.npmrc` token is not scanned). It runs in the `pre-commit` hook and in CI. knip cannot
  trace a rule plugin loaded only via `.secretlintrc.json`, so `@secretlint/secretlint-rule-preset-recommend`
  is the one justified `knip.json` `ignoreDependencies` entry. (git history is clean - verified once with
  a throwaway gitleaks run, 76 commits, no leaks - so history scanning is not an ongoing need here.)

### Commit quality

`@commitlint/cli@^21` + `@commitlint/config-conventional@^21`, enforced from a `commit-msg` hook. As
implemented: config is `.commitlintrc.json` (`{ "extends": ["@commitlint/config-conventional"] }`); the
hook is `bun run commitlint --edit "$1"` in `.githooks/commit-msg`. A `"commitlint": "commitlint"` script
lets knip see the CLI as used; knip's built-in commitlint plugin reads `.commitlintrc.json` and resolves
`@commitlint/config-conventional` on its own, so no `ignoreDependencies` entry is needed (unlike the
secretlint preset). cz-git is rejected: an interactive prompt is ceremony at odds with "fast at the
edges"; contributors can write conventional commits by hand. Note: config-conventional does not block
emoji - it simply does not add gitmoji. The no-emoji rule stays a maintainer convention (enforcing it
would need a custom plugin, i.e. another dependency, which the minimalism rule rejects).

**Deliberately NOT in CI.** commitlint runs only in the local `commit-msg` hook. Linting a PR's commits
in CI is poor ergonomics: the commits already exist, so a failure forces the contributor to rewrite
history (`git commit --amend` / `git rebase -i`) and force-push. Instead, use **squash-merge**: the
individual PR commit messages are discarded on merge, and the single squashed commit takes the PR title -
which the maintainer curates to be conventional. So changelog hygiene is achieved at merge time without
imposing history rewrites on contributors. (Optional future step: a PR-*title* lint, which the
contributor fixes by editing the title - no force-push.)

### Git hooks (zero-dependency)

A git-tracked `.githooks/` directory wired via `git config core.hooksPath .githooks`, set by a
`prepare` script. No dependency, no Bun postinstall issue. Hooks: `commit-msg` runs commitlint;
`pre-commit` runs `secretlint` + `biome format` (fast); `pre-push` runs the full `bun run gate` + `bun audit`.
lefthook is the documented upgrade path if parallelism / staged-file scoping is ever needed.

### Release: Changesets

`@changesets/cli@^2.31`, run locally. `changeset init` config (`.changeset/config.json`), adjusted to
`access: public` (the package is public; init defaults to `restricted`) and the built-in
`@changesets/cli/changelog` (no GitHub-changelog dependency while the repo is private). `$schema` pins
`@changesets/config@3.1.4`. Scripts: `"changeset"` (write an intent file) and `"changeset:version"`
(`changeset version` + `bun run sync-version` - bump package.json + write CHANGELOG.md, then sync the
exported `version`). There is deliberately NO `changeset publish` script: publishing is done by
`publish.yml` on a GitHub Release, not by changesets.

**Version single-source.** `src/core.ts` exports a `version` constant (part of the public API), and
`changeset version` only touches package.json. `scripts/sync-version.ts` (run by `changeset:version`)
rewrites that constant from package.json so the two never drift - package.json is the single source of
truth. The sync stays OUT of `core.ts` (no runtime package.json read in the guarded core) and out of the
gate; the "version matches package.json" test in `core.test.ts` is the backstop that fails the gate if a
release ever skips the sync.

Release flow: add changesets during work (`bun run changeset`) -> when ready, `bun run changeset:version`
to bump + generate the changelog -> commit -> create the matching tag + GitHub Release -> `publish.yml`
runs `npm publish`. Decouples the changelog from commit messages (deliberate English prose, no gitmoji).
Kept out of the gate (release-phase tool); knip's changesets plugin counts the CLI as used.

### Test coverage and the branch-coverage gap

Coverage is enforced locally by Bun's own `coverageThreshold` (bunfig.toml): **line, function, and
statement are held at 100%** and `bun test` (hence the gate) fails below. That is the local coverage
gate - no Sonar-style tool is needed for enforcement; the threshold is stricter than most Sonar gates.

**Branch coverage is a known gap, and Monocart Coverage Reports (MCR) does NOT close it for Bun.**
Verified empirically on Bun 1.3.14: a deliberately uncovered inline branch (`x > 0 ? 1 : 2`, tested only
for `x > 0`) passes a `branch = 1.0` threshold and the report shows no Branch column - Bun measures
line/function/statement only and silently ignores a `branch` key. MCR (the 2026 standalone option)
cannot bridge this: it ingests **V8** coverage or **Istanbul** instrumentation, but Bun runs on
**JavaScriptCore**, so V8 coverage / `NODE_V8_COVERAGE` is unavailable and Istanbul is unsupported;
Bun's lcov carries no branch (BRDA) data to feed MCR either. MCR is the right tool for V8/Istanbul
runners (Vitest, Playwright, node:test) - not for a `bun test` project.

Realistic options for branch coverage here:
1. **Accept the gap (current).** Line/function/statement at 100% is already strong; the durability
   core's branch-level edge cases are exercised by the DST crash/recovery suite plus targeted unit tests.
2. **Track Bun native branch coverage** and adopt it (zero-dependency) when it ships - the clean path.
3. **Last resort (not recommended):** a second coverage pass under Node with a V8/Istanbul tool, which
   means running the `bun:test` suite through a compatibility layer - heavy, and against the locked
   Bun-native test decision (DESIGN 6.4).

Recommendation: 1 + 2. Revisit only if branch coverage becomes critical AND a clean JavaScriptCore-based
coverage path exists.

## Defer to CI (document now, apply when the repo is on GitHub)

These need GitHub Actions. The workflow files are now PREPARED but inert until the repo is on GitHub
(and, for SonarCloud, until a secret is set). What is committed now:

Both workflows are hardened the way CodeQL's actions queries and OpenSSF Scorecard expect: every action is
pinned to a full commit SHA (with a `# vX.Y.Z` comment), not a mutable tag, and each workflow declares a
least-privilege `permissions: contents: read`. Bump the pins by resolving the new release tag to its SHA
(`gh api repos/<owner>/<repo>/commits/<tag> --jq .sha`).

- **CI gate** (`.github/workflows/ci.yml`): runs `bun run gate` (+ secrets, audit, license) on push/PR.
  Needs no secrets, so it runs on FORK PRs too - this is the check that gates external contributions.
  For green to actually block a merge, enable branch protection on `main` (require the `gate` status
  check + a PR review); the workflow only reports, it does not block by itself.
- **SonarCloud** (`.github/workflows/sonarcloud.yml` + `sonar-project.properties`): CI-based analysis
  with LCOV coverage (lcov reporter set in `bunfig.toml`; `bun test --coverage` -> `coverage/lcov.info`). Project
  keys captured: `projectKey=libredb_libredb-database`, `organization=libredb`. Activation
  (post-push fine-tuning): bind the repo to the SonarCloud `libredb` org, add a `SONAR_TOKEN` repo
  secret, DISABLE automatic analysis (CI-based is required for coverage), and confirm the latest
  `sonarqube-scan-action` major. The DST harness `src/sim/` is marked test code, not production source.
  **Fork PRs skip this job** (`if: push || head.repo == repo`): GitHub does not pass secrets to
  fork-triggered runs, so the scan would fail through no fault of the contributor. Fork contributions are
  analyzed after they merge to main; the `gate` (ci.yml) still runs on their PR.
- **Publish** (`.github/workflows/publish.yml`): triggers ONLY on `release: [published]` (never on push/PR),
  runs the full gate, then `npm publish` authenticated via `setup-node` + the `NPMJS_TOKEN` secret. npm runs
  `prepublishOnly` (build + attw + publint) automatically. Releasing = create a tag + GitHub Release.
  Provenance is omitted while private; add `--provenance` + `id-token: write` once public.

Deliberately NOT added now (minimalism - the layers above already cover this ground; each can be
enabled later if the project wants a stronger posture):

- **Dependency updates:** none for now; `bun outdated` is the manual stand-in. When PR volume justifies
  automation, prefer **Dependabot** (GitHub-native, just `.github/dependabot.yml`, no external app,
  Bun/`bun.lock` supported) over Renovate (stronger grouping/automerge but needs the external Renovate
  GitHub App - a service dependency the minimalism rule avoids until it earns its place).
- **SAST:** CodeQL via GitHub's **default setup** (Settings -> Code security -> enable) - no committed
  workflow file; it auto-detects the language. An advanced `.github/workflows/codeql.yml` (SHA-pinned
  `github/codeql-action/{init,analyze}`) is only for custom queries/paths - not needed here.
- **npm provenance:** a one-line change to `publish.yml` (`--provenance` + `id-token: write`) once the
  repo is public; the placeholder comment is already in the workflow.
- **Optional security workflows - evaluated and skipped:** OpenSSF Scorecard, GitHub dependency-review,
  and osv-scanner each add a workflow file plus maintenance, and the existing stack (CodeQL default
  setup, SonarCloud, secretlint, `bun audit`, the license tripwire) already covers the ground. Add any
  as a SHA-pinned `.github/workflows/*.yml` later if wanted.

## Rejected

- **vitest** - `bun test` is locked (DESIGN 6.4); vitest adds a dependency and steps back from Bun-native.
- **Biome** - re-implemented type inference with acknowledged drift risk vs the real TS checker.
- **cz-git** - interactive commit ceremony, against "fast at the edges."
- **Bundlers (tsdown/tsup/bunup)** - no multi-format / treeshake / dual-CJS problem to solve; tsc is honest.
- **lefthook** - the zero-dependency `.githooks` approach is more aligned and avoids the Bun postinstall footgun.

## Security finding (act during implementation)

`.npmrc` holds a live npm `_authToken`. It is gitignored and not tracked by git (not in history - low
risk), but it should not sit in the project directory. Remediation: rotate the token on npmjs.com, move
auth to the user-level `~/.npmrc`, and keep the project `.npmrc` for non-secret settings only. secretlint
(adopted above) will catch any future staged token in a non-ignored file.

## Implementation order (all phases complete)

Each phase ended green through the gate, committed individually.

1. **Lint + format (done):** Oxlint + Biome (formatter only), ESLint reduced to type-aware, `@eslint/js` removed.
2. **Build (done):** `isolatedDeclarations` in `tsconfig.build.json`, `catalog.ts` annotation added.
3. **Packaging (done):** attw + publint + `prepublishOnly` + `sideEffects: false` (no knip entries needed - scripts suffice).
4. **Size budget (done):** size-limit, measured budget 4 kB (2.83 kB actual), gate reordered (build before size).
5. **Environment (done):** `.editorconfig`, `.bun-version`, `bunfig.toml [install] exact`, CI reads `.bun-version` (preinstall guard dropped; `.npmrc` token remediation advised).
6. **Security + hooks (done):** `bun audit` + secretlint + `.githooks` + `core.hooksPath` (secrets + audit also in CI).
7. **Commit quality (done):** commitlint + config-conventional + `commit-msg` hook.
8. **License (done):** runtime-only tripwire via `scripts/license-check.sh` (bunx, no devDependency).
9. **Release (done):** changesets init + config + first changeset (Node 22 / ES2024 / sideEffects, patch).
10. **CI (done):** `ci.yml` + `sonarcloud.yml` + `publish.yml` committed, SHA-pinned, inert until pushed; dependency bot and optional security workflows deliberately deferred (see "Deliberately NOT added now").
