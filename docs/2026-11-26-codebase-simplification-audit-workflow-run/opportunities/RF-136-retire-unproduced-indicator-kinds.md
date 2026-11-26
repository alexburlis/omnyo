# RF-136 — Retire the eight thread-indicator kinds that no resolver has produced since the work-summary rewrite

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The central claim holds: 8 of the 20 `ThreadListIndicatorKind` values are never produced. The scope and the plan needed four corrections, listed at the end of this section.
- **Potential:** medium. About 40 handwritten production lines leave core, plus the duplicated 20-value zod list. Depending on decision D2, another 5 to 85 lines leave the Ask user question plugin.
- **Confidence:** high that the kinds are unproduced inside this repository and in the owner's private plugins repository. It is a hypothesis that no third-party plugin passes them.
- **Readiness:** decision-needed. Decision D1 covers narrowing a type that the plugin SDK publishes. Decision D2 covers the two Ask user question settings that no longer take effect. One small slice, step 3, is ready without either decision.
- **Effort:** small, about 2 to 4 hours. That includes the coordinated edit in `omnyo-plugins`, the SDK version bump and the doc fixes.
- **Risk:** low at runtime and moderate at compile time. Plugins that `switch` on the removed literals fail TypeScript with error TS2678 once they re-vendor the SDK. Two such plugins exist in `omnyo-plugins`.
- **Prerequisites:** decisions D1 and D2 below. Under D1 option (b), RF-041's next-major batch must also be scheduled.
- **Related and overlapping items:**
  - RF-137 (let the domain resolver own `input-welcome`) touches the same union, the same labels and the same overlay map. Run the two in one change, or land RF-137 second.
  - RF-041 (scheduled next-major SDK removals) is the natural carrier if Alex wants the union narrowing treated as a breaking change.
  - The incidental issues are the dead Ask user question settings and the stale `docs/api_to_audit.md` text (see newIssues in the audit summary).
- **Why it deserves its place:**
  - It removes vocabulary that has no producer and is restated in five places: the domain union and its labels, the glyph icon map and switch, the app zod enum, and the overlay map and CSS.
  - It makes two user-visible plugin settings honest again.
  - It is not large. It ranks below the structural items.
- **Corrections to the sweep report:**
  1. The proposed "mark the 8 kinds `@deprecated`" fallback is not possible at the type level. TypeScript does not apply `@deprecated` to individual members of a string-literal union, so that option is documentation only.
  2. External consumers do exist in the owner's private plugins repository. The sweep did not check it.
  3. The host zod enum and the glyph cases cannot be narrowed ahead of the SDK type without a type/runtime mismatch.
  4. The production line counts were understated once the Ask user question CSS is included.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The prepared snapshot worktree was no longer present, so every file was read with `git -C $OMNYO_CHECKOUT show e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e:<path>` and searched with `git grep` at that commit. No tests were run, because the snapshot has no `node_modules`.

How the subsystem works: every sidebar row shows a status glyph. Since the work-summary rewrite, the glyph kind comes from one function, `packages/domain/src/thread-indicator.ts:67` `resolveThreadListIndicator`. It maps the server-owned `ThreadWorkSummary.primary.label` (plus a client-local draft flag) to a `ThreadListIndicatorKind`. The plugin SDK re-exports that union as `PluginSidebarThreadIndicator` (`packages/plugin-sdk/src/app-contract.ts:1124`). Plugins use it in three ways:

- They read it on `PluginSidebarThread.indicator` (`app-contract.ts:1223`).
- They pass it to `ExperimentalProjectSidebarItem.indicator` (`app-contract.ts:1383`).
- They pass it to `PluginThreadStatusGlyphProps.indicator` (`app-contract.ts:1637`), which the SDK exposes as `experimental_ThreadStatusGlyph`.

Observed facts (Proven by inspection):

