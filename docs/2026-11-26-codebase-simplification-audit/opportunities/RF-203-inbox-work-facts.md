# RF-203 — Share request-local wait and queue facts between inbox projectors

## Rank and disposition

- **Potential** High. Delete repeated fact loading and coordination across two projections. Server-lane impact rank 3, execution order 5.
- **Confidence** High for overlap, medium for achievable net source reduction. No latency measurement exists.
- **Readiness** Ready for bounded implementation after fixture/query baseline capture. Do not merge projector policy.
- **Effort/risk** Medium to large, approximately 1–3 days including focused scenarios. Medium to elevated risk to inbox eligibility, wait actors, family expansion and ordering.
- **Dependencies/overlap** RF-201 is a useful predecessor because callback state participates in the work graph. It is not a strict dependency. Count callback classification savings under RF-201 only.

## Context and evidence

At `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e`, `apps/server/src/services/inbox/collect.ts::collectInboxEntries` first selects roots/families and calls `toThreadListEntryResponses`. That calls `thread-runtime-display.ts::buildThreadListEntriesWithoutWork` and `thread-work.ts::buildThreadWorkSummaries`, which expands a dependency graph, reads waits/conditions through `readInboxWaits`, and reads queued messages. The collector then reads `listOpenWaits`, `listConditions`, and queued messages again for overlapping `memberIds`. It groups those rows independently and also translates parts of `entry.work` back to inbox inputs. Source scope: collector 669 physical lines, work-summary module 990 lines. These totals define the inspected source scope.

The two projectors have material differences:

- `thread-work.ts::readInboxWaits` selects live/evaluating/dispatched, excludes send-later and snoozed date questions, uses pending conditions and builds an actor/reason. It spans 72 lines.
- `inbox/store.ts::listOpenWaits` selects nonclosed waits, excludes archive proposals, and orders creation time. `listConditions` returns all conditions ordered by condition key. The collector needs proposal, receipt, snooze, deadline and readiness fields absent from the work projection.
- The work graph may include sources beyond the root/member list. Merely passing member-only facts would incorrectly erase dependent work. Inbox queue projection selects inline payloads and distinguishes owner/scheduled inputs. The work projector uses failure and waiting-on fields for all relevant queues.

Tests/consumers include `test/inbox/inbox-scenarios.test.ts`, `inbox-background-work.test.ts` and `test/public/public-thread-work.test.ts`, plus domain projectors in `packages/domain/src/inbox.ts` and `thread-work.ts`. Their differing display and archive decisions are not duplicate policy to delete.

## Proposed end state and preservation argument

Add a narrow internal `apps/server/src/services/threads/thread-work-facts.ts` owner for request-local raw waits, conditions and queues. It exposes a loader with explicit covered thread IDs and maps by thread/wait. Load nonclosed wait rows, including archive proposals, all conditions for those rows, and the union of fields already needed by both queue consumers. No global cache, retained state, new table, invalidation bus or generic data framework.

The collector creates this request-local fact owner for its member IDs and passes it through the existing list/work call chain. After work-graph expansion, `buildThreadWorkSummaries` asks the same owner to add only uncovered source IDs in bounded batches. The collector consumes the same loaded facts. Other list/work callers create a private instance when none is supplied. Empty IDs remain empty results, never a full-table query.

Keep all eligibility/ordering logic in each projector. The shared loader supplies a raw superset that each projector filters. The work projector applies its live/evaluating/dispatched, send-later/date and pending-condition filters. Inbox applies nonclosed/archive-proposal and inline/owner filters. Preserve the work reader's current raw condition traversal order and derive a condition-key-ordered view for inbox, so the same pending condition continues to name the actor. Preserve the current synchronous request boundary. Do not introduce a new database transaction/locking policy as part of this refactor.

The result deletes duplicate queries/grouping and summary-to-input reconstruction only where raw facts provide the exact same input. Keep work summary activity/assessment use where those outputs carry additional meaning. No changed inbox state, wait ownership, receipt clearing, deadline, queue scheduling, archive eligibility, API response, layout or copy is intended.

## Expected gain and cost

