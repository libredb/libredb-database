#!/usr/bin/env node
/**
 * cli/main.ts — the `libredb` bin shim.
 *
 * The only file that touches the real process: it wires process argv/stdout/
 * stderr/exit code to the pure {@link run}. All behaviour lives in run.ts and is
 * tested there; this glue is excluded from coverage (see bunfig.toml) because it
 * cannot be exercised without spawning a process, and a behavioural smoke test
 * (main.test.ts) runs the bin end-to-end instead.
 */
import { run } from "./run.ts";

process.exitCode = run(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
