import { ScanLimitExceededError } from "busabase-orm-core";
import type { BusabaseClient } from "busabase-sdk";
import {
  and,
  asc,
  avg,
  between,
  count,
  countDistinct,
  desc,
  eq,
  gt,
  like,
  lt,
  max,
  min,
  sql,
  sum,
} from "drizzle-orm";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "./driver";

const contacts = pgTable("contacts", {
  id: text("id"),
  name: text("name"),
  stage: text("stage"),
  score: integer("score"),
  firm: text("firm"),
});

const companies = pgTable("companies", {
  id: text("id"),
  code: text("code"),
  city: text("city"),
});

interface FakeRecord {
  id: string;
  payload: Record<string, unknown>;
}

interface ValueFilterLeaf {
  fieldSlug: string;
  operator: string;
  value: number | string | boolean;
}

/** One CNF conjunct on the wire: a comparison, or a disjunction of them. */
type ValueFilterCall = ValueFilterLeaf | { any: ValueFilterLeaf[] };

interface ListCall {
  baseId?: string;
  limit?: number;
  filters?: unknown[];
  valueFilters?: ValueFilterCall[];
  sort?: unknown;
  cursor?: string;
}

/** The Base this fake serves, and the field types the comparison dispatches on. */
const FIELD_TYPES: Record<string, string> = {
  name: "text",
  stage: "select",
  score: "number",
  firm: "text",
  code: "text",
  city: "text",
};

/**
 * The server's exact comparison, reproduced for the fake — dispatching on FIELD
 * TYPE rather than on the shape of the incoming value, the way
 * `buildExactValueFilter` does.
 *
 * Faithfulness matters more here than convenience: this is the only model of
 * the server the unit tests have, so a fake that is more permissive than the
 * real thing turns a 400 into a green test. In particular text compares as
 * TEXT (`Number("Ada")` is NaN, and treating that as "no match" is what an
 * earlier numeric-only version of this fake did), and ordering on text is
 * refused rather than answered, because the server refuses it.
 */
const compareLeaf = (stored: unknown, filter: ValueFilterLeaf): boolean => {
  // No stored value never matches, including on the negative operators — the
  // server's EXISTS finds no row, which is SQL's UNKNOWN collapsed to false.
  if (stored === null || stored === undefined) return false;
  const type = FIELD_TYPES[filter.fieldSlug];

  if (type === "text" || type === "select") {
    if (filter.operator !== "eq" && filter.operator !== "ne") {
      throw new Error(`fake server: ${filter.operator} is not exact on text "${filter.fieldSlug}"`);
    }
    const equal = String(stored) === String(filter.value);
    return filter.operator === "eq" ? equal : !equal;
  }

  const left = typeof stored === "number" ? stored : Number(stored);
  const right = typeof filter.value === "number" ? filter.value : Number(filter.value);
  if (Number.isNaN(left) || Number.isNaN(right)) return false;
  switch (filter.operator) {
    case "eq":
      return left === right;
    case "ne":
      return left !== right;
    case "gt":
      return left > right;
    case "gte":
      return left >= right;
    case "lt":
      return left < right;
    case "lte":
      return left <= right;
    default:
      return false;
  }
};

/** A CNF conjunct: a leaf, or an OR of leaves. */
const matchesConjunct = (payload: Record<string, unknown>, filter: ValueFilterCall): boolean =>
  "any" in filter
    ? filter.any.some((leaf) => compareLeaf(payload[leaf.fieldSlug], leaf))
    : compareLeaf(payload[filter.fieldSlug], filter);

/**
 * A Busabase stand-in that reproduces the two behaviours the driver has to
 * survive: server-side filters are a **superset** (here, deliberately ignored
 * altogether), and listing is keyset-paginated.
 */
/**
 * A second Base, so joins have something to join to. Records are dispatched by
 * `baseId` the way a real server does — a fake that ignored it would let a join
 * "work" while reading the wrong table.
 */
const COMPANY_BASE = {
  id: "bas_2",
  slug: "companies",
  fields: [
    { slug: "code", type: "text" },
    { slug: "city", type: "text" },
  ],
};