Projection based on the duplicated wait reader and collector query/grouping blocks: remove roughly 120–190 production lines, add 90–140 lines, yielding **approximately 20–80 net lines removed** after adapters. This is a confidence-bounded engineering estimate, derived from the identified blocks. If implementation needs more loader machinery, report zero/negative net reduction and reassess before expanding it. Tests may add 100–200 lines of meaningful shared-source/query assertions. No schema/config/generated savings.

Wait/condition/queue loading moves from separate projector loaders to one request owner. The two policy projectors remain. Adding a raw queue field then updates one selected shape. Query duplication should decrease for intersecting IDs. No exact query total or percentage latency gain is claimed because empty sets, graph expansion and SQLite chunks change the count. Wider rows and retained request memory may cost more than saved round trips: measure them before acceptance.

## Execution steps

1. Reconfirm graph expansion and every wait/queue predicate. Capture current JSON output and SQL operation counts for the same synthetic family fixtures through both public entry points. Stop if a projector intentionally reads a newer state later in the same request or the union requires broad historical reads.
2. Extend existing inbox/work fixtures only for uncovered cases: root+child+external callback source, archived child, failed queue, future owner queue, send-later, proposed/date/archive waits, multiple pending conditions, stopped source/stall receipt, and more than 400 expanded IDs. Keep expected outputs independent of the replacement helper.
3. Introduce the raw fact owner and explicit covered-ID set. Query nonclosed waits once per covered batch. Query their full conditions once. Query queued rows with the union of required columns. Preserve existing ordering at each consumer. Avoid fetching closed historical waits.
4. Add an internal optional fact-owner argument to `toThreadListEntryResponses`/`buildThreadWorkSummaries`. Retain default behavior for callers. Pass it from `collectInboxEntries`, extend only uncovered graph sources, and keep the work projector's filters intact. Verify work responses at this checkpoint.
5. Replace collector wait/condition/queue reloads and grouping with views over the same facts. Remove reverse translation only when equivalent raw inputs replace it. Keep unrelated receipts, marks, failures, continuations, producer and progress reads local. This card does not redesign the inbox.
6. Delete superseded loader/grouping code and imports. Run focused checks, compare outputs/query counts and inspect actual production line delta. Stop if a global cache or caller-specific loader switches are becoming necessary.

## Verification and acceptance

From repository root with the project's existing dependencies:

```sh
pnpm --filter @omnyo/server test test/inbox/inbox-scenarios.test.ts test/inbox/inbox-background-work.test.ts test/public/public-thread-work.test.ts
pnpm --filter @omnyo/domain test test/inbox.test.ts test/thread-work.test.ts
pnpm --filter @omnyo/server typecheck
```

Commands/files are inspected and supported. **Commands were not run in this audit** because no dependencies are installed. Use existing synthetic server harnesses with synthetic records only. Compare exact response objects/order for the matrix, including wait actor, schedule, failure and archive state. Do not rewrite expected state to make the replacement pass. Count actual SQL reads for overlap and graph expansion, including empty IDs, duplicate sources and 400-ID boundaries. Confirm request memory remains bounded by the same selected active facts and does not accumulate across calls.

Performance acceptance requires a comparable before/after local fixture of representative inbox sizes and expanded dependency graphs, recording elapsed/CPU/query count and row volume. No invented regression threshold: investigate a repeatable regression beyond ordinary run variation. No full UI round is required for a pure data-loading change, but API/domain projector equality is mandatory. Changed output requires regression investigation.

Structural acceptance: overlapping IDs are loaded once per request, expansion loads only missing IDs, policy stays distinct, and the old repeated selects/grouping paths disappear without a long-lived cache.

## Rollback and stop conditions

No persistence migration. Keep the loader introduction and second-consumer adoption as working checkpoints, with the temporary dual path removed in the final checkpoint. Revert only owned source/test changes if outputs diverge. Stop for unresolved condition ordering, missing graph sources, memory growth, changed queue error semantics or an unbounded historical query. A smaller queue-only extraction is the safe alternative if wait semantics require more machinery than they remove. Report the reduced benefit and the remaining portion of this card explicitly.
