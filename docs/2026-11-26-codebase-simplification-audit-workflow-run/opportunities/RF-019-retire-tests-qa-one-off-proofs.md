# RF-019 — Retire the twelve unrun `tests/qa` proof harnesses, or give each surviving one a registered runner

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Potential:** medium. Twelve directories under `tests/qa/` hold 11,750 lines (11,251 lines of harness code, 449 lines of README and failure-mode notes, 50 lines of HTML and CSS fixtures). None of it is production code. Nothing in the repository runs any of them; a person has to type a `node` command with private paths. One harness is already broken, and three other audit cards (RF-002, RF-007, RF-101) have to edit these files to keep them consistent with refactors nobody will rerun them against.
- **Confidence:** high that nothing runs the twelve directories (Proven by inspection, searches below). Medium on which of them Alex still wants as reusable manual recipes, because that is a judgment about future verification, not a code fact.
- **Readiness:** decision-needed. Alex must sort each directory into "keep and register" or "delete". A proposed default split is in "Proposed end state" below; the five completed before-and-after comparisons and the broken harness can go with the least judgment.
- **Effort:** about 30 minutes for Alex to confirm the split, 30 minutes to delete the chosen directories and run the checks below, plus about one hour per directory that is kept and given a runner.
- **Risk:** low for the product. No build, test suite, package export, CI workflow or shipped artifact depends on these directories. The loss is the ability to rerun a manual proof from current `main`; Git keeps every file.
- **Prerequisites:** the owner's per-directory decision (step 1 gate). No other RF item must land first.
- **Related or overlapping opportunities:**
  - RF-018 (uninvoked one-off proof, benchmark and smoke harnesses elsewhere) is the same kind of retirement in other directories. The two cards share no files and can land in either order.
  - RF-002 edits `tests/qa/worker-update-checkpoint/proof.mjs:316-319` (the parcel watcher child entry). If this card deletes `worker-update-checkpoint` first, RF-002 drops that step.
  - RF-007 lists `tests/qa/private-native/proof.mjs:35-38` as an importer of `packages/server-archive/src/runtime-identity.ts`. Deleting `private-native` removes one importer RF-007 has to keep working.
  - RF-101 (derive the daemon child-bundle inventory from `bundle-manifest.mjs`) would otherwise leave `tests/qa/worker-update-checkpoint/proof.mjs` as a hand-copied inventory.
  - RF-005 and RF-006 (BB-era desktop continuity and identity adoption) touch the same lifecycle that `private-native` seeds as `"seeded-legacy-migration"` (`tests/qa/private-native/proof.mjs:243`).
- **Why it deserves its place:** it removes the largest block of unrun harness code in the repository. Every repository-wide rename, refactor or format run walks these files, and the composer-predictions harness shows they break silently. The change is a deletion, not a move.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The snapshot worktree named in the audit brief no longer existed when this card was written, so every file was read with `git show e9e1b74c3:<path>` and searched with `git grep <pattern> e9e1b74c3` from `$OMNYO_CHECKOUT`. No harness or test was run: the snapshot has no `node_modules`, and the harnesses need an external Playwright module, Chrome, a packaged macOS app or a pinned Codex binary.

*What the subsystem is.* `tests/qa` is the workspace package `@omnyo/qa` (`tests/qa/package.json`). Its maintained parts are `src/` (the standalone QA server, run by the root scripts `qa:standalone:start`, `qa:standalone:stop` and `qa:standalone:cleanup` at `package.json:46-48` through `tests/qa/scripts/run-root-command.mjs`), and `test/` (four vitest files). Its `test` script is `vitest run --config vitest.config.ts`, and `tests/qa/vitest.config.ts` includes only `test/**/*.test.ts`. Its `typecheck` script uses `tests/qa/tsconfig.json`, which includes only `./src/**/*.ts`, `./test/**/*.ts` and `vitest.config.ts`. The package has no `lint` script, so `turbo run lint` skips it. `docs/platform-support.md:154` lists "workspace-owned QA helpers under `tests/qa/`" as a maintainer-only or best-effort surface, not a supported product surface.

