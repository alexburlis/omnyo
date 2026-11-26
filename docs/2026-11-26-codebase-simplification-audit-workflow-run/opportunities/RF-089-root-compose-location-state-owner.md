# RF-089 — Give the root compose (New thread) router-state contract one typed owner instead of nine ad-hoc readers, an inline duplicate and hand-built writer objects

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplicated knowledge is real, but the sweep overstated two things. First, the two SDK builders (`openNewThread` and `toCompose`) are not near-identical: they deliberately emit different shapes, and one shape is pinned by exact-equality tests, so they can share only the target fields, not one builder. Second, most of the reader code moves rather than disappears; the deleted part is the repeated object guards, the inline duplicate and the duplicated environment/host spreads.
- **Potential:** low-to-medium. The gain is one typed contract for seven router-state keys, not line count.
- **Confidence:** high that the readers, writers and duplicate exist as described (Proven by inspection). Medium on the exact line saving, which is a projection.
- **Readiness:** ready. No owner decision is needed because no key, value or behavior changes.
- **Effort:** S, about half a day including the focused tests.
- **Risk:** low. The realistic regression is a changed key or a changed precedence between `placement`, `sectionId` and `focusPrompt`. Existing exact-shape and reader tests catch most of it.
- **Prerequisites:** none.
- **Related or overlapping:** RF-013 and RF-021 also edit `apps/app/src/views/RootComposeView.tsx` (secondary panel tabs and host commands); RF-029 and RF-099 touch the new-thread composer that consumes this state. None of them changes the location-state contract, so they only conflict textually. Land them in any order and rebase.
- **Why it deserves its place:** about twelve call sites in the app, plus every external plugin through `navigate.toCompose` and `useSidebarThreadActions().openNewThread`, depend on an untyped, single-use contract that only `RootComposeView` understands. Today a new compose intent means editing a component file of several thousand lines and hunting for hand-written objects. The change is cheap and preserves behavior exactly.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The read-only snapshot worktree had already been retired when this card was verified, so every file was read with `git -C $OMNYO_CHECKOUT show e9e1b74c…:<path>`. The snapshot has no `node_modules`, so no test was run; the test evidence below comes from reading the test files.

*How the contract works (Proven by inspection).* Any surface that opens the New thread screen navigates to `getRootComposeRoutePath()` (`/`) with React Router `location.state`. `RootComposeView` reads up to seven keys: `placement`, `sectionId`, `focusPrompt`, `reuseEnvironmentId`, `newEnvironmentHostId`, `initialPrompt` and `replaceInitialPrompt`. It applies them once and then clears them with `navigate(…, { replace: true, state: null })`. This makes them single-use intents. After an initial prompt is applied, the view rewrites the state to `{ focusPrompt: true }`.

*Readers in `apps/app/src/views/RootComposeView.tsx`:*

- `:169` `readSectionIdFromLocationState` (private).
- `:187` `readRootComposeSectionTargetFromLocationState`. A `sectionId` key yields `set` or `clear`; `focusPrompt: true` alone yields `clear`.
- `:207` `shouldStartComposingFromLocationState`.
- `:267` `readReuseEnvironmentIdFromLocationState` (private).
- `:280` `readNewEnvironmentHostIdFromLocationState` (trims the value).
- `:293` `readRootComposeEnvironmentTargetFromLocationState` (a reused environment wins over a host).
- `:307` `hasSingleUseRootComposeTargetState`.
- `:315` `readInitialPromptFromLocationState`.
- `:326` `shouldReplaceInitialPromptFromLocationState`.
- `apps/app/src/lib/thread-creation-placement.ts:11` `readThreadCreationPlacement`. This file stays: `root-compose-selection.ts`, `LegacyProjectComposeRedirect.tsx` and `usePendingChatSubmission.ts` also use its type and `DEFAULT_THREAD_CREATION_PLACEMENT`.
- `RootComposeView.tsx:639-643` `shouldFocusPrompt` is an inline copy of `shouldStartComposingFromLocationState`, character for character in logic.

Each of the eight readers repeats its own `typeof state === "object" && state !== null` guard in one of three different spellings.

*Consumers of the readers:*

- `RootComposeView.tsx:516`, `:556-607`, `:614-637` and `:639-650`.
- Tests: `apps/app/src/views/RootComposeView.test.ts:20-25` and `:422-489`, `:644-680` (import from `./RootComposeView`), and `apps/app/src/hooks/useCreateThreadInEnvironment.test.ts` (imports `shouldStartComposingFromLocationState` and `hasSingleUseRootComposeTargetState`).

