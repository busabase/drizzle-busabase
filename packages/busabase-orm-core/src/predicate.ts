/**
 * The half of a Busabase ORM driver that is not about any particular ORM.
 *
 * Every driver faces the same three problems, and none of them are about the
 * query builder it happens to sit behind:
 *
 * 1. **What does this comparison mean when the value is missing?** SQL says
 *    UNKNOWN, JavaScript says `undefined > 1 === false`. Getting that wrong
 *    silently returns rows a database would not have returned.
 * 2. **Can the server decide this, or must we?** Busabase answers filters two
 *    different ways — view filters are a superset the client narrows, value
 *    filters are exact — and the answer determines whether `limit` may be
 *    pushed down at all.
 * 3. **How do we page a Base without lying about completeness?**
 *
 * So a driver's only real job is walking its own AST and calling the builders
 * below; everything downstream is shared. That is deliberate: the three-valued
 * logic and the push-down rules are the subtle parts, and they should exist
 * once rather than once per ORM.
 */

/** SQL three-valued logic. `null` is UNKNOWN, which is not the same as false. */
type Tri = boolean | null;

export type BusabaseFilterOperator =
  | "contains"
  | "equals"
  | "not_empty"
  | "is_empty"
  | "is_true"
  | "is_false";

export interface BusabaseFilter {
  fieldSlug: string;
  operator: BusabaseFilterOperator;
  value?: unknown;
}

/** A record's current field values — `record.headCommit.payload`, keyed by field slug. */
export type RecordPayload = Record<string, unknown>;

/**
 * An exact comparison the server can evaluate itself, via `records.list`'s
 * `valueFilters`. Unlike a view filter this is not a hint — the server compares
 * the stored value in its typed column, so the answer is authoritative.
 *
 * Only a *candidate* at this stage: whether the field actually has such a
 * column (number/date) is known to the Base, not to this module, so the caller
 * confirms it before sending.
 */
export interface ValueCandidate {
  fieldSlug: string;
  operator: "eq" | "ne" | "gt" | "gte" | "lt" | "lte";
  value: unknown;
}

export interface CompiledWhere {
  /** Superset hint for the server. Never sufficient on its own. */
  pushdown: BusabaseFilter[];
  /** Exact comparisons, pending the caller's field-type check. */
  valueCandidates: ValueCandidate[];
  /**
   * True when `valueCandidates` alone fully decide this where clause — i.e. it
   * is a pure AND of comparisons, with no operator that has to be evaluated
   * locally. That is the condition under which the caller may skip the local
   * predicate and push `limit` down, so it is deliberately conservative: an OR,
   * a NOT, a LIKE or an IS NULL anywhere makes it false.
   */
  fullyExact: boolean;
  /** Exact predicate. This is what decides membership in the result. */
  predicate: (payload: RecordPayload) => boolean;
}

export class UnsupportedWhereError extends Error {
  constructor(detail: string) {
    super(
      `drizzle-busabase cannot evaluate this condition: ${detail}. ` +
        `It is rejected rather than ignored, because ignoring it would silently return rows that do not match.`,
    );
    this.name = "UnsupportedWhereError";
  }
}

const isNullish = (value: unknown): boolean => value === null || value === undefined;

/**
 * Ordering comparison. Returns null (UNKNOWN) when either side is null or the
 * pair is not meaningfully ordered, mirroring SQL rather than JS coercion —
 * `undefined > 1` being `false` in JS is exactly the kind of silent wrong
 * answer this driver must not produce.
 */
const compare = (left: unknown, right: unknown): number | null => {
  if (isNullish(left) || isNullish(right)) return null;
  if (typeof left === "number" && typeof right === "number") {
    return left === right ? 0 : left < right ? -1 : 1;
  }
  if (typeof left === "boolean" && typeof right === "boolean") {
    return left === right ? 0 : left ? 1 : -1;
  }
  const leftText = toComparableText(left);
  const rightText = toComparableText(right);
  if (leftText === null || rightText === null) return null;
  // Numeric strings compare numerically — a Busabase number field's payload can
  // arrive as either, depending on how the value was written.
  const leftNumber = Number(leftText);
  const rightNumber = Number(rightText);
  if (
    leftText !== "" &&
    rightText !== "" &&
    !Number.isNaN(leftNumber) &&
    !Number.isNaN(rightNumber)
  ) {
    return leftNumber === rightNumber ? 0 : leftNumber < rightNumber ? -1 : 1;
  }
  return leftText === rightText ? 0 : leftText < rightText ? -1 : 1;
};

const toComparableText = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  return null;
};