Beside `src/` and `test/`, fourteen directories each hold a single-feature proof harness. Two of them have a runner: `apps/server/test/performance/frontend-loading.test.ts:246` and `:265` import `tests/qa/plugin-loading/inventory.mjs` and `proof.mjs` when `OMNYO_FRONTEND_PLUGIN_INVENTORY` or `OMNYO_FRONTEND_PLUGIN_LOADING_PROOF_OUTPUT` is set, and `:327` imports `tests/qa/sidebar-rail/proof.mjs` when `OMNYO_FRONTEND_SIDEBAR_PROOF_OUTPUT` is set. Even those are opt-in: the whole test is `it.skipIf(!process.env.OMNYO_FRONTEND_MEASUREMENT_OUTPUT)` at `:35` and takes an external Playwright module from `OMNYO_FRONTEND_PLAYWRIGHT_MODULE` (`:38`). They are out of scope for this card.

The other twelve have no runner.

*Line counts (Proven by inspection).* Command, from `$OMNYO_CHECKOUT`: for each directory, `git ls-tree -r --name-only e9e1b74c3 tests/qa/<dir>` and `git show e9e1b74c3:<file> | wc -l` summed over its files. The totals match the sweep report exactly.

| Directory | Files | Lines | What it is (from its README, failure-mode notes or arguments) | Proposed default |
| --- | --- | --- | --- | --- |
| `loading-simplification` | 8 | 1,004 | "compare the real app loader before and after removing automatic warming" (`README.md`). Step 1 freezes the original `split-prefetch.ts` and `web-asset-prefetch.ts`; neither file exists at the snapshot. | Delete (completed comparison) |
| `latency-simplification` | 6 | 984 | "Latency comparison" against "frozen production UI files" (`README.md`); the `before` profile reproduces the old `Vary: Origin` static response. | Delete (completed comparison) |
| `question-submission` | 1 | 200 | `proof.mjs:11` takes `mode, output, baseline`; `:23` asserts "Supply the original question-form.tsx" and builds `before` and `after` sides. | Delete (completed comparison) |
| `instant-chat-history` | 4 | 2,318 | `service-proof.mts:43` switches on `--after` and names `baseline-service` and `calibrated-service-before` runs. `worker-lifecycle-proof.mts` (628 lines) asserts current limits (for example `promotionMs <= 500` at `:219`). | Delete (mostly a completed comparison; see the decision note) |
| `composer-predictions` | 2 | 975 | Native Codex prediction proof. Broken; see below. | Delete (broken) |
| `asset-loading` | 2 | 421 | "Asset loading browser proof" of the production asset-cache helper and `defineSplit` recovery (`FAILURE-MODES.md`). | Owner choice |
| `chat-scroll` | 3 | 898 | Timeline scroll fixture with older-page requests (`run.mts`). | Owner choice |
| `chat-ux` | 1 | 451 | Mounts current composer and timeline components (`proof.mjs:31-36`) and checks heights and actions. | Owner choice |
| `failed-state` | 1 | 350 | Mounts `ThreadInboxReason` and `HomeOrientation` and checks failed-state colors (`proof.mjs:261-315`). | Owner choice |
| `inline-mobile` | 6 | 696 | "Inline preview browser proof" at five viewports; its README calls it "the reusable proof". | Owner choice; most reusable of the browser proofs |
| `private-native` | 3 | 1,964 | "Omnyo packaged native lifecycle proof" of the `dev.omnyo.private` bundle (`README.md`). | Owner choice; reusable for desktop release checks |
| `worker-update-checkpoint` | 4 | 1,489 | "Worker update checkpoint process proof" of the launcher, worker update and SQLite migration (`README.md`). | Owner choice; reusable for update-protocol changes |
| **Total** | **41** | **11,750** | | Default split: 5,481 delete, 6,269 owner choice |

*No runner exists (Proven by inspection).* Searches, all at the snapshot from `$OMNYO_CHECKOUT`:

- `git grep -n "qa/<dir>" e9e1b74c3 -- ':!tests/qa/<dir>'` for each of the twelve names finds one hit in total: `tests/qa/loading-simplification/README.md:45` mentions `tests/qa/asset-loading/proof.mjs`. That is another harness's README, not a runner.
- `git grep -l -F "<dir>/" e9e1b74c3 -- ':!tests/qa'` finds only `plugins/composer-predictions/...` paths, which are the plugin, not the harness.
- `git grep -n -E "tests/qa|@omnyo/qa" e9e1b74c3 -- ':!tests/qa'` finds the `frontend-loading.test.ts` lines above, `package.json:46-48`, `docs/platform-support.md:154`, `pnpm-lock.yaml:5957`, the unrelated `apps/app/tests/qa/orca-visual-workflow` and a stale `tests/qa/unread-native/proof.mjs` entry in `scripts/omnyo-renderer-map.mjs:407` (that directory does not exist; RF-012 retires the file).
- `git grep -n -E "tests/qa|qa/" e9e1b74c3 -- turbo.json .github` finds nothing; `.oxlintrc.json:330` only relaxes rules for `**/tests/**`.
- `tests/qa/test/*.test.ts` and `tests/qa/src/**` mention none of the twelve names (`grep -rn` over the extracted files).
- Outside the repository: `rg -l -F 'tests/qa/'` over `$HOME/.agents`, `$HOME/.codex/skills`, `$HOME/.claude/skills`, `.claude` and `$OMNYO_PLUGIN_CHECKOUT` finds nothing. No verification skill names these harnesses. A skill or note outside those locations could still mention them; that check was not possible.

*Maintenance cost (Proven by inspection).* Every one of the twelve directories has exactly one commit in the public history, `060950255` "Publish Omnyo source" (2026-11-24); none has been edited since, while the source they import has moved:

- `tests/qa/composer-predictions/proof.mjs:349` imports `predictNative` from `../../../plugins/account-pool/src/prediction-runner.ts`, and `:375` hashes the same file. That file was deleted by `e941d383a` "Use pooled Codex subscriptions for composer predictions" (2026-11-24) and does not exist at the snapshot. `:351` also imports `composerPredictionBody` from `plugins/account-pool/src/prediction-contract.ts`, which no longer exports that name (`git grep composerPredictionBody e9e1b74c3` finds only the harness and its `FAILURE-MODES.md:17`). The harness also hard-codes `/Users/developer/bin` and `/Users/developer/.codex/bin/redact-stream` (`:142`) and requires `codex-cli 0.163.0` (`:370`). It fails at import on any machine. The prediction contract it guarded is now covered by `plugins/account-pool/src/prediction-contract.test.ts`, `plugins/account-pool/src/composer-predictions.test.ts` and `apps/server/test/services/plugins/composer-predictions-retry.integration.test.ts`.
- A resolver over every relative import literal in the twelve directories, with named-export checks for the harnesses that import repository modules (a `python3 -I` script over `git show` output), found no other missing file or export. The `./src/...` imports in `chat-ux/proof.mjs` and `failed-state/proof.mjs` resolve against `apps/app/src`, and all of their named imports are still exported there.
- Other refactors must edit these files to keep them current: RF-002 changes `tests/qa/worker-update-checkpoint/proof.mjs:316-319`, and RF-007 must keep `tests/qa/private-native/proof.mjs:35-38` working. Nothing tells the author of such a refactor whether the harness still runs.
- The harnesses are not typechecked (`tests/qa/tsconfig.json` include list) or linted (no `lint` script), so nothing catches a break like composer-predictions. They are formatted by the root `oxfmt .` (`package.json` script `format`).

*Where the history lives.* The public repository squashed their history into `060950255`. The original authoring commits survive in the retired private store at `$ARCHIVED_OMNYO_CHECKOUT`, for example `bb655a062f` "Recover verified Codex composer prediction fixes" (2026-10-15), `276e055c10` (private-native, 2026-10-13), `fcdbab1e20` (worker-update-checkpoint, 2026-10-26), `e3292bab16` (loading-simplification, 2026-11-16) and `4379fe6321` (instant-chat-history, 2026-10-18). The evidence the harnesses produced was written to task scratch directories, never to the repository, so deleting a harness removes the ability to rerun it, not any recorded result.

*Counterevidence.* Several harnesses are written as reusable recipes, with failure modes authored in advance (`asset-loading/FAILURE-MODES.md`, `composer-predictions/FAILURE-MODES.md`, `inline-mobile/README.md`, `private-native/README.md`, `worker-update-checkpoint/README.md`). `private-native` and `worker-update-checkpoint` cover contracts that the README says no other test covers ("The existing `smoke-packaged-app.mjs` attaches a fake HTTP server and cannot cover these contracts"). Those are the strongest candidates to keep.