const makeClient = (
  contactRecords: FakeRecord[],
  pageSize = 2,
  companyRecords: FakeRecord[] = [],
) => {
  const calls: ListCall[] = [];
  const created: Record<string, unknown>[] = [];
  const updated: { recordId: string; fields: Record<string, unknown> }[] = [];
  const deleted: string[] = [];

  const countCalls: ListCall[] = [];
  const groupByCalls: ListCall[] = [];
  const client = {
    bases: {
      list: async () => [
        {
          id: "bas_1",
          slug: "contacts",
          fields: [
            { slug: "name", type: "text" },
            { slug: "stage", type: "select" },
            { slug: "score", type: "number" },
            { slug: "firm", type: "text" },
          ],
        },
        COMPANY_BASE,
      ],
      createChangeRequest: async (input: { fields: Record<string, unknown> }) => {
        created.push(input.fields);
        return {
          materialized: true as const,
          id: `rec_new_${created.length}`,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          headCommit: { payload: input.fields },
        };
      },
    },
    records: {
      list: async (input: ListCall) => {
        calls.push(input);
        const records = input.baseId === COMPANY_BASE.id ? companyRecords : contactRecords;
        // Both contracts, side by side, exactly as the server implements them:
        // view `filters` are accepted and IGNORED (a legal superset), while
        // `valueFilters` are applied FAITHFULLY (they are authoritative).
        const matching = (input.valueFilters ?? []).reduce(
          (rows, filter) => rows.filter((row) => matchesConjunct(row.payload, filter)),
          records,
        );
        const start = input.cursor ? Number(input.cursor) : 0;
        const size = Math.min(input.limit ?? pageSize, pageSize);
        const slice = matching.slice(start, start + size);
        const next = start + size < matching.length ? String(start + size) : null;
        return {
          records: slice.map((record) => ({
            id: record.id,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            headCommit: { payload: record.payload },
          })),
          nextCursor: next,
        };
      },
      // `records.count` answers exactly, from the same value filters — so the
      // fake applies them the same way `list` does. It deliberately does NOT
      // page: a count that transferred rows would defeat its own purpose, and
      // the tests assert that no `list` call happened alongside it.
      count: async (input: ListCall) => {
        countCalls.push(input);
        // A real server REFUSES a filter naming a field the Base does not have,
        // and the driver uses that refusal to tell a server that APPLIES these
        // filters from an older one that silently strips them. A fake that
        // answered politely would make every exact push-down look unsupported.
        for (const filter of input.valueFilters ?? []) {
          const slugs =
            "any" in filter ? filter.any.map((leaf) => leaf.fieldSlug) : [filter.fieldSlug];
          for (const slug of slugs) {
            if (!FIELD_TYPES[slug]) {
              throw new Error(`valueFilters: this Base has no field "${slug}"`);
            }
          }
        }

        const records = input.baseId === COMPANY_BASE.id ? companyRecords : contactRecords;
        const matching = (input.valueFilters ?? []).reduce(
          (rows, filter) => rows.filter((row) => matchesConjunct(row.payload, filter)),
          records,
        );
        return { total: matching.length };
      },
      /**
       * Reproduces the server's NULL semantics deliberately: `sum`/`avg`/`min`/
       * `max` of a group with no values is NULL rather than 0, `count` over a
       * field counts PRESENT values (unlike the group's own record count), and
       * SQL bucketing gives a missing value its OWN group rather than folding
       * it. A fake that folded would let a grouped fast path look right here and
       * disagree with the scan path in production.
       */
      groupBy: async (
        input: ListCall & {
          fieldSlug?: string;
          bucketing?: string;
          aggregates?: { fn: string; fieldSlug: string }[];
        },
      ) => {
        groupByCalls.push(input);
        const records = input.baseId === COMPANY_BASE.id ? companyRecords : contactRecords;
        const matching = (input.valueFilters ?? []).reduce(
          (rows, filter) => rows.filter((row) => matchesConjunct(row.payload, filter)),
          records,
        );
        const buckets = new Map<unknown, typeof matching>();
        for (const row of matching) {
          const key = input.fieldSlug ? (row.payload[input.fieldSlug] ?? null) : null;
          buckets.set(key, [...(buckets.get(key) ?? []), row]);
        }
        if (matching.length === 0) return { groups: [], total: 0 };
        const groups = [...buckets.entries()].map(([value, rows]) => {
          const aggregates: Record<string, number | null> = {};
          for (const entry of input.aggregates ?? []) {
            const values = rows
              .map((row) => row.payload[entry.fieldSlug])
              .filter((v) => v !== null && v !== undefined)
              .map(Number)
              .filter((v) => Number.isFinite(v));
            const key = `${entry.fn}:${entry.fieldSlug}`;
            if (entry.fn === "count") aggregates[key] = values.length;
            else if (values.length === 0) aggregates[key] = null;
            else if (entry.fn === "sum") aggregates[key] = values.reduce((a, b) => a + b, 0);
            else if (entry.fn === "avg")
              aggregates[key] = values.reduce((a, b) => a + b, 0) / values.length;
            else if (entry.fn === "min") aggregates[key] = Math.min(...values);
            else aggregates[key] = Math.max(...values);
          }
          return { value, count: rows.length, aggregates };
        });
        return { groups, total: matching.length };
      },
      changeRequest: async (input: {
        recordId: string;
        operation: string;
        fields?: Record<string, unknown>;
      }) => {
        if (input.operation === "delete") {
          deleted.push(input.recordId);
          // A real server MERGES this when the credential has write access, so
          // the record is gone by the time the call returns. Returning
          // `materialized: false` here would model the no-permission case, and
          // modelling only that let a pending delete read as a success.
          return { materialized: true as const, id: "cr_del" };
        }
        updated.push({ recordId: input.recordId, fields: input.fields ?? {} });
        return {
          materialized: true as const,
          id: input.recordId,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
          headCommit: { payload: input.fields ?? {} },
        };
      },
    },
  } as unknown as BusabaseClient;

  return { client, calls, countCalls, groupByCalls, created, updated, deleted };
};

const dataset: FakeRecord[] = [
  { id: "rec_1", payload: { name: "Ada", stage: "won", score: 90 } },
  { id: "rec_2", payload: { name: "Bo", stage: "lost", score: 10 } },
  { id: "rec_3", payload: { name: "Cy", stage: "won", score: 70 } },
  { id: "rec_4", payload: { name: "Di", stage: "lost", score: 20 } },
  { id: "rec_5", payload: { name: "Ed", stage: "won", score: 50 } },
  { id: "rec_6", payload: { name: "Fi", stage: "won", score: 30 } },
];

