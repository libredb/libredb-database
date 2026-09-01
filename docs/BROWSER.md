# LibreDB in the browser

LibreDB is an **embedded, in-process database**. In a web app that means it runs
*inside the page* (or a Web Worker) — there is **no server, no backend, no network
round-trip**. You `import` it, `open()` a database, and read/write through the
lenses, exactly like on Node, except the bytes live in the browser instead of on
a server's disk.

This guide explains how a web app (React, Vite, Astro, Next.js, plain ESM, …)
uses LibreDB directly in the browser, the two storage modes, the one hard rule
(OPFS needs a Web Worker), the framework-specific gotchas (mostly SSR), and how
much data you can actually keep there (§7).

> TL;DR: import from `@libredb/libredb/browser`. `open()` is **in-memory** and
> works anywhere. For **durable** storage, run LibreDB **in a Web Worker** and
> back it with an OPFS sync access handle. There is no backend in either case.

---

## 1. Install and import

```sh
npm install @libredb/libredb   # or: bun add / pnpm add / yarn add
```

Always import the **browser entry** in browser code:

```ts
import { open, kv, doc, table, opfsFileSystem } from "@libredb/libredb/browser";
```

Why the explicit `/browser` subpath?

- It is built to import **nothing** from `node:`, so it bundles cleanly for the
  browser.
- Its `open` is typed with `BrowserOpenOptions` — `fs` is **required when you pass
  a `path`** (the browser has no default filesystem), so a mistake is a *compile*
  error instead of a runtime surprise.

