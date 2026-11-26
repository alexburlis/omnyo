# RF-100 — Build sent-message edit and handoff execution fields with the client-core builders instead of restating them in thread detail

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** confirmed. Both restatements exist as the sweep described, the values are provably identical, and the line estimate holds. This card adds one scope note: the embedded chat's `executionRequestFields` is a different rule and stays out of scope (see "Non-goals").
- **Potential:** low. The change is small, but it removes duplicated knowledge on a send path. Each new execution field would otherwise need edits in three places, and a missed copy silently drops the field from edited or handed-off messages.
- **Confidence:** high. The duplication and the value equivalence are Proven by inspection. The line savings are a projection from exact line ranges.
- **Readiness:** ready. No owner decision is needed, because no behaviour, API or persisted format changes.
- **Effort:** extra small, under one hour including the targeted tests.
- **Risk:** low. The realistic regression is a missing or extra `serviceTier` key, or a wrong `executionInputSources` object. The client-core helper uses the same gate, and existing client-core and app tests assert both.
- **Prerequisites:** none.
- **Related and overlapping items:**
  - RF-036 "Give the follow-up draft-submission transaction one owner" says RF-100 owns the embedded chat's hand-built `executionRequestFields` (`apps/app/src/components/thread/embedded-chat/EmbeddedThreadChat.tsx:345-376`). That is not the case. The embedded rule differs in meaning (see "Non-goals"), so this card leaves it alone, and RF-036 does not need to wait for RF-100.
  - RF-029 "Run new-thread and existing-thread composer selections through one queue and execution sequence" and RF-052 "Define the composer optimistic thread-status protocol once" edit other parts of `ThreadDetailPromptArea.tsx`. RF-088 "Build the queued-message plugin composer host in one hook" also edits that file. None of them touches `createHandoffThread` or `submitSentMessageEdit`. Land each card as its own commit.
  - The new-thread composer (`apps/app/src/components/promptbox/NewThreadComposer.tsx:1885-1900` and `:2026`) has its own seed-based source rules for a new thread. It is a different contract and is out of scope.
- **Why this rank:** it is a small, safe removal of duplicated knowledge. It does not remove a mechanism, so it ranks below the structural items.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The prepared snapshot worktree had been removed by the time this card was verified, so every file was read with `git show e9e1b74c3:<path>`. `git diff --stat e9e1b74c3 HEAD` over the four cited source files was empty on local `main` (5f2d3f895), so the line anchors also hold there.

*What the subsystem does.* When a user sends a follow-up on an existing thread, the thread-detail composer (`apps/app/src/views/thread-detail/ThreadDetailPromptArea.tsx`) builds a `FollowUpExecutionSelection` (`:1363-1383` "followUpExecutionSelection"). That selection is `null` when no model is selected yet. Otherwise it holds the model, reasoning level, permission mode, service tier, whether the provider supports a service tier, and the execution input sources. Client-core turns this selection into request fields in one module-private function, `packages/client-core/src/prompt/threadDetailPromptSubmission.ts:338-354` "buildSharedThreadExecutionRequestFields". The rule is:

- `null` selection: send no execution fields.
- Otherwise: send `model`, `reasoningLevel`, `permissionMode` and `executionInputSources`, and send `serviceTier` only when `supportsServiceTier && serviceTier`.

Three client-core builders use it: `buildAutoFollowUpRequest` (`:248`), `buildSteerFollowUpRequest` (`:276`) and `buildCreateQueuedFollowUpRequest` (`:292`). The module is re-exported from the package root by `packages/client-core/src/index.ts:33` (`export * from "./prompt/threadDetailPromptSubmission.js"`). `@omnyo/client-core` is a private workspace package consumed from source (`packages/client-core/package.json`: `"private": true`, exports point at `./src/index.ts`), so exporting one more function changes no published contract.

*Observed facts (Proven by inspection).*

