import {
  type AggregateEntry,
  BaseResolver,
  combine,
  computeAggregate,
  distinctKeyValues,
  type ExecuteContext,
  executeAggregate,
  executeCount,
  executeSelect,
  finalize,
  groupRows,
  hashJoin,
  type JoinedRow,
  type JoinPair,
  type JoinSpec,
  type JoinType,
  oneOf,
  type ProjectionEntry,
  qualifiedValues,
  type RecordRow,
  type ResolvedBase,
  readColumn,
  ScanLimitExceededError,
  type SetOperator,
  type SortKey,
  sortCombined,
  UnsupportedJoinError,
} from "busabase-orm-core";
import type { BusabaseClient } from "busabase-sdk";
import { Column, getTableName, isTable, Param, type Query, SQL } from "drizzle-orm";
import type { SelectedFieldsOrdered } from "drizzle-orm/pg-core";
import { PgDatabase } from "drizzle-orm/pg-core/db";
import { PgDialect } from "drizzle-orm/pg-core/dialect";
import { PgPreparedQuery, PgSession } from "drizzle-orm/pg-core/session";
import { parseAggregate } from "./aggregate";
import { parseJoinOn, qualify } from "./join";
import { compileWhere } from "./where";

/**
 * How this driver hooks into drizzle.
 *
 * drizzle's proxy drivers hand the callback a finished SQL string, which would
 * force this package to parse SQL back into intent. It does not have to: the
 * `build*Query` methods on `PgDialect` are public and receive the *structured*
 * config — table, limit, offset, orderBy and values arrive as real objects, and
 * only `where` is a chunk tree (which `where.ts` walks).
 *
 * So the dialect intercepts those four methods, stashes the config against the
 * `SQL` object it returns, and `sqlToQuery` — which receives that same object —
 * attaches it to the `Query` handed to the session. drizzle still builds the SQL
 * string; it is simply never sent anywhere. Everything used here is a public
 * subpath export, so no part of drizzle is forked or patched.
 */

type Intent =
  | { kind: "select"; config: SelectConfigLike }
  | { kind: "insert"; config: InsertConfigLike }
  | { kind: "update"; config: UpdateConfigLike }
  | { kind: "delete"; config: DeleteConfigLike };

interface SelectConfigLike {
  table: unknown;
  where?: SQL;
  orderBy?: (Column | SQL)[];
  limit?: number | unknown;
  offset?: number | unknown;
  joins?: unknown[];
  groupBy?: unknown[];
  /**
   * `union`/`intersect`/`except` branches. drizzle's `addSetOperators` pushes
   * them onto the LEFT select's own config and returns that same builder, so a
   * set operation arrives here as an ordinary select config that happens to
   * carry branches — there is no separate intent to intercept.
   */
  setOperators?: {
    type: string;
    isAll?: boolean;
    /** The branch's own select builder; `config` is what its `getSQL()` compiles. */
    rightSelect?: { config?: SelectConfigLike };
    orderBy?: (Column | SQL)[];
    limit?: unknown;
    offset?: unknown;
  }[];
}
interface InsertConfigLike {
  table: unknown;
  values: Record<string, unknown>[];
  onConflict?: unknown;
}
interface UpdateConfigLike {
  table: unknown;
  set: Record<string, unknown>;
  where?: SQL;
}
interface DeleteConfigLike {
  table: unknown;
  where?: SQL;
}

type QueryWithIntent = Query & { __busabaseIntent?: Intent };

const tableName = (table: unknown): string => {
  if (isTable(table)) return getTableName(table);
  throw new Error(
    "drizzle-busabase supports queries against a plain table only — subqueries, views and raw sql sources have no Busabase equivalent.",
  );
};

const unwrapParam = (value: unknown): unknown => {
  if (value instanceof Param) return value.value;
  if (value instanceof SQL) {
    throw new Error(
      "drizzle-busabase cannot write a sql`` expression as a value — Busabase stores literal field values, and evaluating the expression would require a SQL engine it does not have.",
    );
  }
  return value;
};

const unwrapValues = (row: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(row).map(([key, value]) => [key, unwrapParam(value)]));

/**
 * `orderBy` arrives as `[SQL[" ", Column, " desc"]]` or a bare `Column`. Only a
 * plain column reference is understood; an expression sort has no Busabase
 * translation, and ignoring it would return rows in the wrong order.
 */
const parseSortKeys = (
  orderBy: (Column | SQL)[] | undefined,
  // Joined queries name their columns `table.column`, because a bare name is
  // ambiguous once two tables are in play.
  nameOf: (column: Column) => string = (column) => column.name,
): SortKey[] => {
  if (!orderBy?.length) return [];
  return orderBy.map((entry) => {
    if (entry instanceof Column) return { fieldSlug: nameOf(entry), direction: "asc" as const };
    const chunks = entry.queryChunks;
    const column = chunks.find((chunk) => chunk instanceof Column) as Column | undefined;
    if (!column) {
      throw new Error(
        "drizzle-busabase can only order by a column, not by an expression — " +
          "an expression sort has no Busabase translation and ignoring it would return rows in the wrong order.",
      );
    }
    const descending = chunks.some(
      (chunk) =>
        typeof chunk === "object" &&
        chunk !== null &&
        Array.isArray((chunk as { value?: unknown }).value) &&
        (chunk as { value: string[] }).value.join("").trim() === "desc",
    );
    return {
      fieldSlug: nameOf(column),
      direction: descending ? ("desc" as const) : ("asc" as const),
    };
  });
};