const equals = (left: unknown, right: unknown): Tri => {
  if (isNullish(left) || isNullish(right)) return null;
  if (typeof left === "boolean" || typeof right === "boolean") {
    return toBoolean(left) === toBoolean(right);
  }
  const order = compare(left, right);
  return order === null ? null : order === 0;
};

const toBoolean = (value: unknown): boolean | null => {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  if (typeof value === "number") return value !== 0;
  return null;
};

/** Translates a SQL LIKE pattern into a regex, honouring `%`, `_` and backslash escapes. */
const likeToRegExp = (pattern: string, caseInsensitive: boolean): RegExp => {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "\\" && index + 1 < pattern.length) {
      index += 1;
      source += escapeRegExp(pattern[index] as string);
      continue;
    }
    if (character === "%") {
      source += "[\\s\\S]*";
      continue;
    }
    if (character === "_") {
      source += "[\\s\\S]";
      continue;
    }
    source += escapeRegExp(character as string);
  }
  return new RegExp(`^${source}$`, caseInsensitive ? "i" : "");
};

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const triAnd = (values: Tri[]): Tri => {
  if (values.some((value) => value === false)) return false;
  return values.some((value) => value === null) ? null : true;
};

const triOr = (values: Tri[]): Tri => {
  if (values.some((value) => value === true)) return true;
  return values.some((value) => value === null) ? null : false;
};

const triNot = (value: Tri): Tri => (value === null ? null : !value);

const order = (actual: unknown, expected: unknown, accept: (order: number) => boolean): Tri => {
  const result = compare(actual, expected);
  return result === null ? null : accept(result);
};

/** Busabase models booleans as dedicated `is_true`/`is_false` operators, not `equals`. */
const booleanPushdown = (slug: string, value: unknown): BusabaseFilter[] | null => {
  if (value === true) return [{ fieldSlug: slug, operator: "is_true" }];
  if (value === false) return [{ fieldSlug: slug, operator: "is_false" }];
  return null;
};

const containsPushdown = (slug: string, pattern: string): BusabaseFilter[] => {
  const unanchored = pattern.startsWith("%") && pattern.endsWith("%") && pattern.length > 2;
  const middle = pattern.slice(1, -1);
  if (!unanchored || /[%_\\]/.test(middle)) return [];
  return [{ fieldSlug: slug, operator: "contains", value: middle }];
};

// --- the builder ------------------------------------------------------------
//
// A driver walks its own AST and calls these. Everything about *when* a
// condition can be pushed to the server, and *how* it evaluates locally, lives
// here rather than in each driver.

/** Comparison operators that map 1:1 onto Busabase's exact `valueFilters`. */
export type ComparisonOperator = "eq" | "ne" | "gt" | "gte" | "lt" | "lte";

export interface PredicateNode {
  /** Local evaluation, in SQL's three-valued logic. */
  evaluate: (payload: RecordPayload) => Tri;
  /** View filters: a superset hint that may only ever shrink the candidate set. */
  pushdown: BusabaseFilter[];
  /** Exact comparisons, pending the caller's field-type check. */
  valueCandidates: ValueCandidate[];
  /** Whether `valueCandidates` alone decide this node. */
  fullyExact: boolean;
}

const node = (
  evaluate: PredicateNode["evaluate"],
  parts: Partial<Omit<PredicateNode, "evaluate">> = {},
): PredicateNode => ({
  evaluate,
  pushdown: parts.pushdown ?? [],
  valueCandidates: parts.valueCandidates ?? [],
  fullyExact: parts.fullyExact ?? false,
});

export const alwaysTrue: PredicateNode = node(() => true, { fullyExact: true });

/**
 * `field <op> value`. Every one of these maps onto an exact value filter, so
 * whether it can actually be pushed depends only on the field's type — which is
 * the caller's check, since it needs the Base's definitions.
 */
export const comparison = (
  fieldSlug: string,
  operator: ComparisonOperator,
  value: unknown,
): PredicateNode => {
  const read = (payload: RecordPayload) => payload[fieldSlug];
  const candidates = [{ fieldSlug, operator, value }];
  const evaluate: PredicateNode["evaluate"] =
    operator === "eq"
      ? (payload) => equals(read(payload), value)
      : operator === "ne"
        ? (payload) => triNot(equals(read(payload), value))
        : operator === "gt"
          ? (payload) => order(read(payload), value, (n) => n > 0)
          : operator === "gte"
            ? (payload) => order(read(payload), value, (n) => n >= 0)
            : operator === "lt"
              ? (payload) => order(read(payload), value, (n) => n < 0)
              : (payload) => order(read(payload), value, (n) => n <= 0);

  // Equality is the one comparison Busabase can ALSO express as a view filter,
  // so it gets both: the exact candidate, and a superset hint that still helps
  // when the field turns out to have no exact value column.
  const pushdown =
    operator === "eq"
      ? (booleanPushdown(fieldSlug, value) ?? [{ fieldSlug, operator: "equals" as const, value }])
      : [];
  return node(evaluate, { pushdown, valueCandidates: candidates, fullyExact: true });
};

