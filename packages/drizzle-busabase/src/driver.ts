import {
  BaseResolver,
  type ExecuteContext,
  executeSelect,
  type RecordRow,
  type ResolvedBase,
  readColumn,
  type SortKey,
} from "busabase-orm-core";
import type { BusabaseClient } from "busabase-sdk";
import { Column, getTableName, isTable, Param, type Query, SQL } from "drizzle-orm";
import type { SelectedFieldsOrdered } from "drizzle-orm/pg-core";
import { PgDatabase } from "drizzle-orm/pg-core/db";
import { PgDialect } from "drizzle-orm/pg-core/dialect";
import { PgPreparedQuery, PgSession } from "drizzle-orm/pg-core/session";
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
  setOperators?: unknown[];
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
const parseSortKeys = (orderBy: (Column | SQL)[] | undefined): SortKey[] => {
  if (!orderBy?.length) return [];
  return orderBy.map((entry) => {
    if (entry instanceof Column) return { fieldSlug: entry.name, direction: "asc" as const };
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
    return { fieldSlug: column.name, direction: descending ? ("desc" as const) : ("asc" as const) };
  });
};

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
   * `db.delete()` maps onto a review-first delete ChangeRequest: the rows are
   * *proposed* for archiving, and are still present when the call returns.
   * Because that breaks what `await db.delete(...)` normally guarantees, it is
   * refused unless this is set.
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
      Pick<BusabaseDriverOptions, "allowReviewFirstDelete">,
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

    return new (class extends PgPreparedQuery<T> {
      async execute(): Promise<T["execute"]> {
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

  private async runSelect(config: SelectConfigLike, context: ExecuteContext) {
    if (config.joins?.length) {
      throw new Error(
        "drizzle-busabase cannot join: Busabase's REST surface has no join, and emulating one client-side would silently read whole Bases.",
      );
    }
    if (config.groupBy?.length) {
      throw new Error(
        "drizzle-busabase does not support group by yet — Busabase's records.groupBy covers select/checkbox fields only.",
      );
    }
    if (config.setOperators?.length) {
      throw new Error("drizzle-busabase does not support union/intersect/except.");
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
    if (!this.options.allowReviewFirstDelete) {
      throw new Error(
        "drizzle-busabase refuses db.delete() by default. Busabase deletes are review-first: the call submits a ChangeRequest " +
          "proposing the rows be archived, and they are STILL PRESENT when it returns — which is not what `await db.delete(...)` means. " +
          "Pass `allowReviewFirstDelete: true` once you have accounted for that.",
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
      await this.client.records.changeRequest({
        recordId: row.id,
        operation: "delete",
        message: this.options.changeMessage,
      });
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

/** Turns a record into the positional row drizzle's own result mapper expects. */
const projectRow = (base: ResolvedBase, row: RecordRow, fields: SelectedFieldsOrdered): unknown[] =>
  fields.map((entry) => {
    const field = entry.field;
    if (field instanceof Column) return readColumn(base, row, field.name);
    throw new Error(
      "drizzle-busabase can only select plain columns — computed expressions have no Busabase translation.",
    );
  });

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
      allowReviewFirstDelete: options.allowReviewFirstDelete,
    },
    resolver,
  );
  return new PgDatabase(dialect, session as never, undefined as never) as BusabaseDatabase<TSchema>;
};
