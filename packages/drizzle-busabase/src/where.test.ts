import { type RecordPayload, UnsupportedWhereError } from "busabase-orm-core";
import {
  and,
  between,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  not,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { boolean, integer, pgTable, text } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { compileWhere } from "./where";

const people = pgTable("people", {
  name: text("name"),
  age: integer("age"),
  // A second numeric column, so a column-to-column comparison has two sides.
  score: integer("score"),
  active: boolean("active"),
});

const compile = (where: Parameters<typeof compileWhere>[0]) =>
  compileWhere(where, (column) => column.name);

const matches = (where: Parameters<typeof compileWhere>[0], payload: RecordPayload) =>
  compile(where).predicate(payload);

describe("predicate — comparison operators", () => {
  const row: RecordPayload = { name: "kelly", age: 30, active: true };

  it.each([
    ["eq hit", eq(people.name, "kelly"), true],
    ["eq miss", eq(people.name, "sam"), false],
    ["ne hit", ne(people.name, "sam"), true],
    ["gt hit", gt(people.age, 18), true],
    ["gt miss", gt(people.age, 30), false],
    ["gte boundary", gte(people.age, 30), true],
    ["lt miss", lt(people.age, 30), false],
    ["lte boundary", lte(people.age, 30), true],
    ["between inclusive", between(people.age, 30, 40), true],
    ["between outside", between(people.age, 31, 40), false],
    ["inArray hit", inArray(people.name, ["sam", "kelly"]), true],
    ["notInArray hit", notInArray(people.name, ["sam"]), true],
    ["isNotNull", isNotNull(people.name), true],
    ["isNull", isNull(people.name), false],
    ["like anchored", like(people.name, "kel%"), true],
    ["like anchored miss", like(people.name, "elly"), false],
    ["ilike case-insensitive", ilike(people.name, "%KEL%"), true],
    ["like underscore is single char", like(people.name, "kell_"), true],
    ["boolean eq", eq(people.active, true), true],
  ])("%s", (_label, where, expected) => {
    expect(matches(where, row)).toBe(expected);
  });

  it("treats a missing field as SQL NULL, not as a JS coercion", () => {
    // `undefined > 18` is false in JS by coercion; in SQL it is UNKNOWN, and an
    // UNKNOWN row must not appear in the result either way — but it must also
    // not appear for the negation, which JS coercion would wrongly admit.
    expect(matches(gt(people.age, 18), {})).toBe(false);
    expect(matches(lt(people.age, 18), {})).toBe(false);
    expect(matches(ne(people.name, "sam"), {})).toBe(false);
  });

  it("escapes regex metacharacters in a like pattern", () => {
    expect(matches(like(people.name, "a.c"), { name: "abc" })).toBe(false);
    expect(matches(like(people.name, "a.c"), { name: "a.c" })).toBe(true);
  });
});

describe("predicate — three-valued logic", () => {
  it("AND with UNKNOWN is not true", () => {
    expect(matches(and(eq(people.name, "kelly"), gt(people.age, 1)), { name: "kelly" })).toBe(
      false,
    );
  });

  it("OR short-circuits a true branch past an UNKNOWN one", () => {
    expect(matches(or(eq(people.name, "kelly"), gt(people.age, 1)), { name: "kelly" })).toBe(true);
  });

  it("NOT of UNKNOWN stays UNKNOWN", () => {
    expect(matches(not(eq(people.name, "kelly")), {})).toBe(false);
  });

  it("evaluates nested boolean trees", () => {
    const where = and(eq(people.active, true), or(gt(people.age, 40), isNull(people.name)));
    expect(matches(where, { active: true, age: 50, name: "kelly" })).toBe(true);
    expect(matches(where, { active: true, age: 20, name: null })).toBe(true);
    expect(matches(where, { active: true, age: 20, name: "kelly" })).toBe(false);
    expect(matches(where, { active: false, age: 50, name: "kelly" })).toBe(false);
  });
});

describe("pushdown", () => {
  it("pushes equality, contains and emptiness", () => {
    expect(compile(eq(people.name, "kelly")).pushdown).toEqual([
      { fieldSlug: "name", operator: "equals", value: "kelly" },
    ]);
    expect(compile(ilike(people.name, "%kel%")).pushdown).toEqual([
      { fieldSlug: "name", operator: "contains", value: "kel" },
    ]);
    expect(compile(isNull(people.name)).pushdown).toEqual([
      { fieldSlug: "name", operator: "is_empty" },
    ]);
    expect(compile(isNotNull(people.name)).pushdown).toEqual([
      { fieldSlug: "name", operator: "not_empty" },
    ]);
  });

  it("maps boolean equality onto is_true / is_false", () => {
    expect(compile(eq(people.active, true)).pushdown).toEqual([
      { fieldSlug: "active", operator: "is_true" },
    ]);
    expect(compile(eq(people.active, false)).pushdown).toEqual([
      { fieldSlug: "active", operator: "is_false" },
    ]);
  });

  it("collects every conjunct of an AND", () => {
    expect(compile(and(eq(people.name, "kelly"), isNotNull(people.age))).pushdown).toEqual([
      { fieldSlug: "name", operator: "equals", value: "kelly" },
      { fieldSlug: "age", operator: "not_empty" },
    ]);
  });

  it("refuses to push down anything from an OR", () => {
    // Pushing one branch would exclude rows the other branch matches.
    expect(compile(or(eq(people.name, "kelly"), eq(people.name, "sam"))).pushdown).toEqual([]);
  });

  it("refuses to push down a negation", () => {
    expect(compile(not(eq(people.name, "kelly"))).pushdown).toEqual([]);
    expect(compile(ne(people.name, "kelly")).pushdown).toEqual([]);
  });

  it("does not push down operators Busabase lacks", () => {
    for (const where of [
      gt(people.age, 18),
      lt(people.age, 18),
      between(people.age, 1, 9),
      inArray(people.name, ["a", "b"]),
    ]) {
      expect(compile(where).pushdown).toEqual([]);
    }
  });

  it("only pushes an anchored-free %pattern% as contains", () => {
    expect(compile(like(people.name, "kel%")).pushdown).toEqual([]);
    expect(compile(like(people.name, "%a_c%")).pushdown).toEqual([]);
  });
});

describe("pushdown is a superset of the predicate", () => {
  // The invariant the whole driver rests on: whatever the server returns for
  // `pushdown` must still contain every row the predicate accepts. If this ever
  // fails, the driver silently loses rows.
  const rows: RecordPayload[] = [
    { name: "kelly", age: 30, active: true },
    { name: "sam", age: 17, active: false },
    { name: "kelsey", age: 44, active: true },
    { name: null, age: null, active: null },
    { name: "", age: 0, active: false },
    {},
  ];

  const applyPushdown = (row: RecordPayload, filters: ReturnType<typeof compile>["pushdown"]) =>
    filters.every((filter) => {
      const value = row[filter.fieldSlug];
      const text = value === null || value === undefined ? "" : String(value);
      switch (filter.operator) {
        case "equals":
          return text === String(filter.value);
        case "contains":
          return text.includes(String(filter.value));
        case "is_empty":
          return text === "";
        case "not_empty":
          return text !== "";
        case "is_true":
          return value === true;
        case "is_false":
          return value === false;
        default:
          return true;
      }
    });

  it.each([
    ["eq", eq(people.name, "kelly")],
    ["ilike contains", ilike(people.name, "%kel%")],
    ["isNull", isNull(people.name)],
    ["isNotNull", isNotNull(people.name)],
    ["boolean", eq(people.active, true)],
    ["and", and(eq(people.active, true), gt(people.age, 18))],
    ["or", or(eq(people.name, "kelly"), gt(people.age, 40))],
    ["not", not(eq(people.name, "kelly"))],
    ["mixed", and(ilike(people.name, "%kel%"), or(gt(people.age, 40), isNull(people.active)))],
  ])("%s", (_label, where) => {
    const { pushdown, predicate } = compile(where);
    for (const row of rows) {
      if (predicate(row)) expect(applyPushdown(row, pushdown)).toBe(true);
    }
  });
});

describe("unsupported expressions are rejected, never ignored", () => {
  it("rejects a raw sql fragment", () => {
    expect(() => compile(sql`lower(${people.name}) = 'x'`)).toThrow(UnsupportedWhereError);
  });

  it("names the offending condition in the message", () => {
    expect(() => compile(sql`lower(${people.name}) = 'x'`)).toThrow(/not translatable/);
  });
});

describe("column-to-column comparisons", () => {
  // Previously refused. It is ordinary SQL, it is answerable from the record
  // payload the driver already holds, and refusing it only pushed the user into
  // fetching everything and filtering by hand — the same scan without the
  // three-valued semantics or the scan budget.
  it("compares two columns of the same record", () => {
    const compiled = compile(gt(people.age, people.score));
    expect(compiled.predicate({ age: 30, score: 10 })).toBe(true);
    expect(compiled.predicate({ age: 10, score: 30 })).toBe(false);
  });

  it("keeps SQL's UNKNOWN when either side is missing", () => {
    const compiled = compile(gt(people.age, people.score));
    expect(compiled.predicate({ age: 30 })).toBe(false);
    expect(compiled.predicate({ score: 30 })).toBe(false);
    expect(compiled.predicate({})).toBe(false);
  });

  it("handles equality and inequality between columns", () => {
    expect(compile(eq(people.age, people.score)).predicate({ age: 5, score: 5 })).toBe(true);
    expect(compile(ne(people.age, people.score)).predicate({ age: 5, score: 6 })).toBe(true);
  });

  it("stays out of the exact half — there is no wire form for it", () => {
    expect(compile(gt(people.age, people.score)).fullyExact).toBe(false);
  });
});

describe("value tree — the exact half", () => {
  // `valueFilters` on the server compares stored values in their typed column,
  // so a comparison that maps onto one needs no local narrowing at all. That is
  // what `fullyExact` reports, and it is what lets the caller push `limit` down.
  const leaf = (fieldSlug: string, operator: string, value: unknown) => ({
    kind: "leaf",
    fieldSlug,
    operator,
    value,
  });

  it("maps every ordering comparison onto a leaf", () => {
    expect(compile(gt(people.age, 18)).valueTree).toEqual(leaf("age", "gt", 18));
    expect(compile(lte(people.age, 18)).valueTree).toEqual(leaf("age", "lte", 18));
    expect(compile(ne(people.name, "kelly")).valueTree).toEqual(leaf("name", "ne", "kelly"));
    expect(compile(eq(people.age, 30)).valueTree).toEqual(leaf("age", "eq", 30));
  });

  it("splits between into the gte/lte pair the server ANDs back together", () => {
    expect(compile(between(people.age, 18, 65)).valueTree).toEqual({
      kind: "and",
      nodes: [leaf("age", "gte", 18), leaf("age", "lte", 65)],
    });
    expect(compile(between(people.age, 18, 65)).fullyExact).toBe(true);
  });

  it("collects an AND of comparisons and stays exact", () => {
    const compiled = compile(and(gt(people.age, 18), lt(people.age, 65)));
    expect(compiled.valueTree).toEqual({
      kind: "and",
      nodes: [leaf("age", "gt", 18), leaf("age", "lt", 65)],
    });
    expect(compiled.fullyExact).toBe(true);
  });

  // The four cases below used to be inexact and are now not. That is the point
  // of the CNF work rather than a relaxed assertion: each one previously forced
  // the driver to page an entire Base and decide locally.
  it("turns any-length IN into an OR of equalities", () => {
    // A one-element list stays an `or` of one here rather than collapsing to a
    // bare leaf: the tree mirrors the source clause, and flattening a
    // single-child group is the wire compiler's job, not the builder's.
    expect(compile(inArray(people.name, ["kelly"])).valueTree).toEqual({
      kind: "or",
      nodes: [leaf("name", "eq", "kelly")],
    });
    expect(compile(inArray(people.name, ["kelly", "sam"])).valueTree).toEqual({
      kind: "or",
      nodes: [leaf("name", "eq", "kelly"), leaf("name", "eq", "sam")],
    });
    expect(compile(inArray(people.name, ["kelly", "sam"])).fullyExact).toBe(true);
  });

  it("turns NOT IN into an AND of inequalities", () => {
    expect(compile(notInArray(people.name, ["kelly", "sam"])).valueTree).toEqual({
      kind: "and",
      nodes: [leaf("name", "ne", "kelly"), leaf("name", "ne", "sam")],
    });
  });

  it("keeps an OR exact, as a disjunction", () => {
    const compiled = compile(or(gt(people.age, 18), lt(people.age, 5)));
    expect(compiled.fullyExact).toBe(true);
    expect(compiled.valueTree).toEqual({
      kind: "or",
      nodes: [leaf("age", "gt", 18), leaf("age", "lt", 5)],
    });
  });

  it("rewrites NOT into its leaves instead of asking the server for one", () => {
    expect(compile(not(gt(people.age, 18))).valueTree).toEqual(leaf("age", "lte", 18));
    expect(compile(not(gt(people.age, 18))).fullyExact).toBe(true);
  });

  it.each([
    ["like", like(people.name, "kel%")],
    ["isNull", isNull(people.name)],
    ["isNotNull", isNotNull(people.name)],
  ])("is not fully exact with %s anywhere", (_label, where) => {
    expect(compile(where).fullyExact).toBe(false);
  });

  it("cannot rescue a NOT over an unexpressible condition", () => {
    expect(compile(not(like(people.name, "kel%"))).fullyExact).toBe(false);
  });

  it("loses exactness when one branch of an AND is inexact", () => {
    // The whole point: one condition the server cannot decide makes its answer
    // a superset again, and a superset cannot carry a limit. The expressible
    // half stays in the tree, because dropping a CONJUNCT only widens.
    const compiled = compile(and(gt(people.age, 18), like(people.name, "kel%")));
    expect(compiled.fullyExact).toBe(false);
    expect(compiled.valueTree).toEqual({
      kind: "and",
      nodes: [leaf("age", "gt", 18), { kind: "opaque" }],
    });
  });

  it("keeps the hole visible when one branch of an OR is inexact", () => {
    // Not symmetric with the AND above, and that asymmetry is load-bearing:
    // dropping a DISJUNCT would lose rows rather than gain them.
    expect(compile(or(gt(people.age, 18), like(people.name, "kel%"))).valueTree).toEqual({
      kind: "or",
      nodes: [leaf("age", "gt", 18), { kind: "opaque" }],
    });
  });

  it("is trivially exact with no where clause", () => {
    expect(compileWhere(undefined, (column) => column.name).fullyExact).toBe(true);
  });
});

describe("chunk-walk edge cases", () => {
  // These are the drizzle-specific failure modes — the shared semantics are
  // covered in busabase-orm-core's own suite.
  it("rejects a like pattern that is not a string", () => {
    expect(() => compile(like(people.name, 42 as never))).toThrow(UnsupportedWhereError);
  });

  it("rejects an in-list holding a non-literal", () => {
    expect(() => compile(inArray(people.name, [people.age] as never))).toThrow(
      UnsupportedWhereError,
    );
  });

  it("rejects a hand-built tree it cannot make sense of", () => {
    // drizzle never emits this shape; a hand-assembled SQL object can. The
    // point is that an unrecognised tree is refused, not silently walked.
    const mixed = sql`${sql`(`}${[
      eq(people.name, "a"),
      sql` and `,
      eq(people.name, "b"),
      sql` or `,
      eq(people.name, "c"),
    ]}${sql`)`}`;
    expect(() => compile(mixed)).toThrow(UnsupportedWhereError);
  });

  it("describes the offending node in the message", () => {
    expect(() => compile(sql`lower(${people.name}) = 'x'`)).toThrow(
      /sql expression|not translatable/,
    );
  });

  it("compiles an absent where clause to an always-true predicate", () => {
    const compiled = compileWhere(undefined, (column) => column.name);
    expect(compiled.predicate({})).toBe(true);
    expect(compiled.fullyExact).toBe(true);
    expect(compiled.pushdown).toEqual([]);
  });
});
