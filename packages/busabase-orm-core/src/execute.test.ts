import type { BusabaseClient } from "busabase-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { BaseResolver } from "./base-resolver";
import { type ExecuteContext, executeSelect, readColumn, ScanLimitExceededError } from "./execute";
import { all, comparison, finalize, matchesPattern } from "./predicate";

/**
 * The engine both drivers share. Its job is to turn "what the query means" into
 * as few round trips as is provably safe — so the tests here are mostly about
 * what reaches the wire, not about which rows come back.
 */

interface ListCall {
  baseId?: string;
  limit?: number;
  filters?: { fieldSlug: string; operator: string; value?: unknown; fieldType?: string }[];
  valueFilters?: { fieldSlug: string; operator: string; value: number | string }[];
  sort?: { fieldSlug: string; direction: string; fieldType?: string };
  cursor?: string;
}

const FIELDS = [
  { slug: "name", type: "text" },
  { slug: "score", type: "number" },
  { slug: "due", type: "date" },
  { slug: "active", type: "checkbox" },
];

const DATA: { id: string; payload: Record<string, unknown> }[] = [
  { id: "r1", payload: { name: "Ada", score: 90, due: "2026-01-01T00:00:00.000Z" } },
  { id: "r2", payload: { name: "Bo", score: 10, due: "2026-02-01T00:00:00.000Z" } },
  { id: "r3", payload: { name: "Cy", score: 70, due: "2026-03-01T00:00:00.000Z" } },
  { id: "r4", payload: { name: "Di", score: 20, due: "2026-04-01T00:00:00.000Z" } },
  { id: "r5", payload: { name: "Ed", score: 50, due: "2026-05-01T00:00:00.000Z" } },
];

/** Applies valueFilters faithfully (they are exact) and ignores filters (a legal superset). */
const makeClient = (records = DATA, pageSize = 2) => {
  const calls: ListCall[] = [];
  const client = {
    bases: {
      list: async () => [{ id: "bas_1", slug: "things", fields: FIELDS }],
    },
    records: {
      /**
       * Faithful about ONE thing that matters: a real server REFUSES a
       * `valueFilters` entry naming a field the Base does not have. That
       * refusal is how the driver tells a server that applies these filters
       * from an older one that silently strips them — a fake that answered
       * politely would make every exact push-down look unsupported.
       */
      count: async (input: ListCall) => {
        const slugs = (input.valueFilters ?? []).flatMap((filter) =>
          "any" in filter
            ? (filter as { any: { fieldSlug: string }[] }).any.map((leaf) => leaf.fieldSlug)
            : [(filter as { fieldSlug: string }).fieldSlug],
        );
        for (const slug of slugs) {
          if (!FIELDS.some((field) => field.slug === slug)) {
            throw new Error(`valueFilters: this Base has no field "${slug}"`);
          }
        }
        return { total: records.length };
      },
      list: async (input: ListCall) => {
        calls.push(input);
        const matching = (input.valueFilters ?? []).reduce((rows, filter) => {
          return rows.filter((row) => {
            const stored = row.payload[filter.fieldSlug];
            if (stored === null || stored === undefined) return false;
            const left = typeof stored === "number" ? stored : String(stored);
            const right = typeof filter.value === "number" ? filter.value : String(filter.value);
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
              default:
                return left <= right;
            }
          });
        }, records);
        const start = input.cursor ? Number(input.cursor) : 0;
        const size = Math.min(input.limit ?? pageSize, pageSize);
        const slice = matching.slice(start, start + size);
        return {
          records: slice.map((record) => ({
            id: record.id,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            headCommit: { payload: record.payload },
          })),
          nextCursor: start + size < matching.length ? String(start + size) : null,
        };
      },
    },
  } as unknown as BusabaseClient;
  return { client, calls };
};

const contextFor = (fake: ReturnType<typeof makeClient>, overrides: Partial<ExecuteContext> = {}) =>
  ({
    client: fake.client,
    resolver: new BaseResolver(fake.client, {}),
    maxScannedRecords: 1000,
    pageSize: 100,
    ...overrides,
  }) as ExecuteContext;

const names = (rows: { payload: Record<string, unknown> }[]) => rows.map((r) => r.payload.name);

describe("paging", () => {
  let fake: ReturnType<typeof makeClient>;
  beforeEach(() => {
    fake = makeClient();
  });

  it("follows the cursor until the Base is exhausted", async () => {
    const { rows } = await executeSelect({ baseSlug: "things" }, contextFor(fake, { pageSize: 2 }));
    expect(rows).toHaveLength(5);
    expect(fake.calls.length).toBeGreaterThan(1);
    expect(fake.calls[1]?.cursor).toBe("2");
  });

  it("applies offset and limit", async () => {
    const { rows } = await executeSelect(
      { baseSlug: "things", limit: 2, offset: 1 },
      contextFor(fake, { pageSize: 100 }),
    );
    expect(names(rows)).toEqual(["Bo", "Cy"]);
  });

  it("caps the requested page at pageSize", async () => {
    await executeSelect({ baseSlug: "things" }, contextFor(fake, { pageSize: 2 }));
    expect(fake.calls.every((call) => (call.limit ?? 0) <= 2)).toBe(true);
  });
});

