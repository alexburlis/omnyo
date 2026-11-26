# RF-087 — Replace the three single-command thread keyboard handlers and the menu's separate action-to-command map with one table and one handler

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** Adjusted. The duplication is real and the plan is safe. The sweep's estimate was slightly high, the plan needed to name a hazard in how entries are matched (match by key, never by index), and the sweep missed two references: the one-time rename script and the API audit doc.
- **Potential:** Low to medium. This is a small change. Its value is that each core thread action's keyboard command is declared once, not the line count.
- **Confidence:** High. Every anchor below was re-read at the snapshot (Proven by inspection).
- **Readiness:** Ready.
- **Effort:** Small, about 2 hours including test re-pointing.
- **Risk:** Low. The main hazard is a positional lookup into the filtered entry list (see the preservation argument). The existing tests catch it.
- **Prerequisites:** None.
- **Related or overlapping RF ids:** RF-012 (retire the one-time BB-to-Omnyo source rename tooling) owns `scripts/omnyo-renderer-map.mjs`, which lists the three handler files by path. Whichever change lands second drops the stale entries, or RF-012 deletes the whole file. No other RF touches these files. RF-021 and RF-013 work on other command handlers in thread detail but do not overlap.
- **Why it deserves its place:** Adding a keyboard command for another core action, such as delete or pin, today takes a new component file, a new mount and import in `ThreadDetailView`, and a separate row in the menu map. After this change it takes one table row. The change also removes three identical copies of the focus guard and run-and-return logic. It ranks low on volume.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The four handler, menu and test files are byte-identical at local `main` `5f2d3f895` (checked with `git diff --stat 5f2d3f895 e9e1b74c -- <files>`, no output).

The subsystem: the web app (`apps/app`) has a registry of thread actions. Core actions have keys such as `omnyo--core/archive`, and plugins can register more. Every thread menu renders these actions. Some core actions also have keyboard commands (`KeyboardCommandId` values in `packages/domain/src/app-keybindings.ts:61-64`). When a command fires in the thread detail view, the app runs the same registered action that the menu shows. The menu shows each command's current shortcut beside its action.

Observed facts (Proven by inspection):

- `apps/app/src/components/thread/ThreadActionsMenu.tsx:48-53` "THREAD_ACTION_COMMANDS" is a `ReadonlyMap<string, KeyboardCommandId>` with four rows: `omnyo--core/copyLink` maps to `thread.copyLink`, `omnyo--core/shelve` to `thread.shelve`, `omnyo--core/archive` to `thread.archive` and `omnyo--core/rename` to `thread.rename`. Line 55 "THREAD_ACTION_COMMAND_IDS" spreads its values. Lines 59-75 "useThreadActionShortcuts" turn them into a key-to-label map, returning `NO_SHORTCUTS` for drawers. `ThreadActionMenuItems.tsx:298` reads labels with `shortcuts.get(entry.key)`. `KeyboardCommandId` (import at line 12) is used only by this map.
- Three handler components repeat the same key and command:
  - `apps/app/src/views/thread-detail/ThreadArchiveCommandHandler.tsx` (27 lines) "ThreadArchiveCommandHandler": `ARCHIVE_KEYS = ["omnyo--core/archive"]`, `useAppCommandHandler("thread.archive", …)`, which returns false when `!isFocused || thread.archivedAt !== null || archive === undefined`.
  - `apps/app/src/views/thread-detail/ThreadShelveCommandHandler.tsx` (25 lines) "ThreadShelveCommandHandler": `SHELVE_KEYS`, `thread.shelve`, which returns false when `!isFocused || shelve === undefined`.
  - `apps/app/src/views/thread-detail/ThreadCopyLinkCommandHandler.tsx` (25 lines) "ThreadCopyLinkCommandHandler": `COPY_LINK_KEYS`, `thread.copyLink`, with the same guard.
  - Each one calls `usePaneContext()` and `useThreadActionEntries(thread, { keys })`, then calls `void entry.action.run()` and returns true.
