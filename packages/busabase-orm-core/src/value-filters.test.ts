import { describe, expect, it } from "vitest";
import type { ResolvedBase } from "./base-resolver";
import type { ValueNode } from "./predicate";
import { compileValueFilters } from "./value-filters";

/**
 * Prune + CNF, the two steps between a where clause's exact tree and the wire.
 *
 * Both have a failure mode that is invisible in the result of a single query:
 * prune can drop a disjunct (losing rows the caller asked for), and CNF can
 * blow up (making the request itself fail). So the assertions here are about
 * the SHAPE that goes out and the `exact` flag that rides with it — the flag is
 * what decides whether the caller may stop deciding locally, so an `exact: true`
 * on an incomplete filter set is the worst possible outcome and is checked
 * explicitly in every dropping case.
 */

const base = (fields: Record<string, string>): ResolvedBase => ({
  id: "bas_1",
  slug: "t",
  fields: new Map(Object.entries(fields).map(([slug, type]) => [slug, { slug, type }])),
});

const BASE = base({
  score: "number",
  seq: "auto_number",
  due: "date",
  made: "created_time",
  name: "text",
  tag: "select",
  done: "checkbox",
  blob: "json",
  people: "relation",
});

const leaf = (fieldSlug: string, operator: string, value: unknown): ValueNode =>
  ({ kind: "leaf", fieldSlug, operator, value }) as ValueNode;

const compile = (tree: ValueNode) => compileValueFilters(tree, BASE);

describe("encoding one leaf per family", () => {
  it.each([
    ["number", leaf("score", "gt", 40), { fieldSlug: "score", operator: "gt", value: 40 }],
    ["auto_number", leaf("seq", "lte", 7), { fieldSlug: "seq", operator: "lte", value: 7 }],
    ["text eq", leaf("name", "eq", "Ada"), { fieldSlug: "name", operator: "eq", value: "Ada" }],
    ["select eq", leaf("tag", "ne", "red"), { fieldSlug: "tag", operator: "ne", value: "red" }],
    ["checkbox", leaf("done", "eq", true), { fieldSlug: "done", operator: "eq", value: true }],
  ])("%s", (_label, tree, expected) => {
    expect(compile(tree)).toEqual({ filters: [expected], exact: true });
  });

  it("normalises a Date to ISO 8601, which is what the server parses", () => {
    const when = new Date("2026-04-15T00:00:00.000Z");
    expect(compile(leaf("due", "gte", when)).filters).toEqual([
      { fieldSlug: "due", operator: "gte", value: "2026-04-15T00:00:00.000Z" },
    ]);
  });

  it("sends computed dates the same way as a plain date field", () => {
    expect(compile(leaf("made", "lt", "2026-01-01T00:00:00.000Z")).exact).toBe(true);
  });
});

describe("refuses to send what the server would refuse", () => {
  // Each of these would be a 400 rather than a skipped condition, so the point
  // is that the leaf never leaves — and that `exact` drops, so the caller keeps
  // deciding locally instead of trusting a filter that was never applied.
  it.each([
    ["a field the Base does not define", leaf("nope", "eq", 1)],
    ["a field family with no exact column", leaf("blob", "eq", "x")],
    ["a relation", leaf("people", "eq", "x")],
    ["ordering on text — collation makes it unreproducible", leaf("name", "gt", "b")],
    ["ordering on a select", leaf("tag", "lt", "red")],
    ["a non-boolean on a checkbox", leaf("done", "eq", "true")],
    ["a non-string on a text field", leaf("name", "eq", 42)],
    ["a non-numeric on a number field", leaf("score", "gt", "banana")],
    ["an unparseable date", leaf("due", "gt", "banana")],
    ["a boolean on a date field", leaf("due", "gt", true)],
  ])("%s", (_label, tree) => {
    expect(compile(tree)).toEqual({ filters: [], exact: false });
  });

  it("refuses a text comparison at or over the projection limit", () => {
    // Below the limit, `value_text = target` proves full-value equality; at it,
    // a truncated value has exactly that many characters and could collide.
    expect(compile(leaf("name", "eq", "x".repeat(7_999))).exact).toBe(true);
    expect(compile(leaf("name", "eq", "x".repeat(8_000)))).toEqual({ filters: [], exact: false });
  });
});

describe("pruning is asymmetric between AND and OR", () => {
  it("drops an unpushable CONJUNCT and keeps the rest, marked inexact", () => {
    // Legal: fewer conjuncts is a WIDER row set, and the local predicate still
    // narrows it. Worth sending because the surviving half still cuts transfer.
    const result = compile({
      kind: "and",
      nodes: [leaf("score", "gt", 40), { kind: "opaque" }],
    });
    expect(result.filters).toEqual([{ fieldSlug: "score", operator: "gt", value: 40 }]);
    expect(result.exact).toBe(false);
  });

  it("drops the WHOLE disjunction when one branch is unpushable", () => {
    // Illegal to trim: keeping only the expressible branch would return a
    // SUBSET, and the rows the other branch matched would silently vanish.
    // This is the single assertion that separates a correct implementation from
    // one that looks correct on every positive test.
    expect(compile({ kind: "or", nodes: [leaf("score", "gt", 40), { kind: "opaque" }] })).toEqual({
      filters: [],
      exact: false,
    });
  });

  it("drops an OR whose branch is unpushable only because of its FIELD", () => {
    // Same rule, reached through encoding rather than through an opaque node.
    expect(
      compile({ kind: "or", nodes: [leaf("score", "gt", 40), leaf("blob", "eq", "x")] }),
    ).toEqual({ filters: [], exact: false });
  });

  it("treats an empty OR as unpushable rather than as a match-nothing filter", () => {
    // An OR of nothing is FALSE, and there is no wire form for that — `any: []`
    // is rejected by the schema. The local predicate returns false for every
    // row, which is correct if not free.
    expect(compile({ kind: "or", nodes: [] })).toEqual({ filters: [], exact: false });
  });

  it("treats an empty AND as no constraint at all, and stays exact", () => {
    expect(compile({ kind: "and", nodes: [] })).toEqual({ filters: [], exact: true });
  });

  it("keeps an AND exact when every conjunct survives", () => {
    const result = compile({
      kind: "and",
      nodes: [leaf("score", "gte", 0), leaf("name", "eq", "Ada")],
    });
    expect(result.exact).toBe(true);
    expect(result.filters).toHaveLength(2);
  });
});

