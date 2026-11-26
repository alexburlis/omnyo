# RF-012 — Retire the one-time BB-to-Omnyo source rename transformer, its mapping modules and their tests

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Potential:** high. About 6,220 handwritten production lines of tooling (12 files), a 129-line operator README and 2,962 test lines (11 files) leave the repository. Nothing is added.
- **Confidence:** high that nothing in the repository invokes the tool (Proven by inspection, searches below). Medium that no person or fork outside the repository still needs it, because a repository search cannot prove that.
- **Readiness:** decision-needed. Alex must confirm that the BB-to-Omnyo source rename is finished and that no future port of upstream BB changes is planned to run through this transformer.
- **Effort:** about one hour: delete 24 files, run the `@omnyo/scripts` test suite once and check the diff.
- **Risk:** low for product behavior. No runtime, build, CI or package code imports these files. The only realistic loss is the ability to replay a rename wave from current `main`, and that remains available from Git history.
- **Prerequisites:** the owner's retirement decision (gate in step 1 below).
- **Related or overlapping opportunities:** RF-006 (stopped-state BB-to-Omnyo identity adoption) and RF-018 (uninvoked one-off proof, benchmark and smoke harnesses) are separate retirements of other migration-era machinery; they share no files with this card and can land in any order. RF-039 (BB-era plugin SDK migration in `packages/templates`) and RF-040 (plugin-local browser-storage imports) are runtime migrations for users and plugin authors and are explicitly out of scope here.
- **Why it deserves its place:** it is the largest single block of dead tooling in `scripts/`, it carries its own TypeScript-language-service selector engine and journal format, and its tests run in every `@omnyo/scripts` test run. Retiring the finished operation removes the whole mechanism rather than moving it.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The snapshot worktree named in the audit brief no longer existed when this card was written, so every file was read with `git show <commit>:<path>` and searched with `git grep <commit>` from `$OMNYO_CHECKOUT`. No tests were run; the snapshot has no `node_modules`.

*What the subsystem is.* Omnyo is an MIT fork of BB (`README.md:46`, `NOTICE:5`). During the rename, a controlled source transformer edited a task-owned candidate tree from BB names (`@bb/*`, `@get-bb/plugin-sdk`, `BbSdk`, `bb` manifest keys and so on) to Omnyo names. It is documented in `scripts/omnyo-rename/README.md` ("Omnyo source transformer") and has four commands, dispatched by `main` in `scripts/omnyo-rename.mjs:1059`:

- `plan` calls `createRenamePlan` (`scripts/omnyo-rename.mjs:293`), which binds the Git revision, index, the whole tracked and untracked path universe and file digests.
- `apply` and `resume` call `applyRenamePlan` (`scripts/omnyo-rename.mjs:857`), which writes through a journal and staging paths.
- `check` calls `checkRenamePlan` (`scripts/omnyo-rename.mjs:968`), which rescans for remaining branded tokens.

Operations come from mapping modules that materialize exact edits from inspected source: `materializeCurrentCopyOperations` (`scripts/omnyo-copy-map.mjs`), `materializeEmbeddedSourceOperations` (`scripts/omnyo-embedded-source-map.mjs:240`), `materializeEnvironmentOperations` (`scripts/omnyo-environment-map.mjs`), `scripts/omnyo-guide-map.mjs`, `scripts/omnyo-renderer-map.mjs`, `materializeRuntimeOutputOperations` (`scripts/omnyo-runtime-path-map.mjs`), `collectSourceBindings` and the package identity registry (`scripts/omnyo-source-map.mjs`), `materializeWireHeaderOperations` (`scripts/omnyo-wire-map.mjs`), `inventoryRepository` (`scripts/omnyo-inventory.mjs`), plus the selector engine `createSymbolResolver`, `brandedCandidates` and `isScript` (`scripts/omnyo-rename/selectors.mjs`) and `resolveSelectedMetadataEdge` (`scripts/omnyo-rename/selected-path-edges.mjs`).

*Line counts (Proven by inspection).* Command: `for f in <file>; do git show e9e1b74c3:<file> | wc -l; done` from `$OMNYO_CHECKOUT`.

