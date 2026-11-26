# RF-127 — Stop Push Notifications from re-deriving "open work" and paging sibling lists before a finished-turn notice

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** conditional. Two parts. Part A, a direct `threadIds` lookup for the finishing chat, is ready and keeps behavior unchanged. Part B, making core's `thread.work` the only definition of open work, needs an owner decision, because core's projection differs from the push rule in at least six ways that change when a notification is sent.
- **Potential:** low. Part A removes one needless paging mechanism, about 16 production lines. Part B could remove a second definition of open work, about another 25 to 35 lines. However, it needs a new predicate over `thread.work`, and probably a new core field for it.
- **Confidence:** high in the analysis, which is proven by inspection. Medium in the size of Part B's gain, which depends on the decision.
- **Readiness:** Part A is ready. Part B is decision-needed.
- **Effort:** Part A takes about 1 hour, including the test fake. Part B takes 3 to 6 hours after the decision, plus any core field.
- **Risk:** Part A is low risk. Part B is medium risk, because it changes notification timing, which users notice. For example, a chat with an active goal could ping too early, or a chat that leaves something "On you" could stop pinging.
- **Prerequisites:** none for Part A. Part B needs the decision in its investigation gate.
- **Related and overlapping items:** RF-014 (callback state served from inbox waits) changes the callback signals that both predicates read, so land RF-014 before Part B or re-check against it. RF-136 and RF-137 touch thread indicators, not this predicate. Composer Predictions (`plugins/composer-predictions/readiness.ts`) already uses the lookup pattern that Part A adopts. No other RF item edits `plugins/push-notifications/sender.ts`.
- **Why it ranks here:** the duplicated knowledge is real. A new kind of background activity added to core must also be added to push's `hasOpenWork`, or push notifies too early. But the sweep's proposed replacement would cause regressions, and the safe part is small. This is a low-rank item: execute Part A as cheap cleanup, and Part B only if Alex wants finished-turn notices to follow the Inbox's ownership semantics.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The audit read the files with `git show <commit>:<path>`, because the audit worktree was no longer on disk. No tests were run, because the snapshot has no `node_modules`.

*What the code does (observed).* The Push Notifications plugin sends a "turn finished" notice when a chat goes idle (`plugins/push-notifications/server.ts:956`, which wires `thread.idle` to `sender.onThreadIdle`). Before sending, `resolvePush` calls `isWorkFinished(thread)` (`plugins/push-notifications/sender.ts:732`).

- `sender.ts:624-651` "isWorkFinished", first loop: this loop finds the finishing chat's own list entry. It pages `api.sdk.threads.list` 100 rows at a time (`THREAD_ACTIVITY_PAGE_SIZE`, `sender.ts:66`), filtered by `projectId`, `environmentId` and `parentThreadId`/`hasParent`, until a row with the right id appears. If the chat is not found, it logs `Completion activity unavailable for thread <id>` and returns false.
- `sender.ts:653-673`, second loop: a breadth-first walk over `parentThreadId` children, again paged by 100. Archived or deleted children are skipped together with their subtrees.
- `sender.ts:395-408` "hasOpenWork": this predicate checks every entry the two loops read. It returns true when any of these holds: `status !== "idle"`, `runtime.displayStatus !== "idle"`, `hasPendingInteraction`, `queuedWork !== "none"`, `attention?.kind === "callback-waiting"`, or any of `activeWorkflowCount`, `activeBackgroundAgentCount`, `activeBackgroundCommandCount`, `activeGoalCount` or `activePlanModeCount` above zero.
- Both functions are module-private. A search over the snapshot with `git grep -n "isWorkFinished\|hasOpenWork\|THREAD_ACTIVITY_PAGE_SIZE" <commit>` found push's only uses in `sender.ts`. The other `hasOpenWork` hits are an unrelated method in `packages/agent-runtime/src/runtime-background-work-state.ts:65`. There are no SDK exports, no manifest entries and no CLI consumers.

*What core already offers (observed).*

- `packages/sdk/src/areas/threads.ts:120-139` `ThreadListArgs.threadIds` supports a direct lookup. The server route passes the ids straight to `buildListThreadsFilters` (`apps/server/src/routes/threads/base.ts:347-349`, `packages/db/src/data/threads.ts:858-899`). No `archived` or `shelved` filter applies when those flags are omitted, which matches the current scan. `THREAD_LIST_MAX_IDS` is 200 (`packages/server-contract/src/api/threads.ts:1451`).
- `plugins/composer-predictions/readiness.ts:37-50` "listedThread" already uses `threads.list({ threadIds: [threadId], includeHidden: true })`. Its engine floor is `omnyoPluginSdk >=0.6.42`, and push's is `>=0.6.39 >=0.6.44` (`plugins/push-notifications/package.json`), so the SDK floor already covers `threadIds`.
- Every list response computes `work` for every row it returns. `apps/server/src/services/threads/thread-runtime-display.ts:628-648` "toThreadListEntryResponses" calls `buildThreadWorkSummaries`, which expands each row's dependent graph (`apps/server/src/services/threads/thread-work.ts:248-320` "collectThreadWorkGraph"). Proven by inspection: each 100-row sibling page therefore builds work summaries for up to 100 unrelated chats and their dependents. The cost per page has not been measured.
- Core's ownership roll-up lives in `thread-work.ts:487-990` "buildThreadWorkSummaries", and `packages/domain/src/thread-work.ts:374` "projectThreadWork" turns it into `primary`, `activity`, `waits`, `failures` and `archive.eligible`.

