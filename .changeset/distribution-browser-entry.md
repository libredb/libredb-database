---
"@libredb/libredb": minor
---

Add a browser entry point (`@libredb/libredb/browser`) and make the kernel
runtime-agnostic.

The `node:fs` dependency moved out of the kernel (`core.ts`) into a dedicated
adapter, so importing LibreDB no longer drags `node:fs` into the module graph.
The default Node entry (`@libredb/libredb`) is unchanged: `open({ path })` still
defaults to the real filesystem and is durable out of the box. The new browser
entry exposes the same lens surface with an `open` that has no default
filesystem — in-memory databases work anywhere, and a path-backed open accepts
an injected filesystem. A bundler targeting the browser now resolves a build
free of Node built-ins via the `browser` export condition.