| File | Lines |
|---|---|
| `scripts/omnyo-rename.mjs` | 1,119 |
| `scripts/omnyo-rename/selectors.mjs` | 870 |
| `scripts/omnyo-rename/selected-path-edges.mjs` | 97 |
| `scripts/omnyo-source-map.mjs` | 1,711 |
| `scripts/omnyo-renderer-map.mjs` | 439 |
| `scripts/omnyo-copy-map.mjs` | 412 |
| `scripts/omnyo-embedded-source-map.mjs` | 392 |
| `scripts/omnyo-guide-map.mjs` | 296 |
| `scripts/omnyo-environment-map.mjs` | 280 |
| `scripts/omnyo-runtime-path-map.mjs` | 231 |
| `scripts/omnyo-inventory.mjs` | 206 |
| `scripts/omnyo-wire-map.mjs` | 167 |
| **Production tooling total** | **6,220** |
| `scripts/omnyo-rename/README.md` (docs) | 129 |

That is eight `omnyo-*-map.mjs` files plus `omnyo-inventory.mjs`, the CLI and two selector modules. (The sweep report said "nine mapping modules"; the file list and total are nevertheless correct.)

Tests in `packages/scripts/test/`, each importing only from the files above (Proven by inspection of their `import` lines): `omnyo-rename.test.mjs` 1,164; `omnyo-source-map.test.mjs` 879; `omnyo-copy-map.test.mjs` 245; `omnyo-environment-map.test.mjs` 111; `omnyo-sdk-consumer-map.test.mjs` 111 (it tests `scripts/omnyo-source-map.mjs`; there is no `omnyo-sdk-consumer-map.mjs`); `omnyo-selected-path-edges.test.mjs` 104; `omnyo-guide-map.test.mjs` 92; `omnyo-inventory.test.mjs` 82; `omnyo-renderer-map.test.mjs` 75; `omnyo-embedded-source-map.test.mjs` 67; `omnyo-wire-map.test.mjs` 32. Total 2,962. Their fixtures are inline strings; none imports `packages/scripts/test/atomic-write-helpers.mjs`, `dev-instance-expectations.ts` or `packages/scripts/test/fixtures/` (the only fixture there is `harness-efficiency/accounting.json`, which belongs to RF-059).

*Reachability (Proven by inspection).*

- Basename search across the whole snapshot, excluding the tooling and its tests: `git grep -nE "omnyo-(rename|copy-map|embedded-source-map|environment-map|guide-map|inventory|renderer-map|runtime-path-map|source-map|wire-map|sdk-consumer-map)|selected-path-edges|omnyo-rename/selectors" e9e1b74c3 -- . ':!scripts/omnyo-*.mjs' ':!scripts/omnyo-rename' ':!packages/scripts/test/omnyo-*.test.mjs'`. The only hits are the unrelated fixture strings `/tmp/omnyo-rename-old` and `/tmp/omnyo-rename-new` in `apps/host-daemon/src/command-dispatch.test.ts:1279` and `:1283`.
- `git grep -nE "scripts/omnyo-" e9e1b74c3 -- .github turbo.json package.json '*/package.json'` finds nothing. The snapshot has no `.github/` directory. `packages/scripts/package.json` exposes three unrelated bins and its `test` script is `vitest run --config vitest.config.ts`; `packages/scripts/vitest.config.ts` discovers the tests by the glob `test/**/*.test.mjs`, which is the only thing that runs them.
- Documentation search `git grep -niE "source (rename|transformer)|rename (tool|wave|transformer)|omnyo migration" e9e1b74c3 -- '*.md' '*.json' '*.yml' '*.yaml' '*.toml'` hits only the README itself and `docs/configuration.md:17`, which is about the separate `stateMigration` binding (RF-006 territory), not this tool.
- The planning inputs the tool reads are not in the public snapshot: `git ls-tree -r --name-only e9e1b74c3 | grep -E 'omnyo-migration|rename-rules'` is empty. `packageIdentityRegistry` in `scripts/omnyo-source-map.mjs:556-565` falls back to `[]` when `docs/omnyo-migration/execution-package-identities.json` is absent, while `materializeEmbeddedSourceOperations` in `scripts/omnyo-embedded-source-map.mjs:245-252` reads that file unconditionally unless a caller passes `packageIdentities`. So in the public repository the embedded-source mapping cannot run outside its tests, which inject the identities.
- The only non-Node runtime coupling is lazy: `scripts/omnyo-rename/selectors.mjs:541` and `:576` resolve `postcss` through `apps/mobile/package.json` and `parse5` through `apps/server/package.json`, and `:666` resolves `parse5` the same way for JSX bodies; `scripts/omnyo-renderer-map.mjs:94` and `:276` resolve `postcss`. Both packages stay because the product uses them, so no dependency is removed. The root `typescript` dependency (`package.json:69`) also stays.

