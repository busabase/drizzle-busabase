# drizzle-busabase

A [Drizzle ORM](https://orm.drizzle.team) driver for [Busabase](https://busabase.com). Write a normal drizzle schema and normal drizzle queries; they are translated into [`busabase-sdk`](https://www.npmjs.com/package/busabase-sdk) REST calls against a Base.

```bash
npm install drizzle-busabase drizzle-orm busabase-sdk
```

```ts
import { Busabase } from "busabase-sdk";
import { drizzle } from "drizzle-busabase";
import { eq, and, gt, desc } from "drizzle-orm";
import { pgTable, text, integer } from "drizzle-orm/pg-core";

// The table name is the Base slug; column names are field slugs.
const contacts = pgTable("kelly-crm-contacts", {
  id: text("id"),
  name: text("name"),
  stage: text("stage"),
  score: integer("score"),
});

const bb = new Busabase({ apiKey: process.env.BUSABASE_API_KEY });
const db = drizzle(bb.client);

const hot = await db
  .select()
  .from(contacts)
  .where(and(eq(contacts.stage, "won"), gt(contacts.score, 40)))
  .orderBy(desc(contacts.score))
  .limit(10);
```

## How it works

drizzle's own proxy drivers (`drizzle-orm/pg-proxy`) hand you a finished SQL string, which would mean shipping a SQL parser. This driver hooks in one level higher instead: `PgDialect.buildSelectQuery` and its insert/update/delete siblings are public and receive the **structured** config. Table, limit, offset, orderBy and inserted values arrive as real objects; only `where` is a chunk tree, and even there columns and values survive as `Column` and `Param` instances with just the operator as text. So the driver reads intent, never SQL.

Nothing in drizzle is forked or patched — every entry point used is a published subpath export.

The Busabase half — Base resolution, SQL value semantics, push-down decisions, joins, aggregates, paging — lives in `busabase-orm-core`, shared with [`kysely-busabase`](https://github.com/busabase/kysely-busabase).

## Correctness: what pushes down and what does not

Busabase answers a filter two different ways, and the difference decides what the driver is allowed to do with the answer:

| | what it is | may carry `limit`? |
| --- | --- | --- |
| **view filters** (`contains`, `equals`, `not_empty`, …) | a **superset** the client still narrows | no |
| **value filters** (`eq`/`ne`/`gt`/`gte`/`lt`/`lte`) | **exact** | yes |

Every `where` compiles into both a push-down *and* a local, exactly-evaluated predicate. The predicate is always authoritative. What changes with an exact push-down is only how much data crosses the wire — and whether the server may be trusted to count, aggregate and paginate on your behalf.

**Exact push-down covers** number and date fields (including `created_time` / `updated_time`), text and `select` fields for `eq`/`ne`, and `checkbox`. `or(...)`, `not(...)` and `inArray(...)` all push: the filter list is a CNF, entries may carry an `any` group, and negation is pushed to the leaves at compile time.

Consequences worth knowing before you rely on this in a hot path:

- **`limit` is pushed down only when the server decides the whole `where`** — every conjunct exact, and any sort pushable. Otherwise the server's extra rows would eat the limit budget and you would get a short page, which reads as data loss rather than as a bug. Under an inexact filter the driver pages through candidates and slices locally.
- **`count()` and grouped aggregates run on the server** when the filter is exact, transferring no records at all. When it is not, they fall back to the same scan you would have written by hand — with the scan budget and with SQL's NULL semantics.
- **Operators Busabase lacks still work**, evaluated locally: `like`, `between`, `is null`, column-to-column comparisons. Correct, not free.
- **Sorting** is pushed down for a single number/date field. **Text sorts run locally** — not because of any storage limit, but because Postgres orders text by the database collation and your code orders it by JavaScript string comparison (`'a' < 'B'` in `en_US.UTF-8`, not in JS). An exact row set in an order you cannot reproduce is worse than no push-down.
- **Nulls follow SQL three-valued logic**, not JavaScript coercion. A missing field makes `gt(col, 1)` UNKNOWN, so the row is excluded from both it and its negation — where JS `undefined > 1` would have quietly said `false`.

The scan is bounded by `maxScannedRecords` (default 10,000) and **throws when exceeded rather than truncating**, because a truncated result looks exactly like a complete one.

## Joins, aggregates and set operations

- **Joins** — `innerJoin` / `leftJoin` / `rightJoin` / `fullJoin`, run as a hash join: the driving side is fetched with its own push-down, then the other side is fetched **by key** rather than wholesale. `rightJoin` and `fullJoin` are the exception: they have to keep rows the driving side never referenced, so that side is read in full. `ON` must be an equality (or an AND of equalities) between two columns.
- **`groupBy` + aggregates** — `count`, `sum`, `avg`, `min`, `max` over a plain column. On an exact filter these become a single server request. An empty group aggregates to `NULL`, not `0`, exactly as in SQL.
- **`union` / `intersect` / `except`**, with or without `all`. Each branch runs as its own query with its own push-down.

## What it still refuses

Anything without an exact translation throws with the reason instead of being silently approximated:

- raw ``sql`` `` fragments
- expression sorts (``orderBy(sql`lower(name)`)``) and grouping by an expression
- aggregating over a `union`/`intersect`/`except`
- transactions — Busabase's ChangeRequest is the natural boundary (one request, many operations, merged atomically), but this driver does not batch into one yet

## Writes follow Busabase, not SQL

- **`insert` / `update`** ride Busabase's permission-aware auto-merge. If the credential lacks write access the change lands as a *pending ChangeRequest* — the row does not exist yet, so the driver **throws** rather than report success. The change is not lost; approve the ChangeRequest to apply it.
- **`update` carries untouched fields through**, because Busabase revises a record as a whole payload and a partial one would clear the rest.
- **`delete` archives; it does not erase, and it is refused by default.** Merging a delete sets the record's status to `archived`: it leaves every query this driver can issue, but it is still stored and restorable in Busabase. That is not what `await db.delete(...)` means anywhere else, so opting in is explicit:

  ```ts
  drizzle(bb.client, { allowArchivingDelete: true });
  ```

  Like `insert` and `update`, it **throws** rather than report a delete that is only pending review.

## Server requirements

Exact push-down needs a Busabase server that understands `valueFilters` — anything **newer than 0.42.0**.

You do not have to check. The driver asks the server once per client, and an older server that silently drops the parameter (answering as though no filter were given) is detected and treated as having none: every query falls back to fetching and deciding locally. **Answers are the same either way**; only the amount of data transferred changes.

## Options

```ts
drizzle(bb.client, {
  bases: { contacts: "kelly-crm-contacts-v1" }, // table name -> Base slug or bas_ id
  maxScannedRecords: 10_000,                    // scan ceiling; throws when exceeded
  pageSize: 100,                                // REST caps this at 100
  allowArchivingDelete: false,
  changeMessage: "Change via drizzle-busabase",
});
```

A table resolves to the Base whose **slug** equals the table name unless `bases` overrides it. Columns resolve to field slugs; `id`, `createdAt` and `updatedAt` fall back to the record's system columns when the Base defines no field of that name.

## Not a migration tool

`drizzle-kit push` / `generate` do not apply — a Base's schema is its field list, managed in Busabase. The useful direction is the reverse (generating drizzle table definitions from a Base), which this package does not do yet.