*Why the sweep's replacement does not hold (proven by inspection).* The sweep's rule was "idle, no pending interaction, no queued work, and empty `work.activity` and `work.waits`". Six differences make it not equivalent:

| # | State | Push today (`hasOpenWork` plus walk) | Core `thread.work` | Effect of the sweep's rule |
|---|---|---|---|---|
| 1 | Active goal or plan mode on the chat | Blocks the notice | Sets `coverageComplete = false` and an `unknownReason`. It adds no activity and no wait (`thread-work.ts:797-806`), and `coverageComplete` is not in the public summary | Notifies too early. The contract test `server.test.ts:783` "waits for idle work with %s to finish" would fail |
| 2 | Hidden child that is not running (status `pending`, `error`, needs input, goal active) | Blocks the notice | `dependentWork` returns null for hidden children unless their primary label is `working` (`thread-work.ts:368-372`). `pending` is not a running status (`packages/domain/src/thread-work.ts:211-215`) | Notifies while a hidden child is `pending`. The test `server.test.ts:935` "suppresses completion while a hidden child is %s" (`pending` case) would fail |
| 3 | Callback whose source is `idle` or `unverified` | Blocks, because `attention.kind === "callback-waiting"` for any callback without a required question (`packages/db/src/data/thread-attention.ts:195-208`) | Marks coverage unknown with no wait (`thread-work.ts:713-716`). A failed source is recorded as a failure, not a wait | Notifies while the callback is outstanding |
| 4 | `queuedWork === "failed"` | Blocks the notice | Records the `queue-failed` failure, not activity or a wait (`thread-work.ts:760-765`) | Only the separate `queuedWork` check would keep this case |
| 5 | Inbox waits (`omnyo wait` events, `report` waits shown as "On you"), scheduled messages, resolving interactions, plugin-contributed waits or activity, postponement | Ignored, except that scheduled messages count through `queuedWork` | Added to `waits` or `activity` (`thread-work.ts:719`, `730-758`, `812-844`). A `report` wait is the user's own item | Suppresses the finished notice for a chat that just left something on the user. That is a product change |
| 6 | Chats linked by `lifecycleOwnerThreadId` or `launchedByThreadId` | Ignored, because the walk follows `parentThreadId` only | Rolled in as dependents (`thread-work.ts:269-300`) | Suppresses the notice while a launched chat is still working |

Counterevidence for Part B being simply "better": `PLUGIN_OVERVIEW.md` defines push as "Notify when a chat finishes, needs input (even mid-turn) or errors". It does not state that a notice should follow Inbox ownership. Core's projection serves Ready to archive and the Inbox (`archive.eligible`, `primary`), which are not the purposes push was written for.

*Maintenance cost today.* There are two definitions of "this chat still has work". A new activity counter or wait kind added to core does not reach push, so push may notify too early. The sibling page scan also adds paging and not-found handling around what is really an id lookup.

*Test fixture fact relevant to Part A.* The test host's fake `threads.list` (`plugins/push-notifications/server.test.ts:302-341`) ignores `threadIds` and slices to 100 rows when `limit` is undefined. The test `server.test.ts:1005` "finds the finishing chat past the first activity page" seeds 101 older threads. Without a fixture change, the lookup in Part A would miss the finishing chat in that test.

**Proposed end state and preservation argument**

*Part A (ready).* `isWorkFinished` reads the finishing chat with one call, `api.sdk.threads.list({ threadIds: [thread.id], includeHidden: true })`, picks the row by id with `.find`, and keeps the same not-found warning and `hasOpenWork` check. The descendant walk and `hasOpenWork` stay unchanged.

- What disappears: the sibling paging loop, its `found` flag, and its `projectId`, `environmentId` and `hasParent` filters.
- What it preserves: the same predicate runs on the same list entry, so every state in the table above behaves as today. The warning text and the `false` return when the chat is missing are unchanged. Errors from `threads.list` still propagate, so the test at `server.test.ts:1027` still sees an error log.
- One deliberate difference: today, a chat whose environment or parent changed between `threads.get` and the scan is reported as not found. After Part A it is found. This is a correctness gain, not a regression.
- Use `.find` rather than destructuring, so that a server that ignored `threadIds` still cannot pick the wrong row. Push declares `"omnyo": ">=0.0"`. This guard is not a fallback: a missing row still fails visibly with the existing warning.
- Performance: projected, not measured. One list response with one work summary replaces one or more 100-row pages that each compute up to 100 work summaries.