- `packages/domain/src/thread-indicator.ts:8-28` declares 20 kinds, and lines 30-53 `THREAD_LIST_INDICATOR_LABELS` label 19 of them.
- `resolveThreadListIndicator` (lines 67-90) returns exactly 10 values: `waiting-for-input`, `working-draft`, `runtime`, `dependency-failed`, `unread-error`, `callback-waiting`, `draft`, `ready-to-archive`, `external` and `open`. It never returns `none`.
- `plugins/thread-list/app/model/thread-activity.ts:16-26` `resolveThreadListIndicator` additionally returns `input-welcome`.
- Callers pass `none` explicitly as "draw nothing" (for example `plugins/thread-list/app/model/fixtures.ts:97` and `plugins/composer-predictions/app.spec.tsx:147`).
- The kinds nothing produces are `workflow`, `background-agent`, `background-command`, `plan-mode`, `goal`, `queued-failed`, `queued-waiting` and `unread-success`.
- Host-supplied indicators come only from the resolver: `apps/app/src/lib/plugin-sidebar-threads.ts:112` (`buildPendingSidebarThread`) and `:179` (`toPluginSidebarThread`).

Search scope. For each of the six hyphenated kinds, `git grep -n -F '"<kind>"' <commit> -- . ':!*.md'` (and the single-quoted form) ran over the whole repository. For `workflow` and `goal`, `git grep -n -E '"(workflow|goal)"'` ran over `apps/app/src/components/{thread,sidebar}`, `apps/app/src/lib`, `packages/{domain,client-core,plugin-sdk}` and `plugins/{ask-user-question,thread-list}`. Every hit is one of the following declaration or consumer sites, or an unrelated string (for example `thread-work.ts:32` activity kinds, the `/goal` composer command, timeline `workKind`):

- `packages/domain/src/thread-indicator.ts:15-24` (union) and `:43-52` (labels).
- `apps/app/src/components/thread/ThreadStatusGlyph.tsx`:
  - `WAITING_ICONS` entry `"queued-waiting"` at line 18.
  - `case "queued-failed"` at 195, `case "queued-waiting"` at 207, and `case "workflow"` through `case "goal"` at 217-221.
  - The `case "unread-success"` dot at 259-265, the only user of `SIDEBAR_SUCCESS_STATUS_DOT_CLASS`, which is imported at line 13.
- `apps/app/src/lib/plugin-project-sidebar-items.tsx:28-51`, a zod `z.enum([...])` that restates all 20 kinds.
- `plugins/ask-user-question/src/sidebar/overlay.tsx`:
  - `HookMark` at 37-44.
  - The `visualMarks` entries at 140-145 and the "working" loop at 148-157.
  - The `SidebarDecorator.paint` queued branch at 302-310.
  - `readSettings` at 100-104 (the `unreadSuccess` and `queued` keys).
- `plugins/ask-user-question/src/sidebar/highlight-css.ts`: the `data-needs-you="unread-success"` rules at 40-43, 53-57 and 125-132, and the `data-needs-you-queued` rules at 29-38, 79, 98, 121 and 178.
- `plugins/ask-user-question/src/sidebar/settings-contract.ts`: `unreadSuccess` and `queued` at 10-11, 21-22, 32-33 and 56-68.
- Tests:
  - `apps/app/src/components/thread/ThreadStatusGlyph.test.tsx:16-25` and `:46-57`.
  - `plugins/ask-user-question/src/sidebar/overlay.test.tsx:94-95` and its assertions at about 115-119.
  - `plugins/ask-user-question/src/sidebar/highlight-css.test.ts:20`.

Other consumers checked:

- `packages/client-core/src/thread/thread-activity.ts:10-16` only re-exports the type.
- `packages/plugin-sdk/src/testing/thread-indicator-cases.ts` and `packages/plugin-sdk/src/__tests__/thread-indicator.test.ts` contain none of the 8 kinds.
- No `.json` manifest or migration contains them, and the mobile and desktop apps have no hits.
- `docs/api_to_audit.md:3897-3940` (the `experimental_useSidebarThreads` audit entry) still says three stale things: that `indicator` "now reports `queued-failed` and `queued-waiting`", that "plan and goal [come] before the spinner", and that an idle unread thread "reads as `unread-success`".

Why the kinds became dead (Proven by inspection of the retired private Git store, `$ARCHIVED_OMNYO_CHECKOUT`):

