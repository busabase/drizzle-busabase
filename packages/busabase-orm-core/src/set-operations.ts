/**
 * `UNION` / `INTERSECT` / `EXCEPT`, combined over rows this driver already
 * fetched.
 *
 * Combining happens on the PROJECTED row, never on the record id, and that is
 * the whole correctness argument. SQL's set operators compare whole result
 * rows: `select stage from t union select stage from u` collapses two records
 * that share a stage into one row. Deduplicating by record identity instead
 * would return both — right for `selectAll`, wrong for every narrower
 * projection, and wrong in the direction that looks plausible.
 *
 * The `ALL` variants are multiplicity-aware rather than "skip the dedup":
 * `INTERSECT ALL` keeps min(left, right) copies of a row and `EXCEPT ALL` keeps
 * left − right, which is what Postgres does and what a bag-semantics reading
 * requires. Treating them as plain filters would quietly change the row count
 * while leaving the row SET correct — the kind of difference nobody notices
 * until a total is wrong.
 */

export type SetOperator = "union" | "intersect" | "except";

/** A projected row, as the positional array drizzle's result mapper consumes. */
export type ProjectedRow = unknown[];

const identity = (row: ProjectedRow): string => JSON.stringify(row);

const countByIdentity = (rows: ProjectedRow[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = identity(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
};

const dedupe = (rows: ProjectedRow[]): ProjectedRow[] => {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = identity(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/**
 * One set-operation step. `left` is everything combined so far, which is why
 * chained operators fold left-to-right the way SQL evaluates them.
 */
export const combine = (
  left: ProjectedRow[],
  right: ProjectedRow[],
  operator: SetOperator,
  all: boolean,
): ProjectedRow[] => {
  if (operator === "union") {
    const combined = [...left, ...right];
    return all ? combined : dedupe(combined);
  }

  const rightCounts = countByIdentity(right);

  if (operator === "intersect") {
    if (!all) {
      return dedupe(left).filter((row) => rightCounts.has(identity(row)));
    }
    // Bag semantics: a row present twice on the left and once on the right
    // survives once.
    const remaining = new Map(rightCounts);
    return left.filter((row) => {
      const key = identity(row);
      const available = remaining.get(key) ?? 0;
      if (available === 0) return false;
      remaining.set(key, available - 1);
      return true;
    });
  }

  if (!all) {
    return dedupe(left).filter((row) => !rightCounts.has(identity(row)));
  }
  const remaining = new Map(rightCounts);
  return left.filter((row) => {
    const key = identity(row);
    const available = remaining.get(key) ?? 0;
    if (available > 0) {
      remaining.set(key, available - 1);
      return false;
    }
    return true;
  });
};

/**
 * Ordering applied to the COMBINED result.
 *
 * Keys are resolved to a POSITION in the projection, because a combined row is
 * positional — the branches are union-compatible by SQL's own rule, so column
 * `n` means the same thing in all of them.
 */
export const sortCombined = (
  rows: ProjectedRow[],
  keys: { index: number; direction: "asc" | "desc" }[],
  compare: (left: unknown, right: unknown) => number,
): ProjectedRow[] => {
  if (keys.length === 0) return rows;
  return [...rows].sort((left, right) => {
    for (const key of keys) {
      const order = compare(left[key.index], right[key.index]);
      if (order !== 0) return key.direction === "desc" ? -order : order;
    }
    return 0;
  });
};
