import type { BusabaseClient } from "busabase-sdk";
import type { BaseResolver, ResolvedBase } from "./base-resolver";
import { isServerSortable } from "./base-resolver";
import type { CompiledWhere, RecordPayload } from "./predicate";
import { compileValueFilters } from "./value-filters";

/**
 * Running a translated query against Busabase.
 *
 * The shape of every read is forced by one line in the REST contract: server-side
 * filters are documented as a **superset the client still narrows**. That single
 * fact rules out the obvious implementation. If the server may return extra rows,
 * then `LIMIT n` cannot be pushed down alongside a filter — the server would count
 * its extra rows against the limit and the driver would hand back a short page,
 * which reads as data loss rather than as a bug.
 *
 * So there are two paths, and which one runs is decided by whether the query's
 * meaning survives push-down:
 *
 * - **Exact path** — no local-only predicate and no local-only sort. Everything
 *   the query means is expressible server-side, so `limit` rides along and one
 *   page is one round trip.
 * - **Scan path** — anything else. The driver pages through the candidate set
 *   (narrowed by whatever pushdown was safe), applies the exact predicate and
 *   sort locally, then slices. Correct, and honest about its cost.
 *
 * The scan path is bounded by `maxScannedRecords` and **fails loudly** when it
 * would exceed it. Silently truncating would produce a plausible, wrong answer.
 */

export interface RecordRow {
  id: string;
  createdAt: string;
  updatedAt: string;
  payload: RecordPayload;
}

export class ScanLimitExceededError extends Error {
  constructor(baseSlug: string, limit: number) {
    super(
      `busabase: scanned more than ${limit} records of "${baseSlug}" while resolving a query ` +
        `that Busabase cannot filter or sort server-side, and stopped rather than return a partial result. ` +
        `Narrow the query, raise \`maxScannedRecords\`, or add the missing operator to the Busabase API.`,
    );
    this.name = "ScanLimitExceededError";
  }
}

/**
 * What a driver hands the engine: the query, already translated out of whatever
 * AST it came from. Everything here is plain data — no ORM types survive this
 * boundary, which is what lets one engine serve several drivers.
 */
export interface SelectPlan {
  baseSlug: string;
  /** Built by the driver via the `predicate` builders. */
  where?: CompiledWhere;
  /** Sort keys in priority order, already resolved to field slugs. */
  orderBy?: SortKey[];
  limit?: number;
  offset?: number;
}

export interface SortKey {
  fieldSlug: string;
  direction: "asc" | "desc";
}

export interface ExecuteContext {
  client: BusabaseClient;
  resolver: BaseResolver;
  maxScannedRecords: number;
  pageSize: number;
}

/** System columns a mapped table may expose that are not Base fields. */
const SYSTEM_COLUMNS: Record<string, (row: RecordRow) => unknown> = {
  id: (row) => row.id,
  createdAt: (row) => row.createdAt,
  updatedAt: (row) => row.updatedAt,
};

/**
 * Reads one column off a record. A Base field of the same name always wins, so a
 * Base that genuinely has an `id` field behaves as the user wrote it; the system
 * fallback only fills names the Base does not define.
 */
export const readColumn = (base: ResolvedBase, row: RecordRow, name: string): unknown => {
  if (base.fields.has(name)) return row.payload[name] ?? null;
  const system = SYSTEM_COLUMNS[name];
  return system ? system(row) : (row.payload[name] ?? null);
};

const toRecordRow = (record: {
  id: string;
  createdAt: string;
  updatedAt: string;
  headCommit: { payload: Record<string, unknown> };
}): RecordRow => ({
  id: record.id,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  // A record's current values live under headCommit.payload, keyed by field slug.
  payload: record.headCommit.payload,
});

const compareValues = (left: unknown, right: unknown): number => {
  // Nulls sort last on asc, matching Postgres's default NULLS LAST.
  const leftNull = left === null || left === undefined;
  const rightNull = right === null || right === undefined;
  if (leftNull && rightNull) return 0;
  if (leftNull) return 1;
  if (rightNull) return -1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  const leftText = String(left);
  const rightText = String(right);
  const leftNumber = Number(leftText);
  const rightNumber = Number(rightText);
  if (
    leftText !== "" &&
    rightText !== "" &&
    !Number.isNaN(leftNumber) &&
    !Number.isNaN(rightNumber)
  ) {
    return leftNumber - rightNumber;
  }
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
};

