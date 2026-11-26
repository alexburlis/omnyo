# RF-017 — Retire the GitHub Actions planning, sharding, cache-hygiene, CI-health, NUL-check and nightly-version tooling that no workflow in this repository runs (or publish the workflows that run it)

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The central claim holds, but the scope differs from both sweep reports. The provider-literal ratchet is live and stays: the default `@omnyo/scripts` test suite runs it against the real repository. The npm version guard is handled separately in RF-113.
- **Potential:** medium. About 1,240 handwritten tooling lines, 170 lines of JSON data and about 1,200 net test lines leave active maintenance. One hostless subsystem disappears, and five `@omnyo/scripts` tests that cannot pass at this snapshot are removed.
- **Confidence:** high that nothing in this repository invokes the scripts. Unknown: whether the retired private repository `alexburlis/omnyo-private` still runs GitHub Actions. Verifying that needs network access, which this audit did not use.
- **Readiness:** decision-needed. Alex must choose one of two options. Option B (retire) is the recommended default. Option A (publish CI) is new infrastructure, includes a push, and may spend on paid runners.
- **Effort:** Option B takes about 2 to 3 hours: deletions, one test relocation, documentation edits and one run of the `@omnyo/scripts` tests. Option A takes half a day to a day, plus a secret review and push authority.
- **Risk:** low for Option B. No product, build, release or runtime path loads these files. Two costs remain. First, a future public CI would have to restore the tooling from Git history or from the private checkout. Second, a selective upstream backport that touches these files would land as a modify/delete conflict.
- **Prerequisites:** the owner's decision between Option A and Option B. A separate decision on the public contributor policy that `CONTRIBUTING.md` describes; see the end state below.
- **Related and overlapping items:**
  - RF-113 deletes `packages/plugin-sdk/scripts/check-npm-version-guard.mjs`, which is dead under either option. Do not delete it twice.
  - RF-020 edits other entries in `turbo.json`. Coordinate the `@omnyo/scripts#test` input edit with it to avoid a merge conflict.
  - RF-112 touches the desktop nightly release-channel identity. This card removes only the GitHub-run nightly version stamper and keeps the nightly build variant.
  - RF-059 removes the harness-efficiency reporter from `@omnyo/scripts`. That is the same package but different files.
  - Incidental issue ISS-S20-001 / ISS-X2-001: the `@omnyo/scripts` suite fails at this snapshot because some tests read `.github` files that do not exist. Either option resolves it.
- **Why it deserves its place:** this subsystem has no runner in this repository. It still forces coordination on ordinary changes: `scripts/plan-ci.mjs` hard-codes package path regexes, `scripts/ci-test-shards.json` must track the package list, and `turbo.json` lists `.github` inputs. It also keeps the default test task red. The deletion is mechanical and its reachability proof is strong.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The named read-only worktree was not present on disk. Every path below was therefore read with `git -C $OMNYO_CHECKOUT show e9e1b74c3:<path>` and `git grep ... e9e1b74c3`.

*What the subsystem is.* Upstream bb (get-bb/bb) runs its CI on GitHub Actions. Its workflows call a set of Node scripts:

- a planner that decides which jobs and test shards a pull request needs;
- a shard table;
- Turbo-cache pruning and Actions-cache retirement;
- a CI-health reporter;
- a literal-NUL-byte guard;
- a nightly version stamper.

Omnyo inherited the scripts but not the workflows.

*Observed facts (Proven by inspection):*

1. **No `.github` directory exists in this repository's lineage.**
   - `git ls-tree -r --name-only e9e1b74c3 | grep -c '^\.github'` prints `0`.
   - `git ls-tree --name-only origin/main .github` prints nothing.
   - `git log e9e1b74c3 -- .github` prints nothing, so no `.github` file was ever deleted along this history.
   - The public history is rooted at `060950255` "Publish Omnyo source" (2026-11-24).
   - `.gitignore` does not exclude `.github`.
