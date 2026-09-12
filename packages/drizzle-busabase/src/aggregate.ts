import type { AggregateEntry, AggregateFn } from "busabase-orm-core";
import { Column, SQL } from "drizzle-orm";

/**
 * `select({ n: count(), total: sum(t.score) }).from(t).groupBy(t.stage)`.
 *
 * drizzle builds each aggregate as an ordinary `SQL` whose chunks are the
 * function name, its argument and a closing paren — `["count(", <arg>, ")"]`.
 * There is no aggregate node type to match on, so they are recognised the same
 * way `where` recognises operators: structurally, against shapes verified
 * against the installed drizzle rather than assumed (see aggregate.test.ts,
 * which drives every one of them through the real builders).
 *
 * Only the READING of drizzle's shape lives here; the arithmetic is in
 * busabase-orm-core, because what `sum` means is not a drizzle question.
 *
 * These are computed rather than pushed down, with ONE exception the
 * caller routes away before reaching this module: a bare `count()` over a
 * fully-exact where clause becomes `records.count`. Everything else is
 * arithmetic over rows the driver has already fetched — a scan, bounded by
 * `maxScannedRecords` like any other, and honest about it rather than refused.
 *
 * A GROUPED count is NOT routed to `records.groupBy`, even though that endpoint
 * exists and takes the same value filters. Its buckets are the GRID's, not
 * SQL's: an unset checkbox folds in with `false` and an empty string folds into
 * the null bucket, both right for a Kanban column header and wrong for
 * `GROUP BY`, which gives null its own group.
 *
 * The alternative was the previous behaviour: raise, and let the caller fetch
 * every row and add them up by hand. That is the same scan without the budget.
 */

const chunkText = (chunk: unknown): string | null => {
  if (typeof chunk !== "object" || chunk === null) return null;
  const value = (chunk as { value?: unknown }).value;
  if (!Array.isArray(value) || !value.every((part) => typeof part === "string")) return null;
  return value.join("");
};

const OPENERS: Record<string, { fn: AggregateFn; distinct: boolean }> = {
  "count(": { fn: "count", distinct: false },
  "count(distinct ": { fn: "count", distinct: true },
  "sum(": { fn: "sum", distinct: false },
  "sum(distinct ": { fn: "sum", distinct: true },
  "avg(": { fn: "avg", distinct: false },
  "avg(distinct ": { fn: "avg", distinct: true },
  "min(": { fn: "min", distinct: false },
  "max(": { fn: "max", distinct: false },
};

/** One projected field → what it means, or `null` if it is not an aggregate. */
export const parseAggregate = (field: unknown): AggregateEntry | null => {
  const sql = field instanceof SQL ? field : null;
  if (!sql) return null;
  const chunks = (sql as unknown as { queryChunks: unknown[] }).queryChunks.filter(
    (chunk) => chunkText(chunk) !== "",
  );
  if (chunks.length !== 3) return null;
  const opener = chunkText(chunks[0]);
  const closer = chunkText(chunks[2]);
  if (opener === null || closer !== ")") return null;
  const matched = OPENERS[opener];
  if (!matched) return null;

  const argument = chunks[1];
  if (argument instanceof Column) {
    return { kind: "aggregate", ...matched, fieldSlug: argument.name };
  }
  // `count()` renders its argument as the nested SQL `*`.
  if (argument instanceof SQL) {
    const inner = (argument as unknown as { queryChunks: unknown[] }).queryChunks;
    if (inner.length === 1 && chunkText(inner[0]) === "*") {
      return { kind: "aggregate", ...matched, fieldSlug: null };
    }
  }
  return null;
};