describe("select", () => {
  let fake: ReturnType<typeof makeClient>;
  beforeEach(() => {
    fake = makeClient(dataset);
  });

  it("returns only rows matching the predicate even when the server ignores filters", async () => {
    const db = drizzle(fake.client);
    const rows = await db.select().from(contacts).where(eq(contacts.stage, "won"));
    expect(rows.map((row) => row.name)).toEqual(["Ada", "Cy", "Ed", "Fi"]);
  });

  it("does not push limit down while a local predicate is still deciding", async () => {
    // `like` has no exact form, so the server's answer is a superset. Pushing
    // `limit 3` would let its non-matching rows eat the budget and yield a
    // short, wrong page.
    //
    // This used to be written with `eq` on a TEXT field, which was inexact only
    // because the API had no exact text comparison. It does now, so that query
    // legitimately pushes its limit (see the test below) and no longer
    // exercises this invariant — the invariant itself is unchanged.
    const db = drizzle(fake.client);
    const rows = await db.select().from(contacts).where(like(contacts.stage, "wo%")).limit(3);
    expect(rows.map((row) => row.name)).toEqual(["Ada", "Cy", "Ed"]);
    expect(fake.calls.some((call) => call.limit === 3)).toBe(false);
  });

  it("pushes limit down alongside an exact TEXT comparison", async () => {
    // The gain from widening `valueFilters` to text equality: one round trip
    // for one page, instead of paging the whole Base to decide locally.
    const db = drizzle(fake.client, { pageSize: 100 });
    const rows = await db.select().from(contacts).where(eq(contacts.stage, "won")).limit(2);
    expect(rows.map((row) => row.name)).toEqual(["Ada", "Cy"]);
    expect(fake.calls[0]?.limit).toBe(2);
    expect(fake.calls[0]?.valueFilters).toEqual([
      { fieldSlug: "stage", operator: "eq", value: "won" },
    ]);
  });

  it("pushes limit down when there is nothing to narrow", async () => {
    const db = drizzle(fake.client, { pageSize: 100 });
    const rows = await db.select().from(contacts).limit(2);
    expect(rows).toHaveLength(2);
    expect(fake.calls[0]?.limit).toBe(2);
  });

  it("applies offset", async () => {
    const db = drizzle(fake.client);
    const rows = await db
      .select()
      .from(contacts)
      .where(eq(contacts.stage, "won"))
      .limit(2)
      .offset(1);
    expect(rows.map((row) => row.name)).toEqual(["Cy", "Ed"]);
  });

  it("evaluates operators Busabase cannot express, locally", async () => {
    const db = drizzle(fake.client);
    const rows = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.stage, "won"), gt(contacts.score, 40)));
    expect(rows.map((row) => row.name)).toEqual(["Ada", "Cy", "Ed"]);
  });

  it("pushes down what it safely can", async () => {
    const db = drizzle(fake.client);
    await db.select().from(contacts).where(eq(contacts.stage, "won"));
    // fieldType is load-bearing, not decoration: the server's
    // `buildPushableRecordFilter` reads `filter.fieldType ?? ""` and drops any
    // filter whose type matches none of its branches. Without it every
    // push-down is silently discarded and the whole Base comes back.
    expect(fake.calls[0]?.filters).toEqual([
      { fieldSlug: "stage", operator: "equals", value: "won", fieldType: "select" },
    ]);
  });

  it("pushes a number sort to the server and keeps a text sort local", async () => {
    const db = drizzle(fake.client, { pageSize: 100 });
    await db.select().from(contacts).orderBy(asc(contacts.score));
    // Same for sort: the server resolves its sort column via
    // `sortColumnFor(sort.fieldType)`, so an unstamped key silently falls back
    // to createdAt ordering.
    expect(fake.calls[0]?.sort).toEqual({
      fieldSlug: "score",
      direction: "asc",
      fieldType: "number",
    });

    fake.calls.length = 0;
    const rows = await db.select().from(contacts).orderBy(desc(contacts.name));
    expect(fake.calls[0]?.sort).toBeUndefined();
    expect(rows.map((row) => row.name)).toEqual(["Fi", "Ed", "Di", "Cy", "Bo", "Ada"]);
  });

  it("selects a projection", async () => {
    const db = drizzle(fake.client);
    const rows = await db
      .select({ who: contacts.name })
      .from(contacts)
      .where(eq(contacts.name, "Ada"));
    expect(rows).toEqual([{ who: "Ada" }]);
  });

  it("falls back to the record id for a column the Base does not define", async () => {
    const db = drizzle(fake.client);
    const rows = await db.select().from(contacts).where(eq(contacts.name, "Ada"));
    expect(rows[0]?.id).toBe("rec_1");
  });

  it("fails loudly instead of truncating when the scan budget runs out", async () => {
    // `like` has no value-filter form, so this genuinely has to be scanned.
    const db = drizzle(fake.client, { maxScannedRecords: 3 });
    await expect(db.select().from(contacts).where(like(contacts.name, "%a%"))).rejects.toThrow(
      ScanLimitExceededError,
    );
  });
});

describe("exact value filters", () => {
  let fake: ReturnType<typeof makeClient>;
  beforeEach(() => {
    fake = makeClient(dataset);
  });

  it("sends a comparison the server can decide", async () => {
    const db = drizzle(fake.client, { pageSize: 100 });
    const rows = await db.select().from(contacts).where(gt(contacts.score, 40));
    expect(fake.calls[0]?.valueFilters).toEqual([
      { fieldSlug: "score", operator: "gt", value: 40 },
    ]);
    expect(rows.map((row) => row.name)).toEqual(["Ada", "Cy", "Ed"]);
  });

  it("splits between into the gte/lte pair", async () => {
    const db = drizzle(fake.client, { pageSize: 100 });
    const rows = await db
      .select()
      .from(contacts)
      .where(between(contacts.score, 30, 70));
    expect(fake.calls[0]?.valueFilters).toEqual([
      { fieldSlug: "score", operator: "gte", value: 30 },
      { fieldSlug: "score", operator: "lte", value: 70 },
    ]);
    expect(rows.map((row) => row.name)).toEqual(["Cy", "Ed", "Fi"]);
  });

  it("pushes limit down once the server decides the whole where clause", async () => {
    // What exactness buys, and what a superset filter can never have: the limit
    // rides along instead of being applied locally.
    const db = drizzle(fake.client, { pageSize: 100 });
    const rows = await db.select().from(contacts).where(gt(contacts.score, 40)).limit(2);
    expect(fake.calls[0]?.limit).toBe(2);
    expect(rows.map((row) => row.name)).toEqual(["Ada", "Cy"]);
  });

  it("scans no further than it must — a tiny budget is fine when the server filters", async () => {
    // The same shape of query that exhausts a 3-record budget when scanned.
    const db = drizzle(fake.client, { maxScannedRecords: 3, pageSize: 100 });
    const rows = await db.select().from(contacts).where(gt(contacts.score, 40));
    expect(rows).toHaveLength(3);
  });

  it("keeps a field with no exact value column off the wire", async () => {
    // `stage` is text: the server would 400 on it, so the candidate is dropped
    // and that condition falls back to the local predicate.
    const db = drizzle(fake.client, { pageSize: 100 });
    const rows = await db.select().from(contacts).where(gt(contacts.stage, "a"));
    expect(fake.calls[0]?.valueFilters).toBeUndefined();
    expect(rows.map((row) => row.name).sort()).toEqual(["Ada", "Bo", "Cy", "Di", "Ed", "Fi"]);
  });

  it("does not push limit when one condition is left to the client", async () => {
    const db = drizzle(fake.client, { pageSize: 100 });
    const rows = await db
      .select()
      .from(contacts)
      .where(and(gt(contacts.score, 40), like(contacts.name, "%d%")))
      .limit(1);
    // The comparison still rides along; the limit cannot.
    expect(fake.calls[0]?.valueFilters).toEqual([
      { fieldSlug: "score", operator: "gt", value: 40 },
    ]);
    expect(fake.calls[0]?.limit).not.toBe(1);
    expect(rows.map((row) => row.name)).toEqual(["Ada"]);
  });
});

