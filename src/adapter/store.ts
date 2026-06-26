/**
 * adapter/store.ts — the storage seam a lens depends on.
 *
 * This is an edge, not the kernel: the open, fast-contribution tier (DESIGN.md
 * section 5), holding no durability logic of its own. It names the one thing a
 * lens needs from storage and nothing more.
 *
 * A lens (kv, and later document, relational) is a view over stored bytes. It
 * reads and writes through transactions; it never opens, closes, or recovers the
 * store — that lifecycle belongs to whoever called {@link import("../core.ts").open}.
 * So the seam the lens depends on is exactly one method, `transact`, deliberately
 * NARROWER than the kernel's {@link import("../core.ts").Database} (which also
 * carries `close`). Depending on the narrow port instead of the whole Database
 * keeps the open-edge lenses from binding to the guarded core's lifecycle, and
 * lets any object that can run a transaction back a lens: the kernel today, an
 * async-wrapped or remote core later, a fake in a test. The kernel's `Database`
 * satisfies this port structurally, so the real, durable path runs through it.
 *
 * This is intentionally thin. The seam is a port the lens needs, not an
 * abstraction layer the user pays for — there is no adapter class to subclass,
 * just the minimal contract.
 */
import type { Transaction } from "../core.ts";

/**
 * The minimal storage capability a lens consumes: run a unit of atomic work and
 * return its result. Semantics are the kernel's — see
 * {@link import("../core.ts").Database.transact}.
 */
export interface Store {
  transact<T>(run: (tx: Transaction) => T): T;
}