/** SQL `LIKE` / `ILIKE`. No exact form — Busabase compares whole values. */
export const matchesPattern = (
  fieldSlug: string,
  pattern: string,
  caseInsensitive: boolean,
): PredicateNode => {
  const regexp = likeToRegExp(pattern, caseInsensitive);
  return node(
    (payload) => {
      const actual = payload[fieldSlug];
      if (isNullish(actual)) return null;
      const text = toComparableText(actual);
      return text === null ? null : regexp.test(text);
    },
    { pushdown: containsPushdown(fieldSlug, pattern) },
  );
};

/**
 * `IS NULL` / `IS NOT NULL`. Busabase's is_empty/not_empty also treat "" as
 * empty, which is what the client's own matcher does — so the local evaluation
 * mirrors it rather than the stricter JS notion of null.
 */
export const isEmpty = (fieldSlug: string): PredicateNode =>
  node((payload) => isNullish(payload[fieldSlug]) || payload[fieldSlug] === "", {
    pushdown: [{ fieldSlug, operator: "is_empty" }],
  });

export const isNotEmpty = (fieldSlug: string): PredicateNode =>
  node((payload) => !isNullish(payload[fieldSlug]) && payload[fieldSlug] !== "", {
    pushdown: [{ fieldSlug, operator: "not_empty" }],
  });

/** `IN` / `NOT IN`. */
export const oneOf = (fieldSlug: string, values: unknown[], negated: boolean): PredicateNode => {
  // A single-element IN is just equality, and equality is exactly pushable.
  // A longer list is not: the server ANDs value filters, and `x = 1 AND x = 2`
  // matches nothing.
  const single = !negated && values.length === 1;
  return node(
    (payload) => {
      const actual = payload[fieldSlug];
      if (isNullish(actual)) return null;
      const matches = triOr(values.map((value) => equals(actual, value)));
      return negated ? triNot(matches) : matches;
    },
    {
      pushdown: single ? [{ fieldSlug, operator: "equals", value: values[0] }] : [],
      valueCandidates: single ? [{ fieldSlug, operator: "eq", value: values[0] }] : [],
      fullyExact: single,
    },
  );
};

/** `BETWEEN` — inclusive both ends, which is exactly the gte/lte pair. */
export const inRange = (fieldSlug: string, lower: unknown, upper: unknown): PredicateNode =>
  node(
    (payload) => {
      const actual = payload[fieldSlug];
      const low = compare(actual, lower);
      const high = compare(actual, upper);
      if (low === null || high === null) return null;
      return low >= 0 && high <= 0;
    },
    {
      valueCandidates: [
        { fieldSlug, operator: "gte", value: lower },
        { fieldSlug, operator: "lte", value: upper },
      ],
      fullyExact: true,
    },
  );

/**
 * AND. Every conjunct must hold, so each one's push-down is independently a
 * valid narrowing and they accumulate.
 */
export const all = (nodes: PredicateNode[]): PredicateNode =>
  node((payload) => triAnd(nodes.map((entry) => entry.evaluate(payload))), {
    pushdown: nodes.flatMap((entry) => entry.pushdown),
    valueCandidates: nodes.flatMap((entry) => entry.valueCandidates),
    fullyExact: nodes.every((entry) => entry.fullyExact),
  });

/**
 * OR. Nothing may be pushed: a single branch's filter would exclude rows the
 * other branch matches, and the server ANDs value filters for the same reason.
 */
export const any = (nodes: PredicateNode[]): PredicateNode =>
  node((payload) => triOr(nodes.map((entry) => entry.evaluate(payload))));

/**
 * NOT. Also unpushable — and note this is not the same as `ne`, because
 * NOT UNKNOWN is UNKNOWN rather than true.
 */
export const negate = (inner: PredicateNode): PredicateNode =>
  node((payload) => triNot(inner.evaluate(payload)));

/** Seals a node into the result the executor consumes. */
export const finalize = (root: PredicateNode | undefined): CompiledWhere => {
  const resolved = root ?? alwaysTrue;
  return {
    pushdown: resolved.pushdown,
    valueCandidates: resolved.valueCandidates,
    fullyExact: resolved.fullyExact,
    // UNKNOWN does not satisfy a WHERE clause, same as Postgres.
    predicate: (payload) => resolved.evaluate(payload) === true,
  };
};
