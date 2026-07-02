/**
 * lens/catalog.ts — the reserved catalog namespace and the user-name policy.
 *
 * The catalog (DESIGN.md section 6.3) lets a tool that opens a LibreDB file cold
 * — e.g. the LibreDB Studio provider — show faithful per-kind views: which lens
 * a namespace belongs to, and a relational table's schema. That interpretation
 * lives in application code, not on disk, so the lenses persist it as ordinary
 * KV entries under a reserved key prefix. It is a lens-level CONVENTION, not a
 * kernel feature: core.ts stays pure ordered-KV and unchanged (honesty
 * discipline — do not grow the core for this).
 *
 * This file establishes the namespace, the one correctness rule it depends on,
 * and the registry write/validate mechanics. The `catalog` read API for tools is
 * added in a later phase; here a `table` records its schema and a reopen
 * validates against it.
 *
 * The codec and comparison here are the catalog's OWN — it deliberately does not
 * import a lens. The dependency arrow points lenses -> catalog (the lenses call
 * {@link recordRelational}); the catalog never points back at a lens, so it stays
 * a leaf the lenses build on. The only lens reference is the type-level
 * {@link TableSchema} import, which is erased at runtime (`import type`), so it
 * adds no runtime coupling or import cycle.
 */
import { prefixRange } from "../query/range.ts";
import type { Store } from "../adapter/store.ts";
import { LibreDbError, type Transaction } from "../core.ts";
import type { TableSchema } from "./relational.ts";

/**
 * The reserved marker. It is U+0000, encoded as the single byte 0x00 — the
 * lowest byte, so it sorts before every byte a non-reserved UTF-8 name can begin
 * with. A user collection or table name may not start with it (see
 * {@link assertUserName}); that one rule keeps all user keys strictly above, and
 * therefore disjoint from, the catalog namespace below.
 */
export const RESERVED_MARKER = "\x00";

/**
 * The catalog key prefix: every catalog entry's key begins with this string. It
 * opens with the reserved marker, so the whole catalog namespace sorts before
 * any user-data key (which can never start with the marker). The readable
 * `libredb:catalog:` tail keeps the namespace self-describing if a raw-KV tool
 * dumps the file before it understands the catalog.
 */
export const CATALOG_PREFIX: string = `${RESERVED_MARKER}libredb:catalog:`;

/**
 * Reject a string that is not well-formed UTF-16 (it contains a lone
 * surrogate). Such a string cannot round-trip through the UTF-8 encoding the
 * lenses store keys in — every lone surrogate encodes to the same replacement
 * character, so two DISTINCT malformed strings silently collide on one key.
 * Rejecting at the lens boundary keeps "distinct strings are distinct keys"
 * true. Shared by the kv lens (keys) and the document lens (ids and names).
 */
export function assertWellFormedText(text: string, what: string): void {
  if (!text.isWellFormed()) {
    throw new LibreDbError(
      "INVALID_ARGUMENT",
      `${what} ${JSON.stringify(text)} contains a lone surrogate and cannot round-trip through UTF-8`,
    );
  }
}

/**
 * Reject a user namespace name the key layout cannot isolate — a loud error,
 * the same class of correctness rule as the prefix-soundness checks the lenses
 * already enforce. Three shapes are forbidden outright rather than silently
 * remapped, because each would let one namespace's keys collide with another's:
 *
 *   - a name starting with the reserved marker would place user keys inside the
 *     catalog namespace;
 *   - a name containing ":" breaks the `<name>:` byte boundary the lenses scan
 *     by — `doc(db, "tenant:1")` and id "x" would collide with `doc(db,
 *     "tenant")` id "1:x" (encode the tenant into the ID, not the name);
 *   - an empty name would make every id a bare `:<id>` key shared by all
 *     empty-named namespaces.
 *
 * Called by `doc` and `table` when a handle is built; the raw kv lens is
 * deliberately not guarded — it is the raw layer with full keyspace access
 * (DESIGN.md section 6.3).
 */
