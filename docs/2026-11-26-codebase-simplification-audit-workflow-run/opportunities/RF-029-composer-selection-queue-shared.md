# RF-029 — Replace the two hand-copied composer `setSelection` queues and ordered execution-selection routines with one shared queue hook and one execution-selection routine

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** confirmed, with an adjusted plan. The duplication is real and exactly as large as the sweep agents reported. This card changes one design detail: the existing-thread handoff model path moves into that composer's state builder, so the shared routine needs no handoff hook.
- **Potential:** medium. The routine is small, but it is a plugin-visible contract (`experimental_setSelection` in `@omnyo/plugin-sdk`), and every change to its ordering or settle rules currently has to be made twice, in lockstep.
- **Confidence:** high. The duplication is proven by inspection and byte comparison. The line savings are a projection.
- **Readiness:** ready.
- **Effort:** small to medium, about half a day to one day including the new unit tests.
- **Risk:** moderate. The code is timing-sensitive, because each step waits for committed React state. The realistic regressions are a reordered or missing settle, lost lock gating, a broken handoff model path, and a queue that stops after a rejected request. The change touches only programmatic selection. Manual picker UI is untouched, and no persisted data is involved.
- **Prerequisites:** none.
- **Related and overlapping items:**
  - RF-099 "Make new-thread picker locks a composer prop" changes where `pickerLocksRef` gets its value. That edit is independent: this card only reads `pickerLocksRef.current` once per request, exactly as today. If RF-099 lands first, pass the prop-derived locks instead.
  - RF-088 "Build the queued-message plugin composer host in one hook" also edits the plugin composer host wiring in `ThreadDetailPromptArea.tsx`. The queued-message editor has no `setSelection`; see the test "gives the queued-message editor no pickers to set" in `apps/app/src/views/thread-detail/ThreadDetailPromptArea.test.tsx:2613`. Land the two cards in separate commits to keep their diffs reviewable.
  - RF-052 and RF-100 touch other parts of the same composers but not this routine.
  - An earlier run of this audit wrote a parallel card for the same item: `docs/2026-11-26-codebase-simplification-audit/opportunities/RF-101-composer-selection-sequence.md`. It uses an older numbering scheme. This RF-029 card is the one to execute.
- **Why this rank:** it removes duplicated algorithm knowledge (one copy of the ordered selection rules instead of two) at low cost, and it makes the routine unit-testable for the first time. Today the queue recovery and the execution-lock gating are reachable only through large component integration suites, and neither has a direct test.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The prepared snapshot worktree had been removed by the time this card was verified, so every file was read with `git show e9e1b74c3:<path>`.

*What the subsystem does.* Plugins can call `composer.experimental_setSelection({ projectId?, environment?, providerId?, model?, reasoningLevel?, serviceTier?, permissionMode? })`. The call travels from `apps/app/src/lib/plugin-composer-handle.ts:236` (`hostSetSelection = source.setSelection`) and `:282`, through the host interface `apps/app/src/components/plugin/plugin-composer-host.tsx:56` (`setSelection?(selection): Promise<ComposerSelection>`), to the composer that owns the pickers. The composer applies the request one field at a time. After each change it waits for React to commit, because later options depend on the catalog of the provider that has just been chosen. It then returns the values that were actually committed.

*Observed facts (Proven by inspection).*

- Exactly two production implementations exist. `git grep -n -E 'pendingSelectionRef|waitForSettledComposerState|waitUntilComposerStateSettled|readExecutionTuple|useCommittedComposerState' e9e1b74c3 -- apps packages plugins` finds only `apps/app/src/components/promptbox/NewThreadComposer.tsx`, `apps/app/src/views/thread-detail/ThreadDetailPromptArea.tsx`, the owner module and its test. A wider `git grep -n setSelection` over `apps/app/src` (excluding tests and stories) finds no third implementation. `EmbeddedThreadChat.tsx:28` imports only `readExecutionSelection`, and `plugin-slot-mounts.test.tsx:1643` asserts that hosts without pickers refuse the call.
- **New-thread copy:** `apps/app/src/components/promptbox/NewThreadComposer.tsx:2301-2441`, which covers `pendingSelectionRef`, `applySelection` and `setSelection`. It is 141 physical lines (119 nonblank).
- **Existing-thread copy:** `apps/app/src/views/thread-detail/ThreadDetailPromptArea.tsx:1224-1320`, with the same three symbols. It is 97 physical lines (79 nonblank).
- Measurement (Reproduced): `sed -n` over each range, `wc -l`, and `python3 -I` `difflib.SequenceMatcher(autojunk=False)` on stripped nonblank lines give 119 and 79 lines with 65 matching in order. `cmp` shows that three blocks are byte-identical:
  - the `applySelection` head (deadline, `observer.waitUntil(() => true)`): new-thread 2303-2310 and thread 1226-1233;
  - the `settle` / `ensureSettled` closures: new-thread 2311-2322 and thread 1234-1245;
  - the `setSelection` queue: new-thread 2429-2441 and thread 1308-1320.
