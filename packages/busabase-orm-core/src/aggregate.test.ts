import { describe, expect, it } from "vitest";
import { computeAggregate, groupRows } from "./aggregate";
import type { ResolvedBase } from "./base-resolver";
import type { RecordRow } from "./execute";

/**
 * SQL's aggregate semantics, which is the half no driver should re-derive.
 *
 * The cases worth having are the ones JavaScript gets wrong for free: NULLs are
 * IGNORED rather than counted as zero, `avg` divides by the count of PRESENT
 * values, `count(col)` differs from `count(*)`, and an empty group aggregates
 * to NULL rather than to 0.
 */

const base: ResolvedBase = {
  id: "bas_1",
  slug: "contacts",
  fields: new Map([
    ["name", { slug: "name", type: "text" }],
    ["score", { slug: "score", type: "number" }],
    ["stage", { slug: "stage", type: "select" }],
  ]),
};

const row = (payload: Record<string, unknown>, id = "rec"): RecordRow => ({
  id,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  payload,
});

describe("computeAggregate follows SQL, not JavaScript", () => {
  const rows = [row({ score: 10 }), row({ score: 20 }), row({}), row({ score: 30 })];

  it("counts ROWS for count(*), including those missing the field", () => {
    expect(
      computeAggregate(
        { kind: "aggregate", fn: "count", fieldSlug: null, distinct: false },
        base,
        rows,
      ),
    ).toBe(4);
  });

  it("counts PRESENT VALUES for count(col) — the distinction count(*) does not make", () => {
    expect(
      computeAggregate(
        { kind: "aggregate", fn: "count", fieldSlug: "score", distinct: false },
        base,
        rows,
      ),
    ).toBe(3);
  });

  it("counts distinct values once", () => {
    expect(
      computeAggregate(
        { kind: "aggregate", fn: "count", fieldSlug: "score", distinct: true },
        base,
        [row({ score: 10 }), row({ score: 10 }), row({ score: 20 })],
      ),
    ).toBe(2);
  });

  it("sums and averages over PRESENT values, ignoring the missing one", () => {
    // A JS `reduce` over the raw values would make the average 15 (dividing by
    // 4) instead of 20. That is the arithmetic SQL does not do.
    expect(
      computeAggregate(
        { kind: "aggregate", fn: "sum", fieldSlug: "score", distinct: false },
        base,
        rows,
      ),
    ).toBe("60");
    expect(
      computeAggregate(
        { kind: "aggregate", fn: "avg", fieldSlug: "score", distinct: false },
        base,
        rows,
      ),
    ).toBe("20");
  });

  it("returns sum/avg as STRINGS, which is what drizzle declares", () => {
    // `sum()` and `avg()` are typed `SQL<string | null>`: Postgres answers with
    // `numeric`, and node-postgres hands numerics over as strings rather than
    // silently losing precision. Returning a JS number here would typecheck and
    // then disagree with a real database.
    const summed = computeAggregate(
      { kind: "aggregate", fn: "sum", fieldSlug: "score", distinct: false },
      base,
      rows,
    );
    expect(typeof summed).toBe("string");
  });

  it("returns NULL for sum/avg of a group with no values, not 0", () => {
    // "no rows" and "rows summing to zero" are different answers, and a
    // dashboard renders them differently.
    for (const fn of ["sum", "avg"] as const) {
      expect(
        computeAggregate({ kind: "aggregate", fn, fieldSlug: "score", distinct: false }, base, [
          row({}),
        ]),
      ).toBeNull();
    }
    expect(
      computeAggregate(
        { kind: "aggregate", fn: "count", fieldSlug: null, distinct: false },
        base,
        [],
      ),
    ).toBe(0);
  });

  it("keeps the column's own type for min/max rather than stringifying", () => {
    expect(
      computeAggregate(
        { kind: "aggregate", fn: "min", fieldSlug: "score", distinct: false },
        base,
        rows,
      ),
    ).toBe(10);
    expect(
      computeAggregate(
        { kind: "aggregate", fn: "max", fieldSlug: "score", distinct: false },
        base,
        rows,
      ),
    ).toBe(30);
  });

  it("compares min/max numerically, not as text", () => {
    // As text, "9" > "10". Getting this wrong is invisible until a group
    // straddles a digit boundary.
    const straddling = [row({ score: 9 }), row({ score: 10 })];
    expect(
      computeAggregate(
        { kind: "aggregate", fn: "max", fieldSlug: "score", distinct: false },
        base,
        straddling,
      ),
    ).toBe(10);
  });

  it("compares min/max as text when the values are not numeric", () => {
    const named = [row({ name: "bo" }), row({ name: "ada" })];
    expect(
      computeAggregate(
        { kind: "aggregate", fn: "min", fieldSlug: "name", distinct: false },
        base,
        named,
      ),
    ).toBe("ada");
  });
});

describe("groupRows", () => {
  it("makes ONE group of everything when there is nothing to group by", () => {
    const rows = [row({ score: 1 }), row({ score: 2 })];
    expect(groupRows(base, rows, [])).toEqual([{ key: [], rows }]);
  });

  it("still makes one group when there are no rows at all", () => {
    // `select count(*)` over an empty table is one row holding 0, not zero
    // rows. Collapsing to zero groups turns "nothing matched" into "no answer".
    expect(groupRows(base, [], [])).toEqual([{ key: [], rows: [] }]);
  });

  it("produces NO groups when grouping an empty row set by a column", () => {
    // The mirror image, and also SQL: `GROUP BY` over no rows yields no groups.
    expect(groupRows(base, [], ["stage"])).toEqual([]);
  });

  it("buckets by one column", () => {
    const grouped = groupRows(
      base,
      [row({ stage: "won" }, "a"), row({ stage: "lost" }, "b"), row({ stage: "won" }, "c")],
      ["stage"],
    );
    expect(grouped.map((group) => [group.key, group.rows.map((entry) => entry.id)])).toEqual([
      [["won"], ["a", "c"]],
      [["lost"], ["b"]],
    ]);
  });

  it("gives a missing value its own group, the way SQL does", () => {
    // Not folded in with anything else — this is exactly where the server's own
    // `records.groupBy` differs (it folds an unset checkbox in with `false`),
    // and why a grouped count is not routed to it.
    const grouped = groupRows(base, [row({ stage: "won" }), row({})], ["stage"]);
    expect(grouped).toHaveLength(2);
    expect(grouped.map((group) => group.key[0])).toEqual(["won", null]);
  });

  it("buckets by several columns together", () => {
    const grouped = groupRows(
      base,
      [
        row({ stage: "won", score: 1 }, "a"),
        row({ stage: "won", score: 2 }, "b"),
        row({ stage: "won", score: 1 }, "c"),
      ],
      ["stage", "score"],
    );
    expect(grouped).toHaveLength(2);
    expect(grouped[0]?.rows.map((entry) => entry.id)).toEqual(["a", "c"]);
  });
});
