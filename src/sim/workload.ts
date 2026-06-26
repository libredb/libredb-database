/**
 * workload.ts — the DST workload generator and its model oracle (plan S3).
 *
 * Two halves of the deterministic-simulation reliability bar (DESIGN.md
 * section 6.4):
 *
 *   - the WORKLOAD: a seeded, deterministic sequence of transactions
 *     (`set`/`delete` ops, some deliberately aborted) driven against the kernel;
 *   - the ORACLE: a model — a plain committed map — updated ONLY when a
 *     transaction commits. It is the independent re-derivation of "what should
 *     survive" that the crash/recovery runner (S4) compares the recovered state
 *     against.
 *
 * The oracle is deliberately plain code and shares NO logic with the kernel it
 * judges: if the model reused the engine's apply path, a bug in that path would
 * hide in both and the comparison would be vacuous. The two must agree only by
 * both being correct.
 */
import type { Database } from "../core.ts";
import { mulberry32 } from "./prng.ts";

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

/**
 * Every workload key starts with this single byte. Keeping the keyspace under
 * one prefix lets {@link dump} read the whole committed state with one ordered
 * range scan whose exclusive upper bound is the next byte (`'k'` -> `'l'`).
 */
const KEY_PREFIX = "k";

/** One mutation inside a transaction. Reads are not part of the committed-state
 * oracle, so the workload only ever sets or deletes. */
type WorkloadOp =
  | { readonly kind: "set"; readonly key: string; readonly value: string }
  | { readonly kind: "delete"; readonly key: string };

/** One transaction: a batch of ops applied atomically. When `abort` is true the
 * body throws after staging its ops, so the kernel rolls the whole transaction
 * back and the oracle must record none of its writes. */
export interface WorkloadStep {
  readonly ops: readonly WorkloadOp[];
  readonly abort: boolean;
}

/** Knobs for {@link generateWorkload}; all have defaults so a seed alone is a
 * complete, reproducible specification of a run. */
export interface WorkloadOptions {
  /** Number of transactions to generate. */
  readonly steps?: number;
  /** Size of the key pool (small, so keys collide and overwrites/deletes of
   * live keys actually happen). */
  readonly keys?: number;
  /** Maximum ops per transaction (each transaction has 1..maxOps). */
  readonly maxOps?: number;
  /** Probability a transaction aborts rather than commits. */
  readonly abortRate?: number;
}

/**
 * Thrown by {@link runWorkload} to abort an intended-abort transaction. It is a
 * named type so the runner can swallow exactly this and let every other error
 * (a real kernel/IO fault) propagate — the difference that keeps the DST honest.
 */
class WorkloadAbort extends Error {
  constructor() {
    super("workload: intended abort");
  }
}

/**
 * Generate a deterministic workload from `seed`. The same seed and options
 * always produce the identical sequence, so any failing run replays exactly.
 */
export function generateWorkload(seed: number, options: WorkloadOptions = {}): WorkloadStep[] {
  const stepCount = options.steps ?? 100;
  const keyCount = options.keys ?? 16;
  const maxOps = options.maxOps ?? 4;
  const abortRate = options.abortRate ?? 0.2;

  const rng = mulberry32(seed);
  const steps: WorkloadStep[] = [];
  let valueSeq = 0;
  for (let s = 0; s < stepCount; s++) {
    const opCount = 1 + Math.floor(rng() * maxOps);
    const ops: WorkloadOp[] = [];
    for (let o = 0; o < opCount; o++) {
      const key = KEY_PREFIX + Math.floor(rng() * keyCount);
      if (rng() < 0.7) {
        ops.push({ kind: "set", key, value: "v" + valueSeq++ });
      } else {
        ops.push({ kind: "delete", key });
      }
    }
    steps.push({ ops, abort: rng() < abortRate });
  }
  return steps;
}

/**
 * The oracle: the committed state the workload should leave behind. Applies
 * each non-aborted transaction's ops in order (last write wins, a delete
 * removes); aborted transactions contribute nothing.
 */
export function modelAfter(steps: readonly WorkloadStep[]): Map<string, string> {
  const model = new Map<string, string>();
  for (const step of steps) {
    if (step.abort) continue; // aborted: rolled back, nothing commits
    for (const op of step.ops) {
      if (op.kind === "set") model.set(op.key, op.value);
      else model.delete(op.key);
    }
  }
  return model;
}

/**
 * Drive `steps` against `db`, one transaction per step. An intended-abort step
 * throws a {@link WorkloadAbort} after staging its ops so the kernel rolls it
 * back; that one error is swallowed. Any other error propagates — a genuine
 * fault must never be mistaken for a planned abort.
 */
export function runWorkload(db: Database, steps: readonly WorkloadStep[]): void {
  for (const step of steps) {
    try {
      db.transact((tx) => {
        for (const op of step.ops) {
          if (op.kind === "set") {
            tx.set(utf8.encode(op.key), utf8.encode(op.value));
          } else {
            tx.delete(utf8.encode(op.key));
          }
        }
        if (step.abort) throw new WorkloadAbort();
      });
    } catch (error) {
      if (error instanceof WorkloadAbort) continue;
      throw error;
    }
  }
}

/**
 * Read the entire committed state of `db` as a string map — the form the oracle
 * is compared against. One ordered range scan over the whole keyspace
 * (`[KEY_PREFIX, next byte)`), which covers every key the workload can emit.
 */
export function dump(db: Database): Map<string, string> {
  const start = utf8.encode(KEY_PREFIX);
  const end = Uint8Array.from(start);
  end[end.length - 1] = (end[end.length - 1] as number) + 1; // 'k' -> 'l'
  return db.transact((tx) => {
    const out = new Map<string, string>();
    for (const entry of tx.getRange(start, end)) {
      out.set(fromUtf8.decode(entry.key), fromUtf8.decode(entry.value));
    }
    return out;
  });
}