- The queue in both copies is:
  ```ts
  const run = pendingSelectionRef.current.then(
    () => applySelection(selection),
    () => applySelection(selection),
  );
  pendingSelectionRef.current = run;
  return run;
  ```
  Each request runs after the previous one, whether the previous request resolved or rejected, and each request returns its own result or rejection.
- **Shared ordered sequence** (both copies):
  1. Call `ensureSettled()` when `providerId` is given.
  2. Read `readExecutionTuple(selection, state.providerIds)`. If a tuple is present, call `changeExecution(tuple)` and then `settle(true)`.
  3. Otherwise, when the provider differs and is known, call `changeProvider` and then `settle(true)`. Next, when the provider matches and `model` is given, call `ensureSettled`, apply the model, and `settle(false)`. When the provider matches and `reasoningLevel` is given, call `ensureSettled`, `changeReasoning`, and `settle(false)`. When `serviceTier` is given and `supportsServiceTier` is true, call `changeServiceTier` and `settle(false)`.
  4. When `permissionMode` is given, call `changePermissionMode` and `settle(false)`.
  5. Finish with `settle(true)` and return the readout.
- **Divergences that must survive:**
  - The new-thread copy reads `const locks = pickerLocksRef.current` once (`NewThreadComposer.tsx:2324`). It runs a project and environment prelude first (2325-2355): `changeProject`, a refusal flag, `observer.waitUntil(next.requestedProjectId === requested)`, then `newThreadEnvironmentArgsToSeed` → `changeEnvironment` → `settle(false)`. It drops the tuple when `locks.execution` is set, or when `locks.provider` is set and the tuple names another provider (2359-2366). It skips `changeProvider` under `locks.provider`. It skips the model, reasoning, service-tier and permission steps under `locks.execution`. It returns `readNewThreadComposerSelection(state)` (`NewThreadComposer.tsx:226`).
  - The existing-thread copy has no locks. Its model step calls `state.handoffSelect({ providerId: state.selectedProviderId, model, reasoningLevel: selection.reasoningLevel ?? state.reasoningLevel })` when `state.isHandoffSelection`, and `state.changeModel(model)` otherwise (`ThreadDetailPromptArea.tsx:1266-1279`). It returns `readExecutionSelection(state)`.
  - The tuple filter on the new-thread side is not redundant with the guard inside `applyExecutionTuple` (`NewThreadComposer.tsx:2203-2212`). Filtering sends the request into the per-field path, which can still apply the service tier and permission mode under a provider-only lock. A silent no-op tuple would not.
- **Owner module:** `apps/app/src/components/promptbox/composer-selection-settle.ts` (192 lines). It already owns `resolveComposerSelectionDeadline`, `createCommittedStateObserver`, `useCommittedComposerState`, `waitForSettledComposerState`, `waitUntilComposerStateSettled`, `ExecutionSelectionState`, `readExecutionSelection` and `readExecutionTuple`. It has a unit test, `composer-selection-settle.test.ts`, which covers the observer, `readExecutionSelection` and `readExecutionTuple`.
- **State shapes:** `NewThreadComposerSelectionState` (`NewThreadComposer.tsx:199-222`) and `ThreadComposerSelectionState` (`ThreadDetailPromptArea.tsx:342-358`) share every execution field and `change*` method. The thread shape adds `isHandoffSelection` and `handoffSelect`. The new-thread shape adds the project, environment and `submissionEnvironment` fields. Both are built in `useCommittedComposerState` callbacks (`NewThreadComposer.tsx:2242-2266`, `ThreadDetailPromptArea.tsx:1178-1197`). `state.isHandoffSelection` is read only inside `applySelection` (`ThreadDetailPromptArea.tsx:1271`).
- **Post-snapshot drift:** commit `2366822c6` ("Let Account Pooler pick the Claude account…") edited `ThreadDetailPromptArea.tsx` above this range, so line anchors on current main are about 20 lines lower. It did not change the selection routine.

