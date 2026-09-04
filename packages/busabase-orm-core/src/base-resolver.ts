import type { BusabaseClient } from "busabase-sdk";

/**
 * A drizzle table names a Busabase Base. Resolution is by slug (the table name,
 * unless overridden), because a `bas_…` id is not something you want hard-coded
 * in a schema file that moves between a dev server and Cloud.
 *
 * The Base's field list comes back with it, and the driver needs it for more
 * than mapping: a field's `type` decides whether a sort can be pushed down at
 * all (the REST contract restricts server-side sort to number/date fields), and
 * whether a column name refers to a real field or to a record system column.
 */

export interface ResolvedField {
  slug: string;
  type: string;
}

export interface ResolvedBase {
  id: string;
  slug: string;
  fields: Map<string, ResolvedField>;
}

export class UnknownBaseError extends Error {
  constructor(slug: string, known: string[]) {
    super(
      `drizzle-busabase found no Base with slug "${slug}". ` +
        `Known slugs in this space: ${known.length ? known.join(", ") : "(none)"}. ` +
        `Pass \`bases: { ${slug}: "<slug-or-bas_id>" }\` to map the table explicitly.`,
    );
    this.name = "UnknownBaseError";
  }
}

export class BaseResolver {
  private readonly cache = new Map<string, Promise<ResolvedBase>>();

  constructor(
    private readonly client: BusabaseClient,
    private readonly overrides: Record<string, string> = {},
  ) {}

  resolve(tableName: string): Promise<ResolvedBase> {
    const key = this.overrides[tableName] ?? tableName;
    // Cache the promise, not the result: concurrent queries against the same
    // table then share one round trip instead of racing several.
    const cached = this.cache.get(key);
    if (cached) return cached;
    const pending = this.load(key);
    this.cache.set(key, pending);
    // A failed lookup must not be cached — the Base may simply not exist yet.
    pending.catch(() => this.cache.delete(key));
    return pending;
  }

  private async load(slugOrId: string): Promise<ResolvedBase> {
    const bases = await this.client.bases.list({});
    const match =
      bases.find((base) => base.slug === slugOrId) ?? bases.find((base) => base.id === slugOrId);
    if (!match)
      throw new UnknownBaseError(
        slugOrId,
        bases.map((base) => base.slug),
      );
    return {
      id: match.id,
      slug: match.slug,
      fields: new Map(
        match.fields.map((field) => [field.slug, { slug: field.slug, type: field.type }]),
      ),
    };
  }
}

/** Field types Busabase will sort server-side; everything else sorts locally. */
const SERVER_SORTABLE = new Set(["number", "date", "created_time", "updated_time", "auto_number"]);

export const isServerSortable = (base: ResolvedBase, slug: string): boolean => {
  const field = base.fields.get(slug);
  return field !== undefined && SERVER_SORTABLE.has(field.type);
};