1. **Sent-message edit restates the rule.** `ThreadDetailPromptArea.tsx:2136-2150` "handleSentMessageEditSubmit" passes `followUpExecutionSelection` to `sentMessageEdit.onSubmit` as `target.execution` (type `FollowUpExecutionSelection`, declared at `ThreadDetailPromptArea.tsx:211-224` "ThreadDetailSentMessageEdit"). `apps/app/src/views/thread-detail/ThreadDetailView.tsx:1408-1448` "submitSentMessageEdit" then spreads, at `:1426-1436`, `execution ? { model, permissionMode, reasoningLevel, executionInputSources, ...(execution.supportsServiceTier && execution.serviceTier ? { serviceTier } : {}) } : {}`. This is the same five fields under the same conditions as the client-core function. Only the key order differs.
2. **The edit request accepts exactly these fields.** `packages/server-contract/src/api/threads.ts:536-549` "editMessageRequestSchema" is `sendMessageRequestFieldsSchema` minus `requestId`, `mode`, `sendAt`, `pluginSubmission`, `compactFirst` and `sendNow`, plus `operationId` and `expectedRequestSequence`, and it is `.strict()`. The send builders already put the helper's output into send requests, so its keys are valid edit keys.
3. **Key order does not matter to the server.** The server fingerprints an edit for idempotent replay in `apps/server/src/services/threads/thread-edit-message.ts:84-99` "requestFingerprint". It builds a fresh object with a fixed key order before `JSON.stringify`, and the nested `executionInputSources` object is the same reference in both versions. So reordering the spread keys cannot change the fingerprint.
4. **Handoff re-sets fields the builder already set.** `ThreadDetailPromptArea.tsx:1385-1451` "createHandoffThread" calls `buildThreadHandoffCreateRequest` (`:1411-1427`) with `providerId: selectedProviderId`, `model: effectiveSelectedModel`, `reasoningLevel`, `serviceTier`, `supportsServiceTier` and `permissionMode`. The builder (`packages/client-core/src/prompt/thread-handoff-request.ts:140-180`) returns `providerId`, `model`, `reasoningLevel`, `permissionMode` from that same input, plus `executionInputSources: { providerId, model, reasoningLevel, permissionMode: "explicit", ...(supportsServiceTier && serviceTier ? { serviceTier: "explicit" } : {}) }` and the same conditional `serviceTier`. The app then builds `request = { ...baseRequest, ... }` (`:1433-1451`) and overrides `providerId`, `model`, `reasoningLevel`, `permissionMode` and `executionInputSources` (`:1435-1447`) with values from the same variables, using an identical literal object and the same gate. Only `input: submission.input` (`:1448`), `pluginSubmission` (`:1449`) and `expectedPluginWait` (`:1450`) add anything. Overriding an existing key keeps its original insertion position, so even the serialized key order is unchanged by removing the override.
5. **The override has no other reason to exist.** `git blame` on `:1433-1451` and on the builder shows both arrived in the same initial publish commit `060950255`, so there is no history of a builder that lacked these fields. Only `request.projectId` is read from `request` later (`:1491`).
6. **Callers.** `git grep -n "buildThreadHandoffCreateRequest(" e9e1b74c3 -- apps packages plugins` finds this one production call plus the client-core tests. `git grep -n "buildSharedThreadExecutionRequestFields\|SharedThreadExecutionRequestFields" e9e1b74c3` finds only `threadDetailPromptSubmission.ts`.
7. **No other copy of this rule.** `git grep -n "supportsServiceTier &&" e9e1b74c3 -- apps packages plugins` (tests excluded) finds the two app copies above, the two gates inside `thread-handoff-request.ts`, the client-core helper, and three new-thread composer sites (`NewThreadComposer.tsx:1895`, `:2026`, `composer-selection-settle.ts:164`), which follow the separate new-thread contract. `git grep -n "execution.executionInputSources"` finds only `ThreadDetailView.tsx:1431` and the client-core helper.

*Existing tests that pin the behaviour (Proven by inspection; not run, because the snapshot has no `node_modules`).*

