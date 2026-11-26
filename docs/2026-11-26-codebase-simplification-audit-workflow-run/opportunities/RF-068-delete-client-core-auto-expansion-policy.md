# RF-068 — Delete the orphaned client-core live auto-expansion policy `collectTimelineAutoExpansionRowIds`

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** Confirmed, with one correction to the sweep report. The dead code is not the policy that moved to the web timeline. It is an older, different policy (the "frontier plus last two command or tool rows" rule) that a commit on 18 November 2026 accidentally restored in client-core while moving the live policy into the app. Nothing calls it.
- **Potential:** Low to medium. About 89 non-blank production lines disappear, and with them a second, contradictory live-expansion rule.
- **Confidence:** High.
- **Readiness:** Ready.
- **Effort:** Under one hour.
- **Risk:** Very low. Only unreferenced code in a private workspace package is removed.
- **Prerequisites:** None.
- **Related or overlapping items:** RF-004 ("Delete client-core's orphaned sidebar model") and RF-079 ("Delete small orphaned helpers kept alive only by their own tests") also edit `packages/client-core/src/index.ts`. RF-068 does not need to edit that file, because the export line stays for the surviving helpers. No other overlap.
- **Why it belongs on the list:** The change is small, but it removes duplicated knowledge with a real trap. Two functions named for "live auto-expansion" disagree about which rows open during a running turn. Someone changing that behaviour who searches client-core first would find and edit the wrong one, and nothing would change in the product.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The read-only snapshot worktree had been removed before this verification, so every file was read with `git -C $OMNYO_CHECKOUT show e9e1b74c…:<path>` and searched with `git grep` at that commit.

What the subsystem does: when a chat turn is running, the web timeline opens certain rows automatically, such as pending system rows, bundles and delegations, so the user sees live progress. `apps/app/src/components/thread/timeline/ThreadTimelineRows.tsx` builds that set of row ids in `ThreadTimelineRowsForTimelineView` through a `useMemo` that calls `collectLiveTimelineExpansionRowIds({ rows, scopeActive })`.

Observed facts (Proven by inspection):

- The live policy lives in `apps/app/src/components/thread/timeline/timeline-live-expansion.ts`. `visitLiveRows` (line 4) walks the rows after the last settled conversation row and opens each pending expandable row, recursing into summaries, turns and pending delegations. The exported function is `collectLiveTimelineExpansionRowIds` (line 53). It imports only `isRowExpandable` from `@omnyo/client-core` (line 1).
- `packages/client-core/src/timeline/timeline-auto-expand.ts` has 190 lines. It holds:
  - live code: `isWorkRowExpandable` (line 21, private), `isRowExpandable` (line 69) and `isNonExpandableSummary` (line 91);
  - dead code: the interfaces `CollectTimelineAutoExpansionRowIdsArgs` (line 12) and `TimelineAutoExpansionRowIds` (line 17), and the functions `shouldAutoExpandLiveFrontierRow` (line 99), `visitForLiveFrontierAutoExpand` (line 124), `visitRecentWorkRows` (line 151) and `collectTimelineAutoExpansionRowIds` (line 173, exported). Only the dead code uses the `findTimelineFrontierRow` import on line 3.
- The dead function applies a different rule from the shipped one. It opens the "frontier" row (via `findTimelineFrontierRow` from `@omnyo/thread-view`), recurses into pending delegations, and also opens the last two expandable `command` or `tool` work rows since the last user message. The shipped `visitLiveRows` contains neither the frontier step nor the "last two work rows" step.
- History, from the retired private repository at `$ARCHIVED_OMNYO_CHECKOUT` (the public history is squashed into `060950255 Publish Omnyo source`):
  - `42e9b0e631` / `85f352b241` "Fold finished chat activity as the model works" (2026-11-18 14:24) replaced the frontier policy in client-core with `visitLiveRows`.
  - Two minutes later, `bfc2b1f24a` / `c692f04dca` "Keep the live expansion policy in the web timeline" (2026-11-18 14:26) moved `visitLiveRows` into the new `timeline-live-expansion.ts`, switched `ThreadTimelineRows.tsx` from `collectTimelineAutoExpansionRowIds` to `collectLiveTimelineExpansionRowIds`, and in the same diff restored the older frontier code in client-core.
  - Since then, only `2a07ed0b66` "Show a chat's started dev server as a timeline step" has touched the file. It changed `isRowExpandable`, not the dead code.
  - So the client-core function is an orphaned copy of the retired frontier policy, not a backup of the current one. This corrects the sweep report, which described it as "the old implementation" of the moved policy.

Reachability searches (all at the snapshot, whole repository, tracked files):