**Proposed end state and preservation argument**

After the change, `tests/qa` keeps `src/`, `test/`, `scripts/`, `package.json`, `tsconfig.json`, `vitest.config.ts`, `plugin-loading/` and `sidebar-rail/` unchanged. Each of the twelve directories ends in exactly one of two states:

- **Deleted.** Recommended by default for the five that are completed comparisons or broken: `loading-simplification`, `latency-simplification`, `question-submission`, `instant-chat-history` and `composer-predictions` (5,481 lines). Their "before" side either needs a frozen baseline that no longer exists in the tree (`split-prefetch.ts`, `web-asset-prefetch.ts`, the original `question-form.tsx`, the pre-change history service) or, for composer-predictions, cannot import.
- **Kept with a registered runner.** For any of the seven owner-choice directories Alex keeps, a runner means one documented, discoverable entry point that names its prerequisites. These harnesses need an external Playwright module, Chrome, a packaged app or a prepared runtime, so CI cannot run them and a package script alone would still need arguments. The acceptable forms, in order of preference:
  1. An opt-in case in an existing test, as `apps/server/test/performance/frontend-loading.test.ts` does for `plugin-loading` and `sidebar-rail` (environment-variable gated, skipped by default).
  2. A reference from a repository verification skill or release checklist that already covers that area (for example a desktop release recipe for `private-native`).
  3. An `@omnyo/qa` package script, such as `"proof:worker-update-checkpoint": "node worker-update-checkpoint/proof.mjs"`, with the arguments documented in the directory README.

A kept harness must also run cleanly once at the time it is registered, so the registration does not bless a broken file.

*Preservation argument.* No product code, persisted format, API, UI or performance property changes, because no shipped package, build input or test suite reads these files (searches above). The `@omnyo/qa` package name, its scripts and its dependencies are unchanged, so `pnpm-lock.yaml` does not change. `docs/platform-support.md:154` still points to an existing `tests/qa/` directory. The two harnesses that have runners stay. The contracts that `composer-predictions` once guarded are covered by current plugin and server tests (listed above).

*Non-goals.* This card does not change `plugin-loading`, `sidebar-rail`, `src/`, `test/` or `apps/app/tests/qa/orca-visual-workflow`. It does not fix the pre-existing `tests/qa/test/runbook-contract.test.ts` failure (see the incidental findings). It does not repair `composer-predictions`; if Alex wants a native prediction proof, it should be rewritten against the current pooled-Codex runner as new work.

*Remaining uncertainty.* A manual recipe, note or agent instruction outside the searched locations could tell someone to run one of these harnesses. The step 1 gate asks Alex directly.

**Expected gain and cost**

- Observed: 11,750 lines in 41 files under twelve directories, all test and harness code (0 production lines).
- Projection for the default split: 5,481 lines in 21 files deleted with no new code. If Alex deletes all twelve, 11,750 lines in 41 files go.
- Projection for each kept harness: roughly 5 to 40 lines added (a package script, a skill reference or an environment-gated test case), plus a one-time clean run.
- Maintenance link: after the change, every remaining proof either has a named runner or is gone. Refactors such as RF-002, RF-007 and RF-101 no longer have to patch unrun files, repository-wide searches and renames stop returning stale hits, and a silent break like composer-predictions cannot recur unnoticed in a deleted file.
- Performance: neutral for the product. The root `oxfmt .` run walks fewer files.

**Execution steps**