describe("limit push-down", () => {
  it("rides along when nothing is left to the client", async () => {
    const fake = makeClient();
    await executeSelect(
      { baseSlug: "things", where: finalize(comparison("score", "gt", 40)), limit: 2 },
      contextFor(fake),
    );
    expect(fake.calls[0]?.limit).toBe(2);
  });

  it("rides along with no where clause at all", async () => {
    const fake = makeClient();
    await executeSelect({ baseSlug: "things", limit: 2 }, contextFor(fake));
    expect(fake.calls[0]?.limit).toBe(2);
  });

  it("stays behind when a local predicate decides", async () => {
    // A superset would eat the limit budget and return a short page.
    const fake = makeClient();
    await executeSelect(
      { baseSlug: "things", where: finalize(matchesPattern("name", "%a%", true)), limit: 2 },
      contextFor(fake),
    );
    expect(fake.calls[0]?.limit).not.toBe(2);
  });

  it("stays behind when the sort is local", async () => {
    const fake = makeClient();
    await executeSelect(
      { baseSlug: "things", orderBy: [{ fieldSlug: "name", direction: "asc" }], limit: 2 },
      contextFor(fake),
    );
    expect(fake.calls[0]?.limit).not.toBe(2);
  });

  it("stays behind when one candidate has no exact value column", async () => {
    // `name` is text: the candidate is dropped, so the server's answer is a
    // superset again even though the tree was a pure AND of comparisons.
    const fake = makeClient();
    await executeSelect(
      {
        baseSlug: "things",
        where: finalize(all([comparison("score", "gt", 40), comparison("name", "gt", "A")])),
        limit: 2,
      },
      contextFor(fake),
    );
    expect(fake.calls[0]?.limit).not.toBe(2);
    expect(fake.calls[0]?.valueFilters).toEqual([
      { fieldSlug: "score", operator: "gt", value: 40 },
    ]);
  });
});

describe("what reaches the wire", () => {
  it("stamps view filters with the field's real type", async () => {
    // Without fieldType the server drops the filter silently and returns the
    // whole Base — correct results, zero benefit, and invisible.
    const fake = makeClient();
    await executeSelect(
      { baseSlug: "things", where: finalize(comparison("name", "eq", "Ada")) },
      contextFor(fake),
    );
    expect(fake.calls[0]?.filters).toEqual([
      { fieldSlug: "name", operator: "equals", value: "Ada", fieldType: "text" },
    ]);
  });

  it("stamps the sort key too", async () => {
    const fake = makeClient();
    await executeSelect(
      { baseSlug: "things", orderBy: [{ fieldSlug: "score", direction: "desc" }] },
      contextFor(fake),
    );
    expect(fake.calls[0]?.sort).toEqual({
      fieldSlug: "score",
      direction: "desc",
      fieldType: "number",
    });
  });

  it("does not send a sort the server cannot do", async () => {
    const fake = makeClient();
    await executeSelect(
      { baseSlug: "things", orderBy: [{ fieldSlug: "name", direction: "asc" }] },
      contextFor(fake),
    );
    expect(fake.calls[0]?.sort).toBeUndefined();
  });

  it("does not send a multi-key sort — the REST input takes one", async () => {
    const fake = makeClient();
    await executeSelect(
      {
        baseSlug: "things",
        orderBy: [
          { fieldSlug: "score", direction: "asc" },
          { fieldSlug: "name", direction: "asc" },
        ],
      },
      contextFor(fake),
    );
    expect(fake.calls[0]?.sort).toBeUndefined();
  });

  it("encodes a date candidate as ISO 8601", async () => {
    const fake = makeClient();
    await executeSelect(
      {
        baseSlug: "things",
        where: finalize(comparison("due", "gte", new Date("2026-03-01T00:00:00.000Z"))),
      },
      contextFor(fake),
    );
    expect(fake.calls[0]?.valueFilters).toEqual([
      { fieldSlug: "due", operator: "gte", value: "2026-03-01T00:00:00.000Z" },
    ]);
  });

  it("drops a candidate whose value cannot be encoded", async () => {
    const fake = makeClient();
    await executeSelect(
      { baseSlug: "things", where: finalize(comparison("score", "gt", "banana")) },
      contextFor(fake),
    );
    // Sending it would 400 the whole request; the local predicate still decides.
    expect(fake.calls[0]?.valueFilters).toBeUndefined();
  });

  it("drops a candidate on an unknown field", async () => {
    const fake = makeClient();
    await executeSelect(
      { baseSlug: "things", where: finalize(comparison("nope", "gt", 1)) },
      contextFor(fake),
    );
    expect(fake.calls[0]?.valueFilters).toBeUndefined();
  });
});

