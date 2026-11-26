# RF-059 — Delete the unused offline harness-efficiency reporter and its second `@omnyo/scripts` build step

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** confirmed. The reporter is self-contained developer tooling from a finished October 2026 experiment. Nothing in the repository invokes it, and its own results document says the experiment changed nothing in the product.
- **Potential:** medium. About 1,105 lines of handwritten developer-tooling source, 598 test and fixture lines, and one extra esbuild step in every `@omnyo/scripts` build disappear. The code does not ship in any product surface, so the gain is in maintenance, typecheck and test time, not in runtime behavior.
- **Confidence:** high. All consumers were found by inspection. The lib file imports nothing, and nothing outside its own command and test imports it.
- **Readiness:** decision-needed. This is one yes/no question for Alex: "Will the harness-efficiency experiment be rerun with this reporter?" If the answer is no, the change is mechanical.
- **Effort:** under one hour, plus one `@omnyo/scripts` build, typecheck and test run.
- **Risk:** low. The only invocation path is a manual `node packages/scripts/dist/commands/report-harness-efficiency.js` command. That command is documented only in the retired private checkout's experiment write-up.
- **Prerequisites:** none.
- **Related or overlapping:** RF-018 ("Retire uninvoked one-off proof, benchmark and smoke harnesses") covers the same class of leftover tooling. That card does not list these files; if an executor merges the two cards, keep this card's build-script edit. The Pi disproof fixture from the same experiment, `plugins/provider-pi/src/bridge/harness-efficiency-fixtures/native-summary-disproof.ts` (350 lines) and `plugins/provider-pi/src/bridge/harness-efficiency.pi.test.ts` (61 lines), is a separate test-only decision in another package. It is not part of this card.
- **Why it deserves its place:** this is dead machinery, not just a lower line count. It is the only reason `packages/scripts/package.json` has a two-step build, and every change to the `@omnyo/scripts` build, tsconfig or test setup has to keep it compiling and passing.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The audit's snapshot worktree had already been removed when this card was written, so every file was read with `git show <commit>:<path>` and `git grep <commit>` in `$OMNYO_CHECKOUT`. Live `HEAD` (`5f2d3f895`) has no diff under `packages/scripts` against the snapshot (`git diff --stat e9e1b74c3 HEAD -- packages/scripts` was empty).

What the package is: `@omnyo/scripts` is the private workspace package behind the root developer commands, including `pnpm omnyo`, `pnpm reset*`, `codex:archive-tmp-omnyo-sessions`, `dev:restart*` and `seed:perf`. The root `package.json` lines 11, 12, 26 and 31–33 build it through `scripts:prepare`, `cli:prepare` and `build`.

What exists (Proven by inspection):

| File | Lines (`wc -l`) | Non-blank | Role |
|---|---:|---:|---|
| `packages/scripts/src/lib/harness-efficiency.ts` | 1,074 | 918 | Pure reducer. It has zero `import` statements. It exports only `parseHarnessEfficiencyInput` (line 250) and `reportHarnessEfficiency` (line 794). |
| `packages/scripts/src/commands/report-harness-efficiency.ts` | 31 | 26 | CLI wrapper: `--input PATH`, then `JSON.parse`, then the two exports, then JSON on stdout. It uses the shared `runMainIfEntrypoint` from `src/lib/script-entry.ts`. |
| `packages/scripts/test/harness-efficiency.test.ts` | 390 | 332 | Unit tests of the reducer. |
| `packages/scripts/test/fixtures/harness-efficiency/accounting.json` | 208 | 208 | Synthetic arithmetic fixture. This is the only file in that directory. |

Counting command: `git show e9e1b74c3:<path> | wc -l` for each file, with `grep -cv '^\s*$'` for the non-blank count. Production (developer-tooling) total: 1,105 lines (944 non-blank). Test and fixture total: 598 lines.

The build step: `packages/scripts/package.json:22` "build" is `node ../../scripts/build-package.mjs && node ../../scripts/build-node-entry.mjs src/commands/report-harness-efficiency.ts dist/commands/report-harness-efficiency.js`. `scripts/build-package.mjs` builds only `exports` entries (`collectExportEntries`) and `bin` entries (`collectBinEntries`), and it clears `dist` first (`rm(path.join(packageRoot, "dist"), …)`, around line 94). The reporter is neither an export nor a bin, so it needs the second esbuild call. Every other non-bin command (`request-dev-restart.ts`, `run-dev.ts`, `run-desktop.ts`, `seed-perf-db.ts`) runs from source through `tsx` (root `package.json:22–29`). So the reporter is the only cause of the two-step build.

