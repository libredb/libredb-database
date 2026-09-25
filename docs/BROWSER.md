# LibreDB in the browser

LibreDB is an **embedded, in-process database**. In a web app that means it runs
*inside the page* (or a Web Worker) — there is **no server, no backend, no network
round-trip**. You `import` it, `open()` a database, and read/write through the
lenses, exactly like on Node, except the bytes live in the browser instead of on
a server's disk.

This guide explains how a web app (React, Vite, Astro, Next.js, plain ESM, …)
uses LibreDB directly in the browser, the two storage modes, the one hard rule
(OPFS needs a Web Worker), and the framework-specific gotchas (mostly SSR).

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
[#10](https://github.com/libredb/libredb/issues/10)). Storage may also be
evicted under pressure unless you request persistence — see §7.

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
  // Ask for eviction-resistant storage before the first byte is written. This
  // is a request, not a command — read back navigator.storage.persisted() if
  // the answer matters (§7.2).
  await navigator.storage.persist();
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
  browser under storage pressure. Call `await navigator.storage.persist()` to
  request durable (eviction-resistant) storage, and `navigator.storage.estimate()`
  to check quota. The full picture — quota per engine, Safari's 7-day ITP eviction,
  and what a quota-exceeded write does — is §7.
- **In-memory is ephemeral.** `open()` data vanishes on reload — by design.
- **Release the handle.** Call `db.close()` (which closes the sync access handle)
  when you're done, e.g. on `worker` teardown, so the file's exclusive lock is
  freed for the next session.
- **It's still LibreDB.** All lenses behave exactly as documented in the
  [guides](./guides/) — kv, document, relational, and the catalog. The browser
  changes *where the bytes live*, not the API.

---

## 7. Storage limits and persistence

"How big can my database be in a browser, and will it survive?" deserves one
honest answer instead of folklore. There are three separate limits, none of
them the 5-10 MB `localStorage` story: the **quota** (how much disk the origin
may use), **eviction** (whether the browser keeps it at all), and **memory**
(the real ceiling today, §7.4).

### 7.1 Quota: OPFS is not localStorage

LibreDB's durable mode writes one file into OPFS, which draws from the same
Storage Standard quota pool as IndexedDB — per-origin and engine-sized:

| Browser | Per-origin quota |
| --- | --- |
| Chrome / Edge | ~60% of disk |
| Firefox | ~10% of disk; ~50% with `persist()` |
| Safari / WebKit | ~60% in-browser; ~15% in embedded WebViews |

Those are engine defaults, not promises — a constrained headless Chromium
profile still reported a 10 GB quota to libredb.org in testing. The runtime
truth for your origin is
[`navigator.storage.estimate()`](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/estimate),
which reports current usage and quota:

```ts
const { usage, quota } = await navigator.storage.estimate();
```

The authoritative summary is MDN's
[Storage quotas and eviction criteria](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria).

### 7.2 Eviction: the part that loses data silently

Hitting the quota fails a write loudly (§7.3). Losing storage silently is
worse, and it happens through eviction:

- Without `navigator.storage.persist()`, per-origin storage is **best-effort**:
  the browser may evict it under disk pressure.
- Safari's Intelligent Tracking Protection deletes **all script-writable
  storage** for an origin after 7 days without user interaction (home-screen
  web apps are exempt). For a database this is the headline risk, above quota.

So request persistence before the first byte matters — the Worker example in
§4.1 calls `await navigator.storage.persist()` while acquiring the handle — and
read back what the browser decided:

```ts
await navigator.storage.persist();   // request; engines may grant or deny
await navigator.storage.persisted(); // the current state — check this
```

`persist()` is a request, not a command: an engine may grant it automatically,
heuristically (typically once the user has engaged with the site), or never.
Check `persisted()` and design for the "not granted" case — export anything
you cannot afford to lose.

### 7.3 Running out of quota: the failure latch

An OPFS write that hits the quota throws `QuotaExceededError` from the sync
access handle — the browser's ENOSPC. LibreDB treats it exactly like ENOSPC on
Node: since v0.2.0 a failed append or fsync **latches the database**, so every
later `transact()` throws `code: "FAILED"` (the quota error rides along as
`cause`) until the database is closed and reopened; reopening repairs the log
tail. In practice, when the origin quota runs out:

- every commit that returned before the failure survives the reopen,
- the failing transaction throws with the quota error as its cause,
- nothing is silently truncated or lost.

This is the [`RELIABILITY.md`](./RELIABILITY.md) durability contract applied to
the browser's ENOSPC — worth knowing before it happens.

### 7.4 The practical ceiling is memory, not disk

The whole store lives in RAM, and `open()` currently reads the entire WAL into
one `Uint8Array` (engine ceilings: ~8 GiB on 64-bit, ~2 GiB on 32-bit; opening
transiently needs roughly 2x the file size). Honest guidance, browser and Node
alike:

- **100 MB** — comfortable everywhere, on any engine.
- **500 MB** — fine on desktop-class browsers.
- **~1 GB** — the practical edge today.
- **10 GB** — out of reach regardless of what `estimate()` reports. What
  changes this: streaming recovery
  ([#64](https://github.com/libredb/libredb-database/issues/64)) and compaction
  ([#12](https://github.com/libredb/libredb-database/issues/12)).

### 7.5 The log consumes quota until compaction lands

The WAL is append-only, so quota is consumed by history, not live data: deleted
keys free no space, and `estimate().usage` grows with every write until
compaction ([#12](https://github.com/libredb/libredb-database/issues/12))
lands.

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
