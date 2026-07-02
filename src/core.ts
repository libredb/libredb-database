/**
 * core.ts — the LibreDB kernel.
 *
 * This file is the trust boundary, the comprehension boundary, and the
 * architecture boundary all at once (see DESIGN.md section 5). Everything that
 * touches durability lives here and nowhere else:
 *
 *   - storage      an ordered key-value substrate
 *   - transactions atomic apply with the isolation scoped in DESIGN.md
 *   - recovery     survive a crash and reopen with consistent state
 *
 * The kernel is small because it is genuinely minimal, never because
 * complexity was swept into sibling files. Model lenses (lens/kv.ts,
 * lens/document.ts, lens/relational.ts) sit on top of this; they never
 * reach around it.
 *
 * The boundaries are declared first as types — the contract every lens builds
 * on — followed by the implementation: an ordered key-value store, serializable
 * transactions, and a write-ahead log for durability. Recovery replays that log,
 * discards a record a crash left half-written, and refuses to touch a file it
 * does not recognize as a LibreDB database.
 */

/** The LibreDB package version. Kept in sync with package.json. */
export const version = "0.1.3";

/**
 * The stable failure codes of the kernel. Every error the kernel throws is a
 * {@link LibreDbError} carrying one of these, so a caller can branch on `code`
 * instead of matching message strings (which the package is free to reword).
 *
 *   - CLOSED               the database was closed; open a new one
 *   - NESTED_TRANSACTION   transact() called inside a transaction body
 *   - ASYNC_TRANSACTION    the transaction body returned a Promise/thenable
 *   - CLOSE_IN_TRANSACTION close() called inside a transaction body
 *   - FAILED               a commit hit an IO error; reopen to recover
 *   - NOT_A_DATABASE       the file at `path` is not a LibreDB database
 *   - UNSUPPORTED_VERSION  the file was written by a newer format version
 *   - CORRUPT_WAL          mid-log corruption; refusing to destroy data
 *   - INCOMPLETE_READ      the filesystem returned fewer bytes than it holds
 *   - LOCKED               another writer holds the database open
 *   - INVALID_ARGUMENT     a malformed argument (empty path, missing fs)
 */
export type ErrorCode =
  | "CLOSED"
  | "NESTED_TRANSACTION"
  | "ASYNC_TRANSACTION"
  | "CLOSE_IN_TRANSACTION"
  | "FAILED"
  | "NOT_A_DATABASE"
  | "UNSUPPORTED_VERSION"
  | "CORRUPT_WAL"
  | "INCOMPLETE_READ"
  | "LOCKED"
  | "INVALID_ARGUMENT";

/**
 * The error type of the kernel (and of the adapters that implement its
 * filesystem seam). The `code` is the stable contract; the message is for
 * humans and may change between releases.
 */
export class LibreDbError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(`libredb: ${message}`, options);
    this.name = "LibreDbError";
    this.code = code;
  }
}

/**
 * A key in the kernel: an immutable sequence of bytes.
 *
 * Keys are bytes, not strings, on purpose. Byte order is unambiguous and
 * stable (unlike JavaScript's UTF-16 string order), and only bytes let the
 * higher lenses build COMPOSITE keys by concatenation and scan them as ranges
 * — the move the whole multi-model architecture rests on. The kv lens adds
 * string ergonomics on top; the kernel stays at the honest substrate.
 */
export type Key = Uint8Array;

/** A value in the kernel: an opaque sequence of bytes. The kernel never
 * interprets a value; serialization is a lens concern, not a kernel one. */
export type Value = Uint8Array;

/** One key/value pair yielded by an ordered range scan. */
export interface Entry {
  readonly key: Key;
  readonly value: Value;
}

/**
 * The unit of atomic work against the kernel.
 *
 * Every read and write happens inside a transaction — it is the kernel's one
 * atomicity primitive. Within a transaction, reads observe the transaction's
 * own pending writes (read-your-writes). Across transactions the isolation
 * level is SERIALIZABLE: the synchronous, single-threaded API runs each body to
 * completion before the next begins, so the schedule is always serial. The
 * kernel forbids re-entrant transactions (the only way to overlap two) to keep
 * that guarantee real — see {@link Database.transact}.
 *
 * Buffer ownership: the kernel COPIES every key and value that crosses this
 * boundary, in both directions. A caller may freely reuse a scratch buffer
 * after set()/delete(), and may freely mutate anything get()/getRange()
 * returned — neither can corrupt the committed store.
 *
 * Keys are ordered by unsigned byte-lexicographic comparison. That ordering is
 * the kernel's defining property: it is what makes `getRange` meaningful and
 * what later lenses encode their indexes against.
 */
