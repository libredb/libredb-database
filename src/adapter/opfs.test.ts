/**
 * opfs.test.ts — the OPFS filesystem adapter for the browser.
 *
 * OPFS sync access handles expose synchronous read/write/getSize/truncate/flush/
 * close, which map exactly onto the kernel's synchronous FileSystem seam — so a
 * LibreDB database can be durable in a browser (inside a Worker, where sync
 * handles live) with no async core. The handle is injected, so these tests drive
 * the adapter against an in-memory fake that mimics a FileSystemSyncAccessHandle,
 * proving the mapping and full crash/reopen durability without a real browser.
 */
import { expect, test } from "bun:test";

import { open } from "../core.ts";
import { opfsFileSystem, type SyncAccessHandle } from "./opfs.ts";

/** Backing bytes shared across handles opened on the "same file", so a reopen
 * sees what a prior handle committed (close does not erase). */
const makeBacking = (): { bytes: Uint8Array } => ({ bytes: new Uint8Array(0) });

/** An in-memory stand-in for a FileSystemSyncAccessHandle over `backing`. */
const fakeHandle = (backing: { bytes: Uint8Array }): SyncAccessHandle => ({
  getSize() {
    return backing.bytes.length;
  },
  read(buffer, options) {
    const at = options?.at ?? 0;
    const slice = backing.bytes.subarray(at, at + buffer.length);
    buffer.set(slice);
    return slice.length;
  },
  write(buffer, options) {
    const at = options?.at ?? 0;
    if (at + buffer.length > backing.bytes.length) {
      const grown = new Uint8Array(at + buffer.length);
      grown.set(backing.bytes);
      backing.bytes = grown;
    }
    backing.bytes.set(buffer, at);
    return buffer.length;
  },
  truncate(newSize) {
    backing.bytes = backing.bytes.slice(0, newSize);
  },
  flush() {
    // no durability model in the fake; the kernel calls this as its commit point
  },
  close() {
    // a handle close does not erase the backing bytes
  },
});

const bytes = (...b: number[]): Uint8Array => new Uint8Array(b);

test("a database runs durably on an OPFS sync access handle", () => {
  const backing = makeBacking();
  const db = open({ path: "db", fs: opfsFileSystem(fakeHandle(backing)) });
  db.transact((tx) => tx.set(bytes(1), bytes(10)));
  db.close();

  // The commit landed in the handle's backing store.
  expect(backing.bytes.length).toBeGreaterThan(0);
});

test("committed state recovers when a fresh handle reopens the same backing", () => {
  const backing = makeBacking();
  const first = open({ path: "db", fs: opfsFileSystem(fakeHandle(backing)) });
  first.transact((tx) => {
    tx.set(bytes(1), bytes(10));
    tx.set(bytes(2), bytes(20));
  });
  first.close();

  // A new handle over the same backing is the browser "reopen" path.
  const second = open({ path: "db", fs: opfsFileSystem(fakeHandle(backing)) });
  expect(second.transact((tx) => tx.get(bytes(2)))).toEqual(bytes(20));
  expect(second.transact((tx) => tx.get(bytes(1)))).toEqual(bytes(10));
  second.close();
});

test("recovery truncates a torn tail through the handle", () => {
  const backing = makeBacking();
  const first = open({ path: "db", fs: opfsFileSystem(fakeHandle(backing)) });
  first.transact((tx) => tx.set(bytes(1), bytes(10)));
  first.close();
  const committedSize = backing.bytes.length;

  // Simulate a crash mid-append: tack a partial record onto the backing bytes.
  const torn = new Uint8Array(committedSize + 5);
  torn.set(backing.bytes);
  torn.set([0xff, 0xff, 0xff, 0xff, 1], committedSize);
  backing.bytes = torn;

  // Reopen: recovery drops the torn tail via handle.truncate, restoring the size.
  const second = open({ path: "db", fs: opfsFileSystem(fakeHandle(backing)) });
  expect(second.transact((tx) => tx.get(bytes(1)))).toEqual(bytes(10));
  expect(backing.bytes.length).toBe(committedSize);
  second.close();
});