2. **The workflows exist only in the retired private checkout.** In `$ARCHIVED_OMNYO_CHECKOUT/.github` (remote `alexburlis/omnyo-private`, last `.github` change `074473fa4a` on 2026-11-11), a grep for `scripts/*.mjs` lists the invocations below.

   | Private workflow file | Scripts it invokes |
   |---|---|
   | `workflows/ci.yml` | `plan-ci.mjs`, `ci-comparison-base.mjs`, `ci-dependencies-changed.mjs`, `check-actions-cache-usage.mjs`, `check-source-nul.mjs`, `check-provider-literal-ratchet.mjs`, `check-plugin-forks.mjs`, `check-npm-version-guard.mjs` |
   | `workflows/ci-cache-maintenance.yml` | `cleanup-actions-caches.mjs` |
   | `workflows/ci-health.yml` | `report-ci-health.mjs` |
   | `workflows/publish-bb-app.yml` | `prepare-nightly-version.mjs` (two calls) |
   | `actions/cache-workspace/action.yml` and others | `prune-turbo-cache.mjs` (12 calls) |

   Private releases do not depend on that CI. The private `AGENTS.md` (line 48) says `private:ship` publishes locally through `scripts/private-ship-coordinator.mjs`.
3. **The scripts have no consumer in this repository other than their own tests.** The command was `git grep -n -F <basename> e9e1b74c3` for each basename across the whole tree, with each file's own path excluded. A second pass excluded `scripts/` and `packages/scripts/test`; its only hit was `.gitignore:107` `.ci-health/`. The hits are:
   - `packages/scripts/test/ci-selection.test.mjs:122,221,255,269,291,321` runs `plan-ci`, `ci-dependencies-changed` and `ci-comparison-base`. Lines 81-82 read `scripts/ci-test-shards.json`.
   - `packages/scripts/test/ci-performance.test.mjs:15-18` imports `scripts/lib/actions-cache.mjs`, and line 375 runs `prune-turbo-cache.mjs`.
   - `packages/scripts/test/actions-api.test.mjs:63,151` loads `lib/actions-cache.mjs` and `report-ci-health.mjs`.
   - `packages/scripts/test/ci-health.test.mjs:6` imports `scripts/lib/ci-health.mjs`.
   - `packages/scripts/test/bump-version.test.mjs:16-19` imports `deriveNightlyVersion` and `prepareNightlyVersion` from `scripts/prepare-nightly-version.mjs`. Its `describe("prepare-nightly-version")` block spans lines 181-220.
   - `check-actions-cache-usage.mjs`, `cleanup-actions-caches.mjs` and `check-source-nul.mjs` have no reference anywhere, not even in a test.
   - Imports among the files stay inside the set: `check-actions-cache-usage`, `cleanup-actions-caches` and `report-ci-health` import `./lib/actions-cache.mjs`, and `report-ci-health` also imports `./lib/ci-health.mjs`.
   - `scripts/plan-ci.mjs:13` reads `scripts/ci-test-shards.json`.
   - `prepare-nightly-version.mjs:3` imports the live `./bump-version.mjs`, which is kept.
   - Searched and not found: root `package.json` scripts, `packages/scripts/package.json`, `turbo.json` task commands, `scripts/test-modes.mjs` (no `shard`, `GITHUB` or `plan` reference), the `omnyo-*-map.mjs` rename maps, and `packages/scripts/vitest.config.ts`. That vitest config includes `test/**/*.test.{ts,mjs}` by glob only.
4. **Five tests read `.github` files that are absent, so they cannot pass here** (Proven by inspection; no `node_modules`, so nothing was run):
   - `packages/scripts/test/ci-workflow.test.ts:20-22` calls `readFileSync` on `.github/workflows/ci.yml`, which throws ENOENT. Lines 48-51 run `bash` on `.github/actions/setup-workspace/install-pnpm.sh`. A missing script exits with 127, and the test expects 1.
   - `packages/scripts/test/pr-approval-workflows.test.ts:10-12` reads `.github/workflows/pr-gate.yml` in both of its tests.
   - `packages/scripts/test/ci-performance.test.mjs:44-50` and `:110-116` run `.github/actions/setup-workspace/install-dependencies.sh`.
