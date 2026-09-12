import { describe, expect, it } from "vitest";
import type { ResolvedBase } from "./base-resolver";
import type { RecordRow } from "./execute";
import { distinctKeyValues, hashJoin, type JoinedRow, qualifiedValues } from "./join";

/**
 * SQL's join semantics, which is the half no driver should re-derive.
 *
 * The cases worth having are the ones a naive lookup gets wrong: an outer join
 * keeps its unmatched side with NULLs rather than dropping it, a duplicate key
 * on the joined side MULTIPLIES rows rather than picking one, and a NULL join
 * key matches nothing — including another NULL.
 */

const base = (slug: string, fields: string[]): ResolvedBase => ({
  id: `bas_${slug}`,
  slug,
  fields: new Map(fields.map((name) => [name, { slug: name, type: "text" }])),
});

const record = (id: string, payload: Record<string, unknown>): RecordRow => ({
  id,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  payload,
});

describe("qualifiedValues", () => {
  const contactsBase = base("contacts", ["name", "firm"]);

  it("writes every column under its table's name", () => {
    expect(
      qualifiedValues(contactsBase, "contacts", record("rec_1", { name: "Ada", firm: "acme" }), [
        "name",
        "firm",
        "id",
      ]),
    ).toEqual({ "contacts.name": "Ada", "contacts.firm": "acme", "contacts.id": "rec_1" });
  });

  it("fills every column with null for an unmatched outer side", () => {
    expect(qualifiedValues(contactsBase, "contacts", null, ["name", "id"])).toEqual({
      "contacts.name": null,
      "contacts.id": null,
    });
  });
});

describe("hashJoin", () => {
  const left: JoinedRow[] = [
    { values: { "contacts.name": "Ada", "contacts.firm": "acme" }, sources: {} },
    { values: { "contacts.name": "Bo", "contacts.firm": "zeta" }, sources: {} },
    { values: { "contacts.name": "Cy", "contacts.firm": null }, sources: {} },
  ];
  const incoming = [
    { row: record("c1", {}), values: { "companies.code": "acme", "companies.city": "NY" } },
    { row: record("c2", {}), values: { "companies.code": "other", "companies.city": "LA" } },
  ];
  const pairs = [{ left: "contacts.firm", right: "companies.code" }];
  const empty = { "companies.code": null, "companies.city": null };

  const names = (rows: JoinedRow[]) =>
    rows.map((row) => [row.values["contacts.name"], row.values["companies.city"]]);

  it("keeps only matched rows on an inner join", () => {
    expect(names(hashJoin(left, incoming, pairs, "inner", "companies", empty))).toEqual([
      ["Ada", "NY"],
    ]);
  });

  it("keeps unmatched LEFT rows with nulls on a left join", () => {
    expect(names(hashJoin(left, incoming, pairs, "left", "companies", empty))).toEqual([
      ["Ada", "NY"],
      ["Bo", null],
      ["Cy", null],
    ]);
  });

  it("keeps unmatched RIGHT rows with nulls on a right join", () => {
    const result = hashJoin(left, incoming, pairs, "right", "companies", empty);
    expect(names(result)).toEqual([
      ["Ada", "NY"],
      [null, "LA"],
    ]);
  });

  it("keeps both unmatched sides on a full join", () => {
    expect(names(hashJoin(left, incoming, pairs, "full", "companies", empty))).toEqual([
      ["Ada", "NY"],
      ["Bo", null],
      ["Cy", null],
      [null, "LA"],
    ]);
  });

  it("MULTIPLIES rows when the joined side has a duplicate key", () => {
    // A lookup that picked the first match would quietly return one row here.
    // SQL returns two, and so must this.
    const duplicated = [
      ...incoming,
      { row: record("c3", {}), values: { "companies.code": "acme", "companies.city": "SF" } },
    ];
    expect(names(hashJoin(left, duplicated, pairs, "inner", "companies", empty))).toEqual([
      ["Ada", "NY"],
      ["Ada", "SF"],
    ]);
  });

  it("never matches a NULL key, not even against another NULL", () => {
    // "Cy" has no firm. Neither does this company. In SQL they do not join, and
    // a naive `JSON.stringify([null])` key would have made them.
    const withNullKey = [
      { row: record("c9", {}), values: { "companies.code": null, "companies.city": "nowhere" } },
    ];
    expect(names(hashJoin(left, withNullKey, pairs, "inner", "companies", empty))).toEqual([]);
    expect(names(hashJoin(left, withNullKey, pairs, "left", "companies", empty))).toEqual([
      ["Ada", null],
      ["Bo", null],
      ["Cy", null],
    ]);
  });

  it("joins on a composite key, matching only when BOTH columns agree", () => {
    const composite = [
      { left: "contacts.name", right: "companies.code" },
      { left: "contacts.firm", right: "companies.city" },
    ];
    const rows = [
      { row: record("x", {}), values: { "companies.code": "Ada", "companies.city": "acme" } },
      { row: record("y", {}), values: { "companies.code": "Ada", "companies.city": "wrong" } },
    ];
    const result = hashJoin(left, rows, composite, "inner", "companies", empty);
    expect(result).toHaveLength(1);
    expect(result[0]?.sources.companies?.id).toBe("x");
  });

  it("records which record each side came from, and null for an unmatched one", () => {
    const result = hashJoin(left, incoming, pairs, "left", "companies", empty);
    expect(result[0]?.sources.companies?.id).toBe("c1");
    expect(result[1]?.sources.companies).toBeNull();
  });
});

describe("distinctKeyValues", () => {
  const rows: JoinedRow[] = [
    { values: { "contacts.firm": "acme" }, sources: {} },
    { values: { "contacts.firm": "acme" }, sources: {} },
    { values: { "contacts.firm": "zeta" }, sources: {} },
    { values: { "contacts.firm": null }, sources: {} },
  ];

  it("dedupes, and drops nulls (which cannot match anything)", () => {
    expect(distinctKeyValues(rows, [{ left: "contacts.firm", right: "companies.code" }])).toEqual([
      "acme",
      "zeta",
    ]);
  });

  it("declines a composite key — there is no IN over tuples to push", () => {
    expect(
      distinctKeyValues(rows, [
        { left: "contacts.firm", right: "companies.code" },
        { left: "contacts.id", right: "companies.id" },
      ]),
    ).toBeNull();
  });
});