*Part B (decision-needed).* `hasOpenWork` and the descendant walk are replaced by one predicate over the chat's own `thread.work`, with core owning the roll-up. The predicate must state, for each of rows 1 to 6 in the table, whether push keeps today's behavior or adopts core's. Because of rows 1 and 3, a faithful predicate cannot be written from the current public summary alone. Core would have to expose its unknown-coverage state (for example `coverageComplete` or a `reason.code`), or push would have to keep its own goal, plan-mode and callback checks. Keeping those checks would leave a partial second definition and shrink the gain.

*Non-goals.* No change to `predictionPending` (`sender.ts:410-423`), coalescing, notification levels, read-state suppression or the `pending-interaction` and `thread-error` kinds.

**Expected gain and cost**

Counting method: line ranges from `git show e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e:plugins/push-notifications/sender.ts | sed -n '<range>p' | wc -l`. These are handwritten production lines only.

| | Before | After (projected) | Net |
|---|---|---|---|
| Part A: `sender.ts:624-652`, the sibling scan with its header | 29 lines | about 13 lines | about −16 production lines; one paging mechanism removed |
| Part A: test fake in `server.test.ts:302-341` | ignores `threadIds` | 2 to 3 added lines honoring `threadIds` | about +3 test lines |
| Part B: `hasOpenWork` (`sender.ts:395-408`, 14 lines), the descendant walk (`sender.ts:653-673`, 21 lines), `ThreadListEntry` (`sender.ts:47-49`) and `THREAD_ACTIVITY_PAGE_SIZE` (`sender.ts:66`) | about 40 lines | about 8 to 15 lines for the predicate, plus any new core field | about −25 to −35 production lines; one definition of open work removed |

Sweep claim corrected: the sweep estimated 55 to 65 lines. That figure assumed the unsafe predicate. The safe total is about 16 lines now, and up to about 50 only if Part B is approved without extra core fields.

Causal maintenance link: after Part A, nobody has to reason about paging and not-found edge cases for an id lookup. After Part B, a new background-work kind is added only in core's projection, and push follows it automatically. Unknown: the real latency saving per finished turn, because no baseline exists.

**Execution steps**

Part A (ready):

1. Reconfirm the snapshot facts. Check that `sender.ts` "isWorkFinished" still matches lines 624-676, that `ThreadListArgs.threadIds` exists in `packages/sdk/src/areas/threads.ts`, and that push's `engines.omnyoPluginSdk` floor is at least composer-predictions' `0.6.42`. Stop and re-plan if `isWorkFinished` has already been rewritten, or if `threads.list` with `threadIds` now applies an archived or shelved default that the current scan does not.
2. In `plugins/push-notifications/sender.ts` "isWorkFinished", replace the first loop (lines 625-651) with:
   ```ts
   const current = (
     await api.sdk.threads.list({ threadIds: [thread.id], includeHidden: true })
   ).find((candidate) => candidate.id === thread.id);

   if (current === undefined) {
     api.log.warn(`Completion activity unavailable for thread ${thread.id}`);

     return false;
   }

   if (hasOpenWork(current)) return false;
   ```
   Leave the descendant walk from `const parents = new Set([thread.id]);` onward unchanged. `THREAD_ACTIVITY_PAGE_SIZE` stays, because the walk still uses it.
3. In `plugins/push-notifications/server.test.ts`, in the fake `list` at lines 302-341, add the filter `(args.threadIds === undefined || args.threadIds.includes(thread.id))` next to the existing `parentThreadId` filter. Keep `server.test.ts:1005` "finds the finishing chat past the first activity page" as a regression test for chats in large projects. Rename it to "finds the finishing chat among many sibling chats" only if the old name now misleads. Do not weaken its assertions.
4. Checkpoint: run the push plugin's tests, typecheck and lint (commands below). All gating tests at `server.test.ts:783-1080` must pass unchanged.

Part B investigation gate (do not implement Part B until this gate is done):