describe("CNF distribution", () => {
  it("sends a flat OR as one `any` group", () => {
    expect(
      compile({ kind: "or", nodes: [leaf("score", "eq", 1), leaf("score", "eq", 2)] }).filters,
    ).toEqual([
      {
        any: [
          { fieldSlug: "score", operator: "eq", value: 1 },
          { fieldSlug: "score", operator: "eq", value: 2 },
        ],
      },
    ]);
  });

  it("collapses a single-branch OR to a bare comparison", () => {
    expect(compile({ kind: "or", nodes: [leaf("score", "eq", 1)] }).filters).toEqual([
      { fieldSlug: "score", operator: "eq", value: 1 },
    ]);
  });

  it("emits an AND of comparisons as separate conjuncts", () => {
    expect(
      compile({ kind: "and", nodes: [leaf("score", "gte", 0), leaf("score", "lt", 10)] }).filters,
    ).toEqual([
      { fieldSlug: "score", operator: "gte", value: 0 },
      { fieldSlug: "score", operator: "lt", value: 10 },
    ]);
  });

  it("distributes an OR over an AND — the case CNF exists for", () => {
    // (score > 40 AND score < 90) OR tag = red
    //   ⇒ (score > 40 OR tag = red) AND (score < 90 OR tag = red)
    const result = compile({
      kind: "or",
      nodes: [
        { kind: "and", nodes: [leaf("score", "gt", 40), leaf("score", "lt", 90)] },
        leaf("tag", "eq", "red"),
      ],
    });
    expect(result.exact).toBe(true);
    expect(result.filters).toEqual([
      {
        any: [
          { fieldSlug: "score", operator: "gt", value: 40 },
          { fieldSlug: "tag", operator: "eq", value: "red" },
        ],
      },
      {
        any: [
          { fieldSlug: "score", operator: "lt", value: 90 },
          { fieldSlug: "tag", operator: "eq", value: "red" },
        ],
      },
    ]);
  });

  it("keeps an AND of ORs as one conjunct each, without distributing", () => {
    const result = compile({
      kind: "and",
      nodes: [
        { kind: "or", nodes: [leaf("tag", "eq", "red"), leaf("tag", "eq", "blue")] },
        leaf("score", "gte", 0),
      ],
    });
    expect(result.filters).toEqual([
      {
        any: [
          { fieldSlug: "tag", operator: "eq", value: "red" },
          { fieldSlug: "tag", operator: "eq", value: "blue" },
        ],
      },
      { fieldSlug: "score", operator: "gte", value: 0 },
    ]);
  });

  it("gives up on a distribution that would outgrow the URL budget", () => {
    // `records.list` is a GET, so every literal rides in the query string and a
    // big enough CNF is a 414 rather than a slow query. Degrading to a local
    // scan is correct; degrading to a truncated filter would not be.
    const wide = (slug: string, count: number): ValueNode => ({
      kind: "or",
      nodes: Array.from({ length: count }, (_, index) => leaf(slug, "eq", index)),
    });
    const result = compile({ kind: "and", nodes: [wide("score", 20), wide("seq", 20)] });
    // Each disjunction on its own fits, so both survive as separate conjuncts —
    // an AND does not distribute, which is exactly why it stays affordable.
    expect(result.exact).toBe(true);
    expect(result.filters).toHaveLength(2);

    // Nor does an OR of ORs: disjunction is associative, so it FLATTENS into
    // one wide clause rather than multiplying. Worth pinning down, because it
    // is the shape a big `inArray` produces and it must not be refused.
    const flattened = compile({ kind: "or", nodes: [wide("score", 20), wide("seq", 20)] });
    expect(flattened.exact).toBe(true);
    expect(flattened.filters).toHaveLength(1);

    // The blow-up lives in an OR of ANDs, which is the only shape that
    // genuinely multiplies: 10 × 10 clauses, each 2 literals wide.
    const deep = (slug: string, count: number): ValueNode => ({
      kind: "and",
      nodes: Array.from({ length: count }, (_, index) => leaf(slug, "ne", index)),
    });
    const exploded = compile({ kind: "or", nodes: [deep("score", 10), deep("seq", 10)] });
    expect(exploded).toEqual({ filters: [], exact: false });
  });

  it("drops only the oversized CONJUNCT, keeping the affordable one", () => {
    const huge: ValueNode = {
      kind: "or",
      nodes: Array.from({ length: 200 }, (_, index) => leaf("score", "eq", index)),
    };
    const result = compile({ kind: "and", nodes: [leaf("name", "eq", "Ada"), huge] });
    expect(result.filters).toEqual([{ fieldSlug: "name", operator: "eq", value: "Ada" }]);
    expect(result.exact).toBe(false);
  });
});
