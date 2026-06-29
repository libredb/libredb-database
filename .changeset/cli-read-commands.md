---
"@libredb/libredb": minor
---

Add a `libredb` CLI for inspecting `.libredb` files (`npx libredb`).

Read commands ship first: `inspect` (list each namespace, its kind, and table
schemas), `stats` (file size and namespace counts by kind), `get <key>`, and
`scan <prefix>`. They open the database through a read-only filesystem adapter,
so inspecting a file never mutates it — even a crash-torn tail is recovered in
memory only, leaving the bytes on disk untouched. The CLI is built on the public
API with zero dependencies (Node/Bun `parseArgs`).
