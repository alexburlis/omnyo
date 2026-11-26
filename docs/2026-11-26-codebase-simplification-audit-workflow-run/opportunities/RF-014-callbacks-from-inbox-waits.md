# RF-014 — Delete the read, reconcile and forwarding machinery over the drained `thread_callbacks` table, and give callback state one store (inbox waits) and one source-state classifier

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The central claim holds. Since private-history commit `9aab00e6cc` (2026-10-29, "bb callback wait becomes a chat continuation"), `omnyo callback wait` writes an inbox wait, and the 10-second inbox sweep converts and deletes every `thread_callbacks` row. Eleven production sites still read, reconcile, forward, clean up or classify that table. The sweep reports needed four corrections:
  1. The inbox rule `sourceHasLiveOwner` is a yes/no rule for admitting and stalling waits. It cannot be the single eight-state display classifier. The surviving classifier is the batch classifier in `readThreadAttentionFacts`. Whether the display and stall rules should share inputs is a separate policy choice.
  2. Projecting callbacks from waits is not free. It needs a wait-based change forwarder and `interactions-changed` notifications from the inbox. It also needs one de-duplication rule in thread work, because `readInboxWaits` already lists every callback wait.
  3. Restoring callbacks changes visible behaviour that has been absent since 2026-10-29: status glyphs, banners, sidebar callback links, push-notification gating, CLI output and agent instructions. That restoration is a behaviour fix with its own owner decision, not a neutral refactor.
  4. The work therefore splits into a Phase 1 that is ready now and a Phase 2 that waits on the owner's choice between two paths.
- **Potential:** high. Phase 1 removes about 200 net production lines and four mechanisms: the prompt-matching reconciler, the per-row seven-query classifier, the startup reconcile, and the reconcile half of the hub listener. Phase 2 removes the second store from every reader. Path 2B saves about 215 more lines. Path 2A keeps the classifier and adds about 55 to 90 lines of wait wiring.
- **Confidence:** high that the table is drained and the machinery is dead in practice. Medium on the Phase 2A line estimate.
- **Readiness:** decision-needed overall. Phase 1 is ready. Phase 2 needs the owner decision in the gate below.
- **Effort:** Phase 1 takes about half a day. Path 2B takes about half a day. Path 2A takes one to two days including tests.
- **Risk:** Phase 1 is low risk: observable outputs change only for legacy rows that live 10 seconds or less. Phase 2 is medium risk. It touches the public `experimental_attention` SDK result, the WS `interactions-changed` metadata, the thread-list `attention` kinds, the thread-work revision digest and push-notification eligibility.
- **Prerequisites:** none for Phase 1. Phase 2 needs the owner decision (gate G1) and a precedence choice (gate G2).
- **Related and overlapping items:**
  - **RF-043 (retire the legacy decisions/needs-you attention adoption).** RF-043 owns the table's only writer. If RF-043 lands first, Phase 1 step 3 (synchronous conversion inside adoption) disappears. Keep `convertLegacyCallbacks` until RF-043 decides how upgrades from old databases convert. Count the adoption code under RF-043 only.
  - **RF-136 (retire the eight thread-indicator kinds nothing produces).** `callback-waiting` and `dependency-failed` are produced today by `summarizeThreadAttention`, but in practice never, because the table is empty. Path 2B makes them truly unproduced. RF-136 must not count them unless 2B is chosen, and 2B must not delete them without RF-136's SDK-contract handling.
  - **Earlier draft.** `docs/2026-11-26-codebase-simplification-audit/opportunities/RF-201-callback-source-state.md` belongs to an earlier pass of this audit. It covers only the two-classifier half, which is the sweep's fallback S09.
- **Why it deserves its place:** one concept, "this chat waits for that chat's result", has two stores, two classifiers and a reconciler. That reconciler matches prompt text, and the 2026-10-29 commit removed its tests on purpose because prompt matching was replaced. Every change to callback semantics has to reason about both stores. Meanwhile the attention surfaces that read only the old store have shown nothing for a month.

**Context and evidence**

The snapshot is commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The dedicated snapshot worktree no longer existed at verification time. Files were therefore read with `git -C $OMNYO_CHECKOUT show e9e1b74c3:<path>` and searched with `git grep <pattern> e9e1b74c3 -- <scope>`. `git diff --stat e9e1b74c3 5f2d3f895` (local `main`) showed changes only in `apps/server/src/services/threads/thread-work.ts` among the cited files: 47 lines elsewhere in that file. Recheck thread-work anchors before editing. No tests ran, because the snapshot has no `node_modules`. All behavioural claims below are Proven by inspection unless labelled otherwise.

