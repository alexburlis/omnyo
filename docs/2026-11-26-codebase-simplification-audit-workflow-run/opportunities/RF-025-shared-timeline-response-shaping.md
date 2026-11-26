# RF-025 — One response-shaping module for the timeline worker, the in-memory branches and the single-event route

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplication and the outline drift are real. The sweep's estimate of 50 to 80 net lines is too high: the projection is about 30 to 45 handwritten production lines. The scope also grows to include a third copy of the events recipe in the events route.
- **Potential:** low in lines, but it closes a drift that has already happened in credential redaction on the path the server test harness uses.
- **Confidence:** high. Every anchor below was re-read at the snapshot.
- **Readiness:** ready.
- **Effort:** small, about 2 to 4 hours including the targeted server tests.
- **Risk:** low. Production output stays byte-identical because the worker keeps its current order and options. The in-memory outline branch changes on purpose, as described under "Proposed end state".
- **Prerequisites:** none. Land the outline fix (sweep issue ISS-S06-004) in the same change or just before it.
- **Related or overlapping items:** RF-023 deletes the old primary-database timeline and outline cache repositories, and it edits `apps/server/test/services/threads/timeline-page-builder.test.ts`. That work does not touch these branches. Either change can land first, but rebase the test file. RF-051 changes how rewrites are detected and does not touch shaping. No other item edits `timeline-page-builder.ts` or `timeline-worker.ts`.
- **Why it deserves its place:** two copies of a credential-redaction recipe already disagree. Because the harness runs on in-memory SQLite, server route tests check a different redaction mode than production uses for the conversation outline. One owner removes that whole class of drift and makes the route tests exercise the production shaping code.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The snapshot worktree no longer existed during verification, so every file was read with `git show e9e1b74c…:<path>`. `git diff --stat e9e1b74c HEAD -- apps/server/src/services/threads/` shows only `thread-work.ts` changed since then, so the anchors below still match the main checkout.

*How the subsystem works (Proven by inspection).* The routes in `apps/server/src/routes/threads/data.ts` and `apps/server/src/routes/threads/base.ts` call five entry points in `apps/server/src/services/threads/timeline-page-builder.ts`:

- `buildThreadTimelinePage` at line 636
- `buildThreadConversationOutlinePage` at line 704
- `loadTimelineTurnSummaryDetails` at line 764
- `loadThreadEventListBody` at line 807
- `findThreadSearchMatchesInWorker` at line 852

For a file database, each entry point queues a job on a per-database `PageBuilder`, created by `createPageBuilder` at line 195. That builder runs `apps/server/src/services/threads/timeline-worker.ts` in a worker thread. The worker opens the database by path (`createConnection(data.databasePath, …)` at line 65), so it cannot open `:memory:`. Each entry point therefore has a `db.$client.memory` branch that rebuilds the same response in-process.

*Production never takes the memory branches (Proven by inspection).*

- `apps/server/src/start-server.ts:194` opens `initDb(serverConfig.databasePath, …)`.
- `packages/config/src/database.ts:16-25` derives that path through `resolveDataDirDatabasePath`, which joins the data directory and the file name.
- The in-memory callers are `apps/server/test/helpers/test-app.ts:181` and `:184`. Function `createTestDb` deserializes a migrated `:memory:` template, and every `createTestAppHarness` without `databaseSource` uses it.
- `apps/server/src/omnyo-identity-adoption.ts:45` also opens `:memory:`, but only as a scratch database. It never reaches the timeline entry points.

These were found with `git grep -n -E "initDb|createConnection" e9e1b74c -- apps packages ':!*.test.ts' ':!**/test/**'`. That search covers production source only. It does not prove that no out-of-repository caller exists, but the entry points are internal server functions and are not exported through any SDK.

*Duplicated recipes at the snapshot (Proven by inspection; non-blank line counts from `awk 'NR>=a&&NR<=b&&NF>0' | wc -l`):*

| Response | In-memory copy (`timeline-page-builder.ts`) | Worker copy (`timeline-worker.ts`) | Other copy | Agree? |
|---|---|---|---|---|
| Timeline page: truncate, then preview unless `includeNestedRows`, then redact with `withhold` | 660-675 (15 lines) inside the 643-687 branch (39 lines) | 549-564 (15 lines) | none | Yes |
| Conversation outline: redact, then role filter | 721-729 inside the 711-747 branch (32 lines) | 412-416 and 448-454 (10 lines) | none | **No** |
| Turn-summary details: build, redact with `withhold`, stringify | 780-789 inside the 775-790 branch (14 lines) | 292-299 (8 lines) | none | Yes |
| Events list: list rows, `redactThreadHistoryEvent` per row, redact with `withhold` | 818-831 (14 lines) | 272-282 (11 lines) | `apps/server/src/routes/threads/data.ts:843-853` (the `limit === 1` fast path, 11 lines) | Yes |
| Search | 859-863 (5 lines) | 243-255 | none | Both call `findThreadSearchMatches`, so there is nothing to share |