- `git grep -n -e collectTimelineAutoExpansionRowIds -e TimelineAutoExpansionRowIds -e CollectTimelineAutoExpansionRowIdsArgs -e shouldAutoExpandLiveFrontierRow -e visitForLiveFrontierAutoExpand -e visitRecentWorkRows -e timeline-auto-expand e9e1b74c… -- .` matches only the definitions in `timeline-auto-expand.ts` and the barrel line `packages/client-core/src/index.ts:57` `export * from "./timeline/timeline-auto-expand.js";`.
- The plugin sources at `$OMNYO_PLUGIN_CHECKOUT` contain no reference to `@omnyo/client-core` at all (`rg -c client-core $OMNYO_PLUGIN_CHECKOUT --glob '!**/node_modules/**'` printed nothing). External plugins therefore cannot consume this function.
- `packages/client-core/package.json` declares `"private": true` and version `0.0.1`. The package is a workspace-only source package (its exports point at `./src/*.ts`), not part of the published SDK or plugin SDK, so older clients and external plugins have no stable contract on it.
- The mobile app no longer has a native timeline: private commit `15e87df425` "Replace the native mobile UI with a WebView shell around the PWA" removed it, and `git grep` finds no mobile import of these symbols.
- No docs, persisted data, settings keys, CLI commands or scripts mention the symbols. `git grep -i 'auto-expan\|autoExpan' -- docs '*.md'` returned nothing, and the 2026-11-25 Codex audit does not mention them.
- `findTimelineFrontierRow` stays alive after the deletion. `packages/thread-view/src/timeline-row-title.ts:1957` uses it, `packages/thread-view/src/index.ts:30` exports it, and `packages/thread-view/test/timeline-progression.test.ts:311` tests it. Only the import in client-core goes.

Tests: no test exercises the dead function. `apps/app/src/components/thread/timeline/timeline-auto-expand.test.ts` tests `isRowExpandable` (from client-core) and `collectLiveTimelineExpansionRowIds` (from the app), and both survive. client-core's own tests (`packages/client-core/test/timeline-merge.test.ts`, `timeline-projection.performance.test.ts`) do not touch this file's dead symbols. Because the snapshot has no `node_modules`, no test or typecheck was run during verification.

Counterevidence searched for and not found: a dynamic import, a string-addressed lookup, or a re-export through another package. Uncommitted work in `$OMNYO_CHECKOUT` was also checked: `rg collectTimelineAutoExpansionRowIds` there matches only the definition itself.

**Proposed end state and preservation argument**

- **What disappears:** `CollectTimelineAutoExpansionRowIdsArgs`, `TimelineAutoExpansionRowIds`, `shouldAutoExpandLiveFrontierRow`, `visitForLiveFrontierAutoExpand`, `visitRecentWorkRows`, `collectTimelineAutoExpansionRowIds`, and the `findTimelineFrontierRow` import, all in `packages/client-core/src/timeline/timeline-auto-expand.ts`.
- **What remains:** `isWorkRowExpandable`, `isRowExpandable` and `isNonExpandableSummary` in the same file. They are still exported through `packages/client-core/src/index.ts:57`. `ThreadTimelineRows.tsx` (lines 84–85, 1332, 2134, 2162), `timeline-live-expansion.ts:1` and two app tests keep importing them unchanged.
- **Canonical owner:** after the change, `apps/app/src/components/thread/timeline/timeline-live-expansion.ts` `collectLiveTimelineExpansionRowIds` is the single live-expansion policy. client-core owns only the platform-neutral question "can this row expand?".
- **Preservation:** runtime behaviour cannot change, because no runtime path reaches the removed code. Proof: the only call site was removed in `bfc2b1f24a`, and the repository-wide search above finds no other caller. No UI state, persisted format or public API is affected.
- **Remaining uncertainty:** an untracked local checkout outside these two repositories could import the function. That consumer is improbable because the package is private and workspace-only. If one exists, typecheck fails loudly; it is not a silent break.
- **Non-goals:**
  - Do not rename `timeline-auto-expand.ts` or its app test file. A name such as `timeline-expandable.ts` would fit better, but renaming moves code without reducing complexity and churns the barrel.
  - Do not revive or evaluate the frontier policy as a product change. If Alex wants the "frontier plus last two work rows" behaviour back, that is a separate product decision, and the deleted code stays retrievable from history.

**Expected gain and cost**

- **Measured on the snapshot:** 103 physical lines can be removed (line 3, lines 12–20 and lines 98–190), of which 89 are non-blank. The file drops from 190 to 87 lines. Method: a `python3 -I` count over `git show e9e1b74c…:packages/client-core/src/timeline/timeline-auto-expand.ts`. No tests, generated files, docs or assets change.
- **Mechanisms:** two live-expansion policies become one. The duplicated and contradictory knowledge of which pending rows open automatically disappears.
- **Cost:** none added. No new code and no behaviour change.
- **Performance:** neutral, because the code is never executed. The bundle effect is unknown: the barrel's `sideEffects: false` probably already lets the dead function tree-shake out of the app bundle (Hypothesis).

