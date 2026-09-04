import {
  all,
  any,
  type ComparisonOperator,
  type CompiledWhere,
  comparison,
  finalize,
  inRange,
  isEmpty,
  isNotEmpty,
  matchesPattern,
  negate,
  oneOf,
  type PredicateNode,
  UnsupportedWhereError,
} from "busabase-orm-core";
import { Column, Param, SQL } from "drizzle-orm";

/**
 * Walking drizzle's `where` into the shared predicate builders.
 *
 * This module knows one thing only: the shape of a drizzle chunk tree. What a
 * comparison *means*, whether it can be pushed to the server, and how NULL
 * behaves all live in `busabase-orm-core` — shared with every other driver, so
 * the subtle parts exist once rather than once per ORM.
 *
 * `where` arrives as a `SQL` chunk tree where columns and values survive as
 * real `Column`/`Param` objects and only the operator is a string. These shapes
 * were read off drizzle 0.45 by instrumenting `PgDialect`, not guessed:
 *
 *   eq        ["", COL, " = ",  PARAM, ""]
 *   isNull    ["", COL, " is null"]
 *   inArray   ["", COL, " in ", [PARAM, PARAM], ""]
 *   between   ["", COL, " between ", PARAM, " and ", PARAM, ""]
 *   and/or    ["(", [SQL, " and ", SQL, ...], ")"]
 *   not       ["not ", SQL, ""]
 *
 * `like`/`ilike` are the one irregular case: their value arrives as a bare
 * string, not a `Param`.
 *
 * Anything not translatable throws rather than being dropped — a dropped
 * conjunct silently widens the result, which is worse than a loud failure.
 */

/** Maps a drizzle column to the Busabase field slug that holds its value. */
export type ResolveFieldSlug = (column: Column) => string;

// --- chunk helpers ---------------------------------------------------------

/**
 * drizzle's `StringChunk` is not exported, so it is matched structurally: an
 * object with a `value` array of strings. That is stable across the 0.4x line
 * and cheap to re-verify (see `where.test.ts`).
 */
const asOperatorText = (chunk: unknown): string | null => {
  if (typeof chunk !== "object" || chunk === null) return null;
  const value = (chunk as { value?: unknown }).value;
  if (!Array.isArray(value) || !value.every((part) => typeof part === "string")) return null;
  return value.join("");
};

/** Unwraps a value node: `Param` carries `.value`; `like`/`ilike` pass a bare string. */
const asValue = (chunk: unknown): { ok: true; value: unknown } | { ok: false } => {
  if (chunk instanceof Param) return { ok: true, value: chunk.value };
  if (typeof chunk === "string" || typeof chunk === "number" || typeof chunk === "boolean") {
    return { ok: true, value: chunk };
  }
  return { ok: false };
};

/** drizzle's operator text → the shared builder's comparison vocabulary. */
const COMPARISONS: Record<string, ComparisonOperator> = {
  "=": "eq",
  "<>": "ne",
  ">": "gt",
  ">=": "gte",
  "<": "lt",
  "<=": "lte",
};

const KNOWN_OPERATORS = new Set([
  ...Object.keys(COMPARISONS),
  "like",
  "ilike",
  "in",
  "not in",
  "between",
  "is null",
  "is not null",
]);

/** Drops the empty `""` chunks drizzle pads binary expressions with. */
const meaningful = (chunks: unknown[]): unknown[] =>
  chunks.filter((chunk) => asOperatorText(chunk) !== "");

// --- the walk --------------------------------------------------------------

export const compileWhere = (
  where: SQL | undefined,
  resolveFieldSlug: ResolveFieldSlug,
): CompiledWhere => finalize(where ? walk(where, resolveFieldSlug) : undefined);

const walk = (sql: SQL, resolveFieldSlug: ResolveFieldSlug): PredicateNode => {
  const chunks = meaningful(sql.queryChunks);

  // `(` <inner> `)` — the parens and/or wrap their operand list in.
  if (
    chunks.length === 3 &&
    asOperatorText(chunks[0]) === "(" &&
    asOperatorText(chunks[2]) === ")"
  ) {
    const inner = chunks[1];
    if (Array.isArray(inner)) return walkBoolean(inner, resolveFieldSlug);
    if (inner instanceof SQL) return walk(inner, resolveFieldSlug);
  }

  // `not ` <operand>
  if (chunks.length === 2 && asOperatorText(chunks[0]) === "not ") {
    const operand = chunks[1];
    if (operand instanceof SQL) return negate(walk(operand, resolveFieldSlug));
  }

  // `[SQL, " and ", SQL, ...]` — and/or's operand list, one level in from the
  // parens above. Nested `SQL` children are what separates this from `between`,
  // which also carries an " and " chunk but holds only columns and params.
  if (chunks.some((chunk) => chunk instanceof SQL)) {
    return walkBoolean(chunks, resolveFieldSlug);
  }

  return walkComparison(chunks, sql, resolveFieldSlug);
};

