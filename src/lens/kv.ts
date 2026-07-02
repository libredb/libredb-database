/**
 * lens/kv.ts — the key-value lens, LibreDB's proof lens.
 *
 * The kernel (core.ts) is already an ordered byte key-value store, so this lens
 * is the thinnest one possible: it does not add storage, transactions, or
 * recovery — it only puts an ergonomic face on what the kernel already does.
 * That makes it the honest proof of the architecture (DESIGN.md section 6):
 * "here is the ordered KV core, usable directly."
 *
 * What the lens adds, and nothing more:
 *   - STRING ergonomics. The kernel speaks raw bytes on purpose; this lens
 *     encodes string keys/values as UTF-8 on the way in and decodes on the way
 *     out, so it reads like the `Map<string, string>` it means to replace.
 *   - The SHARED ENVELOPE. Reads return a {@link Result}, writes return a
 *     {@link WriteResult} (lens/types.ts), the shapes every later lens reuses.
 *
 * Each operation runs in its own transaction (auto-commit), so the lens behaves
 * like a durable map: a write is atomic and, on a file-backed database, fsync'd
 * before it returns. Multi-key atomicity is a conscious omission for the proof
 * lens — a caller that needs it reaches the kernel's `transact` directly. The
 * lens is a view: it depends only on the {@link Store} seam (`transact`), never
 * on the store's lifecycle; whoever opened the store closes it.
 */
import { result, type Result, type WriteResult } from "./types.ts";
import { prefixRange } from "../query/range.ts";
import { assertWellFormedText } from "./catalog.ts";
import type { Store } from "../adapter/store.ts";

/** One key/value pair from a range scan, decoded to strings. The kv-lens
 * counterpart of the kernel's byte-level {@link import("../core.ts").Entry}. */
export interface KvEntry {
  readonly key: string;
  readonly value: string;
}

/**
 * The key-value lens surface: a durable, ordered, string-keyed map.
 *
 * Keys are ordered by the UTF-8 byte order the kernel sorts on, so `range`
 * yields entries in ascending key order over the half-open interval
 * `[start, end)` — `start` included, `end` excluded.
 */
export interface Kv {
  /** The value stored for `key`, or `undefined` if it is not set. */
  get(key: string): string | undefined;
  /** Store `value` under `key`, overwriting any existing value. Always reports
   * one changed entry. */
  set(key: string, value: string): WriteResult;
  /** Remove `key`. Reports one changed entry if it existed, zero if it did not. */
  delete(key: string): WriteResult;
  /** Scan `[start, end)` in ascending key order. The {@link Result} is lazy and
   * re-iterable: each pass re-runs the scan against the current state. */
  range(start: string, end: string): Result<KvEntry>;
  /** Scan every key beginning with `prefix`, in ascending key order — the
   * canonical ordered-KV query. Throws if `prefix` is empty (it has no finite
   * upper bound; use {@link range} to scan an explicit interval). The
   * {@link Result} is lazy and re-iterable, like {@link range}. */
  prefix(prefix: string): Result<KvEntry>;
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();
const decode = (b: Uint8Array): string => fromUtf8.decode(b);

/** Encode a string for storage, refusing one that UTF-8 cannot round-trip
 * (a lone surrogate): distinct malformed strings would otherwise silently
 * collide on the same bytes — colliding keys, or a value that reads back as a
 * different string than was stored. */
const encode = (s: string, what: string): Uint8Array => {
  assertWellFormedText(s, what);
  return utf8.encode(s);
};

/** Build a {@link Kv} lens over a {@link Store} (the kernel's `Database`
 * satisfies it, as does any object that can run a transaction). */
export function kv(store: Store): Kv {
  return {
    get(key) {
      return store.transact((tx) => {
        const value = tx.get(encode(key, "key"));
        return value === undefined ? undefined : decode(value);
      });
    },
    set(key, value) {
      store.transact((tx) => {
        tx.set(encode(key, "key"), encode(value, "value"));
      });
      return { changed: 1 };
    },
    delete(key) {
      const changed = store.transact((tx) => {
        const k = encode(key, "key");
        const existed = tx.get(k) !== undefined;
        tx.delete(k);
        return existed ? 1 : 0;
      });
      return { changed };
    },
    range(start, end) {
      return scan(store, encode(start, "range start"), encode(end, "range end"));
    },
    prefix(p) {
      // prefixRange computes the [start, end) bounds on bytes so they agree with
      // the kernel's order, and rejects a prefix with no finite end (an empty
      // string). It runs at call time, so a bad prefix fails here, not on a
      // later iteration; the scan itself stays lazy.
      const { start, end } = prefixRange(encode(p, "prefix"));
      return scan(store, start, end);
    },
  };
}

/**
 * A lazy, re-iterable {@link Result} over the kernel's half-open `[start, end)`
 * byte scan, decoded to string {@link KvEntry} rows. Shared by `range` and
 * `prefix` so the decode-and-materialize step has one definition.
 *
 * The thunk runs on each iteration (laziness + re-iterability come from
 * result()), so every pass observes the current committed state. Rows are
 * materialized inside the read transaction because the kernel's range is only
 * valid within the transaction body; nothing runs until the Result is iterated.
 */
function scan(store: Store, start: Uint8Array, end: Uint8Array): Result<KvEntry> {
  return result(() =>
    store.transact((tx) => {
      const rows: KvEntry[] = [];
      for (const entry of tx.getRange(start, end)) {
        rows.push({ key: decode(entry.key), value: decode(entry.value) });
      }
      return rows;
    }),
  );
}
