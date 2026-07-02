---
"@libredb/libredb": minor
---

Durability, safety, and API-contract hardening across the kernel, adapters, lenses, and CLI (the pre-announcement audit wave).

On-disk format: new databases now begin with an 8-byte `LRDB` magic/version header. Files written by earlier releases (headerless) keep opening through a legacy read path; files written by this release are not readable by older releases. The header is what lets `open()` refuse a file that is not a LibreDB database with a clear error instead of destroying it.

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

- node-fs: creating a database fsyncs the parent directory (a fresh database can no longer vanish wholesale on power loss); recovery truncation is fsync'd; reads are positional on the WAL's own file descriptor instead of re-reading the whole file per call.
- OPFS: reads loop until filled, so a legal short read can no longer masquerade as a torn tail; recovery treats an incomplete read as an IO fault (`INCOMPLETE_READ`), never as license to truncate.

Lenses:

- Collection/table names may not be empty or contain `:` (both broke namespace isolation); ids keep full freedom.
- Strings that are not well-formed UTF-16 (lone surrogates) are rejected wherever they would become keys, ids, names, or kv values — distinct strings can no longer silently collide on one key.
- Relational `number` columns reject `NaN` and the infinities (JSON would store them as `null`).
- `doc()` refuses a name cataloged as a relational table (it would bypass schema validation); `table()` refuses a document collection's name.
- `find()`/`where()` reject a predicate field explicitly set to `undefined`, which previously matched documents *missing* the field.

CLI:

- Write commands rely on the kernel's exclusive lock; `--force` removes a lock only when its holder is not verifiably alive, and never deletes a file that is not a libredb lock.
- `get`/`scan` escape control characters by default so untrusted values cannot inject terminal escape sequences; `--raw` prints verbatim.

Docker image now runs as a non-root user (distroless `:nonroot`, uid 65532).
