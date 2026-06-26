---
name: Bug report
about: Report a defect in LibreDB
title: ""
labels: bug
assignees: ""
---

## What happened

A clear description of the bug and what you expected instead.

## Minimal reproduction

The single most useful thing you can provide. A short code snippet that reproduces the issue:

```ts
import { open, kv } from "@libredb/libredb";

// ...
```

## Expected behavior

What you expected to happen.

## Actual behavior

What actually happened (include the full error and stack trace if there is one).

## Environment

- LibreDB version:
- Bun version (`bun --version`) or Node version:
- OS:
- Storage mode: in-memory / file-backed (`open({ path })`)

## Additional context

Anything else that helps — logs, a failing test, related issues.