describe("write", () => {
  it("inserts through a change request", async () => {
    const fake = makeClient([]);
    const db = drizzle(fake.client);
    const rows = await db
      .insert(contacts)
      .values({ name: "Gil", stage: "new", score: 5 })
      .returning();
    expect(fake.created).toEqual([{ name: "Gil", stage: "new", score: 5 }]);
    expect(rows[0]?.name).toBe("Gil");
  });

  it("carries untouched fields through an update", async () => {
    const fake = makeClient(dataset);
    const db = drizzle(fake.client);
    await db.update(contacts).set({ stage: "won" }).where(eq(contacts.name, "Bo"));
    expect(fake.updated).toEqual([
      { recordId: "rec_2", fields: { name: "Bo", stage: "won", score: 10 } },
    ]);
  });

  it("refuses delete by default, because a Busabase delete ARCHIVES rather than removes", async () => {
    const fake = makeClient(dataset);
    const db = drizzle(fake.client);
    await expect(db.delete(contacts).where(eq(contacts.name, "Bo"))).rejects.toThrow(/ARCHIVES/);
    expect(fake.deleted).toEqual([]);
  });

  it("deletes once opted in", async () => {
    const fake = makeClient(dataset);
    const db = drizzle(fake.client, { allowArchivingDelete: true });
    await db.delete(contacts).where(eq(contacts.name, "Bo"));
    expect(fake.deleted).toEqual(["rec_2"]);
  });

  it("still accepts the 0.1.x option name", async () => {
    const fake = makeClient(dataset);
    const db = drizzle(fake.client, { allowReviewFirstDelete: true });
    await db.delete(contacts).where(eq(contacts.name, "Bo"));
    expect(fake.deleted).toEqual(["rec_2"]);
  });

  it("throws rather than report a delete that is only PROPOSED", async () => {
    // Without write access the change request stays pending and the record is
    // still there. `insert` and `update` both guard against reporting that as
    // success; `delete` did not, so `await db.delete(...)` resolved while the
    // rows remained — the one failure the local predicate cannot catch later.
    const fake = makeClient(dataset);
    const client = new Proxy(fake.client, {
      get(target, prop) {
        if (prop !== "records") return Reflect.get(target, prop);
        const records = Reflect.get(target, prop) as Record<string, unknown>;
        return new Proxy(records, {
          get(inner, innerProp) {
            if (innerProp !== "changeRequest") return Reflect.get(inner, innerProp);
            const original = Reflect.get(inner, innerProp) as (i: {
              operation: string;
            }) => Promise<unknown>;
            return async (input: { operation: string }) =>
              input.operation === "delete"
                ? { materialized: false as const, id: "cr_pending" }
                : original(input);
          },
        });
      },
    });
    const db = drizzle(client, { allowArchivingDelete: true });
    await expect(db.delete(contacts).where(eq(contacts.name, "Bo"))).rejects.toThrow(
      /awaiting review — the record is STILL THERE/,
    );
  });
});

describe("refusals", () => {
  it("still names an unknown table clearly when a join points at one", async () => {
    // Joins are supported now (see the `joins` suite), so this no longer tests
    // a refusal to join — it tests that the failure a typo produces still says
    // which Base could not be found rather than blaming the join.
    const fake = makeClient(dataset);
    const db = drizzle(fake.client);
    const other = pgTable("nope", { id: text("id") });
    await expect(
      db.select().from(contacts).leftJoin(other, eq(contacts.id, other.id)),
    ).rejects.toThrow(/no Base with s/);
  });

  it("rejects transactions with a pointer at the ChangeRequest boundary", async () => {
    const fake = makeClient(dataset);
    const db = drizzle(fake.client);
    await expect(db.transaction(async () => undefined)).rejects.toThrow(/ChangeRequest/);
  });
});

describe("result shaping", () => {
  it("assembles a nested selection into nested objects", async () => {
    const fake = makeClient(dataset);
    const db = drizzle(fake.client, { pageSize: 100 });
    const rows = await db
      .select({ who: { label: contacts.name }, stage: contacts.stage })
      .from(contacts)
      .where(eq(contacts.name, "Ada"));
    expect(rows).toEqual([{ who: { label: "Ada" }, stage: "won" }]);
  });

  it("refuses to select a computed expression", async () => {
    const fake = makeClient(dataset);
    const db = drizzle(fake.client, { pageSize: 100 });
    await expect(
      db.select({ shouted: sql<string>`upper(${contacts.name})` }).from(contacts),
    ).rejects.toThrow(/only select plain columns/);
  });
});

describe("writes that land in review", () => {
  // The credential lacking write access is not an error the API reports — the
  // change simply becomes a pending ChangeRequest. Reporting success there would
  // tell the caller a row exists when it does not.
  const reviewingClient = () => {
    const base = makeClient(dataset);
    const client = new Proxy(base.client, {
      get(target, prop) {
        if (prop === "bases") {
          const bases = Reflect.get(target, prop) as Record<string, unknown>;
          return new Proxy(bases, {
            get(bt, bp) {
              if (bp !== "createChangeRequest") return Reflect.get(bt, bp);
              return async () => ({ materialized: false as const, id: "cr_pending" });
            },
          });
        }
        if (prop === "records") {
          const records = Reflect.get(target, prop) as Record<string, unknown>;
          return new Proxy(records, {
            get(rt, rp) {
              if (rp !== "changeRequest") return Reflect.get(rt, rp);
              const original = Reflect.get(rt, rp) as (i: {
                operation: string;
              }) => Promise<unknown>;
              return async (input: { operation: string }) =>
                input.operation === "update"
                  ? { materialized: false as const, id: "cr_pending" }
                  : original(input);
            },
          });
        }
        return Reflect.get(target, prop);
      },
    });
    return { ...base, client: client as typeof base.client };
  };

  it("throws on an insert that is awaiting review, naming the ChangeRequest", async () => {
    const db = drizzle(reviewingClient().client, { pageSize: 100 });
    await expect(
      db.insert(contacts).values({ name: "Gil", stage: "new", score: 5 }),
    ).rejects.toThrow(/cr_pending.*awaiting review|awaiting review.*cr_pending/);
  });

  it("says the insert is not lost", async () => {
    const db = drizzle(reviewingClient().client, { pageSize: 100 });
    await expect(
      db.insert(contacts).values({ name: "Gil", stage: "new", score: 5 }),
    ).rejects.toThrow(/NOT lost/);
  });

  it("throws on an update that is awaiting review", async () => {
    const db = drizzle(reviewingClient().client, { pageSize: 100 });
    await expect(
      db.update(contacts).set({ stage: "won" }).where(eq(contacts.name, "Bo")),
    ).rejects.toThrow(/awaiting review — the record is unchanged/);
  });
});

