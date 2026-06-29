/**
 * cli/lock.ts — an advisory write lock for the CLI.
 *
 * LibreDB is single-process and does no file locking itself, so two writers to
 * one file would corrupt it. Write commands take a `<path>.lock` first: an
 * exclusive create that fails if the file already exists, turning a concurrent
 * writer into a loud error instead of silent corruption. It is advisory only —
 * `--force` drops a stale lock and proceeds. The lock is always released after
 * the write (see withWriteDb in run.ts).
 */
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";

/** A held lock. Call {@link Lock.release} once the write is done. */
export interface Lock {
  release(): void;
}

// Written into every lock file so a forced acquire can tell a real libredb lock
// from an unrelated file that merely happens to be named <path>.lock, and refuse
// to delete the latter.
const SENTINEL = "libredb-lock\n";

/** Acquire the advisory lock for `path`. With `force`, an existing libredb lock
 * is dropped first; otherwise an existing lock makes this throw. */
export function acquireLock(path: string, force: boolean): Lock {
  const lockPath = `${path}.lock`;
  if (force) dropOwnLock(lockPath);
  try {
    const fd = openSync(lockPath, "wx"); // "wx": exclusive create, fails if it exists
    try {
      writeSync(fd, SENTINEL);
    } finally {
      closeSync(fd); // always release the descriptor, even if the write throws
    }
  } catch (error) {
    // A failed sentinel write (e.g. ENOSPC) leaves an EMPTY <path>.lock behind;
    // that stray is recoverable because dropOwnLock treats an empty file as ours.
    // Only an existing lock file (EEXIST) means "locked". Surface any other IO
    // error (missing directory, permissions, ...) unchanged, so a real problem
    // is not misreported as a held lock.
    if ((error as { code?: string }).code !== "EEXIST") throw error;
    throw new Error(
      `libredb: ${path} is locked (${lockPath}); another writer may be active — use --force to override`,
      { cause: error },
    );
  }
  return {
    release() {
      rmSync(lockPath, { force: true });
    },
  };
}

/** Remove an existing libredb lock so a forced acquire can proceed. A lock this
 * tool created carries the SENTINEL; an empty file is a stray from a crash or a
 * failed sentinel write (also ours) and is safe to drop. Any other content means
 * the file is not our lock, so `--force` refuses it rather than delete unrelated
 * user data that happens to share the `.lock` name. A read error other than "no
 * such file" (e.g. EACCES) propagates instead of being silently swallowed. */
function dropOwnLock(lockPath: string): void {
  if (!existsSync(lockPath)) return; // nothing to drop
  const contents = readFileSync(lockPath, "utf8");
  if (contents !== "" && !contents.startsWith(SENTINEL)) {
    throw new Error(`libredb: refusing to remove ${lockPath} with --force: not a libredb lock file`);
  }
  rmSync(lockPath, { force: true });
}
