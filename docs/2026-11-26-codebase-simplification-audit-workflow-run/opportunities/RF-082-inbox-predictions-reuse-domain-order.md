# RF-082 — Reuse the domain's inbox list ordering and counts in the app's optimistic inbox predictions

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** confirmed. The duplication is real and exact; the scope and line estimate in the sweep report hold.
- **Potential:** low to medium. It removes one duplicated rule set (four list orderings plus seven count fields), not a subsystem. The gain is about 30-35 net production lines and one fewer place to update when the inbox order or counts change.
- **Confidence:** high. Every rule was compared line by line (see Context).
- **Readiness:** ready. There is no persisted-format, API, SDK or plugin-surface change, and no owner decision is needed.
- **Effort:** small, about 1-2 hours including the focused tests.
- **Risk:** low. The client and server rules are semantically identical today, so swapping in the domain functions should change no observable order or count. The realistic regression is a subtle mistake while extracting the counts block (for example, dropping the `guaranteed` filter on `nextBackAt`).
- **Prerequisites:** none.
- **Related and overlapping items:** RF-081 (one hold-and-reapply primitive for optimistic overlays) and RF-052 (composer optimistic thread-status protocol) touch the same optimistic-update layer, but neither edits the ordering or counts in `apps/app/src/lib/inbox-predictions.ts`. RF-080 (identity-map thread-list projection helpers) is a different list. RF-014 (callback state served from inbox waits) changes inbox wait data, not ordering or counts. There are no conflicts; land in any order.
- **Why it deserves its place:** the app's optimistic inbox exists so that a row lands where the next server snapshot will put it. Today that promise depends on two hand-kept copies of the same rules. When they drift, a predicted row moves and then snaps back on the next server snapshot, and the counts badge flickers. After the change, one domain-owned definition makes that drift impossible for the shared rules. It is a small, safe consolidation rather than a large reduction.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The prepared snapshot worktree had already been removed when this card was written, so every file below was read with `git -C $OMNYO_CHECKOUT show e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e:<path>`.

How the subsystem works. The server builds the inbox (`InboxSnapshot`, with lists `inbox`, `waiting`, `running` and `shelf`, plus a `counts` block) with `packages/domain/src/inbox.ts:1747` `buildInboxSnapshot`, called from `apps/server/src/services/inbox/collect.ts:647`. The web app predicts the next snapshot optimistically after archive, shelve, wait, start-turn, queue-send, answer and similar actions with the helpers in `apps/app/src/lib/inbox-predictions.ts`. Its callers are `apps/app/src/hooks/cache-owners/thread-runtime-cache-owner.ts:83`, `thread-state-cache-owner.ts:72`, `thread-continuation-cache-owner.ts:8`, `thread-answer-cache-owner.ts:13`, `outbox-thread-state-cache-owner.ts:14`, `inbox-snapshot-cache-owner.ts:4` (the `InboxPredict` type), `apps/app/src/lib/pending-chat-creations.ts:34`, `apps/app/src/lib/plugin-bound-sdk.ts:32` and `apps/app/src/components/thread/user-questions/NativeThreadAttention.tsx:23`.

Duplicated rules (Proven by inspection, line-by-line comparison):

| Rule | App copy (`apps/app/src/lib/inbox-predictions.ts`) | Domain copy (`packages/domain/src/inbox.ts`) | Same semantics? |
|---|---|---|---|
| Inbox order: question cards first, then `sortAt`, then `threadId` | `LIST_ORDER.inbox` at 45-48, using `bySortAt` (42) and `byThread` (39-40) | private `compareCards` at 1539-1548 | Yes |
| Waiting order: `on-you` group first, then `waiting.returnAt` (null sorts last via `Number.MAX_SAFE_INTEGER`), then `threadId` | `LIST_ORDER.waiting` at 49-54 | private `compareWaiting` at 1550-1562 | Yes |
| Running and shelf order: `sortAt` ascending | `LIST_ORDER.running` and `.shelf` at 55-56 | inline `(a, b) => a.sortAt - b.sortAt` at 1763 and 1767 | Yes |
| Earliest non-null number | `earliest` at 59-66 | private `earliest` at 747-754 | Yes (byte-equivalent apart from a variable name) |
| Counts: `needsYou`, `inbox`, `questions`, `running`, `waiting`, `onYou` (on-you `waiting.reason ?? title`), `nextBackAt` (earliest `returnAt` among `guaranteed` waits) | `recountInbox` at 68-92 | counts block inside `buildInboxSnapshot` at 1769-1773 and 1782-1792 | Yes; the app uses `flatMap`, the domain uses `filter` plus `map`, with identical results |

