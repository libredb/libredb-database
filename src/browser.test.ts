/**
 * browser.test.ts — the browser entry point (Phase 0 of the distribution-channels
 * work; see docs/superpowers/specs/2026-06-29-distribution-channels-design.md).
 *
 * The browser entry (`@libredb/libredb/browser`) is the same lens surface as the
 * default Node entry, but its `open` carries NO default `node:fs` filesystem.
 * In-memory databases work out of the box; a path-backed open requires an
 * injected filesystem. The defining guarantee is that importing this entry drags
 * NOTHING from `node:` into the import graph, so a bundler can ship it to a
 * browser. These tests pin both the runtime behaviour and that static guarantee.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { expect, test } from "bun:test";

import {
  type BrowserOpenOptions,
  catalog,
  CATALOG_PREFIX,
  doc,
  isReservedKey,
  kv,
  open,
  RESERVED_MARKER,
  table,
  version,
} from "./browser.ts";

test("an in-memory database works through the browser entry", () => {
  const db = open();
  const store = kv(db);
  store.set("greeting", "hello");
  expect(store.get("greeting")).toBe("hello");
  db.close();
});

test("a path-backed open with no fs still throws at runtime (JS callers)", () => {
  // BrowserOpenOptions makes this a compile error for TS users, but a JS
  // consumer can still reach it — the kernel's runtime guard is the safety net.
  const openUntyped = open as (options: unknown) => unknown;
  expect(() => openUntyped({ path: "should-not-be-created" })).toThrow(/filesystem/i);
});

test("BrowserOpenOptions requires fs whenever a path is given (compile-time)", () => {
  // Locks the type-level guarantee: if this assignment ever stops being a type
  // error, the directive below becomes unused and the gate fails. No runtime call.
  // @ts-expect-error a path-backed open must also provide fs
  const pathWithoutFs: BrowserOpenOptions = { path: "x" };
  expect(pathWithoutFs).toBeDefined();
});

test("the browser entry exposes the full lens surface", () => {
  expect(typeof version).toBe("string");
  const db = open();

  // kv lens
  kv(db).set("k", "v");
  // document lens
  doc(db, "people").put("ada", { name: "ada" });
  // relational lens
  const users = table(db, "users", {
    primaryKey: "id",
    columns: { id: "string", name: "string" },
  });
  users.insert({ id: "u1", name: "ada" });
  // catalog + reserved-key helpers
  expect(catalog(db).size).toBeGreaterThan(0);
  expect(isReservedKey(`${CATALOG_PREFIX}users`)).toBe(true);
  expect(isReservedKey("plain")).toBe(false);
  expect(RESERVED_MARKER.length).toBe(1);

  db.close();
});

const transpiler = new Bun.Transpiler({ loader: "ts" });

/**
 * Every module specifier `source` imports, across ALL forms the build can emit:
 * static, side-effect (`import "x"`), dynamic (`import("x")`) and re-export
 * (`export ... from "x"`). Type-only imports are erased and correctly excluded.
 * Uses Bun's transpiler instead of a regex precisely so the guarantee below
 * cannot be defeated by an import form a regex would miss.
 */
const importsOf = (source: string): string[] => transpiler.scanImports(source).map((i) => i.path);

/**
 * The bare (non-relative) module specifiers reachable from `entry` through the
 * real runtime import graph. Relative specifiers are followed; the repo
 * convention (enforced by the build's import-extension rewriting) is that they
 * are explicit `.ts` paths, so a relative spec resolves directly to a file.
 * This walks the source graph, proving what a bundler would pull in without
 * depending on a bundler's tree-shaking quirks.
 */
const transitiveBareSpecifiers = (entry: string): Set<string> => {
  const seen = new Set<string>();
  const bare = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of importsOf(readFileSync(file, "utf8"))) {
      if (spec.startsWith(".")) visit(resolve(dirname(file), spec));
      else bare.add(spec);
    }
  };
  visit(entry);
  return bare;
};

test("the import-graph scanner sees every import form (no blind spots)", () => {
  // The guarantee below is only as strong as the scanner. Pin that it catches
  // the forms a regex would miss, so a future `import "node:fs"` or
  // `import("node:fs")` anywhere in the browser graph cannot pass silently.
  expect(importsOf('import "node:fs";')).toContain("node:fs");
  expect(importsOf('const p = import("node:fs");')).toContain("node:fs");
  expect(importsOf('export * from "node:fs";')).toContain("node:fs");
  // Type-only imports are erased and must NOT count: they never reach a bundle.
  expect(importsOf('import type { X } from "node:fs";')).not.toContain("node:fs");
});

test("the browser entry's import graph contains no node: builtins", () => {
  const specifiers = [...transitiveBareSpecifiers(resolve(import.meta.dir, "browser.ts"))];
  const nodeBuiltins = specifiers.filter((s) => s.startsWith("node:"));
  expect(nodeBuiltins).toEqual([]);
});

test("the node entry's import graph DOES pull in node:fs (the walker discriminates)", () => {
  // Guards the test above from silently becoming a tautology: the default Node
  // entry legitimately reaches node:fs through the node-fs adapter, and the
  // browser entry must not. If this ever stops being true, the boundary moved.
  const specifiers = transitiveBareSpecifiers(resolve(import.meta.dir, "index.ts"));
  expect(specifiers.has("node:fs")).toBe(true);
});