*Writers.* Found with `git grep -n 'getRootComposeRoutePath()' e9e1b74c -- apps plugins packages` and `git grep -n -E 'reuseEnvironmentId|newEnvironmentHostId|replaceInitialPrompt|focusPrompt|initialPrompt' e9e1b74c -- apps plugins packages`, excluding tests:

| Site | State written |
|---|---|
| `apps/app/src/lib/plugin-sidebar-hooks.ts:575-604` `openNewThread` (SDK `useSidebarThreadActions`) | always `placement` (defaults to `{ sectionId: options.sectionId ?? null, pinned: false }`, overridden by `experimental_placement`); `focusPrompt: true` only when truthy; `sectionId` when supplied; `reuseEnvironmentId`; trimmed `newEnvironmentHostId` when non-blank |
| `apps/app/src/lib/plugin-sdk-hooks.ts:582-610` `toCompose` (SDK `navigate.toCompose`) | always `focusPrompt: <bool>` (default `false`) and `initialPrompt: <string>` (default `""`); `placement` only when supplied; `reuseEnvironmentId`; trimmed `newEnvironmentHostId` when non-blank; `replaceInitialPrompt: true` and `replace: true` when the Automations plugin leaves its edit route |
| `apps/app/src/hooks/useCreateThreadInEnvironment.ts:24-30` | `focusPrompt`, `reuseEnvironmentId`, `placement` |
| `apps/app/src/views/ToolsView.tsx:307-315` | `focusPrompt`, `initialPrompt`, `replaceInitialPrompt: true` |
| `apps/app/src/components/plugin/PluginsOverview.tsx:210-216` | `focusPrompt`, `initialPrompt`, `replaceInitialPrompt: prompt !== undefined` |
| `apps/app/src/components/settings/AppearanceSettingsPage.tsx:451-456` | `focusPrompt`, `initialPrompt` |
| `apps/app/src/components/sidebar/ProjectRail.tsx:569-571`, `apps/app/src/components/layout/AppLayout.tsx:705-707`, `RootComposeView.tsx:626-629` | `{ focusPrompt: true }` |
| `apps/app/src/views/LegacyProjectComposeRedirect.tsx:24-27` | forwards the incoming `location.state` unchanged |

Other `getRootComposeRoutePath()` callers (for example `useQuickCreateProject.tsx:93`, `ProjectActionsProvider.tsx:123`, `ThreadActionsProvider.tsx:354/523/529` and `resource-route-owner.ts`) pass no state.

*Plugin boundary (Proven by inspection).* First-party plugins call only the SDK methods. They never import app code and never build router state:

- `plugins/thread-list/app/list/ProjectList.tsx:1594` and `ProjectRow.tsx:993` call `navigate.toCompose` with `placement` and `focusPrompt`.
- `plugins/automations/app.tsx:501` and `:565` call it with `focusPrompt` and `initialPrompt`.
- `apps/app/src/lib/thread-actions/core-thread-actions.ts:345` also uses `toCompose`.

The public shapes are `packages/plugin-sdk/src/app-contract.ts:1746` `openNewThread(options?)` and `:4265` `toCompose(options?)`. A search for `-w openNewThread` found no first-party production caller of the sidebar `openNewThread`. It is still a published SDK method, so external plugins may call it, and it must stay exactly as it is.

*Tests that pin builder output.*

- `apps/app/src/lib/plugin-sidebar-hooks.test.tsx:1174-1283` asserts the exact objects `openNewThread` passes to `navigate`, using `toHaveBeenCalledWith`. That includes the redundant `sectionId` key and the always-present `placement`.
- `apps/app/src/lib/app-route-history.test.tsx:147` drives `toCompose` through the route-history flow.
- No unit test asserts the exact state object `toCompose` emits. That gap matters for this change.

*Counterevidence and current requirement.* The two SDK builders differ on purpose:

- `openNewThread` always writes `placement`, because its documented contract is "omitting placement … previous composer placement is cleared". This makes every call a single-use target.
- `toCompose` writes `placement` only when it is given. Its `focusPrompt: false` and `initialPrompt: ""` defaults are read as absent. So a bare `toCompose()` does not reset the composer's placement.

Merging them into one builder with one policy would change SDK behavior. The plan therefore shares only the field encoders.

*Line counts.* Non-blank lines, counted with `sed -n <range>p <file> | grep -c .` on the snapshot copies:

| Code | Non-blank lines |
|---|---|
| Readers at `RootComposeView.tsx:169-213` | 34 |
| Readers at `RootComposeView.tsx:267-335` | 55 |
| Inline duplicate at `:639-643` | 5 |
| `openNewThread` state builder at `plugin-sidebar-hooks.ts:582-603` | 21 |
| `toCompose` state builder at `plugin-sdk-hooks.ts:588-610` | 22 |
| `thread-creation-placement.ts` (stays) | 29 |

*Maintenance cost today.* The contract has no type. Its key names are string literals repeated in about twelve places. Its precedence rules can only be learned by reading the effect at `RootComposeView.tsx:556-607`:

- `placement` beats `sectionId`.
- `focusPrompt` alone clears the section.
- `reuseEnvironmentId` beats `newEnvironmentHostId`.

Its readers also live inside a large view component, so tests and `useCreateThreadInEnvironment.test.ts` must import the whole view module just to check a parser.

**Proposed end state and preservation argument**

Create `apps/app/src/lib/root-compose-location-state.ts` as the single owner. `lib/` is the right home because the two SDK builders already live in `lib/`; `lib` importing from `views` would invert the layering. The module should contain:

```ts
import { readThreadCreationPlacement, type ThreadCreationPlacement } from "./thread-creation-placement";

/** Single-use router state read by RootComposeView. Every key is optional. */
export interface RootComposeLocationState {
  placement?: ThreadCreationPlacement;
  /** Kept for compatibility: an explicit section with no placement. */
  sectionId?: string;
  focusPrompt?: boolean;
  reuseEnvironmentId?: string;
  newEnvironmentHostId?: string;
  initialPrompt?: string;
  replaceInitialPrompt?: boolean;
}

export type RootComposeSectionTarget = { kind: "clear" } | { kind: "set"; sectionId: string };
export type RootComposeEnvironmentTarget =
  | { kind: "reuse"; environmentId: string }
  | { kind: "host"; hostId: string };

/** Shared encoding of the environment target used by both SDK builders. */
export function rootComposeEnvironmentTargetState(options: {
  environmentId?: string;
  hostId?: string;
}): Pick<RootComposeLocationState, "reuseEnvironmentId" | "newEnvironmentHostId">;
```

The rules of `rootComposeEnvironmentTargetState`:

- `reuseEnvironmentId` is set when `environmentId !== undefined`. Both builders use exactly this test today, so an empty string is passed through.
- `newEnvironmentHostId` is set to `hostId.trim()` when the trimmed value is non-empty.
- Both keys may be present. The reader decides precedence. Do not make the encoder drop `newEnvironmentHostId` when an environment is given, because both builders currently write both keys.

Move into this module unchanged in semantics:

- `readRootComposeSectionTargetFromLocationState`, `shouldStartComposingFromLocationState`, `readNewEnvironmentHostIdFromLocationState`, `readRootComposeEnvironmentTargetFromLocationState`, `hasSingleUseRootComposeTargetState`, `readInitialPromptFromLocationState` and `shouldReplaceInitialPromptFromLocationState`.
- The private `readSectionIdFromLocationState` and `readReuseEnvironmentIdFromLocationState`.

They should share one private `asStateRecord(state: unknown): Record<string, unknown> | null` guard instead of eight hand-written guards. Keep the exported names, because the tests and effects read clearly with them. Do not add a re-export from `RootComposeView.tsx`; update the imports instead.

What disappears:

- The eight duplicated object guards (three spellings).
- The inline `shouldFocusPrompt` duplicate (`RootComposeView.tsx:639-643`, which becomes a call).
- The two copies of the environment/host spread and trim in `openNewThread` and `toCompose`.
- The dead `Object.keys(state).length > 0 ? { state } : undefined` conditional in `openNewThread` (`plugin-sidebar-hooks.ts:600-603`). `state` always has `placement`, so the condition is always true and the call becomes `navigate(getRootComposeRoutePath(), { state })`. This is behavior-identical.
- The untyped literals at the writers: each writer annotates its object as `RootComposeLocationState`, with `satisfies` or a typed local.

What remains on purpose:

- Each SDK builder keeps its own policy lines: `openNewThread` always writes `placement` and conditionally `focusPrompt` and `sectionId`; `toCompose` writes `focusPrompt` and `initialPrompt` defaults, optional `placement` and the Automations `replaceInitialPrompt`.
- The simple `{ focusPrompt: true }` writers stay literal, just typed.
- `thread-creation-placement.ts` keeps `readThreadCreationPlacement` and `DEFAULT_THREAD_CREATION_PLACEMENT` for its other consumers.

Why this preserves behavior:

