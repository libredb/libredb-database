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
import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";

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

/** Remove an existing libredb lock so a forced acquire can proceed. Refuses to
 * touch a file that is not a libredb lock, so `--force` can never delete
 * unrelated user data that happens to share the `.lock` name. */
function dropOwnLock(lockPath: string): void {
  let contents: string;
  try {
    contents = readFileSync(lockPath, "utf8");
  } catch {
    return; // no lock file to drop
  }
  if (!contents.startsWith(SENTINEL)) {
    throw new Error(`libredb: refusing to remove ${lockPath} with --force: not a libredb lock file`);
  }
  rmSync(lockPath, { force: true });
}