- They are mounted only at `apps/app/src/views/thread-detail/ThreadDetailView.tsx:3722-3724`, with imports at lines 342-344, all receiving `threadActionTarget` (built at line 3034).
- `thread.rename` is handled separately at `apps/app/src/views/thread-detail/ThreadDetailHeader.tsx:167-172` with the header's `requestRename(threadId)`. It does not run the registry entry. This is intentional, because the header owns the inline rename UI.
- `apps/app/src/components/commands/AppCommandProvider.tsx:553` "useIndexedAppCommandHandlers(commands, handler(index, invocation), priority, enabled, isAvailable)" registers one handler per command in a single effect. `useAppCommandHandler` (line 534) is a one-element wrapper around it. The `commands` array must be referentially stable, because it is an effect dependency, so it must be a module constant.
- `apps/app/src/lib/thread-actions/thread-action-registry.tsx:517-541` "evaluateThreadActions" filters by `keys` and **drops records whose item returns null**. Line 543 "useThreadActionEntries" subscribes to one external store and retains the thread id once per call through a ref count (lines 180-245). `useData` hooks run in the collectors, not inside `useThreadActionEntries`, so changing how many keys one call passes has no hook-order effect.
- Why the archive guard exists: `apps/app/src/lib/thread-actions/core-thread-actions.ts:471-498`, the `archive` registration, labels itself "Unarchive" and unarchives when `thread.archivedAt !== null`. The keyboard command's description is "Archive the focused thread." (`apps/app/src/lib/app-command-metadata.ts:64-68`), so the shortcut must not unarchive. Shelve is a deliberate toggle: its description at lines 69-73 is "Move the focused thread to the Shelf, or bring it back.", and its item returns null for sub-chats (`core-thread-actions.ts:446-457`).
- Default bindings at `apps/server/src/services/system/app-keybindings.ts:203-212`: rename and archive are unassigned, shelve is Mod+Shift+F and copyLink is Mod+Shift+C.

Consumers and searches:

- `git grep -n -E 'Thread(Archive|Shelve|CopyLink)CommandHandler|THREAD_ACTION_COMMANDS|"thread\.(archive|shelve|copyLink|rename)"' e9e1b74c -- . ':!*.md'` over the whole repository found these app consumers: the menu, the three handlers, `ThreadDetailView`, `ThreadDetailHeader` and tests. The other hits are unrelated host-daemon and server command types that share the same strings: `thread.rename` and `thread.archive` in `packages/host-daemon-contract` and in `apps/server` wake policy. Those are daemon command types, not keyboard commands, and stay out of scope.
- Non-obvious consumer the sweep missed: `scripts/omnyo-renderer-map.mjs:19-26` "coreActionFiles" lists the three handler paths. It is used only as a set-membership test (lines 335, 393, 412) while the one-time BB-to-Omnyo renderer rename runs over `collectSourceBindings` files. A missing path is harmless, but it becomes a stale reference. This script belongs to RF-012.
- Docs: `docs/api_to_audit.md:4238-4241` describes which keyboard commands run which core actions (still true after the change). `docs/api_to_audit.md:4262` names `ThreadArchiveCommandHandler` and `ThreadShelveCommandHandler` as core callers and needs the new name.
- No plugin, SDK, plugin-SDK export, CLI, persisted setting, migration or desktop or mobile build references the component names. The components are not exported from any package (they live under `apps/app/src/views`). Persisted keybinding overrides use the command ids (for example `apps/server/test/services/plugins/omnyo-plugin-state.test.ts:70`), and those ids do not change.

Tests that encode the contract:

- `apps/app/src/views/thread-detail/ThreadCommandHandlers.test.tsx` covers: archive follows focus across two split panes; no pane focused does nothing; an archived thread does nothing; shelve runs for a top-level thread and returns handled; a sub-chat leaves Mod+Shift+F unhandled (`pressShortcut` returns true); copyLink copies with a toast; an unfocused pane leaves copyLink unhandled.
- `apps/app/src/components/thread/ThreadActionsMenu.test.tsx:833-870` "shows the effective shortcut beside core actions on desktop menus only" covers the shortcut labels, including the empty Rename label.

Limit: the snapshot has no `node_modules`, so no test was run for this audit. All claims are from source and test inspection.

Maintenance cost today: the key-to-command binding is written twice (the menu map plus a constant and a literal in each handler). The guard and run logic is copied three times. Every new command needs a new component, an import and a mount.

**Proposed end state and preservation argument**

What remains, and who owns it:

1. A new module, `apps/app/src/lib/thread-actions/thread-action-commands.ts`, owns the one table:

   ```ts
   import type { KeyboardCommandId } from "@omnyo/domain";
   import type { PluginThreadActionTarget } from "@omnyo/plugin-sdk";

   export interface ThreadActionCommand {
     readonly key: string;
     readonly command: KeyboardCommandId;
     /** False when another owner handles the command (rename: ThreadDetailHeader). */
     readonly runsAction: boolean;
     /** The command does nothing for this thread although the action exists. */
     readonly isBlocked?: (thread: PluginThreadActionTarget) => boolean;
   }

   export const THREAD_ACTION_COMMANDS: readonly ThreadActionCommand[] = [
     { key: "omnyo--core/copyLink", command: "thread.copyLink", runsAction: true },
     { key: "omnyo--core/shelve", command: "thread.shelve", runsAction: true },
     {
       key: "omnyo--core/archive",
       command: "thread.archive",
       runsAction: true,
       // The core action unarchives archived threads; the command only archives.
       isBlocked: (thread) => thread.archivedAt !== null,
     },
     { key: "omnyo--core/rename", command: "thread.rename", runsAction: false },
   ];
   ```

2. `ThreadActionsMenu.tsx` "useThreadActionShortcuts" reads the same table. It builds `THREAD_ACTION_COMMAND_IDS` with `THREAD_ACTION_COMMANDS.map((row) => row.command)` and loops `for (const { key, command } of THREAD_ACTION_COMMANDS)`. Labels stay keyed by action key, so all four rows, rename included, keep their labels exactly as today.

3. One component, `apps/app/src/views/thread-detail/ThreadActionCommandHandlers.tsx` "ThreadActionCommandHandlers({ thread })", replaces the three:

   ```tsx
   const RUNNABLE = THREAD_ACTION_COMMANDS.filter((row) => row.runsAction);
   const RUNNABLE_KEYS = RUNNABLE.map((row) => row.key);
   const RUNNABLE_COMMANDS = RUNNABLE.map((row) => row.command);

   export function ThreadActionCommandHandlers({ thread }: { thread: PluginThreadActionTarget }) {
     const { isFocused } = usePaneContext();
     const entries = useThreadActionEntries(thread, { keys: RUNNABLE_KEYS });

     useIndexedAppCommandHandlers(RUNNABLE_COMMANDS, (index) => {
       const row = RUNNABLE[index];
       const entry = entries.find((candidate) => candidate.key === row.key);

       if (!isFocused || entry === undefined || row.isBlocked?.(thread) === true) {
         return false;
       }

       void entry.action.run();

       return true;
     });

     return null;
   }
   ```

   `ThreadDetailView.tsx` mounts it once, in place of lines 3722-3724.

4. `ThreadDetailHeader.tsx:167` keeps its own `useAppCommandHandler("thread.rename", …)`. Its row in the table (`runsAction: false`) records that the header handles the command, so the table stays complete. Importing the table into the header just to read one string would add coupling without removing knowledge, so that is a non-goal.

What disappears: the three handler files, their three key constants, three copies of the guard, the menu's private `Map` and its `KeyboardCommandId` import, and two of the three imports and mounts in `ThreadDetailView`.

Preservation argument, for each behavior:

- **Focus guard.** Each pane still registers one handler per command, and the handler returns false when the pane is not focused, so the next registered handler can run. The order of registrations between panes is unchanged: one registration per command per pane, in mount order, at priority 0.
- **Match by key, not by index (the main hazard).** `useThreadActionEntries` drops entries that are missing or null. For a sub-chat, shelve's item returns null, so `entries` is `[copyLink, archive]`. A positional lookup `entries[index]` would make Mod+Shift+F archive a sub-chat. The handler must look entries up with `entries.find((e) => e.key === row.key)`. The existing test "leaves the shortcut unhandled for a sub-chat" fails if the lookup is positional: archive would run and the key event would count as handled.
- **Archive no-op on archived threads.** The archive row's `isBlocked` reproduces `thread.archivedAt !== null`. The existing test "does nothing when the focused thread is archived" covers it.
- **Shelve toggle.** Shelve has no block, so it still toggles as today.
- **Unhandled fall-through.** Returning false when the entry is missing still lets other handlers and the browser default run (covered by the `pressShortcut` return-value assertions).
- **Availability.** None of the three handlers passes `isAvailable` today, so availability stays the default `true`. Do not pass one now: that would change command-palette availability, which is out of scope.
- **Shortcut labels.** They are derived from the same rows with the same keys, so the output is unchanged (covered by `ThreadActionsMenu.test.tsx:833`).
- **Performance.** There is one `useSyncExternalStore` subscription and one thread-id retain per mounted thread detail instead of three, and the same three records are evaluated. Hypothesis: neutral to slightly cheaper. No measurement exists, and this is not a performance-sensitive path.