Consumer searches (all at the snapshot, whole tree, every file type, including `.github`, `turbo.json`, docs and plugins):

- `git grep -n -i -e 'harness-efficiency' -e 'harnessEfficiency' -e 'HarnessEfficiency' -e 'harness_efficiency' -e 'harness efficiency' e9e1b74c3 -- .` finds only the four files above, `packages/scripts/package.json:22`, and the separate provider-pi fixture.
- `git grep -n -e 'accounting.json' -e 'report-harness' -e 'dist/commands/report' e9e1b74c3 -- .`, outside the package's own command, test and build script, finds nothing.
- No `bin` entry, `exports` entry, root script, turbo task, CI workflow, Containerfile, desktop or mobile build, plugin manifest or SDK export references the reporter. The package is `"private": true`, so no external package can import it.
- `git ls-tree -r --name-only e9e1b74c3 docs | grep -i harness` is empty. The public repository has no documentation for the reporter.
- No test in the snapshot asserts on `build-package.mjs` behavior. `git grep -l 'build-package.mjs' e9e1b74c3 -- '*.test.*'` is empty.

History and requirement (Proven by inspection, private retired checkout `$ARCHIVED_OMNYO_CHECKOUT`):

- The code arrived in `cd0ec5e7b8` "feat(scripts): add offline harness efficiency report". The public history collapses it into `060950255` "Publish Omnyo source", and no later commit touches these files.
- `docs/execplans/2026-10-18-harness-efficiency-results.md:3` says: "The offline reporter is implemented. This experiment establishes no measured task-performance or billing improvement. Core stays unchanged, and the fixed Pi masking policy is discarded before live inference." Line 15 says the report values "are arithmetic fixtures, not observed model usage". The section beginning at line 33 says no live experiment calls ran.
- `docs/execplans/2026-10-18-harness-efficiency.md:58` and `:134` define the reporter as "an offline developer report", with no public command, bin, database or SDK member.

Counterevidence:

- The reducer is generic: it handles a baseline arm and a candidate arm with separate cache-read, cache-write, output and resend buckets, so a future token-accounting experiment could reuse it. No current plan or consumer exists (Hypothesis that none is intended; that is the question for Alex).
- The retired results document reproduces the report with `node packages/scripts/dist/commands/report-harness-efficiency.js`. That document is pinned to base source `95e65f967c`, and that commit stays reproducible from Git history after this deletion.

Maintenance cost today: any change to `@omnyo/scripts` build flags, tsconfig (`include: ["src", "test", …]`), vitest configuration or the shared esbuild helpers must keep a 1,074-line reducer that nobody uses compiling, typechecking and passing 33 tests. The build script is also the one package script in the repository that combines `build-package.mjs` with an extra `build-node-entry.mjs` call, which misleads anyone reading it about what the package ships.

**Proposed end state and preservation argument**

End state:

- `packages/scripts/src/lib/harness-efficiency.ts`, `packages/scripts/src/commands/report-harness-efficiency.ts`, `packages/scripts/test/harness-efficiency.test.ts` and the directory `packages/scripts/test/fixtures/harness-efficiency/` are deleted.
- `packages/scripts/package.json` "build" becomes `node ../../scripts/build-package.mjs`.
- `dist/commands/` then contains exactly the three `bin` outputs plus `dist/lib/run-dev-supervisor.js`.

Preservation: no product feature, API, persisted format, UI or runtime path uses the reporter. Its two exports have no importer outside its own command and test. `runMainIfEntrypoint` stays, because seven other commands use it. `build-node-entry.mjs` stays, because the CLI, host daemon, relay, server and plugin-build packages use it. `turbo.json` keeps `scripts/build-node-entry.mjs` in its shared `build` inputs for those packages. Because `build-package.mjs` clears `dist` on every build, no stale reporter output survives locally.

Non-goals: this card does not touch the provider-pi disproof fixture, `build-package.mjs`, `build-node-entry.mjs`, `turbo.json` or the retired private execplan documents.

Remaining uncertainty: an unrecorded personal workflow outside the repository could still run the reporter. Only Alex can rule that out, which is the reason for the decision gate.

**Expected gain and cost**

