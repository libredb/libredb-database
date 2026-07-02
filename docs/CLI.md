# The `libredb` CLI

`libredb` is a small command-line tool for **inspecting and editing `.libredb`
files** — no code required. It is built on the public API, ships with the package,
and has **zero dependencies** (it uses Node/Bun's built-in `parseArgs`).

Because LibreDB is an embedded database, the CLI is a *local* tool — like
`sqlite3` or `cat`: it opens the file path you give it, on your machine. There is
no server and no daemon.

> Three ways to run the exact same CLI: via the package (`npx libredb`, below), a
> [standalone binary](./BINARY.md) (no Node/Bun needed), or a
> [Docker image](./DOCKER.md). The command set in this document applies to all three.

---

## Running it

```sh
# one-off, via the published package (no install)
npx libredb <command> <path> [args]    # npm
bunx libredb <command> <path> [args]    # bun

# or install it
npm install -g @libredb/libredb        # then: libredb <command> ...
```

Run with no arguments (or `--help`) to print usage:

```sh
$ libredb
libredb - inspect and edit .libredb files

Usage:
  libredb inspect <path>             List each namespace, its kind, and table schemas
  libredb stats <path>               Summarize the file: size and namespace counts
  libredb get <path> <key>           Print the value stored at a key
  libredb scan <path> <prefix>       Print key=value for every key under a prefix
  libredb set <path> <key> <value>   Set a key to a value
  libredb delete <path> <key>        Remove a key
  libredb import <path> <file.json>  Bulk-set keys from a JSON object (one atomic commit)

Options:
  --force                            Remove a write lock whose holder is no longer alive
  --raw                              Print values verbatim (default escapes control characters)
```

---

## Commands

### Read commands

These open the file **read-only** and never modify it (see [Safety](#safety)).

#### `inspect <path>` — what's in this file

Lists the file size and each **catalogued namespace** with its kind, plus the
schema for relational tables.

```sh
$ libredb inspect app.libredb
app.libredb  412 bytes
  logs    document
  people  relational  {"primaryKey":"id","columns":{"id":"string","name":"string"}}
```

> Note: only `document` and `relational` namespaces are catalogued; plain
> **key-value pairs are the raw layer and are not listed here**. A file holding
> only kv data prints `(no catalogued namespaces)` — its keys are still readable
> with `get`/`scan`.

#### `stats <path>` — a one-glance summary

```sh
$ libredb stats app.libredb
app.libredb  412 bytes  2 namespaces
  kv: 0  document: 1  relational: 1
```

#### `get <path> <key>` — print one value

```sh
$ libredb get app.libredb user:1
Ada
```

Exits non-zero (`1`) with `key not found: <key>` if the key is absent.

#### `scan <path> <prefix>` — every key under a prefix

Prints `key=value`, one per line, in the kernel's ascending byte order.

```sh
$ libredb scan app.libredb user:
user:1=Ada
user:2=Grace
```

### Write commands

These take an advisory lock (see [Safety](#safety)) and commit through the WAL.

#### `set <path> <key> <value>`

```sh
$ libredb set app.libredb user:1 Ada
set user:1 (1 changed)
```

#### `delete <path> <key>`

```sh
$ libredb delete app.libredb user:1
delete user:1 (1 removed)      # "(0 removed)" if the key did not exist
```

#### `import <path> <file.json>` — atomic bulk load

Reads a JSON **object of string values** and sets every pair in a **single
transaction** — the whole load lands, or (on a crash mid-write) none of it does.

```sh
$ cat seed.json
{ "user:1": "Ada", "user:2": "Grace", "color": "teal" }

$ libredb import app.libredb seed.json
import 3 keys
```

The JSON must be an object whose values are all strings; anything else is a usage
error.

---

## Safety

The CLI touches real database files, so it is deliberately careful:

- **Reads never mutate the file.** Opening a database runs crash recovery, which
  would normally truncate a torn tail — a write. Read commands
  (`inspect`/`stats`/`get`/`scan`) open through a **read-only filesystem adapter**:
  recovery drops a torn tail *in memory only*; the bytes on disk are left exactly
  as found.
- **A wrong path cannot destroy a file.** Opening a file that is not a LibreDB
  database (a typo, a text file) fails with a clear error and leaves the file
  byte-for-byte untouched — the on-disk `LRDB` header is checked before anything
  is written.
- **Writes hold the exclusive open lock.** The library itself locks the database
  on open (`<path>.lock`, recording the holder's pid and host), so a second
  writer — this CLI against a live app, or two CLI invocations — fails loudly
  instead of silently corrupting the file. A lock whose holder is verifiably dead
  is reclaimed automatically; `--force` additionally removes a lock that cannot
  be verified (for example one from another machine), but refuses a verifiably
  live holder and refuses to delete a file that is not a libredb lock.
- **Output is escaped by default.** `get`/`scan` print stored values with control
  characters escaped (`\x1b`, `\x07`, ...), so a value containing terminal escape
  sequences cannot clear your screen, retitle your terminal, or write your
  clipboard when you inspect an untrusted file. Pass `--raw` for the exact bytes.
- **Reserved keys are refused.** Writes reject keys in LibreDB's reserved
  namespace (the `\x00`-prefixed catalog space), so the CLI cannot corrupt the
  catalog or another lens's layout.
- **Bulk imports are atomic.** `import` commits all keys in one transaction.

---

## Backup and restore

The WAL **is** the database: one `.libredb` file holds everything, so backup is a
file copy — with one rule.

- **Backup:** copy the file while **no writer has it open** (no `<path>.lock`
  present, or only your own closed session). A copy taken mid-write can split a
  record in half; the copy would then open only up to the split.

  ```sh
  cp app.libredb backup/app-$(date -u +%Y%m%d).libredb
  ```

- **Restore:** copy the file back and open it — recovery replays it like any
  reopen. Nothing else to do.
- **Export as text:** `libredb scan <path> ""` is not supported (an empty prefix
  is refused); scan per namespace prefix, or use the programmatic lenses for a
  structured export. A first-class `export` command is on the roadmap.

---

## Exit codes

| Code | Meaning | Examples |
| --- | --- | --- |
| `0` | Success | a read/write completed |
| `1` | Runtime error | file not found, `get` on a missing key |
| `2` | Usage error | unknown command/option, missing argument, malformed import JSON, reserved key, lock held |

This makes the CLI scriptable — e.g. in CI:

```sh
libredb get app.libredb migration:done >/dev/null 2>&1 || libredb set app.libredb migration:done "$(date -u +%FT%TZ)"
```

---

## Notes & limitations

- `get`/`scan`/`set`/`delete`/`import` operate on the **key-value layer** (UTF-8
  string keys and values). `inspect`/`stats` read the **catalog** for the richer
  document/relational view.
- There is no interactive `repl` (it was intentionally left out for now).
- The CLI is one of three identical front-ends — see the
  [standalone binary](./BINARY.md) and [Docker image](./DOCKER.md) for the same
  commands without a Node/Bun install.
- For the programmatic API behind these commands, see the
  [lens guides](./guides/).