export interface Transaction {
  /** The value for `key` (a copy), or `undefined` if it is not set. */
  get(key: Key): Value | undefined;
  /** Set `key` to `value`, overwriting any existing value. Both are copied. */
  set(key: Key, value: Value): void;
  /** Remove `key`. A no-op if it is not set. */
  delete(key: Key): void;
  /**
   * Scan the half-open range `[start, end)` in ascending key order:
   * `start` is included, `end` is excluded. The matching entries are
   * SNAPSHOTTED when iteration starts (at the first `next()`), so mutating the
   * transaction while scanning — the delete-what-you-find pattern — visits
   * every entry exactly once; the writes are visible to reads and to later
   * scans, not to this one.
   */
  getRange(start: Key, end: Key): Iterable<Entry>;
}

/**
 * An open kernel instance: the storage substrate plus its durability.
 *
 * The API is synchronous. LibreDB is embedded and single-process (its first
 * home is test/dev), and SQLite shows a synchronous core is both correct and
 * far easier to read than one colored by promises everywhere. Durability uses
 * synchronous fsync (see the write-ahead log further down).
 */
export interface Database {
  /**
   * Run `run` inside a transaction and apply its writes atomically. If `run`
   * returns, the writes commit together and become durable; if `run` throws,
   * the transaction aborts and applies nothing. The return value of `run` is
   * passed through.
   *
   * `run` MUST be synchronous. An async callback returns a pending Promise —
   * the kernel cannot see writes made after an `await`, so committing at that
   * point would silently lose them. Any thenable return value therefore
   * aborts the transaction with {@link ErrorCode} ASYNC_TRANSACTION.
   *
   * If a commit fails to reach the disk (the append or fsync throws), the
   * database LATCHES into a failed state: every later transact() throws with
   * code FAILED until the database is closed and reopened. Continuing to
   * append after a torn write could let recovery silently discard later,
   * acknowledged commits — refusing further writes is what keeps "a returned
   * transact() is durable" true.
   */
  transact<T>(run: (tx: Transaction) => T): T;
  /** Flush pending state and release resources. Safe to call once. Throws if
   * called from inside a transaction body. */
  close(): void;
}

/**
 * The filesystem the write-ahead log runs on — the kernel's one IO seam.
 *
 * The kernel never calls `node:fs` directly; every byte that reaches the disk
 * goes through this interface. That keeps the IO boundary explicit and in one
 * place (a readability gain), and it lets a test inject a simulated filesystem
 * to torture crash recovery without a real disk (DESIGN.md section 6.4). The
 * kernel carries NO default filesystem: a path-backed open must be given one.
 * The Node entry (index.ts) supplies a `node:fs`-backed adapter by default; the
 * browser entry supplies none. The interface is deliberately the SMALLEST set
 * of operations the WAL performs and nothing more.
 */
export interface FileSystem {
  /** Open the log file at `path` for reading and appending, creating it if it
   * is absent, and return a handle to it. */
  open(path: string): WalFile;
  /**
   * Optional: take an exclusive advisory lock on the database at `path`,
   * returning a function that releases it. A filesystem that implements this
   * makes double-open loud: the kernel calls it before touching the file and
   * expects a second concurrent lock of the same path to throw with code
   * LOCKED. A filesystem without it (a read-only inspector, a test fake)
   * simply opts out of the protection.
   */
  lock?(path: string): () => void;
}

/**
 * An open handle to a write-ahead log file: exactly the operations the WAL
 * performs on it. Writes are append-only; recovery reads the file and may
 * truncate a torn tail.
 */
