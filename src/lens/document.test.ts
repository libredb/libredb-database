import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { open } from "../core.ts";
import { doc, encodeDoc, decodeDoc, type Doc, type DocEntry } from "./document.ts";

describe("document codec", () => {
  test("round-trips a flat object", () => {
    const doc: Doc = { name: "Ada", active: true, age: 36 };
    expect(decodeDoc(encodeDoc(doc))).toEqual(doc);
  });

  test("round-trips nested objects", () => {
    const doc: Doc = {
      name: "Ada",
      address: { city: "London", geo: { lat: 51.5, lng: -0.12 } },
    };
    expect(decodeDoc(encodeDoc(doc))).toEqual(doc);
  });

  test("round-trips arrays, including arrays of objects", () => {
    const doc: Doc = {
      tags: ["a", "b", "c"],
      scores: [1, 2, 3],
      items: [{ id: 1 }, { id: 2 }],
    };
    expect(decodeDoc(encodeDoc(doc))).toEqual(doc);
  });

  test("round-trips numbers without coercion (number stays number)", () => {
    const doc: Doc = { int: 42, float: 3.14159, negative: -7, zero: 0 };
    const back = decodeDoc(encodeDoc(doc));
    expect(back).toEqual(doc);
    // Type fidelity matters for find()'s structural equality later: a number
    // must not come back as a string.
    expect(typeof back["int"]).toBe("number");
    expect(back["int"]).not.toBe("42");
  });

  test("round-trips unicode strings byte-for-byte", () => {
    const doc: Doc = { greeting: "merhaba", emoji: "x", astral: "\u{1F600}" };
    expect(decodeDoc(encodeDoc(doc))).toEqual(doc);
  });

  test("round-trips null, booleans, and the empty object", () => {
    expect(decodeDoc(encodeDoc({}))).toEqual({});
    const doc: Doc = { missing: null, yes: true, no: false };
    expect(decodeDoc(encodeDoc(doc))).toEqual(doc);
  });

  test("encodeDoc produces UTF-8 JSON bytes", () => {
    const bytes = encodeDoc({ a: 1 });
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(bytes)).toBe('{"a":1}');
  });

  test("decodeDoc reads UTF-8 JSON bytes from any source", () => {
    const bytes = new TextEncoder().encode('{"hello":"world"}');
    expect(decodeDoc(bytes)).toEqual({ hello: "world" });
  });
});

describe("DocEntry", () => {
  test("pairs an id with its document (compile-time contract)", () => {
    const entry: DocEntry = { id: "u1", doc: { name: "Ada" } };
    expect(entry.id).toBe("u1");
    expect(entry.doc["name"]).toBe("Ada");
  });
});

describe("doc collection — by-id CRUD", () => {
  /** Temp directories created during the run, cleaned up after each test. */
  const dirs: string[] = [];
  const tempPath = (name: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "libredb-doc-"));
    dirs.push(dir);
    return join(dir, name);
  };

  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });

  test("put then get returns the stored document", () => {
    const db = open();
    const users = doc(db, "users");
    users.put("u1", { name: "Ada", age: 36 });
    expect(users.get("u1")).toEqual({ name: "Ada", age: 36 });
    db.close();
  });

  test("get returns undefined for an id that was never put", () => {
    const db = open();
    const users = doc(db, "users");
    expect(users.get("missing")).toBeUndefined();
    db.close();
  });

  test("put reports one changed entry, even when overwriting, and replaces the doc", () => {
    const db = open();
    const users = doc(db, "users");
    expect(users.put("u1", { name: "Ada" })).toEqual({ changed: 1 });
    expect(users.put("u1", { name: "Grace" })).toEqual({ changed: 1 });
    expect(users.get("u1")).toEqual({ name: "Grace" });
    db.close();
  });

  test("delete of an existing id removes it and reports one change", () => {
    const db = open();
    const users = doc(db, "users");
    users.put("u1", { name: "Ada" });
    expect(users.delete("u1")).toEqual({ changed: 1 });
    expect(users.get("u1")).toBeUndefined();
    db.close();
  });

  test("delete of an absent id is a no-op and reports zero changes", () => {
    const db = open();
    const users = doc(db, "users");
    expect(users.delete("never-put")).toEqual({ changed: 0 });
    db.close();
  });

  test("documents preserve JSON type fidelity through a put/get round-trip", () => {
    const db = open();
    const records = doc(db, "records");
    const original: Doc = {
      int: 42,
      nested: { city: "London", geo: { lat: 51.5 } },
      tags: ["a", "b"],
      active: true,
      missing: null,
    };
    records.put("r1", original);
    const back = records.get("r1");
    expect(back).toEqual(original);
    // A number must not come back as a string (find()'s structural equality
    // depends on this in D4).
    expect(typeof back?.["int"]).toBe("number");
    db.close();
  });

  test("collections sharing an id do not collide (point-level isolation)", () => {
    const db = open();
    const users = doc(db, "users");
    const posts = doc(db, "posts");
    users.put("1", { name: "Ada" });
    posts.put("1", { title: "On Computing" });
    // Same id, different collections -> independent documents.
    expect(users.get("1")).toEqual({ name: "Ada" });
    expect(posts.get("1")).toEqual({ title: "On Computing" });
    // Deleting from one collection leaves the other intact.
    users.delete("1");
    expect(users.get("1")).toBeUndefined();
    expect(posts.get("1")).toEqual({ title: "On Computing" });
    db.close();
  });

  test("a put through the lens is durable and survives a reopen", () => {
    const path = tempPath("doc-durable");
    const first = open({ path });
    doc(first, "users").put("u1", { name: "Ada", active: true });
    first.close();

    const second = open({ path });
    expect(doc(second, "users").get("u1")).toEqual({
      name: "Ada",
      active: true,
    });
    second.close();
  });
});