/**
 * Ordering keys for a SET OPERATION, which have a different shape from a plain
 * select's — and correctly so. After a union, SQL's `ORDER BY` names an OUTPUT
 * column rather than a table column, so drizzle renders the key as an
 * identifier string (`SQL[ "", <name>, " desc" ]`) instead of carrying the
 * `Column` through. Feeding these to `parseSortKeys`, which looks for a
 * `Column`, reports "cannot order by an expression" about what is simply a
 * plain column reference.
 */
const parseSetOperationSort = (
  orderBy: (Column | SQL)[] | undefined,
): { name: string; direction: "asc" | "desc" }[] =>
  (orderBy ?? []).map((entry) => {
    if (entry instanceof Column) return { name: entry.name, direction: "asc" as const };
    const chunks = (entry as unknown as { queryChunks: unknown[] }).queryChunks;
    // The identifier arrives as a chunk whose `value` is a bare string; the
    // padding and the direction arrive as chunks whose `value` is an array.
    const name = chunks
      .map((chunk) => (chunk as { value?: unknown }).value)
      .find((value): value is string => typeof value === "string");
    if (!name) {
      throw new Error(
        "drizzle-busabase can only order a union/intersect/except by a selected column, " +
          "not by an expression — an expression sort has no Busabase translation and " +
          "ignoring it would return rows in the wrong order.",
      );
    }
    const descending = chunks.some((chunk) => {
      const value = (chunk as { value?: unknown }).value;
      return Array.isArray(value) && value.join("").trim() === "desc";
    });
    return { name, direction: descending ? ("desc" as const) : ("asc" as const) };
  });

class BusabaseDialect extends PgDialect {
  private readonly intents = new WeakMap<SQL, Intent>();

  buildSelectQuery(config: never): SQL {
    const sql = super.buildSelectQuery(config);
    this.intents.set(sql, { kind: "select", config: config as SelectConfigLike });
    return sql;
  }

  buildInsertQuery(config: never): SQL {
    const sql = super.buildInsertQuery(config);
    this.intents.set(sql, { kind: "insert", config: config as InsertConfigLike });
    return sql;
  }

  buildUpdateQuery(config: never): SQL {
    const sql = super.buildUpdateQuery(config);
    this.intents.set(sql, { kind: "update", config: config as UpdateConfigLike });
    return sql;
  }

  buildDeleteQuery(config: never): SQL {
    const sql = super.buildDeleteQuery(config);
    this.intents.set(sql, { kind: "delete", config: config as DeleteConfigLike });
    return sql;
  }

  sqlToQuery(sql: SQL, invokeSource?: "indexes" | undefined): Query {
    const query = super.sqlToQuery(sql, invokeSource) as QueryWithIntent;
    const intent = this.intents.get(sql);
    if (intent) query.__busabaseIntent = intent;
    return query;
  }
}

const JOIN_REFUSAL =
  "drizzle-busabase cannot join: Busabase's REST surface has no join, and emulating one client-side would silently read whole Bases.";
export interface BusabaseDriverOptions {
  /**
   * Maps a drizzle table name to a Base slug or `bas_…` id. Omitted tables
   * resolve by using their own name as the Base slug.
   */
  bases?: Record<string, string>;
  /**
   * Ceiling on records read while resolving one query that Busabase cannot
   * filter or sort server-side. Exceeding it throws rather than truncates.
   */
  maxScannedRecords?: number;
  /** Page size for record listing. The REST contract caps this at 100. */
  pageSize?: number;
  /**
   * `db.delete()` ARCHIVES rather than removes: merging the delete sets the
   * record's status to `archived`, which takes it out of every query this
   * driver can issue but leaves it restorable in Busabase. `await
   * db.delete(...)` means erasure everywhere else, so the difference is opted
   * into rather than assumed — this is not a data-erasure primitive.
   */
  allowArchivingDelete?: boolean;
  /**
   * @deprecated Renamed to {@link BusabaseDriverOptions.allowArchivingDelete}.
   * The old name described a review-first model that no longer holds: a
   * credential with write access merges the delete immediately. Still accepted
   * so 0.1.x callers keep working.
   */
  allowReviewFirstDelete?: boolean;
  /** Message recorded on the ChangeRequests this driver submits. */
  changeMessage?: string;
}

class BusabaseSession extends PgSession {
  constructor(
    dialect: PgDialect,
    private readonly client: BusabaseClient,
    private readonly options: Required<
      Pick<BusabaseDriverOptions, "maxScannedRecords" | "pageSize" | "changeMessage">
    > &
      Pick<BusabaseDriverOptions, "allowArchivingDelete" | "allowReviewFirstDelete">,
    private readonly resolver: BaseResolver,
  ) {
    super(dialect);
  }

