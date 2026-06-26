/**
 * lens/document.ts — the document lens, LibreDB's differentiator lens.
 *
 * Where kv (lens/kv.ts) is the *string* face over the byte kernel, document is
 * the *JSON* face: a document is a JSON-serializable object stored as UTF-8 JSON
 * bytes (the value) under a `<collection>:<id>` kernel key. The lens adds JSON
 * ergonomics and nothing else — no storage, transactions, or recovery live here;
 * those stay in core.ts (DESIGN.md section 6.1).
 *
 * The collection handle from {@link doc} adds by-id CRUD on top of that codec;
 * collection scans (`all`) and field matching (`find`) build on it in the
 * phases that follow.
 */
import { result, type Result, type WriteResult } from "./types.ts";
import { prefixRange } from "../query/range.ts";
import { assertUserName, recordDocument } from "./catalog.ts";
import type { Store } from "../adapter/store.ts";

/**
 * Any value JSON can represent: the closure of the primitives under arrays and
 * objects. This is the honest type of "what survives a JSON round-trip" —
 * `undefined`, functions, and symbols are deliberately absent because JSON drops
 * them.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * A document: a JSON object. Stored as one value in the kernel, keyed by its id
 * within a collection. The top level is always an object (the unit a collection
 * holds), while field values range over all of {@link JsonValue}.
 */
export type Doc = { [key: string]: JsonValue };

/**
 * One document from a collection scan: its `id` paired with the decoded `doc`.
 * This is the document-lens Row type — collection reads return
 * `Result<DocEntry>` (lens/types.ts), the same envelope the kv lens uses.
 */
export interface DocEntry {
  readonly id: string;
  readonly doc: Doc;
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

/** Serialize a document to UTF-8 JSON bytes — the form the kernel stores. */
export function encodeDoc(doc: Doc): Uint8Array {
  return utf8.encode(JSON.stringify(doc));
}

/**
 * Parse UTF-8 JSON bytes back into a document. The inverse of {@link encodeDoc}:
 * bytes produced by it round-trip with full fidelity (numbers stay numbers,
 * nested objects and unicode survive), which the document lens relies on for
 * type-sensitive field matching.
 */
export function decodeDoc(bytes: Uint8Array): Doc {
  return JSON.parse(fromUtf8.decode(bytes)) as Doc;
}

/**
 * Deep structural equality over {@link JsonValue}. This is what document
 * matching compares with, so it must be the JSON notion of "same value", not
 * reference identity and not `JSON.stringify` (which is sensitive to object key
 * order and so would call two equal objects unequal).
 *
 * - Primitives (string/number/boolean/null) compare by `===`, which is
 *   type-sensitive on purpose: `1` is not `"1"` and `true` is not `"true"`.
 * - Arrays are equal element-wise, in order (order is part of an array's value).
 * - Objects are equal when they have the same set of keys and every value is
 *   deeply equal; key *order* is irrelevant.
 *
 * The arguments are `JsonValue | undefined` so a missing field (`doc[key]` with
 * no such key) is handled directly: it is `undefined`, which equals nothing a
 * predicate can hold (predicate values are always defined {@link JsonValue}).
 */
function deepEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true; // same primitive, same reference, or both undefined
  if (a === null || b === null) return false; // one is null but not the other (=== caught both)
  if (typeof a !== "object" || typeof b !== "object") return false; // unequal primitives/undefined
  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) return false; // an array is never equal to a plain object
  if (aIsArray) {
    const bArr = b as JsonValue[];
    if (a.length !== bArr.length) return false;
    return a.every((item, i) => deepEqual(item, bArr[i]));
  }
  const aObj = a as { [key: string]: JsonValue };
  const bObj = b as { [key: string]: JsonValue };
  const aKeys = Object.keys(aObj);
  if (aKeys.length !== Object.keys(bObj).length) return false;
  return aKeys.every((key) => Object.prototype.hasOwnProperty.call(bObj, key) && deepEqual(aObj[key], bObj[key]));
}

/**
 * Whether `document` satisfies `predicate`: every top-level field named in the
 * predicate is present on the document and deeply equal to the predicate's value
 * (DESIGN.md section 6.1). Multiple fields are an implicit AND. An empty
 * predicate names no fields and so matches every document.
 *
 * Exported so the relational lens's `where` can reuse the exact same matching
 * semantics over rows (a row is a Doc), instead of re-deriving a second matcher.
 */
export function matches(document: Doc, predicate: Doc): boolean {
  return Object.keys(predicate).every((key) => deepEqual(document[key], predicate[key]));
}

/**
 * The kernel key for one document: `<collection>:<id>`, UTF-8 encoded (DESIGN.md
 * section 6.1). Prefixing every id with the collection name is what scopes a
 * collection to a contiguous byte range, so a later `<collection>:` prefix scan
 * (D3) selects exactly that collection. For a point operation it just makes the
 * key deterministic: the same `(collection, id)` always maps to the same bytes.
 */