describe("aggregates", () => {
  let fake: ReturnType<typeof makeClient>;
  beforeEach(() => {
    fake = makeClient(dataset);
  });

  // Aggregates used to raise. They are arithmetic over rows the driver already
  // fetches, so refusing them only pushed the caller into doing the same scan
  // by hand — without the scan budget, and without SQL's NULL semantics.

  describe("count() takes the server's own count when it can", () => {
    it("answers a bare count without transferring a single record", async () => {
      const db = drizzle(fake.client);
      const rows = await db.select({ n: count() }).from(contacts);
      expect(rows).toEqual([{ n: 6 }]);
      // The whole point: one round trip to `records.count`, and no listing.
      expect(fake.countCalls).toHaveLength(1);
      expect(fake.calls).toHaveLength(0);
    });

    it("carries an exact where clause into the server's count", async () => {
      const db = drizzle(fake.client);
      const rows = await db.select({ n: count() }).from(contacts).where(gt(contacts.score, 40));
      // The FIRST count is the capability probe — a deliberately impossible
      // field slug, which a server that applies `valueFilters` refuses and an
      // older one answers. The real query follows it.
      expect(fake.countCalls[0]?.valueFilters).toEqual([
        { fieldSlug: "__busabase_orm_capability_probe__", operator: "eq", value: 1 },
      ]);
      expect(fake.countCalls[1]?.valueFilters).toEqual([
        { fieldSlug: "score", operator: "gt", value: 40 },
      ]);
      expect(fake.calls).toHaveLength(0);
      expect(rows[0]?.n).toBeGreaterThan(0);
    });

    it("probes the server ONCE per client, not once per query", async () => {
      // The probe is an extra round trip; paying it on every query would be a
      // real cost on the happy path.
      const db = drizzle(fake.client);
      await db.select({ n: count() }).from(contacts).where(gt(contacts.score, 40));
      await db.select({ n: count() }).from(contacts).where(gt(contacts.score, 10));
      const probes = fake.countCalls.filter((call) =>
        JSON.stringify(call.valueFilters ?? []).includes("__busabase_orm_capability_probe__"),
      );
      expect(probes).toHaveLength(1);
    });

    it("falls back to counting locally when the where clause is not fully exact", async () => {
      // `records.count` answers EXACTLY, so handing it a clause it only partly
      // understands would give a confident wrong number — and a count is the
      // one result nobody double-checks. It scans instead.
      const db = drizzle(fake.client);
      const rows = await db.select({ n: count() }).from(contacts).where(like(contacts.name, "A%"));
      expect(fake.countCalls).toHaveLength(0);
      expect(fake.calls.length).toBeGreaterThan(0);
      expect(rows[0]?.n).toBe(1); // Ada
    });

    it("agrees with the row count from the same query", async () => {
      const db = drizzle(fake.client);
      const counted = await db.select({ n: count() }).from(contacts).where(gt(contacts.score, 40));
      const listed = await db.select().from(contacts).where(gt(contacts.score, 40));
      expect(counted[0]?.n).toBe(listed.length);
    });
  });

  describe("ungrouped aggregates take the server's own", () => {
    it("sums server-side, transferring no records", async () => {
      const db = drizzle(fake.client, { pageSize: 100 });
      const rows = await db.select({ total: sum(contacts.score) }).from(contacts);
      expect(rows).toEqual([{ total: "270" }]); // 90+10+70+20+50+30
      expect(fake.groupByCalls).toHaveLength(1);
      expect(fake.calls).toHaveLength(0);
    });

    it("carries an exact where clause into the server aggregate", async () => {
      const db = drizzle(fake.client, { pageSize: 100 });
      const rows = await db
        .select({ total: sum(contacts.score), highest: max(contacts.score) })
        .from(contacts)
        .where(gt(contacts.score, 40));
      expect(rows).toEqual([{ total: "210", highest: 90 }]); // 90+70+50
      expect(fake.groupByCalls[0]?.valueFilters).toEqual([
        { fieldSlug: "score", operator: "gt", value: 40 },
      ]);
      expect(fake.calls).toHaveLength(0);
    });

    it("keeps drizzle's declared types — sum/avg strings, min/max native", async () => {
      const db = drizzle(fake.client, { pageSize: 100 });
      const [row] = await db
        .select({
          total: sum(contacts.score),
          mean: avg(contacts.score),
          lowest: min(contacts.score),
          n: count(contacts.id),
        })
        .from(contacts);
      expect(typeof row?.total).toBe("string");
      expect(typeof row?.mean).toBe("string");
      expect(typeof row?.lowest).toBe("number");
      expect(row?.n).toBe(6);
    });

    it("falls back to scanning when the where clause is not fully exact", async () => {
      const db = drizzle(fake.client, { pageSize: 100 });
      const rows = await db
        .select({ total: sum(contacts.score) })
        .from(contacts)
        .where(like(contacts.name, "A%"));
      expect(rows).toEqual([{ total: "90" }]); // Ada only
      expect(fake.groupByCalls).toHaveLength(0);
      expect(fake.calls.length).toBeGreaterThan(0);
    });

    it("falls back for a DISTINCT aggregate, which the endpoint does not offer", async () => {
      const db = drizzle(fake.client, { pageSize: 100 });
      await db.select({ n: countDistinct(contacts.stage) }).from(contacts);
      expect(fake.groupByCalls).toHaveLength(0);
      expect(fake.calls.length).toBeGreaterThan(0);
    });

    it("falls back for an aggregate over a field with no numeric column", async () => {
      const db = drizzle(fake.client, { pageSize: 100 });
      await db.select({ lowest: min(contacts.name) }).from(contacts);
      expect(fake.groupByCalls).toHaveLength(0);
      expect(fake.calls.length).toBeGreaterThan(0);
    });

    it("agrees with the scan path it replaced", async () => {
      const db = drizzle(fake.client, { pageSize: 100 });
      const fast = await db
        .select({ total: sum(contacts.score) })
        .from(contacts)
        .where(gt(contacts.score, 40));
      // The same query with a locally-decided condition takes the scan path.
      const scanned = await db
        .select({ total: sum(contacts.score) })
        .from(contacts)
        .where(and(gt(contacts.score, 40), like(contacts.stage, "%")));
      expect(fast[0]?.total).toBe(scanned[0]?.total);
    });
  });

  describe("grouped aggregates", () => {
    it("takes the SERVER's grouped aggregate, transferring no records", async () => {
      // `stage` is a select, which the server can bucket with SQL semantics —
      // so this is one round trip rather than a scan.
      const db = drizzle(fake.client, { pageSize: 100 });
      const rows = await db
        .select({ stage: contacts.stage, n: count(), total: sum(contacts.score) })
        .from(contacts)
        .groupBy(contacts.stage)
        .orderBy(asc(contacts.stage));
      expect(rows).toEqual([
        { stage: "lost", n: 2, total: "30" },
        { stage: "won", n: 4, total: "240" },
      ]);
      expect(fake.groupByCalls[0]).toMatchObject({ fieldSlug: "stage", bucketing: "sql" });
      expect(fake.calls).toHaveLength(0);
    });

    it("falls back to scanning when the group field cannot be bucketed with SQL semantics", async () => {
      // `name` is text: `value_text` is truncated at a projection limit, so two
      // long values could share a bucket. The server refuses it and the driver
      // groups locally rather than sending a request it knows would 400.
      const db = drizzle(fake.client, { pageSize: 100 });
      const rows = await db
        .select({ name: contacts.name, n: count() })
        .from(contacts)
        .groupBy(contacts.name);
      expect(rows).toHaveLength(6);
      expect(fake.groupByCalls).toHaveLength(0);
      expect(fake.calls.length).toBeGreaterThan(0);
    });

    it("agrees with the scan path it replaced", async () => {
      const db = drizzle(fake.client, { pageSize: 100 });
      const fast = await db
        .select({ stage: contacts.stage, total: sum(contacts.score) })
        .from(contacts)
        .groupBy(contacts.stage)
        .orderBy(asc(contacts.stage));
      // A locally-decided condition forces the scan path for the same question.
      const scanned = await db
        .select({ stage: contacts.stage, total: sum(contacts.score) })
        .from(contacts)
        .where(like(contacts.name, "%"))
        .groupBy(contacts.stage)
        .orderBy(asc(contacts.stage));
      expect(fast).toEqual(scanned);
    });

    it("groups by a column and counts each bucket", async () => {
      const db = drizzle(fake.client);
      const rows = await db
        .select({ stage: contacts.stage, n: count() })
        .from(contacts)
        .groupBy(contacts.stage);
      expect(rows).toEqual([
        { stage: "won", n: 4 }, // Ada, Cy, Ed, Fi
        { stage: "lost", n: 2 }, // Bo, Di
      ]);
    });

    it("computes sum, avg, min and max per group", async () => {
      const db = drizzle(fake.client);
      const rows = await db
        .select({
          stage: contacts.stage,
          total: sum(contacts.score),
          mean: avg(contacts.score),
          lowest: min(contacts.score),
          highest: max(contacts.score),
        })
        .from(contacts)
        .groupBy(contacts.stage)
        .orderBy(contacts.stage);
      expect(rows).toEqual([
        { stage: "lost", total: "30", mean: "15", lowest: 10, highest: 20 },
        { stage: "won", total: "240", mean: "60", lowest: 30, highest: 90 },
      ]);
    });

    it("narrows the input with the where clause before aggregating", async () => {
      const db = drizzle(fake.client);
      const rows = await db
        .select({ stage: contacts.stage, n: count() })
        .from(contacts)
        .where(gt(contacts.score, 40))
        .groupBy(contacts.stage);
      expect(rows).toEqual([{ stage: "won", n: 3 }]); // Ada, Cy, Ed
    });

    it("orders the GROUPS, by a grouped column or by a selected aggregate", async () => {
      const db = drizzle(fake.client);
      const byCount = await db
        .select({ stage: contacts.stage, n: count() })
        .from(contacts)
        .groupBy(contacts.stage)
        .orderBy(desc(count()));
      expect(byCount.map((row) => row.stage)).toEqual(["won", "lost"]);

      const byStage = await db
        .select({ stage: contacts.stage, n: count() })
        .from(contacts)
        .groupBy(contacts.stage)
        .orderBy(asc(contacts.stage));
      expect(byStage.map((row) => row.stage)).toEqual(["lost", "won"]);
    });

    it("applies limit and offset to the GROUPS, not to the records", async () => {
      // Pushing them at the record level would truncate the input to the
      // aggregation and report a confidently wrong total.
      const db = drizzle(fake.client);
      const rows = await db
        .select({ stage: contacts.stage, n: count() })
        .from(contacts)
        .groupBy(contacts.stage)
        .orderBy(asc(contacts.stage))
        .limit(1);
      expect(rows).toEqual([{ stage: "lost", n: 2 }]);
      // Every record still had to be read to make that number right.
      expect(fake.calls.some((call) => call.limit === 1)).toBe(false);
    });

    it("refuses to order a grouped query by something it does not select", async () => {
      const db = drizzle(fake.client);
      await expect(
        db
          .select({ stage: contacts.stage, n: count() })
          .from(contacts)
          .groupBy(contacts.stage)
          .orderBy(desc(sum(contacts.score))),
      ).rejects.toThrow(/order a grouped query by something it also selects/);
    });

    it("treats GROUP BY with no aggregate as a distinct, one row per group", async () => {
      const db = drizzle(fake.client);
      const rows = await db
        .select({ stage: contacts.stage })
        .from(contacts)
        .groupBy(contacts.stage);
      expect(rows).toEqual([{ stage: "won" }, { stage: "lost" }]);
    });
  });
});

