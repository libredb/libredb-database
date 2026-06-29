---
"@libredb/libredb": minor
---

Add OPFS-backed browser persistence via `opfsFileSystem` (exported from
`@libredb/libredb/browser`).

A browser `FileSystemSyncAccessHandle` exposes synchronous read/write/getSize/
truncate/flush/close, which map directly onto the kernel's synchronous filesystem
seam — so a LibreDB database can be durable in the browser with no async core.
Inside a Web Worker, obtain a sync access handle and pass it to `open`:

```ts
const root = await navigator.storage.getDirectory();
const file = await root.getFileHandle("app.libredb", { create: true });
const db = open({ path: "app.libredb", fs: opfsFileSystem(await file.createSyncAccessHandle()) });
```

The adapter takes an already-open handle (acquisition is async and the caller's),
keeping `open` synchronous. The new `SyncAccessHandle` type names the handle
shape the adapter needs, so the package depends on no DOM lib types.
