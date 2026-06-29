/**
 * browser.ts — the browser entry point of the LibreDB npm package
 * (`@libredb/libredb/browser`).
 *
 * Same lens surface as the default Node entry ({@link import("./index.ts")}),
 * with one difference: `open` carries NO default filesystem. An in-memory
 * database (`open()`) works anywhere; a path-backed open requires an injected
 * `fs` (e.g. the bundled {@link opfsFileSystem}). Here that requirement is in
 * the TYPE — {@link BrowserOpenOptions} makes `fs` mandatory when `path` is
 * given, so misuse is a compile error rather than a runtime throw. The point of
 * this entry is the import graph: it reaches nothing in `node:`, so a bundler
 * can ship it to a browser. The node:fs adapter lives behind Node only.
 */
import { open as openKernel, type Database, type FileSystem } from "./core.ts";

export { version } from "./core.ts";
export type { Database, FileSystem, OpenOptions, WalFile } from "./core.ts";

/**
 * Options for the browser {@link open}. Unlike the kernel's permissive
 * `OpenOptions`, `fs` is REQUIRED whenever `path` is present, because the browser
 * entry has no default filesystem — so a path-backed open without an `fs` fails
 * to compile here instead of throwing at runtime. An in-memory open (no `path`)
 * needs no filesystem.
 */
export type BrowserOpenOptions =
  | { readonly path: string; readonly fs: FileSystem }
  | { readonly path?: never; readonly fs?: FileSystem };

/**
 * Open a database in the browser. The same runtime as the kernel's `open`, typed
 * so a path-backed open requires an injected filesystem (e.g.
 * {@link opfsFileSystem}). Assigning the kernel's wider-typed `open` here is
 * sound by parameter contravariance, so the kernel itself stays unchanged.
 */
export const open: (options?: BrowserOpenOptions) => Database = openKernel;

// OPFS persistence (browser-only): wrap an OPFS sync access handle as the
// filesystem for a path-backed open. See adapter/opfs.ts for usage in a Worker.
export { opfsFileSystem } from "./adapter/opfs.ts";
export type { SyncAccessHandle } from "./adapter/opfs.ts";

export { kv } from "./lens/kv.ts";
export type { Kv, KvEntry } from "./lens/kv.ts";

export { doc } from "./lens/document.ts";
export type { DocCollection, Doc, DocEntry, JsonValue } from "./lens/document.ts";

export { table } from "./lens/relational.ts";
export type { Table, TableSchema, Row, ColumnType, Query } from "./lens/relational.ts";

export { catalog, isReservedKey, CATALOG_PREFIX, RESERVED_MARKER } from "./lens/catalog.ts";
export type { CatalogEntry, CatalogRegistry } from "./lens/catalog.ts";

export type { Result, WriteResult } from "./lens/types.ts";