describe("local sorting", () => {
  it("sorts text ascending and descending with NULLS LAST", async () => {
    const fake = makeClient([
      ...DATA,
      { id: "r6", payload: { score: 1 } }, // no name
    ]);
    const asc = await executeSelect(
      { baseSlug: "things", orderBy: [{ fieldSlug: "name", direction: "asc" }] },
      contextFor(fake),
    );
    expect(names(asc.rows)).toEqual(["Ada", "Bo", "Cy", "Di", "Ed", undefined]);

    // Postgres treats null as larger than any value, so descending puts it
    // FIRST — the mirror of the ascending case, not a second NULLS LAST.
    const desc = await executeSelect(
      { baseSlug: "things", orderBy: [{ fieldSlug: "name", direction: "desc" }] },
      contextFor(makeClient([...DATA, { id: "r6", payload: { score: 1 } }])),
    );
    expect(names(desc.rows)).toEqual([undefined, "Ed", "Di", "Cy", "Bo", "Ada"]);
  });

  it("breaks ties with the next key", async () => {
    const tied = [
      { id: "a", payload: { name: "B", score: 1 } },
      { id: "b", payload: { name: "A", score: 1 } },
      { id: "c", payload: { name: "C", score: 0 } },
    ];
    const { rows } = await executeSelect(
      {
        baseSlug: "things",
        orderBy: [
          { fieldSlug: "score", direction: "asc" },
          { fieldSlug: "name", direction: "asc" },
        ],
      },
      contextFor(makeClient(tied)),
    );
    expect(names(rows)).toEqual(["C", "A", "B"]);
  });

  it("compares numeric strings numerically, not lexically", async () => {
    // Sorted on `name` (a text field) so the comparison happens LOCALLY —
    // sorting on `score` would be pushed to the server and prove nothing here.
    const numeric = [
      { id: "a", payload: { name: "10" } },
      { id: "b", payload: { name: "9" } },
    ];
    const { rows } = await executeSelect(
      { baseSlug: "things", orderBy: [{ fieldSlug: "name", direction: "asc" }] },
      contextFor(makeClient(numeric)),
    );
    // Lexically "10" < "9"; numerically it is the other way round.
    expect(names(rows)).toEqual(["9", "10"]);
  });
});

describe("scan budget", () => {
  it("throws rather than truncating into a plausible wrong answer", async () => {
    const fake = makeClient();
    await expect(
      executeSelect(
        { baseSlug: "things", where: finalize(matchesPattern("name", "%zzz%", true)) },
        contextFor(fake, { maxScannedRecords: 2, pageSize: 2 }),
      ),
    ).rejects.toThrow(ScanLimitExceededError);
  });

  it("names the Base and the budget so the failure is actionable", async () => {
    const fake = makeClient();
    await expect(
      executeSelect(
        { baseSlug: "things", where: finalize(matchesPattern("name", "%zzz%", true)) },
        contextFor(fake, { maxScannedRecords: 2, pageSize: 2 }),
      ),
    ).rejects.toThrow(/things.*2|2.*things/);
  });

  it("does not trip when the server does the filtering", async () => {
    const fake = makeClient();
    const { rows } = await executeSelect(
      { baseSlug: "things", where: finalize(comparison("score", "gt", 40)) },
      contextFor(fake, { maxScannedRecords: 2, pageSize: 2 }),
    );
    expect(rows).toHaveLength(3);
  });
});

describe("readColumn", () => {
  const base = {
    id: "bas_1",
    slug: "things",
    fields: new Map([["name", { slug: "name", type: "text" }]]),
  };
  const row = {
    id: "rec_1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    payload: { name: "Ada" },
  };

  it("reads a Base field", () => {
    expect(readColumn(base, row, "name")).toBe("Ada");
  });

  it("falls back to the record's system columns", () => {
    expect(readColumn(base, row, "id")).toBe("rec_1");
    expect(readColumn(base, row, "createdAt")).toBe("2026-01-01T00:00:00.000Z");
    expect(readColumn(base, row, "updatedAt")).toBe("2026-01-02T00:00:00.000Z");
  });

  it("lets a real field of the same name win over the system fallback", () => {
    const shadowed = {
      ...base,
      fields: new Map([["id", { slug: "id", type: "text" }]]),
    };
    expect(readColumn(shadowed, { ...row, payload: { id: "user-supplied" } }, "id")).toBe(
      "user-supplied",
    );
  });

  it("returns null for a name that is neither", () => {
    expect(readColumn(base, row, "nope")).toBeNull();
  });
});