  prepareQuery<T extends { execute: unknown; all: unknown; values: unknown }>(
    query: Query,
    fields: SelectedFieldsOrdered | undefined,
    _name: string | undefined,
    _isResponseInArrayMode: boolean,
    customResultMapper?: (rows: unknown[][]) => T["execute"],
  ): PgPreparedQuery<T> {
    const intent = (query as QueryWithIntent).__busabaseIntent;
    const context: ExecuteContext = {
      client: this.client,
      resolver: this.resolver,
      maxScannedRecords: this.options.maxScannedRecords,
      pageSize: this.options.pageSize,
    };
    const run = () => this.run(intent, fields, context);
    const joined =
      intent?.kind === "select" && (intent.config.joins?.length ?? 0) > 0 ? intent.config : null;
    const setOperation =
      intent?.kind === "select" && (intent.config.setOperators?.length ?? 0) > 0
        ? intent.config
        : null;
    const runSetOperation = (projection: SelectedFieldsOrdered) =>
      this.runSetOperation(setOperation as SelectConfigLike, projection, context);
    const runJoined = () => this.runJoinedSelect(joined as SelectConfigLike, context);
    // An aggregate in the projection changes what a "row" IS, so it is decided
    // here (where `fields` is available) rather than inside `run`.
    const aggregatePlan =
      fields && intent?.kind === "select" ? planAggregates(fields, intent.config) : null;
    const runAggregate = () =>
      this.runAggregate(intent?.config as SelectConfigLike, aggregatePlan!, context);

    return new (class extends PgPreparedQuery<T> {
      async execute(): Promise<T["execute"]> {
        if (setOperation) {
          if (!fields) {
            throw new Error(
              "drizzle-busabase cannot run a union/intersect/except with no projection.",
            );
          }
          const arrayRows = await runSetOperation(fields);
          return (
            customResultMapper
              ? customResultMapper(arrayRows)
              : arrayRows.map((arrayRow) => assembleRow(fields, arrayRow))
          ) as T["execute"];
        }
        if (joined) {
          const { rows } = await runJoined();
          if (!fields) return rows.map((row) => row.values) as T["execute"];
          const arrayRows = rows.map((row) => projectJoinedRow(row, fields));
          return (
            customResultMapper
              ? customResultMapper(arrayRows)
              : arrayRows.map((arrayRow) => assembleRow(fields, arrayRow))
          ) as T["execute"];
        }
        if (aggregatePlan && fields) {
          const arrayRows = await runAggregate();
          return (
            customResultMapper
              ? customResultMapper(arrayRows)
              : arrayRows.map((arrayRow) => assembleRow(fields, arrayRow))
          ) as T["execute"];
        }
        const { base, rows } = await run();
        if (!fields) return rows as T["execute"];
        const arrayRows = rows.map((row) => projectRow(base, row, fields));
        return (
          customResultMapper
            ? customResultMapper(arrayRows)
            : arrayRows.map((arrayRow) => assembleRow(fields, arrayRow))
        ) as T["execute"];
      }
      // `all` exists on the base contract; for this driver it is the same read.
      async all(): Promise<T["all"]> {
        return (await this.execute()) as T["all"];
      }
    })(query, undefined, undefined);
  }

  private async run(
    intent: Intent | undefined,
    _fields: SelectedFieldsOrdered | undefined,
    context: ExecuteContext,
  ): Promise<{ base: ResolvedBase; rows: RecordRow[] }> {
    if (!intent) {
      throw new Error(
        "drizzle-busabase received a query it did not build (raw db.execute() has no Busabase translation).",
      );
    }
    switch (intent.kind) {
      case "select":
        return this.runSelect(intent.config, context);
      case "insert":
        return this.runInsert(intent.config, context);
      case "update":
        return this.runUpdate(intent.config, context);
      case "delete":
        return this.runDelete(intent.config, context);
    }
  }

