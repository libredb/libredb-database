// Single source of truth for the version is package.json. This rewrites the
// exported `version` constant in src/core.ts to match, so `changeset version`
// (which only touches package.json + CHANGELOG) cannot leave the public API
// reporting a stale version. The "version matches package.json" test in
// core.test.ts is the backstop if this ever fails to run.
//
// Kept OUT of src/core.ts (no runtime package.json read in the guarded core)
// and out of the gate; it runs only in the release flow (changeset:version).
import { readFileSync, writeFileSync } from "node:fs";
import pkg from "../package.json" with { type: "json" };

const corePath = new URL("../src/core.ts", import.meta.url);
const pattern = /export const version = "[^"]*";/;
const before = readFileSync(corePath, "utf8");

if (!pattern.test(before)) {
  throw new Error("sync-version: version export not found in src/core.ts");
}

const after = before.replace(pattern, `export const version = "${pkg.version}";`);
writeFileSync(corePath, after);
console.log(`sync-version: src/core.ts version -> ${pkg.version}`);