**Execution steps**

1. **Reconfirm.** In the working checkout, rerun `git grep -n -e collectTimelineAutoExpansionRowIds -e TimelineAutoExpansionRowIds -e shouldAutoExpandLiveFrontierRow -e visitForLiveFrontierAutoExpand -e visitRecentWorkRows -- .` and `rg -n collectTimelineAutoExpansionRowIds $OMNYO_PLUGIN_CHECKOUT --glob '!**/node_modules/**'`.
   - Stop and re-plan if anything other than `packages/client-core/src/timeline/timeline-auto-expand.ts` matches.
   - Stop and re-plan if `packages/client-core/package.json` is no longer `"private": true`.
   - Stop and re-plan if `ThreadTimelineRows.tsx` no longer uses `collectLiveTimelineExpansionRowIds`.
   - Check `git status` and the file's own diff for uncommitted foreign edits to `timeline-auto-expand.ts`. Work around them as the repository's AGENTS.md requires, and do not overwrite them.
2. **No new behavioural evidence is needed,** because no runtime path reaches the code. The existing app test `timeline-auto-expand.test.ts` stays the guard for `isRowExpandable` and the live policy.
3. **Edit `packages/client-core/src/timeline/timeline-auto-expand.ts`:**
   - Remove `findTimelineFrontierRow,` from the `@omnyo/thread-view` import on line 3. Keep `assertNever`, `hasTimelineExplorationIntent`, `isTimelineActivityRow`, `type ThreadTimelineViewRow`, `type TimelineViewWorkRow` and `type TimelineWorkSummaryChild`. `TimelineViewWorkRow` is still used by `isWorkRowExpandable`.
   - Delete the interfaces `CollectTimelineAutoExpansionRowIdsArgs` and `TimelineAutoExpansionRowIds` (lines 12–19) and the blank line after them.
   - Delete everything after `isNonExpandableSummary` (lines 98–190): `shouldAutoExpandLiveFrontierRow`, `visitForLiveFrontierAutoExpand`, `visitRecentWorkRows` and `collectTimelineAutoExpansionRowIds`. The file should end with the closing brace of `isNonExpandableSummary`.
   - Leave `packages/client-core/src/index.ts:57` unchanged, because the file still exports `isRowExpandable` and `isNonExpandableSummary`.
4. **Format** the edited file with the repository formatter: from the repository root, run `pnpm exec oxfmt packages/client-core/src/timeline/timeline-auto-expand.ts`.
5. **Inspect the diff** with `git diff -- packages/client-core/src/timeline/timeline-auto-expand.ts`. Confirm that it only deletes lines, plus the one-name import change. Recount the lines with `wc -l` and expect 87 lines, give or take formatting.

**Verification and acceptance criteria**

All commands below come from the snapshot's `package.json` files. They were confirmed to exist but were not run, because the snapshot has no `node_modules`.

- From `packages/client-core`, run `pnpm typecheck` (`tsc --noEmit`). It must pass, which proves nothing inside the package referenced the removed symbols.
- From `apps/app`, run `pnpm typecheck` (`tsc --noEmit && tsc --noEmit -p tsconfig.node.json`). It must pass, which proves the main consumer of the client-core barrel needed none of the removed exports.
- From `apps/app`, run `pnpm exec vitest run --config vitest.config.ts src/components/thread/timeline/timeline-auto-expand.test.ts src/components/thread/timeline/PreviewActivityRow.test.tsx`. Both must pass unchanged, which covers `isRowExpandable` and the surviving live policy.
- From the repository root, run `pnpm exec oxfmt packages/client-core/src/timeline/timeline-auto-expand.ts --check` and `pnpm exec oxlint --deny-warnings --format=agent packages/client-core/src/timeline/timeline-auto-expand.ts`. Both must report clean. The root `lint` script is `turbo run lint`, and `packages/client-core` has no `lint` script of its own, so run oxlint on the file directly.
- Optional, before a release: run the root `pnpm typecheck` (`turbo run typecheck`) to cover every workspace package that imports `@omnyo/client-core`. This is not required for this dev change.
- No visual, interaction or performance comparison is needed, because no rendered behaviour changes.

**Rollback and stop conditions**

- **Rollback:** revert the single commit. The change touches one file and has no data, migration or API effects.
- **Stop conditions:**
  - Step 1 finds a caller, a plugin or external consumer, or a published export of `@omnyo/client-core`.
  - Typecheck in any workspace fails on a removed symbol. That would mean a consumer this card missed: restore the code and re-plan.
  - Someone has foreign uncommitted edits in `timeline-auto-expand.ts` that touch the dead functions, which suggests active work intends to wire them.
  - Alex says he wants the frontier policy back. That turns the item into a product decision rather than a deletion.