- `packages/client-core/test/threadDetailPromptSubmission.test.ts`: "steers with the selected execution options" (`:41`, `supportsServiceTier: false`), "builds auto follow-up requests with selected execution options" (`:107`, supported tier), "omits unsupported service tier when queueing a follow-up" (`:166`) and the `execution: null` cases (`:151`, `:198`). Together they cover every branch of the helper.
- `packages/client-core/test/thread-handoff-request.test.ts` asserts the builder's explicit sources and its service-tier presence and absence (`:175`, `:191`, `:206`, `:233`).
- `apps/app/src/views/thread-detail/ThreadDetailPromptArea.test.tsx`: "updates an active handoff with a same-provider model and creates the thread with it" (`:2632`), "creates a same-provider handoff with unchanged execution marked explicit" (`:2667`) and "marks a supported handoff service tier explicit" (`:2695`). They assert the `createThreadMutateAsync` payload, so they catch a regression in the handoff path.
- `ThreadDetailView.tsx` has no test file (`git ls-tree -r --name-only e9e1b74c3 apps/app/src/views/thread-detail | grep ThreadDetailView` lists only the lazy wrapper's test). The edit mapping is therefore covered only through the client-core helper tests after this change. That is better than today, where the inline copy has no test at all.

*Maintenance cost today.* Adding an execution field such as a new speed or effort option means editing the client-core helper, the edit copy in `ThreadDetailView.tsx` and the handoff override in `ThreadDetailPromptArea.tsx`. Missing the edit copy silently drops the field from edited messages. Missing the override leaves a field the builder sets but the app then overrides with a stale value or shape.

**Proposed end state and preservation argument**

*What disappears.*

- The inline edit-field spread in `ThreadDetailView.tsx:1426-1436` "submitSentMessageEdit".
- The five redundant overrides in `ThreadDetailPromptArea.tsx:1435-1447` "createHandoffThread".

*What remains and who owns it.* `buildSharedThreadExecutionRequestFields` in `packages/client-core/src/prompt/threadDetailPromptSubmission.ts` becomes exported, keeping its name and signature `(execution: FollowUpExecutionSelection) => SharedThreadExecutionRequestFields`. It stays the single owner of the follow-up rule for existing threads. `buildThreadHandoffCreateRequest` stays the single owner of the handoff request. Keeping the existing name keeps the diff minimal and needs no rename at the three internal call sites. The return-type interface `SharedThreadExecutionRequestFields` (`:42-48`) stays module-private. The package is consumed from source with `tsc --noEmit`, so no declaration emit needs it exported. Export it as a type only if typecheck asks for it.

*Data flow after the change.*

- Edit: `followUpExecutionSelection` goes to `target.execution`, then `buildSharedThreadExecutionRequestFields(target.execution)`, then is spread into `editMessage.mutateAsync({ id, messageId, operationId, expectedRequestSequence, input, ...fields })`.
- Handoff: the builder output is spread, and the app adds only `input`, `pluginSubmission` and `expectedPluginWait`.

*Why semantics survive.*

- Edit: for `null`, both versions spread `{}`. For a selection, both spread the same four fields, plus `serviceTier` under the identical condition. Only the key order changes, and fact 3 shows the order does not matter.
- Handoff: every removed override writes the same value to a key that already holds it (fact 4). The overwritten keys keep their insertion positions, so the request object is identical, including its key order.
- No UI state changes. The submit gating (`canSubmitSentMessageEdit`), the error toast and the session restore in `submitSentMessageEdit` are untouched.

*Non-goals.*

- `EmbeddedThreadChat.tsx:345-376` "executionRequestFields" stays as it is. Its rule differs. It always sends `executionInputSources`, even with no model, and it forces `permissionMode: "explicit"` under `permissionPolicy === "snapshot"`. It sends `permissionMode` independently of the model, and it applies the service-tier gate earlier, at `:332-334`. Routing it through the client-core helper would change what side chats send. Unifying it would be a behaviour decision, not part of this card.
- The new-thread composer's seed-based sources (`NewThreadComposer.tsx:1885-1900`) stay out of scope.
- No rename of the helper, and no change to `buildThreadHandoffCreateRequest`.

**Expected gain and cost**

Projection from exact line ranges (handwritten production code only):

| File | Change | Lines |
|---|---|---|
| `apps/app/src/views/thread-detail/ThreadDetailView.tsx` | Replace the 11-line conditional spread (`:1426-1436`) with one spread line; add one import line | -10, +1 |
| `apps/app/src/views/thread-detail/ThreadDetailPromptArea.tsx` | Delete the 13 override lines (`:1435-1447`) | -13 |
| `packages/client-core/src/prompt/threadDetailPromptSubmission.ts` | Add `export` to the existing function | 0 |
| **Net** | | **about -22** |

The import line `import { buildSharedThreadExecutionRequestFields } from "@omnyo/client-core";` is 77 characters, so it fits the 80-column `printWidth` in `.oxfmtrc.json` on one line. `ThreadDetailView.tsx` already has several single-name imports from `@omnyo/client-core` (`:78`, `:182`, `:277`, `:287`), so a separate import line matches the file's style. If the executor merges it into `:182` instead, oxfmt will wrap it (+4 lines), and the net becomes about -19.

Tests: no test changes are required. A direct unit test of the newly exported helper is optional, because the three builder tests already exercise every branch.

Mechanisms: before, the follow-up field rule is stated three times (client-core plus two app copies), and handoff fields are stated twice. After, each rule is stated once. Performance: neutral, because the same spreads run on the same user action and no hooks or dependencies change.

**Execution steps**

1. **Reconfirm the baseline.** In the working checkout, run `git diff --stat e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e HEAD -- apps/app/src/views/thread-detail/ThreadDetailView.tsx apps/app/src/views/thread-detail/ThreadDetailPromptArea.tsx packages/client-core/src/prompt/threadDetailPromptSubmission.ts packages/client-core/src/prompt/thread-handoff-request.ts`. If any file changed, re-open the anchors and re-check facts 1 and 4. Stop and re-plan if any of the following is true:
   - `buildThreadHandoffCreateRequest` no longer sets `providerId`, `model`, `reasoningLevel`, `permissionMode` and `executionInputSources` from the same inputs the app passes in.
   - `createHandoffThread` now passes the builder different values from the ones it overrides with.
   - `ThreadDetailSentMessageEdit["onSubmit"]`'s `execution` is no longer a `FollowUpExecutionSelection`.
   - `editMessageRequestSchema` no longer accepts every key the helper returns.
2. **Export the helper.** In `packages/client-core/src/prompt/threadDetailPromptSubmission.ts:338`, change `function buildSharedThreadExecutionRequestFields(` to `export function buildSharedThreadExecutionRequestFields(`. Do not change its body. The package root already re-exports the module (`packages/client-core/src/index.ts:33`).
3. **Use it in sent-message edit.** In `apps/app/src/views/thread-detail/ThreadDetailView.tsx`, inside "submitSentMessageEdit", replace the whole `...(execution ? { ... } : {}),` block (`:1426-1436`) with `...buildSharedThreadExecutionRequestFields(execution),`. Keep `const execution = target.execution;` (`:1417`), or inline it as `buildSharedThreadExecutionRequestFields(target.execution)` and delete `:1417`. Either is fine; inlining saves one more line. Add `import { buildSharedThreadExecutionRequestFields } from "@omnyo/client-core";` next to the existing client-core imports.
4. **Drop the handoff overrides.** In `apps/app/src/views/thread-detail/ThreadDetailPromptArea.tsx`, inside "createHandoffThread", reduce `const request = { ... }` (`:1433-1451`) to:

   ```ts
   const request = {
     ...baseRequest,
     input: submission.input,
     ...(pluginSubmission === undefined ? {} : { pluginSubmission }),
     ...(heldWait === undefined ? {} : { expectedPluginWait: heldWait }),
   };
   ```

   Leave the `buildThreadHandoffCreateRequest` call, its `execution` argument and the `useCallback` dependency list unchanged. `selectedProviderId`, `effectiveSelectedModel`, `reasoningLevel`, `permissionMode`, `serviceTier` and `supportsServiceTier` are still read by the builder call, so the dependency list stays the same.
5. **Checkpoint.** Run the client-core and app checks listed under "Verification and acceptance criteria". There is no superseded export, configuration or documentation to remove.
6. **Format and inspect.** Format only the three changed files with the repository's formatter, then lint them (commands below). Inspect `git diff` to confirm that only these three files changed and that no `"explicit" as const` literal or `supportsServiceTier &&` gate remains in `ThreadDetailView.tsx` or in `createHandoffThread`. Recount with `git diff --numstat` against the baseline and expect about +2/-24.

**Verification and acceptance criteria**

The package scripts below were read from `packages/client-core/package.json` (`typecheck`, `test`), `apps/app/package.json` (`typecheck`, `test`, `lint`) and the root `package.json` (`format`, `format:check`, `lint`). They were not run here, because the snapshot has no `node_modules`.

- From the repository root:
  - `pnpm --filter @omnyo/client-core typecheck`
  - `pnpm --filter @omnyo/client-core test`. Expect `test/threadDetailPromptSubmission.test.ts` and `test/thread-handoff-request.test.ts` to pass unchanged.
  - `pnpm --filter @omnyo/app typecheck`
  - `pnpm --filter @omnyo/app exec vitest run --config vitest.config.ts src/views/thread-detail/ThreadDetailPromptArea.test.tsx`. This uses the `vitest run --config vitest.config.ts` form from the app's `test` script, narrowed to one file; the exact file-filter form is unverified. Expect the three handoff payload tests (`:2632`, `:2667`, `:2695`) and the sent-message edit tests (`:1282`, `:1401`) to pass unchanged.
  - Format the changed files with `pnpm exec oxfmt <the three files>`. Lint them with `pnpm exec oxlint --deny-warnings <the three files>`, which uses the root `.oxlintrc.json` (the exact flags are unverified at this snapshot). Finish with `pnpm run format:check`, which may be limited to the changed files.
- **Contract checks.** The edit payload must still omit `serviceTier` when the provider does not support it or no tier is set, and it must send no execution fields when the selection is `null`. The client-core tests at `:41`, `:151`, `:166` and `:198` cover these cases for the shared helper. The handoff payload must still carry `executionInputSources` with exactly `providerId`, `model`, `reasoningLevel` and `permissionMode` marked explicit, plus `serviceTier: "explicit"` only for a supported, set tier. The app tests at `:2667` and `:2695` assert this. Do not edit any of these assertions.
- **Optional manual check (Alex tests UI himself).** On a thread, edit a sent message with a non-default model, and confirm that the rerun uses that model. Start a handoff with a supported Fast tier, and confirm that the new thread starts on Fast.
- **Structural completion.** `git grep -n "supportsServiceTier &&" -- apps/app/src/views/thread-detail` returns nothing. `git grep -n "buildSharedThreadExecutionRequestFields" -- apps packages` shows the definition, its three internal uses and one use in `ThreadDetailView.tsx`.

**Rollback and stop conditions**

- **Rollback.** The change is one small, self-contained commit across three files. Reverting that commit restores the old code exactly. No persisted data, API contract or migration is involved.
- **Stop conditions.**
  - Typecheck shows that `createPendingChat`'s request type needed the narrowed literal types from the removed override, for example the `executionInputSources` literal. In that case keep only an `as const`-free type annotation on `request`. Do not restore the duplicate values.
  - A handoff or edit test fails for a reason other than a key-order assertion.
  - Step 1 finds that the builder and the app now pass different values.

  In any of these cases, keep step 2 and step 3, which are independent, and re-investigate step 4 separately.
- **Smaller alternative.** If the handoff override turns out to be needed, the edit half (steps 2 and 3) still removes the main duplicated rule on its own, for about -9 lines.
