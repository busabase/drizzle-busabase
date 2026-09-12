import type { ResolvedBase } from "./base-resolver";
import type { ValueCandidate, ValueNode } from "./predicate";

/**
 * Turning a where clause's exact tree into what `records.list` accepts.
 *
 * Two transformations, in order, and each one has a failure mode that is
 * silent if it is done in the wrong direction:
 *
 * 1. **Prune** — drop what this Base cannot compare exactly. Legal inside an
 *    AND (fewer conjuncts = more rows, and the local predicate still narrows),
 *    ILLEGAL inside an OR (fewer disjuncts = fewer rows, and rows the caller
 *    asked for vanish). So an OR with any unprunable branch is dropped whole
 *    rather than trimmed.
 * 2. **CNF** — the wire format is an AND of ORs, so a nested tree has to be
 *    distributed into that shape. Distribution can blow up exponentially, so
 *    it is bounded, and going over budget degrades to "don't push this part"
 *    rather than to a wrong answer.
 *
 * Both report whether they were lossless. That flag is what decides whether the
 * caller may skip the local predicate and push `limit` down — dropping even one
 * condition turns the server's answer back into a superset, and a superset
 * cannot carry a limit without silently shortening the page.
 */

export type WireLeaf = {
  fieldSlug: string;
  operator: ValueCandidate["operator"];
  value: number | string | boolean;
};

/** One CNF conjunct on the wire: a comparison, or a disjunction of them. */
export type WireValueFilter = WireLeaf | { any: WireLeaf[] };

/**
 * Field families and operators the server compares exactly, mirroring
 * `buildExactValueFilter`. Kept deliberately in step with it: the server
 * REFUSES anything outside these with a 400, so sending an unsupported leaf
 * fails the whole request rather than skipping that one condition.
 */
const NUMBER_VALUE_TYPES = new Set(["number", "auto_number"]);
const DATE_VALUE_TYPES = new Set(["date", "created_time", "updated_time"]);
const BOOLEAN_VALUE_TYPES = new Set(["checkbox"]);
const TEXT_VALUE_TYPES = new Set([
  "text",
  "longtext",
  "markdown",
  "html",
  "url",
  "embed",
  "email",
  "phone",
  "code",
  "select",
]);

/**
 * Text is exact for equality only. Ordering is refused server-side because
 * Postgres orders text by database collation while this driver orders it by
 * JavaScript string comparison, and the two disagree — so an ordering leaf on
 * text must stay local rather than be sent and 400.
 */
const TEXT_EXACT_OPERATORS = new Set<ValueCandidate["operator"]>(["eq", "ne"]);

/** Mirrors VALUE_TEXT_INDEX_LIMIT: at or over it, text equality is not provable. */
const VALUE_TEXT_INDEX_LIMIT = 8_000;

/**
 * How much CNF is worth sending. This is a URL-length budget, not a
 * complexity one: `records.list` is a GET, so every literal rides in the query
 * string, and a long enough one is a 414 rather than a slow query. Over budget
 * the clause is dropped and the local predicate handles it — correct, just a
 * scan.
 */
const MAX_TOTAL_LITERALS = 64;

const encodeLeaf = (
  base: ResolvedBase,
  leaf: ValueCandidate,
): { ok: true; leaf: WireLeaf } | { ok: false } => {
  const fieldType = base.fields.get(leaf.fieldSlug)?.type;
  if (!fieldType) return { ok: false };
  const wire = (value: number | string | boolean) => ({
    ok: true as const,
    leaf: { fieldSlug: leaf.fieldSlug, operator: leaf.operator, value },
  });

  if (NUMBER_VALUE_TYPES.has(fieldType)) {
    const numeric = typeof leaf.value === "number" ? leaf.value : Number(leaf.value);
    return Number.isFinite(numeric) ? wire(numeric) : { ok: false };
  }
  if (DATE_VALUE_TYPES.has(fieldType)) {
    // A driver may hand over a `Date` (timestamp column) or a string; the
    // server takes ISO 8601 either way.
    if (typeof leaf.value === "boolean") return { ok: false };
    const date = leaf.value instanceof Date ? leaf.value : new Date(leaf.value as string | number);
    return Number.isNaN(date.getTime()) ? { ok: false } : wire(date.toISOString());
  }
  if (BOOLEAN_VALUE_TYPES.has(fieldType)) {
    if (typeof leaf.value !== "boolean") return { ok: false };
    return TEXT_EXACT_OPERATORS.has(leaf.operator) ? wire(leaf.value) : { ok: false };
  }
  if (TEXT_VALUE_TYPES.has(fieldType)) {
    if (typeof leaf.value !== "string") return { ok: false };
    if (!TEXT_EXACT_OPERATORS.has(leaf.operator)) return { ok: false };
    if (leaf.value.length >= VALUE_TEXT_INDEX_LIMIT) return { ok: false };
    return wire(leaf.value);
  }
  return { ok: false };
};

