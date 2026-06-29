/**
 * index.ts — the public entry point of the LibreDB npm package.
 *
 * The public surface is the kv lens (DESIGN.md section 6): you `open` a kernel
 * database and put a lens over it — {@link kv} (strings) or {@link doc} (JSON
 * documents). The kernel's byte-level internals (and each lens's private codec)
 * stay unexported on purpose — the lens is the usable face. The relational lens
 * ({@link table}) completes the trio. {@link catalog} reads the registry of
 * namespaces a database holds, so a tool can render faithful per-kind views;
 * {@link isReservedKey} (with {@link RESERVED_MARKER} / {@link CATALOG_PREFIX})
 * lets a raw-KV tool hide engine-internal keys instead of hardcoding the layout.
 */
import { open as openKernel, type Open } from "./core.ts";
import { nodeFileSystem } from "./adapter/node-fs.ts";

export { version } from "./core.ts";
export type { Database, FileSystem, OpenOptions, WalFile } from "./core.ts";

/**
 * Open a LibreDB database on Node or Bun. Identical to the kernel's
 * {@link import("./core.ts").open}, except a path-backed open with no `fs`
 * defaults to the real `node:fs` adapter — so `open({ path })` is durable out of
 * the box. A pathless open stays in-memory; an explicit `fs` is passed through.
 * The browser entry (`@libredb/libredb/browser`) omits this default so it never
 * imports `node:fs`.
 */
export const open: Open = (options) =>
  options?.path !== undefined && options.fs === undefined
    ? openKernel({ ...options, fs: nodeFileSystem() })
    : openKernel(options);

export { kv } from "./lens/kv.ts";
export type { Kv, KvEntry } from "./lens/kv.ts";

export { doc } from "./lens/document.ts";
export type { DocCollection, Doc, DocEntry, JsonValue } from "./lens/document.ts";

export { table } from "./lens/relational.ts";
export type { Table, TableSchema, Row, ColumnType, Query } from "./lens/relational.ts";

export { catalog, isReservedKey, CATALOG_PREFIX, RESERVED_MARKER } from "./lens/catalog.ts";
export type { CatalogEntry, CatalogRegistry } from "./lens/catalog.ts";

export type { Result, WriteResult } from "./lens/types.ts";