*What a callback is.* An agent in chat A runs `omnyo callback wait --self --from B --reason TEXT`. B is a chat that is already working. A gets a marker, includes the marker in its request to B, and B replies with `omnyo thread tell A --mode auto`. The old design stored this in `thread_callbacks` (migration `packages/db/drizzle/0149_new_dormammu.sql`, schema `packages/db/src/schema.ts:1392` `threadCallbacks`, primary key `threadId`, so one row per waiter). It detected fulfilment by scanning A's `client/turn/requested` events for B's message containing the match text. The current design is an inbox chat-continuation wait.

*Current writer and drain.*
- `apps/server/src/services/interactions/thread-attention.ts:316-345` (`executeAttentionCommand`, action `wait`) calls `registerWait` with key `` `callback:${command.sourceThreadId}` ``, a chat condition, and `forText: command.reason.slice(0, INBOX_FOR_TEXT_MAX)` (60 characters, `packages/domain/src/inbox.ts:30`). It returns `callbackMarker`.
- `apps/server/test/public/public-thread-callback-alias.test.ts:90` asserts that `thread_callbacks` stays empty after a callback wait. Lines 173-200 assert that a legacy row is converted and its old `[callback-wait:<id>]` marker still routes.
- The only production inserts into `threadCallbacks` are in `packages/db/src/thread-attention-adoption.ts:194` and `:207` (`adoptLegacyThreadAttention`, needs-you `callback_waits` and `external_waits`). They are guarded once per database by `threadAttentionImports`. Adoption is triggered by `plugins/ask-user-question/src/server.ts:111` on every plugin start, and it is a no-op after the first import. The CLI `omnyo question adopt` path goes through `apps/server/src/routes/thread-attention.ts:57`.
- `apps/server/src/services/inbox/sweep.ts:24-79` (`convertLegacyCallbacks`) inserts a `callback:` wait and its condition, then deletes the row. `runInboxSweep` (`sweep.ts:127-159`) runs it first inside one immediate transaction. The sweep is registered as `inbox-due-sweep` with `cadenceMs: 0` at `apps/server/src/services/system/periodic-sweeps.ts:730-734` and driven by the 10-second `setInterval` at `apps/server/src/start-server.ts:716-722`. It is not part of `runStartupRecoverySweep` (`periodic-sweeps.ts:808`).
- Search: `git grep -n "insert(threadCallbacks)\|threadCallbacks" e9e1b74c3 -- apps packages plugins scripts tests` excluding tests. Production hits: the two adoption inserts, the sweep, and the readers listed below. Raw-string `thread_callbacks` appears only in the migration, its meta snapshots, `schema.ts` and the test helper `packages/db/test/helpers/rewind.ts:233`. `@omnyo/db` is `"private": true`.
- History: `git -C $ARCHIVED_OMNYO_CHECKOUT show 9aab00e6cc` states: "The sweep converts any remaining legacy callback rows into continuations… Removes public-thread-callback-acceptance.test.ts and the callback cases in the attention suites, which asserted prompt-based fulfillment". The public repository's history starts at `060950255` (2026-11-24).

*Production readers of the drained table* (non-blank line counts from `git show e9e1b74c3:<file> | sed -n '<range>p' | grep -c .`):

| Site | Symbol and lines | What it does | Non-blank lines |
|---|---|---|---|
| `packages/db/src/data/thread-attention.ts` | `prepareGetRequiredOpenThreadQuestion` 71-83, `getCallbackSourceState` 85-128 | Per-source classifier (about 7 queries per row, including a full queue list) | 13 + 37 |
| same | `toThreadCallback` 130-142 | Adds title and state per row (calls `getThread` twice) | 12 |
| same | `listThreadCallbacks` 144-164 | Owner-visible rows ordered by `createdAt` | 21 |
| same | `readThreadAttentionFacts` 222, 240-246 (load) and 249-360 (batch classifier) | Thread-list and thread-work attention facts | 8 + 100 |
| same | `listNativeWorkerOwners` 365-405 | Workflow-worker "working" signal; used only by the two classifiers | 37 |
| same | `summarizeThreadAttention` 190-192, 198-207 | `dependency-failed` and `callback-waiting` kinds, `callback` field | about 10 |
| `apps/server/src/services/interactions/thread-attention.ts` | `reconcileThreadCallbacks` 100-184 | Prompt-text fulfilment (no test covers it at the snapshot: `git grep -n reconcileThreadCallbacks e9e1b74c3 -- '**/test/**' '*.test.ts'` finds nothing) | 74 |
| same | `threadAttentionSnapshot` 187; `notifyThreadAttentionChanged` 95; results at 228, 394, 516 | Runs the reconcile, then lists callbacks | 1 + list calls |
| same | `clear` fallback 362-371 | Deletes a legacy row when the id is not a wait | 10 |
| `apps/server/src/routes/thread-attention.ts` | `get(attention.thread)` 38; `hub.onThreadChanged` listener 60-123; startup `reconcileThreadCallbacks(deps)` 124 | Two queries on every thread change; forwards source-state changes to waiters | 57 |
| `apps/server/src/services/threads/thread-work.ts` | callback evidence 671-717; revision digest entry 947-951 | Work activity, waits and failures from callbacks | 46 + 5 |
| `apps/server/src/services/threads/thread-runtime-config.ts` | 314, 334-337 | "Native callback dependencies" instruction section | 5 |
| `apps/server/src/services/inbox/failure-acknowledgment.ts` | 125-129 | Refuses a failure acknowledgment while a row exists | 5 |
| `packages/db/src/data/threads.ts` | `archiveThread` 3267-3276, 3289-3290 | Deletes rows on archive and adds `interactions-changed` | 12 |
| `apps/server/src/services/threads/thread-runtime-display.ts` | 658-659 | Thread-list attention through `readThreadAttentionFacts` | (consumer) |

