import type { BusabaseClient } from "busabase-sdk";
import type { BaseResolver, ResolvedBase } from "./base-resolver";
import { isServerSortable } from "./base-resolver";
import type { CompiledWhere, RecordPayload, ValueCandidate } from "./predicate";

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
 * Field types Busabase can compare exactly, and the wire form each expects.
 * Kept in step with the server's `buildExactValueFilter`, which refuses (400)
 * anything outside these — so sending a candidate on any other field type would
 * fail the whole request rather than silently skip that one condition.
 */
const NUMBER_VALUE_TYPES = new Set(["number", "auto_number"]);
const DATE_VALUE_TYPES = new Set(["date"]);

const encodeValueFilter = (
  fieldType: string | undefined,
  value: unknown,
): { ok: true; value: number | string } | { ok: false } => {
  if (fieldType && NUMBER_VALUE_TYPES.has(fieldType)) {
    const numeric = typeof value === "number" ? value : Number(value);
    return Number.isFinite(numeric) ? { ok: true, value: numeric } : { ok: false };
  }
  if (fieldType && DATE_VALUE_TYPES.has(fieldType)) {
    // A driver may hand over a `Date` (timestamp column) or a string; the
    // server takes ISO 8601 either way.
    const date = value instanceof Date ? value : new Date(value as string | number);
    return Number.isNaN(date.getTime()) ? { ok: false } : { ok: true, value: date.toISOString() };
  }
  return { ok: false };
};

export const executeSelect = async (
  plan: SelectPlan,
  context: ExecuteContext,
): Promise<{ base: ResolvedBase; rows: RecordRow[] }> => {
  const base = await context.resolver.resolve(plan.baseSlug);
  const { pushdown, valueCandidates, fullyExact, predicate } = plan.where ?? {
    pushdown: [],
    valueCandidates: [],
    fullyExact: true,
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

  // `valueFilters` are the exact half of the story. Every candidate that lands
  // on a field with a real value column can be evaluated authoritatively by the
  // server; anything else falls back to the local predicate.
  const valueFilters: {
    fieldSlug: string;
    operator: ValueCandidate["operator"];
    value: number | string;
  }[] = [];
  let everyCandidateSent = true;
  for (const candidate of valueCandidates) {
    const encoded = encodeValueFilter(base.fields.get(candidate.fieldSlug)?.type, candidate.value);
    if (!encoded.ok) {
      everyCandidateSent = false;
      continue;
    }
    valueFilters.push({
      fieldSlug: candidate.fieldSlug,
      operator: candidate.operator,
      value: encoded.value,
    });
  }

  // The whole where clause is server-decided only when it is a pure AND of
  // comparisons (`fullyExact`) AND every one of those comparisons actually made
  // it into `valueFilters`. Both halves matter: a single condition left behind
  // means the server's answer is a superset again, and a superset cannot carry
  // a limit.
  const whereIsExact = plan.where === undefined || (fullyExact && everyCandidateSent);
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
