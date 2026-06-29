// Single source of truth for the version is package.json. This propagates it to
// the places that must agree: the exported `version` constant in src/core.ts (so
// `changeset version`, which only touches package.json + CHANGELOG, cannot leave
// the public API reporting a stale version), the `version` field in jsr.json (the
// JSR manifest, which carries its own version), and the pinned esm.sh example in
// README.md (so the CDN snippet never drifts behind a release). The "version
// matches package.json" tests in core.test.ts are the backstop if this ever
// fails to run.
//
// Kept OUT of src/core.ts (no runtime package.json read in the guarded core)
// and out of the gate; it runs only in the release flow (changeset:version).
import { readFileSync, writeFileSync } from "node:fs";
import pkg from "../package.json" with { type: "json" };

const corePath = new URL("../src/core.ts", import.meta.url);
const corePattern = /export const version = "[^"]*";/;
const coreBefore = readFileSync(corePath, "utf8");

if (!corePattern.test(coreBefore)) {
  throw new Error("sync-version: version export not found in src/core.ts");
}

writeFileSync(corePath, coreBefore.replace(corePattern, `export const version = "${pkg.version}";`));
console.log(`sync-version: src/core.ts version -> ${pkg.version}`);

const jsrPath = new URL("../jsr.json", import.meta.url);
const jsrPattern = /"version": "[^"]*"/;
const jsrBefore = readFileSync(jsrPath, "utf8");

if (!jsrPattern.test(jsrBefore)) {
  throw new Error("sync-version: version field not found in jsr.json");
}

writeFileSync(jsrPath, jsrBefore.replace(jsrPattern, `"version": "${pkg.version}"`));
console.log(`sync-version: jsr.json version -> ${pkg.version}`);

const readmePath = new URL("../README.md", import.meta.url);
const readmePattern = /esm\.sh\/@libredb\/libredb@[\w.-]+/g;
const readmeBefore = readFileSync(readmePath, "utf8");

if (!readmeBefore.includes("esm.sh/@libredb/libredb@")) {
  throw new Error("sync-version: esm.sh pin not found in README.md");
}

writeFileSync(readmePath, readmeBefore.replace(readmePattern, `esm.sh/@libredb/libredb@${pkg.version}`));
console.log(`sync-version: README.md esm.sh pin -> ${pkg.version}`);
