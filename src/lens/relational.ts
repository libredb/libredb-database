/**
 * lens/relational.ts — the relational lens, LibreDB's reach lens.
 *
 * This is a deliberately minimal *relational view*, NOT a SQL engine (DESIGN.md
 * section 6.2): there is no SQL text, lexer, or planner. A table is a typed,
 * schema-validated collection of rows stored as JSON objects under a
 * `<table>:<pk>` kernel key — the exact storage scheme the document lens uses,
 * reusing its JSON codec. The relational value the lens adds over the document
 * lens is the *schema*: declared columns with declared types, enforced at insert.
 *
 * Schema validation lives here; row STORAGE is delegated to the document lens.
 * Because a validated row is just a JSON object stored at `<table>:<pk>` — the
 * exact key the document lens uses for `<collection>:<id>` — a table is literally
 * a schema-validated document collection. The relational lens holds a
 * {@link doc} handle for the same name and reads/writes rows through it, so it
 * inherits the document lens's codec and its collection-isolation-safe prefix
 * scan for free (a sibling like `users2` never leaks into `users`).
 *
 * On top of the schema/row vocabulary, the {@link table} handle, insert-time
 * validation, and by-pk CRUD (`get`/`delete`/`all`), this lens adds a small
 * chainable query surface: `where` (top-level field-equality filter, reusing the
 * document lens's matcher), `select` (column projection), and `join` (inner
 * equi-join via nested loop, producing rows with columns qualified as
 * `table.column`). The kernel is unchanged.
 */
import { doc, matches, type Doc } from "./document.ts";
import { assertUserName, recordRelational } from "./catalog.ts";
import { result, type Result, type WriteResult } from "./types.ts";
import type { Store } from "../adapter/store.ts";

/**
 * A column's declared type. These are the JSON shapes a relational column can
 * hold (DESIGN.md section 6.2): the three scalars plus a nested object. Arrays
 * and `null` are deliberately not column types in v1 — `"object"` means a plain
 * JSON object, and nullable/optional columns are an honest deferral.
 */
export type ColumnType = "string" | "number" | "boolean" | "object";

/**
 * A table schema: the primary-key column name and the declared columns with
 * their types. `primaryKey` must name a declared column whose type is `"string"`
 * (it becomes the kernel key `<table>:<pk>`), checked when the {@link table}
 * handle is built.
 */
export interface TableSchema {
  readonly primaryKey: string;
  readonly columns: { readonly [name: string]: ColumnType };
}

/**
 * A table row: a JSON object whose fields are the schema's columns. The value
 * type mirrors {@link ColumnType} (string/number/boolean/object). A row is
 * validated against the schema on insert before it is stored.
 */
export type Row = { [column: string]: string | number | boolean | object };

/** Whether `value` matches the declared `type`. `"object"` is a plain JSON
 * object — `null` (typeof `"object"`) and arrays are rejected, since v1 has
 * neither nullable columns nor an array column type. */
function matchesType(value: string | number | boolean | object, type: ColumnType): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "object":
      // typeof null === "object" at runtime, so this null guard is real
      // defensive validation even though the static Row type excludes null:
      // a JS caller (no TypeScript) can still pass null into a column.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

/**
 * Validate `row` against `schema`, throwing on the first violation (DESIGN.md
 * section 6.2: declared columns required, types checked, unknown fields
 * rejected). Strict by design — there is no silent coercion or dropping.
 */
function validateRow(schema: TableSchema, row: Row): void {
  // Unknown fields: every row key must be a declared column.
  for (const key of Object.keys(row)) {
    if (!Object.prototype.hasOwnProperty.call(schema.columns, key)) {
      throw new Error(`unknown column "${key}" (not declared in the table schema)`);
    }
  }
  // Declared columns: each must be present and match its declared type. A
  // missing or null value fails here (no nullable/optional columns in v1).
  for (const [name, type] of Object.entries(schema.columns)) {
    if (!Object.prototype.hasOwnProperty.call(row, name)) {
      throw new Error(`missing required column "${name}"`);
    }
    if (!matchesType(row[name] as string | number | boolean | object, type)) {
      throw new Error(`column "${name}" expected ${type}, got ${typeof row[name]}`);
    }
  }
}

/**
 * A lazy, chainable query over a table's rows.
 *
 * A Query IS a {@link Result} (it is iterable and has `toArray`), so it can be
 * consumed directly; it additionally offers `where` and `select`, each returning
 * a new Query so operations compose (`table.where(...).select(...)`). Like every
 * lens read it stays lazy and re-iterable: nothing runs until iterated, and each
 * pass re-runs the underlying table scan against current state.
 */