- Every key, value, default and precedence rule is kept.
- The SDK contracts in `packages/plugin-sdk/src/app-contract.ts` do not change, so no SDK version bump and no plugin change is needed.
- The UI states are unchanged: placement seeding, environment seeding, host selection waiting for `hostSelectionReady`, the initial-prompt replace versus restore-if-empty choice, prompt focus on non-coarse pointers, and the single-use clearing navigations.

Non-goals:

- Do not drop the redundant `sectionId` key that `openNewThread` writes, or the `set` branch of `RootComposeSectionTarget`. `openNewThread` always also writes `placement`, so the key only takes effect when `readThreadCreationPlacement` rejects that placement, for example `sectionId: ""` or whitespace. In that case it still turns the state into a single-use `clear` target. Removing it would change that edge case and the exact-shape tests, so it is a separate decision.
- Do not change the incidental placement-loss behavior described in newIssues (a `placement` sent together with `initialPrompt` is overwritten by the follow-up `{ focusPrompt: true }` pass). Fix that separately, with its own test.
- Do not touch the `?initialPrompt=` search-param path (`apps/app/src/views/root-compose-initial-prompt.ts`), which is a different, URL-addressed contract used by mobile share intents.

**Expected gain and cost**

These figures are projections, not measurements:

- About 89 non-blank reader lines move to the new module and shrink to about 60–70 once they share one guard.
- The inline duplicate goes from 5 lines to 1.
- The two builders lose about 8 duplicated lines in total.
- The new type and encoder add about 20 lines.
- Net: about 10–30 fewer handwritten production lines.
- Test files change imports only, a few lines.

The real gain is structural:

- One file names every key and its precedence.
- Every writer is type-checked against that file, so a misspelled key or a wrong value type becomes a `tsc` error instead of a silent no-op.
- Adding an intent, such as a preselected provider, becomes one type field, one reader and one writer change.

Cost: one new module and an import change in roughly ten files. Performance should not change, because the readers are the same constant-time property reads, but this was not measured.

**Execution steps**

1. **Reconfirm.**
   - Check out a branch from current main.
   - Confirm that the readers still sit in `apps/app/src/views/RootComposeView.tsx` and the builders at `plugin-sidebar-hooks.ts` `openNewThread` and `plugin-sdk-hooks.ts` `toCompose`.
   - Rerun `git grep -n -E 'reuseEnvironmentId|newEnvironmentHostId|replaceInitialPrompt|focusPrompt: |initialPrompt: ' -- apps plugins packages` and `git grep -n 'getRootComposeRoutePath()' -- apps`. Add any new writer to the list.
   - Re-plan if any of these holds: a plugin or package outside `apps/app` builds this state directly, the SDK `toCompose` or `openNewThread` signature changed, or a new key appeared.

2. **Close the one test gap first.**
   - In a new or existing test file next to `plugin-sdk-hooks.ts`, add an exact-shape characterization of the object `toCompose` passes to `navigate`. Check how `plugin-sidebar-hooks.test.tsx` mocks `navigate` and copy that setup.
   - Cover four cases: `toCompose()` gives `{ focusPrompt: false, initialPrompt: "" }`; `toCompose({ placement, environmentId: "env_1", hostId: " host_a " })` gives both target keys, with the host trimmed; `toCompose({ hostId: "  " })` omits `newEnvironmentHostId`; and the Automations edit-route case adds `replaceInitialPrompt: true` and `replace: true`.
   - Run it green against the unchanged code before any edit. This is the independent baseline for the refactor.

3. **Mechanical move (checkpoint A).**
   - Create `apps/app/src/lib/root-compose-location-state.ts` and move the nine reader functions and the `RootComposeSectionTarget` type into it, keeping each body unchanged for now.
   - Import them in `RootComposeView.tsx`, and drop its now-unused `readThreadCreationPlacement` import if nothing else uses it.
   - Point the imports in `RootComposeView.test.ts` and `useCreateThreadInEnvironment.test.ts` at the new module.
   - Run the focused tests. They must pass unchanged.

4. **Consolidate the readers (checkpoint B).**
   - Add the private `asStateRecord` guard and rewrite each reader body on top of it. Keep the exact return values: trimming only where it is done today (`sectionId`, `newEnvironmentHostId`); no trimming of `reuseEnvironmentId` or `initialPrompt`; strict `=== true` for `focusPrompt` and `replaceInitialPrompt`; and non-empty-string checks.
   - Replace `shouldFocusPrompt` at `RootComposeView.tsx:639-643` with `shouldStartComposingFromLocationState(location.state)`.
   - Run the focused tests.

