# RF-137 — Let the domain indicator resolver own the optional-question ("input-welcome") rule instead of the Thread list plugin's local wrapper

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** conditional. The duplication is real and every cited anchor holds at the snapshot. The plan changes visible status on host surfaces, and it has to settle one precedence question first, so Alex must answer Gate 0 before any edit.
- **Potential:** low. The gain is one owner for one rule and one label. The net production line change is small, between roughly 15 lines removed and roughly 10 lines added (see "Expected gain and cost").
- **Confidence:** high on the facts, which are proven by inspection. Medium on the gain, which depends on the Gate 0 answers.
- **Readiness:** decision-needed.
- **Effort:** about half a day after Gate 0. The work covers the domain resolver, an SDK patch bump, the plugin wrapper, the plugin SDK floor, the shared SDK indicator cases and a check of four host surfaces.
- **Risk:** low to medium, and visible. Host surfaces that never showed the optional-question glyph start showing it. On compact host surfaces the working spinner disappears for a running thread with an optional question, unless those surfaces add the companion runtime glyph that the Thread list already draws. Forks of the Thread list plugin need the SDK floor bump.
- **Prerequisites:** Gate 0 decisions. There are no code prerequisites.
- **Related or overlapping work:**
  - RF-136 ("Retire the eight thread-indicator kinds nothing produces") edits the same `ThreadListIndicatorKind` union, label table, `WAITING_ICONS` map and Ask user question visuals map. `input-welcome` is produced by the plugin, so RF-136 must keep it. Land the two cards sequentially, in either order, and rebase the second.
  - RF-004 ("Delete client-core's orphaned sidebar model") removes `packages/client-core/src/thread/thread-activity.ts` "getCollapsedChildActivity", which is another caller of domain "strongestThreadWorkSummary". If RF-004 lands first, this card has one caller fewer to check.
  - Incidental issue ISS-X1-02 (two labels for one kind) is fixed by Gate 0 decision B, as is the failed-status masking issue reported in this card's structured summary.
- **Why it ranks here:** the card removes a second resolver and a second label for one status kind, and it makes the existing dead `input-welcome` branches in the host reachable. The line savings are negligible. The value is maintenance: a future change to "when does an optional question show" happens in one file, and every surface follows it. Rank it below items that delete whole mechanisms.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The snapshot worktree was gone when this card was verified, so every file was read with `git show e9e1b74c…:<path>`. The three central files are byte-identical at local `main` `5f2d3f895` (`git diff e9e1b74c 5f2d3f895 -- <files>` printed nothing).

How the subsystem works. The server publishes a per-thread work summary (`ThreadWorkSummary`, `packages/domain/src/thread-work.ts:120-140`). The summary carries `primary.label` (needs-you, working, failed, blocked, waiting, open, external, ready-to-archive), `requiredInput` and `optionalInput`. The server fills `optionalInput` from questions whose mode is not `required` (`apps/server/src/services/threads/thread-work.ts:638-648`). Optional input never changes `primary.label` (`packages/domain/src/thread-work.ts:446-492`). Client surfaces turn the summary into a glyph kind with domain "resolveThreadListIndicator". The host ships that resolver to plugins at runtime as `experimental_threadIndicators` (`packages/plugin-sdk/src/app.ts:376`, `apps/app/src/lib/plugin-sdk-app-impl.tsx:157`, typed in `packages/plugin-sdk/src/app-contract.ts:4645`). The SDK authoring reference tells third-party plugins to call it (`plugins/omnyo-guide/skills/omnyo-plugin-authoring/references/frontend-core-slots.md:372-385`).

Observed facts (all proven by inspection at the snapshot):