describe("joins", () => {
  // Refused outright before this branch, on the argument that emulating a join
  // "would silently read whole Bases". Half of that stopped being true here:
  // the joined side is fetched BY KEY now that a multi-value IN pushes down as
  // a disjunction. The other half — the driving table is read in full unless
  // the whole where belongs to it — is real, bounded, and asserted below.
  const contactRows: FakeRecord[] = [
    { id: "rec_1", payload: { name: "Ada", stage: "won", score: 90, firm: "acme" } },
    { id: "rec_2", payload: { name: "Bo", stage: "lost", score: 10, firm: "zeta" } },
    { id: "rec_3", payload: { name: "Cy", stage: "won", score: 70, firm: "acme" } },
    { id: "rec_4", payload: { name: "Di", stage: "lost", score: 20 } }, // no firm
  ];
  const companyRows: FakeRecord[] = [
    { id: "co_1", payload: { code: "acme", city: "NY" } },
    { id: "co_2", payload: { code: "zeta", city: "LA" } },
    { id: "co_3", payload: { code: "orphan", city: "SF" } },
  ];

  let fake: ReturnType<typeof makeClient>;
  beforeEach(() => {
    fake = makeClient(contactRows, 100, companyRows);
  });

  const db = () => drizzle(fake.client, { pageSize: 100 });

  it("inner joins on a field, keeping only matched rows", async () => {
    const rows = await db()
      .select({ who: contacts.name, city: companies.city })
      .from(contacts)
      .innerJoin(companies, eq(contacts.firm, companies.code));
    expect(rows).toEqual([
      { who: "Ada", city: "NY" },
      { who: "Bo", city: "LA" },
      { who: "Cy", city: "NY" },
    ]);
  });

  it("left joins, keeping the unmatched driving row with nulls", async () => {
    const rows = await db()
      .select({ who: contacts.name, city: companies.city })
      .from(contacts)
      .leftJoin(companies, eq(contacts.firm, companies.code));
    // "Di" has no firm at all — SQL keeps it with a NULL right side.
    expect(rows).toContainEqual({ who: "Di", city: null });
    expect(rows).toHaveLength(4);
  });

  it("fetches the joined table BY KEY rather than scanning it", async () => {
    await db()
      .select({ who: contacts.name, city: companies.city })
      .from(contacts)
      .innerJoin(companies, eq(contacts.firm, companies.code));
    const companyCall = fake.calls.find((call) => call.baseId === "bas_2");
    // The distinct firms are acme and zeta — "orphan" is never asked for.
    expect(companyCall?.valueFilters).toEqual([
      {
        any: [
          { fieldSlug: "code", operator: "eq", value: "acme" },
          { fieldSlug: "code", operator: "eq", value: "zeta" },
        ],
      },
    ]);
  });

  it("right joins, keeping the unmatched joined row", async () => {
    // The hash join fetches the joined side BY KEY, which is exactly what a
    // right join must not do: "orphan" is referenced by no contact, so fetching
    // only the keys the left side holds would drop the row a right join exists
    // to keep.
    const rows = await db()
      .select({ who: contacts.name, city: companies.city })
      .from(contacts)
      .rightJoin(companies, eq(contacts.firm, companies.code));
    expect(rows).toContainEqual({ who: null, city: "SF" });
  });

  it("pushes a where that belongs entirely to the driving table", async () => {
    await db()
      .select({ who: contacts.name, city: companies.city })
      .from(contacts)
      .innerJoin(companies, eq(contacts.firm, companies.code))
      .where(eq(contacts.stage, "won"));
    const contactCall = fake.calls.find((call) => call.baseId === "bas_1");
    expect(contactCall?.valueFilters).toEqual([
      { fieldSlug: "stage", operator: "eq", value: "won" },
    ]);
  });

  it("still answers correctly when the where spans BOTH tables", async () => {
    // Nothing to push here — the clause cannot be split back apart — so the
    // driving table is read in full and the predicate runs on the joined row.
    const rows = await db()
      .select({ who: contacts.name, city: companies.city })
      .from(contacts)
      .innerJoin(companies, eq(contacts.firm, companies.code))
      .where(and(eq(contacts.stage, "won"), eq(companies.city, "NY")));
    expect(rows).toEqual([
      { who: "Ada", city: "NY" },
      { who: "Cy", city: "NY" },
    ]);
    const contactCall = fake.calls.find((call) => call.baseId === "bas_1");
    expect(contactCall?.valueFilters ?? []).toEqual([]);
  });

  it("resolves an ambiguous column name to the table the user wrote", async () => {
    // Both tables have an `id`. A bare-name lookup would pick one of them.
    const rows = await db()
      .select({ contact: contacts.id, company: companies.id })
      .from(contacts)
      .innerJoin(companies, eq(contacts.firm, companies.code));
    expect(rows[0]).toEqual({ contact: "rec_1", company: "co_1" });
  });

  it("orders and limits the JOINED rows", async () => {
    const rows = await db()
      .select({ who: contacts.name, city: companies.city })
      .from(contacts)
      .innerJoin(companies, eq(contacts.firm, companies.code))
      .orderBy(desc(contacts.name))
      .limit(2);
    expect(rows).toEqual([
      { who: "Cy", city: "NY" },
      { who: "Bo", city: "LA" },
    ]);
  });

  it("selectAll nests each table under its own key", async () => {
    const rows = await db()
      .select()
      .from(contacts)
      .innerJoin(companies, eq(contacts.firm, companies.code));
    expect(rows[0]).toEqual({
      contacts: { id: "rec_1", name: "Ada", stage: "won", score: 90, firm: "acme" },
      companies: { id: "co_1", code: "acme", city: "NY" },
    });
  });

  it("refuses an ON it cannot hash on, rather than approximating", async () => {
    await expect(
      db()
        .select({ who: contacts.name })
        .from(contacts)
        .innerJoin(companies, gt(contacts.firm, companies.code)),
    ).rejects.toThrow(/not an equality/);
  });

  it("fails loudly rather than truncating when the driving table blows the budget", async () => {
    const tiny = drizzle(fake.client, { pageSize: 100, maxScannedRecords: 2 });
    await expect(
      tiny
        .select({ who: contacts.name })
        .from(contacts)
        .innerJoin(companies, eq(contacts.firm, companies.code)),
    ).rejects.toThrow(ScanLimitExceededError);
  });
});