5. **Turbo and the docs reference the missing CI.**
   - `turbo.json:593-597` and `:600-602` list eight `$TURBO_ROOT$/.github/...` inputs for `@omnyo/scripts#test`.
   - `CONTRIBUTING.md:5-13` describes a PR gate and `.github/APPROVED_CONTRIBUTORS`.
   - `docs/platform-support.md:220-245` ("CI And Validation") describes GitHub Actions jobs and branch protection. It links `windows-ci.md`, which does not exist (`git ls-tree --name-only e9e1b74c3 docs/` has no CI file). Line 218 also mentions "Windows CI jobs".
   - `docs/forkable-plugins.md:35-39` describes PR plugin selection and links `ci-performance.md`, which does not exist.
   - `apps/desktop/README.md:299-304` already says "`publish-bb-app.yml` runs only in that repository [upstream]". That is the repository's own statement that `prepare-nightly-version.mjs` is upstream-only here.
   - `apps/mobile/README.md:348-366` and `:615-640` describe `.github/workflows/mobile-*.yml` jobs.

*Corrections to the sweep reports:*

- **Keep `scripts/check-provider-literal-ratchet.mjs` (379 lines) and `scripts/provider-literal-baseline.json` (36 lines). They are live.** `packages/scripts/test/provider-literal-ratchet.test.mjs:328-335` ("ratchet CLI (against the real repo baseline)") runs the script against the repository and fails if core gains provider-ID literals. That test belongs to the default `@omnyo/scripts` test task, so the guard is enforced without CI. Report RF-S20-003 was wrong to include it. Report X2-RF-001 was right to keep it.
- **`check-npm-version-guard.mjs` (360 lines) and its 200-line test belong to RF-113.** They are excluded here.
- **Keep `scripts/check-plugin-forks.mjs` and `scripts/lib/ci-plugin-forks.mjs`.** The root script `check:plugin-forks` (`package.json:40`) uses them, and `docs/forkable-plugins.md` documents `--shard`, `--list` and `--changed-from`. Their unique coverage lives in `ci-performance.test.mjs:173-213` and `:215-276`, and it must be relocated rather than deleted.
- Also keep `bump-version.mjs` and `bump-plugin-sdk.mjs`, which the release docs use; `test-modes.mjs`, which implements `pnpm test`; and `lib/semver.mjs` and `lib/package-version.mjs`.

*Line counts.* Command: `git show e9e1b74c3:<path> | wc -l` for each file.

| File | Lines | Kind |
|---|---:|---|
| `scripts/plan-ci.mjs` | 215 | tooling |
| `scripts/ci-comparison-base.mjs` | 27 | tooling |
| `scripts/ci-dependencies-changed.mjs` | 25 | tooling |
| `scripts/check-actions-cache-usage.mjs` | 27 | tooling |
| `scripts/cleanup-actions-caches.mjs` | 71 | tooling |
| `scripts/prune-turbo-cache.mjs` | 190 | tooling |
| `scripts/report-ci-health.mjs` | 50 | tooling |
| `scripts/lib/ci-health.mjs` | 346 | tooling |
| `scripts/lib/actions-cache.mjs` | 178 | tooling |
| `scripts/check-source-nul.mjs` | 32 | tooling |
| `scripts/prepare-nightly-version.mjs` | 81 | tooling |
| **Handwritten tooling subtotal** | **1,242** | none of it ships in a product |
| `scripts/ci-test-shards.json` | 170 | data |
| `packages/scripts/test/ci-selection.test.mjs` | 341 | test |
| `packages/scripts/test/ci-health.test.mjs` | 205 | test |
| `packages/scripts/test/actions-api.test.mjs` | 185 | test |
| `packages/scripts/test/ci-workflow.test.ts` | 67 | test |
| `packages/scripts/test/pr-approval-workflows.test.ts` | 89 | test |
| `packages/scripts/test/ci-performance.test.mjs` | 405 | test (104 lines relocated) |
| `bump-version.test.mjs` nightly block and its import | about 44 | test |

*Counterevidence considered.*