- `git log -S 'return "queued-waiting"'` points to commit `69047f500e` "refactor: unify chat work status from server evidence" (2026-10-28).
- That commit deleted the old flag-based resolver, which returned `plan-mode`, `goal`, `unread-success`, `workflow`, `background-agent`, `background-command`, `queued-failed` and `queued-waiting`.
- `git tag --contains 69047f500e` starts at `desktop-v0.46.0`.
- Ask user question declares `engines.omnyo >=0.46.83` (`plugins/ask-user-question/package.json`). Every host in its supported range therefore runs the new resolver. Hypothesis, low risk: this assumes `engines.omnyo` is compared against the desktop release version. The plugin is bundled first-party, so in practice it ships with a matching host.

External consumers (Proven by inspection of `$OMNYO_PLUGIN_CHECKOUT` at `7edbc502`, 2026-11-26):

- `chat-groups/groups.ts:164` `indicatorIcon` and `branch-tree/tree.ts:123` `indicatorIcon` switch on `queued-failed`, `unread-success`, `queued-waiting`, `background-agent`, `background-command`, `goal`, `plan-mode` and `workflow`. Both have `default: return null` and vendor `omnyo-plugin-sdk-0.6.46`.
- `chat-topics/tests/grouping.test.ts:98` builds a fixture with `indicator: "unread-success"` and labels it "obsolete runtime indicators".
- The plugins that write `ExperimentalProjectSidebarItem.indicator` or `ThreadStatusGlyph indicator` (`canvas/components/project-sidebar.tsx:186`, `canvas/components/project-chat.tsx:350`, `chat-topics/components/project-items.tsx:55`) only forward host-resolved values.
- `alex-fixes/sidebar/unread-navigation.tsx` reads Ask user question's `data-omnyo-sidebar-unread-targets` attribute (`overlay.tsx:353-357`). That set can contain only `unread-failed` threads today, because `unread-success` is never produced.
- `@omnyo/plugin-sdk` is `"private": true` and is distributed as packed tarballs (`pack:private`). Its known consumers are therefore this repository and `omnyo-plugins`. Third-party users are a hypothesis that cannot be checked from here.

Remaining host data (Proven by inspection):

- `PluginSidebarThread` still carries `queuedWork` (`app-contract.ts:1219`, filled at `plugin-sidebar-threads.ts:137` and `:205`) and `isUnread` (`:1231`, filled at `:142` and `:217`).
- It also still carries `activity.workflows`, `backgroundAgents`, `backgroundCommands`, `planMode` and `goals` (`:1128-1141`, filled at `:207-213`).
- So the state behind the dead kinds still reaches plugins through other fields. Only the indicator vocabulary is stale.

Persisted data (Proven by inspection):

- Plugin settings reads iterate declared descriptors only: `apps/server/src/services/plugins/plugin-settings.ts:60` `readPluginSettingsValuesSync` and `:130` `buildPluginSettingsView`.
- A removed setting key therefore stays inert in the stored row and needs no migration.

Maintenance cost today: adding or renaming a live indicator kind touches the domain union, the labels, the glyph map and switch, the app zod enum, the overlay map and possibly the CSS. Each of those sites also carries 8 inert kinds that look meaningful. Two user-facing settings ("Finished, unread" and "Queued messages") sit on those inert kinds and do nothing.

**Proposed end state and preservation argument**

End state:

- `ThreadListIndicatorKind` lists the 12 values that are produced or passed: `input-welcome`, `callback-waiting`, `dependency-failed`, `unread-error`, `waiting-for-input`, `working-draft`, `runtime`, `draft`, `ready-to-archive`, `external`, `open` and `none`.
- The domain owns one `threadListIndicatorKinds` const array. The type and the app zod enum both derive from it, so the list is written once.
- `ThreadStatusGlyph` keeps every live branch unchanged and loses the dead cases.
- Ask user question keeps every live mark. What happens to the two dead settings depends on decision D2.

Decisions that gate the work:

- **D1 (SDK contract).** Choose one:
  - (a) Narrow the union now, with an SDK minor bump and the coordinated `omnyo-plugins` edit. This is recommended, because the only known consumers are the owner's own and no host has emitted these values since 0.46.0.
  - (b) Hold the narrowing for RF-041's next-major batch.
  - (c) Keep the union and add a doc comment only. That yields about 5 lines of gain and leaves the duplication.