Non-goals: moving rename to the action registry; adding commands for other actions; changing default bindings; hiding the archive shortcut label on "Unarchive" rows (recorded as an incidental issue instead).

**Expected gain and cost**

Line counts below are measured at the snapshot with `git show e9e1b74c:<path> | wc -l`. The replacement sizes are projections based on the drafts above.

| Item | Before | After (projected) |
|---|---|---|
| Handler files | 3 files, 77 lines | 1 file, about 30 lines |
| Table | 8 lines in `ThreadActionsMenu.tsx:48-55` | 1 module, about 25 lines (adds `runsAction` and `isBlocked`) |
| `ThreadDetailView` imports and mounts | 6 lines | 2 lines |
| Declarations of key-to-command | 2 (menu map plus each handler) | 1 |
| Copies of guard and run logic | 3 | 1 |
| `useThreadActionEntries` subscriptions per thread detail | 3 | 1 |

- **Net handwritten production lines:** about 25 to 35 fewer (91 lines removed against about 57 to 62 added). This is a projection, slightly below the sweep's 30-40 estimate, because the table gains two fields.
- **Tests:** `ThreadCommandHandlers.test.tsx` re-points one import and four mounts, with a net change of a few lines. Adding one assertion is recommended (see Verification).
- **Docs:** a one-line name update in `docs/api_to_audit.md:4262`.
- **Script:** `scripts/omnyo-renderer-map.mjs:21-23` loses three stale path strings, unless RF-012 has already deleted the file.
- **Causal maintenance gain:** a new core-action keyboard command becomes one table row instead of a new component, a mount and a separate menu row. The archive guard's reason sits beside its row.
- **Cost:** the `runsAction` flag is a small extra concept. It is needed because rename is handled by its own owner.

**Execution steps**

1. **Reconfirm the anchors.** On your base, re-read `ThreadActionsMenu.tsx` "THREAD_ACTION_COMMANDS", the three handler files, `ThreadDetailView.tsx` (search `ThreadArchiveCommandHandler`), `ThreadDetailHeader.tsx` (search `"thread.rename"`) and `AppCommandProvider.tsx` "useIndexedAppCommandHandlers". Stop and re-plan if any of these hold:
   - a handler gained different behavior (a non-default priority, `isAvailable`, an extra guard);
   - a fourth handler was added;
   - the handlers are mounted anywhere other than `ThreadDetailView`;
   - `useThreadActionEntries` now returns entries in a different form;
   - `useIndexedAppCommandHandlers` changed its signature.

   Run `rg -n "Thread(Archive|Shelve|CopyLink)CommandHandler" /path/to/checkout --glob '!node_modules'` to list every reference.
2. **Baseline.** In `apps/app`, run the two focused test files (see Verification) and record that they pass before you edit anything.
3. **Add the table.** Create `apps/app/src/lib/thread-actions/thread-action-commands.ts` with "ThreadActionCommand" and "THREAD_ACTION_COMMANDS" as drafted, in the same order as the current map (copyLink, shelve, archive, rename).
4. **Point the menu at the table.** In `ThreadActionsMenu.tsx`:
   - delete lines 48-53 and the now-unused `KeyboardCommandId` import at line 12;
   - import `THREAD_ACTION_COMMANDS`;
   - set `THREAD_ACTION_COMMAND_IDS = THREAD_ACTION_COMMANDS.map((row) => row.command)`;
   - change the loop in "useThreadActionShortcuts" to destructure `{ key, command }`.

   Checkpoint: run `ThreadActionsMenu.test.tsx`.
5. **Add the merged handler.** Create `apps/app/src/views/thread-detail/ThreadActionCommandHandlers.tsx` as drafted. It imports `useIndexedAppCommandHandlers` from `@/components/commands/AppCommandProvider`, `useThreadActionEntries` from `@/lib/thread-actions/thread-action-registry` and `usePaneContext` from `./PaneContext`. Keep `RUNNABLE`, `RUNNABLE_KEYS` and `RUNNABLE_COMMANDS` at module scope so they are referentially stable. Look entries up by key.
6. **Swap the mount.** In `ThreadDetailView.tsx`, replace the three imports (lines 342-344) with one import, and the three mounts (lines 3722-3724) with `<ThreadActionCommandHandlers thread={threadActionTarget} />`.
7. **Delete the old handlers.** Delete `ThreadArchiveCommandHandler.tsx`, `ThreadShelveCommandHandler.tsx` and `ThreadCopyLinkCommandHandler.tsx` (clean tracked files).
8. **Re-point the tests.** In `ThreadCommandHandlers.test.tsx`:
   - replace the three imports with `ThreadActionCommandHandlers`;
   - mount it in `SplitHandlers` (both panes) and in `FocusedShelveHandler` (once, replacing the shelve and copyLink pair);
   - keep every existing assertion unchanged;
   - add `expect(mocks.requestArchive).not.toHaveBeenCalled()` to "leaves the shortcut unhandled for a sub-chat". Now that all three commands share one handler, this assertion pins the match-by-key rule directly.
