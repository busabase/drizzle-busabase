import { describe, expect, it } from "vitest";
import {
  all,
  alwaysTrue,
  any,
  type BusabaseFilter,
  columnComparison,
  comparison,
  finalize,
  inRange,
  isEmpty,
  isNotEmpty,
  matchesPattern,
  negate,
  oneOf,
  type RecordPayload,
} from "./predicate";

/**
 * These are the semantics both drivers inherit, so they are tested here once
 * rather than re-tested through each ORM's syntax. The driver suites cover the
 * other half: that their AST walk calls the right builder.
 */

const rows: RecordPayload[] = [
  { name: "kelly", age: 30, active: true },
  { name: "sam", age: 17, active: false },
  { name: "kelsey", age: 44, active: true },
  { name: null, age: null, active: null },
  { name: "", age: 0, active: false },
  {},
];

const matches = (node: Parameters<typeof finalize>[0], payload: RecordPayload) =>
  finalize(node).predicate(payload);

describe("three-valued logic", () => {
  const row: RecordPayload = { name: "kelly", age: 30 };

  it.each([
    ["eq hit", comparison("name", "eq", "kelly"), true],
    ["eq miss", comparison("name", "eq", "sam"), false],
    ["ne hit", comparison("name", "ne", "sam"), true],
    ["gt hit", comparison("age", "gt", 18), true],
    ["gte boundary", comparison("age", "gte", 30), true],
    ["lt miss", comparison("age", "lt", 30), false],
    ["lte boundary", comparison("age", "lte", 30), true],
    ["between inclusive", inRange("age", 30, 40), true],
    ["between outside", inRange("age", 31, 40), false],
    ["in hit", oneOf("name", ["sam", "kelly"], false), true],
    ["not in hit", oneOf("name", ["sam"], true), true],
    ["isNotEmpty", isNotEmpty("name"), true],
    ["isEmpty", isEmpty("name"), false],
  ])("%s", (_label, node, expected) => {
    expect(matches(node, row)).toBe(expected);
  });

  it("treats a missing field as UNKNOWN, not as a JS coercion", () => {
    // `undefined > 18` is false in JS by coercion; SQL says UNKNOWN, which
    // satisfies neither the comparison nor its negation.
    expect(matches(comparison("age", "gt", 18), {})).toBe(false);
    expect(matches(comparison("age", "lt", 18), {})).toBe(false);
    expect(matches(comparison("name", "ne", "sam"), {})).toBe(false);
  });

  it("AND with UNKNOWN is not true, OR short-circuits past it", () => {
    const left = comparison("name", "eq", "kelly");
    const right = comparison("age", "gt", 1);
    expect(matches(all([left, right]), { name: "kelly" })).toBe(false);
    expect(matches(any([left, right]), { name: "kelly" })).toBe(true);
  });

  it("NOT of UNKNOWN stays UNKNOWN", () => {
    expect(matches(negate(comparison("name", "eq", "kelly")), {})).toBe(false);
  });

  it("matches patterns case-sensitively unless asked otherwise", () => {
    expect(matches(matchesPattern("name", "KEL%", false), { name: "kelly" })).toBe(false);
    expect(matches(matchesPattern("name", "KEL%", true), { name: "kelly" })).toBe(true);
  });

  it("escapes regex metacharacters in a pattern", () => {
    expect(matches(matchesPattern("name", "a.c", false), { name: "abc" })).toBe(false);
    expect(matches(matchesPattern("name", "a.c", false), { name: "a.c" })).toBe(true);
  });
});

describe("columnComparison", () => {
  const decide = (node: ReturnType<typeof columnComparison>, payload: Record<string, unknown>) =>
    finalize(node).predicate(payload);

  it.each([
    ["gt", { a: 5, b: 3 }, true],
    ["gt", { a: 3, b: 5 }, false],
    ["gte", { a: 5, b: 5 }, true],
    ["lt", { a: 3, b: 5 }, true],
    ["lte", { a: 5, b: 5 }, true],
    ["eq", { a: 5, b: 5 }, true],
    ["ne", { a: 5, b: 6 }, true],
  ] as const)("%s", (operator, payload, expected) => {
    expect(decide(columnComparison("a", operator, "b"), payload)).toBe(expected);
  });

  it.each(["eq", "ne", "gt", "gte", "lt", "lte"] as const)(
    "%s is UNKNOWN when either side is missing, not false-by-coercion",
    (operator) => {
      // `undefined > 1` is `false` in JS and UNKNOWN in SQL. Both readings keep
      // the row out of a WHERE, but only one of them keeps `NOT` honest — which
      // is why this goes through the same `compare`/`equals` as a literal.
      expect(decide(columnComparison("a", operator, "b"), { a: 5 })).toBe(false);
      expect(decide(columnComparison("a", operator, "b"), { b: 5 })).toBe(false);
      expect(decide(columnComparison("a", operator, "b"), {})).toBe(false);
    },
  );

  it("compares text columns as text", () => {
    expect(decide(columnComparison("a", "eq", "b"), { a: "x", b: "x" })).toBe(true);
    expect(decide(columnComparison("a", "lt", "b"), { a: "a", b: "b" })).toBe(true);
  });

  it("is never sent to the server — there is no wire form for it", () => {
    expect(finalize(columnComparison("a", "gt", "b")).fullyExact).toBe(false);
    expect(finalize(columnComparison("a", "gt", "b")).pushdown).toEqual([]);
  });
});

