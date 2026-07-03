---
"@libredb/libredb": patch
---

Complete the API documentation surface and export the types it references.

Every exported symbol — including interface and class members — now carries JSDoc, and both entrypoints carry an explicit module doc, so generated documentation (JSR, editors) is complete. Types that public signatures reference are now exported instead of being reachable-but-unnamed: `Transaction`, `Entry`, `Key`, `Value`, `Open`, and the lens seam `Store` from the main entry; `Transaction`, `Entry`, `Key`, `Value`, and `Store` from the browser entry. No runtime behavior changes.