/** `[SQL, " and ", SQL, " and ", SQL]` — a flat, same-operator operand list. */
const walkBoolean = (parts: unknown[], resolveFieldSlug: ResolveFieldSlug): PredicateNode => {
  const operands: PredicateNode[] = [];
  const operators = new Set<string>();
  for (const part of parts) {
    if (part instanceof SQL) {
      operands.push(walk(part, resolveFieldSlug));
      continue;
    }
    const text = asOperatorText(part)?.trim();
    if (text === "and" || text === "or") {
      operators.add(text);
      continue;
    }
    throw new UnsupportedWhereError(`unexpected node in a boolean expression (${describe(part)})`);
  }
  if (operators.size > 1) {
    throw new UnsupportedWhereError("mixed and/or at the same level");
  }
  return operators.has("or") ? any(operands) : all(operands);
};

const walkComparison = (
  chunks: unknown[],
  sql: SQL,
  resolveFieldSlug: ResolveFieldSlug,
): PredicateNode => {
  const column = chunks.find((chunk) => chunk instanceof Column) as Column | undefined;
  if (!column) {
    throw new UnsupportedWhereError(
      `no column found in expression (${describe(sql)}) — raw sql\`\` fragments are not translatable`,
    );
  }
  const slug = resolveFieldSlug(column);

  // Only a known operator counts. Matching any string chunk instead would let a
  // raw sql`` fragment's incidental text (e.g. ") = 'x'") pose as an operator
  // and be mistranslated.
  const operatorIndex = chunks.findIndex(
    (chunk, index) => index > 0 && KNOWN_OPERATORS.has(asOperatorText(chunk)?.trim() ?? ""),
  );
  const operator = operatorIndex === -1 ? null : asOperatorText(chunks[operatorIndex])?.trim();
  if (!operator) {
    throw new UnsupportedWhereError(
      `no recognisable operator in (${describe(sql)}) — raw sql\`\` fragments are not translatable`,
    );
  }

  if (operator === "is null") return isEmpty(slug);
  if (operator === "is not null") return isNotEmpty(slug);

  const rest = chunks.slice(operatorIndex + 1);

  if (operator === "in" || operator === "not in") {
    const list = rest[0];
    if (!Array.isArray(list)) throw new UnsupportedWhereError(`${operator} without a value list`);
    const values = list.map((entry) => {
      const parsed = asValue(entry);
      if (!parsed.ok) throw new UnsupportedWhereError(`${operator} list holds a non-literal`);
      return parsed.value;
    });
    return oneOf(slug, values, operator === "not in");
  }

  if (operator === "between") {
    const lower = asValue(rest[0]);
    const upper = asValue(rest[2]);
    if (!lower.ok || !upper.ok) throw new UnsupportedWhereError("between without two literals");
    return inRange(slug, lower.value, upper.value);
  }

  const parsed = asValue(rest[0]);
  if (!parsed.ok) {
    throw new UnsupportedWhereError(
      `right-hand side of \`${operator}\` is not a literal (${describe(rest[0])}) — column-to-column comparison is not supported`,
    );
  }

  if (operator === "like" || operator === "ilike") {
    if (typeof parsed.value !== "string") {
      throw new UnsupportedWhereError(`${operator} with a non-string pattern`);
    }
    return matchesPattern(slug, parsed.value, operator === "ilike");
  }

  const mapped = COMPARISONS[operator];
  if (!mapped) {
    throw new UnsupportedWhereError(`operator \`${operator}\` has no Busabase translation`);
  }
  return comparison(slug, mapped, parsed.value);
};

const describe = (node: unknown): string => {
  if (node instanceof SQL) return "sql expression";
  if (node instanceof Column) return `column ${node.name}`;
  const text = asOperatorText(node);
  if (text !== null) return JSON.stringify(text);
  return typeof node;
};