/** A pruned tree: same shape, minus everything this Base cannot compare. */
type PrunedNode = { kind: "leaf"; leaf: WireLeaf } | { kind: "and" | "or"; nodes: PrunedNode[] };

interface Pruned {
  /** `null` = no constraint survived here, i.e. TRUE. */
  node: PrunedNode | null;
  /** Whether the pruned node still means exactly what the original did. */
  complete: boolean;
}

const prune = (node: ValueNode, base: ResolvedBase): Pruned => {
  if (node.kind === "opaque") return { node: null, complete: false };
  if (node.kind === "leaf") {
    const encoded = encodeLeaf(base, node);
    return encoded.ok
      ? { node: { kind: "leaf", leaf: encoded.leaf }, complete: true }
      : { node: null, complete: false };
  }

  const children = node.nodes.map((child) => prune(child, base));

  if (node.kind === "and") {
    // An AND of nothing is TRUE, which is exactly "no constraint" — so an empty
    // AND prunes to null and stays complete. That is the `alwaysTrue` case.
    const kept = children.filter((child) => child.node !== null).map((child) => child.node!);
    const complete = children.every((child) => child.complete);
    if (kept.length === 0) return { node: null, complete };
    return { node: kept.length === 1 ? kept[0]! : { kind: "and", nodes: kept }, complete };
  }

  // An OR of nothing is FALSE, not TRUE. There is no wire form for "match
  // nothing" (`any: []` is rejected by the schema, and rightly — it would read
  // as a mistake), so it degrades to a local decision. The predicate returns
  // false for every row, which is correct, just not free.
  if (children.length === 0) return { node: null, complete: false };
  // One unprunable branch poisons the whole disjunction: keeping the rest would
  // return a SUBSET, which is the one direction that loses rows.
  if (children.some((child) => child.node === null)) return { node: null, complete: false };
  return {
    node:
      children.length === 1
        ? children[0]!.node!
        : { kind: "or", nodes: children.map((child) => child.node!) },
    complete: children.every((child) => child.complete),
  };
};

type Clause = WireLeaf[];

interface CnfResult {
  clauses: Clause[];
  complete: boolean;
}

const toCnf = (node: PrunedNode, budget: { left: number }): CnfResult => {
  if (node.kind === "leaf") {
    if (budget.left < 1) return { clauses: [], complete: false };
    budget.left -= 1;
    return { clauses: [[node.leaf]], complete: true };
  }

  if (node.kind === "and") {
    // Conjuncts concatenate, and one that overflows can simply be left out:
    // fewer conjuncts is a wider row set, which the local predicate re-narrows.
    const clauses: Clause[] = [];
    let complete = true;
    for (const child of node.nodes) {
      const result = toCnf(child, budget);
      if (!result.complete) complete = false;
      clauses.push(...result.clauses);
    }
    return { clauses, complete };
  }

  // Disjuncts must be DISTRIBUTED: (a ∧ b) ∨ c becomes (a ∨ c) ∧ (b ∨ c). The
  // product is where the blow-up lives, so it is measured before it is built.
  // A partial disjunction is not an option — see prune's OR case — so anything
  // short of the whole thing returns nothing.
  const parts: CnfResult[] = [];
  for (const child of node.nodes) {
    const result = toCnf(child, budget);
    if (!result.complete) return { clauses: [], complete: false };
    parts.push(result);
  }
  let distributed: Clause[] = [[]];
  for (const part of parts) {
    const next: Clause[] = [];
    for (const existing of distributed) {
      for (const clause of part.clauses) {
        const merged = [...existing, ...clause];
        if (merged.length > MAX_TOTAL_LITERALS) return { clauses: [], complete: false };
        next.push(merged);
      }
    }
    if (next.length * (next[0]?.length ?? 0) > MAX_TOTAL_LITERALS) {
      return { clauses: [], complete: false };
    }
    distributed = next;
  }
  return { clauses: distributed, complete: true };
};

export interface CompiledValueFilters {
  filters: WireValueFilter[];
  /**
   * Whether `filters` still mean exactly what the tree meant. False if anything
   * was pruned or dropped — in which case the server's answer is a superset and
   * the caller must keep deciding locally.
   */
  exact: boolean;
}

/**
 * Tree → wire. Everything that can be decided server-side is, and the caller is
 * told plainly whether that covered the whole clause.
 */
export const compileValueFilters = (tree: ValueNode, base: ResolvedBase): CompiledValueFilters => {
  const pruned = prune(tree, base);
  if (pruned.node === null) return { filters: [], exact: pruned.complete };
  const budget = { left: MAX_TOTAL_LITERALS };
  const cnf = toCnf(pruned.node, budget);
  return {
    filters: cnf.clauses.map((clause) => (clause.length === 1 ? clause[0]! : { any: clause })),
    exact: pruned.complete && cnf.complete,
  };
};
