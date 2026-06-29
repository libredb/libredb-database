/**
 * browser.ts — the browser entry point of the LibreDB npm package
 * (`@libredb/libredb/browser`).
 *
 * Same lens surface as the default Node entry ({@link import("./index.ts")}),
 * with one difference: `open` is the kernel's own, carrying NO default
 * filesystem. An in-memory database (`open()`) works anywhere; a path-backed
 * open requires an injected `fs` (e.g. a future OPFS adapter). The point of this
 * entry is the import graph: it reaches nothing in `node:`, so a bundler can
 * ship it to a browser. The node:fs adapter lives behind the Node entry only.
 */
export { open, version } from "./core.ts";
export type { Database, FileSystem, OpenOptions, WalFile } from "./core.ts";

export { kv } from "./lens/kv.ts";
export type { Kv, KvEntry } from "./lens/kv.ts";

export { doc } from "./lens/document.ts";
export type { DocCollection, Doc, DocEntry, JsonValue } from "./lens/document.ts";

export { table } from "./lens/relational.ts";
export type { Table, TableSchema, Row, ColumnType, Query } from "./lens/relational.ts";

export { catalog, isReservedKey, CATALOG_PREFIX, RESERVED_MARKER } from "./lens/catalog.ts";
export type { CatalogEntry, CatalogRegistry } from "./lens/catalog.ts";

export type { Result, WriteResult } from "./lens/types.ts";
