import { ScanLimitExceededError } from "busabase-orm-core";
import type { BusabaseClient } from "busabase-sdk";
import { and, asc, between, desc, eq, gt, like, sql } from "drizzle-orm";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "./driver";

const contacts = pgTable("contacts", {
  id: text("id"),
  name: text("name"),
  stage: text("stage"),
  score: integer("score"),
});

interface FakeRecord {
  id: string;
  payload: Record<string, unknown>;
}

interface ValueFilterCall {
  fieldSlug: string;
  operator: string;
  value: number | string;
}

interface ListCall {
  baseId?: string;
  limit?: number;
  filters?: unknown[];
  valueFilters?: ValueFilterCall[];
  sort?: unknown;
  cursor?: string;
}

/** The server's exact comparison, reproduced for the fake. */
const compareValue = (stored: unknown, filter: ValueFilterCall): boolean => {
  if (stored === null || stored === undefined) return false;
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

/**
 * A Busabase stand-in that reproduces the two behaviours the driver has to
 * survive: server-side filters are a **superset** (here, deliberately ignored
 * altogether), and listing is keyset-paginated.
 */
const makeClient = (records: FakeRecord[], pageSize = 2) => {
  const calls: ListCall[] = [];
  const created: Record<string, unknown>[] = [];
  const updated: { recordId: string; fields: Record<string, unknown> }[] = [];
  const deleted: string[] = [];

  const client = {
    bases: {
      list: async () => [
        {
          id: "bas_1",
          slug: "contacts",
          fields: [
            { slug: "name", type: "text" },
            { slug: "stage", type: "text" },
            { slug: "score", type: "number" },
          ],
        },
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
        // Both contracts, side by side, exactly as the server implements them:
        // view `filters` are accepted and IGNORED (a legal superset), while
        // `valueFilters` are applied FAITHFULLY (they are authoritative).
        const matching = (input.valueFilters ?? []).reduce(
          (rows, filter) =>
            rows.filter((row) => compareValue(row.payload[filter.fieldSlug], filter)),
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
      changeRequest: async (input: {
        recordId: string;
        operation: string;
        fields?: Record<string, unknown>;
      }) => {
        if (input.operation === "delete") {
          deleted.push(input.recordId);
          return { materialized: false as const, id: "cr_del" };
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

  return { client, calls, created, updated, deleted };
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

  it("does not push limit down alongside a filter", async () => {
    // The server here returns a superset. Pushing `limit 3` would let its
    // non-matching rows eat the budget and yield a short, wrong page.
    const db = drizzle(fake.client);
    const rows = await db.select().from(contacts).where(eq(contacts.stage, "won")).limit(3);
    expect(rows.map((row) => row.name)).toEqual(["Ada", "Cy", "Ed"]);
    // The user's `limit 3` must never reach the server while a local predicate
    // is still deciding which rows count.
    expect(fake.calls.some((call) => call.limit === 3)).toBe(false);
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
      { fieldSlug: "stage", operator: "equals", value: "won", fieldType: "text" },
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

  it("refuses delete by default because Busabase deletes are review-first", async () => {
    const fake = makeClient(dataset);
    const db = drizzle(fake.client);
    await expect(db.delete(contacts).where(eq(contacts.name, "Bo"))).rejects.toThrow(
      /review-first/,
    );
    expect(fake.deleted).toEqual([]);
  });

  it("submits a delete change request once opted in", async () => {
    const fake = makeClient(dataset);
    const db = drizzle(fake.client, { allowReviewFirstDelete: true });
    await db.delete(contacts).where(eq(contacts.name, "Bo"));
    expect(fake.deleted).toEqual(["rec_2"]);
  });
});

describe("refusals", () => {
  it("rejects a join rather than emulating one", async () => {
    const fake = makeClient(dataset);
    const db = drizzle(fake.client);
    const other = pgTable("other", { id: text("id") });
    await expect(
      db.select().from(contacts).leftJoin(other, eq(contacts.id, other.id)),
    ).rejects.toThrow(/cannot join/);
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