export interface WalFile {
  /** The number of bytes currently in the file. */
  size(): number;
  /** Read `length` bytes starting at `offset`. May return fewer only when the
   * file itself ends early; the kernel treats a short read of bytes the file
   * claims to hold as an IO fault, never as missing data. */
  read(offset: number, length: number): Uint8Array;
  /** Append `bytes` to the end of the file. */
  append(bytes: Uint8Array): void;
  /** Flush appended bytes to durable storage. After this returns the bytes
   * survive a crash — the durability point of a commit. */
  fsync(): void;
  /** Shrink the file to `length` bytes, dropping anything after it. */
  truncate(length: number): void;
  /** Release the handle. */
  close(): void;
}

/** What recovery had to do to the log, reported through
 * {@link OpenOptions.onRecovery} so a torn-tail truncation is never silent. */
export interface RecoveryInfo {
  /** Bytes discarded from the tail of the log: the remains of a commit a crash
   * interrupted mid-append. Always > 0 when the callback fires. */
  readonly truncatedBytes: number;
}

/**
 * How to open a kernel instance.
 *
 * With `path`, the kernel is file-backed and durable: reopening the same path
 * after a crash reconstructs exactly the committed state. Without `path`, the
 * kernel is purely in-memory — the natural fit for tests and ephemeral use.
 */
export interface OpenOptions {
  readonly path?: string;
  /**
   * The filesystem the write-ahead log runs on. Optional at the type level, but a
   * path-backed open needs one at runtime: the kernel and the browser entry throw
   * when `path` is given without `fs`, while the Node entry (index.ts) supplies a
   * `node:fs` adapter by default so `open({ path })` works there. Injecting one
   * lets tests simulate crashes and IO faults deterministically (DESIGN.md section
   * 6.4). Ignored when there is no `path` (an in-memory database never touches a
   * filesystem).
   */
  readonly fs?: FileSystem;
  /**
   * Called when recovery discarded a torn tail — the bytes of a commit a crash
   * interrupted, which were never acknowledged as durable. This is the expected
   * crash-model outcome, not corruption (corruption refuses to open instead),
   * but it should never be invisible; pass a callback to log or count it.
   */
  readonly onRecovery?: (info: RecoveryInfo) => void;
}

/** The signature of the kernel's entry point (see {@link open} for the
 * implementation). Naming the contract separately lets lenses depend on it. */
export type Open = (options?: OpenOptions) => Database;

// ---------------------------------------------------------------------------
// Implementation
//
// The store is a single array of entries kept sorted by unsigned
// byte-lexicographic key order. That ordering is not an implementation detail
// to hide behind a Map — it IS the kernel's defining property, so the code
// compares raw bytes directly. Locating a key is a binary search; a range scan
// is "find the start, walk until the end". Nothing more elaborate is justified
// yet: comprehension is the budget (DESIGN.md section 3), not throughput.
// ---------------------------------------------------------------------------

/** One stored key/value pair. Identical in shape to {@link Entry}; the distinct
 * name marks a value living in the committed store rather than one handed back
 * to a caller. The buffers are owned by the kernel: they were copied on the way
 * in and are copied again on the way out, so no caller ever aliases them. */
interface StoredEntry {
  readonly key: Key;
  readonly value: Value;
}

/**
 * Compare two keys by unsigned byte-lexicographic order: the first differing
 * byte decides, and if one key is a prefix of the other the shorter sorts
 * first. Returns <0, 0, or >0 like every comparator.
 *
 * Bytes are unsigned (0..255) because they come from a Uint8Array, so this is
 * the byte order a sorted file would use — not JavaScript's UTF-16 string
 * order, where "10" would sort before "2".
 */
function compareKeys(a: Key, b: Key): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const delta = (a[i] as number) - (b[i] as number);
    if (delta !== 0) return delta;
  }
  return a.length - b.length;
}

/**
 * Binary-search a sorted entry array for `key`. Returns whether it is present
 * and the index: the entry's own index if found, otherwise the index at which
 * inserting would keep the array sorted.
 */
function locate(entries: readonly StoredEntry[], key: Key): { readonly found: boolean; readonly index: number } {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const order = compareKeys((entries[mid] as StoredEntry).key, key);
    if (order === 0) return { found: true, index: mid };
    if (order < 0) low = mid + 1;
    else high = mid;
  }
  return { found: false, index: low };
}

/** Set `key` to `value` in a sorted entry array, keeping it sorted. Shared by
 * live transaction writes and by log replay during recovery, so "what a set
 * means" has exactly one definition. */
