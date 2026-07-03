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
 *
 * The exports below are deliberately LOCAL declarations (documented aliases of
 * the shared originals) rather than `export ... from` re-exports: a plain
 * re-export of a symbol another entrypoint also exports is emitted as a bare,
 * undocumented reference by the documentation tooling, so each alias carries
 * its own doc and the generated API documentation stays complete for this
 * entry too.
 *
 * @module
 */
import { LibreDbError as KernelError, open as openKernel, version as packageVersion } from "./core.ts";
import type {
  Entry as KernelEntry,
  ErrorCode as KernelErrorCode,
  Key as KernelKey,
  RecoveryInfo as KernelRecoveryInfo,
  Transaction as KernelTransaction,
  Value as KernelValue,
  Database as KernelDatabase,
  FileSystem as KernelFileSystem,
  WalFile as KernelWalFile,
} from "./core.ts";
import type { Store as LensStore } from "./adapter/store.ts";
import { kv as kvLens, type Kv as KvLens, type KvEntry as KvLensEntry } from "./lens/kv.ts";
import {
  doc as docLens,
  type Doc as LensDoc,
  type DocCollection as LensDocCollection,
  type DocEntry as LensDocEntry,
  type JsonValue as LensJsonValue,
} from "./lens/document.ts";
import {
  table as tableLens,
  type ColumnType as LensColumnType,
  type Query as LensQuery,
  type Row as LensRow,
  type Table as LensTable,
  type TableSchema as LensTableSchema,
} from "./lens/relational.ts";
import {
  CATALOG_PREFIX as CATALOG_PREFIX_VALUE,
  catalog as catalogReader,
  isReservedKey as isReservedKeyFn,
  RESERVED_MARKER as RESERVED_MARKER_VALUE,
  type CatalogEntry as LensCatalogEntry,
  type CatalogRegistry as LensCatalogRegistry,
} from "./lens/catalog.ts";
import type { Result as LensResult, WriteResult as LensWriteResult } from "./lens/types.ts";

/** The LibreDB package version. Kept in sync with package.json. */
export const version: string = packageVersion;

/** The typed error every kernel and adapter failure throws; branch on its
 * stable {@link ErrorCode} `code` instead of matching message strings. */
export const LibreDbError: typeof KernelError = KernelError;
/** The instance type of {@link LibreDbError}, for annotations and narrowing. */
export type LibreDbError = InstanceType<typeof KernelError>;

/** The stable failure codes carried by {@link LibreDbError}. */
export type ErrorCode = KernelErrorCode;
/** What recovery reports through {@link BrowserOpenOptions} `onRecovery` when
 * a torn tail was truncated. */
export type RecoveryInfo = KernelRecoveryInfo;
/** A key in the kernel: an immutable sequence of bytes. */
export type Key = KernelKey;
/** A value in the kernel: an opaque sequence of bytes. */
export type Value = KernelValue;
/** One key/value pair yielded by an ordered range scan. */
export type Entry = KernelEntry;
/** The unit of atomic work against the kernel — see the Node entry for the
 * full contract (read-your-writes, snapshot scans, copied buffers). */
export type Transaction = KernelTransaction;
/** An open kernel instance: transact plus close. */
export type Database = KernelDatabase;
/** The filesystem seam a path-backed browser open must be given — see
 * {@link opfsFileSystem} for the OPFS implementation. */
export type FileSystem = KernelFileSystem;
/** An open handle to a write-ahead log file: the operations the WAL performs. */
export type WalFile = KernelWalFile;
/** The minimal transact-only seam the lenses build on; implement it to put a
 * lens over something that is not a kernel database. */
export type Store = LensStore;

/**
 * Options for the browser {@link open}. Unlike the kernel's permissive
 * `OpenOptions`, `fs` is REQUIRED whenever `path` is present, because the browser
 * entry has no default filesystem — so a path-backed open without an `fs` fails
 * to compile here instead of throwing at runtime. An in-memory open (no `path`)
 * needs no filesystem.
 */
export type BrowserOpenOptions =
  | { readonly path: string; readonly fs: FileSystem; readonly onRecovery?: (info: RecoveryInfo) => void }
  | { readonly path?: never; readonly fs?: FileSystem; readonly onRecovery?: never };

/**
 * Open a database in the browser. The same runtime as the kernel's `open`, typed
 * so a path-backed open requires an injected filesystem (e.g.
 * {@link opfsFileSystem}). Assigning the kernel's wider-typed `open` here is
 * sound by parameter contravariance, so the kernel itself stays unchanged.
 */
export const open: (options?: BrowserOpenOptions) => Database = openKernel;

// OPFS persistence (browser-only): wrap an OPFS sync access handle as the
// filesystem for a path-backed open. See adapter/opfs.ts for usage in a Worker.
// These are canonical here (the Node entry does not export them), so plain
// re-exports keep their original documentation.
export { opfsFileSystem } from "./adapter/opfs.ts";
export type { SyncAccessHandle } from "./adapter/opfs.ts";

/** The key-value lens: a durable, ordered, string-keyed map over the kernel. */
export const kv: typeof kvLens = kvLens;
/** The kv lens surface: get/set/delete plus ordered range and prefix scans. */
export type Kv = KvLens;
/** One key/value pair from a kv scan, decoded to strings. */
export type KvEntry = KvLensEntry;

/** The document lens: JSON documents with by-id CRUD and field-match queries. */
export const doc: typeof docLens = docLens;
/** A handle on one document collection. */
export type DocCollection = LensDocCollection;
/** A document: a JSON object stored under an id within a collection. */
export type Doc = LensDoc;
/** One document from a collection scan: its id paired with the decoded doc. */
export type DocEntry = LensDocEntry;
/** Any value JSON can represent — the universe document fields live in. */
export type JsonValue = LensJsonValue;

/** The relational lens: schema-validated tables with where/select/join. */
export const table: typeof tableLens = tableLens;
/** A handle on one typed table. */
export type Table = LensTable;
/** A table schema: the primary-key column and the declared columns. */
export type TableSchema = LensTableSchema;
/** A table row: a JSON object whose fields are the schema's columns. */
export type Row = LensRow;
/** A column's declared type: string, number, boolean, or object. */
export type ColumnType = LensColumnType;
/** A lazy, chainable query over a table's rows. */
export type Query = LensQuery;

/** Read the whole catalog: which lens each namespace belongs to, plus table
 * schemas — the faithful view a cold-opening tool renders. */
export const catalog: typeof catalogReader = catalogReader;
/** Whether a string key lies in LibreDB's reserved internal namespace, so a
 * raw-KV tool can hide engine-internal keys. */
export const isReservedKey: typeof isReservedKeyFn = isReservedKeyFn;
/** The catalog key prefix (reserved marker + `libredb:catalog:`). */
export const CATALOG_PREFIX: string = CATALOG_PREFIX_VALUE;
/** The reserved namespace marker: U+0000, sorting below every user key. */
export const RESERVED_MARKER: string = RESERVED_MARKER_VALUE;
/** One catalog entry: a namespace's lens kind, plus a table's schema. */
export type CatalogEntry = LensCatalogEntry;
/** The whole catalog as a snapshot, keyed by namespace name. */
export type CatalogRegistry = LensCatalogRegistry;

/** What every lens read returns: a lazy, typed, re-iterable row sequence. */
export type Result<Row> = LensResult<Row>;
/** The outcome of a lens write: how many stored entries changed. */
export type WriteResult = LensWriteResult;
