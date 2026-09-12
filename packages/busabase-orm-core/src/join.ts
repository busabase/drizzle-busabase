import type { ResolvedBase } from "./base-resolver";
import type { RecordRow } from "./execute";
import { readColumn } from "./execute";

/**
 * The hash join itself, which is not about any query builder.
 *
 * How an ORM SPELLS a join differs (drizzle hands over a chunk tree for `ON`;
 * Kysely emits a `JoinNode`), but what a join MEANS does not — and the meaning
 * is where the mistakes are: an outer join keeps its unmatched side with NULLs,
 * a duplicate key on the joined side MULTIPLIES rows rather than picking one,
 * and a NULL join key matches nothing including another NULL.
 *
 * Rows are keyed by QUALIFIED name (`contacts.name`) once joined, because a
 * bare column name is ambiguous the moment two tables are in play — and
 * silently resolving `id` to the wrong table's `id` is the kind of wrong answer
 * that looks right.
 */

export type JoinType = "inner" | "left" | "right" | "full";

export interface JoinPair {
  /** Qualified column on the rows accumulated so far. */
  left: string;
  /** Qualified column on the table being joined in. */
  right: string;
}

export interface JoinSpec {
  /** Table name, which the resolver maps to a Base slug. */
  tableName: string;
  alias: string;
  type: JoinType;
  pairs: JoinPair[];
}

export class UnsupportedJoinError extends Error {
  constructor(detail: string) {
    super(
      `busabase: cannot translate this join: ${detail}. ` +
        `It is rejected rather than approximated, because a join that quietly drops a condition ` +
        `returns rows that do not belong together.`,
    );
    this.name = "UnsupportedJoinError";
  }
}

/**
 * A row of the join so far: values keyed by qualified column name, plus the
 * per-table record ids that produced it (kept so a projection can still ask for
 * a table's system columns).
 */
export interface JoinedRow {
  values: Record<string, unknown>;
  /** Qualified table name → the RecordRow it came from, or null for an unmatched outer side. */
  sources: Record<string, RecordRow | null>;
}

/** Every column of one record, written under its table's qualified names. */
export const qualifiedValues = (
  base: ResolvedBase,
  table: string,
  row: RecordRow | null,
  columnNames: string[],
): Record<string, unknown> => {
  const values: Record<string, unknown> = {};
  for (const name of columnNames) {
    values[`${table}.${name}`] = row === null ? null : readColumn(base, row, name);
  }
  return values;
};

const keyOf = (values: Record<string, unknown>, names: string[]): string =>
  JSON.stringify(names.map((name) => values[name] ?? null));

/**
 * One join step: combine the rows built so far with the rows of the table being
 * joined in.
 *
 * `right` and `full` are handled by the same code as `inner`/`left` — a right
 * join is a left join with the sides swapped, and a full join is a left join
 * plus the right rows nothing matched. Rather than four code paths, the caller
 * says which unmatched sides to keep.
 */
export const hashJoin = (
  accumulated: JoinedRow[],
  incoming: { row: RecordRow; values: Record<string, unknown> }[],
  pairs: JoinPair[],
  type: JoinType,
  incomingTable: string,
  emptyIncoming: Record<string, unknown>,
): JoinedRow[] => {
  const leftNames = pairs.map((pair) => pair.left);
  const rightNames = pairs.map((pair) => pair.right);

  const buckets = new Map<string, typeof incoming>();
  for (const entry of incoming) {
    const key = keyOf(entry.values, rightNames);
    const existing = buckets.get(key);
    if (existing) existing.push(entry);
    else buckets.set(key, [entry]);
  }

  const keepUnmatchedLeft = type === "left" || type === "full";
  const keepUnmatchedRight = type === "right" || type === "full";
  const matchedKeys = new Set<string>();
  const output: JoinedRow[] = [];

  for (const accumulatedRow of accumulated) {
    const key = keyOf(accumulatedRow.values, leftNames);
    const matches = buckets.get(key);
    // A NULL join key never matches, in SQL and here: `keyOf` renders it as
    // `[null]`, so an incoming row whose key is also null would collide with it
    // — which is why an all-null key is excluded rather than bucketed.
    const nullKey = leftNames.every((name) => accumulatedRow.values[name] == null);
    if (!matches || nullKey) {
      if (keepUnmatchedLeft) {
        output.push({
          values: { ...accumulatedRow.values, ...emptyIncoming },
          sources: { ...accumulatedRow.sources, [incomingTable]: null },
        });
      }
      continue;
    }
    matchedKeys.add(key);
    for (const match of matches) {
      output.push({
        values: { ...accumulatedRow.values, ...match.values },
        sources: { ...accumulatedRow.sources, [incomingTable]: match.row },
      });
    }
  }

  if (keepUnmatchedRight) {
    const emptyAccumulated = Object.fromEntries(
      Object.keys(accumulated[0]?.values ?? {}).map((name) => [name, null]),
    );
    const emptySources = Object.fromEntries(
      Object.keys(accumulated[0]?.sources ?? {}).map((name) => [name, null]),
    );
    for (const entry of incoming) {
      const key = keyOf(entry.values, rightNames);
      if (matchedKeys.has(key)) continue;
      output.push({
        values: { ...emptyAccumulated, ...entry.values },
        sources: { ...emptySources, [incomingTable]: entry.row },
      });
    }
  }

  return output;
};

/**
 * Distinct join-key values on the accumulated side, so the incoming table can
 * be fetched BY KEY instead of scanned.
 *
 * Only single-column keys: a composite key would need an `IN` over tuples,
 * which Busabase's value filters cannot express, so those fall back to reading
 * the incoming table in full.
 */
export const distinctKeyValues = (rows: JoinedRow[], pairs: JoinPair[]): unknown[] | null => {
  if (pairs.length !== 1) return null;
  const name = (pairs[0] as JoinPair).left;
  const seen = new Set<string>();
  const values: unknown[] = [];
  for (const row of rows) {
    const value = row.values[name];
    if (value === null || value === undefined) continue;
    const identity = typeof value === "string" ? value : JSON.stringify(value);
    if (seen.has(identity)) continue;
    seen.add(identity);
    values.push(value);
  }
  return values;
};