export interface Query extends Result<Row> {
  /** Keep only the rows whose top-level fields all equal `predicate`'s (deep
   * structural equality, type-sensitive — the same matcher the document lens
   * uses). Multiple predicate fields are an implicit AND; an empty predicate
   * keeps every row. Chained `where`s narrow further (also an AND). */
  where(predicate: Row): Query;
  /** Project each row down to only the named `columns`. A requested column that
   * a row does not have is simply omitted from that row's projection. On a joined
   * result the columns are the qualified `table.column` names, which `select`
   * matches literally — so projecting `"users.id"` works the same as any column. */
  select(...columns: string[]): Query;
  /**
   * Inner equi-join this query's rows against `other`'s on `this[leftField]`
   * deeply equal to `other[rightField]`, returning a chainable {@link Query} of
   * the matched, combined rows. Each result row carries every column of both
   * sides, qualified as `table.column` (e.g. `users.id`, `orders.total`), so the
   * two sides never collide and `select`/`where` can name a column unambiguously.
   *
   * Inner means unmatched rows on either side are dropped; one left key matching
   * several right rows fans out to several result rows (and vice versa). Joining
   * on a key that a row lacks never matches that row (a missing key is not a join
   * value), so it cannot produce a cross product by accident.
   *
   * Cost: O(n*m) — a nested loop over this query's `n` rows and `other`'s `m`
   * rows, the honest minimal join with no indexes (DESIGN.md section 6.2).
   */
  join(other: Table, leftField: string, rightField: string): Query;
}

/** Whether `row` matches `predicate` by the document lens's field-equality
 * matcher. The casts are the same Row/Doc type-system artifact `table` uses
 * elsewhere (their value unions overlap but neither is a subtype of the other);
 * the runtime values are plain JSON. */
function rowMatches(row: Row, predicate: Row): boolean {
  return matches(row as unknown as Doc, predicate as unknown as Doc);
}

/** A row containing only `columns` that are actually present on `row`. A row's
 * values are always defined (it comes from JSON, which has no `undefined`), so an
 * absent column reads as `undefined` and is omitted from the projection. */
function project(row: Row, columns: readonly string[]): Row {
  const out: Row = {};
  for (const column of columns) {
    const value = row[column];
    if (value !== undefined) {
      out[column] = value;
    }
  }
  return out;
}

/** Whether a left row joins to a right row: `left[leftField]` deeply equals
 * `right[rightField]`. A join match is literally "the left row matches a
 * predicate built from the right row's join value", so it reuses the document
 * lens's `matches` for the exact same deep, type-sensitive equality `where` uses.
 * A field a row lacks reads as `undefined`, which is never a join value (a row
 * from JSON never holds `undefined`), so a missing key on either side never
 * matches — an inner join, not an accidental cross product. */
function joinKeyEqual(left: Row, leftField: string, right: Row, rightField: string): boolean {
  const rightValue = right[rightField];
  if (left[leftField] === undefined || rightValue === undefined) return false;
  return matches(left as unknown as Doc, { [leftField]: rightValue } as unknown as Doc);
}

/** Combine a matched left/right pair into one row whose columns are qualified by
 * their table name (`<table>.<column>`), so columns of the same name on the two
 * sides stay distinct and a later `select`/`where` can name either unambiguously. */
function qualify(leftName: string, left: Row, rightName: string, right: Row): Row {
  const out: Row = {};
  for (const [column, value] of Object.entries(left)) out[`${leftName}.${column}`] = value;
  for (const [column, value] of Object.entries(right)) out[`${rightName}.${column}`] = value;
  return out;
}

/** The inner equi-join itself: a nested loop pairing each left row with each
 * right row that shares the join key, emitting qualified rows in left-major order
 * (every match for the first left row, then the second, ...). O(n*m). */
function joinRows(
  leftName: string,
  leftRows: readonly Row[],
  other: Table,
  leftField: string,
  rightField: string,
): Row[] {
  const rightRows = other.all().toArray();
  const out: Row[] = [];
  for (const left of leftRows) {
    for (const right of rightRows) {
      if (joinKeyEqual(left, leftField, right, rightField)) {
        out.push(qualify(leftName, left, other.name, right));
      }
    }
  }
  return out;
}

/**
 * Wrap a lazy row source as a {@link Query}. `where`/`select`/`join` build new
 * Queries over the materialized rows of this one, so they re-run the source each
 * pass (laziness and re-iterability carry through the whole chain). All filtering,
 * projection, and joining happen in-engine over the rows — there are no indexes,
 * so a `where` is O(n) in the table size and a `join` is O(n*m), the same cost as
 * the underlying scans.
 *
 * `name` is the qualifier the rows belong to — the table name. It is carried so
 * a later `join` can prefix this side's columns as `<name>.<column>`; `where` and
 * `select` do not use it (they match/project by literal column name), so it rides
 * through them unchanged.
 */
function query(name: string, source: () => Iterable<Row>): Query {
  const base = result(source);
  return {
    [Symbol.iterator]() {
      return base[Symbol.iterator]();
    },
    toArray() {
      return base.toArray();
    },
    where(predicate) {
      return query(name, () => base.toArray().filter((row) => rowMatches(row, predicate)));
    },
    select(...columns) {
      return query(name, () => base.toArray().map((row) => project(row, columns)));
    },
    join(other, leftField, rightField) {
      return query(name, () => joinRows(name, base.toArray(), other, leftField, rightField));
    },
  };
}

