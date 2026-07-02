/**
 * adapter/node-fs.ts — the default {@link FileSystem} for Node and Bun.
 *
 * This is an edge, not the kernel (DESIGN.md section 5): it holds the one place
 * LibreDB touches `node:fs`. The kernel (`core.ts`) is runtime-agnostic and
 * imports nothing from `node:`; it reaches the disk only through the injected
 * {@link FileSystem} seam. Keeping the node dependency HERE — and out of the
 * kernel — is what lets the browser entry (`browser.ts`) ship without dragging
 * `node:fs` into its import graph. The default Node entry (`index.ts`) wires this
 * adapter in as the default `fs`, so production behaviour is unchanged.
 *
 * Everything runs on one file descriptor opened in append mode: positional
 * reads, appends, fsync and truncate all address the same inode, so a path
 * swapped out from under a live database cannot split reads from writes. Two
 * durability details live here because they are platform facts, not kernel
 * logic: creating the file fsyncs the PARENT DIRECTORY (POSIX does not make a
 * new directory entry durable until then), and the exclusive {@link
 * FileSystem.lock} is a `<path>.lock` file so a second writer — same process or
 * another one — fails loudly instead of silently corrupting the log.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";

import { LibreDbError, type FileSystem } from "../core.ts";

/** The first line of every LibreDB lock file, so tooling (and `--force`) can
 * tell a real lock from an unrelated file that merely shares the name. */
export const LOCK_SENTINEL = "libredb-lock";

/** What a lock file records about its holder. `pid`/`host` let a later opener
 * detect a stale lock (the holder died); `nonce` proves ownership on release. */
interface LockOwner {
  readonly pid: number;
  readonly host: string;
  readonly nonce: string;
}

/** Parse a lock file's contents. Returns undefined for an empty file or a
 * legacy sentinel-only lock (both are LibreDB strays with no liveness info) and
 * throws nothing — a FOREIGN file (no sentinel) returns null. */
function parseLock(contents: string): LockOwner | undefined | null {
  if (contents === "") return undefined; // a crashed create left an empty file
  if (!contents.startsWith(LOCK_SENTINEL)) return null; // not ours
  const [, pid, host, nonce] = contents.split("\n");
  if (pid === undefined || host === undefined || nonce === undefined || nonce === "") {
    return undefined; // sentinel-only legacy lock: ours, but anonymous
  }
  return { pid: Number(pid), host, nonce };
}

/** Can the process behind `owner` be probed on THIS host, and is it alive?
 * "verified dead" means same host and signal-0 says the pid is gone; a holder
 * on another host is never verifiable either way. */
function livenessOf(owner: LockOwner): "alive" | "dead" | "unverifiable" {
  if (owner.host !== hostname()) return "unverifiable";
  try {
    process.kill(owner.pid, 0); // signal 0: existence probe, no signal sent
    return "alive";
  } catch (error) {
    // ESRCH: no such process (dead). EPERM: exists but not ours (alive).
    return (error as { code?: string }).code === "EPERM" ? "alive" : "dead";
  }
}

/**
 * Is the lock at `lockPath` stale — held by a LibreDB process that verifiably
 * no longer exists? Foreign files are never stale (they are not locks to
 * steal), and a holder that cannot be probed (another host) counts as live:
 * auto-reclaim must never race a writer that might still be running. `--force`
 * (see {@link forceUnlock}) is the explicit escape hatch for that case.
 */
export function isStaleLock(lockPath: string): boolean {
  let contents: string;
  try {
    contents = readFileSync(lockPath, "utf8");
  } catch {
    return true; // vanished between the failed create and this read: retry
  }
  const owner = parseLock(contents);
  if (owner === null) return false; // foreign file: refuse to touch it
  if (owner === undefined) return true; // anonymous LibreDB stray: reclaim it
  return livenessOf(owner) === "dead";
}

/** One attempt to create `lockPath` exclusively. Returns false when it already
 * exists; any other failure (missing directory, permissions) propagates. */
