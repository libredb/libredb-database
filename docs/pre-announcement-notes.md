# Pre-announcement engineering audit

LibreDB — expert review before the public launch
@libredb/libredb v0.1.3 · audited 2026-07-02/03 · 8 review dimensions, 69 agents, every critical/high finding independently verified by two adversarial refuters against the real code.
Result: 42 confirmed findings (2 critical, 13 high, 12 medium, 15 low), 2 claims refuted, 3 additions from a completeness pass.

2 **Critical**
13 **High**
12 **Medium**
15 **Low**
2 **Refuted**

Verdict: do not announce yet — but the distance is short
The kernel is genuinely well built for the failure model it was designed around (clean crash, torn tail). The problems are concentrated in what sits outside that model: IO errors that are not a crash, a second writer, a wrong file, a caller-held buffer, an async callback. Two findings are critical (one destroys arbitrary user files on a typo'd path), and one cluster — the poisoned-WAL-after-failed-append chain — directly falsifies the README's headline durability claim, the sentence most likely to be publicly reproduced and disproven after a launch. Nearly everything below is fixable in days, and several fixes are one-guard-plus-one-test small. Fix the blockers, re-run the gate, then announce.


---

1. Announcement blockers
Reachable by a normal user doing normal things; each violates a promise the docs currently make. The 13 raw high-severity findings cluster into the root causes below (several were independently found by 3–4 different review dimensions — a strong signal).

**Critical**
B1 — open({ path }) on a non-LibreDB file silently and permanently erases it

src/core.ts:413 · partially tracked in #9 (magic header)

recover() cannot parse the first record of a foreign file, stops at offset 0, and file.truncate(0) wipes the file. A typo'd path or libredb set notes.txt k v destroys arbitrary user data instantly, with no error and no undo.

Fix — WAL magic/version header (#9) plus refuse-don't-truncate semantics: unknown or missing header must throw and leave the file byte-for-byte untouched. Note this changes the on-disk format — cheapest to do before the announcement, with a migration read-path for headerless v0.1.x files.

**Critical**
B2 — transact(async tx => ...) is silently accepted; writes after the first await never reach the WAL

src/core.ts:502

An async callback returns a pending Promise; transact() commits immediately with whatever the journal held at the first await. Later writes mutate the already-swapped working array — visible in memory, absent from disk. TypeScript happily infers T = Promise<...>, so it type-checks. This is the default reflex of every modern DB user; the data reappears missing only after a restart.

Fix — one guard: if run() returns a thenable, throw "transact() body must be synchronous" before committing. One test pins it.

**High**
B3 — a failed append/fsync poisons the WAL: later acknowledged commits are silently destroyed at next recovery

src/core.ts:435,508 · src/adapter/node-fs.ts:36 · found independently by 4 dimensions; adjacent to #9 but the kernel-side latch is untracked

ENOSPC/EIO mid-writeSync leaves a torn record on disk; transact() re-throws but the database keeps accepting writes, appending fresh records after the garbage. recover() breaks at the torn record and truncates everything after it — including commits whose transact() returned success and fsync'd. The comment at core.ts:503 ("memory and disk still agreeing on the prior state") is factually wrong for partial writes. This directly falsifies README line ~266 / RELIABILITY.md ("a returned transact() is durable") and the claim "a crash can only ever damage the last record".

Fix — on any append/fsync failure, either latch the database failed (every later transact throws until reopen — SQLite/Postgres behavior), or truncate back to the pre-append offset before accepting the next write. Never continue past a failed fsync (fsyncgate). Add the matching DST fault profile (see section 3).

**High**
B4 — no double-open protection: two open() calls on one file silently diverge, lose updates, and can corrupt the log

src/core.ts:474 · src/adapter/node-fs.ts:25 · found by 4 dimensions

Each open recovers an independent in-memory store and appends to the same file; neither sees the other. In the stated beachhead (test/dev) this is an everyday event: parallel test workers on one fixture, a stale dev-server surviving hot-reload, the CLI run against a live app. Every comparable embedded DB locks (SQLite, LMDB, LevelDB). The lock machinery already exists in src/cli/lock.ts — but only the CLI uses it.

Fix — exclusive lock at open(), released at close(): an O_EXCL <path>.lock via the FileSystem seam plus an in-process open-paths set. If deferred, at minimum a loud documented constraint — today it appears nowhere.

**High**
B5 — keys/values are stored and returned by reference: caller buffer reuse silently corrupts the committed store

src/core.ts:250-262

tx.set stores the caller's Uint8Array as-is; get/getRange return internal buffers. Reusing one scratch buffer in a loop (the standard byte-key pattern from LMDB/RocksDB) retro-corrupts every previously written key: binary search misses, the sorted invariant breaks, memory diverges from disk. Untested and undocumented.

Fix — defensive-copy on set (and on returned values), or document transfer-of-ownership loudly. Copying is the right default for an embeddable DB; cost is one allocation per op. Pin whichever contract with tests.

**High**
B6 — getRange iterator is silently invalidated by tx.set/tx.delete: delete-while-scanning skips entries

src/core.ts:262-271

The lazy generator walks the live working array by index; a delete shifts elements left and the scan skips the next entry (inserts duplicate). "Scan a prefix and delete what you find" — the most natural use of the API — silently processes every other entry and reports success.

Fix — snapshot the matching entries at first next() (entries are immutable objects; this is cheap), or detect structural modification and throw. Either way, document and test it.

**High**
B7 — a colon in a collection/table name escapes its namespace: silent cross-collection collisions

src/lens/document.ts:116

doc(db, `tenant:${tenantId}`) — the natural multi-tenant pattern — produces keys that collide with other namespaces and leak into other scans; for relational tables it can also shadow catalog entries. Data corruption with no error.

Fix — reject ':' (and the empty name) in the name validator with the same loud-error style as the reserved-marker rule, or length-prefix/escape names in the key codec.

**High**
B8 — recovery is silently destructive: mid-log corruption truncates everything after it, with zero reporting

src/core.ts:408-413 · partially tracked in #9

One flipped bit in an early record of a long-lived WAL makes reopen silently delete every later transaction — and the truncate makes it permanent. Torn-tail truncation is correct for the crash model; mid-log corruption (bit rot, partial copies, cloud-sync tools, a second writer) is exactly what CRC exists to catch, and the response is to destroy the evidence without telling the user.

Fix — distinguish torn tail (truncate, but surface a count/callback) from mid-log corruption (valid records exist after the bad one: refuse to open, never truncate). Related: replayPayload has no bounds validation (core.ts:371, low) — a CRC-valid but structurally invalid record replays as garbage ops instead of erroring.

**High**
B9 — no parent-directory fsync on file creation: a fresh database can vanish entirely after power loss

src/adapter/node-fs.ts:25,43

POSIX does not make a new file's directory entry durable until the directory is fsync'd. A user creates a DB, commits fsync'd transactions, power fails — the whole file can be gone. Also: truncateSync during recovery is never followed by an fsync, so tail truncation itself is not durable.

Fix — fsync the parent directory once when the file was created; fsync the fd after recovery truncation. Until then, RELIABILITY.md and the README Reliability section must carry the caveat (they currently overstate the guarantee).

**High**
B10 — a transient short read during recovery permanently truncates intact committed data (OPFS read() does not loop)

src/core.ts:399,413 · src/adapter/opfs.ts · related to #10

recover() treats "fewer bytes than size()" as a torn tail and truncates. The OPFS adapter's read() does not loop to fill the requested length (the API returns a byte count precisely because short reads are legal), so one transient short read at reopen destroys fsync'd commits. The DST short-read test currently asserts this loss as acceptable.

Fix — loop reads in the OPFS adapter (mirroring its append loop); in recover(), compare bytes-read to file.size() and fail loudly instead of truncating when they disagree.

**Medium**
B11 — the README's headline durability claim is publicly falsifiable as written

README.md:268 · docs/RELIABILITY.md:3 · from the completeness pass

"A crash can only ever damage the last, un-fsync'd record" is disprovable with a ~20-line reproduction (B3). For a project whose manifesto stakes its identity on honesty, this is the sentence a Hacker News commenter will quote. Fix B3/B9 or scope the claim precisely ("on a healthy disk; IO-error handling is tracked in #…").




---


2. Fix before or at announcement
Not data-destroying, but each is either a correctness surprise, a supply-chain gap reviewers will notice, or doc drift that undercuts the honesty positioning.

| **Sev** | **Finding** | **Where** | **Fix in one line** |
| ------- | ----------- | --------- | ------------------- |
| Med | NaN/Infinity pass "number" column validation, stored as null — schema round-trip broken | lenses/relational.ts:64 | Use Number.isFinite, throw like other validation errors |
| Med | doc() on a cataloged relational table bypasses schema validation, breaking the catalog's faithful-view contract (Studio renders wrong) | lenses/document.ts:206 | Throw when the name is cataloged with kind "relational" |
| Med | CLI lock has no owner identity: release() deletes whoever's lock is present; two --force writers both acquire | cli/lock.ts:49 | Write pid+host+nonce; release only your own; check liveness on --force |
| Med | npm publish still without provenance; workflow comment still claims the repo is private | publish.yml:50 · #7 | Add id-token: write + --provenance before the launch release |
| Med | JSR job runs unpinned npx --yes jsr publish holding a publish-capable OIDC token | publish.yml:84 | Pin jsr@<exact-version> |
| Med | No Dependabot/Renovate: every SHA-pinned action and image digest goes stale with no update loop | Dockerfile:29 | Add .github/dependabot.yml (actions, docker, npm weekly) |
| Med | Declared Node.js support (engines >=22, npx usage) is never exercised by CI — Bun-only gate | ci.yml:20 | Add a Node smoke job (install tarball, open/write/reopen) |
| Med | Performance envelope undocumented: full store copy per transaction (quadratic bulk writes), whole DB in RAM — seed loops look "hung" | core.ts:500 | README section: ceilings + "wrap bulk loads in one transact()" |
| Low | README status says "pre-alpha (0.0.x)" while announcing 0.1.3 — self-contradiction at first read | README.md:296 | Update the status line |


---

3. Test & DST gaps
The suite is excellent for the fault model it covers — and structurally blind to the fault classes behind section 1. "100% coverage" is true for lines, not for behaviors. These extend issue #9's DST direction with concrete profiles.

**High**
No IO-error fault injection anywhere: SimFS append/fsync never throw

src/sim/simfs.ts:60 · src/sim/dst.ts:119

A failed fsync producing a phantom commit, a partial append poisoning the tail (B3), fsync lies, crash-during-recovery, multi-crash loops — none can be expressed. Each of the kernel fixes in section 1 needs its matching seeded fault profile: armAppendError(partialBytes), armFsyncError(), error-then-continue schedules, and N crash-recover-write cycles per seed with a durability lower bound (everything fsync'd before the fault must survive).

**Medium**
Workload alphabet is 16 short ASCII keys / "vN" values — no binary, empty, or large-payload fuzz of the record codec; recovered sortedness never asserted

src/sim/workload.ts:88

Lens composite keys embed 0x00 separators and arbitrary document bytes — exactly the inputs the DST never generates. Add a seeded round-trip fuzz (random Uint8Array ops, lengths 0..N, full byte alphabet → encode → replay → deep-equal) and assert the recovered array is sorted. Also add aliasing tests once the B5 contract is pinned.

---

4. Lower priority (roadmap)
| **Sev** | **Finding** | **Where** |
| ------- | ----------- | --------- |
| Low | No typed error contract — all failures are bare Error with prefix strings; callers must match message text. Worth deciding before the API surface is public-locked. | core.ts:494 |
| Low | close() during an open transaction surfaces raw EBADF instead of a libredb error | core.ts:517 |
| Low | Lone-surrogate string keys silently collide after UTF-8 encoding (kv keys, doc ids) | lenses/kv.ts:62 |
| Low | find({ field: undefined }) matches documents lacking the field — inverted meaning for JS callers | lenses/document.ts:79 |
| Low | CLI get/scan print raw bytes — terminal escape-sequence injection when inspecting untrusted data | cli/run.ts:125 |
| Low | node-fs read() reads the whole file per call and goes by path, not fd (transient 2× memory at open; wrong inode if path is swapped) | node-fs.ts:33 · #12 |
| Low | OPFS flush() lacks fsync-strength power-loss guarantees — document the weaker contract; verify in #10's E2E | opfs.ts:69 · #10 |
| Low | Docker image runs as root — root-owned files in bind mounts; switch to distroless :nonroot | Dockerfile:30 |
| Low | Publish workflow never verifies release tag == package.json version | publish.yml:141 |
| Low | No export/dump command and no documented backup story (file-copy rule is fine — say it) | docs/CLI.md:41 |

---

5. What survived scrutiny
For balance — the audit adversarially attacked far more than it confirmed. Things that held up:

**Held**
The core design decisions are sound

The crash model (append-only + CRC + fsync-before-visible + torn-tail truncation) is correct for crashes; the trust-boundary file structure is real (no lens reaches around the kernel); the reserved-namespace/catalog contract is enforced where claimed; the workflows are SHA-pinned with least-privilege tokens; secretlint/CodeQL/SonarCloud are wired; commit and record encoding round-trips correctly under the tested alphabet. Two review claims were refuted outright (require() interop — verified empirically as intended ESM-only behavior; Docker root as a CLI-blocking issue — real but reclassified low). The 100%-coverage gate, changesets discipline, and docs volume are genuinely above the bar for a project at this stage.

---

6. Suggested sequence
|**Wave** |**Scope** |**Contents** |
| ------- | ----------- | --------- |
|1 — before announcing	| Kernel guards + honest docs (mostly small, each with a pinning test) | B2 async guard · B3 failure latch/truncate-back · B4 open lock · B5 buffer copy contract · B6 iterator semantics · B7 name validation · B9 dir-fsync + truncate-fsync · B1 magic header with refuse-don't-truncate (the one format change — do it now, with a headerless-v0.1.x read path) · B11 + README status/claims fixes |
|2 — same release train |	Prove it + supply chain | DST fault profiles + codec fuzz (section 3) · B10 read loops · provenance (#7) · jsr pin · Dependabot · Node CI job · CLI lock ownership · perf-envelope + backup docs |
|3 — tracked roadmap |	Already-open issues | #12 compaction · #10 real-browser OPFS E2E · #9 remainder (group commit) · typed errors · remaining lows |

---


**Method**
8 parallel expert reviewers (kernel durability, API contract, lenses, CLI/multi-process, adapters, test adequacy, supply chain, database must-haves) → every finding adversarially verified (critical/high: two independent refuters, unanimous confirmation required) → completeness critic. All findings cite real code read from the working tree at commit ccaca81. Refuted claims were discarded; severities shown are post-verification.

---


## Github Issues

Pre-announcement audit (docs/pre-announcement-notes.md) derinlemesine incelendi; 30 yeni GitHub issue açıldı, 4 mevcut issue milestone/label ile audit programına bağlandı. Issue gövdeleri agent odaklı: dosya referansları, kök neden, kabul kriterleri, test gereksinimleri, changeset notu ve bun run gate doğrulaması.


### Altyapı
#### Milestone'lar:

| **Milestone** | **Issue sayısı** | **Amaç** |
| ------- | ----------- | --------- |
| Wave 1: Pre-announcement blockers | 10 | Lansman öncesi zorunlu kernel + dürüst docs |
| Wave 2: Prove it + supply chain | 12 | DST, adapter, CI, supply chain |
| Wave 3: Post-announcement roadmap | 12 | Düşük öncelik + mevcut keşif issue'ları |

**Yeni label'lar:** priority/critical|high|medium|low, area/kernel|adapters|lenses|cli|dst|docs|ci, pre-announcement

---

**Wave 1 — Lansman blocker'ları (10 issue)**
| **#** | **Öncelik** | **Konu** |
| ------- | ----------- | --------- |
| #13 | P0 | Foreign file açılınca sessiz truncate — WAL magic header |
| #16 | P0 | Foreign file açılınca sessiz truncate — WAL magic header |
| #19 | P1 | Async transact() sessiz kabul |
| #21 | P1 | Append/fsync failure → poisoned WAL (fsyncgate) |
| #14 | P1 | Double-open koruması |
| #17 | P1 | Buffer aliasing / defensive copy |
| #17 | P1 | getRange + delete-while-scan |
| #20 | P1 | : içeren collection/table adları |
| #22 | P1 | Mid-log corruption → refuse, torn-tail ayrımı |
| #15 | P1 | Parent dir fsync + truncate fsync |
| #18 | P2 | README/RELIABILITY iddialarını düzelt |

---

**Wave 2 — Kanıtla + supply chain (12 issue)**

| **Issue** | **Konu** |
| ------- | --------- |
| #23 | OPFS read loop + short-read recovery |
| #25 | DST IO-error fault injection |
| #29 | DST binary/large payload fuzz |
| #26 | NaN/Infinity column validation |
| #30 | doc() on relational table guard |
| #33 | CLI lock ownership |
| #7  | npm provenance (mevcut) |
| #24 | JSR CLI pin |
| #27 | Dependabot |
| #32 | Node 22 CI smoke |
| #34 | Performance envelope docs |
| #10 | OPFS browser E2E (mevcut) |

---

**Wave 3 — Roadmap (12 issue)**
Yeni: #28–#42 (typed errors, close-during-tx, surrogate keys, find(undefined), CLI escape injection, node-fs read optimizasyonu, OPFS flush docs, Docker nonroot, publish tag check, backup docs)

Mevcut: #9 (group-commit araştırması), #12 (WAL compaction)