  /**
   * `union` / `intersect` / `except`.
   *
   * The hook was here the whole time. `addSetOperators` pushes the branches
   * onto the LEFT select's config and returns that same builder, so
   * `buildSelectQuery` receives the left query with `setOperators` attached —
   * no separate dialect interception is needed, and an earlier attempt to
   * reconstruct the left side from `buildSetOperations` was solving a problem
   * that does not exist.
   *
   * Each branch runs as an ordinary select, so each keeps its own push-down: a
   * union of two narrow queries stays two narrow requests. They are combined on
   * the PROJECTED row, which is what SQL's set operators compare.
   *
   * The operation's own `limit`/`offset`/`orderBy` hang off the LAST operator
   * and apply to the COMBINED result, so no branch may carry them down — a
   * limit pushed into a branch would truncate the input to the combination and
   * drop rows the other branch would have kept.
   */
  private async runSetOperation(
    config: SelectConfigLike,
    fields: SelectedFieldsOrdered,
    context: ExecuteContext,
  ): Promise<unknown[][]> {
    const operators = config.setOperators ?? [];
    const branch = async (branchConfig: SelectConfigLike) => {
      const { base, rows } = await this.runSelect(branchConfig, context);
      return rows.map((row) => projectRow(base, row, fields));
    };

    // The left is this very config, minus the branches hanging off it.
    const { setOperators: _branches, ...left } = config;
    let combined = await branch(left as SelectConfigLike);

    for (const operator of operators) {
      const right = operator.rightSelect?.config;
      if (!right) {
        throw new Error(
          "drizzle-busabase can only combine plain selects with union/intersect/except — " +
            "one branch is not a select.",
        );
      }
      combined = combine(
        combined,
        await branch(right),
        operator.type as SetOperator,
        operator.isAll === true,
      );
    }

    // Ordering keys name columns of the (union-compatible) projection, so they
    // resolve to a POSITION. One that is not selected is refused rather than
    // dropped: returning rows in a different order than asked for is not
    // something a caller re-checks.
    const last = operators[operators.length - 1];
    const sortKeys = parseSetOperationSort(last?.orderBy).map((key) => {
      const index = fields.findIndex(
        (entry) => entry.field instanceof Column && entry.field.name === key.name,
      );
      if (index === -1) {
        throw new Error(
          `drizzle-busabase cannot order a union/intersect/except by "${key.name}" — ` +
            `it is not one of the combined columns.`,
        );
      }
      return { index, direction: key.direction };
    });
    const ordered = sortCombined(combined, sortKeys, compareGroupValues);

    const offset = typeof last?.offset === "number" ? last.offset : 0;
    const limit = typeof last?.limit === "number" ? last.limit : undefined;
    return limit === undefined ? ordered.slice(offset) : ordered.slice(offset, offset + limit);
  }

  private async runSelect(config: SelectConfigLike, context: ExecuteContext) {
    // Reachable only without a projection (a grouped select routes to
    // `runAggregate`, which is chosen from `fields`), so this is a backstop
    // rather than the message a user normally sees.
    if (config.groupBy?.length) {
      throw new Error("drizzle-busabase cannot group a query that selects no fields.");
    }
    return executeSelect(
      {
        baseSlug: tableName(config.table),
        where: compileWhere(config.where, (column) => column.name),
        orderBy: parseSortKeys(config.orderBy),
        limit: typeof config.limit === "number" ? config.limit : undefined,
        offset: typeof config.offset === "number" ? config.offset : undefined,
      },
      context,
    );
  }

  /**
   * A grouped / aggregated select.
   *
   * `limit` and `offset` are deliberately NOT passed to `executeSelect`: on an
   * aggregate query they bound the GROUPS, not the records, so pushing them
   * down would truncate the input to the aggregation and report a confidently
   * wrong total. Same for `orderBy`, which orders groups here.
   *
   * There is one fast path, and only one. A bare `count()` over a fully-exact
   * where clause is `records.count` — one round trip, no rows transferred.
   *
   * A GROUPED count is NOT routed to `records.groupBy`, even though that
   * endpoint exists and now takes the same value filters. Its buckets are the
   * GRID's, not SQL's: an unset checkbox is folded in with `false`, and an
   * empty string is folded in with the null bucket. Both are right for a Kanban
   * column header and wrong for `GROUP BY`, which gives null its own group. A
   * fast path that answered differently from the scan path would be worse than
   * no fast path.
   */
  private async runAggregate(
    config: SelectConfigLike,
    plan: AggregatePlan,
    context: ExecuteContext,
  ): Promise<unknown[][]> {
    // The same two refusals a plain select makes, stated here rather than
    // reached through it — aggregating over a join or a union would need the
    // combined row set this driver cannot build.
    if (config.joins?.length) throw new Error(JOIN_REFUSAL);
    if (config.setOperators?.length) {
      throw new Error("drizzle-busabase cannot aggregate over a union/intersect/except.");
    }
    const where = compileWhere(config.where, (column) => column.name);
    const baseSlug = tableName(config.table);

    const bareCount =
      plan.groupSlugs.length === 0 &&
      plan.entries.length === 1 &&
      plan.entries[0]?.kind === "aggregate" &&
      plan.entries[0].fn === "count" &&
      plan.entries[0].fieldSlug === null;

    if (bareCount) {
      const counted = await executeCount({ baseSlug, where }, context);
      // `null` means the where clause is not fully expressible server-side, so
      // the count falls through to the scan below rather than being answered
      // from a row set the server only partly filtered.
      if (counted !== null) return [[counted]];
    }

    // A projection of aggregates — optionally grouped by ONE column — is a
    // single round trip: `records.groupBy` aggregates server-side, with SQL
    // bucketing so its groups match what `groupRows` would produce locally.
    const entries = plan.entries;
    const aggregateEntries = entries.filter(
      (entry): entry is AggregateEntry => entry.kind === "aggregate",
    );
    const groupColumns = entries.filter(
      (entry): entry is Extract<ProjectionEntry, { kind: "column" }> => entry.kind === "column",
    );
    const serverGroupable =
      plan.groupSlugs.length <= 1 &&
      aggregateEntries.length > 0 &&
      // Every non-aggregate column must BE the group column: anything else has
      // no defined value per group, and SQL would reject the query outright.
      groupColumns.every((entry) => entry.fieldSlug === plan.groupSlugs[0]) &&
      // Ordering is applied to the groups below, and needs the values it sorts
      // by — which the server path returns, so only an unsupported sort blocks.
      true;

    if (serverGroupable) {
      const answered = await executeAggregate(
        {
          baseSlug,
          where,
          groupBy: plan.groupSlugs[0],
          aggregates: aggregateEntries.map((entry) => ({
            fn: entry.fn,
            fieldSlug: entry.fieldSlug,
            distinct: entry.distinct,
          })),
        },
        context,
      );
      if (answered) {
        const rows = answered.map((group) =>
          entries.map((entry) => {
            if (entry.kind === "column") return group.value;
            if (entry.fieldSlug === null) return group.count;
            const value = group.values[`${entry.fn}:${entry.fieldSlug}`] ?? null;
            if (entry.fn === "count") return value ?? 0;
            if (entry.fn === "min" || entry.fn === "max") return value;
            // drizzle declares sum/avg as `SQL<string | null>`, matching
            // Postgres's numeric-as-string, so the fast path must agree with
            // the scan path rather than leaking a JS number here.
            return value === null ? null : String(value);
          }),
        );
        return sliceAggregateRows(sortAggregateRows(rows, plan.sorts), config);
      }
    }

    const { base, rows } = await executeSelect({ baseSlug, where }, context);
    const groups = groupRows(base, rows, plan.groupSlugs);
    const built = groups.map((group) =>
      plan.entries.map((entry) =>
        entry.kind === "aggregate"
          ? computeAggregate(entry, base, group.rows)
          : readColumn(base, group.rows[0] as RecordRow, entry.fieldSlug),
      ),
    );

    return sliceAggregateRows(sortAggregateRows(built, plan.sorts), config);
  }