describe("exactness", () => {
  it("marks a comparison exact and carries it as a leaf", () => {
    const compiled = finalize(comparison("age", "gt", 18));
    expect(compiled.valueTree).toEqual({
      kind: "leaf",
      fieldSlug: "age",
      operator: "gt",
      value: 18,
    });
    expect(compiled.fullyExact).toBe(true);
  });

  it("splits between into the gte/lte pair the server ANDs back", () => {
    expect(finalize(inRange("age", 18, 65)).valueTree).toEqual({
      kind: "and",
      nodes: [
        { kind: "leaf", fieldSlug: "age", operator: "gte", value: 18 },
        { kind: "leaf", fieldSlug: "age", operator: "lte", value: 65 },
      ],
    });
  });

  // These three used to be inexact, and the change is the point of the CNF
  // work rather than a loosened assertion: an OR is now a disjunction the
  // server evaluates, a NOT is rewritten into its leaves, and a multi-element
  // IN is the OR it always was. Each previously forced a full-Base scan.
  it("keeps an OR exact, as a disjunction", () => {
    const compiled = finalize(any([comparison("age", "gt", 18), comparison("age", "lt", 5)]));
    expect(compiled.fullyExact).toBe(true);
    expect(compiled.valueTree).toEqual({
      kind: "or",
      nodes: [
        { kind: "leaf", fieldSlug: "age", operator: "gt", value: 18 },
        { kind: "leaf", fieldSlug: "age", operator: "lt", value: 5 },
      ],
    });
  });

  it("rewrites a NOT into its leaves rather than asking the server for one", () => {
    const compiled = finalize(negate(comparison("age", "gt", 18)));
    expect(compiled.fullyExact).toBe(true);
    expect(compiled.valueTree).toEqual({
      kind: "leaf",
      fieldSlug: "age",
      operator: "lte",
      value: 18,
    });
  });

  it("applies De Morgan through a NOT over an AND", () => {
    expect(
      finalize(negate(all([comparison("age", "gt", 18), comparison("age", "lt", 65)]))).valueTree,
    ).toEqual({
      kind: "or",
      nodes: [
        { kind: "leaf", fieldSlug: "age", operator: "lte", value: 18 },
        { kind: "leaf", fieldSlug: "age", operator: "gte", value: 65 },
      ],
    });
  });

  it("keeps a NOT over an unexpressible condition unexpressible", () => {
    // De Morgan cannot rescue what has no exact form to begin with.
    expect(finalize(negate(matchesPattern("name", "kel%", false))).fullyExact).toBe(false);
  });

  it("turns a multi-element IN into an OR of equalities", () => {
    const compiled = finalize(oneOf("name", ["a", "b"], false));
    expect(compiled.fullyExact).toBe(true);
    expect(compiled.valueTree).toEqual({
      kind: "or",
      nodes: [
        { kind: "leaf", fieldSlug: "name", operator: "eq", value: "a" },
        { kind: "leaf", fieldSlug: "name", operator: "eq", value: "b" },
      ],
    });
  });

  it("turns NOT IN into an AND of inequalities", () => {
    expect(finalize(oneOf("name", ["a", "b"], true)).valueTree).toEqual({
      kind: "and",
      nodes: [
        { kind: "leaf", fieldSlug: "name", operator: "ne", value: "a" },
        { kind: "leaf", fieldSlug: "name", operator: "ne", value: "b" },
      ],
    });
  });

  it.each([
    ["like", matchesPattern("name", "kel%", false)],
    ["isEmpty", isEmpty("name")],
  ])("is not exact with %s", (_label, node) => {
    expect(finalize(node).fullyExact).toBe(false);
  });

  it("loses exactness when one branch of an AND is inexact", () => {
    // One condition the server cannot decide makes its answer a superset again,
    // and a superset cannot carry a limit. The expressible half survives in the
    // tree — dropping a conjunct only widens, so it is still worth sending.
    const compiled = finalize(
      all([comparison("age", "gt", 18), matchesPattern("name", "kel%", false)]),
    );
    expect(compiled.fullyExact).toBe(false);
    expect(compiled.valueTree).toEqual({
      kind: "and",
      nodes: [{ kind: "leaf", fieldSlug: "age", operator: "gt", value: 18 }, { kind: "opaque" }],
    });
  });

  it("keeps the hole visible when one branch of an OR is inexact", () => {
    // The distinction the tree exists for: this hole may NOT be dropped the way
    // the AND's may, because dropping a disjunct loses rows.
    const compiled = finalize(
      any([comparison("age", "gt", 18), matchesPattern("name", "kel%", false)]),
    );
    expect(compiled.fullyExact).toBe(false);
    expect(compiled.valueTree).toEqual({
      kind: "or",
      nodes: [{ kind: "leaf", fieldSlug: "age", operator: "gt", value: 18 }, { kind: "opaque" }],
    });
  });

  it("is trivially exact with nothing to decide", () => {
    expect(finalize(undefined).fullyExact).toBe(true);
    expect(finalize(alwaysTrue).fullyExact).toBe(true);
  });
});