1. The domain declares the kind and a label but never produces it. `packages/domain/src/thread-indicator.ts:9` declares `"input-welcome"`. Line 37 sets its label to "Optional question; the agent can continue". "resolveThreadListIndicator" (lines 67-90) switches only on `primary.label` and has no optional-input branch. "strongestThreadWorkSummary" (lines 106-129) returns one summary and does not merge optional input across summaries.
2. The Thread list plugin wraps the SDK resolver to add the rule. `plugins/thread-list/app/model/thread-activity.ts`:
   - lines 16-26, "resolveThreadListIndicator": returns `input-welcome` whenever `primary.label !== "needs-you"` and `optionalInput.length > 0`, and otherwise delegates to `experimental_threadIndicators.resolve`;
   - lines 28-34, "getThreadListIndicatorLabel": overrides the label with "Open decision; the agent can continue";
   - lines 39-67, "strongestThreadWorkSummary": after the SDK's choice, merges `optionalInput` and `activity` across all summaries, de-duplicated by `id`. When there is optional input it falls back to the first non-null summary even if the SDK returned `null`, which the SDK does for an unknown family member beside a ready-to-archive sibling;
   - lines 82-115, "resolveThreadStatus": an allow-list (`open`, `none`, `draft`) decides when a plugin row status may replace the glyph. A separate running variant label, "Open decision; work is running", is set at line 108.
3. The plugin draws a companion runtime glyph beside `input-welcome` when work is running (`plugins/thread-list/app/rows/ThreadRow.tsx:298-301` "CollapsedThreadStatusGlyph", `:394-400` "ThreadTrailingIndicator"). It strips optional input from children before computing the parent row (`thread-activity.ts:172-180` "parentRowChildWork").
4. Host surfaces call the domain resolver directly, so they never see `input-welcome`:
   - Related threads: `apps/app/src/components/secondary-panel/info/RelatedThreadsSection.tsx:40-51`;
   - search palette: `apps/app/src/components/commands/ThreadSearchPaletteMode.tsx:756-787`;
   - the `indicator` and `indicatorLabel` fields of every `PluginSidebarThread` the host gives plugins: `apps/app/src/lib/plugin-sidebar-threads.ts:112` "buildPendingSidebarThread" and `:179` "toPluginSidebarThread".
5. Host code that already handles `input-welcome` is therefore dead. Search command: `git grep -n "input-welcome" e9e1b74c -- ':!*.md'`. Excluding the plugin and its tests, it returned only these four locations:
   - `apps/app/src/components/thread/ThreadStatusGlyph.tsx:19` (the `MessageQuestion` icon), `:142` (deny-list entry) and `:204` (render case). These are reachable only when the Thread list passes the kind in;
   - `plugins/ask-user-question/src/sidebar/overlay.tsx:134`, which maps `input-welcome` to the `needs-input` highlight. It reads `thread.indicator` from `experimental_useSidebarThreads()` (`overlay.tsx:326-330`), which the host computes, so the entry never fires;
   - `apps/app/src/lib/plugin-project-sidebar-items.tsx:30`, which accepts the kind from plugin-supplied items. It is a schema value, not a producer.
6. The two labels collide within one sidebar row. The trailing glyph's tooltip and `data-status-reason` come from the plugin label ("Open decision; …"; `ThreadRow.tsx:357-407`). The inner icon's `aria-label` comes from the host's `threadIndicatorLabel` (`apps/app/src/lib/thread-indicator-label.ts:6-10`, which delegates to the domain label "Optional question; …"; `ThreadStatusGlyph.tsx:204-212`). The user documentation names the state "Optional question" (`plugins/omnyo-guide/skills/omnyo-cli/references/thread-operation.md:142`).
7. A third rule exists for the same evidence. `apps/app/src/components/sidebar/railAttention.ts:31-46` "railChatState" counts optional input as "needs" only while the label is `working`. Its test explicitly keeps a failed run visible when an optional question also exists (`apps/app/src/components/sidebar/railAttention.test.ts:83-98`). The plugin's rule (fact 2) has no such exclusion: a `failed`, `blocked` or `waiting` summary with optional input shows the question glyph in the sidebar and hides the failure. No plugin test covers that case. The plugin test at `plugins/thread-list/app/model/thread-activity.test.ts:12-48` covers only working, open, ready-to-archive and needs-you.

