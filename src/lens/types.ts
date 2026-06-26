/**
 * lens/types.ts — the shared query/result shape every lens reuses.
 *
 * A lens (kv, document, relational) is a typed view over the kernel in core.ts.
 * Lenses differ wildly in HOW you ask for data — a kv key range, a document
 * filter, a relational SELECT — and that is on purpose: DESIGN.md section 2
 * rejects a single unified query
 * *language* as a lowest-common-denominator trap. So what lenses share is not
 * the query syntax but the RESULT envelope: every read hands back a
 * {@link Result}, every write reports a {@link WriteResult}. Pinning these two
 * shapes once lets later lenses — and the universal tooling above them (Studio,
 * Platform) — consume any lens uniformly without flattening their differences.
 *
 * This file is an edge, not the kernel: it holds no durability logic, only the
 * vocabulary the lenses speak.
 */

/**
 * What every lens read returns: a lazy, typed, re-iterable sequence of rows.
 *
 * `Row` is the lens's own unit — a kv {@link import("../core.ts").Entry}, a
 * document, a relational tuple — so the shape is shared without erasing what
 * each lens actually yields.
 *
 * Lazy and re-iterable are deliberate. The kernel's range scan is itself lazy
 * (`Iterable<Entry>`), so a Result must not force a large scan to materialize
 * just to be wrapped. Re-iterable means a Result behaves like the query it
 * stands for: iterating it twice runs the read twice, instead of the classic
 * generator footgun where the second pass silently yields nothing. Because of
 * that, the Result *is* the deferred query — there is no separate query object
 * to define.
 */
export interface Result<Row> extends Iterable<Row> {
  /** Materialize every row into a fresh array. Convenience over iterating; the
   * returned array is the caller's to keep and mutate. */
  toArray(): Row[];
}

/**
 * The outcome of a lens write.
 *
 * `changed` is the number of stored entries the write created, overwrote, or
 * removed. It is uniform across lenses (a kv set is 1, a delete of an absent
 * key is 0, a relational UPDATE is its matched-row count) and keeps writes
 * visible by default (DESIGN.md principle 2): a caller can always see what a
 * write actually did.
 */
export interface WriteResult {
  readonly changed: number;
}

/**
 * Build a {@link Result} from a source of rows.
 *
 * `source` is a thunk, not an iterable, so the read is deferred and repeatable:
 * nothing runs until the Result is iterated, and each iteration calls `source`
 * again for a fresh pass. Every lens constructs its reads through this one
 * helper so "what a Result is" has a single definition.
 */
export function result<Row>(source: () => Iterable<Row>): Result<Row> {
  return {
    [Symbol.iterator]() {
      return source()[Symbol.iterator]();
    },
    toArray() {
      return [...source()];
    },
  };
}