describe("set operations", () => {
  let fake: ReturnType<typeof makeClient>;
  let db: ReturnType<typeof drizzle>;
  beforeEach(() => {
    // pageSize 100 on BOTH sides: the fake caps each page at its own pageSize,
    // so a default (2) fake would page each branch twice and the request counts
    // below would be measuring pagination rather than push-down.
    fake = makeClient(dataset, 100);
    db = drizzle(fake.client, { pageSize: 100 });
  });

  it("unions two branches and dedupes the combined ROWS", async () => {
    // Both branches project only `stage`, and several records share one — so
    // the union collapses them. Deduping by record id would have returned every
    // record, which is the mistake this asserts against.
    const rows = await db
      .select({ stage: contacts.stage })
      .from(contacts)
      .where(gt(contacts.score, 40))
      .union(db.select({ stage: contacts.stage }).from(contacts).where(lt(contacts.score, 40)));
    expect(rows).toEqual([{ stage: "won" }, { stage: "lost" }]);
  });

  it("keeps duplicates with unionAll", async () => {
    const rows = await db
      .select({ stage: contacts.stage })
      .from(contacts)
      .where(gt(contacts.score, 40))
      .unionAll(db.select({ stage: contacts.stage }).from(contacts).where(lt(contacts.score, 40)));
    expect(rows).toHaveLength(6); // every record, nothing collapsed
  });

  it("runs each branch as its own query, so each keeps its push-down", async () => {
    // The reason to combine at this level rather than scan: a union of two
    // narrow queries stays two narrow requests.
    await db
      .select({ who: contacts.name })
      .from(contacts)
      .where(gt(contacts.score, 40))
      .union(db.select({ who: contacts.name }).from(contacts).where(lt(contacts.score, 40)));
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]?.valueFilters).toEqual([
      { fieldSlug: "score", operator: "gt", value: 40 },
    ]);
    expect(fake.calls[1]?.valueFilters).toEqual([
      { fieldSlug: "score", operator: "lt", value: 40 },
    ]);
  });

  it("intersects and excepts", async () => {
    const won = () =>
      db.select({ who: contacts.name }).from(contacts).where(eq(contacts.stage, "won"));
    const high = () =>
      db.select({ who: contacts.name }).from(contacts).where(gt(contacts.score, 40));

    expect((await won().intersect(high())).map((row) => row.who).sort()).toEqual([
      "Ada",
      "Cy",
      "Ed",
    ]);
    expect((await won().except(high())).map((row) => row.who)).toEqual(["Fi"]);
  });

  it("chains three branches, folding left to right", async () => {
    const at = (score: number) =>
      db.select({ who: contacts.name }).from(contacts).where(eq(contacts.score, score));
    const rows = await at(90).union(at(10)).union(at(70));
    expect(rows.map((row) => row.who)).toEqual(["Ada", "Bo", "Cy"]);
    expect(fake.calls).toHaveLength(3);
  });

  it("orders and limits the COMBINED result, not the branches", async () => {
    const rows = await db
      .select({ who: contacts.name })
      .from(contacts)
      .where(gt(contacts.score, 40))
      .union(db.select({ who: contacts.name }).from(contacts).where(lt(contacts.score, 40)))
      .orderBy(desc(contacts.name))
      .limit(2);
    expect(rows.map((row) => row.who)).toEqual(["Fi", "Ed"]);
    // A limit pushed into a branch would have truncated the union's input.
    expect(fake.calls.some((call) => call.limit === 2)).toBe(false);
  });

  it("refuses to order by a column that is not in the combined projection", async () => {
    await expect(
      db
        .select({ who: contacts.name })
        .from(contacts)
        .union(db.select({ who: contacts.name }).from(contacts))
        .orderBy(desc(contacts.score)),
    ).rejects.toThrow(/not one of the combined columns/);
  });
});

