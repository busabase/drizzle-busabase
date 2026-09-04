# drizzle-busabase

A [Drizzle ORM](https://orm.drizzle.team) driver for [Busabase](https://busabase.com). Write a normal drizzle schema and normal drizzle queries; they are translated into [`busabase-sdk`](https://www.npmjs.com/package/busabase-sdk) REST calls against a Base.

```bash
npm install drizzle-busabase drizzle-orm busabase-sdk
```

```ts
import { Busabase } from "busabase-sdk";
import { drizzle } from "drizzle-busabase";
import { eq, and, gt } from "drizzle-orm";
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

## Correctness: what pushes down and what does not

Busabase's REST contract documents server-side filters as **a superset the client still narrows**, and it has six filter operators (`contains`, `equals`, `not_empty`, `is_empty`, `is_true`, `is_false`) against drizzle's twenty-odd.

That one fact shapes everything. A `where` compiles into two artifacts:

| | what it is | role |
| --- | --- | --- |
| **pushdown** | Busabase view filters | a hint that may only ever *shrink* the candidate set |
| **predicate** | a local, exactly-evaluated function | decides which rows are actually in the result |

Consequences worth knowing before you rely on this in a hot path:

- **`limit` is only pushed down when there is no local predicate and no local sort.** Otherwise the server's extra rows would eat the limit budget and you would get a short page — which reads as data loss, not as a bug. Under a filter, the driver pages through candidates and slices locally.
- **Operators Busabase lacks (`>`, `<`, `<>`, `between`, `in`, `or`, `not`) still work**, evaluated locally. They are correct but not free. If Busabase later grows these filters, that is a pure performance change — no query stops or starts working.
- **Sorting** is pushed down only for a single number/date field (what the contract allows). Text sorts run locally.
- **Nulls follow SQL three-valued logic**, not JavaScript coercion. A missing field makes `gt(col, 1)` UNKNOWN, so the row is excluded from both it and its negation — where JS `undefined > 1` would have quietly said `false`.

The scan is bounded by `maxScannedRecords` (default 10,000) and **throws when exceeded rather than truncating**, because a truncated result looks exactly like a complete one.

## What it refuses

Anything without an exact translation throws with the reason instead of being silently approximated:

- raw ``sql`` `` fragments and column-to-column comparisons
- joins, `group by`, `union`/`intersect`/`except`
- expression sorts (`orderBy(sql`lower(name)`)`)
- transactions — Busabase's ChangeRequest is the natural boundary (one request, many operations, merged atomically), but this driver does not batch into one yet

## Writes follow Busabase, not SQL

- **`insert` / `update`** ride Busabase's permission-aware auto-merge. If the credential lacks write access the change lands as a *pending ChangeRequest* — the row does not exist yet, so the driver **throws** rather than report success. The change is not lost; approve the ChangeRequest to apply it.
- **`update` carries untouched fields through**, because Busabase revises a record as a whole payload and a partial one would clear the rest.
- **`delete` is refused by default.** Busabase deletes are review-first: the call submits a ChangeRequest proposing the rows be archived, and they are still present when it returns. That is not what `await db.delete(...)` means anywhere else, so opting in is explicit:

  ```ts
  drizzle(bb.client, { allowReviewFirstDelete: true });
  ```

## Options

```ts
drizzle(bb.client, {
  bases: { contacts: "kelly-crm-contacts-v1" }, // table name -> Base slug or bas_ id
  maxScannedRecords: 10_000,                    // scan ceiling; throws when exceeded
  pageSize: 100,                                // REST caps this at 100
  allowReviewFirstDelete: false,
  changeMessage: "Change via drizzle-busabase",
});
```

A table resolves to the Base whose **slug** equals the table name unless `bases` overrides it. Columns resolve to field slugs; `id`, `createdAt` and `updatedAt` fall back to the record's system columns when the Base defines no field of that name.

## Not a migration tool

`drizzle-kit push` / `generate` do not apply — a Base's schema is its field list, managed in Busabase. The useful direction is the reverse (generating drizzle table definitions from a Base), which this package does not do yet.