describe("doc collection — all() scan", () => {
  test("returns every document in the collection, in ascending id order", () => {
    const db = open();
    const users = doc(db, "users");
    // Insert out of order; byte order on the ids is u1 < u10 < u2.
    users.put("u2", { name: "Grace" });
    users.put("u1", { name: "Ada" });
    users.put("u10", { name: "Linus" });
    expect(users.all().toArray()).toEqual([
      { id: "u1", doc: { name: "Ada" } },
      { id: "u10", doc: { name: "Linus" } },
      { id: "u2", doc: { name: "Grace" } },
    ]);
    db.close();
  });

  test("returns an empty result for a collection with no documents", () => {
    const db = open();
    expect(doc(db, "empty").all().toArray()).toEqual([]);
    db.close();
  });

  test("strips the collection prefix to recover the id, and decodes the doc with fidelity", () => {
    const db = open();
    const records = doc(db, "records");
    records.put("r1", {
      int: 42,
      nested: { city: "London" },
      tags: ["a", "b"],
    });
    const [only] = records.all().toArray();
    expect(only?.id).toBe("r1");
    expect(only?.doc).toEqual({
      int: 42,
      nested: { city: "London" },
      tags: ["a", "b"],
    });
    // Type fidelity carried through the scan, not just point get.
    expect(typeof only?.doc["int"]).toBe("number");
    db.close();
  });

  // MANDATORY: collection isolation. A scan of one
  // collection must never see another's documents, even when one collection
  // name is a byte-prefix of the other ("users" vs "users2"). The `:` separator
  // is the boundary token and must hold on raw bytes, not UTF-16.
  test("a collection scan does not see another collection's documents", () => {
    const db = open();
    const users = doc(db, "users");
    const users2 = doc(db, "users2");
    users.put("u1", { name: "Ada" });
    users.put("u2", { name: "Grace" });
    users2.put("x1", { name: "Other" });

    expect(users.all().toArray()).toEqual([
      { id: "u1", doc: { name: "Ada" } },
      { id: "u2", doc: { name: "Grace" } },
    ]);
    // The reverse direction too: users2 sees only its own document, none of users'.
    expect(users2.all().toArray()).toEqual([{ id: "x1", doc: { name: "Other" } }]);
    db.close();
  });

  test("the result is lazy and re-iterable: a second pass observes later writes", () => {
    const db = open();
    const users = doc(db, "users");
    users.put("u1", { name: "Ada" });
    const all = users.all();
    expect(all.toArray()).toHaveLength(1);
    // The same Result, iterated again after a write, re-runs the scan.
    users.put("u2", { name: "Grace" });
    expect(all.toArray()).toHaveLength(2);
    db.close();
  });
});

