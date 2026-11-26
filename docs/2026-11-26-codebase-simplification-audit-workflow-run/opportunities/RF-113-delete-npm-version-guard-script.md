# RF-113 — Delete the dormant npm version guard for the private plugin SDK

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** confirmed, as the sweep described it.
- **Potential:** low. The change removes one dormant tooling mechanism (360 lines) and its test suite (200 lines). No runtime code changes.
- **Confidence:** high.
- **Readiness:** ready.
- **Effort:** under one hour. Delete two files and run the plugin SDK test project.
- **Risk:** very low. Nothing in this repository runs the script. The script also cannot fail on the current manifest, because it returns a pass as soon as it sees `"private": true`.
- **Prerequisites:** none.
- **Related and overlapping items:** RF-017 ("Retire the CI-only scripts, data and tests, or publish the workflows that consume them") covers the wider group of files whose only consumer was the retired private CI. RF-113 does not depend on the RF-017 decision. Even under the CI that used to run it, this script does nothing on a private package. Incidental issue ISS-X2-004 (the registry URL still names the old `@get-bb` scope) is resolved by this deletion. RF-041 (the scheduled SDK next-major removal batch) touches the same package but different files.
- **Why it deserves a place:** this is a small but certain removal. It deletes dead machinery that still costs test time on every SDK test run. It also misleads readers: the script implies that the SDK is published to npm and that a "publish job" exists, and neither is true.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The read-only snapshot worktree was no longer on disk when this card was written. Every citation below was read with `git show e9e1b74c3…:<path>` and `git grep … e9e1b74c3…` against that commit. `git diff --stat e9e1b74c3 5f2d3f895 -- packages/plugin-sdk/scripts packages/plugin-sdk/package.json` returned no changes, so local `main` at `5f2d3f895` holds the same files.

The plugin SDK (`packages/plugin-sdk`) is distributed privately: `scripts/pack-private.mjs` and `scripts/private-artifact.mjs` own the tarball that the host builds copy in. The script `packages/plugin-sdk/scripts/check-npm-version-guard.mjs` comes from the era when the SDK was published to npm as `@get-bb/plugin-sdk` (it was added in commit `57c06f94c`, "Publish @get-bb/plugin-sdk with the release train (#1575)"). It downloads the published tarball for the current version, packs the local package and fails when the files or consumer-facing manifest fields differ without a version bump.

Observed facts (Proven by inspection):

- `packages/plugin-sdk/scripts/check-npm-version-guard.mjs` has 360 lines (`wc -l`). It exports `COMPARED_MANIFEST_FIELDS` (line 25), `normalizePackedFile` (line 36) and `decideNpmVersionGuard` (line 58). Its private helpers are `readPackedTree`, `splitPackage`, `extractTarball`, `loadLocalPackage` and `loadRegistryState`, and `main` runs only when the file is executed directly (lines 355–360).
- `main` (line 315) reads `packages/plugin-sdk/package.json`. At line 324, when `manifest.private === true`, it prints a pass with reason `"private-publication-disabled"` and returns before any registry or pack work.
- `packages/plugin-sdk/package.json` line 3 is `"private": true`. The package's `"files"` list is `bundled-types/omnyo-plugin-sdk*.d.ts`, `dist` and `README.md`, so the script is not part of the packed artifact.
- `REGISTRY_URL` (line 23) is `https://registry.npmjs.org/@get-bb%2Fplugin-sdk`, while `PACKAGE_NAME` (line 21) is `@omnyo/plugin-sdk`. Even with publication enabled, the script would compare against the wrong package (ISS-X2-004).
- `packages/plugin-sdk/scripts/check-npm-version-guard.test.mjs` has 200 lines and 10 `it` cases. All of them exercise `decideNpmVersionGuard` with in-memory fixtures; none covers behavior used anywhere else. `packages/plugin-sdk/vitest.config.ts` collects it through the include glob `"scripts/**/*.test.mjs"`, so it runs in every SDK test pass.
- The script is absent from every `package.json` script. The SDK's scripts are `build`, `build:runtime`, `build:types*`, `clean`, `prepack`, `test`, `typecheck` and `pack:private`. `packages/plugin-sdk/tsconfig.json` includes only `src`, so typecheck does not see the script.

