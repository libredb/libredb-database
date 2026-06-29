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
 * transactions, and a write-ahead log for durability. Recovery replays that log
 * and discards any record a crash left half-written.
 */

/** The LibreDB package version. Kept in sync with package.json. */
export const version = "0.1.0";

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
 * Keys are ordered by unsigned byte-lexicographic comparison. That ordering is
 * the kernel's defining property: it is what makes `getRange` meaningful and
 * what later lenses encode their indexes against.
 */
export interface Transaction {
  /** The value for `key`, or `undefined` if it is not set. */
  get(key: Key): Value | undefined;
  /** Set `key` to `value`, overwriting any existing value. */
  set(key: Key, value: Value): void;
  /** Remove `key`. A no-op if it is not set. */
  delete(key: Key): void;
  /**
   * Scan the half-open range `[start, end)` in ascending key order:
   * `start` is included, `end` is excluded. Lazy by design — callers iterate
   * without the kernel materializing the whole range.
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
   */
  transact<T>(run: (tx: Transaction) => T): T;
  /** Flush pending state and release resources. Safe to call once. */
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
}

/**
 * An open handle to a write-ahead log file: exactly the operations the WAL
 * performs on it. Writes are append-only; recovery reads the file and may
 * truncate a torn tail.
 */
export interface WalFile {
  /** The number of bytes currently in the file. */
  size(): number;
  /** Read `length` bytes starting at `offset`. */
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
   * The filesystem the write-ahead log runs on. Required for a path-backed open:
   * the kernel carries no default, so omitting it with a `path` throws. (The
   * Node entry defaults this to a `node:fs` adapter; the browser entry has none.)
   * Injecting one lets tests simulate crashes and IO faults deterministically
   * (DESIGN.md section 6.4). Ignored when there is no `path` (an in-memory
   * database never touches a filesystem).
   */
  readonly fs?: FileSystem;
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
 * to a caller. */
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

/**
 * A transaction backed by `working`, a mutable snapshot of the committed store.
 * Reads and writes hit the snapshot directly, which is what gives
 * read-your-writes; the caller commits or discards the snapshot as a whole.
 * Every mutation is also appended to `journal`, the redo record a durable
 * database writes to its log on commit (and ignores when purely in-memory).
 */
function makeTransaction(working: StoredEntry[], journal: Op[]): Transaction {
  return {
    get(key) {
      const { found, index } = locate(working, key);
      return found ? (working[index] as StoredEntry).value : undefined;
    },
    set(key, value) {
      applySet(working, key, value);
      journal.push({ kind: "set", key, value });
    },
    delete(key) {
      applyDelete(working, key);
      journal.push({ kind: "delete", key });
    },
    *getRange(start, end) {
      // locate() returns the first index whose key is >= start (the insertion
      // point), so the scan is naturally inclusive of start. It stops at the
      // first key that is not < end, making the range half-open [start, end).
      for (let i = locate(working, start).index; i < working.length; i++) {
        const entry = working[i] as StoredEntry;
        if (compareKeys(entry.key, end) >= 0) break;
        yield entry;
      }
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
// On-disk record = an 8-byte header followed by a payload:
//   [u32 payloadLength][u32 crc32(payload)][payload]
// The payload is the transaction's mutations back to back. Each op is:
//   set:    [u8 1][u32 keyLength][key][u32 valueLength][value]
//   delete: [u8 0][u32 keyLength][key]
// Integers are big-endian. Because the log is append-only and fsync'd, a crash
// can only ever damage the LAST record, so recovery trusts every record up to
// the first one that is incomplete or fails its checksum, and truncates the
// rest away.
// ---------------------------------------------------------------------------

const OP_SET = 1;
const OP_DELETE = 0;
/** Bytes in a record header: the payload length and its checksum, both u32. */
const RECORD_HEADER = 8;

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

/** Replay one record's payload onto `entries`, in order, reconstructing the
 * committed state the transaction produced. */
function replayPayload(entries: StoredEntry[], payload: Uint8Array): void {
  let off = 0;
  while (off < payload.length) {
    const tag = payload[off++] as number;
    const keyLength = readU32(payload, off);
    off += 4;
    const key = payload.slice(off, off + keyLength);
    off += keyLength;
    if (tag === OP_SET) {
      const valueLength = readU32(payload, off);
      off += 4;
      const value = payload.slice(off, off + valueLength);
      off += valueLength;
      applySet(entries, key, value);
    } else {
      applyDelete(entries, key);
    }
  }
}

/**
 * Rebuild the committed store from the log behind `file`, returning its entries.
 * Replays every intact record and stops at the first record a crash left torn
 * (header promises bytes that are not there) or corrupt (checksum mismatch),
 * truncating that tail away so the next append starts from a clean boundary.
 */
function recover(file: WalFile): StoredEntry[] {
  const entries: StoredEntry[] = [];
  const log = file.read(0, file.size());
  let offset = 0;
  while (offset + RECORD_HEADER <= log.length) {
    const size = readU32(log, offset);
    const checksum = readU32(log, offset + 4);
    const start = offset + RECORD_HEADER;
    const end = start + size;
    if (end > log.length) break; // torn: fewer bytes than the header promised
    const payload = log.subarray(start, end);
    if (crc32(payload) !== checksum) break; // corrupt: record damaged mid-write
    replayPayload(entries, payload);
    offset = end;
  }

  if (offset < log.length) file.truncate(offset);
  return entries;
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
function openLog(path: string, fs: FileSystem): { entries: StoredEntry[]; log: Log } {
  const file = fs.open(path);
  const entries = recover(file);
  return {
    entries,
    log: {
      append(ops) {
        file.append(encodeRecord(ops));
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
  if (options?.path !== undefined) {
    // A path must actually name a file: reject the degenerate empty string here
    // with a clear error, rather than letting it reach the filesystem and
    // surface a raw, adapter-specific failure (e.g. node's ENOENT for "").
    if (options.path === "") {
      throw new Error("libredb: open({ path }) requires a non-empty path");
    }
    // The kernel is runtime-agnostic: it carries no default filesystem, so a
    // path-backed open MUST be given one. The default node:fs adapter lives at
    // the package edge (index.ts wires it in); the browser entry has none. A
    // pathless, in-memory open never reaches here and needs no filesystem.
    if (options.fs === undefined) {
      throw new Error("libredb: open({ path }) requires a filesystem; none was provided");
    }
    const opened = openLog(options.path, options.fs);
    committed = opened.entries;
    log = opened.log;
  } else {
    committed = [];
    log = null;
  }

  let closed = false;
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
      if (closed) throw new Error("libredb: database is closed");
      if (inTransaction) {
        throw new Error("libredb: nested transactions are not supported");
      }
      inTransaction = true;
      try {
        const working = committed.slice();
        const journal: Op[] = [];
        const result = run(makeTransaction(working, journal));
        // Reached only if run() did not throw. Make the commit DURABLE before
        // exposing it in memory: if the append fails, we throw with memory and
        // disk still agreeing on the prior state. A read-only transaction has
        // nothing to persist, so it skips the log entirely. The in-memory
        // commit is then one atomic reference swap.
        if (log !== null && journal.length > 0) log.append(journal);
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
      closed = true;
      if (log !== null) log.close();
      committed = [];
    },
  };
};