The bare `@libredb/libredb` entry also resolves to the browser build at runtime
(via the package's `browser` export condition), but TypeScript will usually show
you the Node types for it unless you enable the `browser` condition
(`customConditions`). Importing `@libredb/libredb/browser` keeps types and runtime
in step. Use it.

---

## 2. The two storage modes

| Mode | How | Where it runs | Survives reload? |
| --- | --- | --- | --- |
| **In-memory** | `open()` | Anywhere (main thread, Worker, SSR) | No — gone on reload |
| **Durable (OPFS)** | `open({ path, fs: opfsFileSystem(handle) })` | **Web Worker only** | Yes — persists in the origin's OPFS |

Both are fully embedded — no backend either way. The synchronous LibreDB kernel
maps onto an OPFS **sync access handle** (whose `read`/`write`/`getSize`/
`truncate`/`flush` are synchronous), which is why durable browser storage works
with no async core. Sync access handles are only available **inside a dedicated
Web Worker**, so durable LibreDB *must* live in a Worker.

One honest caveat on the word *durable*: the kernel's durability point maps to
the handle's `flush()`, and the OPFS specification does not promise that
`flush()` carries POSIX-`fsync` strength against **power loss** — the browser's
storage layer decides when bytes reach stable media. In practice a committed
write survives a tab crash, a page reload, and a browser restart; what a sudden
power cut can lose is browser-and-OS dependent. Treat OPFS durability as "as
strong as the browser's flush", not as a battery-backed guarantee (verifying
this per engine is tracked in
[#10](https://github.com/libredb/libredb-database/issues/10)). Storage may also
be evicted under pressure unless you request persistence, and the database has
size limits well below the browser's quota — both are in §7.

---

## 3. In-memory: the 30-second start (main thread)

Good for tests, demos, ephemeral UI state, or "I'll just use a `Map`" cases that
want real queries. No Worker, no setup:

```ts
import { open, kv, table } from "@libredb/libredb/browser";

const db = open(); // in-memory; lives only until the page reloads

kv(db).set("greeting", "hello");
kv(db).get("greeting"); // "hello"

const users = table(db, "users", {
  primaryKey: "id",
  columns: { id: "string", name: "string", age: "number" },
});
users.insert({ id: "1", name: "Ada", age: 36 });
users.where({ age: 36 }).select("name").toArray(); // [{ name: "Ada" }]
```

That's it — this runs on the main thread, in any framework, with no special
configuration.

---

## 4. Durable: persist to OPFS (in a Web Worker)

For data that survives reloads, store it in the **Origin Private File System
(OPFS)** — a private, per-origin filesystem built into modern browsers. The
database file lives there; still no server.

The shape of a real app: a Worker **owns** the database (it holds the one OPFS
handle and runs every transaction), and the UI talks to it with `postMessage`.

> Requirements: a **secure context** (HTTPS, or `localhost`) and a browser with
> OPFS sync access handles (Chrome/Edge 102+, Firefox 111+, Safari 16.4+; check
> caniuse for the current matrix). One file can be opened by **one** sync access
> handle at a time — LibreDB is single-writer (see §6).

### 4.1 The worker — `db.worker.ts`

```ts
import { open, kv, type Database, opfsFileSystem } from "@libredb/libredb/browser";

let db: Database;

// Acquiring the handle is async and happens ONCE; using it (and the kernel) is
// synchronous, so the database itself stays sync.
const ready = (async () => {
  const root = await navigator.storage.getDirectory();
  const file = await root.getFileHandle("app.libredb", { create: true });
  const handle = await file.createSyncAccessHandle(); // exclusive, Worker-only
  db = open({ path: "app.libredb", fs: opfsFileSystem(handle) });
})();

// A tiny request/response protocol. Swap in your own ops or a library like Comlink.
self.onmessage = async (event: MessageEvent) => {
  await ready;
  const { id, op, args } = event.data;
  try {
    let result: unknown;
    switch (op) {
      case "set":
        result = kv(db).set(args.key, args.value);
        break;
      case "get":
        result = kv(db).get(args.key);
        break;
      case "scan":
        result = kv(db).prefix(args.prefix).toArray();
        break;
      default:
        throw new Error(`unknown op: ${op}`);
    }
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: (error as Error).message });
  }
};
```

### 4.2 The main thread — a small client

```ts
const worker = new Worker(new URL("./db.worker.ts", import.meta.url), { type: "module" });

function call<T>(op: string, args: unknown = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const onMessage = (event: MessageEvent) => {
      if (event.data.id !== id) return;
      worker.removeEventListener("message", onMessage);
      event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.result);
    };
    worker.addEventListener("message", onMessage);
    worker.postMessage({ id, op, args });
  });
}

await call("set", { key: "user:1", value: "Ada" });
await call<string | undefined>("get", { key: "user:1" }); // "Ada" — and still there after reload
```

`new Worker(new URL("./db.worker.ts", import.meta.url), { type: "module" })` is the
standard, bundler-friendly way to load a module worker; Vite, webpack/Next, and
esbuild all understand it.

> Prefer not to hand-roll the protocol? [Comlink](https://github.com/GoogleChromeLabs/comlink)
> wraps the Worker so you can `await dbApi.set("user:1", "Ada")` directly. LibreDB
> doesn't depend on it — it's just a nicer ergonomics layer over the same
> Worker boundary.

---

## 5. Framework guides

The only cross-cutting issue is **server-side rendering (SSR)**: frameworks like
Next.js and Astro render components on the server (Node), where `window`,
`navigator.storage`, and `Worker` don't exist. So browser-database code must run
**client-side only** — and durable (OPFS) code must additionally be in a Worker.

### Vite / React / SvelteKit (client) / SolidStart — client components

In a client component, set up the worker after mount:

```tsx
import { useEffect, useState } from "react";

export function useLibreDb() {
  const [api, setApi] = useState<ReturnType<typeof makeClient> | null>(null);
  useEffect(() => {
    const worker = new Worker(new URL("./db.worker.ts", import.meta.url), { type: "module" });
    setApi(makeClient(worker)); // makeClient wraps `call()` from §4.2
    return () => worker.terminate();
  }, []);
  return api;
}
```

Vite handles the `new Worker(new URL(...))` form out of the box, including in
production builds.

### Next.js (App Router) — keep it on the client

LibreDB browser code must not run during SSR. Two rules:

1. Mark the component `"use client"`.
2. Touch `navigator.storage` / create the `Worker` only inside `useEffect`
   (never during render), so it never executes on the server.

```tsx
"use client";
import { useEffect, useRef } from "react";

export default function Notes() {
  const workerRef = useRef<Worker>();
  useEffect(() => {
    workerRef.current = new Worker(new URL("./db.worker.ts", import.meta.url), { type: "module" });
    return () => workerRef.current?.terminate();
  }, []);
  // ... render UI, send ops to workerRef.current
}
```

If you only need **in-memory** LibreDB (no OPFS), you can `open()` directly in a
client component's `useEffect` without a Worker. For **durable** data, use the
Worker as above. (Tip: a `dynamic(() => import("./Notes"), { ssr: false })` import
also guarantees the module never loads on the server.)

### Astro — client islands

Astro is server-first; put the database in a hydrated island or a client script:

```astro
---
// component frontmatter runs at build/SSR time — no LibreDB here
---
<my-notes></my-notes>
<script>
  import { open, kv } from "@libredb/libredb/browser";
  const db = open();               // in-memory island state
  kv(db).set("opened", String(Date.now()));
  // for durable data, spawn the Worker from this client script instead
</script>
```

Use a framework island with `client:only="react"` (so it never SSRs) when
embedding a React/Vue/Svelte component that owns the Worker.

### Plain ESM / no framework

Import the browser entry directly from an esm.sh-style CDN or your bundle:

```html
<script type="module">
  import { open, kv } from "https://esm.sh/@libredb/libredb@0.1.3/browser";
  const db = open();
  kv(db).set("k", "v");
</script>
```

For durable storage, point a `new Worker(...)` at a module that does the OPFS
setup from §4.1.

---

## 6. Constraints and gotchas

- **OPFS is single-writer.** `createSyncAccessHandle()` takes an **exclusive** lock
  on the file — only one handle per file at a time. So one Worker owns the database;
  a second tab/Worker cannot open the same file concurrently. For multi-tab apps,
  route all access through a single owner (e.g. a `SharedWorker`, or elect one tab
  as writer). This matches LibreDB's single-writer model — on Node the kernel
  enforces it with an exclusive `<path>.lock` file (a second `open` throws
  `LOCKED`); in the browser the sync access handle's own exclusivity provides
  the same guarantee, so the OPFS adapter needs no lock file. It is the
  foundation, not a server.
- **OPFS needs a Worker and a secure context.** Sync access handles exist only in
  dedicated Web Workers, over HTTPS or `localhost`. In-memory `open()` has neither
  requirement.
- **Persistence can be evicted.** OPFS data is per-origin and may be cleared by the
  browser under storage pressure unless you request persistent storage. How much
  space you get, how to ask for it, and what happens when it runs out are in §7.
- **In-memory is ephemeral.** `open()` data vanishes on reload — by design.
- **Release the handle.** Call `db.close()` (which closes the sync access handle)
  when you're done, e.g. on `worker` teardown, so the file's exclusive lock is
  freed for the next session.
- **It's still LibreDB.** All lenses behave exactly as documented in the
  [guides](./guides/) — kv, document, relational, and the catalog. The browser
  changes *where the bytes live*, not the API.

---

## 7. Storage limits and persistence

"How big can my database be in the browser, and will it survive?" Three
different ceilings answer that, and they are not the same number:

1. **Memory** — the whole store lives in RAM. This is the real limit today.
2. **WAL growth** — the file grows with write *history*, not just live data.
3. **The origin's storage quota** — usually the largest of the three, and the
   only one people expect.

Quota is the number everyone asks about; memory is the number that actually
stops you. Both are below.

### 7.1 The quota: OPFS is not `localStorage`

The 5-10 MB figure you remember belongs to **Web Storage** (`localStorage` /
`sessionStorage`) and does not apply here. OPFS draws on the Storage Standard's
per-origin quota pool — shared with IndexedDB and the Cache API — and that pool
is a fraction of the *disk*, not a handful of megabytes.

Approximate per-origin quotas. These are browser *policy*: they vary by browser,
version, device, and free disk space, so treat them as orientation and measure at
runtime (§7.2) rather than budgeting against the table.

| Browser | Best-effort (the default) | With persistent storage granted |
| --- | --- | --- |
| Chrome / Edge (Chromium) | up to ~60% of total disk | the same ~60% |
| Firefox | the smaller of ~10% of disk **or 10 GiB** | up to ~50% of disk (capped at 8 TiB) |
| Safari / WebKit (macOS 14+, iOS 17+) | ~60% of disk in the browser; ~15% for a non-browser app embedding web content | the same |

Two details that catch people out: Firefox's best-effort mode is capped at
**10 GiB** however large the disk is, and in WebKit a cross-origin iframe gets
roughly a tenth of its parent's quota. Eviction is also all-or-nothing — an
origin's storage is dropped as a whole, never partially.

Reference: MDN,
[Storage quotas and eviction criteria](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria).

### 7.2 Ask the browser: `navigator.storage.estimate()`

The runtime number is worth more than any table, and it works in the Worker that
owns the database:

```ts
// Window and Worker, secure contexts only.
const { usage = 0, quota = 0 } = await navigator.storage.estimate();
console.log({ usage, quota, headroom: quota - usage });
```

Two caveats. The values are deliberately imprecise — browsers pad and deduplicate
them — so use them for headroom decisions ("am I near the edge?"), never as an
exact byte budget. And `usage` covers the **whole origin**, IndexedDB and Cache
API included, not just your `.libredb` file.

### 7.3 Persistent storage and eviction

By default an origin's storage is **best-effort**: under disk pressure the
browser evicts least-recently-used origins, and an evicted origin loses
everything at once. **Persistent** storage takes the origin out of that sweep —
it is then cleared only by explicit user action.

You ask for it with `navigator.storage.persist()`. Two facts to design around:

- **It is a request, not a switch.** The browser decides by its own rules
  (Firefox prompts; Chromium decides from engagement signals). Read the boolean
  it resolves to and handle `false`.
- **It is a `Window` method.** `persist()` is not exposed in workers, so it
  cannot be called from the database Worker. `persisted()` and `estimate()`
  *are* worker-exposed.

So the persist call belongs in the **main-thread half of the Worker setup** from
§4.2, next to where the Worker is spawned:

```ts
// main thread — alongside creating the DB worker
const worker = new Worker(new URL("./db.worker.ts", import.meta.url), { type: "module" });

// persist() exists only on Window: call it here, never inside the Worker.
if (navigator.storage?.persist) {
  const granted = await navigator.storage.persist();
  if (!granted) {
    // Still best-effort. The origin can be evicted under disk pressure, so keep
    // an export or sync path — do not treat the database as the only copy.
  }
}
```

Inside the Worker you can still read the state you were granted:

```ts
// db.worker.ts — persisted() and estimate() are available in workers
const persistent = await navigator.storage.persisted(); // boolean
const { usage, quota } = await navigator.storage.estimate();
```

**Safari/WebKit adds a rule of its own.** With cross-site tracking prevention
enabled, an origin the user has not interacted with for seven days of browser use
has its script-created storage deleted. A web app added to the Home Screen is not
part of Safari and keeps its own counter of days of use, which using the app
resets — that is a separate counter, not an exemption. For a database this is the
eviction risk that matters more than quota, and persistent storage is what
mitigates it. (References: MDN, above; WebKit,
[Full Third-Party Cookie Blocking and More](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/).)

### 7.4 What happens when the quota runs out

Quota exhaustion is the browser's `ENOSPC`, and it travels LibreDB's existing
IO-failure path — there is no browser-specific error handling, by design:

```
  OPFS write() exceeds the origin's quota
        |  throws QuotaExceededError
        v
  opfsFileSystem(handle).append()      adapter/opfs.ts - passes it through
        |
        v
  kernel commit path: append -> fsync  core.ts - catches, latches
        |
        v
  LibreDbError { code: "FAILED", cause: QuotaExceededError }
```

Concretely:

- the `transact()` that hit the wall throws `code: "FAILED"`, carrying the
  browser's `QuotaExceededError` as `cause`;
- its writes are **not** applied in memory — RAM and the file stay on the last
  good state;
- the database **latches**. Every later `transact()` throws `FAILED` too,
  **including read-only ones** (every read runs inside a transaction), until you
  `close()` and open again;
- reopening replays the log, truncates any partially-written tail record the
  failure left — which also returns those bytes — and reports the truncation
  through `onRecovery`.

```ts
import { LibreDbError, kv } from "@libredb/libredb/browser";

try {
  kv(db).set("user:1", "Ada");
} catch (error) {
  if (error instanceof LibreDbError && error.code === "FAILED") {
    const cause = error.cause as { name?: string } | undefined;
    if (cause?.name === "QuotaExceededError") {
      // Out of quota. This instance is done: close(), release the sync access
      // handle, free space, then open again.
    }
  }
}
```

Why the latch exists at all — appending past a torn record would let the next
recovery silently destroy commits that already returned — is the durability
contract in [`RELIABILITY.md`](./RELIABILITY.md); this section only connects the
browser's failure to it.

**One trap specific to append-only storage: deleting data does not free quota.**
A delete appends a tombstone record, so the file gets *bigger*. Recovering space
means compaction (§7.5), not deletion.

### 7.5 WAL growth: quota is spent on history, not just data

The file is a write-ahead log, so every set, overwrite, and delete appends a
record and nothing is ever edited in place. Memory holds the current result; the
file holds the whole history. A 500 MB live data set that has been rewritten many
times can easily sit behind a multi-gigabyte file — the quota is consumed by
superseded versions and tombstones, not by your data.

Compaction is what reclaims that history (one record per live key, superseded
versions and tombstones dropped). **It is not built yet** — it is tracked as
[#12](https://github.com/libredb/libredb-database/issues/12). Until it lands the
only way to reclaim space is to do it by hand: read the live data out of the
database, write it into a fresh file, and remove the old one. Treat that as a
stopgap, not a feature.

### 7.6 The ceiling that actually stops you: memory

Quota is rarely the first wall. LibreDB keeps the **whole store in memory** as one
sorted array (the file is only the log that rebuilds it), and `open()` currently
reads the **entire log into a single `Uint8Array`** before replaying it. So:

- **steady state** costs roughly your live data set, in RAM, in the Worker;
- **peak at open** is the log's bytes *plus* the live set they replay into — up to
  about twice the file size when most of the log is still live.

Above that sit two harder caps, neither of them LibreDB's:

- **The engine's maximum typed-array length.** Firefox documents 2^33 (8 GiB) on
  64-bit builds and 2 GiB - 1 on 32-bit ones; other engines set their own limits.
  Once the log exceeds that cap, `open()` cannot allocate its buffer at all,
  however much quota is free.
- **The tab or Worker's memory budget**, which is much lower on mobile, in
  embedded WebViews, and in headless/CI browsers than the engine cap suggests.

Rules of thumb for the engine as it stands — guidance, not guarantees:

| Live data set | What to expect |
| --- | --- |
| up to ~100 MB | comfortable everywhere, mobile included |
| ~500 MB | fine on desktop; already heavy on a phone |
| ~1 GB | the practical edge — slow opens, and peak memory is the risk |
| ~10 GB | out of reach today, whatever quota `estimate()` reports |

These are the same limits LibreDB has on Node: they come from the in-memory store
(see [`ARCHITECTURE.md`](../ARCHITECTURE.md) section 5), not from the browser.
Bounding `open()`'s memory by streaming recovery record-by-record is tracked in
[#64](https://github.com/libredb/libredb-database/issues/64).

**So a reported 60 GB of free quota does not mean a usable 60 GB database.** Size
against memory first, then check the quota can hold the log that memory implies.

### 7.7 A worked example

An offline-first app keeps customer records, cached API responses, and a local
event log in one `.libredb` file. At launch: 300 MB live, a 400 MB file. Six
months of edits later: **450 MB live, a 2.2 GB file** — the extra 1.8 GB is
superseded versions and tombstones, not data.

What each piece of the picture tells the developer:

- **`estimate()`** reports `usage` near 2.2 GB against a `quota` in the tens of
  GB. Plenty of headroom, so quota is not the problem — and knowing that is the
  point of asking at runtime instead of guessing (§7.2).
- **`persist()`** matters more than the headroom does. At 2.2 GB this origin is a
  large, attractive eviction target on a full disk, and in Safari seven days
  without interaction is enough on its own (§7.3).
- **Quota exhaustion**, if the disk did fill, would latch the database on the next
  write — reads included — until close and reopen (§7.4). Deleting records to
  recover would make the file *larger*.
- **Compaction** is what turns 2.2 GB back into ~450 MB. Until #12 lands, that is
  a manual copy into a fresh file (§7.5).
- **Memory** is the ceiling that bites first anyway. 450 MB live is workable on a
  desktop; the 2.2 GB log is the real cost, because opening it allocates the whole
  file in one buffer before replaying it into a 450 MB store (§7.6). This app
  would start failing to open on mobile long before it ran out of quota.

The practical fix set, in order: compact (manually, today) to keep the log near
the live set; request persistence; check `estimate()` before large imports; and
keep the live set inside the memory budget of the weakest device you support.

---

## 8. Which mode should I use?

- **Ephemeral UI state, prototypes, tests, demos** → in-memory `open()`, main
  thread. Simplest possible setup.
- **Data that must survive reloads (offline notes, local-first app state, caches)**
  → OPFS in a Worker (§4).
- **Multi-tab, shared, durable** → OPFS via a single `SharedWorker` owner (§6).

In all of these there is no backend: LibreDB is embedded in the browser, and the
data never leaves the user's machine unless *you* send it somewhere.

See also: [`ARCHITECTURE.md`](../ARCHITECTURE.md) for how the WAL and recovery
work under the hood, and the [lens guides](./guides/) for the query APIs.
