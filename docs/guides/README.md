# LibreDB guides

Hands-on guides for each lens over the LibreDB kernel. Start with key-value (the simplest face), then
move up to documents and typed tables. All three are thin lenses over the same ordered key-value core.

- [Key-value](./key-value.md) — a durable, ordered, string-keyed map. The proof lens.
- [Document](./document.md) — collections of JSON documents. The differentiator lens.
- [Relational](./relational.md) — schema-validated typed tables, with `where` / `select` / `join`. The
  reach lens.
- [Catalog](./catalog.md) — the self-describing registry of what each namespace holds.

See also: the [README](../../README.md) for the quick start, [`../ARCHITECTURE.md`](../ARCHITECTURE.md)
for how it all works under the hood, and [`../RELIABILITY.md`](../RELIABILITY.md) for the durability
and crash-recovery story.