function applySet(entries: StoredEntry[], key: Key, value: Value): void {
  const { found, index } = locate(entries, key);
  if (found) entries[index] = { key, value };
  else entries.splice(index, 0, { key, value });
}

/** Remove `key` from a sorted entry array. A no-op if it is absent. Shared by
 * live writes and log replay (see {@link applySet}). */
function applyDelete(entries: StoredEntry[], key: Key): void {
  const { found, index } = locate(entries, key);
  if (found) entries.splice(index, 1);
}

/**
 * One mutation recorded by a transaction: the redo record the write-ahead log
 * persists on commit and replays on recovery. Reads are not journaled — only
 * the changes that must outlive a crash.
 */
type Op =
  | { readonly kind: "set"; readonly key: Key; readonly value: Value }
  | { readonly kind: "delete"; readonly key: Key };

/** Is `value` a thenable — the duck-typed shape `await` would latch onto?
 * Used to reject async transaction bodies (see {@link Database.transact}). */
function isThenable(value: unknown): boolean {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * A transaction backed by `working`, a mutable snapshot of the committed store.
 * Reads and writes hit the snapshot directly, which is what gives
 * read-your-writes; the caller commits or discards the snapshot as a whole.
 * Every mutation is also appended to `journal`, the redo record a durable
 * database writes to its log on commit (and ignores when purely in-memory).
 *
 * Every buffer is copied at this boundary — caller buffers on the way in,
 * kernel buffers on the way out — so no caller mutation can ever reach the
 * committed store or desynchronize memory from disk.
 */
function makeTransaction(working: StoredEntry[], journal: Op[]): Transaction {
  return {
    get(key) {
      const { found, index } = locate(working, key);
      return found ? (working[index] as StoredEntry).value.slice() : undefined;
    },
    set(key, value) {
      // One copy each, shared by the store and the journal: both treat entries
      // as immutable, so sharing the copy is safe and halves the allocations.
      const ownedKey = key.slice();
      const ownedValue = value.slice();
      applySet(working, ownedKey, ownedValue);
      journal.push({ kind: "set", key: ownedKey, value: ownedValue });
    },
    delete(key) {
      const ownedKey = key.slice();
      applyDelete(working, ownedKey);
      journal.push({ kind: "delete", key: ownedKey });
    },
    *getRange(start, end) {
      // Snapshot the matching entries when iteration starts (a generator body
      // runs at the first next()). Walking the live array by index instead
      // would let a delete-during-scan shift entries under the cursor and
      // silently skip them — the classic delete-while-scanning bug.
      // locate() returns the first index whose key is >= start (the insertion
      // point), so the scan is naturally inclusive of start. It stops at the
      // first key that is not < end, making the range half-open [start, end).
      const snapshot: Entry[] = [];
      for (let i = locate(working, start).index; i < working.length; i++) {
        const entry = working[i] as StoredEntry;
        if (compareKeys(entry.key, end) >= 0) break;
        snapshot.push({ key: entry.key.slice(), value: entry.value.slice() });
      }
      yield* snapshot;
    },
  };
}

// ---------------------------------------------------------------------------
// Durability: a write-ahead log
//
// Without a path the kernel is purely in-memory. With one, durability is a
// write-ahead log (a redo log): every committed transaction is appended to the
// file as a single record and fsync'd BEFORE the commit becomes visible, so a
// returned transact() is durable. Recovery replays the records in order to
// rebuild the store. This is the same mechanism real databases use, written
// plainly so the file still teaches how durability works.
//
// On-disk layout = an 8-byte file header followed by records:
//   header: [4-byte magic "LRDB"][u16 formatVersion][u16 reserved]
//   record: [u32 payloadLength][u32 crc32(payload)][payload]
// The magic is what lets open() refuse a file that is NOT a LibreDB database
// instead of misparsing arbitrary bytes (and destroying them); the version is
// what lets the format evolve without ambushing older readers. Files written
// by v0.1.x predate the header; recovery still reads them (see recover()).
//
// The payload is the transaction's mutations back to back. Each op is:
//   set:    [u8 1][u32 keyLength][key][u32 valueLength][value]
//   delete: [u8 0][u32 keyLength][key]
// Integers are big-endian. Because the log is append-only and fsync'd, a crash
// can only ever damage the LAST record, so recovery trusts every record up to
// the end of the file, truncates a torn tail away — and treats a bad record
// with intact records AFTER it as what it really is: corruption, which refuses
// the open rather than silently truncating committed data.
// ---------------------------------------------------------------------------

const OP_SET = 1;
const OP_DELETE = 0;
/** Bytes in a record header: the payload length and its checksum, both u32. */
const RECORD_HEADER = 8;
/** The file magic: "LRDB" in ASCII. A file that does not start with it (and
 * does not parse as a headerless v0.1.x log) is refused, untouched. */
const MAGIC = Uint8Array.of(0x4c, 0x52, 0x44, 0x42);
/** The on-disk format version this kernel writes and the newest it reads. */
const FORMAT_VERSION = 1;
/** Bytes in the file header: magic, u16 version, u16 reserved. */
const FILE_HEADER = 8;

/** Write `value` as a big-endian u32 at `offset`. */
function writeU32(out: Uint8Array, offset: number, value: number): void {
  out[offset] = (value >>> 24) & 0xff;
  out[offset + 1] = (value >>> 16) & 0xff;
  out[offset + 2] = (value >>> 8) & 0xff;
  out[offset + 3] = value & 0xff;
}

/** Read a big-endian u32 from `offset`. The top byte is multiplied, not
 * shifted: `<< 24` would land on the sign bit and yield a negative int. */
function readU32(buffer: Uint8Array, offset: number): number {
  return (
    ((buffer[offset] as number) * 0x1000000 +
      ((buffer[offset + 1] as number) << 16) +
      ((buffer[offset + 2] as number) << 8) +
      (buffer[offset + 3] as number)) >>>
    0
  );
}

/**
 * CRC-32 (IEEE 802.3 polynomial), computed without a lookup table to keep the
 * mechanism in plain sight. It lets recovery tell a fully-written record from
 * one a crash left half-flushed.
 */
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] as number;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Encode the 8-byte file header a new database starts with. */
function encodeFileHeader(): Uint8Array {
  const header = new Uint8Array(FILE_HEADER);
  header.set(MAGIC, 0);
  header[4] = (FORMAT_VERSION >>> 8) & 0xff;
  header[5] = FORMAT_VERSION & 0xff;
  // Bytes 6-7 are reserved and stay zero.
  return header;
}

