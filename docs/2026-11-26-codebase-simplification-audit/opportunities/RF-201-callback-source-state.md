# RF-201 — Load and classify callback sources once

## Rank and disposition

- **Potential** High. Two definitions of dependency state become one. Server-lane impact rank 1, execution order 2.
- **Confidence** High from current source. This audit did not rerun the earlier fixture.
- **Readiness** Conditional on separately authorizing the conflicting-state correction in [ISS-201](../server-issues.md#iss-201--callback-readers-classify-the-same-source-differently). Do not silently select a new precedence in a pure refactor.
- **Effort/risk** Small to medium, approximately 0.5–1.5 days with characterization. Medium risk to dependency/attention display and decisions driven by that display.
- **Dependencies/overlap** Independent of RF-200/RF-202. Coordinate loader reuse with RF-203, but do not count the same wait/queue read savings twice.

## Context and evidence

At snapshot `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e`, `packages/db/src/data/thread-attention.ts` maintains two callback source-state paths:

- `getCallbackSourceState` reads one source, required questions, pending interaction, background-agent counts, native workers and queue. It does not include `activeBackgroundCommandCount` or `activeWorkflowCount`. Its queued-interaction check happens after error/working checks.
- `readThreadAttentionFacts` loads distinct source IDs in batches of 400. It includes agent, command and workflow counts, adds queued interaction to `needsInput` before error/working classification, and assembles `ThreadCallback` objects with another state decision tree.

`toThreadCallback` additionally loads the source title separately before invoking the single-source reader. `listThreadCallbacks` joins owner threads, excluding archived/deleted owners, orders callbacks by creation, then calls that mapper per row. The batch reader supplies work/list projection through `apps/server/src/services/threads/thread-runtime-display.ts`. `apps/server/src/routes/thread-attention.ts` uses the single-reader callback list and mapper. Search scope was `apps packages plugins scripts`, covering public DB exports and runtime/server callers.

Counterevidence: owner filtering differs intentionally between an unscoped callback list and a requested-ID facts reader. Callback ordering, source title fallback, null sources, source archival/deletion and worker ownership are required. Eliminating a second classifier does not authorize changing those. `packages/db/test/data/thread-attention.test.ts` covers null sources, eligible queues and native worker ownership but its existing single-reader case does not compare both public readers for commands/workflows or overlapping states.

The old audit reported a runtime mismatch. This audit independently proves its cause by inspection. No current execution claim is made.

## Proposed end state and preservation argument

Create an internal batch source loader in the same module, taking distinct source IDs and returning source row/title plus already-classified source state. It retains the batch query structure and 400-ID bounds. Both readers assemble callbacks from this map. `getCallbackSourceState(db, id)` delegates with a singleton ID. `toThreadCallback` reuses the resolved source. `listThreadCallbacks` resolves all source IDs once and preserves its current owner selection/order. Keep the new loader separate from `readThreadAttentionFacts`, which loads callbacks owned by the supplied thread ID.

Keep one pure classification function over explicit facts: nullable source, archived/deleted flags, pending interaction/required question, queued interaction, status, open work and pending queue. Establish the corrected precedence before extraction under ISS-201. A proposed consistency contract, supported by the existing batch path, is `unverified → unavailable → archived → needs-input → error → working → waiting → idle`, with queued interaction included in needs-input and agent/command/workflow/native-worker activity included in working. Approval of implementation must explicitly include that behavior correction. The later consolidation preserves it. No persisted format, callback ID/generation/marker/cursor or clearing behavior changes.

## Expected gain and cost

Projection based on the 405-line module: delete roughly 55–90 production lines and add 20–45 lines, for **25–60 net lines removed**. Tests likely add 70–140 lines for the cross-reader matrix. Mechanisms: two source classifiers become one. Per-row list source lookups become one bounded loader over unique sources. The benefit is fewer query and classification owners. Runtime latency remains unmeasured. A new source-work kind or precedence change then has one policy edit and one common expectation table. Keep indexes/schema/migrations unchanged.

## Execution steps

1. Reconfirm source-state callers and owner eligibility. Stop if either surface intentionally exposes a different product meaning. Record that decision and reassess the shared-classifier plan.
2. Add a table-driven matrix in `packages/db/test/data/thread-attention.test.ts` invoking `getCallbackSourceState`, `listThreadCallbacks` and `readThreadAttentionFacts` on the same synthetic owner/source fixture. Include null/missing/deleted/archived, all statuses, required vs optional questions, pending/resolving interactions, failed/scheduled queues, queued interaction with error/work, each background task kind, and active/queued/archived native workers. Observe existing divergence before the correction.
3. Under separate correctness scope, align the two paths to the accepted matrix. Keep this checkpoint distinguishable from extraction.
4. Extract the current batch source-loading block into `readCallbackSources(db, sourceIds)` and the common classifier. Preserve deduplication/chunking and existing parse failures. Do not swallow malformed persisted queue data as idle.
5. Have the single API, mapper, list API and attention reader use it. Keep exported signatures stable. Remove the old decision tree, redundant source reads and now-unused prepared-query helper/imports only when no other consumer needs them.
6. Run focused checks and compare list ordering, title fallback and facts objects before/after for unchanged cases. Count actual query calls for many callbacks sharing one source and more than 400 unique sources.

## Verification and acceptance

From the repository root, with existing installed dependencies:

```sh
pnpm --filter @omnyo/db test test/data/thread-attention.test.ts
pnpm --filter @omnyo/server test test/public/public-thread-work.test.ts
pnpm --filter @omnyo/db typecheck
pnpm --filter @omnyo/server typecheck
```

These commands are repository-supported but **not run in the audit** because dependencies are absent. Extend the existing DB test with real synthetic rows. Keep adoption/generation/cursor cases intact. Acceptance requires all public readers to match the accepted matrix, one classifier, no per-callback reload loop, and unchanged list eligibility/order/title behavior. Query count must scale with distinct source batches. There is no source-only proof of faster runtime. Compare fixed fixtures before/after if claiming speed. No UI restyling is in scope. Only the separately approved correction may change a state label.

## Rollback and stop conditions

No schema/data migration. Keep the behavior correction and structural consolidation as separate reversible changes. Revert only owned changes. Stop if a live external reader relies on documented differing semantics, if source IDs expand differently than expected, if a real index/fixture reveals worse batching cost, or if parse/error behavior changes. Prefer retaining the current batch queries and replacing only the duplicate classifier over introducing a new generic facts framework.