9. **Remove the leftover references.**
   - In `scripts/omnyo-renderer-map.mjs` "coreActionFiles", remove the three deleted paths. Skip this if RF-012 has deleted the script. Do not add the new files: the BB-to-Omnyo rewrite is finished.
   - In `docs/api_to_audit.md:4262`, replace `ThreadArchiveCommandHandler`, and `ThreadShelveCommandHandler` with `ThreadActionCommandHandlers`.
10. **Format and finish.** Format the changed files with the repository formatter (`pnpm exec oxfmt <files>` from the repository root) and run lint. Run the Verification commands. Inspect the full diff, and confirm that `rg -n "Thread(Archive|Shelve|CopyLink)CommandHandler|ARCHIVE_KEYS|SHELVE_KEYS|COPY_LINK_KEYS"` finds nothing outside the audit docs. Recount lines with `wc -l` on the new and deleted files.

**Verification and acceptance criteria**

The commands below are confirmed from `package.json` scripts at the snapshot. They were not run for this audit, because the snapshot has no `node_modules`.

- Focused tests, run from `apps/app`: `pnpm test -- src/views/thread-detail/ThreadCommandHandlers.test.tsx src/components/thread/ThreadActionsMenu.test.tsx`. The `test` script is `vitest run --config vitest.config.ts`, and `vitest.config.ts` accepts explicit `src/**.test.tsx` paths as filters. Expected: all tests pass with unchanged assertions plus the one added assertion.
- Typecheck, from `apps/app`: `pnpm typecheck` (`tsc --noEmit && tsc --noEmit -p tsconfig.node.json`).
- Lint, from `apps/app`: `pnpm lint` (oxlint over `src` and the Vite configs). From the root, `pnpm format:check` (`oxfmt . --check`) covers formatting.
- If `scripts/omnyo-renderer-map.mjs` was edited, run from `packages/scripts`: `pnpm exec vitest run test/omnyo-renderer-map.test.mjs`. This command is unconfirmed: check `packages/scripts/package.json` for its test script and use that.

Behavior checks the tests must still prove:

- Each command runs only in the focused pane and follows focus changes.
- An archived thread ignores `thread.archive` and is never unarchived.
- A sub-chat leaves `thread.shelve` unhandled, and nothing else runs (the new assertion).
- `thread.copyLink` copies with the same toast messages.
- Unhandled commands return false, so the key event is not consumed.

UI: the shortcut labels in desktop menus are unchanged and drawers still show none (`ThreadActionsMenu.test.tsx:833`). Alex tests UI changes himself. A manual check in a split pane is recommended but not required: press Mod+Shift+F in a top-level thread and in a sub-chat, and Mod+Shift+C in each pane.

Structural completion:

- The three handler files are gone.
- Exactly one key-to-command table exists (`thread-action-commands.ts`).
- The menu and the handler both import it.
- `ThreadDetailView` mounts one handler.
- No `ARCHIVE_KEYS`, `SHELVE_KEYS` or `COPY_LINK_KEYS` remain.

Performance: no budget applies, and no measurement is required for this path.

**Rollback and stop conditions**

- **Rollback.** The change is local to `apps/app` source, one test file, one doc line and one script set, with no persisted data, setting or API change. Reverting the single commit restores the old state. Command ids and keybinding overrides are untouched, so user overrides stay valid either way.
- **Stop if any of these hold:**
  - a handler on your base has diverged in priority, availability or guard semantics that the table cannot express without a per-row callback beyond `isBlocked`;
  - the handlers are mounted in a second place with different props;
  - `useIndexedAppCommandHandlers` is no longer exported or its registration order semantics differ;
  - any existing assertion in `ThreadCommandHandlers.test.tsx` or `ThreadActionsMenu.test.tsx` has to change to pass.
- **Safer smaller alternative.** If one of those stop conditions holds, export only the table from `thread-action-commands.ts` and have the three existing handlers read their key and command from it. That still removes the duplicated binding knowledge while keeping separate components.
