---
"@libredb/libredb": minor
---

Add a `libredb` CLI for inspecting and editing `.libredb` files (`npx libredb`).

Read commands: `inspect` (list each namespace, its kind, and table schemas),
`stats` (file size and namespace counts by kind), `get <key>`, and
`scan <prefix>`. They open through a read-only filesystem adapter, so inspecting
a file never mutates it — even a crash-torn tail is recovered in memory only,
leaving the bytes on disk untouched.

Write commands: `set <key> <value>`, `delete <key>`, and `import <file.json>`
(bulk-set from a JSON object in a single atomic commit). Writes take an advisory
`<path>.lock` so a second concurrent writer fails loudly instead of corrupting
the file; `--force` overrides a stale lock.

The CLI is built on the public API with zero dependencies (Node/Bun `parseArgs`).