*The rename is finished (Proven by inspection).* In the public repository the tooling has only one commit, `060950255` "Publish Omnyo source" (2026-11-24), so it arrived already renamed and has never been edited since. Every remaining `@bb/` or `@get-bb/` hit in the snapshot (`git grep -lE '"@bb/|from "@bb/' e9e1b74c3`) is either this tooling, its tests, or a deliberate legacy-input fixture: `packages/templates/src/legacy-plugin-sdk-layout-v1.ts`, `packages/templates/src/plugin-scaffold.ts`, `packages/plugin-build/src/build-plugin-host.ts`, and tests in `apps/cli`, `packages/plugin-build`, `packages/plugin-sdk` and `packages/templates`. In the retired private checkout (`$ARCHIVED_OMNYO_CHECKOUT`, read-only), the root package is named `omnyo`, the last change to the tool is `53ed71ff8e` (2026-11-06, "Integrate Omnyo migration and selected features at the phone release cutoff"), and the planning specification `docs/omnyo-migration/rename-rules.md` says execution authority came from the 2026-11-03 migration ExecPlan. The private `docs/omnyo-migration/` directory, which holds `rename-rules.json` and `execution-package-identities.json`, was never published.

*Counterevidence and remaining uncertainty.*

- The README still documents manual invocation (`scripts/omnyo-rename/README.md:107-112`) and says bounded waves `P0` through `P7` may defer files to a later wave. A repository search cannot show whether a person still holds an open rename journal or a deferred wave. Hypothesis: none exists, because both trees are fully renamed and the public tree has never changed the tool.
- Omnyo is a fork of the public `get-bb/bb` project. If Alex intends to port upstream BB commits into Omnyo, someone might think this transformer helps. It does not fit that job: it renames a whole bound candidate tree from a manifest of exact operations and refuses any unclassified candidate. It does not translate patches. This is a judgment from the README's contract, not a test.

*Maintenance cost today.* The mapping tables hard-code current package names and file layouts (for example `omnyo-source-map.test.mjs` asserts specific `@omnyo/*` names and paths such as `packages/config/src/managed-app-config.js`). Renaming a package or moving one of those files can break tests for a tool nobody runs. `turbo.json` hashes `$TURBO_ROOT$/scripts/*.mjs` into `@omnyo/sdk#test` (task at `turbo.json:111`, glob at `:129`), `omnyo-app#build` (task at `:195`, glob at `:221`) and `@omnyo/scripts#test` (task at `:589`, glob at `:604`), so any edit to these 10 top-level `.mjs` files invalidates those caches. Because nobody edits the tool, that cache effect is small in practice; the main costs are dead code to read around and an extra 2,962 lines of tests, including Git-initializing tests (`omnyo-rename.test.mjs:1066-1068`), in every `@omnyo/scripts` run.

**Proposed end state and preservation argument**

What disappears: the `scripts/omnyo-rename.mjs` CLI, the `scripts/omnyo-rename/` directory (README, `selectors.mjs`, `selected-path-edges.mjs`), the eight `scripts/omnyo-*-map.mjs` files, `scripts/omnyo-inventory.mjs`, and the 11 test files listed above. The journal and plan JSON formats disappear with them; they were written only to operator-chosen paths outside the source tree ("Reports and journals remain outside the candidate source", README) and are never read by the product.

What remains, unchanged:

- Every runtime legacy migration for users and plugin authors: legacy settings keys, `packages/templates/src/legacy-plugin-sdk-layout-v1.ts` and the `omnyo plugin migrate` path (RF-039 decides that separately), wire compatibility, and the `@bb/` and `@get-bb/` fixtures in `packages/templates`, `packages/plugin-build`, `packages/plugin-sdk` and `apps/cli` tests.
- `packages/scripts/test/omnyo-private-sdk-artifact.test.mjs` (617 lines), which tests the private SDK artifact and shares only the `omnyo-` filename prefix.
- `packages/scripts/test/start-omnyo.test.mjs`, `reset-omnyo-data.test.ts` and `archive-codex-tmp-omnyo-sessions.test.ts`, which also only share the prefix.
- `parse5`, `postcss` and `typescript`, which the product and other scripts still use.
- The `$TURBO_ROOT$/scripts/*.mjs` globs in `turbo.json`, because other `scripts/*.mjs` files still feed those tasks. Do not edit `turbo.json`.
- Git history. The tool stays recoverable with `git show <last-revision>:scripts/omnyo-rename.mjs`.