describe("doc collection — find() equality filter", () => {
  /** Seed three users with overlapping field values for the filter cases. */
  const seed = (): ReturnType<typeof doc> => {
    const db = open();
    const users = doc(db, "users");
    users.put("u1", { name: "Ada", age: 36, active: true });
    users.put("u2", { name: "Grace", age: 36, active: false });
    users.put("u3", { name: "Linus", age: 21, active: true });
    return users;
  };

  test("a single field equality matches every document with that value", () => {
    const users = seed();
    expect(users.find({ age: 36 }).toArray()).toEqual([
      { id: "u1", doc: { name: "Ada", age: 36, active: true } },
      { id: "u2", doc: { name: "Grace", age: 36, active: false } },
    ]);
  });

  test("multiple fields are an implicit AND", () => {
    const users = seed();
    // age 36 matches u1 and u2; adding active:true narrows to u1 alone.
    expect(users.find({ age: 36, active: true }).toArray()).toEqual([
      { id: "u1", doc: { name: "Ada", age: 36, active: true } },
    ]);
  });

  test("an empty predicate matches every document (identity filter)", () => {
    const users = seed();
    expect(users.find({}).toArray()).toEqual(users.all().toArray());
  });

  test("returns an empty result when nothing matches", () => {
    const users = seed();
    expect(users.find({ name: "Nobody" }).toArray()).toEqual([]);
  });

  test('equality is type-sensitive: 1 is not "1", true is not "true"', () => {
    const db = open();
    const items = doc(db, "items");
    items.put("a", { qty: 1, ok: true });
    // A string predicate must not match a number/boolean field (no coercion).
    expect(items.find({ qty: "1" }).toArray()).toEqual([]);
    expect(items.find({ ok: "true" }).toArray()).toEqual([]);
    // The correctly-typed predicate matches.
    expect(items.find({ qty: 1 }).toArray()).toEqual([{ id: "a", doc: { qty: 1, ok: true } }]);
    db.close();
  });

  test("a field whose value is a nested object matches by deep structural equality", () => {
    const db = open();
    const people = doc(db, "people");
    people.put("p1", {
      name: "Ada",
      address: { city: "London", geo: { lat: 51.5, lng: -0.12 } },
    });
    people.put("p2", { name: "Grace", address: { city: "Baltimore" } });

    // Whole-value deep equality on the nested object (key order is irrelevant).
    expect(people.find({ address: { geo: { lng: -0.12, lat: 51.5 }, city: "London" } }).toArray()).toEqual([
      {
        id: "p1",
        doc: {
          name: "Ada",
          address: { city: "London", geo: { lat: 51.5, lng: -0.12 } },
        },
      },
    ]);
    // A nested object that is only a partial match (missing geo) does not match:
    // the field is compared as a whole value, not recursively as its own predicate.
    expect(people.find({ address: { city: "London" } }).toArray()).toEqual([]);
    db.close();
  });

  test("a field whose value is an array matches element-wise and in order", () => {
    const db = open();
    const posts = doc(db, "posts");
    posts.put("p1", { title: "A", tags: ["x", "y"] });
    posts.put("p2", { title: "B", tags: ["y", "x"] });
    posts.put("p3", { title: "C", tags: ["x"] });

    // Same elements in the same order match; a different order is a different
    // value (order is part of an array's identity), and a different length too.
    expect(posts.find({ tags: ["x", "y"] }).toArray()).toEqual([{ id: "p1", doc: { title: "A", tags: ["x", "y"] } }]);
    expect(posts.find({ tags: ["x"] }).toArray()).toEqual([{ id: "p3", doc: { title: "C", tags: ["x"] } }]);
    // An array predicate must not match a non-array field of the same "shape".
    posts.put("p4", { title: "D", tags: "x" });
    expect(posts.find({ tags: ["x"] }).toArray()).toEqual([{ id: "p3", doc: { title: "C", tags: ["x"] } }]);
    db.close();
  });

  test("a missing field never matches a predicate that requires it", () => {
    const db = open();
    const users = doc(db, "users");
    users.put("u1", { name: "Ada" });
    expect(users.find({ age: 36 }).toArray()).toEqual([]);
    db.close();
  });

  test("find respects collection isolation (does not match a sibling collection)", () => {
    const db = open();
    doc(db, "users").put("u1", { role: "admin" });
    doc(db, "users2").put("x1", { role: "admin" });
    expect(doc(db, "users").find({ role: "admin" }).toArray()).toEqual([{ id: "u1", doc: { role: "admin" } }]);
    db.close();
  });

  test("the find result is lazy and re-iterable: a second pass observes later writes", () => {
    const db = open();
    const users = doc(db, "users");
    users.put("u1", { name: "Ada", active: true });
    const active = users.find({ active: true });
    expect(active.toArray()).toHaveLength(1);
    users.put("u2", { name: "Grace", active: true });
    expect(active.toArray()).toHaveLength(2);
    db.close();
  });
});