- **D2 (Ask user question settings).** Choose one:
  - (a) Remove "Finished, unread" (`unreadSuccess`) and "Queued messages" (`queued`) with all their marks and CSS. This matches today's actual behavior.
  - (b) Reimplement them from data the host still sends: unread-success from `thread.isUnread && thread.experimental_work?.primary.label` in `open`, `external` or `ready-to-archive`, and queued from `thread.queuedWork !== "none"`. This is a product change that turns the highlights back on, and the exact predicate needs the owner's approval.

Preservation argument:

- No host or first-party plugin produces the 8 values, so no rendered state changes for host-resolved rows under D2(a).
- Plugin-supplied indicators can only lose values that the type still technically allowed. The known writers only forward host values.
- `none` stays: callers use it to mean "draw nothing", even though the resolver never returns it.
- `SIDEBAR_SUCCESS_STATUS_DOT_CLASS` stays exported from `packages/shared-ui/src/components/ui/sidebar-row-classes.ts:24`, because the shared-ui plugin registry (`packages/plugin-registry/r/sidebar-row-classes.json`) publishes it. Only its import in the glyph goes.
- `PluginSidebarThread.activity` and `queuedWork` stay unchanged.

Non-goals: changing resolver precedence, moving `input-welcome` into the domain (that is RF-137), changing the `rowStatus` exclusion list in `resolveThreadStatus`, and removing the alex-fixes unread-navigation reader.

Reachability proof and remaining uncertainty: the git grep scopes and the omnyo-plugins search above, plus the git-history proof that the producer was deleted. What remains uncertain is unseen third-party plugins compiled against the SDK. For those, the break is compile-time only, and a project-sidebar item carrying a removed kind would fail `groupsSchema.parse` at `plugin-project-sidebar-items.tsx:143`.

**Expected gain and cost**

Projections from line inspection, not measurements:

| Slice | Handwritten production lines removed | Notes |
|---|---|---|
| Domain union and labels | about 16 | Lines 15-19, 21-22, 24, 43-47, 49-50 and 52. The union becomes a const array of about 14 lines plus 1 type line. |
| App zod enum | about 21 | `z.enum(threadListIndicatorKinds)` replaces the 20-line literal list. This removes one restatement of the vocabulary. |
| `ThreadStatusGlyph.tsx` | about 16 | 1 map entry, 7 case labels, the 7-line dot branch and 1 import. |
| Ask user question "working" loop (step 3, ready now) | 5 | `workflow` through `goal` at `overlay.tsx:150-154`. |
| Ask user question under D2(a) | about 75 to 85 | Overlay about 24 (HookMark, `visualMarks` 140-145, the queued branch in `paint`, `ATTR_QUEUED`, `readSettings` keys). CSS about 35 to 40 (the unread-success and queued rules and comments). Settings contract 19. |
| Ask user question under D2(b) | about 0 net | The entries are replaced by two derivations of about 8 lines. The CSS stays. |

Totals:

| Combination | Production lines removed |
|---|---|
| D1(a) and D2(a) | about 130 |
| D1(a) and D2(b) | about 55 |
| D1(c) | about 5 |

Test changes: about 15 fixture and assertion lines in the three test files. Docs: about 6 lines corrected in `docs/api_to_audit.md`.

Costs:

- A plugin SDK version bump.
- One edit in `omnyo-plugins` (two `indicatorIcon` functions and one fixture) when those plugins re-vendor.
- Under D2(a), Alex loses two settings that already do nothing.

Performance: neutral (Hypothesis). The map gets fewer entries and the stylesheet fewer `:has()` selectors.

Why it gets easier: a new kind is added in one domain array and one glyph case. The zod list follows automatically, and every remaining value has a producer.

**Execution steps**

1. **Reconfirm.**
   - Rerun the Context searches at the new HEAD, for example `git grep -n -F '"queued-waiting"'` for each kind.
   - Confirm that `resolveThreadListIndicator` still returns only the 10 values.
   - Rerun the same search in `$OMNYO_PLUGIN_CHECKOUT`.
   - Stop and re-plan if any producer appears, or if a plugin in either repository writes one of the 8 kinds into `ExperimentalProjectSidebarItem.indicator` or `ThreadStatusGlyph`.
