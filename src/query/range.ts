/**
 * query/range.ts — the minimal query surface for the key-value lens.
 *
 * This is an edge, not the kernel (DESIGN.md section 5): the open,
 * fast-contribution tier, holding no durability logic. It is deliberately thin
 * — one inspectable value and the single piece of query logic the KV lens lacks.
 *
 * The kernel's native query is a range scan over its ordered keyspace, and the
 * lens already exposes an explicit `[start, end)`. The one ordered-KV query that
 * is both ubiquitous and easy to get wrong is the PREFIX scan ("every key under
 * `user:`"). Its only subtlety is the exclusive upper bound, and the naive
 * string trick (`prefix + "￿"`) is unsound here: the kernel sorts by
 * unsigned BYTE order, not UTF-16 code units, and the two disagree above U+FFFF.
 * So this module computes the bound on raw bytes, where it agrees with the
 * kernel by construction. Working in bytes also keeps the surface shared: the
 * document and relational lenses plan ranges over the same byte keyspace.
 *
 * A {@link KeyRange} is a plain value, not a builder: the query is visible
 * (DESIGN.md principle 2 — query visible by default), so a caller can inspect
 * the exact bounds a scan will use before running it.
 */

/**
 * A half-open key range `[start, end)`: `start` is included, `end` is excluded
 * — the exact contract of the kernel's
 * {@link import("../core.ts").Transaction.getRange}. Bounds are raw bytes, the
 * unit the kernel orders on.
 */
export interface KeyRange {
  readonly start: Uint8Array;
  readonly end: Uint8Array;
}

/**
 * The half-open byte range that selects exactly the keys beginning with
 * `prefix`: `[prefix, upperBound(prefix))`. The start is the prefix itself; the
 * end is the smallest key that no longer carries the prefix (see
 * {@link upperBound}).
 *
 * Throws if `prefix` has no finite upper bound — it is empty, or every byte is
 * already `0xFF`. In that case no `end` key can exclude the next sibling, so a
 * half-open range cannot express the scan; rejecting it loudly is honest
 * (DESIGN.md principle 2) where silently scanning the wrong range would not be.
 */
export function prefixRange(prefix: Uint8Array): KeyRange {
  const end = upperBound(prefix);
  if (end === undefined) {
    throw new Error("libredb: prefix has no finite upper bound (empty or all-0xFF)");
  }
  return { start: prefix, end };
}

/**
 * The smallest key strictly greater than every key beginning with `prefix`:
 * drop the trailing `0xFF` bytes (they are already maximal and cannot be
 * incremented), then add one to the last remaining byte. Returns `undefined`
 * when no such key exists — the prefix is empty, or all of its bytes are `0xFF`.
 *
 * Computed on raw bytes so the result agrees with the kernel's unsigned
 * byte-lexicographic order. A dropped trailing `0xFF` is why the bound can be
 * shorter than the prefix (e.g. `[0x61, 0xFF]` yields `[0x62]`).
 */
function upperBound(prefix: Uint8Array): Uint8Array | undefined {
  let length = prefix.length;
  while (length > 0 && prefix[length - 1] === 0xff) length--;
  if (length === 0) return undefined;
  const bound = prefix.slice(0, length);
  bound[length - 1] = (bound[length - 1] as number) + 1;
  return bound;
}