function tryCreateLock(lockPath: string, contents: string): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath, "wx"); // "wx": exclusive create, fails if it exists
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") throw error;
    return false;
  }
  try {
    writeSync(fd, contents);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Atomically claim `lockPath` for removal by renaming it aside, then judge the
 * CLAIMED file's contents with `verdict`. Rename is the atomicity primitive:
 * of N racers, exactly one wins the rename (the rest see ENOENT and report
 * "gone") — so check-then-delete can never remove a lock a NEW writer created
 * between the check and the delete. If `verdict` refuses, the file is renamed
 * back so the refused lock keeps protecting its holder.
 *
 * Returns "removed" | "gone" (nothing to claim) | never (verdict threw).
 */
function claimAndRemoveLock(lockPath: string, verdict: (contents: string) => void): "removed" | "gone" {
  const claimed = `${lockPath}.claim-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    renameSync(lockPath, claimed);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return "gone"; // another racer won
    throw error;
  }
  let contents: string;
  try {
    contents = readFileSync(claimed, "utf8");
    verdict(contents);
  } catch (error) {
    // Refused (or unreadable): put the lock back where it was so its holder
    // stays protected, then surface the refusal.
    renameSync(claimed, lockPath);
    throw error;
  }
  rmSync(claimed, { force: true });
  return "removed";
}

/**
 * Remove a lock file with `--force` semantics: a LibreDB lock is removed
 * unless its holder is VERIFIABLY alive (same host, pid exists); a foreign
 * file is always refused. An unverifiable holder (another host) is removed —
 * that is exactly the case force exists for — with the risk on the caller.
 * The claim is atomic (rename-aside), so force can never delete a lock a new
 * writer acquired after the stale one was observed. Exported for the CLI,
 * which offers this as its `--force` flag.
 */
export function forceUnlock(path: string): void {
  const lockPath = `${path}.lock`;
  if (!existsSync(lockPath)) return; // nothing to remove
  claimAndRemoveLock(lockPath, (contents) => {
    const owner = parseLock(contents);
    if (owner === null) {
      throw new LibreDbError("LOCKED", `refusing to remove ${lockPath}: not a libredb lock file`);
    }
    if (owner !== undefined && livenessOf(owner) === "alive") {
      throw new LibreDbError("LOCKED", `refusing to remove ${lockPath}: holder (pid ${owner.pid}) is alive`);
    }
  });
}

/**
 * Fsync the directory containing `path`, making a just-created file's directory
 * entry durable. POSIX leaves a new entry volatile until the directory itself
 * is fsync'd — without this, a freshly created database (and every commit in
 * it) can vanish wholesale on power loss. Exported for the tests that pin it.
 */
export function fsyncDirectoryOf(path: string): void {
  try {
    const dirFd = openSync(dirname(path), "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // Platforms without directory fsync (Windows) throw on the open or the
    // fsync; directory-entry durability is the OS's best effort there.
  }
}

/** Build the default node:fs-backed {@link FileSystem}. */
export function nodeFileSystem(): FileSystem {
  return {
    open(path) {
      const creating = !existsSync(path);
      const fd = openSync(path, "a+"); // read + append-only writes; creates if missing
      if (creating) fsyncDirectoryOf(path);
      return {
        size() {
          return fstatSync(fd).size;
        },
        read(offset, length) {
          // Positional reads on the WAL's own descriptor, looped because a
          // single readSync may legally return fewer bytes than asked. Fewer
          // bytes than the file holds would otherwise read as a torn tail and
          // truncate committed data — the kernel treats that as an IO fault.
          const out = new Uint8Array(length);
          let filled = 0;
          while (filled < length) {
            const count = readSync(fd, out, filled, length - filled, offset + filled);
            if (count === 0) break; // end of file
            filled += count;
          }
          return filled === length ? out : out.subarray(0, filled);
        },
        append(bytes) {
          for (let written = 0; written < bytes.length; ) {
            written += writeSync(fd, bytes, written);
          }
        },
        fsync() {
          fsyncSync(fd);
        },
        truncate(length) {
          ftruncateSync(fd, length);
        },
        close() {
          closeSync(fd);
        },
      };
    },
    lock(path) {
      const lockPath = `${path}.lock`;
      const nonce = randomBytes(8).toString("hex");
      const contents = `${LOCK_SENTINEL}\n${process.pid}\n${hostname()}\n${nonce}\n`;
      // Two attempts: the second runs only after a stale lock (a crashed
      // holder's leftover) was reclaimed. A live holder never yields.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (tryCreateLock(lockPath, contents)) {
          return () => {
            // Release only OUR lock — atomically. If someone force-removed it
            // and locked again, the claimed contents carry THEIR nonce; the
            // verdict throws, the rename puts their lock back, and we leave it
            // alone (a plain check-then-delete would race a fresh acquire).
            try {
              claimAndRemoveLock(lockPath, (c) => {
                if (parseLock(c)?.nonce !== nonce) throw new Error("not ours");
              });
            } catch {
              // Not ours or already gone: either way there is nothing to release.
            }
          };
        }
        if (!isStaleLock(lockPath)) break;
        // Reclaim the stale lock ATOMICALLY: rename-aside means that of N
        // processes racing this reclaim, exactly one removes the stale file —
        // the losers see it gone and retry the exclusive create, where again
        // exactly one wins. Two concurrent writers can never both acquire.
        // The verdict re-checks staleness on the claimed bytes: if a NEW
        // writer's lock slid in between the check and the claim, it is put
        // back untouched.
        try {
          if (
            claimAndRemoveLock(lockPath, (c) => {
              const owner = parseLock(c);
              if (owner === null) throw new Error("foreign file");
              if (owner !== undefined && livenessOf(owner) === "alive") throw new Error("holder alive");
            }) === "gone"
          ) {
            continue; // another racer reclaimed it; retry the exclusive create
          }
        } catch {
          break; // a live or foreign lock appeared: locked
        }
      }
      throw new LibreDbError(
        "LOCKED",
        `${path} is locked (${lockPath}); another writer holds it — close it first, or use --force in the CLI`,
      );
    },
  };
}