*Two classifiers disagree.* This is the cause behind ISS-201 in `server-issues.md`; Proven by inspection here, and reproduced by the 2026-11-25 audit at `eb5a9bc7d`. `getCallbackSourceState` checks only `activeBackgroundAgentCount` (line 110). It also tests a queued interaction after error and working (lines 114-125). The batch classifier counts agent, command and workflow tasks (lines 320-328) and adds queued interactions to needs-input before the error check (lines 312-317). A third rule, `sourceHasLiveOwner` (`apps/server/src/services/inbox/waits.ts:270-294`), is a yes/no admission and stall rule. It counts open non-proposed waits, owner inputs, active producers and any background task row. It drives `registerWait` admission (line 447) and `sweepStalledSources` through `sourceIsIdle` (lines 1386-1395). It does not produce display states.

*Consumers of the callback field and kinds (all still in place):*
- **Public SDK.** The `ThreadCallback` type is exported from `packages/sdk/src/public-types.ts:17`. Its schema is `threadCallbackSchema` / `threadAttentionSchema` / `threadAttentionSnapshotSchema` in `packages/domain/src/thread-attention.ts:91-128`, exposed through `sdk.experimental_attention.snapshot()`, `.thread` and `.command`.
- **App.** `apps/app/src/components/thread/user-questions/NativeThreadAttention.tsx:56-73` (`NativeCallback` 251-284, `WaitingChats` 299+), `apps/app/src/views/thread-detail/ThreadDetailPromptArea.tsx:472`, the WS cache merge `apps/app/src/hooks/cache-owners/thread-attention-cache-owner.ts:27-32`, and the glyphs `apps/app/src/components/thread/ThreadStatusGlyph.tsx:20-21,143-144,205-206`.
- **CLI.** `apps/cli/src/commands/attention.ts:101-119` (`omnyo callback waiting`) filters `snapshot().callbacks`. It is documented in `plugins/omnyo-guide/skills/omnyo-cli/references/thread-operation.md:137`, `command-index.md:16-20` and `packages/templates/src/templates/omnyo-guide-threads.md:29`. `omnyo callback clear --id EXACT_ID` expects an id taken from that listing.
- **Plugins.** `plugins/ask-user-question/src/sidebar/callback-ui.tsx:27-30` and `callback-links.ts:52-80` draw the callback lanes advertised in `plugins/ask-user-question/PLUGIN_OVERVIEW.md:11`. The attention kinds feed `plugins/ask-user-question/src/sidebar/overlay.tsx:136-139`, `plugins/push-notifications/notification-eligibility.ts:46-50` and `sender.ts:401`.
- **Agent instructions.** `CALLBACK_INSTRUCTIONS` (`thread-runtime-config.ts:62-63`).

*Observed consequence (ISS-S06-001, Proven by inspection).* Because every reader sees only `thread_callbacks`, every one of these surfaces has been empty since 2026-10-29, apart from the 10-second window after adoption. The empty surfaces are the banner, the "Waiting on this chat" list, the sidebar lanes, the `callback-waiting` and `dependency-failed` kinds, `omnyo callback waiting`, and the agent dependency list. Callback waits are still visible through the inbox: thread work's `readInboxWaits` (`thread-work.ts:417-485`) shows "Waiting for: <forText>", and `omnyo wait list` reads `GET` inbox waits (`apps/server/src/routes/inbox.ts:197-215`, which also returns `waitingChatIds` from `waitersOnSource`).

*Maintenance cost today.* A change to "what counts as the source still working" has three edit sites (two classifiers and the inbox rule), and two of them already disagree. A change to callback lifecycle has to consider a reconciler, a hub listener, an archive cleanup, a failure-ack guard and a clear fallback. All of them act on a table that is empty within 10 seconds.