5. **Type and share the writers (checkpoint C).**
   - Export `RootComposeLocationState` and `rootComposeEnvironmentTargetState`.
   - In `openNewThread`, replace the two environment/host spreads with `...rootComposeEnvironmentTargetState(options ?? {})`. Keep `placement`, `focusPrompt` and `sectionId` as they are, and use `navigate(getRootComposeRoutePath(), { state })`.
   - Do the same in `toCompose`, keeping `focusPrompt`/`initialPrompt` defaults, optional `placement`, and the `replaceInitialPrompt` and `replace` handling. Key order in the emitted object does not matter to `toHaveBeenCalledWith`, but keep it anyway for readable diffs.
   - Type the literals in `useCreateThreadInEnvironment.ts`, `ToolsView.tsx`, `PluginsOverview.tsx`, `AppearanceSettingsPage.tsx`, `ProjectRail.tsx`, `AppLayout.tsx` and `RootComposeView.tsx:628` as `RootComposeLocationState`, using `satisfies`.
   - Run the focused tests and `tsc`.

6. **Clean up.**
   - Make sure no copy of a reader is left in `RootComposeView.tsx`.
   - Add a short doc comment on `RootComposeLocationState` stating the precedence rules and that the state is single-use.
   - Inspect the whole diff for unrelated edits.
   - Recount with the same `grep -c .` method on the same ranges or files, and report the measured net change.

**Verification and acceptance criteria**

Commands (run from `$OMNYO_CHECKOUT` or the lane root after `pnpm install`):

- `pnpm --filter @omnyo/app exec vitest run --config vitest.config.ts src/views/RootComposeView.test.ts src/lib/plugin-sidebar-hooks.test.tsx src/hooks/useCreateThreadInEnvironment.test.ts src/lib/app-route-history.test.tsx src/lib/thread-creation-placement.test.ts src/lib/root-compose-selection.test.tsx`, plus the new `toCompose` characterization test. The `test` script (`vitest run --config vitest.config.ts`) is confirmed in `apps/app/package.json`. Passing explicit file filters to it was not run here because the snapshot has no `node_modules`.
- `pnpm --filter @omnyo/app typecheck`. The script is confirmed in `apps/app/package.json`: `tsc --noEmit && tsc --noEmit -p tsconfig.node.json`.
- `pnpm --filter @omnyo/app lint`, a confirmed script. Then run the repository formatter on the changed files: `pnpm exec oxfmt <files>` (root `format` script confirmed as `oxfmt .`).
- Optionally, `pnpm --filter omnyo-plugin-thread-list test`, which is confirmed in `plugins/thread-list/package.json`. It only proves that the plugins still compile against the unchanged SDK.

Acceptance:

- The behavior and contract tests pass without any change to expected values. In particular, the `plugin-sidebar-hooks.test.tsx:1174-1283` exact-shape assertions and the new `toCompose` characterization test pass unchanged. Do not edit expected objects to make the refactor pass.
- The structure is complete: `git grep -n -E '"focusPrompt" in|"replaceInitialPrompt" in|reuseEnvironmentId\?: unknown' -- apps/app/src` matches only `apps/app/src/lib/root-compose-location-state.ts`. `RootComposeView.tsx` exports no `*LocationState` reader. Every root-compose writer object is typed against `RootComposeLocationState`.
- No public surface changes: `git diff -- packages/plugin-sdk` is empty.
- Manual UI check (Alex tests UI changes himself; list these for him):
  - "New thread in environment" from the thread metadata panel opens with that environment and section.
  - The Thread list "+" on a section opens the composer in that section, pinned when the section is pinned.
  - Plugins → Create plugin seeds the prompt.
  - Automations → Edit via chat replaces the draft and Back does not bounce.
  - The project rail context menu "New thread" focuses the prompt on desktop but not on touch.

**Rollback and stop conditions**

Rollback: the change touches only app-internal code and has no persisted data. Router state is transient and is cleared on use, so reverting the commit is enough. Stop and re-plan in any of these cases:

- An exact-shape test, or the new `toCompose` characterization test, can only pass by changing expected values. That means the shared encoder changed the SDK output.
- A writer outside `apps/app` is found that constructs this state directly, for example a plugin that bypasses the SDK.
- A concurrent change (RF-013, RF-021, RF-029) has restructured the `RootComposeView` effects so that the readers are no longer called the way described above.
- Someone wants to drop the redundant `sectionId` key or fix the placement-loss issue inside this change. Both are behavior changes and need their own card or issue with tests.

If the shared encoder proves awkward, a safer, smaller alternative is to stop after checkpoint B (move, consolidate the readers and type the writers) and leave the two builders' spreads in place.