/**
 * A handle on one typed table over a {@link Store}.
 *
 * Like the other lenses, the handle is a view: it depends only on the `Store`
 * seam and never touches lifecycle. `insert` auto-commits in its own kernel
 * transaction (a file-backed write is fsync'd before it returns). Read-side
 * operations are added in later phases.
 */
export interface Table {
  /** This table's name — the qualifier its columns take in a join
   * (`<name>.<column>`). A join reads it off the right-hand table. */
  readonly name: string;
  /**
   * Validate `row` against the schema and store it under `<table>:<pk>`,
   * overwriting any existing row at that primary key. Throws if the row is
   * invalid (missing/wrong-typed column, or an unknown field). Reports one
   * changed entry.
   */
  insert(row: Row): WriteResult;
  /** The row stored under primary key `pk`, or `undefined` if none exists. The
   * returned row is the whole stored object, including the primary-key column. */
  get(pk: string): Row | undefined;
  /** Remove the row at primary key `pk`. Reports one changed entry if it
   * existed, zero if it did not. */
  delete(pk: string): WriteResult;
  /** Every row in the table, in ascending primary-key (byte) order, as a
   * chainable {@link Query}. Each row is the whole stored object (the primary key
   * is a declared column, so it is part of the row — there is no separate id).
   * The Query is lazy and re-iterable: each pass re-runs the scan against current
   * state. The scan sees only this table's rows — the `<table>:` byte prefix is a
   * sound boundary, so a sibling whose name shares a prefix (`users` vs `users2`)
   * is never included. */
  all(): Query;
  /** The rows matching `predicate` (top-level field equality). Sugar for
   * `all().where(predicate)`; returns a chainable {@link Query}. */
  where(predicate: Row): Query;
  /** Every row projected to only `columns`. Sugar for `all().select(...columns)`;
   * returns a chainable {@link Query}. */
  select(...columns: string[]): Query;
  /** Inner equi-join every row of this table against `other` on
   * `this[leftField]` equal to `other[rightField]`. Sugar for
   * `all().join(other, leftField, rightField)`; returns a chainable {@link Query}
   * of qualified `table.column` rows. */
  join(other: Table, leftField: string, rightField: string): Query;
}

/**
 * Build a {@link Table} handle for `name` with `schema` over a {@link Store}
 * (the kernel's `Database` satisfies it). The schema is validated immediately:
 * the `primaryKey` must name a declared column whose type is `"string"`, since
 * the primary key becomes the string kernel key.
 */
export function table(store: Store, name: string, schema: TableSchema): Table {
  // A table name may not intrude on the reserved catalog namespace (DESIGN.md
  // section 6.3) — reject it before validating the schema or deriving any key.
  assertUserName(name);

  const pkType = schema.columns[schema.primaryKey];
  if (pkType === undefined) {
    throw new Error(`primaryKey "${schema.primaryKey}" is not a declared column`);
  }
  if (pkType !== "string") {
    throw new Error(`primaryKey "${schema.primaryKey}" must be a string column, but is ${pkType}`);
  }

  // Record this table's schema in the catalog (DESIGN.md section 6.3) so a tool
  // opening the file cold can show a faithful relational view, or — if the name
  // is already cataloged — validate the schema matches the persisted one (no
  // migration in v1). Runs after the schema is structurally valid, so a broken
  // schema never reaches the catalog. The kernel stays unchanged: this is just a
  // KV write under the reserved prefix.
  recordRelational(store, name, schema);

  // A table is a schema-validated document collection: rows are stored, read,
  // deleted, and scanned through the document lens at `<table>:<pk>`. This is
  // what reuses the document codec and the collection-isolation-safe prefix scan;
  // a row is a Doc whose fields happen to be the declared columns. The Row/Doc
  // casts are type-system artifacts (their value unions overlap but neither is a
  // subtype of the other); validation guarantees what crosses the boundary.
  const rows = doc(store, name);

  // Every read starts from the full table scan re-wrapped as a chainable Query:
  // drop the document lens's DocEntry id wrapper (the pk lives in the row), then
  // let where/select compose over it. Each call rebuilds the Query so laziness
  // and re-iterability carry through from the document scan.
  const allRows = (): Query =>
    query(name, () =>
      rows
        .all()
        .toArray()
        .map((entry) => entry.doc as unknown as Row),
    );

  return {
    name,
    insert(row) {
      validateRow(schema, row);
      // The primary-key column is validated as a string above and required, so
      // this read is a checked string, safe as the document id.
      const pk = row[schema.primaryKey] as string;
      return rows.put(pk, row as unknown as Doc);
    },
    get(pk) {
      return rows.get(pk) as Row | undefined;
    },
    delete(pk) {
      return rows.delete(pk);
    },
    all() {
      return allRows();
    },
    where(predicate) {
      return allRows().where(predicate);
    },
    select(...columns) {
      return allRows().select(...columns);
    },
    join(other, leftField, rightField) {
      return allRows().join(other, leftField, rightField);
    },
  };
}
