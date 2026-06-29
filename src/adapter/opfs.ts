/**
 * adapter/opfs.ts — an OPFS-backed {@link FileSystem} for the browser.
 *
 * An edge, not the kernel: it carries no durability logic, only the mapping from
 * the kernel's synchronous {@link FileSystem} seam onto an OPFS sync access
 * handle. The point is that a `FileSystemSyncAccessHandle` exposes SYNCHRONOUS
 * read/write/getSize/truncate/flush/close — the exact shape the kernel's WAL
 * needs — so LibreDB can be durable in a browser with no async core.
 *
 * Sync access handles only exist inside a Web Worker, and obtaining one is async
 * (navigator.storage.getDirectory -> getFileHandle -> createSyncAccessHandle).
 * That async acquisition is the caller's, done once before {@link
 * import("../core.ts").open}; this adapter takes the already-open handle and
 * wraps it synchronously, keeping `open` synchronous. Typical use in a Worker:
 *
 *   const root = await navigator.storage.getDirectory();
 *   const file = await root.getFileHandle("app.libredb", { create: true });
 *   const handle = await file.createSyncAccessHandle();
 *   const db = open({ path: "app.libredb", fs: opfsFileSystem(handle) });
 *
 * The handle is bound to one file, so the kernel's `path` is unused here — the
 * database opened with this adapter is the file the handle was created for.
 */
import type { FileSystem } from "../core.ts";

/**
 * The synchronous subset of a browser `FileSystemSyncAccessHandle` the WAL uses.
 * Declared locally so the package needs no DOM lib types; a real sync access
 * handle satisfies it structurally.
 */
export interface SyncAccessHandle {
  /** Read into `buffer` starting at `options.at` (default 0); returns bytes read. */
  read(buffer: Uint8Array, options?: { at?: number }): number;
  /** Write `buffer` starting at `options.at` (default 0); returns bytes written. */
  write(buffer: Uint8Array, options?: { at?: number }): number;
  /** The file's current size in bytes. */
  getSize(): number;
  /** Resize the file to `newSize`, dropping anything beyond it. */
  truncate(newSize: number): void;
  /** Persist buffered writes to storage. */
  flush(): void;
  /** Release the handle. */
  close(): void;
}

/** Build a {@link FileSystem} backed by an open OPFS sync access `handle`. */
export function opfsFileSystem(handle: SyncAccessHandle): FileSystem {
  return {
    open() {
      return {
        size() {
          return handle.getSize();
        },
        read(offset, length) {
          const buffer = new Uint8Array(length);
          const read = handle.read(buffer, { at: offset });
          return buffer.subarray(0, read);
        },
        append(data) {
          handle.write(data, { at: handle.getSize() });
        },
        fsync() {
          handle.flush();
        },
        truncate(length) {
          handle.truncate(length);
        },
        close() {
          handle.close();
        },
      };
    },
  };
}