*Builder bootstrap (Proven by inspection).* The block `let builder = builders.get(db); if (builder === undefined) { builder = createPageBuilder(db); builders.set(db, builder); }` plus `await ensureHistoryCache(db)` appears five times, at lines 689-696, 749-755, 792-798, 833-839 and 865-871 (6 non-blank lines each, 30 in total). The order is not uniform:

- `buildThreadTimelinePage` gets or creates the builder first and then awaits `ensureHistoryCache`.
- The other four entry points await first and then get or create the builder.

This matters only if `closeThreadTimelinePageBuilders` (line 884) runs during that await. In that case the timeline entry point holds the closed builder, whose `build` rejects with `unavailable()` at line 481. The other four can register a fresh builder after the close. See the newIssues entry; this is a Hypothesis and was not reproduced.

*The outline drift (Proven by inspection).*

- The in-memory branch at `timeline-page-builder.ts:723-729` filters `response.items` by `options.role` first. It then calls `redactThreadHistory(db, thread.id, {...})` with **no options**.
- The worker at `timeline-worker.ts:414-416` redacts the full outline with `{ invalidJsonText: "withhold" }`. It hashes the redacted items into the checkpoint digest at lines 418-420, and only then filters by role at lines 448-454.
- In `packages/domain/src/credential-redaction.ts:214-229` "redactText", a string that matches `JSON_TEXT_PATTERN` (for example `[1/3] Building`) but fails `JSON.parse` returns the withheld marker only in `withhold` mode. In any other mode it throws `CredentialRedactionError`.
- `apps/server/src/services/threads/thread-history-redaction.ts:129-131` maps that error to a 413 `history_redaction_limit`.
- The node budget (`MAX_NODES`, line 14) and the string budget (`MAX_STRING_CHARS`, line 12) count across the whole value. Filtering before redaction can therefore also avoid a 413 that production would return.

The result: a user or assistant outline item that looks like JSON but is invalid returns 200 with a withheld marker in production. On the harness it returns 413.

*Test coverage that encodes the contract (Proven by inspection of test files; the tests were not run because the snapshot has no node_modules).*

- `apps/server/test/public/public-thread-history-safety.test.ts:120-266` ("withholds malformed %s output on event pages and timeline reads") checks `withhold` on the timeline, turn-summary details and events. It checks that `/events/wait` returns 413. It does **not** cover `/conversation-outline`, which is why the drift went unnoticed.
- `apps/server/test/public/public-thread-data.test.ts:1011-1068` covers the outline with and without `?role=`.
- `apps/server/test/public/public-thread-timeline-output-preview.test.ts` covers truncation and preview.
- `apps/server/test/services/threads/timeline-page-builder.test.ts` (fixture `createConnection(join(directory, "history.db"))` at line 84) and `apps/server/test/services/threads/history-worker.test.ts` (line 38) run the real worker on file databases.

*Current requirement.* The in-memory branches are a legitimate test seam: fast route tests run on in-memory SQLite, which the worker cannot open. The duplication of the shaping recipe is not required by anything.

*Bundling constraint (Proven by inspection).* `apps/server/package.json` script `build` bundles `src/services/threads/timeline-worker.ts` as its own entry (`dist/timeline-worker.js`). Any shared module that the worker imports is bundled into the worker. It must therefore import only what the worker already imports: redaction, truncation, preview, `thread-data.js` and `timeline.js`. It must never import `timeline-page-builder.ts`, which pulls in `node:worker_threads` `Worker` and error reporting.

**Proposed end state and preservation argument**

Add one module, `apps/server/src/services/threads/timeline-response-shaping.ts`, as the single owner of the post-build shaping recipe for each history response kind. Signatures:

```ts
export function shapeTimelineResponse(
  db: DbConnection,
  threadId: string,
  response: ThreadTimelineResponse,
  options: Pick<BuildThreadTimelineOptions, "maxInlineOutputChars" | "includeNestedRows">,
): ThreadTimelineResponse; // truncate (unless null), preview unless includeNestedRows, redact with withhold

export function redactConversationOutline(
  db: DbConnection,
  threadId: string,
  outline: ThreadConversationOutlineResponse,
): ThreadConversationOutlineResponse; // redact with withhold, full item list

export function filterConversationOutlineRole(
  outline: ThreadConversationOutlineResponse,
  role: OutlineBuildOptions["role"],
): ThreadConversationOutlineResponse; // identity when role is undefined

export function redactedThreadEventRows(
  db: DbConnection,
  threadId: string,
  options: EventsBuildOptions,
): ThreadEventRow[]; // listThreadEventRows → map(redactThreadHistoryEvent) → redact with withhold

export function redactedTurnSummaryDetails(
  db: DbConnection,
  thread: Thread,
  options: BuildTimelineTurnSummaryDetailsOptions,
): TimelineTurnSummaryDetailsResponse; // build → redact with withhold
```

The outline needs two functions, not one, because the worker must hash the redacted items **before** role filtering (`timeline-worker.ts:418-420`). The digest decides whether a checkpoint is written, and that persisted cache record must not change.

Callers after the change:

- **`timeline-worker.ts`:**
  - The events branch becomes `JSON.stringify(redactedThreadEventRows(db, thread.id, request.options))`.
  - The turn-details branch becomes `JSON.stringify(redactedTurnSummaryDetails(db, thread, request.options))`.
  - The outline branch uses `redactConversationOutline`, then the digest code, then `filterConversationOutlineRole`.
  - The timeline branch uses `shapeTimelineResponse(db, thread.id, timeline.response, options)`.
  - Cache keys, `record`, epochs, identity, `queries`, `cacheTouches` and the outline checkpoint logic stay in the worker unchanged.
- **`timeline-page-builder.ts`:**
  - The memory branches call the same functions in the same order as the worker.
  - The outline branch therefore switches to redact-with-`withhold`-then-filter. This is the intentional fix to ISS-S06-004, and it changes behaviour only on in-memory databases.
  - A local `async function pageBuilderFor(db): Promise<PageBuilder>` replaces the five bootstrap blocks. It gets or creates the builder first and then awaits `ensureHistoryCache(db)`, which is the timeline order. For the other four entry points this changes only the close-during-await race: they now get the closed builder's `unavailable()` (503) instead of registering a fresh builder. Record that choice in the commit message.
- **`apps/server/src/routes/threads/data.ts:843-853`:** the `limit === 1` fast path becomes `context.json(redactedThreadEventRows(deps.db, threadId, options))`. The route's `options` object (afterSeq, beforeSeq, limit, order, types) must type-check as `EventsBuildOptions`. If it does not, stop and leave this call site alone, because it is optional to the item.

What survives unchanged: all five exported entry-point signatures, the memory branches as a test seam, `db.transaction` around the in-memory timeline build, the `workerError(404)` checks, and every result shape (`TimelineWorkerResult`, `OutlineWorkerResult`, `TurnDetailsWorkerResult`, `EventsWorkerResult`). The worker's message protocol and persisted history-cache records are byte-identical, because the worker calls the same primitives in the same order with the same options.

Non-goals:

- Do not delete the memory branches or move the harness to file databases. That would slow every route test.
- Do not run the worker's request handler in-process. The handler is bound to module-level `cache`, `sourceIdentity`, `queries` and `outlineDigests`, so this would be a larger restructuring of a hot path.
- Do not change `/events/wait` (`data.ts:912`), which uses default redaction options on purpose. `public-thread-history-safety.test.ts:263` asserts its 413.
- Do not change search.

**Expected gain and cost**

Observed baseline at the snapshot (handwritten production, non-blank lines):

| Area | Lines |
|---|---|
| In-memory branches in `timeline-page-builder.ts` | 104 (39 + 32 + 14 + 14 + 5) |
| Bootstrap blocks | 30 |
| Duplicated shaping in `timeline-worker.ts` | 44 (11 + 8 + 10 + 15) |
| Events copy in `data.ts` | 11 |

Projection (not measured):

| Change | Effect on line count |
|---|---|
| New module, including imports | about +45 |
| Shaping removed from the worker | about −30 |
| Shaping removed from the memory branches | about −40 |
| Five bootstrap blocks replaced by an 8-line helper and five one-line calls | about −17 |
| Route fast path shrinks | about −8 |
| Imports dropped from `timeline-page-builder.ts` (`truncateTimelineResponseOutputs`, `previewTimelineResponseOutputs`, `redactThreadHistoryEvent`, `listThreadEventRows`, likely `buildTimelineTurnSummaryDetails`) | about −5 |
| **Net** | **about −30 to −45** |

The sweep's 50 to 80 overstated the gain: much of the memory-branch code (result assembly, epochs, identities) is not shaping and stays.

Tests: one new regression case of about 25 to 40 lines. No test lines are removed.