/** Encode one committed transaction's ops as a length-framed, checksummed
 * record ready to append to the log. */
function encodeRecord(ops: readonly Op[]): Uint8Array {
  let size = 0;
  for (const op of ops) {
    size += 1 + 4 + op.key.length;
    if (op.kind === "set") size += 4 + op.value.length;
  }

  const payload = new Uint8Array(size);
  let off = 0;
  for (const op of ops) {
    payload[off++] = op.kind === "set" ? OP_SET : OP_DELETE;
    writeU32(payload, off, op.key.length);
    off += 4;
    payload.set(op.key, off);
    off += op.key.length;
    if (op.kind === "set") {
      writeU32(payload, off, op.value.length);
      off += 4;
      payload.set(op.value, off);
      off += op.value.length;
    }
  }

  const record = new Uint8Array(RECORD_HEADER + size);
  writeU32(record, 0, size);
  writeU32(record, 4, crc32(payload));
  record.set(payload, RECORD_HEADER);
  return record;
}

/**
 * Replay one record's payload onto `entries`, in order, reconstructing the
 * committed state the transaction produced. Every length is validated against
 * the payload's actual size first: a payload that passed its CRC but promises
 * bytes it does not hold was never produced by this kernel, so it is corruption
 * — not something to silently misread as ops.
 */
function replayPayload(entries: StoredEntry[], payload: Uint8Array): void {
  const corrupt = (): never => {
    throw new LibreDbError("CORRUPT_WAL", "corrupt WAL record: malformed payload");
  };
  let off = 0;
  while (off < payload.length) {
    const tag = payload[off++] as number;
    if (tag !== OP_SET && tag !== OP_DELETE) corrupt();
    if (off + 4 > payload.length) corrupt();
    const keyLength = readU32(payload, off);
    off += 4;
    if (off + keyLength > payload.length) corrupt();
    const key = payload.slice(off, off + keyLength);
    off += keyLength;
    if (tag === OP_SET) {
      if (off + 4 > payload.length) corrupt();
      const valueLength = readU32(payload, off);
      off += 4;
      if (off + valueLength > payload.length) corrupt();
      const value = payload.slice(off, off + valueLength);
      off += valueLength;
      applySet(entries, key, value);
    } else {
      applyDelete(entries, key);
    }
  }
}

