/**
 * dst.ts — the deterministic-simulation crash/recovery runner (plan S4).
 *
 * This is the reliability bar promised in DESIGN.md section 6.4: torture the
 * WAL's crash/recovery path under a seeded simulated filesystem and assert the
 * recovered state is always a valid committed prefix — never a partial
 * transaction, never fabricated data. It composes the three S1-S3 pieces:
 *
 *   - the injectable FS seam (core.ts {@link open} accepts an `fs`);
 *   - the crash-injecting {@link SimFS} (S2);
 *   - the seeded workload + committed-map model oracle (S3).
 *
 * Everything is driven by one integer seed, so any failing run replays
 * byte-for-byte from {@link runSeed} — the deterministic replay entry point the
 * suite reports on failure.
 *
 * Like the rest of `src/sim/`, this is TEST HARNESS code: it is excluded from
 * the package build (tsconfig.build.json) and never ships on npm.
 */
import { open } from "../core.ts";
import { SimFS } from "./simfs.ts";
import {
  dump,
  generateWorkload,
  modelAfter,
  runWorkload,
  type WorkloadOptions,
  type WorkloadStep,
} from "./workload.ts";

/** The single WAL path every simulated run opens. The SimFS keeps one file per
 * path, so the workload, the crash, and the reopen all address the same log. */
const WAL_PATH = "wal";

/** True when two string maps hold exactly the same keys and values. The DST
 * comparison reduces to this: recovered store vs. model oracle. */
export function mapEqual(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

/**
 * The committed states reachable after each PREFIX of the successfully-committed
 * transactions in `steps`. `states[0]` is the empty starting state; `states[i]`
 * is the state after the first `i` committed (non-aborted) transactions; the
 * last entry is the full model. Aborted transactions contribute nothing, so
 * they are not prefix boundaries.
 *
 * This is the full crash-recovery invariant made checkable: after any crash,
 * torn tail, corruption or short read, the recovered store must equal ONE of
 * these — a complete committed prefix, never a torn half-transaction. The test
 * suite asserts exactly this (via {@link isCommittedPrefix}) for the corruption
 * and short-read cases, where dropping a mid-log record makes a SHORTER prefix
 * the legal outcome. {@link runSeed}'s own `passed` check is the stricter special
 * case — full-model equality — because its workload fsyncs every commit, so the
 * only un-fsync'd (tearable) bytes are the injected tail and the only legal
 * recovered state is the whole model.
 */
export function committedPrefixStates(steps: readonly WorkloadStep[]): Map<string, string>[] {
  const states: Map<string, string>[] = [new Map()];
  const current = new Map<string, string>();
  for (const step of steps) {
    if (step.abort) continue; // aborted: never a durable record, never a prefix
    for (const op of step.ops) {
      if (op.kind === "set") current.set(op.key, op.value);
      else current.delete(op.key);
    }
    states.push(new Map(current)); // snapshot this prefix
  }
  return states;
}

/** True when `state` equals one of the acceptable committed prefixes. */
export function isCommittedPrefix(state: Map<string, string>, acceptable: readonly Map<string, string>[]): boolean {
  return acceptable.some((candidate) => mapEqual(state, candidate));
}

/** The outcome of one simulated seed: what recovery produced, what the model
 * says should survive, and whether they matched. */
export interface SeedResult {
  readonly seed: number;
  readonly recovered: Map<string, string>;
  readonly expected: Map<string, string>;
  readonly passed: boolean;
}

/**
 * Append a torn in-flight record to the un-fsync'd tail of the log, WITHOUT
 * fsync, so the next {@link SimFS.crash} can tear it. The header promises 0xffff
 * payload bytes but only three are provided, so however the crash tears it the
 * record can never recover to a valid frame — exactly a commit interrupted by
 * power loss before its fsync. Recovery must always discard it. Exported so
 * the test suite can compose it into multi-cycle crash schedules.
 *
 * Synchronous append+fsync means the kernel itself can never leave un-fsync'd
 * bytes between commits, so injecting this partial write is the honest way to
 * reproduce the one moment a crash can damage an append-only log: mid-record.
 */
export function injectTornTail(fs: SimFS): void {
  fs.open(WAL_PATH).append(Uint8Array.from([0, 0, 0xff, 0xff, 0, 0, 0, 0, 1, 2, 3]));
}

/**
 * Run one seed end-to-end and return the result. Deterministic: the same seed
 * (and options) always produces the identical run, so this doubles as the
 * replay entry point for a failing seed.
 *
 * The procedure: build a {@link SimFS} from the seed, open the WAL on it, run
 * the seeded workload (every commit fsync'd, hence durable), inject a torn
 * in-flight append, crash (keeps all durable bytes, tears the un-fsync'd tail at
 * a seeded point), reopen, and compare the recovered store to the committed
 * model. The invariant: recovery discards the torn tail and reproduces exactly
 * the committed model. Strict full-model equality is the right check HERE
 * because every workload commit is fsync'd (only the injected tail is tearable);
 * the more general "recovered is SOME committed prefix" invariant — for crashes
 * that drop a mid-log record — lives in {@link committedPrefixStates} /
 * {@link isCommittedPrefix}, which the test suite asserts on every seed.
 */
export function runSeed(seed: number, options?: WorkloadOptions): SeedResult {
  const fs = new SimFS(seed);
  const steps = generateWorkload(seed, options);

  // Run the workload, then simulate a crash WITHOUT a graceful close.
  runWorkload(open({ path: WAL_PATH, fs }), steps);
  const expected = modelAfter(steps);

  injectTornTail(fs);
  fs.crash();

  const recovered = dump(open({ path: WAL_PATH, fs }));
  return { seed, recovered, expected, passed: mapEqual(recovered, expected) };
}

/** Render a string map as a stable, sorted `{k=v, ...}` for failure messages. */
function mapToString(map: Map<string, string>): string {
  return (
    "{" +
    [...map.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${key}=${value}`)
      .join(", ") +
    "}"
  );
}

/** A human-readable invariant-violation report that names the seed and gives a
 * one-line replay hint — the failing seed is all a maintainer needs to reproduce
 * the run exactly. */
export function describeFailure(result: SeedResult): string {
  return (
    `DST invariant violated for seed ${result.seed}: ` +
    `recovered ${mapToString(result.recovered)} != ` +
    `expected ${mapToString(result.expected)}. ` +
    `Replay with runSeed(${result.seed}).`
  );
}