Mechanisms:

- The four shaping recipes (timeline, outline, turn details, events) go from two copies to one each. Events go from three copies to one.
- The builder bootstrap goes from five copies, in two different orders, to one.

Maintenance effect: a new redaction, truncation or preview step for history responses becomes one edit, and the harness route tests then exercise it. Today a missed memory copy changes only test behaviour, which is exactly how the outline drifted.

Performance: neutral by construction on the production worker path, because it runs the same calls in the same order. Running one extra function frame is not measurable. No benchmark is required. The existing `apps/server/test/performance/history-stalls.bench.test.ts` covers this path if a reviewer asks for one.

**Execution steps**

1. **Reconfirm.**
   - Run `git log --oneline e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e..HEAD -- apps/server/src/services/threads/timeline-page-builder.ts apps/server/src/services/threads/timeline-worker.ts apps/server/src/routes/threads/data.ts apps/server/src/services/threads/thread-history-redaction.ts`.
   - Re-read the anchors in the table above.
   - **Re-plan** if any of these is true: the worker no longer redacts the outline before hashing; a memory branch was removed or now runs in a worker; `redactThreadHistory` gained ordering-sensitive state beyond the aggregate budgets; or the worker started importing `timeline-page-builder.ts`.
2. **Add the regression test first and watch it fail.** In `apps/server/test/public/public-thread-history-safety.test.ts`, add a case next to "withholds malformed %s output on event pages and timeline reads" (line 120). Use the existing `withTestHarness`, `seedThreadFixture` and `seedEvent` helpers.
   - Seed a turn whose user message (or `agentMessage` text) is exactly `[1/3] Building`. This matches the JSON-text pattern but is invalid JSON.
   - Request `/api/v1/threads/${thread.id}/conversation-outline`, then the same URL with `?role=user`.
   - Expect status 200, the item text replaced by `[Content withheld: this text could not be safely displayed]` (the marker string the existing test asserts at line 190), and no raw synthetic value.
   - On the snapshot code this should fail with 413. That is the predicted result, inferred by inspection and not yet run.
3. **Checkpoint A: create `timeline-response-shaping.ts`.** Write the five functions with the signatures above. Move the bodies verbatim from `timeline-worker.ts:272-282`, `292-299`, `414-416`, `448-454` and `549-564`. Import only from `./thread-history-redaction.js`, `./thread-data.js`, `./timeline-output-truncation.js`, `./timeline-output-preview.js`, `./timeline.js` and `./timeline-worker-contract.js` (types only), plus `@omnyo/db` and `@omnyo/server-contract` types.
4. **Switch the worker** (`timeline-worker.ts`). Replace the four inline recipes with calls. In the outline branch:
   - assign `const sanitized = redactConversationOutline(db, thread.id, outline)`;
   - leave the digest and checkpoint code untouched;
   - build `const response = filterConversationOutlineRole(sanitized, options.role)`.

   Keep the checkpoint redaction at lines 434-436 inline: it redacts a checkpoint, not a response. Remove the now-unused imports (`truncateTimelineResponseOutputs`, `previewTimelineResponseOutputs`, `listThreadEventRows`, `redactThreadHistoryEvent`, and `buildTimelineTurnSummaryDetails` if unused). Keep `redactThreadHistory`, which the checkpoint still uses.
   - **Verify:** run the worker-path tests (`timeline-page-builder.test.ts`, `history-worker.test.ts`, `conversation-outline-incremental.test.ts`) and typecheck. They must pass unchanged.
5. **Checkpoint B: switch the memory branches** (`timeline-page-builder.ts`).
   - The timeline branch (643-687) calls `shapeTimelineResponse`.
   - The outline branch (711-747) calls `filterConversationOutlineRole(redactConversationOutline(db, thread.id, response), options.role)`. This is the intentional behaviour fix.
   - The turn-details branch (775-790) calls `redactedTurnSummaryDetails`.
   - The events branch (818-831) calls `redactedThreadEventRows`.
   - Add `async function pageBuilderFor(db: DbConnection): Promise<PageBuilder>` next to `const builders` (line 140). Replace the five bootstrap blocks with `const builder = await pageBuilderFor(db);`.
   - Drop the unused imports.
   - **Verify:** the new regression case now passes, and the route suites listed below pass.