2. **Decision gate.** Record the owner's choices for D1 and D2. Without them, do only step 3.
3. **Ready slice, independent of D1 and D2.** In `plugins/ask-user-question/src/sidebar/overlay.tsx` `visualMarks`, shrink the "working" loop at 148-157 to `runtime` and `working-draft`, or write two `visuals.set` calls.
   - This compiles under any union, because Map keys may be a subset.
   - It changes no behavior on hosts at or above 0.46.0.
   - Checkpoint: run the Ask user question plugin tests and typecheck.
4. **D2 edits (Ask user question).**
   - Under D2(a):
     - Delete the `unread-success`, `queued-failed` and `queued-waiting` entries in `visualMarks`, and those members from `HookMark`.
     - Delete `ATTR_QUEUED`, the `queued` computation in `SidebarDecorator.paint`, and the `ATTR_QUEUED` parts of `clearAllMarks`. `paint` becomes `setAttribute(anchor, ATTR_STATE, mark ?? null)`.
     - Simplify the `unread` memo to `mark === "unread-failed"`.
     - Remove `unreadSuccess` and `queued` from `readSettings`, and from `NeedsYouSettings`, `NEEDS_YOU_DEFAULTS`, `NEEDS_YOU_KEYS` and `defineNeedsYouSettings` in `settings-contract.ts`.
     - In `highlight-css.ts`, delete the `data-needs-you="unread-success"` and `data-needs-you-queued` selectors and rules, and the comment paragraphs that describe the success dot and the queued glyphs. Keep the `unread-failed` half of the bold title rule at line 57.
     - Update `highlight-css.test.ts:20` to drop `"unread-success"`.
     - In `overlay.test.tsx`, replace the `unreadSuccess: false` and queued fixture with a live-kind case. Keep the `needs-input` and intensity assertions.
   - Under D2(b): replace those map entries with per-thread derivations inside the `for (const thread of threads)` loop, using `thread.isUnread`, `thread.experimental_work?.primary.label` and `thread.queuedWork`. Rewrite the overlay test fixtures to set those fields instead of `indicator`.
   - Checkpoint: run the Ask user question tests.
5. **D1(a) edits (core and SDK), in one commit.**
   - In `packages/domain/src/thread-indicator.ts`, replace the union with `export const threadListIndicatorKinds = ["input-welcome", …, "none"] as const;` and `export type ThreadListIndicatorKind = (typeof threadListIndicatorKinds)[number];`, using the 12 values. Delete the 8 label entries. `Record<Exclude<…, "none">, string>` keeps the labels exhaustive.
   - `threadListIndicatorKinds` is exported automatically, because `packages/domain/src/index.ts:171` already has `export * from "./thread-indicator.js"`.
   - In `apps/app/src/lib/plugin-project-sidebar-items.tsx:28-51`, use `indicator: z.enum(threadListIndicatorKinds).optional()` with an import from `@omnyo/domain`.
   - In `apps/app/src/components/thread/ThreadStatusGlyph.tsx`, delete the `"queued-waiting"` entry in `WAITING_ICONS`, `case "queued-failed"`, `case "queued-waiting"`, the five cases `workflow` through `goal`, the `case "unread-success"` branch and the `SIDEBAR_SUCCESS_STATUS_DOT_CLASS` import. The switch stays exhaustive over the narrowed type.
   - In `ThreadStatusGlyph.test.tsx`, drop the 7 rows for removed kinds at 16-25, and split the "unread success as a dot and nothing for none" test so the `none` assertion survives.
   - Bump `packages/plugin-sdk/package.json` `version` by one minor step under D1(a), following the repository's SDK release practice. Read `docs/forkable-plugins.md` for the minimum-version rule before choosing it.
   - Fix `docs/api_to_audit.md:3897-3940` so it describes the work-summary resolver.
   - Under D1(b), do this step inside RF-041's batch instead. Under D1(c), only add a doc comment on `PluginSidebarThreadIndicator` that names the 8 values as no longer produced.
