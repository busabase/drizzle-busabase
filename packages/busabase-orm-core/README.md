# busabase-orm-core

The half of a Busabase ORM driver that is not about any particular ORM. Used by [`drizzle-busabase`](../drizzle-busabase) and [`kysely-busabase`](https://github.com/busabase/kysely-busabase).

**Not published to npm.** It is bundled into each driver's build output, so installing a driver pulls in nothing extra and there is no version to keep in step. Nobody consumes this package directly, which is exactly why it is not worth being a separate install.

## Why it exists

Every driver faces the same three problems, and none of them are about the query builder it sits behind:

1. **What does a comparison mean when the value is missing?** SQL says UNKNOWN; JavaScript says `undefined > 1 === false`. Getting that wrong silently returns rows a database would not have.
2. **Can the server decide this, or must we?** Busabase answers filters two ways — view filters are a *superset* the client narrows, value filters are *exact* — and the answer determines whether `limit` may be pushed down at all.
3. **How do we page a Base without lying about completeness?**

Those are the subtle parts, so they exist once here rather than once per ORM. A driver's real job is walking its own AST and calling the builders below.

## The shape of a driver

```ts
import { all, comparison, finalize, executeSelect, BaseResolver } from "busabase-orm-core";

// 1. Walk your ORM's AST into predicate nodes.
const where = finalize(all([
  comparison("stage", "eq", "won"),
  comparison("score", "gt", 40),
]));

// 2. Hand the engine plain data — no ORM types cross this boundary.
const { base, rows } = await executeSelect(
  { baseSlug: "contacts", where, orderBy: [{ fieldSlug: "score", direction: "desc" }], limit: 10 },
  { client, resolver, maxScannedRecords: 10_000, pageSize: 100 },
);
```

## The invariant everything rests on

`finalize()` returns three things that must stay in step:

- `pushdown` — view filters for the server. A **hint**: it may only ever *shrink* the candidate set.
- `valueCandidates` — exact comparisons, pending the caller's field-type check.
- `predicate` — the local, authoritative decision.

**Whatever the server returns for `pushdown` must still contain every row `predicate` accepts.** If that breaks, every driver silently loses rows — so it is tested directly in `predicate.test.ts`, not left to the driver suites.

`fullyExact` reports whether `valueCandidates` alone decide the clause. It is deliberately conservative: an `or`, a `not`, a `like` or an `is null` anywhere makes it false. Only when it holds — *and* every candidate landed on a field with a real value column — may a driver skip the local predicate and push `limit` down.