Counterevidence and current requirement. The current requirement is plausible: the sidebar needed the state, and a plugin cannot edit `@omnyo/domain`, so the rule was added locally. Showing it only in the sidebar may be deliberate, and the history cannot settle it, because the relevant history is squashed into `060950255 Publish Omnyo source` and `a606eb352`. Against that reading, the domain label, the host icon, the Ask user question mapping and the user docs all assume a host-produced `input-welcome`. Those are hypotheses about intent, not proof.

Consumers checked:
- `git grep` over the whole snapshot for `resolveThreadListIndicator|strongestThreadWorkSummary|threadIndicators|experimental_threadIndicators` found the server, CLI and mobile apps do not resolve indicators. The SDK test host (`packages/plugin-sdk/src/testing/app.tsx:1839`) and Ladle (`apps/app/.ladle/plugin-sdk-app.ts:57`) both bind domain `threadIndicators`, so they follow automatically.
- Nothing is persisted: indicator kinds are computed per render.
- Public contract: `PluginSidebarThread["indicator"]` already includes `input-welcome` in its type, so the change is behavioural, not a type break. External plugins that call `experimental_threadIndicators.resolve` or read `thread.indicator` start receiving the kind.
- The SDK floor matters. The host supplies `experimental_threadIndicators` at runtime, so a plugin that drops its local rule needs a host whose SDK ships the rule. Managed installs refuse a plugin whose `engines.omnyoPluginSdk` floor exceeds the running SDK (`docs/configuration.md:2338-2349`). The Thread list declares `">=0.6.53"` (`plugins/thread-list/package.json:18`). The current SDK is `0.6.57` (`packages/domain/src/plugin-sdk-version.ts:1`, `packages/plugin-sdk/package.json:4`).

Maintenance cost today. Changing when an optional question shows means editing the plugin wrapper, and nothing forces the host glyph, the search palette, Related threads, the Ask user question highlight or the rail to agree. Facts 5 to 7 show that they already disagree three ways.

**Proposed end state and preservation argument**

**Gate 0 (owner decisions; do not start the execution steps before these are answered):**

- **A. Scope.** Should Related threads, the search palette, pending and real `PluginSidebarThread.indicator` values, and therefore the Ask user question `needs-input` highlight, show the optional-question state? If the answer is no, stop. The rule is then intentionally sidebar-only, and only the label fix (decision B) remains, as an incidental-issue fix rather than a simplification.
- **B. Label.** Choose one label for the idle state: the domain's "Optional question; the agent can continue" (matches the user docs) or the plugin's "Open decision; the agent can continue". Also choose the running variant, for example "Optional question; work is running".
- **C. Precedence.** Should a `failed`, `blocked` or `waiting` summary with optional input keep its failure, blocked or waiting glyph, as the rail contract does, or show the question glyph, as the plugin does today? Recommendation: keep failed, blocked and waiting, and show `input-welcome` only over `working`, `open`, `external` and `ready-to-archive`. That keeps the rail test's intent.
- **D. Running companion glyph.** On compact host surfaces (Related threads, search palette), should a running thread with an optional question also show the runtime spinner, as the sidebar does? Otherwise those rows lose the spinner.

End state, assuming A is yes:

- `packages/domain/src/thread-indicator.ts` is the single owner of:
  - the `input-welcome` rule, as the first branch of "resolveThreadListIndicator";
  - the label in `THREAD_LIST_INDICATOR_LABELS`;
  - the optional-input merge inside "strongestThreadWorkSummary".
  The object `threadIndicators` and its four members keep their names and signatures, so the SDK export `experimental_threadIndicators` keeps its shape.
