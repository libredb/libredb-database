/**
 * index.test.ts — the default (Node) package entry.
 *
 * The kernel (core.ts) is runtime-agnostic and carries no default filesystem.
 * The Node entry is where the convenience lives: `open({ path })` with no `fs`
 * defaults to the real `node:fs` adapter, so the long-standing ergonomic — open
 * a file by path and get durability — is preserved. A pathless open stays
 * in-memory, and an explicitly injected `fs` is passed straight through.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "bun:test";

import { open } from "./index.ts";

const dirs: string[] = [];
const tempPath = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "libredb-index-"));
  dirs.push(dir);
  return join(dir, name);
};

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const bytes = (...b: number[]): Uint8Array => new Uint8Array(b);

test("open({ path }) with no fs defaults to node:fs and persists durably", () => {
  const path = tempPath("db");
  const first = open({ path });
  first.transact((tx) => tx.set(bytes(1), bytes(42)));
  first.close();

  // Reopening reads the real file back through the default node:fs adapter.
  const second = open({ path });
  expect(second.transact((tx) => tx.get(bytes(1)))).toEqual(bytes(42));
  second.close();
});

test("open() with no path stays in-memory", () => {
  const db = open();
  db.transact((tx) => tx.set(bytes(1), bytes(7)));
  expect(db.transact((tx) => tx.get(bytes(1)))).toEqual(bytes(7));
  db.close();
});

test("open({ path: '' }) throws the clean libredb error, not a raw node failure", () => {
  // The empty path is rejected by the kernel before the node:fs default is ever
  // exercised, so a public Node consumer sees the libredb message, not ENOENT.
  expect(() => open({ path: "" })).toThrow(/non-empty path/i);
});

test("open({ path, fs }) passes the injected filesystem straight through", () => {
  // An exploding filesystem proves the injected fs is used (not the node
  // default): if the wrapper ignored it and fell back to node:fs, this would
  // silently write to a real file instead of throwing.
  const boom = new Error("injected filesystem was used");
  expect(() =>
    open({
      path: "db",
      fs: {
        open() {
          throw boom;
        },
      },
    }),
  ).toThrow(boom);
});