/** What {@link recover} learned about the log. */
interface Recovery {
  entries: StoredEntry[];
  /** True for an empty file: the first append must write the file header. A
   * non-empty headerless v0.1.x file keeps appending headerless records — a
   * header cannot be inserted mid-file. */
  needsHeader: boolean;
  /** Torn-tail bytes discarded, reported via {@link OpenOptions.onRecovery}. */
  truncatedBytes: number;
}

/**
 * Replay every record of `log` from `base` onto a fresh entry array.
 *
 * Failure classification is the heart of recovery:
 *
 *   - A record whose promised end lies BEYOND the file, or a trailing fragment
 *     shorter than a record header, is a TORN TAIL: the append a crash
 *     interrupted. Only the tail can tear (the log is append-only and every
 *     earlier record was fsync'd), so it is truncated away.
 *   - A record that fails its checksum but ends exactly at the file's end is
 *     a DAMAGED TAIL — a half-flushed final block — and truncates the same way.
 *   - A record that fails its checksum with more data AFTER it cannot be a
 *     crash artifact: bytes after it mean a later append succeeded, which means
 *     this record was once durable and has since been damaged (bit rot, a
 *     partial copy, a second writer). That is corruption; recovery THROWS and
 *     leaves the file untouched rather than destroy the committed records
 *     behind the damage.
 */
function replayLog(log: Uint8Array, base: number): { entries: StoredEntry[]; tail: number; replayed: number } {
  const entries: StoredEntry[] = [];
  let offset = base;
  let replayed = 0;
  while (offset + RECORD_HEADER <= log.length) {
    const size = readU32(log, offset);
    const start = offset + RECORD_HEADER;
    const end = start + size;
    if (end > log.length) break; // torn tail: fewer bytes than the header promised
    const payload = log.subarray(start, end);
    if (crc32(payload) !== readU32(log, offset + 4)) {
      if (end < log.length) {
        throw new LibreDbError(
          "CORRUPT_WAL",
          `corrupt WAL record at offset ${offset} with intact data after it; refusing to open`,
        );
      }
      break; // damaged tail: the final record half-flushed
    }
    replayPayload(entries, payload);
    offset = end;
    replayed++;
  }
  return { entries, tail: offset, replayed };
}

/**
 * Rebuild the committed store from the log behind `file`.
 *
 * The file is recognized before it is touched:
 *
 *   - An empty file is a new database; the header is written with the first
 *     commit (never at open, so a read-only open writes nothing).
 *   - A file starting with the magic is ours: records replay after the header.
 *   - A file that instead replays as headerless v0.1.x records (at least one
 *     valid record) is a legacy database and keeps working.
 *   - Anything else is NOT a LibreDB database: open() throws and the file is
 *     left byte-for-byte untouched. This is what makes a typo'd path an error
 *     instead of a destroyed file.
 */