export function assertUserName(name: string): void {
  if (name.startsWith(RESERVED_MARKER)) {
    throw new LibreDbError(
      "INVALID_ARGUMENT",
      `namespace name ${JSON.stringify(name)} may not start with the reserved catalog marker (U+0000)`,
    );
  }
  if (name === "") {
    throw new LibreDbError("INVALID_ARGUMENT", "namespace name may not be empty");
  }
  if (name.includes(":")) {
    throw new LibreDbError(
      "INVALID_ARGUMENT",
      `namespace name ${JSON.stringify(name)} may not contain ":" (it delimits the namespace in the key ` +
        `layout); encode variable parts into document ids instead`,
    );
  }
  assertWellFormedText(name, "namespace name");
}

/** The cataloged kind of `name` as seen through `read` (a point-read inside
 * the caller's own transaction), or undefined when it is not cataloged. The
 * lens entry points use this to route a name to the right lens: `doc()` refuses
 * a relational table (its rows are schema-validated), `table()` refuses a
 * document collection (its documents never were). Taking a read function
 * instead of a Store keeps the check inside whatever transaction the caller is
 * already running — the kernel forbids nesting a fresh one. */
export function catalogKindAt(
  read: (key: Uint8Array) => Uint8Array | undefined,
  name: string,
): CatalogEntry["kind"] | undefined {
  const bytes = read(catalogKey(name));
  return bytes === undefined ? undefined : (JSON.parse(fromUtf8.decode(bytes)) as CatalogEntry).kind;
}

/**
 * Whether `key` lies in LibreDB's reserved internal namespace — that is, whether
 * it begins with the {@link RESERVED_MARKER}. This is the public contract a tool
 * that renders RAW key-value data (e.g. the LibreDB Studio provider) uses to HIDE
 * engine-internal keys: the catalog today, and any further reserved sub-namespace
 * added under the marker later. Testing the marker rather than the specific
 * {@link CATALOG_PREFIX} is deliberate — a tool that depends on this stays correct
 * if the reserved namespace grows, so it never has to track the byte layout.
 *
 * {@link assertUserName} guarantees no user namespace name begins with the marker,
 * so this predicate partitions reserved keys from user keys with no overlap.
 */
export function isReservedKey(key: string): boolean {
  return key.startsWith(RESERVED_MARKER);
}

/**
 * The lens a cataloged namespace belongs to, plus (for a relational table) its
 * schema — the otherwise-unrecoverable interpretation a cold-opening tool needs
 * (DESIGN.md section 6.3). `kv` namespaces are never cataloged (kv is the raw
 * layer); a `document` entry carries only `kind` (documents are schemaless).
 */
export interface CatalogEntry {
  readonly kind: "kv" | "document" | "relational";
  readonly schema?: TableSchema;
}

/**
 * The whole catalog as a snapshot, keyed by namespace name (the `<collection>`
 * or `<table>`, with the reserved prefix stripped). It is the registry a tool
 * that opens a LibreDB file cold reads to render faithful per-kind views
 * (DESIGN.md section 6.3): for each namespace, which lens it belongs to and, for
 * a relational table, its schema.
 */
export type CatalogRegistry = ReadonlyMap<string, CatalogEntry>;

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

/** The kernel key for one namespace's catalog entry: the reserved prefix plus
 * the namespace name, UTF-8 encoded. Because the prefix opens with the reserved
 * low byte, this key always sorts outside every user-data range. */
function catalogKey(name: string): Uint8Array {
  return utf8.encode(CATALOG_PREFIX + name);
}

/** Whether two table schemas are equal by structure: same primary key and the
 * same columns mapped to the same types. Declared column ORDER is irrelevant
 * (the comparison is over the key set), so reopening with the same schema
 * written differently still validates. Specialized to the schema shape on
 * purpose — the catalog has no arbitrary-JSON entries to compare. */
function schemasEqual(a: TableSchema, b: TableSchema): boolean {
  const aColumns = Object.keys(a.columns);
  const bColumns = Object.keys(b.columns);
  return (
    a.primaryKey === b.primaryKey &&
    aColumns.length === bColumns.length &&
    aColumns.every((column) => a.columns[column] === b.columns[column])
  );
}