- `plugins/thread-list/app/model/thread-activity.ts` loses its wrapper bodies. "resolveThreadListIndicator", "getThreadListIndicatorLabel" and "strongestThreadWorkSummary" become direct aliases of the `experimental_threadIndicators` members, so the plugin's internal imports do not change. "resolveThreadStatus" keeps the plugin-specific parts: the stopping override, the row-status allow-list and the running variant label. "parentRowChildWork" and the companion runtime glyph in `ThreadRow.tsx` stay in the plugin as presentation.
- `engines.omnyoPluginSdk` in `plugins/thread-list/package.json` rises to the SDK version that ships the rule.
- Host surfaces receive `input-welcome` from the domain resolver without code changes, except for the optional companion glyph from decision D.

Preservation argument:
- The sidebar keeps its current behaviour for every case except the one decision C changes.
- The merge semantics move unchanged: de-duplicate by id, return the same object when no summary has optional input, and fall back to the first non-null summary when the SDK returns `null`.
- The existing domain tests compare by identity (`packages/domain/test/thread-work.test.ts:95-97, 455-456`). Those fixtures carry no optional input, so they still hold.
- The rail (`railAttention.ts`) does not use the indicator resolver, so its counts do not change.

Non-goals:
- Do not merge the plugin's row-status allow-list (`thread-activity.ts:97-101`) with the host glyph's deny-list (`ThreadStatusGlyph.tsx:136-145`). They encode different policies. The sidebar hides a plugin row status on `working-draft`, `ready-to-archive` and `unread-success`, and the search palette shows it, so unifying them is a separate visible change and is rejected for this card.
- Do not change the rail counts.
- Do not touch RF-136's unused kinds.

**Expected gain and cost**

Measured baseline, counted as non-blank lines with `git show e9e1b74c:<file> | sed -n A,Bp | grep -cv '^\s*$'`:

| Location | Non-blank lines |
|---|---|
| Plugin wrapper, `thread-activity.ts:16-34` | 17 |
| Plugin merge, `thread-activity.ts:39-67` | 23 |
| Plugin `resolveThreadStatus`, `:82-115` (stays) | 31 |
| Host visibility rule, `ThreadStatusGlyph.tsx:129-156` (stays) | 26 |

Projected changes to handwritten production lines:

| Change | Lines |
|---|---|
| Plugin wrapper and merge replaced by three aliases | about -36 |
| Domain resolver branch | about +4 to +6 |
| Domain merge inside the domain strongest function | about +18 to +22 |
| Host companion glyph (only if decision D is yes) | about +8 to +15 |
| **Net** | about -10 to -15 lines, or about 0 to +5 with decision D |

Tests change too. They gain new domain and SDK cases, about 30 to 50 lines, and the plugin's label expectations change.

What disappears:
- one of two resolvers for the same kind;
- one of two labels for that kind;
- the dead `input-welcome` handling in the host glyph and the Ask user question overlay, which becomes reachable.

Cost:
- a visible behaviour change on host surfaces;
- one SDK patch release;
- a floor bump that makes the forked Thread list refuse older hosts.

Performance: neutral by inspection. The same constant-time checks and a merge over a parent's child summaries move from the plugin to the domain module. No benchmark exists and none is needed for this change.

**Execution steps**

1. **Reconfirm.**
   - Check that `packages/domain/src/thread-indicator.ts` "resolveThreadListIndicator" still lacks an optional-input branch.
   - Check that `plugins/thread-list/app/model/thread-activity.ts:16-67` still wraps it.
   - Re-run `git grep -n "input-welcome" HEAD -- ':!*.md'` and compare the result with Context fact 5.
   - Read the Gate 0 answers. Re-plan if any of the following is true: decision A is no; RF-136 has removed `input-welcome`; a new surface resolves indicators without the domain function; or the host stopped supplying `experimental_threadIndicators` at runtime.