Counterevidence and intentional differences. The server groups runs and incidents (`groupRuns`, `groupIncidents`, called at `packages/domain/src/inbox.ts:1753-1754`) before sorting; the app predictor never regroups and instead skips grouped members (`groupedMember` at `inbox-predictions.ts:177`). That difference is intentional and is untouched by this change. The app inserts one entry into an already-sorted list (`inserted` at 160-171, which places the entry before the first item that compares greater), while the server sorts the whole list with the stable `Array.prototype.sort`. Both use the same comparator, and both place an equal-key entry after the existing equals, so swapping the comparator source changes nothing.

Second use of `earliest` in the app. `scheduleInboxSend` at `inbox-predictions.ts:475` calls `earliest([source.waiting.returnAt, sendAt])`, where `sendAt` is a non-null `number`. That call is equivalent to `Math.min(source.waiting.returnAt ?? sendAt, sendAt)`.

Searches (scope: every tracked file at the snapshot, using `git grep` against the commit):

- `git grep -n -w recountInbox <commit> -- apps` outside the defining file found no hits. `recountInbox` is exported but only used inside its own module (18 occurrences there); the test file does not import it.
- `git grep -n "nextBackAt"` and `git grep -n "needsYou:"` outside tests found no third computation of the counts. The CLI (`apps/cli/src/commands/inbox.ts:601`) only reads `counts.nextBackAt`. Fixtures (`apps/demo-server/fixtures.mjs:671-677`, `tests/qa/failed-state/proof.mjs:115-120`, and `ThreadInboxReason.stories.tsx:93`) hard-code literal counts and are unaffected.
- `git grep -n -E 'group (===|!==) "on-you"'` found no third copy of the waiting order.
- `git grep -n "countInboxSnapshot\|compareInbox"` found no hits, so the proposed export names are free.

Packaging facts. `@omnyo/domain` is `"private": true`, with `sideEffects: false` and root export `./src/index.ts`. `packages/domain/src/index.ts:177` re-exports `./inbox.js`. The app already imports runtime values (not only types) from the `@omnyo/domain` root (for example `isMacKeyboardPlatform` in `apps/app/src/components/commands/ThreadSearchPaletteMode.tsx:13`), so no new dependency edge or bundle seam is added. The package is not part of the published SDK or the plugin SDK, so no external plugin or older client can depend on the new exports.

Existing tests. `apps/app/src/lib/inbox-predictions.test.ts` (470 lines) checks prediction counts (for example `counts.nextBackAt` at 298 and `counts` at 398) and placement. `packages/domain/test/inbox.test.ts` checks `buildInboxSnapshot` order and counts (`counts` with `questions` and `nextBackAt: 9000` at 1014-1018, and `needsYou` at 1585 and 1650). `apps/server/test/inbox/shared-snapshot.test.ts` calls `buildInboxSnapshot`. None of the tests compares a prediction against a server-built snapshot. The snapshot has no `node_modules`, so none of these tests was run for this card.

Maintenance cost today. A change to the card order (for example, putting problems after questions), to the waiting tiebreak, or to a count (for example, adding a failures count) needs two matching edits, one in `packages/domain/src/inbox.ts` and one in `apps/app/src/lib/inbox-predictions.ts`. No test fails if only the domain is edited: predictions then disagree with the server, and rows visibly jump when the next snapshot arrives.

**Proposed end state and preservation argument**

What remains and who owns it. `packages/domain/src/inbox.ts` owns the list order and the counts:

- `export function compareInboxCards(a: InboxEntry, b: InboxEntry): number`, which is the renamed `compareCards` with an unchanged body.
- `export function compareInboxWaiting(a: InboxEntry, b: InboxEntry): number`, which is the renamed `compareWaiting` with an unchanged body.
- `export function compareInboxSortAt(a: InboxEntry, b: InboxEntry): number { return a.sortAt - b.sortAt; }`, used by `buildInboxSnapshot` for `running` and `shelf`.
- `export function countInboxSnapshot(lists: Pick<InboxSnapshot, "inbox" | "waiting" | "running">): InboxSnapshot["counts"]`, which holds the moved counts block and the `nextBackAt` computation. `buildInboxSnapshot` sets `counts: countInboxSnapshot({ inbox, waiting, running })`.
- The private `earliest` stays private in the domain; it is still used by `countInboxSnapshot` and elsewhere in `inbox.ts`.