*Existing coverage* (read, not run; the snapshot has no `node_modules`):

- `apps/app/src/components/plugin/PluginNewThreadComposer.test.tsx:3620` `describe("NewThreadComposer setSelection")` covers project switching, environment seeding, refused project, reconciled values, model applied after provider landing, the atomic tuple, the picker commit through the tuple path, the provider lock (`locks: { provider: true }` at 3682) and the settle timeout (`setComposerSelectionSettleTimeoutForTest(150)` at 4168).
- `apps/app/src/views/thread-detail/ThreadDetailPromptArea.test.tsx:2434-2547` covers a handoff on another provider, a same-provider model set in place, and the picker commit after a model fallback. Line 2632 covers updating an active handoff with a same-provider model.
- `apps/app/src/components/plugin/plugin-slot-mounts.test.tsx:1433` `describe("useComposer().experimental_setSelection")` covers routing and validation.
- **Gaps:** no test found exercises queue recovery after a rejected request, back-to-back calls, or `locks.execution`. The search was `grep -n -i -E 'reject|serial|back-to-back|execution: true'` over the three test files.

*Maintenance cost today.* Adding an execution field (as `serviceTier` was added), or changing when `settle(true)` is required, means editing two 80 to 120 line async routines in lockstep inside two 2,800 to 3,000 line component files. Only the component integration suites check those edits.

**Proposed end state and preservation argument**

`composer-selection-settle.ts` becomes the single owner of the queue, the per-request session and the ordered execution routine. Each composer keeps only its own policy.

New exports (signatures are the plan, and the names may be adjusted):

```ts
export interface ExecutionSelectionTarget
  extends CommittedComposerState, ExecutionSelectionState {
  providerIds: readonly string[];
  changeProvider(providerId: string): void;
  // requestedReasoning lets thread detail's handoff path seed reasoning;
  // the new-thread builder ignores it.
  changeModel(model: string, requestedReasoning: ReasoningLevel | undefined): void;
  changeReasoning(level: ReasoningLevel): void;
  changeServiceTier(tier: ServiceTier | undefined): void;
  changeExecution(selection: ModelPickerSelection): void;
  changePermissionMode(mode: PermissionMode): void;
}

export interface ComposerSelectionSession<T extends CommittedComposerState> {
  state: T;                 // latest committed state; reassigned by the helpers below
  readonly deadline: number;
  settle(requireSettled: boolean): Promise<void>;
  ensureSettled(): Promise<void>;
  waitFor(predicate: (state: T) => boolean): Promise<void>;
}

// One deadline per request; initial observer.waitUntil(() => true, deadline).
export async function openComposerSelectionSession<T extends CommittedComposerState>(
  controller: CommittedComposerStateController<T>,
): Promise<ComposerSelectionSession<T>>;

export interface ExecutionSelectionLocks { provider?: boolean; execution?: boolean }

// Steps 1-4 of the shared sequence above, with lock gating identical to the
// new-thread copy; absent locks means all false (the existing-thread behaviour).
// Does NOT run the final settle(true): callers keep it so the readout is explicit.
export async function applyExecutionSelection<T extends ExecutionSelectionTarget>(
  session: ComposerSelectionSession<T>,
  selection: ExperimentalComposerSelection,
  locks?: ExecutionSelectionLocks,
): Promise<void>;

// Stable setSelection with chain-after-resolve-or-reject semantics.
export function useSerializedComposerSelection(
  apply: (selection: ExperimentalComposerSelection) => Promise<ExperimentalComposerSelection>,
): (selection: ExperimentalComposerSelection) => Promise<ExperimentalComposerSelection>;
```

Alternative that keeps the call sites simpler: let `applyExecutionSelection` run the final `settle(true)` itself. Choose one form and use it at both sites.

Consumers after the change:

- `NewThreadComposer.applySelection` opens a session and reads `locks` once. It runs its project and environment prelude using `session.state`, `session.waitFor` and `session.settle(false)`. It then calls `applyExecutionSelection(session, selection, { provider: locks.provider, execution: locks.execution })`, runs `await session.settle(true)`, and returns `readNewThreadComposerSelection(session.state)`. Its state builder passes `changeModel: (model) => handleModelChange(model)`. Wrap the function explicitly; do not pass the `useDraftPreservingOptionChange` function through with a second argument.
- `ThreadDetailPromptArea.applySelection` opens a session, calls `applyExecutionSelection(session, selection)`, runs `settle(true)`, and returns `readExecutionSelection(session.state)`. Its state builder implements the handoff choice:
  ```ts
  changeModel: isHandoffSelection
    ? (model, requested) => handleHandoffSelect({ providerId: selectedProviderId, model, reasoningLevel: requested ?? reasoningLevel })
    : (model) => setSelectedModel(model),
  ```
  The `isHandoffSelection` and `handoffSelect` fields then leave `ThreadComposerSelectionState`, because nothing else reads them (Proven by inspection at the snapshot: line 1271 is their only reader).
- Both `setSelection` blocks and both `pendingSelectionRef` refs are replaced by `const setSelection = useSerializedComposerSelection(applySelection)`.

*What disappears:* one of the two promise queues, one of the two session-setup copies (deadline, initial wait and the two settle closures), one of the two ordered execution routines, and the handoff branch inside the routine.

*Why the semantics survive:*

- **Ordering and settles.** The shared routine is the new-thread sequence with locks defaulting to false. With all locks false, every new-thread guard reduces to the existing-thread condition, token for token (compare `NewThreadComposer.tsx:2357-2414` with `ThreadDetailPromptArea.tsx:1247-1296`), except for the model step.
- **The model step.** The handoff closure reads `selectedProviderId`, `reasoningLevel` and `isHandoffSelection` from the same render that produced the committed `state` object the routine holds. These are the same values the current code reads as `state.selectedProviderId`, `state.reasoningLevel` and `state.isHandoffSelection`. The call is therefore equivalent (Proven by inspection: both come from the one `useCommittedComposerState` build callback per render).
- **One deadline per request.** `openComposerSelectionSession` computes `resolveComposerSelectionDeadline()` once, and every wait uses it.
- **Queue semantics.** These are unchanged: the request chains on both fulfilment and rejection, and each caller receives its own promise. `setSelection` stays referentially stable, because `useSerializedComposerSelection` wraps it in `useCallback([apply])` and both `applySelection` callbacks depend only on the stable controller. This matters because `dockConfig` (`NewThreadComposer.tsx:2453-2470`) and the host objects memoize on it.
- **Project and environment refusal.** These stay entirely in `NewThreadComposer`.

*Contracts that must not change:* `ExperimentalComposerSelection` and `experimental_setSelection` in `packages/plugin-sdk/src/app-contract.ts` and `packages/plugin-sdk/src/internal/composer-handle.ts`; `PluginComposerHost.setSelection`; the `NewChatDock` `select` callback; and the 15-second settle timeout with its test override.

*Non-goals:* moving project or environment logic; changing timeouts; adding `setSelection` to `EmbeddedThreadChat`, `PluginThreadChat` or the queued-message editor; changing whether the service tier or permission mode apply when the requested provider was refused (existing behaviour in both composers, kept as is).

**Expected gain and cost**

- **Before** (observed): 238 handwritten production lines across the two ranges, containing 2 queues, 2 session setups and 2 ordered routines, plus one inline handoff branch.
- **After** (projection): the owner module grows by about 100 to 115 lines (types, session helper, routine, hook). The new-thread `applySelection` shrinks to about 45 to 50 lines (session, project and environment prelude, call, readout). The thread `applySelection` shrinks to about 10 lines, plus about 4 lines in its state builder.
- **Net** (projection): roughly 50 to 70 fewer production lines. The basis is 238 − (≈110 + ≈48 + ≈14). This is consistent with the sweep estimates of 40 to 65. Recount after the change against the same ranges.
- **Tests:** add about 120 to 180 lines of unit tests in `composer-selection-settle.test.ts`. These are new coverage, not moved code.
- **Mechanisms:** 2 queues become 1 hook, 2 ordered routines become 1 routine with a 2-field lock policy, and the existing-thread routine loses its handoff branch.
- **Maintenance:** a new execution field, or a change to the settle rules, becomes one edit in one 300-line module with a fast unit test, instead of two edits in two large component files.
- **Performance** (projection, not measured): neutral. The same awaits run in the same order, and nothing is added on the render path. The only render-path change is one closure per render in the thread state builder, where the object literal is already rebuilt every render.
- **Costs:** a new 2-field policy object, and a `changeModel` signature with an optional second argument that only one site uses.