  /**
   * A joined select, as a hash join over rows this driver fetches.
   *
   * Three things about the cost, stated rather than buried:
   *
   * - The LEFT (driving) table is read in full UNLESS the whole `where`
   *   references only its columns — in which case it is compiled and pushed
   *   down exactly as an unjoined query would be. That covers the common shape
   *   (`from(a).innerJoin(b).where(<condition on a>)`); a `where` that spans
   *   both tables cannot be split back apart here and falls back to a scan.
   * - Each joined table is fetched BY KEY when the join column is a real Base
   *   field, batched so the value filters stay inside their URL budget. When
   *   the key is the record `id` (the most natural join target, and NOT a
   *   field) there is no filter that can express it, so that table is read in
   *   full. Lookup tables are usually small; this is the honest trade.
   * - Everything is bounded by `maxScannedRecords` and fails loudly.
   */
  private async runJoinedSelect(
    config: SelectConfigLike,
    context: ExecuteContext,
  ): Promise<{ rows: JoinedRow[] }> {
    const leftTable = tableName(config.table);
    const specs = (config.joins ?? []).map((entry) => {
      const join = entry as { table: unknown; alias?: string; joinType?: string; on?: unknown };
      const type = (join.joinType ?? "inner") as JoinType;
      if (!["inner", "left", "right", "full"].includes(type)) {
        throw new UnsupportedJoinError(`\`${type}\` is not a join type this driver knows`);
      }
      const table = tableName(join.table);
      return { tableName: table, alias: join.alias ?? table, type, pairs: parseJoinOn(join.on) };
    });

    // Push the whole `where` only when every column in it belongs to the
    // driving table. Compiling with a resolver that refuses anything else is
    // the check: if it throws, the clause spans tables and stays local.
    let leftWhere: ReturnType<typeof compileWhere> | undefined;
    if (config.where) {
      try {
        leftWhere = compileWhere(config.where, (column) => {
          if (qualify(column).split(".")[0] !== leftTable) {
            throw new Error("references another table");
          }
          return column.name;
        });
      } catch {
        leftWhere = undefined;
      }
    }

    const leftBase = await context.resolver.resolve(leftTable);
    const { rows: leftRecords } = await executeSelect(
      { baseSlug: leftTable, where: leftWhere },
      context,
    );
    if (leftRecords.length > context.maxScannedRecords) {
      throw new ScanLimitExceededError(leftBase.slug, context.maxScannedRecords);
    }
    const namesOf = (base: ResolvedBase) => [...base.fields.keys(), "id", "createdAt", "updatedAt"];
    const leftNames = namesOf(leftBase);
    let accumulated: JoinedRow[] = leftRecords.map((row) => ({
      values: qualifiedValues(leftBase, leftTable, row, leftNames),
      sources: { [leftTable]: row },
    }));

    for (const spec of specs) {
      const base = await context.resolver.resolve(spec.tableName);
      const names = namesOf(base);
      const records = await this.fetchJoinSide(accumulated, spec, base, context);
      if (records.length > context.maxScannedRecords) {
        throw new ScanLimitExceededError(base.slug, context.maxScannedRecords);
      }
      const incoming = records.map((row) => ({
        row,
        values: qualifiedValues(base, spec.tableName, row, names),
      }));
      const empty = qualifiedValues(base, spec.tableName, null, names);
      accumulated = hashJoin(accumulated, incoming, spec.pairs, spec.type, spec.tableName, empty);
    }

    // The authoritative predicate reads QUALIFIED names, because it may span
    // tables — the push-down above was only ever an optimisation on the left.
    if (config.where) {
      const combined = compileWhere(config.where, qualify);
      accumulated = accumulated.filter((row) => combined.predicate(row.values));
    }

    const sortKeys = parseSortKeys(config.orderBy, qualify);
    if (sortKeys.length) {
      accumulated.sort((left, right) => {
        for (const key of sortKeys) {
          const order = compareGroupValues(left.values[key.fieldSlug], right.values[key.fieldSlug]);
          if (order !== 0) return key.direction === "desc" ? -order : order;
        }
        return 0;
      });
    }

    const offset = typeof config.offset === "number" ? config.offset : 0;
    const limit = typeof config.limit === "number" ? config.limit : undefined;
    return {
      rows:
        limit === undefined ? accumulated.slice(offset) : accumulated.slice(offset, offset + limit),
    };
  }