Why this is the simplest sufficient option: the operation is complete, so the tool has no supported job. Keeping it "just in case" preserves a large specialized engine whose inputs are not even in the repository. Git history is the archive. Non-goals: no change to product code, persisted formats, CLI commands, SDK exports or `turbo.json`; no cleanup of other migration machinery (RF-006, RF-018, RF-039, RF-040).

**Expected gain and cost**

| Measure | Before | After | Basis |
|---|---|---|---|
| Handwritten production lines (tooling) | 6,220 in 12 files | 0 | `wc -l` via `git show` at the snapshot |
| Docs | 129 (README) | 0 | same |
| Test lines | 2,962 in 11 files | 0 | same |
| Maintained mechanisms | 1 CLI with plan/apply/resume/check, 1 journal format, 1 TypeScript-language-service selector engine, 9 mapping or inventory modules | none | file inspection |
| Dependencies removed | | none | parse5, postcss and typescript have other consumers |
| Added lines | | 0 | deletion only |

Projected, not measured: a shorter `@omnyo/scripts` test run, because `omnyo-rename.test.mjs` creates temporary Git repositories and drives the TypeScript language service. There is no credible baseline in the snapshot; if a number is wanted, time `pnpm test` in `packages/scripts` before and after on the same machine. Cache invalidation of the three turbo tasks listed above only falls when someone would otherwise have edited these files, which is rare, so treat that benefit as minor.

The maintenance gain is causal: package renames and file moves no longer have to keep the hard-coded tables and test fixtures of a finished tool in step, and readers of `scripts/` no longer meet a 6,000-line engine that looks live.

**Execution steps**

1. **Decision gate (must pass before any edit).** Ask the owner to confirm all three points, and record his answer in the commit message:
   - the BB-to-Omnyo source rename is complete in every tree he cares about, and nobody holds an open rename journal or a deferred wave (`P0`–`P7`) to replay from current `main`;
   - no planned port of upstream `get-bb/bb` changes depends on this transformer;
   - Git history is an acceptable archive.
   If any answer is no, stop and keep the tool (see stop conditions).
