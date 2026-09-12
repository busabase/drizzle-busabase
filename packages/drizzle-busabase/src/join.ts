import { type JoinPair, UnsupportedJoinError } from "busabase-orm-core";
import { Column, SQL } from "drizzle-orm";

/**
 * Reading drizzle's `ON` expression. The hash join itself is in
 * busabase-orm-core — what a join means is not a drizzle question.
 *
 * Busabase's REST surface has no join, so this is emulated — which used to be
 * the argument for refusing it outright ("emulating one client-side would
 * silently read whole Bases"). Half of that argument stopped being true in this
 * same branch: a multi-value `IN` is now pushed down as a disjunction, so the
 * RIGHT side of a join is fetched by key rather than scanned. A star join
 * against a large lookup table is now one narrow request per batch instead of a
 * full read.
 *
 * The other half is still true and is not hidden: the LEFT (driving) side is
 * read in full, because a `where` on a joined query is evaluated against the
 * COMBINED row and cannot be split back into per-table conditions here. That is
 * bounded by `maxScannedRecords` and fails loudly, exactly like every other
 * scan this driver does.
 *
 * Rows are keyed by QUALIFIED name (`contacts.name`) once joined, because a
 * bare column name is ambiguous the moment two tables are in play — and
 * silently resolving `id` to the wrong table's `id` is the kind of wrong answer
 * that looks right.
 */

/** `contacts.name` — the key a joined row's payload is written under. */
export const qualify = (column: Column): string =>
  `${(column.table as unknown as Record<symbol, string>)[Symbol.for("drizzle:Name")]}.${column.name}`;

const chunkText = (chunk: unknown): string | null => {
  if (typeof chunk !== "object" || chunk === null) return null;
  const value = (chunk as { value?: unknown }).value;
  if (!Array.isArray(value) || !value.every((part) => typeof part === "string")) return null;
  return value.join("");
};

/** Drops the empty `""` chunks drizzle pads binary expressions with. */
const meaningful = (chunks: unknown[]): unknown[] =>
  chunks.filter((chunk) => chunkText(chunk) !== "");

/**
 * `ON a.x = b.y`, or an AND of several such equalities.
 *
 * Only equality, and only column-to-column. An inequality join or a condition
 * against a literal has no hash key to build, and emulating either would mean a
 * nested-loop over two full tables — which is the thing this refuses to do
 * quietly.
 */
export const parseJoinOn = (on: unknown): JoinPair[] => {
  if (!(on instanceof SQL)) {
    throw new UnsupportedJoinError("the ON condition is not an expression this driver can read");
  }
  const chunks = meaningful((on as unknown as { queryChunks: unknown[] }).queryChunks);

  // `(` <operands> `)` — how `and()` / `or()` wrap their operand list. The
  // operand list arrives as a nested SQL, not as a bare array.
  if (chunks.length === 3 && chunkText(chunks[0]) === "(" && chunkText(chunks[2]) === ")") {
    const inner = chunks[1];
    if (inner instanceof SQL) {
      return parseOperands(
        meaningful((inner as unknown as { queryChunks: unknown[] }).queryChunks),
      );
    }
    if (Array.isArray(inner)) return parseOperands(inner);
  }
  if (chunks.some((chunk) => chunk instanceof SQL)) return parseOperands(chunks);
  return [parseEquality(chunks)];
};

const parseOperands = (parts: unknown[]): JoinPair[] => {
  const pairs: JoinPair[] = [];
  for (const part of parts) {
    if (part instanceof SQL) {
      pairs.push(...parseJoinOn(part));
      continue;
    }
    if (chunkText(part)?.trim() === "or") {
      throw new UnsupportedJoinError("an OR in ON has no single hash key to join on");
    }
    // `and` and the padding between operands carry no condition of their own.
  }
  return pairs;
};

const parseEquality = (chunks: unknown[]): JoinPair => {
  const columns = chunks.filter((chunk): chunk is Column => chunk instanceof Column);
  // Column count first: a raw `sql` fragment has no columns at all, and saying
  // "that is not an equality" about it would point at the wrong thing.
  if (columns.length !== 2) {
    throw new UnsupportedJoinError(
      "ON compares something other than two columns — a literal or an expression cannot be a join key",
    );
  }
  const operator = chunks
    .map((chunk) => chunkText(chunk)?.trim())
    .find((text) => text !== undefined && text !== null && text !== "");
  if (operator !== "=") {
    throw new UnsupportedJoinError(
      `\`${operator ?? "?"}\` in ON is not an equality, so there is no key to hash on`,
    );
  }
  return { left: qualify(columns[0] as Column), right: qualify(columns[1] as Column) };
};
