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
- `valueTree` — the exact comparisons as a boolean tree, pending the caller's field-type check.
- `predicate` — the local, authoritative decision.

**Whatever the server returns for `pushdown` must still contain every row `predicate` accepts.** If that breaks, every driver silently loses rows — so it is tested directly in `predicate.test.ts`, not left to the driver suites.

`fullyExact` reports whether `valueTree` alone decides the clause — that is, whether it holds no `opaque` node. An `or` or a `not` does **not** make it false: the wire format is a CNF whose entries may carry an `any` group, and `compileValueFilters` distributes into it, so the whole boolean structure survives. What makes it false is a condition with no exact form at all — a `like`, an `is null`, a comparison against another column.

`fullyExact` is necessary but not sufficient. The caller must also confirm every leaf is sendable against the Base's actual field types; only then may a driver skip the local predicate and push `limit` down.

Negation never reaches the wire. Every operator has an exact negation, so `not` is pushed to the leaves with De Morgan at compile time. That keeps evaluation **monotone**, which is what makes the missing-value semantics sound: a leaf matching no row is false, and for an AND/OR tree with no NOT that agrees with SQL's three-valued answer.

Distribution into CNF is **budgeted** rather than unbounded. `records.list` is a GET, so the compiled filters have to fit in a URL — past the budget the tree is pruned instead, asymmetrically: inside an AND an unpushable conjunct may be dropped (that widens, and the local predicate re-narrows), inside an OR it may not (that would narrow, and rows would vanish).