  /**
   * The rows of one joined table: by key when the key is a real Base field,
   * otherwise everything.
   *
   * Batched at 50 keys because the value filters ride in a GET query string and
   * a big enough `IN` becomes a 414 rather than a slow query — the same budget
   * `compileValueFilters` enforces, kept under it deliberately.
   */
  private async fetchJoinSide(
    accumulated: JoinedRow[],
    spec: JoinSpec,
    base: ResolvedBase,
    context: ExecuteContext,
  ): Promise<RecordRow[]> {
    const rightSlug =
      spec.pairs.length === 1 ? (spec.pairs[0] as JoinPair).right.split(".")[1] : undefined;
    const keys = distinctKeyValues(accumulated, spec.pairs);
    // An outer join needs the unmatched rows of the joined table too, so it
    // cannot be narrowed to the keys the left side happens to hold.
    const needsEveryRow = spec.type === "right" || spec.type === "full";
    if (!rightSlug || !base.fields.has(rightSlug) || keys === null || needsEveryRow) {
      const { rows } = await executeSelect({ baseSlug: spec.tableName }, context);
      return rows;
    }
    if (keys.length === 0) return [];

    const collected: RecordRow[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < keys.length; index += 50) {
      const batch = keys.slice(index, index + 50);
      const { rows } = await executeSelect(
        { baseSlug: spec.tableName, where: finalize(oneOf(rightSlug, batch, false)) },
        context,
      );
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        collected.push(row);
      }
    }
    return collected;
  }

  private async runInsert(config: InsertConfigLike, context: ExecuteContext) {
    if (config.onConflict) {
      throw new Error("drizzle-busabase does not support on-conflict clauses.");
    }
    const base = await context.resolver.resolve(tableName(config.table));
    const rows: RecordRow[] = [];
    for (const value of config.values) {
      const result = await this.client.bases.createChangeRequest({
        baseId: base.id,
        fields: unwrapValues(value),
        message: this.options.changeMessage,
      });
      if (!result.materialized) {
        throw new Error(
          `drizzle-busabase submitted the insert as ChangeRequest ${result.id}, which is awaiting review — the record does not exist yet. ` +
            `This happens when the API credential lacks write access on the Base. ` +
            `The insert is NOT lost; approve the ChangeRequest to apply it.`,
        );
      }
      rows.push({
        id: result.id,
        createdAt: result.createdAt,
        updatedAt: result.updatedAt,
        payload: result.headCommit.payload,
      });
    }
    return { base, rows };
  }

  private async runUpdate(config: UpdateConfigLike, context: ExecuteContext) {
    const { base, rows } = await executeSelect(
      {
        baseSlug: tableName(config.table),
        where: compileWhere(config.where, (column) => column.name),
      },
      context,
    );
    const patch = unwrapValues(config.set);
    const updated: RecordRow[] = [];
    for (const row of rows) {
      const result = await this.client.records.changeRequest({
        recordId: row.id,
        operation: "update",
        // Busabase revises a record as a whole payload, so the untouched fields
        // have to be carried over or they would be cleared.
        fields: { ...row.payload, ...patch },
        message: this.options.changeMessage,
        autoMerge: true,
      });
      if (!result.materialized) {
        throw new Error(
          `drizzle-busabase submitted the update to record ${row.id} as ChangeRequest ${result.id}, which is awaiting review — the record is unchanged for now.`,
        );
      }
      updated.push({
        id: result.id,
        createdAt: result.createdAt,
        updatedAt: result.updatedAt,
        payload: result.headCommit.payload,
      });
    }
    return { base, rows: updated };
  }

  private async runDelete(config: DeleteConfigLike, context: ExecuteContext) {
    if (!(this.options.allowArchivingDelete ?? this.options.allowReviewFirstDelete)) {
      throw new Error(
        "drizzle-busabase refuses db.delete() by default. A Busabase delete ARCHIVES the record rather than removing it: " +
          "it leaves every query this driver can issue, but it is still stored and restorable — which is not what `await db.delete(...)` " +
          "means anywhere else. Pass `allowArchivingDelete: true` once you have accounted for that.",
      );
    }
    const { base, rows } = await executeSelect(
      {
        baseSlug: tableName(config.table),
        where: compileWhere(config.where, (column) => column.name),
      },
      context,
    );
    for (const row of rows) {
      const result = await this.client.records.changeRequest({
        recordId: row.id,
        operation: "delete",
        message: this.options.changeMessage,
        autoMerge: true,
      });
      if (!result.materialized) {
        throw new Error(
          `drizzle-busabase submitted the delete of record ${row.id} as ChangeRequest ${result.id}, which is awaiting review — ` +
            `the record is STILL THERE. This happens when the API credential lacks write access on the Base. ` +
            `The delete is NOT lost; approve the ChangeRequest to apply it.`,
        );
      }
    }
    return { base, rows };
  }

  async transaction<T>(): Promise<T> {
    throw new Error(
      "drizzle-busabase does not support transactions yet. Busabase's ChangeRequest is the natural transaction boundary " +
        "(one request, many operations, merged atomically), but this driver does not batch into one yet.",
    );
  }
}