6. **Coordinated external edit** (separate repository, separate commit): in `$OMNYO_PLUGIN_CHECKOUT`, remove the dead cases from `chat-groups/groups.ts` `indicatorIcon` and `branch-tree/tree.ts` `indicatorIcon`, and change the `chat-topics/tests/grouping.test.ts:98` fixture to a live kind. Do this when those plugins re-vendor the new SDK tarball. It is not needed while they pin 0.6.46.
7. **Final check.** Inspect the full diff for unrelated changes. Confirm with `git grep -n -E '"(workflow|goal|background-agent|background-command|plan-mode|queued-failed|queued-waiting|unread-success)"'` that the remaining hits are unrelated strings only, then recount the removed lines with `git diff --numstat`.

**Verification and acceptance criteria**

Run from the repository root of the working checkout. The script names come from each package's `package.json` at the snapshot; the `--filter` names are confirmed (`@omnyo/domain`, `@omnyo/app`, `@omnyo/plugin-sdk`, `@omnyo/client-core`, `omnyo-plugin-ask-user-question`, `omnyo-plugin-thread-list`). None of these commands were run in this audit.

- `pnpm --filter @omnyo/domain typecheck` and `pnpm --filter @omnyo/domain test`
- `pnpm --filter @omnyo/client-core typecheck`
- `pnpm --filter @omnyo/plugin-sdk typecheck` and `pnpm --filter @omnyo/plugin-sdk exec vitest run --config vitest.config.ts src/__tests__/thread-indicator.test.ts`
- `pnpm --filter @omnyo/app typecheck` and `pnpm --filter @omnyo/app exec vitest run --config vitest.config.ts src/components/thread/ThreadStatusGlyph.test.tsx src/lib/plugin-project-sidebar-items.test.tsx src/lib/plugin-sidebar-threads.test.ts`
- `pnpm --filter omnyo-plugin-ask-user-question typecheck` and `pnpm --filter omnyo-plugin-ask-user-question test`
- `pnpm --filter omnyo-plugin-thread-list typecheck`, because the thread-list plugin aliases `PluginSidebarThreadIndicator`.
- Format and lint the changed files: `pnpm exec oxfmt <files>`, then `pnpm exec oxlint --deny-warnings --format=agent`.

Acceptance:

- Every live glyph row in `ThreadStatusGlyph.test.tsx` passes unchanged: the labels, icons and working orb for the 10 resolved kinds plus `input-welcome`, `draft` and `none`.
- `plugin-sdk` `thread-indicator.test.ts` passes without any edit to `thread-indicator-cases.ts`.
- Ask user question still marks `needs-input`, `unread-failed`, `callback` and `working` rows, and still applies intensity.
- Under D2(b), tests prove that the new unread-success and queued derivations fire from `isUnread` and `queuedWork`.
- Alex checks the sidebar by hand: a working chat, a needs-you chat, a failed unread chat, a callback-waiting chat and a done chat, with Ask user question enabled at subtle and bold intensity. Each must look as it does before the change. Under D2(b), the restored highlights are new behavior and need his sign-off.
- Structural completion: the 8 literals appear nowhere as indicator values, the app zod enum no longer lists kinds by hand, and under D2(a) the settings pane no longer shows "Finished, unread" or "Queued messages".

**Rollback and stop conditions**

- Rollback: each checkpoint is a self-contained revert. Revert the core and SDK commit and the plugin commit independently.
- Data: no persisted data changes. Under D2(a), stored values for `unreadSuccess` and `queued` stay in the plugin settings row and are ignored (`plugin-settings.ts:60`). Reverting restores them as they were.
- Stop if:
  - any producer of one of the 8 kinds is found;
  - a plugin, in this repository or in `omnyo-plugins`, writes one of them as a project-sidebar item indicator, because it would start failing `groupsSchema.parse`;
  - Alex wants SDK union changes only in a major release (then switch to D1(b) and fold this into RF-041);
  - Alex rejects both D2 options (then do only step 3 and leave the settings as a documented issue).
- Smaller safe alternative: step 3 plus the `docs/api_to_audit.md` correction. That changes no contract.
