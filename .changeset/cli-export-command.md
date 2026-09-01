---
"@libredb/libredb": minor
---

Add a CLI `export` command: `libredb export <path> <file.json>` dumps a database's key-value layer as JSON in the exact shape `import` consumes, so `export` -> `import` round-trips.

The dump is one flat JSON object of string values. It covers the key-value layer, which is the raw layer — `document` and `relational` data therefore appears as the internal prefixed entries those lenses store (a document `l1` in collection `logs` is the key `logs:l1` holding its JSON); there is no per-lens export. LibreDB's reserved `\x00`-prefixed catalog namespace is deliberately left out, because `import` refuses to write reserved keys: a restored file holds every row but no catalog entry, so a byte-exact copy is still a file copy, not a dump. A database holding raw non-UTF-8 bytes (only reachable by writing through the kernel API directly) is refused rather than dumped with replacement characters that would import back as different data.

Like every other read command, `export` opens through the read-only filesystem adapter: it takes no lock, creates no `<path>.lock`, and leaves the database byte-identical, so it can dump a file a live writer holds open. The only thing it writes is the destination JSON file, which is overwritten if it already exists.
