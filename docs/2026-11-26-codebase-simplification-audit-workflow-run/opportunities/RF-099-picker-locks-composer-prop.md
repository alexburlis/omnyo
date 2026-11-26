# RF-099 — Replace the per-render four-flag picker locks and their render-phase ref mirror with one `selectionLocked` composer prop

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The central claim holds. The sweep's two-step plan is replaced by one step: a single boolean prop. A plain "move the four-flag object to a prop" (the sweep's Step A) adds a memo-churn hazard and removes almost no code (see the Context section).
- **Potential:** low. The change removes a small state-coordination mechanism in one component, not a subsystem.
- **Confidence:** high for the facts. The line savings are a projection.
- **Readiness:** ready. Partial locks are internal machinery. `NewThreadComposerLocks` is not exported, plugins cannot set locks, and the last production caller of a partial lock (the fork draft) was removed on 2026-10-02. No supported capability is retired. If a reviewer still wants partial locks kept for a planned surface, use the fallback in step 3b; it is still ready.
- **Effort:** about 2 hours, including rewriting two test helpers and adding one regression test.
- **Risk:** low. The realistic regressions are (1) the pending chat composer starts accepting plugin `setSelection` or picker changes, and (2) `setSelection` or `pluginComposerHost` lose referential stability. The verification section checks both.
- **Prerequisites:** none.
- **Related and overlapping:** RF-029 (one selection queue and execution sequence for the new-thread and existing-thread composers). RF-029 edits the same `applySelection` body and explicitly leaves picker locks with each composer. Either order works. Landing RF-099 first leaves RF-029 one early return to keep instead of eleven lock guards. RF-036 and RF-088 touch nearby composer code but not the locks.
- **Why it has a place:** today two sources hold the lock state, the per-render option and a ref written during render. The four independent flags allow 16 lock combinations, but only one (all four set) has a production user, so every new programmatic selection field forces a choice about which flag gates it. The published plugin-SDK documentation still describes a lock combination that no longer exists.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The snapshot worktree no longer existed when this card was written, so every file was read with `git show e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e:<path>` from `$OMNYO_CHECKOUT`. The snapshot has no `node_modules`, so no tests ran. Every claim below is **Proven by inspection** unless it is labelled otherwise.

What the subsystem does. `NewThreadComposer` (`apps/app/src/components/promptbox/NewThreadComposer.tsx:544`) owns the project, environment, provider, model, reasoning, service-tier and permission selection for a chat that does not exist yet. Callers render it with a render-prop child, which calls `renderPromptBox(options)` (`NewThreadComposerState.renderPromptBox`, line 287). Plugins change the selection programmatically through `pluginComposerHost.setSelection`, which queues `applySelection` (lines 2301-2427 and 2429-2441). The new-chat dock's `select` uses the same queue (`dockConfig`, lines 2452-2471).

Current lock mechanism:

- `apps/app/src/components/promptbox/NewThreadComposer.tsx:190-195` "NewThreadComposerLocks" has four optional flags: `project`, `provider`, `environment` and `execution`. The interface is not exported.
- Line 251: `locks?: NewThreadComposerLocks` sits on `NewThreadComposerPromptOptions`, so locks arrive per render, not as a component prop.
- Line 2201: `const pickerLocksRef = useRef<NewThreadComposerLocks>({});`.
- Lines 2521-2522, inside the `renderPromptBox` callback: `const locks = options.locks ?? {}; pickerLocksRef.current = locks;`. The ref is written while the render-prop child (`NewThreadComposerStateRenderer`, line 312) renders, which is a render-phase side effect.
- Asynchronous readers: `applyExecutionTuple` (lines 2203-2240) reads the ref at line 2205 and returns early when `locks.execution || (locks.provider && selection.providerId !== selectedProviderId)`. `applySelection` reads it at line 2324, after its first `await observer.waitUntil`, and guards the project (2327), environment (2342), execution tuple (2363-2365), provider (2375), model (2389), reasoning (2399), service tier (2408) and permission mode (2417).
- Render-time readers in the same callback: environment `disabled` (2585), worktree `disabled` (2602), permission `supported` (2608), `sessionOptionsControl` (2612), `environmentProviderInputsSlot` (2619), `machineProviderInputsSlot` (2622), project `disabled` and `showChevronWhenDisabled` (2674, 2678), execution `disabled` (2691), `favoriteChips` (2699) and provider `onChange` (2704).
- Count: `grep -c "locks\|pickerLocksRef\|NewThreadComposerLocks"` over the snapshot file gives 29 lines; 22 of them read a single flag (`locks\.provider|locks\.project|locks\.environment|locks\.execution`).