6. **Checkpoint C (optional, independent): route fast path.** Change `apps/server/src/routes/threads/data.ts:843-853` to `context.json(redactedThreadEventRows(deps.db, threadId, options))`. Drop `listThreadEventRows` and `redactThreadHistoryEvent` from that file's imports only if they become unused; `redactThreadHistoryEvent` is still used at line 912. Skip this step if `options` does not satisfy `EventsBuildOptions` without casts.
7. **Clean up and recount.**
   - `rg -n "truncateTimelineResponseOutputs|previewTimelineResponseOutputs|map\(redactThreadHistoryEvent\)|invalidJsonText" apps/server/src/services/threads apps/server/src/routes/threads` should show the shaping primitives only in the new module. The remaining `invalidJsonText` uses should be the worker checkpoint, `thread-history-redaction.ts` and unrelated routes.
   - `rg -n "builders.get\(db\)" apps/server/src/services/threads/timeline-page-builder.ts` should show only `pageBuilderFor`, `closeThreadTimelinePageBuilders` and `invalidateThreadHistoryBuilders`.
   - Recount with `git diff --stat` and report the net line count against the baseline above.
   - Inspect the full diff for unrelated edits.

**Verification and acceptance criteria**

Commands, from the repository root `$OMNYO_CHECKOUT` with dependencies installed. The script names were read from `apps/server/package.json` and the root `package.json` at the snapshot. They were not run here because the snapshot has no node_modules.

- Typecheck: `pnpm --filter @omnyo/server typecheck` (script `typecheck` = `tsc --noEmit`).
- Targeted tests: `cd apps/server && pnpm exec vitest run --config vitest.config.ts test/public/public-thread-history-safety.test.ts test/public/public-thread-data.test.ts test/public/public-thread-timeline-output-preview.test.ts test/public/public-thread-outline-snapshot.test.ts test/services/threads/timeline-page-builder.test.ts test/services/threads/timeline-page-builder.deadline.test.ts test/services/threads/history-worker.test.ts test/services/threads/conversation-outline-incremental.test.ts test/services/threads/thread-history-redaction.test.ts`. The package script `test` is `vitest run --config vitest.config.ts`, so `pnpm --filter @omnyo/server test -- <files>` is equivalent.
- Lint and format: `pnpm exec oxlint --deny-warnings --format=agent apps/server/src/services/threads/timeline-response-shaping.ts apps/server/src/services/threads/timeline-worker.ts apps/server/src/services/threads/timeline-page-builder.ts apps/server/src/routes/threads/data.ts`, and `pnpm exec oxfmt --check <same files>`. The root has `.oxlintrc.json` and `.oxfmtrc.json`, and the root scripts are `lint` (`turbo run lint`) and `format:check` (`oxfmt . --check`).
- Worker bundle: `pnpm --filter @omnyo/server build` must still emit `dist/timeline-worker.js`, and `rg -n "timeline-page-builder" apps/server/dist/timeline-worker.js` should find nothing. This check is optional and needs a full build.

Acceptance:

- **Behaviour:**
  - All listed suites pass without editing any existing assertion.
  - The new outline regression case fails before step 5 and passes after it.
  - The worker-path suites pass after step 4 with no test edits, which shows production shaping is unchanged.
- **Contract:** the cache record bodies and keys written by the worker are unchanged. Nothing in steps 3-4 touches `record(...)`, `historyRecordKey(...)` or the digest input `sanitized.items`.
- **Structure:**
  - The shaping primitives are called only from `timeline-response-shaping.ts`.
  - There is one bootstrap helper.
  - The memory branches contain only thread lookup, option resolution, a shaping call and result assembly.
  - The new module is imported by the worker but never imports `timeline-page-builder.ts`.
- **Performance:** no measurement required. The production call order is unchanged by construction. If a reviewer asks, run `apps/server/test/performance/history-stalls.bench.test.ts` before and after on the same machine.

**Rollback and stop conditions**

- **Rollback:** the change is one commit with no data, schema, protocol or persisted-format change. Revert the commit. If only the outline fix needs to survive, keep the one-line change at `timeline-page-builder.ts:723-729` (add `{ invalidJsonText: "withhold" }` and filter after redaction) together with the new regression test.
- **Stop if:**
  - any worker-path test changes output after step 4. That would mean the extraction altered production shaping, so find out why before continuing.
  - the outline digest would need to be computed on filtered items. That would change the persisted checkpoint behaviour, so keep the worker's outline code inline and share only the memory-side calls.
  - the new module cannot avoid importing something heavy into the worker bundle.
  - an existing assertion depends on the in-memory outline returning 413. None was found by `git grep -n "conversation-outline" e9e1b74c -- apps/server/test`, but re-check before editing such an assertion.
- **Safer smaller alternative:** if any stop condition fires, land only the ISS-S06-004 outline fix with its regression test and the `pageBuilderFor` helper. That still removes about 17 lines and the drift that has already happened.