2. **Reconfirm the snapshot.** From the checkout you will edit, record `git rev-parse HEAD` as the last revision that contains the tool. Re-run the reachability search from Context against the working tree: `git grep -nE "omnyo-(rename|copy-map|embedded-source-map|environment-map|guide-map|inventory|renderer-map|runtime-path-map|source-map|wire-map|sdk-consumer-map)|selected-path-edges|omnyo-rename/selectors" -- . ':!scripts/omnyo-*.mjs' ':!scripts/omnyo-rename' ':!packages/scripts/test/omnyo-*.test.mjs'`. The plan stays valid if the only hits are the two `/tmp/omnyo-rename-*` strings in `apps/host-daemon/src/command-dispatch.test.ts`. Any new hit in a package script, CI workflow, Containerfile, `turbo.json`, doc or source file invalidates this plan: trace that consumer and re-plan. Also run `git ls-files 'scripts/omnyo-*' 'scripts/omnyo-rename/*' 'packages/scripts/test/omnyo-*'`; if a new file matching these names exists, check whether it belongs to the tool before deleting it. Check `git status --porcelain -- scripts packages/scripts/test` for uncommitted edits by other agents to these paths; if any exist, stop and ask, because they are foreign work.
3. **Delete the tests** (one checkpoint with step 4, because the tests import the tooling): `git rm packages/scripts/test/omnyo-rename.test.mjs packages/scripts/test/omnyo-source-map.test.mjs packages/scripts/test/omnyo-copy-map.test.mjs packages/scripts/test/omnyo-embedded-source-map.test.mjs packages/scripts/test/omnyo-environment-map.test.mjs packages/scripts/test/omnyo-guide-map.test.mjs packages/scripts/test/omnyo-inventory.test.mjs packages/scripts/test/omnyo-renderer-map.test.mjs packages/scripts/test/omnyo-sdk-consumer-map.test.mjs packages/scripts/test/omnyo-selected-path-edges.test.mjs packages/scripts/test/omnyo-wire-map.test.mjs`. Do not touch `omnyo-private-sdk-artifact.test.mjs`, `start-omnyo.test.mjs`, `reset-omnyo-data.test.ts` or `archive-codex-tmp-omnyo-sessions.test.ts`.
4. **Delete the tooling:** `git rm -r scripts/omnyo-rename scripts/omnyo-rename.mjs scripts/omnyo-source-map.mjs scripts/omnyo-copy-map.mjs scripts/omnyo-embedded-source-map.mjs scripts/omnyo-environment-map.mjs scripts/omnyo-guide-map.mjs scripts/omnyo-inventory.mjs scripts/omnyo-renderer-map.mjs scripts/omnyo-runtime-path-map.mjs scripts/omnyo-wire-map.mjs`.
5. **Remove support references.** None are expected (no package script, turbo task, lint ignore or doc names these files at the snapshot). Re-run the step 2 search without the exclusions; it must return only the two unrelated `command-dispatch.test.ts` strings. Leave `turbo.json` unchanged. Do not edit dated audit documents under `docs/` that mention the tool; they are historical records.
6. **Verify and inspect.** Run the commands below, then `git diff --cached --stat` and confirm the diff contains exactly the 24 deletions (13 under `scripts/`, 11 under `packages/scripts/test/`) and nothing else. Recount with `git diff --cached --numstat | awk '{d+=$2} END {print d}'`; expect 9,311 deleted lines (6,220 + 129 + 2,962) if the files are unchanged since the snapshot.
7. **Commit** locally on a named branch with a message such as "Retire the finished BB-to-Omnyo source rename transformer", naming the last revision from step 2 and recording the owner's decision from step 1. Pushing needs the owner's separate authority.

**Verification and acceptance criteria**

- `@omnyo/scripts` tests still pass without the deleted files. From `packages/scripts`: `pnpm test` (runs `vitest run --config vitest.config.ts`, confirmed in `packages/scripts/package.json`). Through turbo from the repository root: `pnpm turbo run test --filter=@omnyo/scripts` (the `@omnyo/scripts#test` task exists in `turbo.json:589`; it depends on `@omnyo/cli#build`, so it is slower). Expected: every remaining test passes and vitest reports no "Failed to load" or missing-module error.
- Typecheck of the package from `packages/scripts`: `pnpm typecheck` (`tsc --noEmit`, confirmed in `packages/scripts/package.json`). The deleted files are `.mjs` outside `src/`, so this should be unaffected; run it once to confirm.
- Format check from the repository root: `pnpm format:check` (confirmed root script `oxfmt . --check`). A pure deletion should not change its result; if it fails, compare with the baseline before treating the failure as caused by this change.
- Structural completion: the search in step 5 returns only the two unrelated strings; `ls scripts/omnyo-rename* scripts/omnyo-*-map.mjs scripts/omnyo-inventory.mjs` finds nothing; `packages/scripts/test/omnyo-private-sdk-artifact.test.mjs` still exists.
- No UI, persisted format, wire contract or performance-sensitive path changes, so no visual, migration or benchmark checks apply. the owner's normal release gate (`pnpm test:full`, root script confirmed) is only needed when this lands on a shipping branch, not per edit.

**Rollback and stop conditions**

Rollback is one `git revert` of the deletion commit, or `git checkout <last-revision> -- <paths>` for a single file. No user data, persisted format or published artifact depends on these files, so reverting has no compatibility implications.

Stop and keep the tool if any of these hold:

- Alex says a rename wave, open journal or deferred file is still pending, or that an upstream-port workflow uses the transformer. The smaller alternative is to keep the tool but move it out of the default test run, which needs its own decision.
- Step 2 finds a new consumer in a package script, CI workflow, Containerfile, `turbo.json` or doc.
- Another agent has uncommitted changes in any of the 24 paths.
- After deletion, an unrelated `@omnyo/scripts` test fails because it imported one of these modules through a path the search missed. Restore the file, trace the importer and re-plan.