describe("pushdown is a superset of the predicate", () => {
  // The invariant BOTH drivers rest on: whatever the server returns for
  // `pushdown` must still contain every row the predicate accepts. If this
  // breaks, every driver silently loses rows.
  const applyPushdown = (row: RecordPayload, filters: BusabaseFilter[]) =>
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
    ["eq", comparison("name", "eq", "kelly")],
    ["boolean eq", comparison("active", "eq", true)],
    ["contains", matchesPattern("name", "%kel%", true)],
    ["isEmpty", isEmpty("name")],
    ["isNotEmpty", isNotEmpty("name")],
    ["single in", oneOf("name", ["kelly"], false)],
    ["and", all([comparison("active", "eq", true), comparison("age", "gt", 18)])],
    ["or", any([comparison("name", "eq", "kelly"), comparison("age", "gt", 40)])],
    ["not", negate(comparison("name", "eq", "kelly"))],
  ])("%s", (_label, node) => {
    const { pushdown, predicate } = finalize(node);
    for (const row of rows) {
      if (predicate(row)) expect(applyPushdown(row, pushdown)).toBe(true);
    }
  });
});

describe("LIKE pattern translation", () => {
  const like = (pattern: string, value: string, caseInsensitive = false) =>
    finalize(matchesPattern("name", pattern, caseInsensitive)).predicate({ name: value });

  it("treats % as any run of characters, including none", () => {
    expect(like("a%c", "ac")).toBe(true);
    expect(like("a%c", "abbbc")).toBe(true);
    expect(like("a%c", "abd")).toBe(false);
  });

  it("treats _ as exactly one character", () => {
    expect(like("a_c", "abc")).toBe(true);
    expect(like("a_c", "ac")).toBe(false);
    expect(like("a_c", "abbc")).toBe(false);
  });

  it("takes a backslash-escaped wildcard literally", () => {
    // `\%` means a real percent sign, not "anything".
    expect(like("100\\%", "100%")).toBe(true);
    expect(like("100\\%", "100 percent")).toBe(false);
    expect(like("a\\_c", "a_c")).toBe(true);
    expect(like("a\\_c", "abc")).toBe(false);
  });

  it("anchors the whole value, unlike a substring search", () => {
    expect(like("ell", "kelly")).toBe(false);
    expect(like("%ell%", "kelly")).toBe(true);
  });

  it("matches multi-byte characters as single units", () => {
    expect(like("_好", "你好")).toBe(true);
  });

  it("returns UNKNOWN for a missing value rather than false-by-coercion", () => {
    expect(finalize(matchesPattern("name", "%a%", false)).predicate({})).toBe(false);
    expect(finalize(matchesPattern("name", "%a%", false)).predicate({ name: null })).toBe(false);
  });

  it("does not match a non-textual value", () => {
    expect(finalize(matchesPattern("name", "%a%", false)).predicate({ name: { a: 1 } })).toBe(
      false,
    );
  });
});

describe("value coercion at the edges", () => {
  it("compares a Date against an ISO string", () => {
    const node = comparison("due", "gte", new Date("2026-03-01T00:00:00.000Z"));
    expect(finalize(node).predicate({ due: "2026-04-01T00:00:00.000Z" })).toBe(true);
    expect(finalize(node).predicate({ due: "2026-02-01T00:00:00.000Z" })).toBe(false);
  });

  it("compares numeric strings numerically", () => {
    expect(finalize(comparison("age", "gt", 9)).predicate({ age: "10" })).toBe(true);
  });

  it("compares booleans, including their string spellings", () => {
    expect(finalize(comparison("active", "eq", true)).predicate({ active: "true" })).toBe(true);
    expect(finalize(comparison("active", "eq", false)).predicate({ active: "false" })).toBe(true);
    expect(finalize(comparison("active", "eq", true)).predicate({ active: 1 })).toBe(true);
  });

  it("returns UNKNOWN when the pair is not meaningfully ordered", () => {
    expect(finalize(comparison("age", "gt", 1)).predicate({ age: { nested: true } })).toBe(false);
  });

  it("treats an empty string as empty for is/not empty", () => {
    expect(finalize(isEmpty("name")).predicate({ name: "" })).toBe(true);
    expect(finalize(isNotEmpty("name")).predicate({ name: "" })).toBe(false);
  });
});
