import { UnsupportedJoinError } from "busabase-orm-core";
import { and, eq, gt, or, sql } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { parseJoinOn, qualify } from "./join";

/**
 * Reading drizzle's ON expression.
 *
 * Every case is driven through drizzle's own `eq`/`and` rather than a
 * hand-built chunk array — the point is to notice when the real shape changes,
 * which a hand-built one never would. The join ITSELF lives in
 * busabase-orm-core and is tested there.
 */

const contacts = pgTable("contacts", { id: text("id"), name: text("name"), firm: text("firm") });
const companies = pgTable("companies", { id: text("id"), code: text("code") });

describe("parseJoinOn", () => {
  it("reads a single equality between two columns", () => {
    expect(parseJoinOn(eq(contacts.firm, companies.code))).toEqual([
      { left: "contacts.firm", right: "companies.code" },
    ]);
  });

  it("reads an AND of equalities as a composite key", () => {
    expect(
      parseJoinOn(and(eq(contacts.firm, companies.code), eq(contacts.id, companies.id))),
    ).toEqual([
      { left: "contacts.firm", right: "companies.code" },
      { left: "contacts.id", right: "companies.id" },
    ]);
  });

  it.each([
    ["an inequality, which has no hash key", gt(contacts.firm, companies.code), /not an equality/],
    [
      "an OR, which has no single key",
      or(eq(contacts.firm, companies.code), eq(contacts.id, companies.id)),
      /OR in ON/,
    ],
    ["a comparison against a literal", eq(contacts.firm, "acme"), /other than two columns/],
    ["a raw sql fragment", sql`contacts.firm = companies.code`, /other than two columns/],
  ])("refuses %s", (_label, on, message) => {
    expect(() => parseJoinOn(on)).toThrow(UnsupportedJoinError);
    expect(() => parseJoinOn(on)).toThrow(message);
  });

  it("refuses an ON that is not an expression at all", () => {
    expect(() => parseJoinOn(undefined)).toThrow(/not an expression/);
  });
});

describe("qualify", () => {
  it("names a column by its table, so two `id` columns stay distinct", () => {
    expect(qualify(contacts.id)).toBe("contacts.id");
    expect(qualify(companies.id)).toBe("companies.id");
  });
});
