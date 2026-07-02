// scripts/node-smoke.mjs — the Node-runtime smoke test behind CI's node-smoke
// job. The gate runs on Bun; this is the minimum proof that the BUILT package
// actually works on the Node version package.json declares (engines >= 22):
// open a file-backed database, write through each lens, hit the exclusive
// lock, reopen, and read everything back. Run with `node scripts/node-smoke.mjs`
// after `bun run build`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { open, kv, doc, table, LibreDbError } = await import("../dist/index.js");

const dir = mkdtempSync(join(tmpdir(), "libredb-node-smoke-"));
const path = join(dir, "smoke.libredb");

try {
  // Open, write through every lens, and exercise the double-open lock.
  const db = open({ path });
  kv(db).set("greeting", "hello from node");
  doc(db, "notes").put("n1", { text: "smoke" });
  table(db, "people", { primaryKey: "id", columns: { id: "string", name: "string" } }).insert({
    id: "p1",
    name: "Ada",
  });

  let locked;
  try {
    open({ path });
  } catch (error) {
    locked = error;
  }
  assert.ok(locked instanceof LibreDbError && locked.code === "LOCKED", "second open must throw LOCKED");
  db.close();

  // Reopen: everything written above must have survived through the WAL.
  const reopened = open({ path });
  assert.equal(kv(reopened).get("greeting"), "hello from node");
  assert.deepEqual(doc(reopened, "notes").get("n1"), { text: "smoke" });
  assert.deepEqual(table(reopened, "people", {
    primaryKey: "id",
    columns: { id: "string", name: "string" },
  }).get("p1"), { id: "p1", name: "Ada" });
  reopened.close();

  // One pass of the CLI entry under Node, against the same database.
  const out = execFileSync(process.execPath, ["dist/cli/main.js", "get", path, "greeting"], {
    encoding: "utf8",
  });
  assert.equal(out.trim(), "hello from node");

  console.log("node smoke: ok (open, lenses, lock, reopen, and the CLI all behaved under Node)");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