What disappears from `apps/app/src/lib/inbox-predictions.ts`: `byThread`, `bySortAt`, the bodies of `LIST_ORDER`, the module-local `earliest`, and the counts body of `recountInbox`. What stays: `LIST_ORDER` as a 6-line map `{ inbox: compareInboxCards, waiting: compareInboxWaiting, running: compareInboxSortAt, shelf: compareInboxSortAt }`, and `recountInbox` as `({ ...snapshot, counts: countInboxSnapshot(snapshot) })`. All prediction-only helpers stay in the app: `mapLists`, `withoutThreads`, `withoutMembers`, `inserted`, `placed`, `archivedEntry`, `shelvedEntry`, `runningEntry`, `waitingEntry`, `canStartTurn`, `predictInboxAct`, `captureInboxRows`, `restoreInboxRows` and `answerInboxQuestions`.

Data flow. Nothing changes at runtime: the server still calls `buildInboxSnapshot`, the app still predicts locally, and both now call the same comparator and count functions.

Why this is the simplest sufficient option. Moving the whole predictor into the domain was rejected because the prediction rules (what an archive or a start-turn does to a row) are client-only optimistic policy with no server twin. Exporting only the shared rules removes the duplication without moving client policy into the domain.

Preserved contracts. The `InboxSnapshot` and `counts` zod schema (`packages/domain/src/inbox.ts:465-471`), the CLI JSON shape (`apps/cli/src/json-shapes.ts:20`), list order, count values and every exported prediction helper signature stay the same. There are no UI changes; the visible states that depend on this code are the inbox, waiting, running and shelf rows and the counts badges, and their order and values are unchanged by construction.

Non-goals. Do not make the predictor regroup runs or incidents. Do not change `inserted`'s placement behavior. Do not export `earliest` from the domain as a general utility. Do not merge prediction helpers into the domain.

**Expected gain and cost**

Counting method (Proven by inspection): line ranges read from `git show e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e:apps/app/src/lib/inbox-predictions.ts | cat -n`. The production range in scope is lines 37-92 (56 lines, including blank lines).

| File | Before | After (projection) | Change |
|---|---|---|---|
| `apps/app/src/lib/inbox-predictions.ts` | 37-92: `Order` type, `byThread`, `bySortAt`, 14-line `LIST_ORDER`, 8-line `earliest`, 25-line `recountInbox` | 6-line `LIST_ORDER`, 3-line `recountInbox`, 1-3 import lines, and an inlined `Math.min` at the former line 475 | about -38 to -42 |
| `packages/domain/src/inbox.ts` | private `compareCards` and `compareWaiting`, inline sort lambdas, counts block inside `buildInboxSnapshot` | renamed exports, new 3-line `compareInboxSortAt`, `countInboxSnapshot` wrapper (the counts block moves, so a move is not a deletion) | about +5 to +7 |
| **Net handwritten production** | | | **about -30 to -35** |
| Tests | | | 0 required; optional +10-20 for one parity test (below) |

Mechanisms: two copies of the inbox order and count rules become one, owned by the domain. Afterwards, a future order or count change needs one edit, and the existing predictions tests exercise it automatically. Performance: Hypothesis, neutral. The same comparisons and filters run, with one extra function call per comparison; no measurement was taken, and none is warranted for lists of this size. Cost: four new exported names in a private package.

**Execution steps**

1. **Reconfirm the anchors.** On the current `main`, open `apps/app/src/lib/inbox-predictions.ts` and `packages/domain/src/inbox.ts`. Confirm that `LIST_ORDER`, `earliest` and `recountInbox` still mirror `compareCards`, `compareWaiting`, `earliest` and the counts block in `buildInboxSnapshot`, using the table in Context. Stop and re-plan if any rule now differs between the two files (see Rollback and stop conditions), or if someone has already added a server-versus-prediction difference on purpose.
2. **Domain checkpoint (`packages/domain/src/inbox.ts`).**
   - Rename `compareCards` to `compareInboxCards` and `compareWaiting` to `compareInboxWaiting`, and add `export` to both. Keep the bodies byte-identical.
   - Add `export function compareInboxSortAt(a: InboxEntry, b: InboxEntry): number { return a.sortAt - b.sortAt; }` next to them, and use it in `buildInboxSnapshot` for `running` and `shelf`.
   - Extract `export function countInboxSnapshot(lists: Pick<InboxSnapshot, "inbox" | "waiting" | "running">): InboxSnapshot["counts"]`. Move the `nextBackAt` const and the `counts` object literal into it without changing them, then set `counts: countInboxSnapshot({ inbox, waiting, running })` in `buildInboxSnapshot`.
   - Confirm that `packages/domain/src/index.ts` already re-exports `./inbox.js` (line 177 at the snapshot), so no barrel edit is needed.
   - Run the domain tests and typecheck (see Verification) before touching the app.