1. **Investigation gate: get the owner's per-directory decision.** Present the table in "Context and evidence" and ask Alex to mark each of the twelve directories "delete" or "keep and register (form 1, 2 or 3)". Ask specifically whether any personal checklist, release recipe or agent instruction outside the repository runs one of them. Do not delete anything before this answer. If Alex keeps a directory, record which runner form he chose.
2. **Reconfirm the snapshot.** From the working checkout, run `git diff --stat e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e HEAD -- tests/qa apps/server/test/performance/frontend-loading.test.ts package.json docs/platform-support.md`. If any of the twelve directories changed, or a new file references them, re-read that change: a new reference means the harness gained a runner and must be re-planned. Re-run `git grep -n -E "qa/(asset-loading|chat-scroll|chat-ux|composer-predictions|failed-state|inline-mobile|instant-chat-history|latency-simplification|loading-simplification|private-native|question-submission|worker-update-checkpoint)" HEAD -- ':!tests/qa'` and expect no hits outside `tests/qa`.
3. **Check out a clean lane.** Other agents share the checkout, so work in your own worktree and confirm `git status --porcelain -- tests/qa` is empty there before editing.
4. **Delete the directories marked "delete".** Use `git rm -r tests/qa/<dir>` for each one. Also edit `tests/qa/loading-simplification/README.md:45` only if `loading-simplification` is kept while `asset-loading` is deleted (that line names `tests/qa/asset-loading/proof.mjs`).
5. **Register each kept directory** with the form Alex chose:
   - Form 1: add an environment-gated branch in the matching existing test next to the `OMNYO_FRONTEND_SIDEBAR_PROOF_OUTPUT` branch in `apps/server/test/performance/frontend-loading.test.ts`, importing the harness by `new URL("../../../../tests/qa/<dir>/<file>", import.meta.url)`. Only harnesses that accept a browser and origin fit this form; the others need form 2 or 3.
   - Form 2: add one line to the chosen verification skill or checklist naming `node tests/qa/<dir>/<entry>` and its README.
   - Form 3: add a script to `tests/qa/package.json`, for example `"proof:<dir>": "node <dir>/proof.mjs"` (use `node --conditions=source --import tsx` for harnesses whose README says so, such as `asset-loading`), and make the README's run command use it.
   Then run each kept harness once with its documented prerequisites, and keep the evidence in task scratch. If a kept harness fails against current source, stop and ask Alex whether to repair or delete it; do not change product code to make it pass.
6. **Update references.** RF-002's step for `tests/qa/worker-update-checkpoint/proof.mjs:316-319` and RF-007's importer list become obsolete if those directories are deleted; note that in the audit index or in those cards' execution, not in product code.
7. **Inspect the full diff.** `git diff --stat` must show only deletions under the chosen `tests/qa/<dir>` paths plus any registration lines from step 5. Recount the deleted lines with `git diff --numstat` against the same base and compare with the table.

**Verification and acceptance criteria**

Commands below come from `package.json` scripts read at the snapshot; none was run for this card because the snapshot has no `node_modules`.

- From the repository root: `pnpm --filter @omnyo/qa typecheck`. Expected: same result as before the change (the deleted files were never in `tests/qa/tsconfig.json`).
- From the repository root: `pnpm --filter @omnyo/qa test`. Expected: the same pass and fail set as before the change. Note that `tests/qa/test/runbook-contract.test.ts` is expected to fail both before and after, because it reads `qa/manual-runbook.md` and `qa/provider-permission-mode-runbook.md`, which are not in the public repository (see the incidental findings). Run the baseline first so this failure is not attributed to the deletion.
- From the repository root: `pnpm format:check`. Expected: no new findings.
- From the repository root, structural check: `git grep -n -E "qa/(<deleted names joined with |>)" HEAD` returns no hits, and `git ls-files tests/qa` lists only the kept directories plus `src/`, `test/`, `scripts/`, `plugin-loading/`, `sidebar-rail/` and the package files.
- For each kept harness: its registered runner exists (the script in `tests/qa/package.json`, the skill reference or the gated test branch), and one clean run with its documented prerequisites passed after registration.
- `apps/server/test/performance/frontend-loading.test.ts` is untouched unless form 1 was chosen. If it was touched, run it once with the new environment variable set and once without (it must stay skipped by default). The exact invocation depends on the external Playwright module path; label it unverified.

**Rollback and stop conditions**

- Rollback: each deletion is a plain tracked-file removal in one commit; `git revert <commit>` or `git checkout <base> -- tests/qa/<dir>` restores a directory. The files also remain in `060950255`, in `e9e1b74c3` and, with full authoring history, in `$ARCHIVED_OMNYO_CHECKOUT`. There is no data or compatibility impact.
- Stop if Alex names an outside recipe, checklist or agent instruction that runs one of the directories: keep that directory and register it instead.
- Stop if step 2 finds a new in-repository reference to a directory marked for deletion.
- Stop and ask if a kept harness fails its registration run; offer "repair as separate work" or "delete" rather than editing product code.
- Smaller safe alternative if Alex wants to defer the sorting: delete only `composer-predictions` (975 lines), which cannot run at all and whose contract is covered by current tests.
