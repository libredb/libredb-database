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
 * Each method is the obvious synchronous syscall, so the adapter adds an
 * interface boundary, not behaviour. Appends go through one append-mode
 * descriptor (creating the file if missing); reads, size and truncate work by
 * path, matching how the WAL has always reached the disk.
 */
import { closeSync, fsyncSync, openSync, readFileSync, statSync, truncateSync, writeSync } from "node:fs";

import type { FileSystem } from "../core.ts";

/** Build the default node:fs-backed {@link FileSystem}. */
export function nodeFileSystem(): FileSystem {
  return {
    open(path) {
      const fd = openSync(path, "a"); // append-only; creates the file if missing
      return {
        size() {
          return statSync(path).size;
        },
        read(offset, length) {
          // A fresh Uint8Array so the returned slice is an independent copy, not
          // a view aliasing a shared Buffer pool.
          return new Uint8Array(readFileSync(path)).subarray(offset, offset + length);
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
          truncateSync(path, length);
        },
        close() {
          closeSync(fd);
        },
      };
    },
  };
}