- Removed (observed counts): 1,105 handwritten developer-tooling source lines (944 non-blank); 598 test and fixture lines (390 test, 208 fixture JSON); one esbuild invocation in `@omnyo/scripts#build`; 33 unit tests from the `@omnyo/scripts` test run (the count comes from the results document, line 50, and was not recounted).
- Added: nothing.
- Performance (projection, not measured): one fewer esbuild bundle when Turbo misses its cache for `@omnyo/scripts#build`, which happens through `pnpm omnyo`, `pnpm reset*` and `scripts:prepare` after a change to an input. The saving is probably well under a second per miss. The test and typecheck runs of the package also get shorter.
- Cost: losing a ready-made offline accounting reducer. It can be restored from Git history if a future experiment needs it.

**Execution steps**

0. **Decision gate (do this first).** Ask the owner: "The October harness-efficiency experiment concluded with no product change. Can the offline reporter in `@omnyo/scripts` be deleted, or will you rerun that experiment with it?" Stop if Alex intends to rerun it or wants to keep the tool. Proceed only on a clear yes to deletion.
1. **Reconfirm.** In a worktree based on current `main`, run `git grep -n -i harness-efficiency -- .` and `git grep -n report-harness -- .`. Expect only the four files, `packages/scripts/package.json` "build", and `plugins/provider-pi/src/bridge/harness-efficiency*`. Re-plan if any new consumer appears, for example a root script, a turbo task, a doc, or an import from another package.
2. **Delete the source and tests.** Remove `packages/scripts/src/lib/harness-efficiency.ts`, `packages/scripts/src/commands/report-harness-efficiency.ts`, `packages/scripts/test/harness-efficiency.test.ts`, and `packages/scripts/test/fixtures/harness-efficiency/accounting.json` together with its directory. All four are clean tracked files, so removing them is ordinary editing, but name them in the report. At the snapshot, `harness-efficiency/` was the only subdirectory of `packages/scripts/test/fixtures/` (`git ls-tree -r --name-only e9e1b74c3 packages/scripts/test`), so `test/fixtures/` disappears too. If other fixtures have appeared there since, leave them alone.
3. **Simplify the build script.** In `packages/scripts/package.json`, change "build" to `"node ../../scripts/build-package.mjs"`. Do not touch `bin`, `exports` or the other scripts.
4. **Check for leftovers.** Run `git grep -n -i -e harness-efficiency -e HarnessEfficiency -- packages/scripts package.json turbo.json`. It should print nothing. The provider-pi files remain by design.
5. **Verify** with the commands below, then inspect `git diff --stat`. Expect exactly four deletions and one changed line in `packages/scripts/package.json`.

**Verification and acceptance criteria**

Run all commands from the repository root of the working lane. The script names were confirmed in the snapshot's root `package.json` and `packages/scripts/package.json`, but none of these commands was executed for this card, because the snapshot had no `node_modules`.

- `pnpm exec turbo run build --filter=@omnyo/scripts` succeeds, and the output line from `build-package.mjs` reads `@omnyo/scripts: built 4 entries` (three bins plus one export). Afterwards, `ls packages/scripts/dist/commands` lists `archive-codex-tmp-omnyo-sessions.js`, `reset-omnyo-data.js` and `run-cli.js`, and no `report-harness-efficiency.js`.
- `pnpm exec turbo run typecheck --filter=@omnyo/scripts` passes.
- `pnpm exec turbo run test --filter=@omnyo/scripts` passes. This task depends on `@omnyo/cli#build` and `//#ensure-native-modules` (`turbo.json:589–590`), so it needs installed dependencies and native modules.
- `pnpm run scripts:prepare` exits 0. As an optional smoke check, `pnpm omnyo --help` still starts the CLI through `packages/scripts/dist/commands/run-cli.js`.
- Lint: `pnpm exec oxlint --deny-warnings --format=agent packages/scripts`. There is no package-level lint script, and the root `lint` script runs `turbo run lint`.
- Structural completion: the four files are gone, the build script has one step, and the step-4 search is empty.

There is no UI, persisted data, API contract or concurrency surface to compare.

**Rollback and stop conditions**

- Rollback: revert the single commit. Nothing persisted, published or migrated depends on these files.
- Stop if Alex wants to keep or rerun the reporter.
- Stop if the step-1 search shows a new consumer, such as a root script, CI job, documentation page or import from another workspace package.
- Stop if `build-package.mjs` does not build the package correctly once the second step is gone. Investigate that separately: the tail of the build script never built any other entry, so such a failure would be unrelated to this change.
- Safer smaller alternative if Alex wants the tool kept but not built: delete only the `&& node ../../scripts/build-node-entry.mjs …` tail and run the reporter through `node --conditions=source --import tsx packages/scripts/src/commands/report-harness-efficiency.ts --input …`, the way the repository already runs `seed-perf-db.ts`. This removes the build step but keeps the 1,105 lines.