**Execution steps**

1. **Reconfirm.**
   - On current main, run `rg -n 'pendingSelectionRef|const applySelection|const setSelection' apps/app/src` and expect exactly the two composer files.
   - Diff the two `applySelection` bodies again.
   - Check whether RF-099 or RF-088 has landed, and adapt the lock source or the host wiring if so.
   - **Re-plan** if a third `setSelection` implementation now exists, if either routine gained a step the other lacks, or if the plugin SDK contract changed `experimental_setSelection` semantics.
2. **Characterize the uncovered behaviour first**, in `apps/app/src/components/promptbox/composer-selection-settle.test.ts`, against a fake controller. A fake controller is a `createCommittedStateObserver` plus a `commit()` that publishes a new state with `version + 1` on a microtask. Write these tests against the *extracted* functions only after step 3. Before extracting, add one integration test per composer for the queue: in `PluginNewThreadComposer.test.tsx` under `describe("NewThreadComposer setSelection")`, make a first call reject (for example by setting `setComposerSelectionSettleTimeoutForTest(0)` before the composer publishes, so the observer rejects with "This composer is not ready yet."), then assert that a second queued call still applies. Add an equivalent test, or a two-calls-in-order test, in `ThreadDetailPromptArea.test.tsx` near line 2487. Run both on the unchanged code and confirm they pass.
3. **Checkpoint A: mechanical extraction** in `composer-selection-settle.ts`.
   - Add `ExecutionSelectionTarget`, `ComposerSelectionSession`, `openComposerSelectionSession`, `ExecutionSelectionLocks`, `applyExecutionSelection` and `useSerializedComposerSelection`.
   - Copy the body of `applyExecutionSelection` from `NewThreadComposer.tsx:2357-2420` (from the `ensureSettled` on `providerId` through the permission step). Replace `locks.x` with `locks?.x === true`, `state` with `session.state`, and `state.changeModel(selection.model)` with `session.state.changeModel(selection.model, selection.reasoningLevel)`.
   - Import `useCallback` and `useRef` from React, and `PermissionMode`, `ServiceTier` and `ReasoningLevel` (already imported).
4. **Checkpoint B: migrate the new-thread composer.**
   - In `NewThreadComposer.tsx`, rewrite `applySelection` (2303-2427) as described in the end state, keeping the project and environment prelude verbatim on `session`.
   - Replace `pendingSelectionRef` and the `setSelection` block (2301, 2429-2441) with `useSerializedComposerSelection`.
   - Make `NewThreadComposerSelectionState` extend `ExecutionSelectionTarget` and delete the duplicated field declarations.
   - In the state builder (2242-2266), set `changeModel: (model) => handleModelChange(model)`.
   - Remove the now-unused imports `waitForSettledComposerState`, `waitUntilComposerStateSettled`, `readExecutionTuple` and `resolveComposerSelectionDeadline`, and keep any import still used elsewhere in the file. Run the new-thread suite.
5. **Checkpoint C: migrate thread detail.**
   - In `ThreadDetailPromptArea.tsx`, rewrite `applySelection` (1226-1306) and replace the queue (1224, 1308-1320).
   - Make `ThreadComposerSelectionState` extend `ExecutionSelectionTarget`, and drop `isHandoffSelection` and `handoffSelect` from it.
   - In the state builder (1178-1197), replace `changeModel: setSelectedModel, handoffSelect: handleHandoffSelect, isHandoffSelection` with the conditional `changeModel` closure shown above.
   - Remove the unused imports. Run the thread-detail suite.
6. **Add unit tests** for the extracted functions in `composer-selection-settle.test.ts`. Cover:
   - the tuple path, with one `changeExecution` and `settle(true)`;
   - the per-field order, provider → model → reasoning → tier → permission, with the exact `requireSettled` flags (true, false, false, false, false);
   - `ensureSettled` waiting when `isSettled` is false;
   - the model and reasoning steps skipped when the provider was refused;
   - `locks.execution`, which skips the tuple, model, reasoning, tier and permission steps;
   - `locks.provider` with a cross-provider tuple, which falls back to the per-field path, skips the provider change and still applies the tier and permission;
   - `changeModel` receiving `selection.reasoningLevel`;
   - `useSerializedComposerSelection` chaining after a rejection and returning per-call results, tested with `renderHook` or a direct call to the inner chaining helper if you factor one out.