/**
 * Assembles a positional row back into the object shape the select asked for.
 *
 * drizzle has an internal `mapResultRow` that does this, but it is not part of
 * any published type surface — only its implementation is shipped. Rather than
 * reach past the types into an internal, this rebuilds the same nesting from
 * `SelectedFieldsOrdered.path`, which *is* public: `db.select()` yields
 * single-segment paths, and a nested selection like
 * `db.select({ user: { name: t.name } })` yields `["user", "name"]`.
 */
const assembleRow = (fields: SelectedFieldsOrdered, row: unknown[]): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  fields.forEach((entry, index) => {
    let target = result;
    for (const segment of entry.path.slice(0, -1)) {
      const existing = target[segment];
      if (existing && typeof existing === "object") {
        target = existing as Record<string, unknown>;
      } else {
        const created: Record<string, unknown> = {};
        target[segment] = created;
        target = created;
      }
    }
    const leaf = entry.path[entry.path.length - 1];
    if (leaf !== undefined) target[leaf] = row[index];
  });
  return result;
};

interface AggregatePlan {
  /** One entry per projected field, in drizzle's own order. */
  entries: ProjectionEntry[];
  /** Field slugs from `GROUP BY`, in order. */
  groupSlugs: string[];
  /** Ordering applied to the GROUPS, resolved to projection indexes. */
  sorts: { index: number; direction: "asc" | "desc" }[];
}

/**
 * Reads a select's projection, returning a plan only if it actually aggregates.
 *
 * A `GROUP BY` with no aggregate in the projection still counts: it is SQL's
 * DISTINCT-by-another-name, and it produces one row per group rather than one
 * per record, so it cannot go down the ordinary row path either.
 */
const planAggregates = (
  fields: SelectedFieldsOrdered,
  config: SelectConfigLike,
): AggregatePlan | null => {
  const groupBy = config.groupBy ?? [];
  const entries: ProjectionEntry[] = [];
  let sawAggregate = false;
  for (const entry of fields) {
    const aggregate = parseAggregate(entry.field);
    if (aggregate) {
      entries.push(aggregate);
      sawAggregate = true;
      continue;
    }
    if (entry.field instanceof Column) {
      entries.push({ kind: "column", fieldSlug: entry.field.name });
      continue;
    }
    // Not an aggregate and not a plain column. Left for `projectRow` to reject
    // with its own message when this turns out not to be an aggregate query.
    entries.push({ kind: "column", fieldSlug: "" });
  }
  if (!sawAggregate && groupBy.length === 0) return null;

  const groupSlugs = groupBy.map((entry) => {
    if (entry instanceof Column) return entry.name;
    throw new Error(
      "drizzle-busabase can only group by a plain column — a grouped expression has no Busabase translation.",
    );
  });

  // A grouped query's ORDER BY orders the GROUPS, so each key is resolved
  // against the projection rather than against a record field: either a
  // grouped column, or an aggregate that is also selected (matched by function,
  // argument and distinctness — the same aggregate written twice IS the same
  // value, so it does not need an alias to be found).
  const sorts = (config.orderBy ?? []).map((entry) => {
    const { target, direction } = unwrapSort(entry);
    const aggregate = parseAggregate(target);
    const index = entries.findIndex((candidate) =>
      aggregate
        ? candidate.kind === "aggregate" &&
          candidate.fn === aggregate.fn &&
          candidate.fieldSlug === aggregate.fieldSlug &&
          candidate.distinct === aggregate.distinct
        : target instanceof Column &&
          candidate.kind === "column" &&
          candidate.fieldSlug === target.name,
    );
    if (index === -1) {
      throw new Error(
        "drizzle-busabase can only order a grouped query by something it also selects — " +
          "ordering by a value that is not in the projection has no Busabase translation.",
      );
    }
    return { index, direction };
  });

  return { entries, groupSlugs, sorts };
};