describe("an older Busabase server", () => {
  /**
   * A server from before `valueFilters` existed does not reject them — it
   * STRIPS the unknown parameter and answers 200 with everything. Verified
   * against the real published `busabase@0.42.0`, where a filtered
   * `records.count` returned the unfiltered total.
   *
   * That is the worst shape a failure can take here, because `exact` is what
   * lets the driver skip the local predicate and push `limit`: it would hand
   * back every record in the Base as though each one matched. Measured before
   * the fix — `where(gt(score, 35))` over five records returned all five.
   */
  const oldServer = () => {
    const fake = makeClient(dataset, 100);
    const client = fake.client as unknown as {
      records: {
        count: (input: ListCall) => Promise<{ total: number }>;
        list: (input: ListCall) => Promise<unknown>;
        groupBy: (input: ListCall) => Promise<unknown>;
      };
    };
    // What makes it old: it does not KNOW the parameter, so it strips it and
    // answers as though no filter were given. Every read has to behave that
    // way — an earlier version of this helper only made `count` old, and the
    // row-level assertion below then passed on the fake's own filtering rather
    // than on the driver's fallback.
    client.records.count = async (input: ListCall) => {
      fake.countCalls.push(input);
      return { total: dataset.length };
    };
    client.records.groupBy = async (input: ListCall) => {
      fake.groupByCalls.push(input);
      return { groups: [{ value: null, count: dataset.length }], total: dataset.length };
    };
    const listWithFilters = client.records.list;
    client.records.list = async (input: ListCall) =>
      listWithFilters({ ...input, valueFilters: undefined });
    return fake;
  };

  it("returns the RIGHT rows, by deciding locally instead of trusting the server", async () => {
    const fake = oldServer();
    const db = drizzle(fake.client, { pageSize: 100 });
    const rows = await db.select().from(contacts).where(gt(contacts.score, 40));
    expect(rows.map((row) => row.name).sort()).toEqual(["Ada", "Cy", "Ed"]);
    // Not the whole Base, which is what trusting the stripped filter produced.
    expect(rows).toHaveLength(3);
  });

  it("does not push `limit` down, which would return a short page", async () => {
    const fake = oldServer();
    const db = drizzle(fake.client, { pageSize: 100 });
    const rows = await db.select().from(contacts).where(gt(contacts.score, 40)).limit(2);
    expect(rows).toHaveLength(2);
    expect(fake.calls.some((call) => call.limit === 2)).toBe(false);
  });

  it("counts locally rather than trusting the server's unfiltered total", async () => {
    const fake = oldServer();
    const db = drizzle(fake.client, { pageSize: 100 });
    const counted = await db.select({ n: count() }).from(contacts).where(gt(contacts.score, 40));
    expect(counted[0]?.n).toBe(3);
    // 6 is what the old server would have answered.
    expect(counted[0]?.n).not.toBe(dataset.length);
  });

  it("aggregates locally rather than reporting nulls the old server never computed", async () => {
    const fake = oldServer();
    const db = drizzle(fake.client, { pageSize: 100 });
    const [row] = await db.select({ total: sum(contacts.score) }).from(contacts);
    expect(row?.total).toBe("270");
  });
});
