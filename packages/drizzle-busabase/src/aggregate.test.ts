import { avg, avgDistinct, count, countDistinct, max, min, sum, sumDistinct } from "drizzle-orm";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { parseAggregate } from "./aggregate";

/**
 * Reading drizzle's aggregate shape.
 *
 * `parseAggregate` reads a shape drizzle does not document — there is no
 * aggregate node type, only an `SQL` whose chunks happen to be `["count(", arg,
 * ")"]`. So every case here is driven through drizzle's OWN builders rather
 * than through a hand-written chunk array: a hand-written one would keep
 * passing after an upgrade changed the real shape, which is the failure mode
 * that matters.
 *
 * The arithmetic those entries drive lives in busabase-orm-core, and is tested
 * there — what `sum` MEANS is not a drizzle question.
 */

const contacts = pgTable("contacts", {
  id: text("id"),
  name: text("name"),
  score: integer("score"),
});

describe("parseAggregate reads drizzle's own output", () => {
  it.each([
    ["count()", count(), { fn: "count", fieldSlug: null, distinct: false }],
    ["count(col)", count(contacts.score), { fn: "count", fieldSlug: "score", distinct: false }],
    [
      "countDistinct",
      countDistinct(contacts.name),
      { fn: "count", fieldSlug: "name", distinct: true },
    ],
    ["sum", sum(contacts.score), { fn: "sum", fieldSlug: "score", distinct: false }],
    ["sumDistinct", sumDistinct(contacts.score), { fn: "sum", fieldSlug: "score", distinct: true }],
    ["avg", avg(contacts.score), { fn: "avg", fieldSlug: "score", distinct: false }],
    ["avgDistinct", avgDistinct(contacts.score), { fn: "avg", fieldSlug: "score", distinct: true }],
    ["min", min(contacts.score), { fn: "min", fieldSlug: "score", distinct: false }],
    ["max", max(contacts.score), { fn: "max", fieldSlug: "score", distinct: false }],
  ])("%s", (_label, built, expected) => {
    expect(parseAggregate(built)).toEqual({ kind: "aggregate", ...expected });
  });

  it("does not mistake a plain column for an aggregate", () => {
    expect(parseAggregate(contacts.score)).toBeNull();
  });

  it("does not mistake an unrelated expression for an aggregate", () => {
    // The shape test is `[opener, arg, ")"]` with a KNOWN opener, so a
    // same-shaped call to some other function is rejected rather than guessed.
    expect(parseAggregate(sqlLike("lower(", contacts.name, ")"))).toBeNull();
  });
});

/** A hand-built SQL with the same 3-chunk shape but a different function. */
const sqlLike = (opener: string, column: unknown, closer: string) =>
  ({
    queryChunks: [{ value: [opener] }, column, { value: [closer] }],
    constructor: undefined,
  }) as never;