7. **Clean up and check structure.**
   - Confirm that `rg -n 'pendingSelectionRef' apps/app/src` finds nothing.
   - Confirm that `rg -n 'waitForSettledComposerState|waitUntilComposerStateSettled' apps/app/src` finds only the owner module and its tests.
   - Recount the two `applySelection` ranges and the module growth, and report the measured net change against the 238-line baseline.
   - Inspect the full diff for unrelated edits.

**Verification and acceptance criteria**

Commands, from the repository root `$OMNYO_CHECKOUT` or your lane. The script names were read from `apps/app/package.json` and the root `package.json` at the snapshot. The suites were not run for this card, because the snapshot has no `node_modules`.

- Focused tests: `pnpm --filter @omnyo/app exec vitest run --config vitest.config.ts src/components/promptbox/composer-selection-settle.test.ts src/components/plugin/PluginNewThreadComposer.test.tsx src/views/thread-detail/ThreadDetailPromptArea.test.tsx src/components/plugin/plugin-slot-mounts.test.tsx`. The package script `test` is `vitest run --config vitest.config.ts`, so `cd apps/app && pnpm test -- <files>` is equivalent. Expect all tests to pass, including the pre-existing setSelection, handoff, provider-lock and settle-timeout tests, without editing their expectations.
- Typecheck: `pnpm --filter @omnyo/app typecheck` (script `tsc --noEmit && tsc --noEmit -p tsconfig.node.json`).
- Lint and format for the changed files: `pnpm exec oxlint --fix <files>`, `pnpm exec oxfmt <files>`, then `pnpm exec oxlint --deny-warnings --format=agent`. The root has `.oxlintrc.json` and `.oxfmtrc.json`; the package lint script is `oxlint src …`.

Behaviour and contract checks that must hold:

- Both composers: the same final committed `providerId`, `model`, `reasoningLevel`, `serviceTier` and `permissionMode` as before for each existing test input.
- Settle order and flags are unchanged. The new unit test asserts them exactly.
- One deadline per request. The settle-timeout test at `PluginNewThreadComposer.test.tsx:4141` still reports within its bound.
- After a rejected call, the next queued call still runs (the new characterization tests from step 2).
- Lock gating: the provider lock (existing test at `PluginNewThreadComposer.test.tsx:4104`) and the execution lock (new unit test) behave as before.
- Handoff: `ThreadDetailPromptArea.test.tsx:2434` ("starts a handoff when a plugin sets another provider…") and `:2632` ("updates an active handoff with a same-provider model…") pass unchanged.
- `setSelection` identity stays stable across renders. Check by inspection that `useSerializedComposerSelection` wraps it in `useCallback([apply])` and that `apply` depends only on the stable controller.

Structural completion: one queue implementation, one ordered routine, no `pendingSelectionRef` in either composer, and no handoff branch inside the shared routine.

UI and performance: no visual change is expected, and Alex tests UI himself. The manual pickers are untouched. Comparative performance runs are not required, because the await sequence is unchanged by construction. If a reviewer doubts this, compare the number of `commit()` calls per request in the new unit test against the old code path.

**Rollback and stop conditions**

- **Rollback:** the change sits inside one app package with no persisted data and no wire-format change. Revert the commit, or each checkpoint commit (A, B, C) separately.
- **Stop and re-plan if any of these occur:**
  - an existing setSelection, handoff or lock test needs its expectations changed to pass, which means semantics drifted;
  - the two routines turn out to differ in a step this card did not list;
  - a third `setSelection` implementation appears and needs a different policy;
  - the React Compiler (`apps/app/vite-react-compiler.ts`) or a lint rule rejects mutating `session.state`. In that case make `ComposerSelectionSession` a small class, or return the new state from each helper instead of mutating it.
- **Safer smaller alternative:** if the execution routine cannot be shared cleanly, land only `useSerializedComposerSelection` and `openComposerSelectionSession`. These are the byte-identical parts, about 30 lines per site. Leave the ordered steps in each composer.