function recover(file: WalFile): Recovery {
  const size = file.size();
  const log = file.read(0, size);
  if (log.length < size) {
    // The file claims `size` bytes but the read returned fewer. Treating that
    // as a torn tail would truncate committed data over a transient IO fault,
    // so it is an error, never a recovery.
    throw new LibreDbError("INCOMPLETE_READ", `WAL read returned ${log.length} of ${size} bytes`);
  }
  if (size === 0) return { entries: [], needsHeader: true, truncatedBytes: 0 };

  const magicPrefix = Math.min(log.length, MAGIC.length);
  const hasMagicPrefix = log.subarray(0, magicPrefix).every((byte, i) => byte === MAGIC[i]);
  if (hasMagicPrefix) {
    if (log.length < FILE_HEADER) {
      // A torn header: the very first commit (header + record in one append)
      // was interrupted before the header finished. Nothing was ever
      // acknowledged, so start the database over from empty.
      file.truncate(0);
      file.fsync();
      return { entries: [], needsHeader: true, truncatedBytes: log.length };
    }
    const fileVersion = ((log[4] as number) << 8) | (log[5] as number);
    if (fileVersion !== FORMAT_VERSION) {
      throw new LibreDbError(
        "UNSUPPORTED_VERSION",
        `database format version ${fileVersion} is newer than this library supports (${FORMAT_VERSION})`,
      );
    }
    return { ...finishReplay(file, log, FILE_HEADER), needsHeader: false };
  }

  // No magic: either a headerless v0.1.x database or a foreign file. Probe the
  // FIRST record without side effects — if it does not replay cleanly, this is
  // not a database we recognize, and the file must be left exactly as found.
  // (Only the first record decides: once it proves the file is ours, a bad
  // LATER record is judged by the normal torn-tail/corruption rules.)
  if (!isLegacyLog(log)) {
    throw new LibreDbError("NOT_A_DATABASE", "file is not a libredb database; refusing to touch it");
  }
  return { ...finishReplay(file, log, 0), needsHeader: false };
}

/** Does `log` begin with one complete, checksummed, well-formed v0.1.x record?
 * That is the recognition test for a headerless legacy database: real bytes
 * from this kernel always start with one, foreign bytes essentially never do. */
function isLegacyLog(log: Uint8Array): boolean {
  if (log.length < RECORD_HEADER) return false;
  const size = readU32(log, 0);
  const end = RECORD_HEADER + size;
  if (end > log.length) return false;
  const payload = log.subarray(RECORD_HEADER, end);
  if (crc32(payload) !== readU32(log, 4)) return false;
  try {
    replayPayload([], payload); // throwaway replay: structural validation only
  } catch {
    return false;
  }
  return true;
}

/** Run the replay and apply its torn-tail truncation (fsync'd, so the clean
 * boundary itself survives a crash) — shared by the headered and legacy paths. */
function finishReplay(
  file: WalFile,
  log: Uint8Array,
  base: number,
): { entries: StoredEntry[]; truncatedBytes: number } {
  const { entries, tail } = replayLog(log, base);
  const truncatedBytes = log.length - tail;
  if (truncatedBytes > 0) {
    file.truncate(tail);
    file.fsync();
  }
  return { entries, truncatedBytes };
}

/** A durable backing store: append committed records, then release the file. */
interface Log {
  /** Append one transaction's ops and fsync before returning, so a successful
   * call means the commit is on disk. */
  append(ops: readonly Op[]): void;
  /** Close the underlying file. */
  close(): void;
}

/** Open the log file at `path` on `fs`, recover the store from it, and return
 * the recovered entries together with a {@link Log} that appends future commits
 * to the same file. */
function openLog(
  path: string,
  fs: FileSystem,
  onRecovery: ((info: RecoveryInfo) => void) | undefined,
): { entries: StoredEntry[]; log: Log } {
  const file = fs.open(path);
  const recovery = recover(file);
  if (recovery.truncatedBytes > 0) onRecovery?.({ truncatedBytes: recovery.truncatedBytes });
  let needsHeader = recovery.needsHeader;
  return {
    entries: recovery.entries,
    log: {
      append(ops) {
        const record = encodeRecord(ops);
        if (needsHeader) {
          // First commit of a new database: header and record go down in ONE
          // append, so a crash can only ever leave a recognizable prefix
          // (handled by recover()) — never a headerless fragment.
          const first = new Uint8Array(FILE_HEADER + record.length);
          first.set(encodeFileHeader(), 0);
          first.set(record, FILE_HEADER);
          file.append(first);
          needsHeader = false;
        } else {
          file.append(record);
        }
        file.fsync(); // the durability point: bytes are on disk before we return
      },
      close() {
        file.close();
      },
    },
  };
}

/**
 * Open a kernel instance. See {@link Open} and {@link OpenOptions}.
 *
 * With a `path` the store is recovered from its write-ahead log and future
 * commits are appended to it durably. Without one the store is purely
 * in-memory.
 */
