/**
 * simfs.ts — SimFS, the seeded crash-injecting filesystem for DST (DESIGN.md
 * section 6.4 / plan S2).
 *
 * SimFS is a TEST HARNESS, not shipped code: it is excluded from the build
 * (tsconfig.build.json) and never reaches the npm package. It implements the
 * kernel's {@link FileSystem}/{@link WalFile} seam entirely in memory so the
 * write-ahead log's crash/recovery path can be tortured without a real disk.
 *
 * The durability model is the whole point and is deliberately literal. Each
 * simulated file holds two byte pools:
 *
 *   - `durable`  bytes confirmed by an fsync. They ALWAYS survive a crash.
 *   - `pending`  bytes appended since the last fsync. A crash keeps only a
 *                seeded-length PREFIX of them — the "torn tail" — and discards
 *                the rest.
 *
 * That is the exact POSIX append+fsync guarantee the WAL relies on: a crash can
 * only ever damage the last, un-fsync'd record, so recovery can trust every
 * record up to the first torn/corrupt one. Everything is driven by a seeded
 * PRNG, so any failure is replayable byte-for-byte from its seed.
 */
import type { FileSystem, WalFile } from "../core.ts";
import { mulberry32 } from "./prng.ts";

/** The persisted state of one simulated file: fsync'd bytes plus the not-yet
 * durable tail. See the module comment for the crash semantics. */
interface SimFile {
  durable: number[];
  pending: number[];
}

/**
 * A seeded, in-memory filesystem that can simulate crashes and inject IO
 * faults. Construct it with a seed, open files through the {@link FileSystem}
 * interface (so the kernel drives it exactly as it would a real disk), then
 * call {@link SimFS.crash} / {@link SimFS.corrupt} / {@link SimFS.armShortRead}
 * to torture recovery.
 */
export class SimFS implements FileSystem {
  private readonly random: () => number;
  private readonly files = new Map<string, SimFile>();
  /** When set, the NEXT read returns a seeded-short prefix, then disarms. */
  private shortReadArmed = false;
  /** When set, the NEXT append persists only a seeded STRICT prefix of its
   * bytes, then throws — a partial write cut short by ENOSPC/EIO. */
  private appendErrorArmed = false;
  /** When set, the NEXT fsync throws — the bytes stay pending (not durable),
   * modelling a durability point that failed after the write. */
  private fsyncErrorArmed = false;

  constructor(seed: number) {
    this.random = mulberry32(seed);
  }

  open(path: string): WalFile {
    let file = this.files.get(path);
    if (file === undefined) {
      file = { durable: [], pending: [] };
      this.files.set(path, file);
    }
    const f = file;
    return {
      size: () => f.durable.length + f.pending.length,
      read: (offset, length) => this.readFrom(f, offset, length),
      append: (b) => {
        if (this.appendErrorArmed) {
          this.appendErrorArmed = false;
          // A STRICT prefix (never the full record): the fault is "the write
          // was cut short", so the record on disk must be torn.
          const kept = Math.floor(this.random() * b.length);
          for (const byte of b.subarray(0, kept)) f.pending.push(byte);
          throw new Error("simfs: injected append fault (ENOSPC)");
        }
        for (const byte of b) f.pending.push(byte);
      },
      fsync: () => {
        if (this.fsyncErrorArmed) {
          this.fsyncErrorArmed = false;
          throw new Error("simfs: injected fsync fault (EIO)");
        }
        f.durable = f.durable.concat(f.pending);
        f.pending = [];
      },
      truncate: (length) => this.truncateTo(f, length),
      // A real close() does NOT make pending bytes durable; only fsync does.
      // The pools persist on the SimFS across close/reopen, like a real file.
      close: () => {},
    };
  }

  /** Arm a one-shot append fault: the next {@link WalFile.append} persists a
   * seeded strict prefix of its bytes and throws. The torn record this leaves
   * is exactly the poisoned-tail scenario the kernel's failure latch exists
   * for (audit finding B3 / fsyncgate). */
  armAppendError(): void {
    this.appendErrorArmed = true;
  }

  /** Arm a one-shot fsync fault: the next {@link WalFile.fsync} throws and the
   * appended bytes stay in the un-fsync'd (crash-tearable) pending pool. */
  armFsyncError(): void {
    this.fsyncErrorArmed = true;
  }

  /**
   * Simulate a process/power crash. For every open file the fsync'd bytes are
   * kept in full and the un-fsync'd tail is truncated to a seeded length in
   * [0, pending.length] — modelling the last append being torn anywhere from
   * "nothing reached disk" to "all of it did". The kept prefix becomes durable
   * (it is what survived); the rest is gone.
   */
  crash(): void {
    for (const f of this.files.values()) {
      const kept = Math.floor(this.random() * (f.pending.length + 1));
      f.durable = f.durable.concat(f.pending.slice(0, kept));
      f.pending = [];
    }
  }

  /**
   * Flip every bit of one durable byte, simulating on-disk corruption (bit
   * rot, a torn sector). The record containing that byte then fails its CRC
   * check, so recovery drops it as a damaged tail. Throws on an unknown path or
   * an offset outside the durable region.
   */
  corrupt(path: string, offset: number): void {
    const f = this.fileAt(path);
    const original = f.durable[offset];
    if (original === undefined) {
      throw new Error(`simfs: corrupt offset ${offset} out of range for "${path}"`);
    }
    f.durable[offset] = original ^ 0xff;
  }

  /** Arm a one-shot short read: the next {@link WalFile.read} returns a
   * seeded-short prefix of what was asked for, then normal reads resume. Models
   * a read() syscall that returns fewer bytes than requested. */
  armShortRead(): void {
    this.shortReadArmed = true;
  }

  /** The durable (crash-surviving) bytes of `path`, for test inspection. */
  durableBytes(path: string): Uint8Array {
    return Uint8Array.from(this.fileAt(path).durable);
  }

  private readFrom(f: SimFile, offset: number, length: number): Uint8Array {
    const content = f.durable.concat(f.pending);
    let end = Math.min(offset + length, content.length);
    if (this.shortReadArmed) {
      this.shortReadArmed = false;
      // Return strictly fewer than the bytes available from `offset`.
      end = offset + Math.floor(this.random() * (end - offset));
    }
    return Uint8Array.from(content.slice(offset, end));
  }

  private truncateTo(f: SimFile, length: number): void {
    if (length >= f.durable.length + f.pending.length) return; // nothing to drop
    if (length <= f.durable.length) {
      f.durable.length = length;
      f.pending = [];
    } else {
      f.pending.length = length - f.durable.length;
    }
  }

  private fileAt(path: string): SimFile {
    const f = this.files.get(path);
    if (f === undefined) throw new Error(`simfs: no file at "${path}"`);
    return f;
  }
}