**Proposed end state and preservation argument**

*Phase 1 (ready; behaviour-preserving apart from legacy rows that live 10 seconds or less).*
- **Removed:**
  - `reconcileThreadCallbacks` and its three call sites.
  - The reconcile half of the route listener. In Phase 1 the whole listener goes, because it only serves transient rows.
  - The startup reconcile.
  - `getCallbackSourceState`, `prepareGetRequiredOpenThreadQuestion` and the per-row `toThreadCallback`.
  - The `clear` fallback delete.
  - The failure-ack `threadCallbacks` guard.
  - The `archiveThread` callback delete and its `interactions-changed` flag.
- **Kept:**
  - `listThreadCallbacks` keeps its owner-visibility join and `createdAt` order. It now classifies through one extracted batch function, `classifyCallbackRows(db, rows)`, taken from `readThreadAttentionFacts` lines 249-360.
  - `convertLegacyCallbacks` remains the sweep backstop for databases upgraded with rows in place.
  - The table, migration 0149 and the schema declaration stay.
- **New:** the server adoption wrapper `adoptLegacyAttention` (`apps/server/src/services/interactions/thread-attention-adoption.ts:5-18`) calls `convertLegacyCallbacks` in an immediate transaction right after `adoptLegacyThreadAttention`. Adopted rows then never outlive the request.
- **Preservation:**
  - The wire shapes are unchanged.
  - The marker routing tested in `public-thread-callback-alias.test.ts` is unchanged, because it lives in the inbox.
  - The only observable differences affect a legacy row before its conversion. Such a row now gets batch precedence: background commands and workflows count as working, and needs-input wins over error. A legacy row on a thread archived during that window is converted into a wait instead of deleted, matching how inbox waits on archived chats already behave (`dispatchWake` refuses archived waiters, `waits.ts:877-883`). An acknowledgment in that window is not blocked by the row.
  - Document these differences in the commit message.

*Phase 2: one store. The owner picks one path in gate G1.*

- **Path 2A (restore the documented surfaces; recommended if the callback UI is still wanted).**
  - Callbacks are projected from open waits whose `key` starts with `callback:`, with no row in `thread_callbacks`.
  - The projection lives in `packages/db/src/data/thread-attention.ts`, next to the classifier. The `threadWaits` and `threadWaitConditions` schemas are already in `@omnyo/db`.
  - Owed-callback rule: the same as `isOwedCallback` (`waits.ts:1368-1373`). The wait status is `live` or `evaluating`, and its condition `state === "pending"`.
  - Mapping from wait to callback:

    | `ThreadCallback` field | Source |
    |---|---|
    | `id` | `wait.id`, so `omnyo callback clear --id` works with the listed id |
    | `threadId` | `wait.threadId` |
    | `sourceThreadId` | the chat condition `target`, or `null` for a `kind: "event"` legacy wait |
    | `sourceTitle` | source `title ?? titleFallback ?? condition.label` |
    | `reason` | `wait.forText` |
    | `createdAt` | `wait.createdAt` |
    | `afterSeq` | `condition.afterSeq ?? 0` |
    | `matchText` | `wait.marker` |
    | `sourceState` | `classifyCallbackRows` |

  - `listThreadCallbacks` and `readThreadAttentionFacts` read this projection, so one store and one classifier serve the list, attention, CLI, instruction and thread-work consumers.
  - A wait-based forwarder replaces the old route listener. On `hub.onThreadChanged(id)` it finds owed callback waits whose condition target is `id`, or `id`'s workflow lifecycle owner, using `listPendingChatConditionsForSources`. It calls `notifyThreadAttentionChanged(waiterId)` only when `sourceState` or `sourceTitle` changed, keeping today's `forwardedSourceStates` dedupe.
  - The inbox calls `notifyThreadAttentionChanged` for the waiter whenever a `callback:` wait is registered, closed or met.
  - Thread work shows each callback wait once. `readInboxWaits` skips `callback:` keys, and the callback block in `thread-work.ts:671-717` stays as the richer description.
  - Behaviour restored on purpose: glyphs, banners, lanes, `callback-waiting` and `dependency-failed` kinds, push gating (`dependency-failed` notifies, and `callback-waiting` keeps a chat counted as open work), `omnyo callback waiting` output, and agent instructions.
  - `reason` shows at most 60 characters, because registration truncates it today; see newIssue on truncation.
  - Revision digests change for threads with callback waits, which costs one refetch each.