function keyOf(collection: string, id: string): Uint8Array {
  return utf8.encode(`${collection}:${id}`);
}

/**
 * A handle on one collection: by-id CRUD over the kernel.
 *
 * Each operation auto-commits in its own kernel transaction, so the collection
 * behaves like a durable map of documents — a write is atomic and, on a
 * file-backed database, fsync'd before it returns. Multi-document atomicity is a
 * conscious omission (DESIGN.md section 6.1): a caller that needs it drops to the
 * kernel's `transact`. The handle is a view — it depends only on the
 * {@link Store} seam and never touches the store's lifecycle.
 */
export interface DocCollection {
  /** Store `document` under `id`, overwriting any existing document at that id.
   * Always reports one changed entry. */
  put(id: string, document: Doc): WriteResult;
  /** The document stored at `id`, decoded, or `undefined` if none is set. */
  get(id: string): Doc | undefined;
  /** Remove the document at `id`. Reports one changed entry if it existed, zero
   * if it did not. */
  delete(id: string): WriteResult;
  /** Every document in the collection, as {@link DocEntry} rows in ascending id
   * order (the kernel's byte order over the `<collection>:<id>` keys). The
   * {@link Result} is lazy and re-iterable: each pass re-runs the scan against
   * the current state. A scan sees only this collection's documents — the
   * `<collection>:` prefix is a byte boundary, so a sibling whose name shares a
   * prefix (`users` vs `users2`) is never included. */
  all(): Result<DocEntry>;
  /** Every document whose top-level fields match `predicate` by deep
   * (structural) equality; multiple fields are an implicit AND, and an empty
   * predicate matches everything (so `find({})` equals `all()`). Returns the
   * same lazy, re-iterable {@link Result} as `all`, scoped to this collection.
   *
   * Cost: O(n) in the collection size. `find` is a full collection scan with an
   * in-engine predicate — there are no secondary indexes (DESIGN.md section 6.1,
   * a deliberate v1 omission). Every document is decoded and tested on each
   * pass. */
  find(predicate: Doc): Result<DocEntry>;
}

/**
 * Build a {@link DocCollection} handle scoped to `collection` over a
 * {@link Store} (the kernel's `Database` satisfies it, as does any object that
 * can run a transaction).
 */
export function doc(store: Store, collection: string): DocCollection {
  // A collection name may not intrude on the reserved catalog namespace
  // (DESIGN.md section 6.3) — reject it loudly before any key is derived.
  assertUserName(collection);

  // The byte range covering every `<collection>:` key. prefixRange computes the
  // [start, end) bound on raw bytes so it agrees with the kernel's order, which
  // is what makes the colon a sound collection boundary (a sibling like "users2"
  // sorts outside ["users:", "users;") and is never seen). The prefix string
  // length is also where every key's id begins, so stripping it recovers the id.
  const prefix = `${collection}:`;
  const { start, end } = prefixRange(utf8.encode(prefix));

  // The shared collection scan behind both all() and find(): walk the prefix
  // range in id (byte) order and return the documents `keep` accepts. The thunk
  // re-runs per iteration, so the Result stays lazy and re-iterable; rows are
  // materialized inside the transaction because the kernel's getRange is only
  // valid in the tx body.
  const scan = (keep: (document: Doc) => boolean): Result<DocEntry> =>
    result(() =>
      store.transact((tx) => {
        const rows: DocEntry[] = [];
        for (const entry of tx.getRange(start, end)) {
          const document = decodeDoc(entry.value);
          if (keep(document)) {
            rows.push({
              id: fromUtf8.decode(entry.key).slice(prefix.length),
              doc: document,
            });
          }
        }
        return rows;
      }),
    );

  return {
    put(id, document) {
      store.transact((tx) => {
        // Register this collection in the catalog on its first write (DESIGN.md
        // section 6.3). Idempotent and inside the write's own transaction, so the
        // registration and the document are durable together. A table's inserts
        // also reach here, but recordDocument is write-if-absent and the
        // relational entry already exists, so it never downgrades that entry.
        recordDocument(tx, collection);
        tx.set(keyOf(collection, id), encodeDoc(document));
      });
      return { changed: 1 };
    },
    get(id) {
      return store.transact((tx) => {
        const bytes = tx.get(keyOf(collection, id));
        return bytes === undefined ? undefined : decodeDoc(bytes);
      });
    },
    delete(id) {
      // Read-before-delete in one transaction: the kernel's delete is a silent
      // no-op on a missing key, so this is how the lens tells 1 from 0 changes.
      const changed = store.transact((tx) => {
        const k = keyOf(collection, id);
        const existed = tx.get(k) !== undefined;
        tx.delete(k);
        return existed ? 1 : 0;
      });
      return { changed };
    },
    all() {
      return scan(() => true);
    },
    find(predicate) {
      return scan((document) => matches(document, predicate));
    },
  };
}
