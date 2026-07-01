# Understanding the LibreDB Kernel

*A guided walk from a single byte to a durable database.*

This document teaches how the LibreDB kernel actually works, from the ground up.
It is the **learning companion** to the reference material:

- [`ARCHITECTURE.md`](../ARCHITECTURE.md) is the authoritative tour of the structure and algorithms.
- [`docs/DESIGN.md`](./DESIGN.md) records the locked decisions and their rationale.
- [`MANIFESTO.md`](../MANIFESTO.md) says what LibreDB refuses to be.

Where those explain *what the system is*, this one walks the *path a learner
takes to understand it* -- opening the hood of a real database for the first
time and following one insight into the next. It is deliberately paced, uses
analogies, and decodes real bytes from a real file. If a claim here ever
disagrees with the code, the code wins (see the repo's honesty discipline); this
is a teaching text, and the source is the truth.

The whole kernel lives in one file: [`src/core.ts`](../src/core.ts). Every line
reference below points there unless noted. It is small on purpose -- small enough
to read in an afternoon -- and this document is a map for that read.

---

## Table of contents

1. [The central idea: a ledger, not a snapshot](#1-the-central-idea-a-ledger-not-a-snapshot)
2. [The ladder of abstraction: bytes, bits, and hex](#2-the-ladder-of-abstraction-bytes-bits-and-hex)
3. [The on-disk format, decoded from real bytes](#3-the-on-disk-format-decoded-from-real-bytes)
4. [The write path: two operations, no magic](#4-the-write-path-two-operations-no-magic)
5. [Durability: fsync, the page cache, and what we do not delegate](#5-durability-fsync-the-page-cache-and-what-we-do-not-delegate)
6. [The read path: cold recovery and hot queries](#6-the-read-path-cold-recovery-and-hot-queries)
7. [Three representations of the same data](#7-three-representations-of-the-same-data)
8. [The lifecycle: open, use, close -- and the memory constraint](#8-the-lifecycle-open-use-close--and-the-memory-constraint)
9. [How LibreDB compares to other databases](#9-how-libredb-compares-to-other-databases)
10. [Where LibreDB is strong](#10-where-libredb-is-strong)
11. [What LibreDB deliberately avoids](#11-what-libredb-deliberately-avoids)
12. [Glossary](#12-glossary)
13. [References](#13-references)

---

## 1. The central idea: a ledger, not a snapshot

Most application developers meet persistence through XML, JSON or YAML files: you hold
an object in memory, serialize the *whole thing* to disk, and to read it back you
parse the *whole thing*. The file is the **current state**. Every save rewrites
it from scratch.

A database does not work this way, and understanding why is the first real step.
The LibreDB file is not the current state -- it is an **append-only log of every
change that ever happened**. You never seek back into the file to edit a spot;
you only ever **append to the end**. This structure is called a **write-ahead log
(WAL)** ([`core.ts`](../src/core.ts) L275-294).

```
JSON / snapshot model          LibreDB / WAL model
---------------------          -------------------
[ {all the data} ]             set users:1 = Ada
 rewrite the whole             set users:1 = Ada (age 37)   <- does NOT overwrite; APPENDS
 file on every save            delete users:1
                               "current state" = replay every record in order
```

Three familiar systems share this exact shape, which is why the model feels
recognizable once named:

- **An accounting ledger.** A bookkeeper never erases a balance and writes a new
  one -- that destroys history and is how fraud hides. They append every
  transaction as a line; the balance is the sum of the lines. A mistake is fixed
  by appending a *correcting entry*, not by going back.
- **`git`.** A commit is never edited in place. New work is a new commit; `HEAD`
  is just a pointer to "the latest valid state." All history stays.
- **`app.log`.** You append log lines; you never rewrite the file to change line 400.

Even a delete is an append: it writes a *tombstone* record that says "this key is
gone now" (`OP_DELETE`, [`core.ts`](../src/core.ts) L239), not a physical erasure.
The file only ever grows.

**Why append-only?** Because appending is atomic and safe. Rewriting the middle
of a file and losing power halfway corrupts it. Appending and losing power can
only damage the **last** record; everything before it is intact. That single
property is what makes the rest of the design possible.

> A consequence, worth flagging early: because nothing is ever rewritten,
> superseded and deleted data stay on disk forever. Reclaiming that space is
> **compaction**, which LibreDB does not yet do -- see
> [section 11](#11-what-libredb-deliberately-avoids) and issue
> [#12](https://github.com/libredb/libredb-database/issues/12).

---

## 2. The ladder of abstraction: bytes, bits, and hex

When you first run `xxd` on a `.libredb` file, the hex looks alien. It is not.
The anxiety most developers feel here is "if I look deeper, will I fall into a
1/0 abyss and get lost?" The answer is no, because the ladder of abstraction has
a floor you can comfortably stand on, one step above the hardware:

```
  Layer 7   Business logic       user.age = 36
  Layer 6   Object / JSON        {"name":"Ada","age":36}
  Layer 5   String               "Ada"
  ------------------------------------------------- you always stood here
  Layer 4   Byte array           [65, 100, 97]                <- the kernel works here
  Layer 3   Byte (0-255)         65
  Layer 2   Hex notation         0x41   (a short way to write 65)
  Layer 1   Bits (eight 0/1)     01000001
  ------------------------------------------------- solid floor to stand on
  Layer 0   Voltage / transistor ~0V / ~1V          <- hardware's job, not yours
```

A database developer lives between Layer 1 and Layer 4. Layer 0 (transistors,
voltage) is real but you never need to descend to it -- just as a car designer
knows a metal's strength without reasoning about the quantum states of its
electrons. Every layer trusts the one below it.

The key realization: **a string is already bytes.** The letter `l` you have typed
a million times *is* the number 108 *is* `0x6c` *is* `01101100`. These are not
four different things -- they are one thing wearing four costumes. Your editor
always showed you the top costume ("l"). `xxd` just takes the costume off.

- A **bit** is one yes/no: high voltage (1) or not (0).
- A **byte** is 8 bits, giving 2^8 = 256 combinations, so it holds a number from
  **0 to 255**. `Key = Uint8Array` in the kernel ([`core.ts`](../src/core.ts) L35)
  means "unsigned 8-bit integers" -- a sequence of bytes.
- **Hex** is just a compact way to *write* a byte. Because 4 bits map exactly to
  one hex digit (2^4 = 16), one byte is always exactly two hex digits. `0x6c`
  splits as `0110` (=6) and `1100` (=c). Hex is for human eyes; the machine only
  ever knows bits.

The deepest point: **a byte is a universal medium.** A string, a number, an
image, a video -- on disk they are all the same thing, a sequence of bytes. The
only difference is *interpretation*: the byte `01100001` is "97" through one lens
and "a" through another. This is exactly why the kernel keeps values as opaque
bytes and never interprets them ([`core.ts`](../src/core.ts) L37-39) -- that
decision is a lens concern, not a kernel one, and it is what lets one storage
substrate carry three data models.

---

## 3. The on-disk format, decoded from real bytes

The best way to believe all of the above is to decode a real record. The shipped
sample `libredb-studio/data/demo.libredb` begins:

```
00000000: 0000 009d ea44 7848 0100 0000 1600 6c69  .....DxH......li
00000010: 6272 6564 623a 6361 7461 6c6f 673a 7573  bredb:catalog:us
00000020: 6572 7300 0000 7e7b 226b 696e 6422 3a22  ers...~{"kind":"
```

The record format ([`core.ts`](../src/core.ts) L285-291) is:

```
record  = [u32 payloadLength][u32 crc32(payload)][payload]
payload = one or more ops, back to back
  set:    [u8 1][u32 keyLength][key][u32 valueLength][value]
  delete: [u8 0][u32 keyLength][key]
integers are big-endian (most significant byte first)
```

Decoding the first record byte by byte:

| Bytes | Value | Meaning | Code |
| --- | --- | --- | --- |
| `00 00 00 9d` | 157 | payloadLength | `encodeRecord` ([`core.ts`](../src/core.ts) L363) |
| `ea 44 78 48` | 0xea447848 | crc32 of the payload | L364 |
| `01` | 1 | OP_SET | L349 |
| `00 00 00 16` | 22 | keyLength | L351 |
| `00 6c 69 ... 73` | `\x00libredb:catalog:users` | the key (22 bytes) | L353 |
| `00 00 00 7e` | 126 | valueLength | L357 |
| `7b 22 6b ...` | `{"kind":"relational",...}` | the value (126 bytes) | L359 |

Note the key begins with a `0x00` byte. That is the catalog's reserved marker
([`lens/catalog.ts`](../src/lens/catalog.ts), `RESERVED_MARKER`): `0x00` is the
lowest byte, so the engine's internal catalog entries sort *before* every
user key. This is how a tool opening the file cold (e.g. the LibreDB Studio
provider) can tell "this namespace is relational, here is its schema" from
user data.

Why does a database bother with this binary framing instead of just storing JSON
text? Four reasons, each of which you can now see in the bytes:

1. **Fixed-width numbers give computable addresses.** Lengths are `u32` (always
   4 bytes), not text like `"126"` (variable width). The reader can *compute*
   where the next field is -- "offset + 4 bytes is the length" -- instead of
   scanning for it. Fixed-width fields are a `struct`; JSON is free text you must
   parse.
2. **Length-prefixing kills delimiter-hunting.** "Read 4 bytes for the length,
   then read exactly that many bytes" ([`core.ts`](../src/core.ts) L377-383).
   No scanning for a closing quote, no escaping. Crucially, the value can then
   contain *any* byte -- even `0x00`, even `"` -- so the store is byte-safe and
   can hold arbitrary blobs. Text formats are not byte-safe.
3. **Space and speed.** Binary integers are smaller than their text spellings and
   need no parser; `readU32` ([`core.ts`](../src/core.ts) L311) turns 4 bytes into
   a number with one shift-and-add.
4. **Sortability.** Ordering over raw bytes is exact and stable, and big-endian
   makes byte-lexicographic order match numeric order. String order is not stable
   across encodings (`"10" < "2"` in UTF-16). See `compareKeys`
   ([`core.ts`](../src/core.ts) L189).

The **CRC-32** ([`core.ts`](../src/core.ts) L326, written without a lookup table
so the mechanism stays visible) is the record's "is this complete?" checksum. It
is what lets recovery tell a fully-written record from one a crash left
half-flushed.

---

## 4. The write path: two operations, no magic

A common early misconception: "we opened the file in append mode, so writing to
the file must keep memory in sync automatically." It does not. There is **no
magic** and **no automatic bridge** between the file and the in-memory data.
Opening in append mode (`openSync(path, "a")`,
[`adapter/node-fs.ts`](../src/adapter/node-fs.ts)) only means "writes go to the
end of the file." It says nothing about memory.

Memory and disk are two separate worlds -- a JavaScript array on the heap, and a
byte stream on disk -- and *the kernel's code explicitly bridges them*. Writing
`employees.insert(...)` runs through `transact`
([`core.ts`](../src/core.ts) L493):

```ts
transact(run) {
  const working = committed.slice();          // 1) a COPY of the in-memory array
  const journal = [];
  const result = run(makeTransaction(working, journal));
  //   inside, each tx.set does two things:
  //     applySet(working, key, value)   // (A) update the in-memory COPY   L259
  //     journal.push({kind:"set",...})  // records the op in a list        L260
  if (log !== null && journal.length > 0)
    log.append(journal);                      // (B) write to DISK (append + fsync)  L508
  committed = working;                        // (C) make it official (atomic swap)  L509
}
```

So a write is **three explicit, hand-written steps**, two in memory and one on
disk: (A) update the working copy, (B) append the record to disk and fsync, (C)
swap the reference. Append mode governs only *where in the file* (B) writes; it
has zero connection to (A) or (C). The only thing linking file and memory is this
function.

Two design choices fall out of this being explicit:

- **Copy-on-write commit.** The transaction works on a *copy* (`working`), and a
  successful commit is a single atomic reference assignment `committed = working`
  ([`core.ts`](../src/core.ts) L509). If `run` throws, that line is never reached
  and `committed` keeps its old value -- so an abort applies nothing, with no undo
  logic. Atomicity is "the reference either changed or it did not."
- **The order matters: disk before memory.** (B) runs before (C). If the disk
  append fails, we throw *before* the swap, leaving memory and disk agreeing on
  the prior state. This is only possible *because* they are separate operations
  you can order.

A subtle bonus: writes within one transaction accumulate in `journal` (a list in
RAM) and are flushed as **one** appended record ([`core.ts`](../src/core.ts)
L508). Five `set`s in a transaction produce one disk append, not five -- atomicity
and throughput at once.

> Aside: memory-mapped files (mmap) *do* let the OS couple a memory region to a
> file. LibreDB deliberately does not use mmap -- it blurs *when* durability
> happens and pulls OS paging mechanics into the reasoning, against the
> comprehension budget. Explicit, hand-coded sync is more lines but fully visible.

---

## 5. Durability: fsync, the page cache, and what we do not delegate

It is tempting to think that once we delegate file I/O to Node and the OS, "data
loss on sudden shutdown is not our problem anymore." That inverts cause and
effect. The worry is very much real -- it is *the* central worry -- and the only
reason it *feels* gone is that LibreDB was built specifically to handle it, with
the WAL, `fsync`, CRC, and recovery.

Here is the danger. `append` hands bytes to the OS, but the OS may keep them in
its **page cache** (RAM) and write to the physical device "later." If the power
fails in that window, a commit you already reported as successful is lost.
**`fsync`** ([`core.ts`](../src/core.ts) L127, called at L437; `fsyncSync` in the
Node adapter) is the command that closes this window: "OS, flush this file to
durable storage now, and do not return until it is there." It is the single line
that gives the word "durability" its weight.

So the correct mental model is: **we delegate the mechanics but not the
durability.** Byte transport, syscalls, disk scheduling -- delegated and
forgotten. But *when* bytes become durable is something we reach down through the
abstraction and command, precisely because the lower layer's default (lazy
writeback) is unsafe. Delegating is not the same as forgetting.

"No data loss" is also not absolute -- it loses exactly the *right* thing:

- Committed (fsync'd) data survives; recovery brings it back.
- An in-flight transaction not yet fsync'd is lost -- which is *correct*
  (atomicity: it never happened).
- A torn last record is truncated away on recovery
  ([`core.ts`](../src/core.ts) L413).

**The trust boundary.** Good systems do not "trust the language" broadly; they
shrink and make explicit exactly what they must trust. The kernel imports nothing
from `node:`. Every byte to disk goes through one tiny interface, the
`FileSystem` seam ([`core.ts`](../src/core.ts) L109-134):

```ts
interface FileSystem { open(path): WalFile }
interface WalFile { size; read; append; fsync; truncate; close }  // that is all
```

That is auditable trust, not blind trust: "everything I need from the outside
world is these six operations." The Node adapter
([`adapter/node-fs.ts`](../src/adapter/node-fs.ts)) fills it with `node:fs`; the
browser adapter ([`adapter/opfs.ts`](../src/adapter/opfs.ts)) fills it with OPFS;
a test fills it with a fake to simulate crashes. The kernel knows none of them --
dependency inversion in service of comprehension and portability. The honest
floor: even `fsync`'s guarantee ultimately depends on the hardware honoring it
(some disks have their own write cache), but that is the OS/hardware contract, one
layer below yours.

---

## 6. The read path: cold recovery and hot queries

Writing is easy ("append to the end"). Reading looks harder -- if you write
everything, including dead records, out of order, you have to work to read it
back. LibreDB's answer has two parts, and only the first part is the "hard work":

```
1. COLD read (recovery)  -- from disk, at open, ONCE.       the "work hard" moment
2. HOT read (query)      -- from memory, many times, cheap. every get / getRange
```

The trick that makes even the cold read mechanical rather than guesswork: **the
write format was designed for the reader.** Every record is length-framed, so the
reader never guesses where a record ends -- it reads the header, jumps exactly
that many bytes, and lands on the next record. The format is *self-describing*.

**Cold read -- `recover`** ([`core.ts`](../src/core.ts) L397) reads the whole file
and replays every record:

```
offset = 0
loop:
  read 8-byte header -> payloadLength, crc         L402-403
  end = offset + 8 + payloadLength
  if end > file length  -> STOP: record is torn    L406
  if crc32(payload) != crc -> STOP: record corrupt L408
  replayPayload(payload) -> apply set/delete        L409
  offset = end                                      jump to the next record
if leftover bytes remain -> truncate them           L413
```

Three things happen as the flat log becomes the in-memory state -- this is the
whole of "reading":

1. **Collapse.** Superseded records and tombstones are replayed and dropped via
   `applySet` / `applyDelete` ([`core.ts`](../src/core.ts) L219, L227) -- the same
   functions live writes use, so "what a set means" has exactly one definition.
   The last write of a key wins. In `demo.libredb`, `project:1` is written twice
   on disk but collapses to one live key in memory.
2. **Re-sort.** On disk, records are in *write order* (chronological). In memory,
   they are in *key order* (sorted, byte-lexicographic). This is a real physical
   reorganization, not just cleaning:

   ```
   DISK (write order)           MEMORY (key order, sorted)
   0  \0catalog:users           \0catalog:people
   1  users:1                   \0catalog:users
   2  users:2                   config:locale
   3  \0catalog:people          config:theme
   3  people:1                  people:1
   ...                          people:2
   8  project:1  (dead)         project:1   (collapsed)
   9  project:1  (live)         project:2
   10 project:2                 session:abc
                                users:1
                                users:2
   ```

   Sorting is what makes queries cheap (below); the cold read pays for it once.
3. **Restructure.** A flat, framed byte stream becomes a JavaScript array of
   `{key, value}` objects (`StoredEntry[]`, [`core.ts`](../src/core.ts) L175). The
   framing (lengths, CRC) is gone -- the JS array holds structure natively.

Torn-tail handling is the payoff of append-only: because a crash can only damage
the last record, recovery trusts every record up to the first one that is
incomplete or fails its checksum, and truncates the rest so the next append starts
on a clean boundary.

**Hot read -- queries.** Once in memory, reads never touch disk:

- `get(key)` is a **binary search** over the sorted array (`locate`,
  [`core.ts`](../src/core.ts) L203; `get` at L250) -- O(log n), like finding a
  word in a dictionary by halving.
- `getRange(start, end)` is "find the start, walk until the end"
  ([`core.ts`](../src/core.ts) L262-270). Because the array is sorted, all keys in
  a range are contiguous -- which is why `prefix("users:")` (scanning a table) is
  cheap even though `users:1` and `users:2` were far apart on disk.
- **Read-your-writes**: a transaction reads from its `working` copy, so it sees
  its own not-yet-committed writes ([`core.ts`](../src/core.ts) L242-247).

The resolution to the "reading is hard" worry: all the hard work is concentrated
into a *single moment* (open), which produces a clean sorted structure that makes
every subsequent read easy. And that one moment can be shortened by compaction
([#12](https://github.com/libredb/libredb-database/issues/12)), since a bloated
log means replaying more dead records on every open.

---

## 7. Three representations of the same data

A single insight ties the whole kernel together: **logical content and physical
representation are different things.** The same live key/value set exists in three
physical forms at once, each optimized for a different job:

| Aspect | Disk (WAL) | Kernel memory (`committed`) | Lens surface |
| --- | --- | --- | --- |
| Type | flat framed byte stream | JS `Array<{key, value}>` | strings / JSON |
| Order | write order (chronological) | key order (sorted) | key order |
| Dead records | present | absent (collapsed) | absent |
| Framing | length prefixes + CRC | none (JS holds structure) | none |
| key/value form | raw bytes | **still raw bytes** (`Uint8Array`) | decoded string |
| Optimized for | append + durability | search | ergonomics |

Two points surprise most learners:

- **In kernel memory, keys and values are still `Uint8Array`, not strings.**
  `StoredEntry` is `{key: Uint8Array, value: Uint8Array}`
  ([`core.ts`](../src/core.ts) L35, L175). The kernel never decodes to strings;
  that happens one layer up, in the lens (`encode`/`decode` in
  [`lens/kv.ts`](../src/lens/kv.ts)). Strings are *born at the lens*, not in the
  kernel.
- **Recovery is therefore a format converter**, turning a chronological byte
  stream into a sorted, collapsed, structured array. That conversion is the
  essence of the cold read.

This layering is exactly why LibreDB is multi-model: the byte substrate stays
honest and uninterpreted, and different lenses (kv, document, relational) put
different interpretations on the same bytes. See
[`ARCHITECTURE.md` section 6](../ARCHITECTURE.md) for the lenses.

---

## 8. The lifecycle: open, use, close -- and the memory constraint

Concretely, for an app using the npm package:

```ts
import { open, table } from "@libredb/libredb";

const db = open({ path: "hr.libredb" });   // COLD BOOT: whole file read, memory built
const employees = table(db, "employees", { primaryKey: "id",
  columns: { id: "string", name: "string", salary: "number" } });

const ada = employees.get("1");            // from memory (binary search)
employees.insert({ id: "9", name: "Linus", salary: 5000 }); // append + fsync
for (const row of employees.all()) { /* ... */ }            // from memory, sorted

db.close();                                // free memory, close the file descriptor
```

- **`open`** ([`index.ts`](../src/index.ts) wires the `node:fs` adapter when a
  path is given without one) calls `openLog` -> `recover`
  ([`core.ts`](../src/core.ts) L429, L397). It opens an append-mode descriptor,
  reads the **whole file** into memory (`readFileSync` in the Node adapter), and
  replays it into the sorted `committed` array. This is the cold boot.
- **Use.** Reads come from memory; writes append + fsync through the descriptor
  that stays open for the session.
- **`close`** ([`core.ts`](../src/core.ts) L517) sets `closed`, closes the file
  descriptor (`log.close()`), and drops the array (`committed = []`) for GC. It is
  idempotent. Importantly, **durability does not depend on `close`** -- every
  commit was already fsync'd, so committed data survives even a crash with no
  `close`. `close` only releases resources.

**The memory model, and its one big consequence.** Two memory moments matter:

- *Transient peak* at open: `readFileSync` loads the entire file (say 500 MB) into
  a buffer while replaying.
- *Retained*: after replay, that buffer is GC'd; what stays is the live data only
  (say 50 MB), because recovery collapsed the dead records.

So a 500 MB file with 50 MB of live data settles to ~50 MB in memory. But note
what this means: **the entire live dataset must fit in RAM.** LibreDB is an
*in-memory database with a durable log*, not a disk-paged engine. This is a
deliberate simplicity choice (see [`docs/DESIGN.md`](./DESIGN.md)), with a
trade-off:

| | PostgreSQL | LibreDB (today) |
| --- | --- | --- |
| In memory | hot pages only (buffer pool) | the entire live dataset |
| 1 TB data, 16 GB RAM? | works (pages in/out from disk) | does not fit |
| Reads | may hit disk | always from memory (very fast) |
| Cost | complex (buffer pool, page manager) | simple, readable core |

The upside of the constraint is that reads never touch disk, so for a dataset
that fits in RAM, LibreDB reads are extremely fast. Growing past RAM would reopen
the in-memory sorted array in favor of an on-disk paged structure (a B-tree or
LSM tree) -- the deepest possible change, listed as a scaling decision in
[`ARCHITECTURE.md` section 10.3](../ARCHITECTURE.md).

---

## 9. How LibreDB compares to other databases

LibreDB is not trying to be Postgres. The comparison is useful for locating it,
not for scoring it.

| Dimension | PostgreSQL | SQLite | LibreDB |
| --- | --- | --- | --- |
| Durable log | WAL (`pg_wal/`) | WAL mode (`-wal` file) | the `.libredb` file itself |
| Main data store | heap + B-tree data files | B-tree in one file | none on disk; sorted array in RAM |
| Current state lives | on disk, cached in buffer pool | on disk (paged) | in RAM (whole live set) |
| Reclaiming dead data | `VACUUM` (dead tuples) | `VACUUM` | not yet -- compaction ([#12](https://github.com/libredb/libredb-database/issues/12)) |
| Concurrency | MVCC, many writers | reader/writer locking | serial (single-threaded); serializable by construction |
| Interface | SQL over the network | SQL, embedded | typed lenses, embedded, synchronous |
| Larger than RAM | yes | yes | no |
| Read the source in an afternoon | no | almost | yes (the point) |

Two structural facts explain most of the differences:

1. **Most engines keep two disk structures** (an append-only log *and* an
   in-place-updated main store), splitting "be safe/fast to write" from "be
   queryable." LibreDB keeps only the log on disk and puts the queryable form in
   RAM. This is why its core is small and why it must fit in RAM.
2. **The `VACUUM` you have run in Postgres/Oracle/SQL Server** is the same family
   of problem as LibreDB's missing compaction. Append-only structures always
   accumulate dead versions (Postgres dead tuples, LibreDB duplicate records), and
   something must periodically reclaim them. Postgres has `VACUUM`; LibreDB has the
   accumulation but not yet the reclamation.

Serializability deserves a note. In Postgres, serializable isolation is expensive
machinery (MVCC + conflict detection). In LibreDB it is *free*: the API is
synchronous and single-threaded, so each transaction body runs to completion
before the next begins -- the schedule is serial by construction, and the kernel
forbids nested transactions to keep it that way
([`core.ts`](../src/core.ts) L490-497). Cheap serializability is a gift of the
constraint, not a feature that was built.

---

## 10. Where LibreDB is strong

- **Comprehensibility as a feature.** The entire durability core is one small
  file you can read in an afternoon. The file boundary is the trust boundary
  ([`ARCHITECTURE.md`](../ARCHITECTURE.md)); you can audit exactly what you trust.
- **Fast reads.** Everything queryable is in RAM in a sorted array; reads never
  touch disk. Binary search and contiguous range scans are cheap.
- **Honest, simple durability.** One mechanism (append + fsync + CRC + replay),
  no separate data file to keep in sync, no checkpoint machinery. A commit is
  durable the instant it returns.
- **A byte-honest multi-model foundation.** The kernel stores opaque bytes in a
  single ordered keyspace; three data models (kv, document, relational) are lenses
  over it with no duplicated storage.
- **A small, explicit trust boundary.** The `FileSystem` seam is six operations.
  The same kernel runs on Node, in the browser (OPFS), and against a fault-
  injecting fake, with zero `node:` imports in the core.
- **Free serializability.** The serial execution model gives the strongest
  isolation level at no cost.
- **Reliability discipline.** 100% line/function/statement coverage, plus a
  deterministic-simulation crash/recovery harness ([`docs/RELIABILITY.md`](./RELIABILITY.md),
  [`src/sim/`](../src/sim/)).

---

## 11. What LibreDB deliberately avoids

These are conscious omissions, not gaps of neglect. Each is a decision to keep the
kernel small; see [`ARCHITECTURE.md` section 10.2/10.3](../ARCHITECTURE.md) and
[`docs/DESIGN.md`](./DESIGN.md).

- **Compaction / checkpointing (for now).** The log only grows; dead records are
  never reclaimed. This is the single most important hardening item for a
  long-lived database and is scoped in issue
  [#12](https://github.com/libredb/libredb-database/issues/12). A `hr.libredb`
  written for months will bloat until compaction exists.
- **Larger-than-RAM storage.** No disk paging; the live set must fit in RAM.
  Adding it means an on-disk B-tree/LSM -- the deepest change, deliberately not
  taken in v1.
- **Concurrent writers / MVCC.** Serializability is currently free *because*
  execution is serial. Real concurrency would mean MVCC or OCC with conflict
  detection -- a much larger kernel. Deferred on purpose.
- **A SQL engine.** The relational lens is a relational *view*, not SQL. A SQL
  parser/planner would put LibreDB head-to-head with SQLite, a competition the
  project explicitly refuses (see [`MANIFESTO.md`](../MANIFESTO.md)).
- **mmap and OS-coupled memory.** Explicit hand-coded sync is chosen over
  memory-mapped files for clarity and control over the durability point.
- **Group-commit / fsync-batching, versioned WAL headers, expanded fault
  profiles.** Exploratory durability-hardening directions tracked in issue
  [#9](https://github.com/libredb/libredb-database/issues/9); intentionally not in
  the current core.
- **Directory fsync on first file creation.** A known durability gap
  ([`ARCHITECTURE.md` 10.3](../ARCHITECTURE.md)): creating a file durably needs a
  directory fsync, currently not done.

The unifying rule: **durability hardening lands inside the guarded core under
heavy review; scaling features are pushed above the trust boundary wherever the
ordered-KV substrate allows.** The kernel earns production by staying small and
correct, not by absorbing every feature.

---

## 12. Glossary

- **WAL (write-ahead log).** An append-only file of change records; the durable
  representation. In LibreDB, the WAL *is* the database.
- **fsync.** A syscall that forces buffered writes to physical storage before
  returning; the durability point of a commit.
- **Page cache.** The OS's in-RAM buffer of file data; makes writes fast but
  loses unflushed data on power failure (hence fsync).
- **CRC-32.** A checksum used to detect a partially written (torn) record.
- **Tombstone.** A record that marks a key as deleted, rather than physically
  erasing it.
- **Compaction / checkpointing.** Rewriting the log to keep only live data,
  reclaiming space and speeding recovery. The log-structured analog of `VACUUM`.
- **Big-endian.** Byte order with the most significant byte first; makes
  byte-lexicographic order match numeric order.
- **Length-prefixing.** Writing a field's length before the field so the reader
  knows exactly how many bytes to read, with no delimiters.
- **Copy-on-write commit.** A transaction mutates a copy of the state; commit is a
  single atomic reference swap.
- **Read-your-writes.** Within a transaction, reads see that transaction's own
  pending writes.
- **Serializable.** The strongest isolation level; here achieved for free by
  serial, single-threaded execution.
- **MVCC.** Multi-version concurrency control -- keeping multiple versions of a row
  so readers and writers do not block. LibreDB does not use it.
- **Lens.** A typed view over the byte substrate (kv, document, relational) that
  adds ergonomics but no storage.
- **Trust boundary.** The small, explicit surface the system must trust; in
  LibreDB, `core.ts` plus the `FileSystem` interface.

---

## 13. References

**Source (all line numbers are [`src/core.ts`](../src/core.ts) unless noted):**

- Types: `Key`/`Value` (L35-39), `Transaction` (L62-75), `FileSystem`/`WalFile`
  (L109-134), `OpenOptions` (L143-155).
- Ordered store: `compareKeys` (L189), `locate` (L203), `applySet` (L219),
  `applyDelete` (L227), `makeTransaction` (L248).
- Record codec: format comment (L275-294), `writeU32` (L302), `readU32` (L311),
  `crc32` (L326), `encodeRecord` (L339), `replayPayload` (L371).
- Durability + recovery: `recover` (L397), `openLog` (L429, fsync at L437),
  `open` (L453), `transact` (L493, disk-then-memory at L508-509), `close` (L517).
- Adapters and lenses: [`src/adapter/node-fs.ts`](../src/adapter/node-fs.ts),
  [`src/adapter/opfs.ts`](../src/adapter/opfs.ts),
  [`src/adapter/store.ts`](../src/adapter/store.ts),
  [`src/lens/kv.ts`](../src/lens/kv.ts),
  [`src/lens/catalog.ts`](../src/lens/catalog.ts),
  [`src/index.ts`](../src/index.ts).

**Documents:**

- [`ARCHITECTURE.md`](../ARCHITECTURE.md) -- authoritative structure and algorithms.
- [`docs/DESIGN.md`](./DESIGN.md) -- locked decisions and rationale.
- [`MANIFESTO.md`](../MANIFESTO.md) -- what LibreDB refuses to be.
- [`docs/RELIABILITY.md`](./RELIABILITY.md) -- the deterministic-simulation harness.

**Issues:**

- [#9](https://github.com/libredb/libredb-database/issues/9) -- kernel durability
  hardening (WAL headers, fsync-batching, DST fault profiles).
- [#12](https://github.com/libredb/libredb-database/issues/12) -- WAL compaction.