- **Path 2B (retire the attention view of callbacks; inbox waits are the only view).**
  - `listThreadCallbacks`, the callback half of `readThreadAttentionFacts`, the classifier, `listNativeWorkerOwners`, the callback branches of `summarizeThreadAttention`, the thread-work callback block, and the runtime-config callback section are deleted.
  - Every response keeps `callbacks: []` and `callback: null`, so the SDK schema, CLI JSON shape and WS metadata shape stay valid.
  - The thread-work digest keeps its value for every thread: replace `attention?.callbacks.map(...)` with `attention === undefined ? undefined : []`.
  - The CLI docs point `callback waiting` users to `omnyo wait list`. Alternatively, `omnyo callback waiting` can print open `callback:` waits from the inbox waits route.
  - This path preserves today's observed behaviour exactly. It retires a documented feature (the PLUGIN_OVERVIEW callback lanes, the "Waiting for another chat" banner) that has silently not worked since 2026-10-29.
  - Deleting the now-unreachable client UI and the `callback-waiting` and `dependency-failed` kinds is a further SDK-contract retirement, owned by RF-136 and an owner decision. It is not counted here.

*Canonical owners after either path.* `thread_waits` is the only live callback store. `classifyCallbackRows` is the only display classifier (2A), or there is none (2B). `sourceHasLiveOwner` stays the inbox admission and stall rule. `convertLegacyCallbacks` is the only reader of `thread_callbacks` until RF-043 decides its fate.

*Non-goals.*
- Do not drop the table, the migration or the schema export.
- Do not change marker routing, the deadline or the stall escalation.
- Do not merge `sourceHasLiveOwner` into the display classifier unless gate G2 explicitly asks for it.
- Do not change `INBOX_FOR_TEXT_MAX`.

*Reachability of the deleted code.* Rows exist only between adoption, or server start on an upgraded database, and the next sweep. After Phase 1 step 3 they exist only between server start and the first sweep, on databases that already held rows. Every deleted reader acts only on those rows. Remaining uncertainty: an external plugin or older client that calls `sdk.experimental_attention.*` and relies on non-empty `callbacks`. That field has been empty for a month, so Phase 1 cannot regress such a caller. Path 2A gives it data again, and path 2B keeps it empty.

**Expected gain and cost**

All figures are projections from non-blank production line counts at the snapshot. Tests are counted separately.

| Scope | Removed | Added | Net |
|---|---|---|---|
| Phase 1 | about 228 (13 + 37 + 12 + 74 + 1 + 10 + 57 + 5 + 12 + about 7 imports) | about 20-30 (classifier extraction signature, adapter in `listThreadCallbacks`, sync conversion call) | about −200 |
| Phase 2B (additional) | about 225 (21 + 8 + 100 + 37 + 10 + 46 + 5) | about 10 (`[]` literals, digest expression) | about −215; Phase 1 + 2B ≈ −415 |
| Phase 2A (additional) | about 29 (old row loaders) | about 85-120 (projection 45-60, forwarder 25-35, inbox notifications 10-20, `readInboxWaits` filter 3) | about +55 to +90; Phase 1 + 2A ≈ −110 to −145 |

Mechanisms before and after:

| Mechanism | Before | After Phase 1 | After 2A | After 2B |
|---|---|---|---|---|
| Live callback stores read by consumers | 2 (`thread_callbacks`, `thread_waits`) | 2 | 1 | 1 |
| Display source-state classifiers | 2 | 1 | 1 | 0 |
| Prompt-text fulfilment reconciler | 1 | 0 | 0 | 0 |
| Per-thread-change listener | 1 (reconcile and forward) | 0 | 1 (forward only, wait-based) | 0 |
| Legacy cleanup branches (archive, failure-ack, clear) | 3 | 0 | 0 | 0 |

- **Tests (separate count).**
  - `packages/db/test/data/thread-attention.test.ts:327-409` (single-path classifier test) becomes a precedence table over `classifyCallbackRows`.
  - `packages/db/test/data/archive-callback-waits.test.ts` (113 lines) is deleted in Phase 1. Its "archive cancels callbacks" contract no longer exists.
  - The `"callback"` case in `apps/server/test/inbox/inbox-failure-ack.test.ts:643-700` is removed, because the `"wait"` case covers the surviving guard.
  - `apps/server/test/public/public-thread-work.test.ts:207-240` is ported to a real `callback wait` in 2A, or deleted in 2B.
  - Path 2A adds projection, forwarder and notification tests.
- **Maintenance.** After 2A, a new "working" signal is added in one classifier. Callback lifecycle is the inbox lifecycle, so no second store needs cleanup on archive, acknowledgment or clear. After 2B, callbacks have no display rule outside the inbox.
- **Performance (Hypothesis, unmeasured).**
  - Phase 1 removes two point queries from every `hub.onThreadChanged`. It also removes a full `thread_callbacks` scan from every attention snapshot; the ask-user-question sidebar requests a snapshot on every `thread:changed`.
  - Path 2A adds one `thread_waits` and `thread_wait_conditions` query per attention batch and per thread change (indexed by `thread_waits_thread_status_idx` and `thread_wait_conditions_target_idx`).
  - Path 2B removes the callback work from every thread-list build.
  - Measure with `apps/server/test/performance/history-stalls.bench.test.ts` before claiming a gain.