5. Ask the owner for one decision per row 1 to 6 of the table: should a finished-turn notice wait in that state? The recommended default is to keep today's behavior for rows 1 to 4 and to choose explicitly for rows 5 and 6. Record the answers in `plugins/push-notifications/PLUGIN_OVERVIEW.md` under Delivery as one sentence that defines "finished".
6. Check whether the decided rule can be expressed from the public `ThreadWorkSummary` (`packages/domain/src/thread-work.ts:119-159`). Today it cannot express rows 1 and 3, because `coverageComplete` and `unknownReason` are internal. If a field is needed, it is a core contract change in `packages/domain`, `apps/server` and the public SDK. That makes it a separate, larger item: write a short design first, including the SDK minimum version that push would then require under `docs/forkable-plugins.md`.
7. Stop Part B if the decision keeps rows 1 to 4 as they are and no core field is approved. The remaining gain (deleting only the walk) would not justify a mixed predicate.

Part B implementation (only after the gate):

8. In `sender.ts`, replace `hasOpenWork` and the whole `isWorkFinished` body with one lookup, as in step 2, followed by a predicate named `workFinished(entry: ThreadListEntry): boolean`. The predicate checks the entry's own `status`, `runtime.displayStatus`, `hasPendingInteraction` and `queuedWork`, then the approved conditions on `entry.work` (null `work` counts as not finished, and the existing warning is logged). Delete the descendant walk and `THREAD_ACTIVITY_PAGE_SIZE`.
9. Update `server.test.ts`. The fake `list` must return a `work` object for each row. Today it spreads the stored thread, whose `work` comes from `makeThreadResponse` defaults or from `setThread` overrides (`server.test.ts:382-395`). Child-based tests (`server.test.ts:935`, `961`, `985`) must seed the parent's `work` with the dependent activity that core would compute. Add one server-side characterization test in `apps/server/test/public/public-thread-work.test.ts` for each approved row, so that core's roll-up, not the plugin fake, proves the semantics. Keep every existing assertion whose behavior the decision keeps.
10. Remove leftovers: the unused `ThreadListEntry` alias if nothing uses it, comments about paging, and the test `server.test.ts:961` "checks child turns past the first page" if paging no longer exists. Replace that test with an equivalent "many children" case only if core's roll-up lacks such coverage.
11. Inspect the full diff and recount lines with the method above.

**Verification and acceptance criteria**

Commands come from `plugins/push-notifications/package.json` scripts (`test`, `typecheck`, `lint`) and the root `package.json` (`check:plugin-forks`). None were run in this audit, because the snapshot has no `node_modules`.

- From the repository root: `pnpm --filter omnyo-plugin-push-notifications test`. Expected: all tests pass, including `server.test.ts:783` (goal and plan mode), `:825` (workflow, agent and command counters), `:867` (held follow-up), `:886` (callback), `:935` (hidden child, four statuses), `:961` and `:985` (children), `:1005` (many siblings), `:1027` (list failure leads to an error log and no notice) and `:1051` (pending input still delivered).
- From the repository root: `pnpm --filter omnyo-plugin-push-notifications typecheck` and `pnpm --filter omnyo-plugin-push-notifications lint`. Expected: clean.
- From the repository root: `pnpm run check:plugin-forks`. Expected: clean. This matters only for Part B, if a new SDK field raises the floor.
- Part B only, from the repository root: `pnpm --filter @omnyo/server test -- public-thread-work`. The filter argument is unconfirmed: it assumes vitest's positional file filter passes through the `test` script in `apps/server/package.json`. Expected: the new characterization cases pass.
- Behavior acceptance for Part A: the gating outcome is identical for every existing fixture, and no test assertion changes.
- Structural acceptance for Part A: `sender.ts` makes no `threads.list` call with `projectId`, `environmentId` or `hasParent`, and the `found` loop is gone.
- Structural acceptance for Part B: `git grep -n "hasOpenWork\|THREAD_ACTIVITY_PAGE_SIZE" -- plugins/push-notifications` returns nothing, and the approved semantics are written in `PLUGIN_OVERVIEW.md`.
- Performance: no credible baseline exists. If a claim of latency improvement is wanted, time `resolvePush` for a project with more than 100 root chats before and after Part A on the same server build and data. Otherwise, claim only "fewer list rows read", which is proven by inspection.
- UI: none. Push notification copy, cards and timing settings are untouched.

**Rollback and stop conditions**

- Each part is one commit confined to `plugins/push-notifications/sender.ts` and `server.test.ts`. Part B also touches `PLUGIN_OVERVIEW.md` and any approved core files. Reverting the commit restores the old behavior. Neither part involves persisted data or a stored format.
- Stop Part A if the lookup changes any gating test outcome, or if the server applies a filter to `threadIds` lookups that the scan did not.
- Stop Part B under any of these conditions:
  - Alex declines the semantic changes, or the approved rule needs a core field that is not approved.
  - RF-014 is in flight and changes callback signals; re-run the gate after it lands.
  - A characterization test shows that core's roll-up disagrees with an approved row.
- Safer alternative if Part B stops: keep Part A only. Optionally add a comment above `hasOpenWork` listing the core fields it mirrors, so that someone who adds a counter in `thread-work.ts` knows to update push as well.
