/**
 * cli/readonly-fs.ts — a read-only {@link FileSystem} for the inspection CLI.
 *
 * An edge, not the kernel: it carries no durability logic, only the node:fs
 * calls a read needs. Inspection commands open a database purely to read it, but
 * open() runs recovery, which truncates a torn tail — a write. This adapter makes
 * that impossible: `append` and `fsync` refuse, and `truncate` is a no-op, so a
 * crash-interrupted file is recovered correctly IN MEMORY (the torn tail is
 * dropped from the returned entries) while the bytes on disk are left exactly as
 * found. `size` and `read` are the obvious read syscalls.
 */
import { closeSync, openSync, readFileSync, statSync } from "node:fs";

import type { FileSystem } from "../core.ts";

/** Build a read-only {@link FileSystem} over `node:fs`. */
export function readonlyFileSystem(): FileSystem {
  return {
    open(path) {
      const fd = openSync(path, "r"); // read-only; throws if the file is absent
      return {
        size() {
          return statSync(path).size;
        },
        read(offset, length) {
          return new Uint8Array(readFileSync(path)).subarray(offset, offset + length);
        },
        append() {
          throw new Error("libredb: read-only database; refusing to write");
        },
        fsync() {
          throw new Error("libredb: read-only database; refusing to write");
        },
        truncate() {
          // Deliberate no-op: a read must not alter the file. Recovery still
          // drops a torn tail from the in-memory state; the disk is untouched.
        },
        close() {
          closeSync(fd);
        },
      };
    },
  };
}