/**
 * `count(*)` without transferring the rows.
 *
 * Returns `null` when the where clause is NOT fully expressible server-side —
 * the caller then falls back to scanning and counting locally. That refusal is
 * the whole safety property: `records.count` answers exactly, so handing it a
 * where clause it only partly understands would produce a confident, wrong
 * number, and a count is the one result nobody double-checks.
 *
 * Only the value filters are sent, never the view `filters` alongside them.
 * They would be redundant — an exact value tree already describes the row set —
 * and a filter whose contract is "superset" has no business narrowing a number
 * the caller is going to trust.
 */
export const executeCount = async (
  plan: { baseSlug: string; where?: CompiledWhere },
  context: ExecuteContext,
): Promise<number | null> => {
  const base = await context.resolver.resolve(plan.baseSlug);
  const tree = plan.where?.valueTree ?? { kind: "and" as const, nodes: [] };
  const { filters, exact } = compileValueFilters(tree, base);
  if (!exact) return null;
  // A server that ignores `valueFilters` would answer the UNFILTERED count with
  // a 200 — a confident wrong number, and a count is the one result nobody
  // re-checks. Fall back to scanning instead.
  if (filters.length && !(await supportsExactFilters(context, base.id))) return null;
  const counted = await context.client.records.count({
    baseId: base.id,
    ...(filters.length ? { valueFilters: filters } : {}),
  });
  return counted.total;
};

/**
 * Whether this server applies `valueFilters` at all, cached per client.
 *
 * It has to be asked, because a server that does NOT support them does not say
 * so — it strips the unknown parameter and answers as if no filter were given.
 * Verified against the real `busabase@0.42.0`: `records.count` with a
 * `valueFilters` entry returns HTTP 200 and the UNFILTERED total.
 *
 * That is the worst possible failure for this driver. `compileValueFilters`
 * reporting `exact` is what lets `executeSelect` skip the local predicate and
 * push `limit` down — so against an old server it would hand back every record
 * in the Base as though each one matched. Measured: `where(gt(score, 35))` over
 * five records returned all five, with no error.
 *
 * The probe is a `valueFilters` entry naming a field that cannot exist. A
 * server that understands the parameter REFUSES it (400, "this Base has no
 * field …"); a server that does not, ignores it and answers 200. So resolving
 * means unsupported and rejecting means supported — including for a network
 * error, which resolves nothing and would fail the real query anyway.
 */
const IMPOSSIBLE_FIELD_SLUG = "__busabase_orm_capability_probe__";
const exactFilterSupport = new WeakMap<object, Promise<boolean>>();

const supportsExactFilters = (context: ExecuteContext, baseId: string): Promise<boolean> => {
  const client = context.client as unknown as object;
  const cached = exactFilterSupport.get(client);
  if (cached) return cached;
  // Wrapped so a client that cannot even attempt the probe throws INTO the
  // promise rather than out of the read path.
  const probe = (async () =>
    context.client.records.count({
      baseId,
      valueFilters: [{ fieldSlug: IMPOSSIBLE_FIELD_SLUG, operator: "eq", value: 1 }],
    }))().then(
    // Answered without complaint: the parameter was stripped, so it is not
    // applied. Refused: the server understood it well enough to say no.
    () => false,
    () => true,
  );
  exactFilterSupport.set(client, probe);
  return probe;
};

/** Field families with a numeric column the server can aggregate over. */
const AGGREGATABLE_TYPES = new Set(["number", "auto_number"]);

/**
 * Field families `records.groupBy` can bucket with SQL semantics.
 *
 * Text is absent here for the same reason it is absent server-side:
 * `value_text` is truncated at a projection limit, so two long values can land
 * in one bucket. Everything listed groups on a column that holds the value.
 */
const SQL_GROUPABLE_TYPES = new Set([
  "select",
  "checkbox",
  "number",
  "auto_number",
  "date",
  "created_time",
  "updated_time",
]);

export interface AggregateRequest {
  fn: "sum" | "avg" | "min" | "max" | "count";
  /** `null` only for `count`, which counts records rather than values. */
  fieldSlug: string | null;
  distinct: boolean;
}

