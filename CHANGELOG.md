# @libredb/libredb

## 0.2.1

### Patch Changes

- 6f5e953: Complete the API documentation surface and export the types it references.

  Every exported symbol — including interface and class members — now carries JSDoc, and both entrypoints carry an explicit module doc, so generated documentation (JSR, editors) is complete. Types that public signatures reference are now exported instead of being reachable-but-unnamed: `Transaction`, `Entry`, `Key`, `Value`, `Open`, and the lens seam `Store` from the main entry; `Transaction`, `Entry`, `Key`, `Value`, and `Store` from the browser entry. No runtime behavior changes.

## 0.2.0

### Minor Changes

- 69f7161: Durability, safety, and API-contract hardening across the kernel, adapters, lenses, and CLI (the pre-announcement audit wave).

  On-disk format: new databases now begin with an 8-byte `LRDB` magic/version header, and each record header carries a checksum of its own length field. Files written by earlier releases (headerless) keep opening through a legacy read path, and keep their legacy record framing on later appends. The header is what lets `open()` refuse a file that is not a LibreDB database with a clear error instead of destroying it; the record-header checksum is what lets recovery refuse a damaged length field instead of mistaking it for a torn tail.

  DOWNGRADE WARNING: a file written by this release must never be opened by 0.1.3 or older — the old recovery cannot parse the header, classifies the whole file as a torn tail, and silently truncates it to zero bytes. Back up before any downgrade. Three smaller legacy-behavior changes: a headerless file whose only record is torn/incomplete now refuses to open as `NOT_A_DATABASE` (0.1.3 recovered it to an empty database; refusing is the safe reading, since such a file is indistinguishable from a foreign one); any file shorter than the 8-byte header is likewise refused untouched (a crash inside the first bytes of a brand-new database's first-ever commit therefore needs a manual delete — nothing in it was acknowledged); and a legacy length-field corruption still reads as a torn tail (the legacy format has no header checksum — the v1 format exists to close exactly that gap).

  Kernel:

  - `open({ path })` on a non-LibreDB file throws `NOT_A_DATABASE` and leaves the file byte-for-byte untouched (previously the file was silently truncated to zero).
  - Recovery classifies failures: a torn tail truncates (reported through the new `onRecovery` open option), while mid-log corruption throws `CORRUPT_WAL` and truncates nothing. Record payloads are structurally validated during replay.
  - A failed append/fsync latches the database: every later `transact()` throws `FAILED` until reopen, so an IO error can never lead recovery to silently drop later acknowledged commits.
  - `transact()` rejects async callbacks (`ASYNC_TRANSACTION`): writes after an `await` could never reach the log.
  - Keys and values are copied at the transaction boundary in both directions — caller buffer reuse and mutation of returned buffers can no longer corrupt the store.
  - `getRange` snapshots at first iteration, so delete-while-scanning visits every entry exactly once.
  - `close()` inside a transaction throws `CLOSE_IN_TRANSACTION` instead of surfacing a raw file error.
  - `open()` takes an exclusive per-file lock (`<path>.lock`, pid/host/nonce): a second writer throws `LOCKED` instead of silently diverging; locks from verifiably dead holders are reclaimed automatically. `FileSystem` gains an optional `lock()` seam method.
  - All kernel failures are now `LibreDbError` instances carrying a stable `code` (exported, with the `ErrorCode` and `RecoveryInfo` types).

  Adapters:

  - node-fs: creating a database fsyncs the parent directory (a fresh database can no longer vanish wholesale on power loss); a directory-fsync failure that is not a platform limitation (e.g. EIO) now surfaces as an error instead of being silently ignored; recovery truncation is fsync'd; reads are positional on the WAL's own file descriptor instead of re-reading the whole file per call.
  - OPFS: reads loop until filled, so a legal short read can no longer masquerade as a torn tail; recovery treats an incomplete read as an IO fault (`INCOMPLETE_READ`), never as license to truncate.

  Lenses:

  - Collection/table names may not be empty or contain `:` (both broke namespace isolation); ids keep full freedom.
  - Strings that are not well-formed UTF-16 (lone surrogates) are rejected wherever they would become keys, ids, names, or kv values — distinct strings can no longer silently collide on one key.
  - Relational `number` columns reject `NaN` and the infinities (JSON would store them as `null`).
  - `doc()` refuses a name cataloged as a relational table (it would bypass schema validation); `table()` refuses a document collection's name.
  - `find()`/`where()` reject a predicate field explicitly set to `undefined`, which previously matched documents _missing_ the field.

  CLI:

  - Write commands rely on the kernel's exclusive lock; `--force` removes a lock only when its holder is not verifiably alive, and never deletes a file that is not a libredb lock. Automatic reclaim is stricter still: only a lock whose holder is VERIFIABLY dead (same host, pid gone) is reclaimed without `--force` — anonymous locks (empty, or the sentinel-only 0.1.x format) carry no liveness information and now require `--force`.
  - `get`/`scan` escape control characters (including tab and newline) by default so untrusted values cannot inject terminal escape sequences — scripts that consumed values verbatim should pass `--raw`.

  New exports: `LibreDbError`, `ErrorCode`, `RecoveryInfo`, `nodeFileSystem`, and `readonlyFileSystem` (open a database for inspection with no lock and no writes — the supported way to read a file a live writer holds).

  Docker image now runs as a non-root user (distroless `:nonroot`, uid 65532): bind-mounted directories must be writable by that uid, or pass `--user "$(id -u):$(id -g)"`.

## 0.1.3

### Patch Changes

- 78f3547: Add a `libredb` CLI for inspecting and editing `.libredb` files (`npx libredb`).

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

- 8a1bd79: Add a browser entry point (`@libredb/libredb/browser`) and make the kernel
  runtime-agnostic.

  The `node:fs` dependency moved out of the kernel (`core.ts`) into a dedicated
  adapter, so importing LibreDB no longer drags `node:fs` into the module graph.
  The default Node entry (`@libredb/libredb`) is unchanged: `open({ path })` still
  defaults to the real filesystem and is durable out of the box. The new browser
  entry exposes the same lens surface with an `open` that has no default
  filesystem — in-memory databases work anywhere, and a path-backed open accepts
  an injected filesystem. A bundler targeting the browser now resolves a build
  free of Node built-ins via the `browser` export condition.

- 1f823de: Add OPFS-backed browser persistence via `opfsFileSystem` (exported from
  `@libredb/libredb/browser`).

  A browser `FileSystemSyncAccessHandle` exposes synchronous read/write/getSize/
  truncate/flush/close, which map directly onto the kernel's synchronous filesystem
  seam — so a LibreDB database can be durable in the browser with no async core.
  Inside a Web Worker, obtain a sync access handle and pass it to `open`:

  ```ts
  const root = await navigator.storage.getDirectory();
  const file = await root.getFileHandle("app.libredb", { create: true });
  const db = open({
    path: "app.libredb",
    fs: opfsFileSystem(await file.createSyncAccessHandle()),
  });
  ```

  The adapter takes an already-open handle (acquisition is async and the caller's),
  keeping `open` synchronous. The new `SyncAccessHandle` type names the handle
  shape the adapter needs, so the package depends on no DOM lib types.

## 0.1.0 - 0.1.2

Builds published while validating the multi-channel release pipeline (npm, JSR,
GitHub Releases, GHCR, Docker Hub) end to end; superseded by 0.1.3.

## 0.0.4 and earlier

Released before this changelog was generated by Changesets. See the GitHub
Releases for their notes — e.g.
[v0.0.4](https://github.com/libredb/libredb-database/releases/tag/v0.0.4) and
[earlier](https://github.com/libredb/libredb-database/releases).
