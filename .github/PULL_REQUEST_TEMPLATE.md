<!--
Thank you for contributing to LibreDB. Keep the PR title in Conventional Commits form
(e.g. "feat(lens): add prefix scan") — PRs are squash-merged and the title becomes the changelog entry.
-->

## What and why

What does this change do, and why? Link any related issue (e.g. `Closes #123`).

## How it works

A short description of the approach. If this touches `src/core.ts` (the guarded durability core),
explain the reasoning in detail — core changes get heavier review.

## Checklist

- [ ] `bun run gate` passes locally (typecheck, format, lint, knip, build, size, test).
- [ ] Tests are added or updated to cover the change (coverage is held at 100%).
- [ ] A changeset is added for user-facing changes (`bun run changeset`).
- [ ] Docs updated if behavior or the public API changed.
- [ ] English only, no emoji, Conventional Commit PR title.