**Execution steps**

1. **Reconfirm.** At the target commit, rerun:
   - `git grep -n "threadCallbacks\|thread_callbacks\|listThreadCallbacks\|toThreadCallback\|getCallbackSourceState\|reconcileThreadCallbacks\|listNativeWorkerOwners\|readThreadAttentionFacts" HEAD -- apps packages plugins scripts tests`
   - `git grep -n 'callback:' HEAD -- apps/server/src/services`

   Stop and re-plan if any of these holds:
   - Any production insert into `threadCallbacks` exists outside `thread-attention-adoption.ts`.
   - `executeAttentionCommand`'s `wait` action no longer uses `registerWait`.
   - `convertLegacyCallbacks` is no longer called from `runInboxSweep`.
   - RF-043 has already changed the adoption path.

**Phase 1 (no decision needed)**

2. **Extract the classifier** in `packages/db/src/data/thread-attention.ts`. Add a non-exported `classifyCallbackRows(db: DbConnection, rows: readonly (typeof threadCallbacks.$inferSelect)[]): ThreadCallback[]`.
   - Move lines 249-360 into it unchanged: the source batch loads in groups of 400 ids, the `needsInput`, `working` and `queued` sets, `listNativeWorkerOwners`, the precedence ternary, and the title fallback `source?.title ?? source?.titleFallback ?? row.sourceTitle`.
   - Return results in input order.
   - `readThreadAttentionFacts` calls it once and pushes each result to `result.get(row.threadId)?.callbacks`.
   - `listThreadCallbacks` keeps its query (lines 148-162) and maps the rows through `classifyCallbackRows(db, rows)` instead of `toThreadCallback`.
   - Delete `getCallbackSourceState`, `prepareGetRequiredOpenThreadQuestion`, `toThreadCallback`, and the now-unused imports (`placeholder`, `prepareCachedQuery`, `getThread`, `getActivePendingInteractionForThread`, `listQueuedThreadMessages`, if unused).
   - **Checkpoint:** `packages/db` typecheck passes, and the precedence table test from step 8 passes.
3. **Convert synchronously on adoption.** In `apps/server/src/services/interactions/thread-attention-adoption.ts` `adoptLegacyAttention`, after `adoptLegacyThreadAttention(...)` returns, run `deps.db.transaction((tx) => convertLegacyCallbacks(tx, Date.now()), { behavior: "immediate" })`. Import it from `../inbox/sweep.js`. Notify each returned thread id with `deps.hub.notifyThread(id, ["work-changed"])` in addition to the existing `notifyThreadAttentionChanged`. Leave `convertLegacyCallbacks` in `runInboxSweep` as the backstop for upgraded databases.
4. **Delete the reconciler.** In `apps/server/src/services/interactions/thread-attention.ts`:
   - Delete `reconcileThreadCallbacks` (100-184).
   - Delete its call in `threadAttentionSnapshot` (187).
   - Replace the `clear` ternary's legacy branch (362-371) with `: false`.
   - Drop the now-unused imports `listStoredEventRows`, `parseStoredEvent`, `threadCallbacks` and `inArray`, if unused.
5. **Delete the route listener.** In `apps/server/src/routes/thread-attention.ts`:
   - Delete `reconcileThreadCallbacks(deps, thread.id)` (38).
   - Delete the `notifying` / `forwardedSourceStates` / `deps.hub.onThreadChanged` block (60-123) and the startup call (124).
   - Drop the `threadCallbacks`, `threads`, `toThreadCallback`, `reconcileThreadCallbacks`, `eq`, `inArray` and `or` imports.
   - **Checkpoint:** `apps/server` typecheck passes, and `public-thread-callback-alias.test.ts` plus `public-thread-attention.test.ts` pass.
6. **Delete the cleanup branches.**
   - In `apps/server/src/services/inbox/failure-acknowledgment.ts`, delete lines 125-129 and the `threadCallbacks` import.
   - In `packages/db/src/data/threads.ts` `archiveThread`, delete the `cancelledCallbackThreadIds` computation (3267-3276), its return field, the `interactions-changed` push (3289-3290) and the `threadCallbacks` import.
   - Delete `packages/db/test/data/archive-callback-waits.test.ts`, and the `"callback"` entry and branch in `inbox-failure-ack.test.ts:646,685-698`.
