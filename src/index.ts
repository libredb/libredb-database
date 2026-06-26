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
export { version, open } from "./core.ts";
export type { Database, OpenOptions } from "./core.ts";

export { kv } from "./lens/kv.ts";
export type { Kv, KvEntry } from "./lens/kv.ts";

export { doc } from "./lens/document.ts";
export type { DocCollection, Doc, DocEntry, JsonValue } from "./lens/document.ts";

export { table } from "./lens/relational.ts";
export type { Table, TableSchema, Row, ColumnType, Query } from "./lens/relational.ts";

export { catalog, isReservedKey, CATALOG_PREFIX, RESERVED_MARKER } from "./lens/catalog.ts";
export type { CatalogEntry, CatalogRegistry } from "./lens/catalog.ts";

export type { Result, WriteResult } from "./lens/types.ts";