/**
 * Numeric aggregates without transferring the rows, via `records.groupBy` with
 * no group field — one bucket over the whole filtered set.
 *
 * Returns `null` whenever the answer would not be exact, and the caller falls
 * back to scanning. That covers four cases, each a real one:
 *
 * - the where clause is not fully expressible server-side;
 * - a `DISTINCT` aggregate, which the endpoint does not offer;
 * - an aggregate over a field with no numeric column;
 * - `count` over a field, whose "count the PRESENT values" meaning the server
 *   does provide — that one IS sent; it is `countDistinct` that is not.
 *
 * Grouped aggregates come here too, but ONLY with `bucketing: "sql"`. The
 * endpoint's DEFAULT buckets are the grid's — an unset checkbox folds in with
 * `false`, an empty string folds into the null bucket — and a fast path built
 * on those would answer differently from the scan path, which is worse than no
 * fast path. SQL bucketing gives a missing value its own group, which is what
 * `groupRows` does locally, so the two agree.
 */
export interface AggregatedGroup {
  /** The stored value this group is keyed by; `null` is its own bucket. */
  value: string | number | boolean | null;
  /** Records in the group, whether or not they hold the aggregated field. */
  count: number;
  values: Record<string, number | null>;
}

export const executeAggregate = async (
  plan: {
    baseSlug: string;
    where?: CompiledWhere;
    aggregates: AggregateRequest[];
    /** Group by one field, with SQL bucketing. Omitted = one bucket over all. */
    groupBy?: string;
  },
  context: ExecuteContext,
): Promise<AggregatedGroup[] | null> => {
  const base = await context.resolver.resolve(plan.baseSlug);
  const tree = plan.where?.valueTree ?? { kind: "and" as const, nodes: [] };
  const { filters, exact } = compileValueFilters(tree, base);
  if (!exact) return null;
  // Same reason as `executeCount`, and one more: a server that does not know
  // `aggregates`/`bucketing` strips those too, so it answers a bare count over
  // EVERY record and no aggregates at all — which would read back as a total.
  if (!(await supportsExactFilters(context, base.id))) return null;

  // Typed with the narrow union rather than `string`, so a wrong function name
  // is a compile error here instead of a 400 at runtime. The `as never` this
  // call used to carry was hiding exactly that looseness.
  const sendable: { fn: AggregateRequest["fn"]; fieldSlug: string }[] = [];
  for (const aggregate of plan.aggregates) {
    if (aggregate.distinct) return null;
    // `count()` with no field is the group's own record count, already in the
    // response — nothing to request.
    if (aggregate.fieldSlug === null) continue;
    if (!AGGREGATABLE_TYPES.has(base.fields.get(aggregate.fieldSlug)?.type ?? "")) return null;
    sendable.push({ fn: aggregate.fn, fieldSlug: aggregate.fieldSlug });
  }

  // A group field the server cannot bucket with SQL semantics falls back to
  // scanning rather than sending a request it would refuse with a 400.
  if (plan.groupBy && !SQL_GROUPABLE_TYPES.has(base.fields.get(plan.groupBy)?.type ?? "")) {
    return null;
  }

  const response = await context.client.records.groupBy({
    baseId: base.id,
    ...(plan.groupBy ? { fieldSlug: plan.groupBy, bucketing: "sql" as const } : {}),
    ...(sendable.length ? { aggregates: sendable } : {}),
    ...(filters.length ? { valueFilters: filters } : {}),
  });

  // An UNGROUPED query over no matching records still has an answer: one bucket
  // holding a count of zero and a null for every value, not "no groups". A
  // GROUPED one genuinely has no groups, which is what SQL returns too.
  if (response.groups.length === 0 && !plan.groupBy) {
    return [
      {
        value: null,
        count: 0,
        values: Object.fromEntries(
          sendable.map((entry) => [`${entry.fn}:${entry.fieldSlug}`, null]),
        ),
      },
    ];
  }
  return response.groups.map((group) => ({
    value: group.value as string | number | boolean | null,
    count: group.count,
    values: (group.aggregates ?? {}) as Record<string, number | null>,
  }));
};