2. **Establish the missing evidence first.** Add failing tests that encode the Gate 0 decisions:
   - In `packages/domain/test/` (next to `thread-work.test.ts`, which already tests "strongestThreadWorkSummary"), add resolver cases. With optional input, `working`, `open`, `external` and `ready-to-archive` each return `input-welcome`, with and without `hasUnsubmittedDraft`. `needs-you` returns `waiting-for-input`. Under decision C, `failed` returns `unread-error`, `blocked` returns `dependency-failed` and `waiting` returns `callback-waiting`.
   - Add merge cases. A running child plus an open child with optional input returns the running primary with the merged optional input and activity. This mirrors `plugins/thread-list/app/model/thread-activity.test.ts:49-75`. An unknown child plus a ready-to-archive child with optional input returns the ready child's summary with that optional input, not `null`. Summaries with no optional input return the identical object.
   - In `packages/plugin-sdk/src/testing/thread-indicator-cases.ts`, add the same resolver cases to `experimental_threadIndicatorCases`. The `work()` fixture helper needs an `optionalInput` parameter, because today it always returns `[]` (line 44). Adding cases is additive for forks that iterate the cases.
3. **Domain edit** in `packages/domain/src/thread-indicator.ts`:
   - Make the first branch of "resolveThreadListIndicator": `const work = state.work; if (work !== null && work.optionalInput.length > 0 && OPTIONAL_INPUT_SHOWS_OVER.has(work.primary.label)) return "input-welcome";`. Here `OPTIONAL_INPUT_SHOWS_OVER` is `new Set(["working", "open", "external", "ready-to-archive"])` under the recommended decision C. If decision C keeps today's plugin behaviour, the condition is `work.primary.label !== "needs-you"`.
   - Set the `"input-welcome"` entry of `THREAD_LIST_INDICATOR_LABELS` to the decision B label.
   - Move the plugin's merge (`thread-activity.ts:44-66`) into "strongestThreadWorkSummary". Keep the existing loop. Then, if any non-null summary has optional input, choose `strongest ?? first non-null summary` and return `{ ...selected, optionalInput: dedupById(all optional input), activity: dedupById(all activity) }`. Otherwise return the existing result unchanged, which keeps the object identity.
   - Checkpoint: `packages/domain` tests and typecheck pass, including the new tests from step 2.
4. **SDK release.** Run `node scripts/bump-plugin-sdk.mjs --patch` from the repository root. It updates `packages/plugin-sdk/package.json` and `packages/domain/src/plugin-sdk-version.ts` together, and `packages/plugin-sdk/src/__tests__/version.test.ts` checks that they agree. The SDK export `experimental_threadIndicators` (`packages/plugin-sdk/src/app.ts:376`) needs no change. Checkpoint: `packages/plugin-sdk` tests pass, including `src/__tests__/thread-indicator.test.ts`, which iterates the shared cases.
5. **Plugin edit** in `plugins/thread-list/app/model/thread-activity.ts`:
   - Replace lines 16-34 and 39-67 with `export const resolveThreadListIndicator = experimental_threadIndicators.resolve;`, `export const getThreadListIndicatorLabel = experimental_threadIndicators.label;` and `export const strongestThreadWorkSummary = experimental_threadIndicators.strongest;`.
   - Keep the `WorkSummary`, `ThreadListIndicatorState` and `ThreadListIndicatorKind` types.
   - In "resolveThreadStatus", change the running label at line 108 to the decision B running label.
   - Set `engines.omnyoPluginSdk` in `plugins/thread-list/package.json` to `>=<new version>`.
   - Update the label expectations in `thread-activity.test.ts:73` and `plugins/thread-list/app/rows/ThreadRow.test.tsx:1465-1468`, but only to the decision B text. Keep the cases themselves. Add a failed-plus-optional sidebar case that matches decision C.
   - Checkpoint: the plugin's test, typecheck and lint pass.
6. **Host surfaces.** No resolver edits are needed.
   - If decision D is yes, add the companion runtime glyph beside `input-welcome` when `hasThreadListWorkingActivity(state)` is true. Do this in `RelatedThreadsSection.tsx:48-52` and in the palette status at `ThreadSearchPaletteMode.tsx:783-787`, mirroring `ThreadRow.tsx:394-400`.
   - Check that `plugin-sidebar-threads.ts:112,179` now emit `input-welcome` with the decision B `indicatorLabel`.
   - Check that the Ask user question overlay (`overlay.tsx:134`) now highlights those rows as `needs-input`, and add an overlay test case with `indicator: "input-welcome"` if `plugins/ask-user-question/src/sidebar/overlay.test.tsx` lacks one.
