---
"@libredb/libredb": patch
---

Document the browser entry's full export surface.

The browser entry now declares its exports as documented local aliases instead of bare re-exports: a symbol exported by two entrypoints is emitted as an undocumented reference for the second one by the documentation tooling, which left the browser half of the API blank on JSR and in editors. Every symbol now carries browser-context documentation; runtime behavior and the exported API are unchanged.