3. **App checkpoint (`apps/app/src/lib/inbox-predictions.ts`).**
   - Add `compareInboxCards`, `compareInboxSortAt`, `compareInboxWaiting` and `countInboxSnapshot` to the `@omnyo/domain` import. Make it a value import next to the existing `import type`, or merge both into `import { ..., type InboxActRequest, ... }`.
   - Delete `byThread` and `bySortAt`. Replace the `LIST_ORDER` bodies with `{ inbox: compareInboxCards, waiting: compareInboxWaiting, running: compareInboxSortAt, shelf: compareInboxSortAt }`, and keep the `Order` type and the `Readonly<Record<InboxList, Order>>` annotation.
   - Replace the `recountInbox` body with `return { ...snapshot, counts: countInboxSnapshot(snapshot) };`. Drop its `export`, because no other module imports it (re-run `rg -n -w recountInbox apps packages` first; if a new importer has appeared, keep the export).
   - Replace `earliest([source.waiting.returnAt, sendAt])` in `scheduleInboxSend` with `Math.min(source.waiting.returnAt ?? sendAt, sendAt)`, then delete the local `earliest`.
4. **Optional parity guard.** Add one test in `apps/app/src/lib/inbox-predictions.test.ts`: build a snapshot with `buildInboxSnapshot` from the entries of a fixture that includes a question card, an on-you wait, a timed wait and an untimed wait, then assert that `withInboxEntry` on one of those entries (removed and re-added) reproduces the same lists and counts. This guards the "predicted order equals server order" promise that this card relies on. Do not rewrite existing assertions.
5. **Cleanup and recount.** Search for leftovers (`rg -n "byThread|bySortAt|function earliest" apps/app/src/lib/inbox-predictions.ts` should return nothing). Read the full diff for unrelated changes, and recount the changed production lines with `git diff --stat -- apps/app/src/lib/inbox-predictions.ts packages/domain/src/inbox.ts`.

**Verification and acceptance criteria**

The following commands come from the snapshot's `package.json` scripts. They were not run for this card because the snapshot has no `node_modules`.

- `cd packages/domain && pnpm test`, which runs `vitest run --config vitest.config.ts`. Expected: `test/inbox.test.ts` passes unchanged, including the order and counts assertions at about lines 204, 1014-1018, 1585 and 1650.
- `cd packages/domain && pnpm typecheck`, which runs `tsc --noEmit`.
- `cd apps/app && pnpm exec vitest run --config vitest.config.ts src/lib/inbox-predictions.test.ts`. The app's `test` script is `vitest run --config vitest.config.ts`; passing a file filter is standard vitest usage but was not executed here. Expected: every existing case passes unchanged, including the `nextBackAt` (line 298) and `counts` (line 398) assertions.
- `cd apps/server && pnpm exec vitest run test/inbox/shared-snapshot.test.ts`. This is unverified: check `apps/server/package.json` for its vitest config flag before running it. It confirms that the server snapshot builder still works.
- `cd apps/app && pnpm typecheck`, which runs `tsc --noEmit && tsc --noEmit -p tsconfig.node.json`.
- Lint and format: from the repository root, `pnpm lint` (`turbo run lint`). For the two edited files, run `pnpm exec oxlint --fix <files>`, `pnpm exec oxfmt <files>` and `pnpm exec oxlint --deny-warnings --format=agent`, as the global instructions require.

Behavioral acceptance: the order of all four lists and every `counts` field are identical before and after for the existing fixtures. The tests above, plus the optional parity test, cover the realistic regressions: a dropped `guaranteed` filter, a swapped tiebreak, or a changed null-`returnAt` placement. There is no UI change, so no visual comparison is needed. Spot-check by hand that archiving or shelving a chat in the sidebar inbox still lands the row without a jump on the next refresh.

Structural acceptance: `apps/app/src/lib/inbox-predictions.ts` contains no comparator or count logic of its own; `packages/domain/src/inbox.ts` is the only definition of the inbox order and counts; and no second `earliest` remains in the app.

**Rollback and stop conditions**

Rollback boundary: the change touches two source files (and optionally one test) and has no data, persistence, API or compatibility implications. Reverting the commit restores the previous state.

Stop conditions:

- A rule has drifted between the copies by the time of execution. Find out which copy is the intended behavior (usually the server's) before unifying, and treat any behavior change as a separate, named fix.
- Someone needs the client to order rows differently from the server on purpose (for example, to keep a just-acted row pinned). Keep that difference as an explicit app-side comparator that wraps the domain one, not as a silent copy.
- An app test fails after the swap. That means the copies were not equivalent for some input; investigate it, and do not edit the expected values to match.