- Commit `936dfbf98` carries `[skip ci]`. The other `[skip ci]` commits (`cba169612` and earlier, PR #4560-#5183) come from the merged upstream lineage. The marker suggests a habit or an intent to run CI, but nothing in this tree consumes it.
- `CONTRIBUTING.md` describes a live PR gate. This is the strongest sign that public CI may be intended, and it is why the item is decision-needed rather than ready.

*Maintenance cost today.* Several kinds of change force edits to tooling that no job reads:

- a package rename or a new UI package means `scripts/plan-ci.mjs:142-152` regexes must change;
- a new test package means `scripts/ci-test-shards.json` must change;
- any `.github` path must be mirrored in `turbo.json`.

Meanwhile `pnpm test` reports five failures, which hides real regressions in `@omnyo/scripts`.

**Proposed end state and preservation argument**

*Option B, retire (recommended default; needs the owner's choice).*

What disappears:
- the 11 tooling files and `scripts/ci-test-shards.json`;
- `ci-selection.test.mjs`, `ci-health.test.mjs`, `actions-api.test.mjs`, `ci-workflow.test.ts` and `pr-approval-workflows.test.ts`;
- `ci-performance.test.mjs`, after its two plugin-fork cases are relocated;
- the `prepare-nightly-version` block in `bump-version.test.mjs`;
- the eight `.github` inputs in `turbo.json`;
- the `.ci-health/` line at `.gitignore:107`;
- documentation that describes CI this repository lacks.

What remains:
- `check:plugin-forks` with every option it has today;
- the provider-literal ratchet and its test;
- `bump-version.mjs` and its tests;
- the desktop nightly build variant (`OMNYO_DESKTOP_RELEASE_CHANNEL=nightly`, `apps/desktop/README.md:321-354`).

Why behavior survives:
- No product, release (`private:ship`) or developer command invokes the deleted files.
- The only unique live coverage, `affectedPluginForks` and `check-plugin-forks --shard/--list`, moves intact.
- No persisted format, API or UI is involved.

Remaining uncertainty: an external runner outside this repository might still call these scripts. The only candidate is the private repository's Actions, and that repository does not load this tree's files.

*Option A, publish CI (alternative).* Add sanitized `.github/workflows`, `.github/actions` and `APPROVED_CONTRIBUTORS` to the public tree. The tooling becomes live and the five tests pass. This option is new infrastructure. The global rules require a demonstrated need, and this audit found none: releases run locally. It also needs:
- a secret and runner review (for example, the mobile workflow uses `blacksmith-6vcpu-macos-15`, a paid runner);
- a rewrite of the bb-named `publish-bb-app.yml`;
- push authority.

The rest of this card details Option B. Under Option A, the equivalent card would port the workflows instead.

*Coupled decision (either option).* `CONTRIBUTING.md:5-13` promises a PR approval gate. Under Option B, Alex chooses one of two wordings:
- (a) describe the manual policy ("a maintainer reviews whether to accept"), or
- (b) say that pull requests are not accepted.

Do not invent a policy. If Alex has not answered, replace only the `.github/APPROVED_CONTRIBUTORS` mechanics with "a maintainer approves you", keep the approval requirement, and flag the change in the report.

*Optional retention within Option B.* If Alex wants the literal-NUL guard enforced, convert `check-source-nul.mjs` into a test, as the ratchet already is. The default is to delete it. No in-tree failure shows that the guard is needed.

*Non-goals.*
- Do not change `check-plugin-forks.mjs` options (`--shard` and `--changed-from` stay).
- Do not touch `check-provider-literal-ratchet.mjs` or `check-npm-version-guard.mjs` (RF-113).
- Do not touch the desktop nightly channel identity (RF-112).
- Do not rewrite the mobile README beyond removing claims about workflows that do not exist.

**Expected gain and cost**

These are projections from the counts above, not measurements.

| Item | Before | After (Option B) |
|---|---:|---:|
| Handwritten tooling lines | 1,242 | 0 |
| JSON shard data | 170 | 0 |
| Test lines | about 1,336 | about 116 relocated, so about 1,220 net removed |
| `turbo.json` `.github` inputs | 8 | 0 |
| `@omnyo/scripts` tests that cannot pass | 5 | 0 |
| Mechanisms | CI planner, shard map, Turbo-cache pruning, Actions-cache retirement, CI-health reporter, NUL guard, nightly stamper | none |

The 1,336 test lines are the five whole files, the 405-line `ci-performance.test.mjs` and about 44 nightly lines. The 116 relocated lines are the two plugin-fork cases plus imports.

Documentation shrinks or is corrected in five files, by roughly 40 to 60 lines.

Causal link: once these files are gone, a package or path change no longer needs edits to `plan-ci.mjs` regexes, the shard table or the `.github` inputs. The default `@omnyo/scripts` suite also goes green, so its failures will be meaningful again.

Cost: restoring public CI later means reviving these files from Git, either `git show e9e1b74c3:<path>` or the private checkout. A selective upstream backport that touches them would conflict. `docs/upstream-credits.md` shows that backports are cherry-picked feature changes, so such conflicts are expected to be rare.

Performance: product runtime is unaffected. The `@omnyo/scripts` test task gets shorter; the amount was not measured.

**Execution steps**

Investigation gate (do this before any edit):

1. Get the owner's choice: Option A, Option B, or Option B with the NUL guard kept as a test. Also get the `CONTRIBUTING.md` wording (a) or (b). Stop and re-plan for Option A.
2. Reconfirm the snapshot facts on the working base. Re-plan if any check shows a new consumer.
   - Run `git ls-tree -r --name-only HEAD | grep '^\.github'`. Expect no output. If `.github` now exists, stop: Option A is in effect.
   - Run `git grep -n -E "plan-ci|ci-comparison-base|ci-dependencies-changed|check-actions-cache-usage|cleanup-actions-caches|prune-turbo-cache|report-ci-health|lib/ci-health|lib/actions-cache|check-source-nul|prepare-nightly-version|ci-test-shards|\.ci-health" HEAD`. Every hit must be in the files this card deletes or edits.
   - Check that `packages/scripts/test/provider-literal-ratchet.test.mjs` still contains the real-repo describe block. If it does not, the ratchet's status changes and this card stays silent on it.
   - Check whether RF-113 or RF-020 has already landed, and rebase the `turbo.json` edit if so.

Checkpoint 1, relocate the unique coverage (a mechanical move):

3. Create `packages/scripts/test/ci-plugin-forks.test.mjs` containing, unchanged, the two cases from `ci-performance.test.mjs:173-213` ("checks both sides of plugin renames ...") and `:215-276` ("partitions fork checks ..."). Bring the imports they need: `execFileSync` and `spawnSync` from `node:child_process`; `mkdirSync`, `mkdtempSync`, `rmSync` and `writeFileSync` from `node:fs`; `tmpdir` from `node:os`; `join` from `node:path`; `fileURLToPath` from `node:url`; `expect`, `it` and `onTestFinished` from `vitest`; and `affectedPluginForks` from `../../../scripts/lib/ci-plugin-forks.mjs`. Keep the `30_000` timeout on the second case. Appending the cases to `plugin-forks.test.mjs` also works. A separate file keeps the move reviewable.

Checkpoint 2, delete the hostless tooling:

4. Delete these scripts: `scripts/plan-ci.mjs`, `scripts/ci-comparison-base.mjs`, `scripts/ci-dependencies-changed.mjs`, `scripts/check-actions-cache-usage.mjs`, `scripts/cleanup-actions-caches.mjs`, `scripts/prune-turbo-cache.mjs`, `scripts/report-ci-health.mjs`, `scripts/lib/ci-health.mjs`, `scripts/lib/actions-cache.mjs`, `scripts/check-source-nul.mjs` (unless it is kept as a test), `scripts/prepare-nightly-version.mjs` and `scripts/ci-test-shards.json`.
5. Delete these tests: `packages/scripts/test/ci-selection.test.mjs`, `ci-health.test.mjs`, `actions-api.test.mjs`, `ci-workflow.test.ts`, `pr-approval-workflows.test.ts` and `ci-performance.test.mjs` (its plugin-fork cases were moved in step 3).
6. In `packages/scripts/test/bump-version.test.mjs`, remove the import of `deriveNightlyVersion` and `prepareNightlyVersion` (lines 16-19) and the `describe("prepare-nightly-version", ...)` block (lines 181-220). Keep any helper such as `createTestRepo` or `readVersion` that the `bump-version` block still uses. Delete a helper only if nothing else references it.

Checkpoint 3, configuration:

7. In `turbo.json`, under the `"@omnyo/scripts#test"` `inputs` (lines 593-597 and 600-602), remove the eight `$TURBO_ROOT$/.github/...` entries. Keep `$TURBO_ROOT$/scripts/*.mjs`, `scripts/lib/**` and `scripts/forkable-plugins.json`.
8. In `.gitignore`, remove line 107 `.ci-health/`.

Checkpoint 4, documentation (keep the wording minimal and factual):

9. `docs/forkable-plugins.md:35-39`: replace the paragraph with one sentence about local selection: `--changed-from=<sha> --list` shows which listed plugins a change touches. Drop the broken link to `ci-performance.md`.
10. `docs/platform-support.md:220-245` ("CI And Validation"): replace the GitHub Actions claims with what the repository actually runs locally. For example: "This repository runs no hosted CI. Validate with `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm format:check`; Windows and mobile end-to-end checks are manual." Remove the dead `windows-ci.md` link. Reword line 218 "the Windows CI jobs" to "Windows builds".
11. `CONTRIBUTING.md:5-13`: apply the wording Alex chose in step 1.
12. `apps/desktop/README.md:299-319`: keep the "Upstream get-bb/bb publishes this channel" framing. Delete only sentences that describe deriving a nightly version in this repository, if any remain. Keep the coexistence rules and the build variable.
13. `apps/mobile/README.md:348-366` and `:615-640`: mark the `.github/workflows/mobile-*.yml` descriptions as upstream-only, or remove them. Keep the manual `node scripts/testflight-distribute.mjs` instructions, because that script is not part of this card. Check first that it exists at HEAD.

Step 14, closeout:

14. Search again with the step 2 `git grep`. Expect hits only in the 2026-11-26 audit documents and in `upstream-credits`-style history text. Review the complete diff for unrelated changes. Recount the deleted lines with `git diff --stat` against the base.

**Verification and acceptance criteria**

The working directory is the repository root of the implementation worktree, with dependencies installed. These script names exist in the snapshot's `package.json` files. The commands could not be run in this audit, because the snapshot has no `node_modules`.

- `pnpm --filter @omnyo/scripts test` runs `vitest run --config vitest.config.ts` from `packages/scripts/package.json`. Expected result: it passes. In particular:
  - `ci-plugin-forks.test.mjs` runs both relocated cases;
  - `provider-literal-ratchet.test.mjs` still passes, including its real-repo case;
  - `bump-version.test.mjs` passes without the nightly block.
- `pnpm check:plugin-forks --list` (root `package.json:40`) prints the same JSON plugin list as before the change. Compare against the output from the base commit.
- `pnpm exec turbo run test --filter=@omnyo/scripts --dry=json` (Turbo's dry-run flag; confirm it works with the installed Turbo version) shows that the task resolves with no `.github` inputs.
- `pnpm format:check` and `pnpm lint` (root scripts) pass for the edited files, and `pnpm typecheck` covers the `.ts` test removal. Per the repository's Oxc policy, `pnpm exec oxfmt <changed files>` formats the edited Markdown and JSON.
- Structural completion:
  - the step 2 `git grep` returns no live references;
  - no file under `scripts/` imports a deleted module;
  - `scripts/lib/` keeps `ci-plugin-forks.mjs`, `plugin-fork.mjs`, `semver.mjs`, `package-version.mjs` and `semantic-comment.mjs`.
- No UI, persisted data or performance budget is involved, so no visual or performance comparison applies.

**Rollback and stop conditions**

Rollback: every change is a tracked-file deletion or edit inside one commit, and `git revert <commit>` restores it. No data, API or compatibility surface changes.

Stop and re-plan if any of the following holds:
- Alex chooses Option A, or a `.github` directory appears on the base.
- A consumer outside this repository is shown to fetch these scripts from the public tree. For example, a GitHub Actions workflow in another repository checks out `alexburlis/omnyo` and runs `scripts/plan-ci.mjs`. Ask the owner to check the Actions settings of `alexburlis/omnyo-private`; this audit could not.
- Removing the nightly block breaks a `bump-version` helper whose ownership is unclear.
- `provider-literal-ratchet.test.mjs` no longer runs the real-repo check. In that case, leave the ratchet out of this card and raise it separately.

Safer smaller alternative: delete only the five tests that cannot pass and the eight `turbo.json` `.github` inputs. That fixes the red suite but keeps the hostless tooling. Do this only if Alex defers the A/B decision.