Callers. `git grep -nE "locks: \{|locks=\{|locks\?:" e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e -- apps packages plugins` finds one production caller: `apps/app/src/views/thread-detail/PendingThreadChat.tsx:116-121` "PendingThreadChat", which passes an **inline object literal** with all four flags set to `true`. The other two hits are tests: `apps/app/src/components/plugin/PluginNewThreadComposer.test.tsx:1045-1070` "seededEnvironmentElement" (environment-only lock, used at lines 1083 and 1127) and lines 3660-3703 "RootLikeComposer" (provider-only lock, used by the test "keeps a provider-locked composer on its provider and without footer chips" at line 4104). The other `renderPromptBox` callers pass no locks: `apps/app/src/components/new-chat-launcher/LauncherComposer.tsx:82`, `apps/app/src/components/plugin/PluginNewThreadComposer.tsx:88,98` and `apps/app/src/views/RootComposeView.tsx:473,1474`. `git grep -n "NewThreadComposerLocks\|pickerLocks"` over the whole snapshot finds only `NewThreadComposer.tsx`. Nothing in `packages/` or `plugins/` can set locks, because the option lives on an app-internal type.

History (read-only `git log` in the retired private store at `$ARCHIVED_OMNYO_CHECKOUT`):

- `09c811472c` (2026-09-18, "Add useComposer().experimental_setSelection…") added `pickerLocksRef` for a fork-draft composer that locked project, provider and environment but not execution.
- `52ec591958` (2026-10-02, "Create forks eagerly…", #4670) removed that fork-draft `locks: {` caller.
- `d3f75cbb39` (2026-10-20) added the `execution` flag and the fully locked `PendingThreadChat` caller.
- `0fc3d3db4e` (2026-10-21) added the provider-only test helper.

So the partial-lock combinations have had no production user since 2026-10-02.

Stale public documentation. `packages/plugin-sdk/src/app-contract.ts:3442`, in the JSDoc above `setSelection` (line 3483), still says "a fork draft locks its project, provider and environment". No fork-draft composer exists at the snapshot. The only locked composer is the pending chat follow-up composer, and it locks every picker.

Current requirement. While a chat is being created, `PendingThreadChat` shows a follow-up composer. Its project, environment, provider, model, reasoning, service tier, permission mode and session options must not change, whether the user or a plugin tries to change them. `apps/app/src/app.css:1434` hides that composer's footer selection row, and `apps/app/src/views/thread-detail/PendingThreadChat.test.tsx:227` "hides the locked selection row…" encodes this. The lock flags still decide what the prompt box and dock receive, and what `setSelection` does.

Counterevidence and why the sweep's Step A is not adopted as written:

- The render-phase write is benign today. `PendingThreadChat` calls `renderPromptBox` on every render, and locks never change while it is mounted. **No incorrect behavior was reproduced or proven.** The gain is removing a fragile pattern, not fixing a bug.
- `applySelection` deliberately depends only on `[selectionState]`, a stable controller (`apps/app/src/components/promptbox/composer-selection-settle.ts:99-124` "useCommittedComposerState"). That keeps `setSelection`, `dockConfig` and `pluginComposerHost` (lines 2474-2510) referentially stable. If a `locks` **object** prop were added to those dependencies, the inline literal in `PendingThreadChat.tsx:116` would rebuild `setSelection` and `pluginComposerHost` on every `PendingThreadChat` render. That would re-run every plugin composer surface that depends on the host object. The React Compiler (`apps/app/vite-react-compiler.ts`) may or may not memoize that literal; this card does not rely on it. A primitive boolean has no such hazard.

Maintenance cost today. Lock state lives in two places and is only correct after the latest render. Readers must know that the ref is fresh before plugin effects run. Each programmatic selection field needs a choice about which of four flags gates it. The provider-versus-execution interaction (`locks.provider && selection.providerId !== selectedProviderId`) is a rule that only dead combinations exercise.

**Proposed end state and preservation argument**

End state:

- `NewThreadComposerProps` gains `selectionLocked?: boolean` (default `false`), destructured in `NewThreadComposer`.
- `NewThreadComposerLocks`, `NewThreadComposerPromptOptions.locks`, `pickerLocksRef` and the render-phase assignment disappear.
- `applyExecutionTuple` starts with `if (selectionLocked) return;` and lists `selectionLocked` in its dependencies.
- `applySelection` reads the lock from committed state, so its dependencies stay `[selectionState]`. Add `selectionLocked: boolean` to `NewThreadComposerSelectionState` and to the `useCommittedComposerState` builder. After the first `await observer.waitUntil(...)`, a locked composer runs `await settle(true); return readNewThreadComposerSelection(state);`. The remaining body keeps the same order with every `!locks.X` guard removed.
- The render-time sites read the one boolean: `disabled: selectionLocked`, `supported: supportsPermissionModeSelection && !selectionLocked`, `selectionLocked ? null : …`, `showChevronWhenDisabled: !selectionLocked`, `favoriteChips: !selectionLocked` and `onChange: selectionLocked ? undefined : handleProviderChange`.
- `PendingThreadChat` passes `selectionLocked` on `<NewThreadComposer>` and drops the six-line `locks` literal.
- The SDK JSDoc at `packages/plugin-sdk/src/app-contract.ts:3442` replaces the fork-draft clause with a true one, for example "a composer for a chat that is still being created keeps every picker fixed".

Preservation argument (**Proven by inspection** of the snapshot's `applySelection`): with all four flags set, the current `applySelection` skips the project, environment, execution-tuple, provider, model, reasoning, service-tier and permission branches. It only awaits `ensureSettled()` when `selection.providerId` is defined, then `settle(true)`, and returns `readNewThreadComposerSelection(state)`. `ensureSettled` followed by `settle(true)` waits for the same settled condition under the same `deadline` as `settle(true)` alone. The early return therefore produces the same resolved value and the same bounded wait. `applyExecutionTuple` already returns immediately when `locks.execution` is set. Every render-time site receives the same values it gets today under all-true locks. For the unlocked composers (root compose, launcher, plugin composer), `selectionLocked` is `false`, and each guard evaluates exactly as the current `{}` locks do.

Non-goals: no change to the queue, deadline or settle semantics (RF-029 owns those). No change to the pending-chat footer CSS. No change to `ThreadDetailPromptArea`'s own selection path.

Uncertainty. A future surface might want a partial lock. That is speculative, and the fallback in step 3b keeps four flags while still removing the ref and the render-phase write.

**Expected gain and cost**

All figures are projections from the snapshot source, not measurements.

| Item | Before | After (one boolean) |
|---|---|---|
| Lock sources | per-render option plus ref mirror written during render | one component prop, also published in committed state |
| Lock flags | 4 independent (16 combinations, 1 used) | 1 |
| `NewThreadComposer.tsx` lock-related lines | 29 | about 15 |
| `PendingThreadChat.tsx` lock lines | 6 | 1 |
| Production net | — | about −15 to −25 handwritten lines |
| Tests | 2 partial-lock helpers, 1 provider-only behavior test | 1 boolean parameter per helper, 1 rewritten test and 1 new fully locked regression test (roughly net zero) |

The mechanisms that disappear are the render-phase ref write, the dual source of lock state, the four-field interface and the provider-versus-execution lock rule. Performance is neutral: a primitive dependency causes no new memo invalidation. The cost is rewriting the provider-only test, whose same-provider-model-change-while-provider-locked half covers a combination that no longer has a user.

**Execution steps**

1. **Reconfirm.** In the working checkout, run `git grep -nE "locks: \{|locks=\{|locks\?:|pickerLocksRef|NewThreadComposerLocks" -- apps packages plugins` and `git grep -n "renderPromptBox" -- apps`. Re-plan if any new production caller passes a partial lock, if locks reach a plugin or SDK type, or if `applySelection`'s dependencies are no longer `[selectionState]`. If RF-029 has landed, apply the same edits inside its shared queue's new-thread adapter instead.
2. **Missing evidence first.** In `apps/app/src/components/plugin/PluginNewThreadComposer.test.tsx`, add a test for a fully locked composer before changing production code. At the snapshot it would pass `locks: { project: true, environment: true, provider: true, execution: true }`; afterwards it passes `selectionLocked`. The test should assert four things:
   - `currentHost().setSelection!({ projectId: "<other>", providerId: "claude-code", model: "gpt-5.6-sol", permissionMode: "accept-edits" })` resolves to the unchanged selection, and no prompt-box render shows a different provider, model or permission.
   - `latestPromptBoxProps().execution.selection.onChange({...})` leaves the selection unchanged.
   - `execution.disabled`, `project.disabled` and `modeConfig.environment.disabled` are `true`, and `favoriteChips` is `false`.
   - `execution.provider.onChange` is `undefined`.

   Run it once against the unchanged code to confirm that it passes.
3. **Edit `apps/app/src/components/promptbox/NewThreadComposer.tsx`.**
   1. Delete `interface NewThreadComposerLocks` (lines 190-195) and `locks?:` from `NewThreadComposerPromptOptions` (line 251).
   2. Add `selectionLocked?: boolean;` to `NewThreadComposerProps` (line 299) and destructure `selectionLocked = false` in `NewThreadComposer` (line 544).
   3. Add `selectionLocked: boolean;` to `NewThreadComposerSelectionState` (line 199) and `selectionLocked,` to the object built in `useCommittedComposerState(...)` (lines 2242-2266).
   4. Delete `pickerLocksRef` (line 2201). In `applyExecutionTuple`, replace the lock condition with `if (selectionLocked) return;` and add `selectionLocked` to its dependency array.
   5. In `applySelection`, replace `const locks = pickerLocksRef.current;` with `if (state.selectionLocked) { await settle(true); return readNewThreadComposerSelection(state); }`, then remove every `!locks.project`, `!locks.environment`, `!locks.provider` and `!locks.execution` term. Simplify the execution-tuple expression to `requestedTuple`. Keep the dependency array `[selectionState]`.
   6. In `renderPromptBox`, delete lines 2521-2522 and replace each `locks.<flag>` read with `selectionLocked`. Add `selectionLocked` to the `renderPromptBox` `useCallback` dependencies.

   Fallback 3b, used only if a reviewer requires partial locks: keep the four flags, but make `locks` a component prop holding a module-level constant object. Publish its four booleans in `NewThreadComposerSelectionState`, read `state.locks` in `applySelection` and use the four primitives as dependencies elsewhere. This still deletes the ref and the render-phase write.
4. **Edit `apps/app/src/views/thread-detail/PendingThreadChat.tsx`.** Add `selectionLocked` to the `<NewThreadComposer>` element (lines 90-109) and remove the `locks` literal (lines 116-121) from the `renderPromptBox` options. `PendingThreadChat.test.tsx` mocks `NewThreadComposer` and ignores the new prop, so it needs no change.
5. **Tests.** In `PluginNewThreadComposer.test.tsx`:
   - Change `seededEnvironmentElement` (line 1045) to take `selectionLocked: boolean` and pass it as a prop. The call at line 1083 passes `true`; the call at line 1127 passes `false`. The "default worktree inputs when no inputs control mounts" case still works, because a locked composer also nulls `environmentProviderInputsSlot`. Verify that the submission still carries `DEFAULT_BRANCH_INPUTS`.
   - Change `RootLikeComposer` (line 3660) to take `selectionLocked`. Rewrite "keeps a provider-locked composer on its provider and without footer chips" (line 4104) as "keeps a locked composer's execution and hides footer chips": the first half stays, and the same-provider model change now asserts no change. Fold it into the step 2 test where they duplicate.
6. **Docs.** Update the `setSelection` JSDoc clause in `packages/plugin-sdk/src/app-contract.ts:3442`, which is a documentation-only change to a published type. Check `git grep -n "fork draft" -- packages docs` for copies and update them too.
7. **Close out.** Run the verification below. Then `git grep -n "pickerLocksRef\|NewThreadComposerLocks\|locks\." -- apps/app/src/components/promptbox/NewThreadComposer.tsx` must return nothing. Inspect the full diff for unrelated changes. Recount with `grep -c "selectionLocked"` against the 29-line baseline.

**Verification and acceptance criteria**

The script names below are taken from the snapshot's `package.json` files. None of these commands were run, because the snapshot has no `node_modules`.

- Focused tests, from `$OMNYO_CHECKOUT` (the root `test` script is `node scripts/test-modes.mjs dev`, which documents the `--package … -- <files>` form): `pnpm test:dev --package @omnyo/app -- src/components/plugin/PluginNewThreadComposer.test.tsx src/views/thread-detail/PendingThreadChat.test.tsx`. Equivalent, from `apps/app`: `pnpm test src/components/plugin/PluginNewThreadComposer.test.tsx src/views/thread-detail/PendingThreadChat.test.tsx` (the script is `vitest run --config vitest.config.ts`). Expected: all pass, including the new fully locked test.
- Type check, from `apps/app`: `pnpm typecheck`. Expected: no errors. The removal of `locks` from `NewThreadComposerPromptOptions` must surface any caller missed in step 1. Also run `pnpm typecheck` in `packages/plugin-sdk` if its script exists (unconfirmed: check that package's `package.json`).
- Lint and format, from `$OMNYO_CHECKOUT`: `pnpm exec oxlint --fix <changed files>`, then `pnpm exec oxfmt <changed files>`, then `pnpm exec oxlint --deny-warnings --format=agent`.
- Acceptance criteria:
  - Plugin `setSelection` on the pending chat composer resolves with the unchanged selection.
  - The unlocked composers' existing `setSelection` tests still pass. These are the tests around `RootLikeComposer`, from line 3620, which cover ordering, timeout and refusal.
  - `setSelection` and `pluginComposerHost` keep their identity across `PendingThreadChat` re-renders. This follows from the dependency arrays (`applySelection` still depends only on `[selectionState]`, and the other dependencies are primitive). Confirm it by reading the diff.
- Manual check (Alex tests UI himself): start a chat from the home composer and, while it shows "Starting...", confirm that the follow-up composer accepts text, its selection row stays hidden, and sending queues the message.

**Rollback and stop conditions**

- Roll back by reverting the single commit. No persisted data, settings key, route or published API shape changes. The SDK edit is JSDoc only.
- Stop and re-plan in any of these cases:
  - A production caller or plugin path needs a partial lock. Switch to fallback 3b.
  - The fully locked test from step 2 fails against the unchanged code, which would mean the preservation argument is wrong.
  - A plugin-composer test shows `pluginComposerHost` identity churn.
  - RF-029 has restructured `applySelection` in a way that moves the lock check out of this component.