7. **Phase 1 diff review.** No remaining reference to the deleted symbols. `thread_callbacks` is read only by `convertLegacyCallbacks`, `listThreadCallbacks` and `readThreadAttentionFacts`. Recount the removed lines with the same `grep -c .` method.

**Phase 2 gate (decision before any Phase 2 edit)**

- **G1, product decision for Alex.** Should callback waits appear again in the attention surfaces (path 2A)? Those surfaces are the thread banner, "Waiting on this chat", the Needs You sidebar lanes, the `callback-waiting` and `dependency-failed` kinds with their push-notification gating, `omnyo callback waiting`, and the agent dependency list. Or are those surfaces retired in favour of inbox waits and `omnyo wait list` (path 2B)? Evidence for the decision: those surfaces have been empty since 2026-10-29, and `PLUGIN_OVERVIEW.md:11` and the CLI guides still advertise them.
- **G2, needed for 2A only.** Confirm the batch precedence: unverified, then unavailable, archived, needs-input, error, working (status, any background agent, command or workflow, or workflow worker), waiting (eligible queue), and finally idle. Also decide whether the display "working" should also count `sourceHasLiveOwner`'s inputs (open waits, owner inputs, producers). Record the answer in the precedence test.

**Path 2A steps**

8. **Projection.** In `packages/db/src/data/thread-attention.ts`, add `listCallbackWaitRows(db, filter: { ownerIds?: readonly string[] })`. It selects `threadWaits` joined to `threadWaitConditions` where `key LIKE 'callback:%'`, `status IN ('live','evaluating')`, the condition `state = 'pending'`, and the owner is not deleted or archived. It returns rows in the existing `typeof threadCallbacks.$inferSelect` shape, using the mapping table in the end-state section; for event-kind waits, `sourceThreadId` is null and `sourceTitle` is the condition label. Use groups of 400 ids. `listThreadCallbacks` and `readThreadAttentionFacts` switch their loaders to it and keep `classifyCallbackRows`. Delete their `threadCallbacks` selects. Add the precedence table test, run through both `listThreadCallbacks` and `readThreadAttentionFacts`, with these cases: null source, missing, deleted, archived, error, error with queued interaction, active with queued interaction, idle with background command, idle with workflow, workflow worker, eligible queue, failed queue.
9. **Notifications.** In `apps/server/src/services/interactions/thread-attention.ts`, the `wait` and `clear` actions already end in `notifyThreadAttentionChanged`, so keep that. In the inbox, every place that closes or meets a `callback:` wait must also call `notifyThreadAttentionChanged(deps, wait.threadId)`. Find them by grepping `updateWait(` and condition `state: "met"` in `apps/server/src/services/inbox/*.ts`, and limit the notification to `wait.key.startsWith("callback:")`.
10. **Forwarder.** In `apps/server/src/routes/thread-attention.ts`, add a listener on `deps.hub.onThreadChanged(id)`. It computes `sources` as before (id, plus the lifecycle owner for `originPluginId === "workflows"`). It finds owed `callback:` waits through `listPendingChatConditionsForSources`, keeps the re-entrancy guard and the `forwardedSourceStates` dedupe keyed `${waiterId}:${waitId}`, and classifies with one `listThreadCallbacks`-style batch call rather than per row.
11. **Thread-work de-duplication.** In `apps/server/src/services/threads/thread-work.ts` `readInboxWaits`, add `&& !row.key.startsWith("callback:")` to the filter; select `key`. Port `public-thread-work.test.ts:207-240` to a real `callback wait`.
12. **Docs.** Update `plugins/omnyo-guide/skills/omnyo-cli/references/thread-operation.md:136-138` to say that `callback waiting` lists wait ids accepted by `callback clear`.

**Path 2B steps**

8. **Empty field.** Delete `listThreadCallbacks`, `classifyCallbackRows`, `listNativeWorkerOwners`, and the callback load in `readThreadAttentionFacts`; `ThreadAttentionFacts` keeps `callbacks: ThreadCallback[]` as `[]`, or remove the field and adjust the consumers. Replace each `callbacks: listThreadCallbacks(...)` with `callbacks: []` at `interactions/thread-attention.ts:95,191,228,394,516` and `routes/thread-attention.ts:42`.
9. **Attention kinds.** Simplify `summarizeThreadAttention` so `kind` is `required-answer`, `optional-input` or `none`, with `callback: null`.
10. **Thread work.** In `thread-work.ts`, delete 671-717. In the digest, replace `attention?.callbacks.map(...)` with `attention === undefined ? undefined : []`, so revision strings are byte-identical. Prove that with a before/after digest fixture.
11. **Agent instructions and CLI.** In `thread-runtime-config.ts`, delete 314 and 334-337. Point `omnyo callback waiting` at the inbox waits route filtered to `callback:` keys, or document `omnyo wait list`; this choice belongs to the owner in G1. Update `thread-operation.md`, `command-index.md` and `omnyo-guide-threads.md` to match.
12. **Leave the client.** Leave the unreachable client UI and kinds for RF-136. Do not delete schema members here.