/** `desc(x)` / `asc(x)` arrive as `[target, " desc"]`; a bare key is the target. */
const unwrapSort = (entry: Column | SQL): { target: unknown; direction: "asc" | "desc" } => {
  if (entry instanceof Column) return { target: entry, direction: "asc" };
  const chunks = (entry as unknown as { queryChunks: unknown[] }).queryChunks;
  const trailing = chunks
    .map((chunk) => (chunk as { value?: unknown }).value)
    .filter((value): value is string[] => Array.isArray(value))
    .map((value) => value.join("").trim());
  const direction = trailing.includes("desc") ? ("desc" as const) : ("asc" as const);
  const target = chunks.find((chunk) => chunk instanceof Column || chunk instanceof SQL);
  return { target: target ?? entry, direction };
};

/**
 * A joined row's projection. Columns are read by QUALIFIED name, so `id` in a
 * two-table query resolves to the table the user actually wrote rather than to
 * whichever one happens to be first.
 */
const projectJoinedRow = (row: JoinedRow, fields: SelectedFieldsOrdered): unknown[] =>
  fields.map((entry) => {
    const field = entry.field;
    if (field instanceof Column) return row.values[qualify(field)] ?? null;
    throw new Error(
      "drizzle-busabase can only select plain columns — computed expressions have no Busabase translation.",
    );
  });

/** Turns a record into the positional row drizzle's own result mapper expects. */
const projectRow = (base: ResolvedBase, row: RecordRow, fields: SelectedFieldsOrdered): unknown[] =>
  fields.map((entry) => {
    const field = entry.field;
    if (field instanceof Column) return readColumn(base, row, field.name);
    throw new Error(
      "drizzle-busabase can only select plain columns — computed expressions have no Busabase translation.",
    );
  });

/**
 * Ordering for grouped output. Numbers compare numerically (so `count()` sorts
 * as a number rather than as "10" < "9"), nulls sort last on ascending to match
 * Postgres, and everything else compares as text.
 */
/** Ordering applied to GROUPS, by position in the projection. */
const sortAggregateRows = (
  rows: unknown[][],
  sorts: { index: number; direction: "asc" | "desc" }[],
): unknown[][] => {
  for (const sort of [...sorts].reverse()) {
    rows.sort((left, right) => {
      const order = compareGroupValues(left[sort.index], right[sort.index]);
      return sort.direction === "desc" ? -order : order;
    });
  }
  return rows;
};

/** `limit`/`offset` bound the GROUPS, never the records that fed them. */
const sliceAggregateRows = (rows: unknown[][], config: SelectConfigLike): unknown[][] => {
  const offset = typeof config.offset === "number" ? config.offset : 0;
  const limit = typeof config.limit === "number" ? config.limit : undefined;
  return limit === undefined ? rows.slice(offset) : rows.slice(offset, offset + limit);
};

const compareGroupValues = (left: unknown, right: unknown): number => {
  const leftNull = left === null || left === undefined;
  const rightNull = right === null || right === undefined;
  if (leftNull && rightNull) return 0;
  if (leftNull) return 1;
  if (rightNull) return -1;
  const leftNumber = typeof left === "number" ? left : Number(left);
  const rightNumber = typeof right === "number" ? right : Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber === rightNumber ? 0 : leftNumber < rightNumber ? -1 : 1;
  }
  const leftText = String(left);
  const rightText = String(right);
  return leftText === rightText ? 0 : leftText < rightText ? -1 : 1;
};

export type BusabaseDatabase<TSchema extends Record<string, unknown> = Record<string, never>> =
  PgDatabase<never, TSchema>;

/**
 * Builds a drizzle database backed by Busabase.
 *
 * ```ts
 * const bb = new Busabase({ apiKey: process.env.BUSABASE_API_KEY });
 * const db = drizzle(bb.client, { bases: { contacts: "kelly-crm-contacts-v1" } });
 * const rows = await db.select().from(contacts).where(eq(contacts.stage, "won"));
 * ```
 */
export const drizzle = <TSchema extends Record<string, unknown> = Record<string, never>>(
  client: BusabaseClient,
  options: BusabaseDriverOptions & { schema?: TSchema } = {},
): BusabaseDatabase<TSchema> => {
  const dialect = new BusabaseDialect();
  const resolver = new BaseResolver(client, options.bases ?? {});
  const session = new BusabaseSession(
    dialect,
    client,
    {
      maxScannedRecords: options.maxScannedRecords ?? 10_000,
      pageSize: Math.min(options.pageSize ?? 100, 100),
      changeMessage: options.changeMessage ?? "Change via drizzle-busabase",
      allowArchivingDelete: options.allowArchivingDelete,
      allowReviewFirstDelete: options.allowReviewFirstDelete,
    },
    resolver,
  );
  return new PgDatabase(dialect, session as never, undefined as never) as BusabaseDatabase<TSchema>;
};
