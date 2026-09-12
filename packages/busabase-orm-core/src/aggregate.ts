import type { ResolvedBase } from "./base-resolver";
import type { RecordRow } from "./execute";
import { readColumn } from "./execute";

/**
 * Aggregate arithmetic, in SQL's semantics rather than JavaScript's.
 *
 * Shared rather than per-driver because none of it is about any query builder:
 * how an ORM SPELLS `sum(x)` differs (drizzle renders an `SQL` whose chunks are
 * `["sum(", col, ")"]`; Kysely emits an `AggregateFunctionNode`), but what
 * `sum` MEANS does not. The subtle parts — NULLs are ignored rather than
 * counted as zero, `count(col)` differs from `count(*)`, an empty group
 * aggregates to NULL rather than 0 — are exactly the parts worth having in one
 * place instead of once per driver.
 */

export type AggregateFn = "count" | "sum" | "avg" | "min" | "max";

export interface AggregateEntry {
  kind: "aggregate";
  fn: AggregateFn;
  /** `null` for `count()` / `count(*)`, which counts rows rather than values. */
  fieldSlug: string | null;
  distinct: boolean;
}

export interface ColumnEntry {
  kind: "column";
  fieldSlug: string;
}

export type ProjectionEntry = AggregateEntry | ColumnEntry;

/**
 * Every value in one group, for one field. Nulls are dropped: SQL aggregates
 * ignore NULL, so `avg` divides by the count of PRESENT values and `sum` of an
 * all-null group is NULL rather than 0. `count(col)` follows the same rule,
 * which is what makes it different from `count(*)`.
 */
const presentValues = (
  base: ResolvedBase,
  rows: RecordRow[],
  fieldSlug: string,
  distinct: boolean,
): unknown[] => {
  const values = rows
    .map((row) => readColumn(base, row, fieldSlug))
    .filter((value) => value !== null && value !== undefined);
  if (!distinct) return values;
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = typeof value === "string" ? value : JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const numeric = (values: unknown[]): number[] =>
  values
    .map((value) => (typeof value === "number" ? value : Number(value)))
    .filter((value) => Number.isFinite(value));

/**
 * One aggregate over one group.
 *
 * The return types follow Postgres rather than convenience, because a caller
 * comparing against a real database will notice otherwise: `count` is a number,
 * `sum`/`avg` come back as STRINGS (Postgres returns numeric for both, and
 * node-postgres hands numerics over as strings to avoid silent precision loss),
 * and `min`/`max` keep the column's own type. `sum`/`avg` of an empty group is
 * `null`, not `0` — the distinction between "no rows" and "rows summing to
 * zero" is one a dashboard renders differently.
 */
export const computeAggregate = (
  entry: AggregateEntry,
  base: ResolvedBase,
  rows: RecordRow[],
): unknown => {
  if (entry.fn === "count") {
    if (entry.fieldSlug === null) return rows.length;
    return presentValues(base, rows, entry.fieldSlug, entry.distinct).length;
  }

  const values = presentValues(base, rows, entry.fieldSlug as string, entry.distinct);
  if (values.length === 0) return null;

  if (entry.fn === "min" || entry.fn === "max") {
    const wantLower = entry.fn === "min";
    return values.reduce((best, value) => {
      const order = compareForExtreme(value, best);
      return (wantLower ? order < 0 : order > 0) ? value : best;
    });
  }

  const numbers = numeric(values);
  if (numbers.length === 0) return null;
  const total = numbers.reduce((sum, value) => sum + value, 0);
  // Postgres returns `numeric` for both, which arrives as a string.
  return entry.fn === "sum" ? String(total) : String(total / numbers.length);
};

/** Ordering for min/max: numbers numerically, everything else as text. */
const compareForExtreme = (left: unknown, right: unknown): number => {
  const leftNumber = typeof left === "number" ? left : Number(left);
  const rightNumber = typeof right === "number" ? right : Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber === rightNumber ? 0 : leftNumber < rightNumber ? -1 : 1;
  }
  const leftText = String(left);
  const rightText = String(right);
  return leftText === rightText ? 0 : leftText < rightText ? -1 : 1;
};

/**
 * Rows → groups, keyed by the GROUP BY columns.
 *
 * With no group columns the whole row set is ONE group, and it exists even when
 * there are no rows at all: `select count(*)` over an empty table is one row
 * holding `0`, not zero rows. Getting that wrong turns "nothing matched" into
 * "no answer", which reads as a failed query.
 */
export const groupRows = (
  base: ResolvedBase,
  rows: RecordRow[],
  groupSlugs: string[],
): { key: unknown[]; rows: RecordRow[] }[] => {
  if (groupSlugs.length === 0) return [{ key: [], rows }];
  const groups = new Map<string, { key: unknown[]; rows: RecordRow[] }>();
  for (const row of rows) {
    const key = groupSlugs.map((slug) => readColumn(base, row, slug));
    const identity = JSON.stringify(key.map((value) => value ?? null));
    const existing = groups.get(identity);
    if (existing) existing.rows.push(row);
    else groups.set(identity, { key, rows: [row] });
  }
  return [...groups.values()];
};