7. **Clean up and recount.**
   - Search `git grep -n "Open decision\|Optional question; the agent" -- ':!*.md'`. Exactly one label definition should remain, in the domain, plus the plugin's running variant.
   - Confirm `plugins/thread-list/app/model/thread-activity.ts` no longer reads `optionalInput` outside "parentRowChildWork".
   - Recount the lines with the baseline commands above and inspect the full diff for unrelated changes.

**Verification and acceptance criteria**

Commands come from the `package.json` scripts at the snapshot. Run each in the named directory. The commands were not executed for this card, because the snapshot has no `node_modules`.

- `packages/domain`: `pnpm test` (`vitest run --config vitest.config.ts`) and `pnpm typecheck`.
- `packages/plugin-sdk`: `pnpm build` (the plugin tests resolve the SDK's built entries, `docs/forkable-plugins.md:91-93`), then `pnpm test` and `pnpm typecheck`.
- `plugins/thread-list`: `pnpm test`, `pnpm typecheck` and `pnpm lint`.
- `plugins/ask-user-question`: `pnpm test` and `pnpm typecheck`.
- `apps/app`: `pnpm exec vitest run --config vitest.config.ts src/components/sidebar/railAttention.test.ts` for the rail counts, which must not change, plus any tests covering `RelatedThreadsSection`, `ThreadSearchPaletteMode` and `plugin-sidebar-threads` found with `rg -l` on those names. Also run `pnpm typecheck`.
- Repository root: `node scripts/check-plugin-forks.mjs` (script `check:plugin-forks`), because the Thread list is a forkable plugin. Then run `pnpm exec oxfmt <changed files>` and `pnpm exec oxlint --deny-warnings` on the changed files.

Acceptance:
- **Behaviour.** The domain cases from step 2 pass. The plugin's existing optional-decision tests pass with only label text changed. `railAttention.test.ts` passes unchanged. The SDK indicator cases include optional input.
- **UI (Alex checks).**
  - In the sidebar, a running thread with an optional question shows the question glyph and the spinner, and the tooltip and screen-reader label read the same text.
  - In Related threads and the search palette, the same thread shows the question glyph, with the spinner if decision D is yes.
  - A failed thread with an optional question shows the failure glyph everywhere, if decision C is "keep failure".
  - With Ask user question enabled, the row gets the needs-input highlight.
- **Structure.**
  - `input-welcome` is produced only in `packages/domain/src/thread-indicator.ts`.
  - The plugin has no local resolver or merge.
  - One idle label exists.
  - The SDK version and the plugin floor agree.

**Rollback and stop conditions**

Change boundary and rollback:
- The change splits into three commits: domain and SDK (steps 2-4), plugin (step 5) and host companion glyph (step 6). Each one reverts cleanly.
- Reverting the plugin commit alone restores the local wrapper. It works on both old and new SDKs, because the local rule is idempotent over a domain resolver that already returns `input-welcome`.
- Reverting the domain commit after the SDK patch release would leave released plugin floors pointing at a version without the rule. If the release has shipped, revert the plugin commit first.
- No persisted data or migrations are involved.

Stop if any of the following happens:
- Alex answers no to decision A. Ship only the label fix from decision B as an incidental fix, and close this card.
- An external or forked plugin is found that depends on host `thread.indicator` never being `input-welcome`.
- Decision C conflicts with a server-side intent recorded elsewhere, for example the Inbox `optionalQuestions` facts in `apps/server/src/services/inbox/collect.ts:478`.
- Step 6 shows a host surface cannot show the state without a layout change that DESIGN.md does not cover. In that case, keep the domain rule and ask Alex about that surface's presentation instead of restyling it.