Consumer searches (all against the snapshot commit):

- `git grep -n -I -i -E 'version-guard|version guard|versionguard|npm-version|decideNpmVersionGuard|COMPARED_MANIFEST_FIELDS|normalizePackedFile|private-publication-disabled|plugin-sdk-guard' e9e1b74c3… -- .` matched only the script and its test. The other hits are unrelated: an `"npm-version"` event-source example in `plugins/omnyo-guide/skills/omnyo-plugin-authoring/references/backend-event-sources.md`, a temporary directory name in `packages/scripts/test/ci-workflow.test.ts:37`, and a test title in `apps/server/test/services/plugins/omnyo-artifact-meta.test.ts:54`.
- `git grep -n -E 'plugin-sdk/scripts/' e9e1b74c3… -- . ':!packages/plugin-sdk/scripts'` found only imports of `private-artifact.mjs` (`packages/omnyo-app/scripts/build.mjs:6`, `build-host.mjs:11`, `build-host-artifact.mjs:19`, `packages/scripts/test/omnyo-private-sdk-artifact.test.mjs:25`) and its `turbo.json` inputs (lines 222 and 246).
- A search for glob or `readdir` access to the SDK `scripts` directory found nothing. `turbo.json` names no task or input for the guard.
- `git ls-tree -r --name-only e9e1b74c3…` lists no `.github/` directory or other CI configuration, and the working checkout `$OMNYO_CHECKOUT` has no `.github` directory either.
- `grep -rn -i 'version.guard' $HOME/.agents/docs $HOME/.agents/skills` found nothing relevant. The 2025-11-25 prior audit does not mention the guard.

Counterevidence that was checked:

- The retired private repository `$ARCHIVED_OMNYO_CHECKOUT` (remote `alexburlis/omnyo-private`, last commit `52b7fdf012` on 2026-11-23) still has `.github/workflows/ci.yml`. Its step "Check plugin SDK npm version guard" (around lines 452–465) runs `node packages/plugin-sdk/scripts/check-npm-version-guard.mjs`, treats exit code 2 as a warning and otherwise passes the exit code through. That workflow belongs to a different repository and runs against its own copy of the file. Its `packages/plugin-sdk/package.json` is also `"private": true`, so that step already passes immediately. Deleting the file from this repository does not affect that workflow, unless someone later ports this tree into a CI that still has that step (see Rollback and stop conditions).
- Maintenance cost today: any change to the SDK manifest fields or packed layout leaves `COMPARED_MANIFEST_FIELDS` and the test fixtures describing an npm publication that no longer exists. The script's failure text tells readers that "the publish job will ship it", which is false.

**Proposed end state and preservation argument**

- **What disappears:** `packages/plugin-sdk/scripts/check-npm-version-guard.mjs` and `packages/plugin-sdk/scripts/check-npm-version-guard.test.mjs`.
- **What remains:** private SDK distribution stays with `packages/plugin-sdk/scripts/pack-private.mjs` (the `pack:private` script and the turbo task `@omnyo/plugin-sdk#pack:private`) and `packages/plugin-sdk/scripts/private-artifact.mjs` (`copyPrivateSdkArtifact`). Version lockstep stays with `scripts/bump-plugin-sdk.mjs`, which this change does not touch.
- **Preservation:** no runtime, build, packed artifact, persisted format, SDK export or UI depends on the script. Its only observable behavior on the current manifest is printing a pass message, and nothing invokes it to see that message. `vitest.config.ts` keeps its `scripts/**/*.test.mjs` glob, which still matches four other test files, so no configuration changes.
- **Reachability proof:** see the searches in Context. Remaining uncertainty is limited to manual steps or external automation outside this repository. The only one found is the retired private CI, where the script is already a no-op.
- **Non-goals:** this change does not decide whether the SDK should be published to npm, and it does not alter RF-017's CI decision. If public npm publication returns, write a new guard against the real package name rather than restoring this one.