13. **Final review.** Inspect the full diff. `thread_callbacks` is read only by `convertLegacyCallbacks`. Recount the removed and added lines against the Phase 1 baseline.

**Verification and acceptance criteria**

The package scripts exist at the snapshot. Each `test` script is `vitest run --config vitest.config.ts`, so the file arguments below pass through. None of them could be executed in this audit.

- `pnpm --filter @omnyo/db test -- test/data/thread-attention.test.ts` (from the repository root). The precedence table passes through both readers with identical states, and adoption still records rows.
- `pnpm --filter @omnyo/server test -- test/public/public-thread-callback-alias.test.ts test/public/public-thread-attention.test.ts test/inbox/inbox-failure-ack.test.ts test/public/public-thread-work.test.ts`. Marker routing (`[omnyo wait …]`, legacy `[bb wait …]`, `[callback-wait:<id>]`), legacy conversion, cycle and idle-source refusal, and failure-ack refusal for open waits all pass unchanged.
- **New server test for step 3:** `POST /api/v1/thread-attention/adopt` with a fixture `needs-you/data.db` leaves `thread_callbacks` empty and creates one live `callback:` wait per row before the response returns.
- **Path 2A additionally:**
  - A callback wait appears in `GET` attention snapshot `callbacks` with `id === wait.id` and `matchText === marker`.
  - Ending the source turn emits one `interactions-changed` for the waiter; repeated identical changes emit none.
  - `omnyo callback clear --id <listed id>` returns `cleared: true`.
  - Thread work lists the wait once.
  - Run `pnpm --filter @omnyo/app test -- src/components/thread/user-questions/NativeThreadAttention.test.tsx src/hooks/queries/thread-attention.test.tsx src/views/thread-detail/ThreadDetailPromptArea.test.tsx` and `pnpm --filter omnyo-plugin-ask-user-question test`.
  - Alex checks the banner, the "Waiting on this chat" list and the sidebar lanes by hand. These are restored UI, so there is no baseline to compare against.
  - Check `plugins/push-notifications` eligibility with `pnpm --filter omnyo-plugin-push-notifications test` (the `test` script exists at the snapshot).
- **Path 2B additionally:** a digest fixture shows `evidence.revision` unchanged for a thread with and without attention facts, and `omnyo callback waiting --json` keeps its JSON array shape.
- **Static checks:** `pnpm --filter @omnyo/db typecheck`, `pnpm --filter @omnyo/server typecheck`, `pnpm --filter @omnyo/cli typecheck`, then `pnpm exec oxfmt <changed files>` and `pnpm exec oxlint --deny-warnings --format=agent <changed files>` (root scripts `format:check` and `lint`).
- **Performance (2A):** compare `pnpm --filter @omnyo/server exec vitest run test/performance/history-stalls.bench.test.ts` before and after on the same machine. Attribute any thread-list regression to the projection query before accepting it.
- **Structural completion:**
  - `git grep -n "reconcileThreadCallbacks\|getCallbackSourceState\|toThreadCallback\|prepareGetRequiredOpenThreadQuestion" HEAD -- apps packages plugins` returns nothing.
  - `git grep -n "threadCallbacks" HEAD -- apps packages plugins` shows only the schema, the adoption writer, `convertLegacyCallbacks`, the db index export, tests, and (Phase 1 only) the two db readers.

**Rollback and stop conditions**

- **Rollback.** Each phase is a plain revert with no data migration. The table and migration stay. Waits created by synchronous conversion are ordinary inbox waits, and the sweep would have created the same waits.
- **Stop conditions:**
  - A production writer of `thread_callbacks` other than adoption.
  - An external plugin or client that depends on prompt-based callback fulfilment.
  - `convertLegacyCallbacks` throwing during adoption on a real legacy database, for example a `thread_waits_key_generation_idx` collision on generation 1. In that case use `nextKeyGeneration`, or keep sweep-only conversion.
  - In 2A, a measured thread-list regression from the projection query, or notification churn from the forwarder (more than one `interactions-changed` per waiter per source state change).
  - In 2B, a digest mismatch for threads without callbacks.
- **Next steps.**
  - If G1 cannot be decided, ship Phase 1 alone. It leaves current behaviour intact and fixes the classifier split for the rows that remain.
  - If 2A's notification wiring proves invasive, a smaller alternative is to let the app refetch the attention snapshot on `work-changed` for threads whose snapshot contains callbacks. Label that alternative a design change and measure its refetch volume first.