export const open: Open = (options) => {
  // The committed store. Each transaction works on a copy and replaces this
  // reference on success, so a commit is one atomic assignment and an abort is
  // simply never reaching that assignment. With a path, the initial contents
  // are recovered from the log and `log` persists every later commit.
  let committed: StoredEntry[];
  let log: Log | null;
  let releaseLock: (() => void) | null = null;
  if (options?.path !== undefined) {
    // A path must actually name a file: reject the degenerate empty string here
    // with a clear error, rather than letting it reach the filesystem and
    // surface a raw, adapter-specific failure (e.g. node's ENOENT for "").
    if (options.path === "") {
      throw new LibreDbError("INVALID_ARGUMENT", "open({ path }) requires a non-empty path");
    }
    // The kernel is runtime-agnostic: it carries no default filesystem, so a
    // path-backed open MUST be given one. The default node:fs adapter lives at
    // the package edge (index.ts wires it in); the browser entry has none. A
    // pathless, in-memory open never reaches here and needs no filesystem.
    if (options.fs === undefined) {
      throw new LibreDbError("INVALID_ARGUMENT", "open({ path }) requires a filesystem; none was provided");
    }
    // Exclusive access first: a second writer on the same file would recover an
    // independent store and interleave appends — silent divergence. Filesystems
    // that implement the lock make that a loud LOCKED error instead.
    if (options.fs.lock !== undefined) releaseLock = options.fs.lock(options.path);
    try {
      const opened = openLog(options.path, options.fs, options.onRecovery);
      committed = opened.entries;
      log = opened.log;
    } catch (error) {
      releaseLock?.(); // recovery refused the file; do not hold its lock
      throw error;
    }
  } else {
    committed = [];
    log = null;
  }

  let closed = false;
  // Latched on the first commit that fails to reach the disk. A failed append
  // can leave a torn record at the tail; appending MORE records after it would
  // let the next recovery truncate them away even though their transact()
  // returned success. Refusing all further writes until reopen (which repairs
  // the tail) is what keeps an acknowledged commit durable.
  let failed = false;
  // Guards against re-entrancy. The API is synchronous and single-threaded, so
  // a transaction body runs to completion before the next one begins — making
  // the schedule serial (hence serializable) by construction. The only way to
  // overlap two transactions is to call transact() from inside another, which
  // we forbid: the inner snapshot would miss the outer's pending writes and the
  // outer's later commit would clobber the inner's, a silent lost update. With
  // this guard the serializable guarantee is a fact, not an assumption.
  let inTransaction = false;

  return {
    transact(run) {
      if (closed) throw new LibreDbError("CLOSED", "database is closed");
      if (failed) {
        throw new LibreDbError("FAILED", "a previous commit failed to reach the disk; close and reopen to recover");
      }
      if (inTransaction) {
        throw new LibreDbError("NESTED_TRANSACTION", "nested transactions are not supported");
      }
      inTransaction = true;
      try {
        const working = committed.slice();
        const journal: Op[] = [];
        const result = run(makeTransaction(working, journal));
        // An async body returns a pending Promise: any write after its first
        // await would land in memory but never in the journal already written
        // below — silent data loss on reopen. Refuse before committing.
        if (isThenable(result)) {
          throw new LibreDbError(
            "ASYNC_TRANSACTION",
            "transact() body must be synchronous; an async callback cannot commit correctly",
          );
        }
        // Reached only if run() did not throw. Make the commit DURABLE before
        // exposing it in memory. If the append or fsync fails, the tail of the
        // file may hold a torn record — so the database latches (see `failed`)
        // and memory keeps the prior state; reopening repairs the tail.
        if (log !== null && journal.length > 0) {
          try {
            log.append(journal);
          } catch (error) {
            failed = true;
            throw error;
          }
        }
        committed = working;
        return result;
      } finally {
        // Always clear the guard, even on abort, so a thrown body does not wedge
        // the database against all future transactions.
        inTransaction = false;
      }
    },
    close() {
      if (closed) return; // idempotent: never double-close the underlying file
      if (inTransaction) {
        // Closing mid-transaction would rip the file out from under the commit
        // path and surface a raw adapter error; name the misuse instead.
        throw new LibreDbError("CLOSE_IN_TRANSACTION", "cannot close the database inside a transaction");
      }
      closed = true;
      if (log !== null) log.close();
      releaseLock?.();
      committed = [];
    },
  };
};