/**
 * Record a relational table's schema in the catalog on first creation, or — if
 * the namespace is already cataloged — validate that the passed schema equals
 * the persisted one, throwing on mismatch (DESIGN.md section 6.3: no schema
 * migration in v1). Called by {@link table} when a handle is built.
 *
 * The read and the conditional write run in ONE kernel transaction, so the
 * check-then-record is atomic and, on a file-backed database, the entry is
 * fsync'd through the WAL before `table()` returns (it survives a reopen). The
 * value is JSON of a {@link CatalogEntry} — an ordinary KV value under the
 * reserved key, so the kv lens (the raw layer) can also read it.
 */
export function recordRelational(store: Store, name: string, schema: TableSchema): void {
  store.transact((tx) => {
    const key = catalogKey(name);
    const existing = tx.get(key);
    if (existing === undefined) {
      const entry: CatalogEntry = { kind: "relational", schema };
      tx.set(key, utf8.encode(JSON.stringify(entry)));
      return;
    }
    const persisted = JSON.parse(fromUtf8.decode(existing)) as CatalogEntry;
    if (persisted.kind !== "relational") {
      throw new LibreDbError(
        "INVALID_ARGUMENT",
        `${JSON.stringify(name)} is a ${persisted.kind} namespace; use its own lens instead of table()`,
      );
    }
    if (persisted.schema === undefined || !schemasEqual(persisted.schema, schema)) {
      throw new Error(
        `libredb: table ${JSON.stringify(name)} was reopened with a schema that does not match ` +
          `the persisted catalog entry; v1 does not support schema migration`,
      );
    }
  });
}

/**
 * Register a document collection in the catalog on its first write, recording
 * only `{ kind: "document" }` — documents are schemaless, so existence and kind
 * are all there is to record (DESIGN.md section 6.3). Idempotent: it writes the
 * entry only when the namespace is not already cataloged, so repeated writes
 * neither duplicate nor error.
 *
 * Unlike {@link recordRelational}, this takes the caller's {@link Transaction}
 * rather than a {@link Store}: a document collection registers lazily on its
 * first `put`, which is already inside a transaction, and the kernel forbids
 * nested `transact`. Riding the write's own transaction also makes the
 * registration and the first document durable together (one fsync, atomic).
 *
 * Write-if-absent is the crux that keeps a relational table's catalog entry
 * intact: `table()` routes its inserts through an internal document `put`, but
 * the `{ kind: "relational", schema }` entry was already recorded at table
 * construction (see {@link recordRelational}), so this no-ops there and never
 * downgrades it to a bare `document` kind.
 */
export function recordDocument(tx: Transaction, name: string): void {
  const key = catalogKey(name);
  if (tx.get(key) !== undefined) return;
  const entry: CatalogEntry = { kind: "document" };
  tx.set(key, utf8.encode(JSON.stringify(entry)));
}

/**
 * Read the whole catalog as a {@link CatalogRegistry} snapshot — the public
 * read API a tool uses to enumerate a database's namespaces and their kinds
 * (DESIGN.md section 6.3). Each entry's key has the reserved prefix stripped, so
 * callers see plain namespace names (`users`, not `\x00libredb:catalog:users`).
 *
 * It scans only `[CATALOG_PREFIX, upperBound)` — the same byte-level prefix
 * range the lenses use, computed by {@link prefixRange}. Because the prefix
 * opens with the reserved low byte and {@link assertUserName} keeps user keys
 * above it, that range is disjoint from all user data: catalog entries never
 * leak into a `doc`/`table`/user-`kv` scan, and no user row leaks into the
 * registry.
 *
 * The result is an EAGER snapshot, not a lazy {@link import("./types.ts").Result}
 * like a lens read: the catalog is small metadata (one entry per namespace), and
 * a `Map` gives a tool direct lookup and enumeration. The single read
 * transaction sees one consistent committed state.
 */
export function catalog(store: Store): CatalogRegistry {
  const { start, end } = prefixRange(utf8.encode(CATALOG_PREFIX));
  return store.transact((tx) => {
    const registry = new Map<string, CatalogEntry>();
    for (const entry of tx.getRange(start, end)) {
      const name = fromUtf8.decode(entry.key).slice(CATALOG_PREFIX.length);
      registry.set(name, JSON.parse(fromUtf8.decode(entry.value)) as CatalogEntry);
    }
    return registry;
  });
}