**Expected gain and cost**

- **Production runtime lines:** 0 removed (the script is tooling and never ships).
- **Handwritten tooling lines:** 360 removed, 0 added (`wc -l packages/plugin-sdk/scripts/check-npm-version-guard.mjs`).
- **Test lines:** 200 removed (`wc -l packages/plugin-sdk/scripts/check-npm-version-guard.test.mjs`), 10 test cases.
- **Mechanisms:** before, a dormant publication-drift checker plus its tests; after, none.
- **Why maintenance gets easier:** readers no longer meet a second, stale account of how the SDK is released, and manifest or layout changes no longer leave dead fixtures to reconcile.
- **Performance:** one fewer test file per SDK test run. The time saved has not been measured and is expected to be small.
- **Cost:** two file deletions and one test run.

**Execution steps**

1. Reconfirm the baseline. From the repository root, run `git grep -n -I -i -E 'check-npm-version-guard|decideNpmVersionGuard|COMPARED_MANIFEST_FIELDS|private-publication-disabled' HEAD -- .`. Expect matches only inside the two files to be deleted. Run `ls .github 2>/dev/null` and expect nothing. Confirm that `packages/plugin-sdk/package.json` still has `"private": true`. Stop and re-plan if any of the following holds: a new consumer appears (a package script, a turbo task, a workflow file or a doc instruction), `.github/workflows` has returned with a step that calls the script, or the package is no longer private.
2. No new behavioral evidence is needed. The deleted test covers only the deleted function.
3. Delete `packages/plugin-sdk/scripts/check-npm-version-guard.mjs`.
4. Delete `packages/plugin-sdk/scripts/check-npm-version-guard.test.mjs`.
5. Leave `packages/plugin-sdk/vitest.config.ts`, `package.json`, `turbo.json`, `scripts/bump-plugin-sdk.mjs`, `pack-private.mjs` and `private-artifact.mjs` unchanged. Re-run the grep from step 1 and expect no matches. If the incidental-findings backlog lists ISS-X2-004, mark it resolved by RF-113.
6. Inspect `git diff --stat`. It should show exactly two deleted files, 560 lines in total. Commit only those two paths.

**Verification and acceptance criteria**

- Run `pnpm --filter @omnyo/plugin-sdk test` from the repository root. That invokes the package script `"test": "vitest run --config vitest.config.ts"`, confirmed in `packages/plugin-sdk/package.json`. Equivalently, run `pnpm test` in `packages/plugin-sdk`. Expected result: the suite passes, and `check-npm-version-guard.test.mjs` no longer appears in the file list. This was not run for this card, because the snapshot has no `node_modules`.
- Run `git grep -n 'check-npm-version-guard' HEAD -- .` from the repository root after committing. Expected result: no matches.
- Lint and format checks are optional for a pure deletion. If they are wanted, run `pnpm lint` from the root, which is `turbo run lint` in the root `package.json`. No formatter run is needed, because no surviving file changes.
- There are no UI, persisted-data or performance checks, because no runtime path changes.

**Rollback and stop conditions**

- **Rollback:** revert the deletion commit (`git revert <sha>`), or restore both files with `git checkout e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e -- packages/plugin-sdk/scripts/check-npm-version-guard.mjs packages/plugin-sdk/scripts/check-npm-version-guard.test.mjs`.
- **Stop before deleting** if step 1 finds a live consumer, or if Alex says a CI still runs `node packages/plugin-sdk/scripts/check-npm-version-guard.mjs` against this tree. That CI would then fail with a module-not-found error, exit code 1, which the retired workflow's step passes through. In that case, remove that CI step together with the script under RF-017.
- **Stop and re-plan** if public npm publication of the SDK is being reintroduced. Design a guard for the current package name instead of keeping this one.
