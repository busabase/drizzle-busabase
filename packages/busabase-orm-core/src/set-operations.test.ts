import { describe, expect, it } from "vitest";
import { combine, type ProjectedRow, sortCombined } from "./set-operations";

/**
 * SQL's set operators, and specifically the parts a "concat and dedupe"
 * implementation gets wrong.
 *
 * The `ALL` variants are not "skip the dedup": `INTERSECT ALL` keeps
 * min(left, right) copies of a row and `EXCEPT ALL` keeps left − right.
 * Reading them as plain filters changes the row COUNT while leaving the row
 * SET correct, which is exactly the kind of difference nobody notices until a
 * total is wrong.
 */

const rows = (...values: (string | number)[][]): ProjectedRow[] => values;

describe("union", () => {
  it("dedupes whole rows, not record identity", () => {
    expect(combine(rows(["a"], ["b"]), rows(["b"], ["c"]), "union", false)).toEqual(
      rows(["a"], ["b"], ["c"]),
    );
  });

  it("compares the WHOLE row, so rows differing in any column both survive", () => {
    expect(combine(rows(["a", 1]), rows(["a", 2]), "union", false)).toEqual(
      rows(["a", 1], ["a", 2]),
    );
  });

  it("keeps duplicates with ALL", () => {
    expect(combine(rows(["a"], ["b"]), rows(["b"]), "union", true)).toEqual(
      rows(["a"], ["b"], ["b"]),
    );
  });

  it("dedupes WITHIN a branch too, not just across them", () => {
    // `select stage from t` over two records sharing a stage is ONE row after
    // UNION — the dedup is over the combined bag, not a cross-branch check.
    expect(combine(rows(["a"], ["a"]), rows(["a"]), "union", false)).toEqual(rows(["a"]));
  });
});

describe("intersect", () => {
  it("keeps only rows present in both, deduped", () => {
    expect(combine(rows(["a"], ["b"], ["b"]), rows(["b"], ["c"]), "intersect", false)).toEqual(
      rows(["b"]),
    );
  });

  it("keeps min(left, right) copies with ALL", () => {
    // Two on the left, one on the right → one survives. A filter-style
    // implementation would have kept both.
    expect(combine(rows(["b"], ["b"], ["a"]), rows(["b"]), "intersect", true)).toEqual(rows(["b"]));
    expect(combine(rows(["b"], ["b"]), rows(["b"], ["b"], ["b"]), "intersect", true)).toEqual(
      rows(["b"], ["b"]),
    );
  });

  it("is empty when nothing is shared", () => {
    expect(combine(rows(["a"]), rows(["b"]), "intersect", false)).toEqual([]);
  });
});

describe("except", () => {
  it("removes every copy of a matched row, deduped", () => {
    expect(combine(rows(["a"], ["b"], ["b"]), rows(["b"]), "except", false)).toEqual(rows(["a"]));
  });

  it("removes left − right copies with ALL", () => {
    expect(combine(rows(["b"], ["b"], ["b"]), rows(["b"]), "except", true)).toEqual(
      rows(["b"], ["b"]),
    );
  });

  it("keeps a left row the right side does not hold at all", () => {
    expect(combine(rows(["a"], ["b"]), rows(["c"]), "except", true)).toEqual(rows(["a"], ["b"]));
  });

  it("is not symmetric — right-only rows are never added", () => {
    expect(combine(rows(["a"]), rows(["a"], ["z"]), "except", false)).toEqual([]);
  });
});

describe("null and type handling", () => {
  it("collapses two NULLs, unlike a WHERE comparison", () => {
    // SQL's set operators compare with NOT DISTINCT FROM, so NULL matches NULL
    // here — the opposite of `NULL = NULL` being UNKNOWN in a filter.
    expect(combine([[null]], [[null]], "intersect", false)).toEqual([[null]]);
  });

  it("does not conflate a number with its string spelling", () => {
    expect(combine([[1]], [["1"]], "intersect", false)).toEqual([]);
  });
});

describe("sortCombined", () => {
  const compare = (left: unknown, right: unknown) =>
    left === right ? 0 : (left as number) < (right as number) ? -1 : 1;

  it("orders by a projection POSITION, ascending and descending", () => {
    const input = rows(["b", 2], ["a", 1], ["c", 3]);
    expect(sortCombined(input, [{ index: 0, direction: "asc" }], compare)).toEqual(
      rows(["a", 1], ["b", 2], ["c", 3]),
    );
    expect(sortCombined(input, [{ index: 1, direction: "desc" }], compare)).toEqual(
      rows(["c", 3], ["b", 2], ["a", 1]),
    );
  });

  it("falls through to the next key on a tie", () => {
    expect(
      sortCombined(
        rows(["a", 2], ["a", 1]),
        [
          { index: 0, direction: "asc" },
          { index: 1, direction: "asc" },
        ],
        compare,
      ),
    ).toEqual(rows(["a", 1], ["a", 2]));
  });

  it("does not mutate its input", () => {
    const input = rows(["b"], ["a"]);
    sortCombined(input, [{ index: 0, direction: "asc" }], compare);
    expect(input).toEqual(rows(["b"], ["a"]));
  });
});