export const executeSelect = async (
  plan: SelectPlan,
  context: ExecuteContext,
): Promise<{ base: ResolvedBase; rows: RecordRow[] }> => {
  const base = await context.resolver.resolve(plan.baseSlug);
  const { pushdown, valueTree, predicate } = plan.where ?? {
    pushdown: [],
    valueTree: { kind: "and" as const, nodes: [] },
    predicate: () => true,
  };
  const sortKeys = plan.orderBy ?? [];

  // A sort is exact server-side only when it is a single column the contract
  // allows sorting on. `sort` in the REST input is one key, not a list.
  // Carries `fieldType` for the same reason the filters below do: the server
  // picks its sort column with `sortColumnFor(parsed.sort.fieldType)`, so an
  // unstamped sort key resolves to no column and the sort silently stays
  // createdAt-keyed.
  const sortKey = sortKeys.length === 1 ? sortKeys[0] : undefined;
  const serverSort =
    sortKey && isServerSortable(base, sortKey.fieldSlug)
      ? { ...sortKey, fieldType: base.fields.get(sortKey.fieldSlug)?.type }
      : undefined;
  const sortIsLocal = sortKeys.length > 0 && !serverSort;

  // `valueFilters` are the exact half of the story: the tree is pruned to what
  // this Base can compare exactly, then distributed into the AND-of-ORs the
  // wire format takes. `exact` says whether that survived intact — a single
  // condition left behind means the server's answer is a superset again, and a
  // superset cannot carry a limit.
  const { filters: valueFilters, exact: compiledExact } = compileValueFilters(valueTree, base);
  // Trusting `exact` is what skips the local predicate and pushes `limit`, so it
  // may only be trusted once the server is known to APPLY these filters. An
  // older one strips them and answers 200 with every record, which would come
  // back as "they all matched".
  const valueFiltersAreExact =
    compiledExact && (valueFilters.length === 0 || (await supportsExactFilters(context, base.id)));
  const whereIsExact = plan.where === undefined || valueFiltersAreExact;
  const predicateIsLocal = !whereIsExact;
  const canPushLimit = !predicateIsLocal && !sortIsLocal;
  // Skipping the local predicate is the point of exactness — with `limit` pushed
  // down, re-filtering locally could only ever shorten a page the server already
  // sized correctly.
  const decide = whereIsExact ? () => true : predicate;

  // Stamp each pushdown filter with the field's REAL type, read from the Base.
  // This is not decoration: `buildPushableRecordFilter` on the server starts with
  // `const type = filter.fieldType ?? ""`, and an empty type matches none of its
  // branches — so a filter sent without one is silently DROPPED and the server
  // returns the whole Base. Results stay correct either way (the local predicate
  // decides), but every push-down is wasted, which is invisible without looking
  // at how many records actually came back.
  const filters = pushdown.map((filter) => {
    const type = base.fields.get(filter.fieldSlug)?.type;
    return type ? { ...filter, fieldType: type } : filter;
  });

  const offset = plan.offset ?? 0;
  const wanted = plan.limit === undefined ? undefined : plan.limit + offset;

  const collected: RecordRow[] = [];
  let cursor: string | undefined;
  let scanned = 0;

  do {
    const page = await context.client.records.list({
      baseId: base.id,
      limit: Math.min(
        context.pageSize,
        canPushLimit && wanted ? wanted - collected.length : context.pageSize,
      ),
      ...(cursor ? { cursor } : {}),
      ...(filters.length ? { filters } : {}),
      ...(valueFilters.length ? { valueFilters } : {}),
      ...(serverSort ? { sort: serverSort } : {}),
    });
    scanned += page.records.length;
    for (const record of page.records) {
      const row = toRecordRow(record);
      if (decide(row.payload)) collected.push(row);
    }
    cursor = page.nextCursor ?? undefined;
    if (canPushLimit && wanted !== undefined && collected.length >= wanted) break;
    // The budget bounds rows read and THROWN AWAY, not rows read. When the
    // server decided the whole clause every row it sent is a result, so paging
    // through a large answer is the caller asking for a large answer — that is
    // what `limit` is for, and tripping here would reject a correct query.
    if (!whereIsExact && scanned > context.maxScannedRecords) {
      throw new ScanLimitExceededError(base.slug, context.maxScannedRecords);
    }
  } while (cursor);

  if (sortIsLocal) {
    collected.sort((left, right) => {
      for (const key of sortKeys) {
        const order = compareValues(
          readColumn(base, left, key.fieldSlug),
          readColumn(base, right, key.fieldSlug),
        );
        if (order !== 0) return key.direction === "desc" ? -order : order;
      }
      return 0;
    });
  }

  const sliced =
    plan.limit === undefined
      ? collected.slice(offset)
      : collected.slice(offset, offset + plan.limit);
  return { base, rows: sliced };
};
