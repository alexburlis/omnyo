# RF-078 — Delete the orphaned root changelog modules (`RELEASE_META`, `parseChangelog`) and the turbo cache inputs that keep them alive

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The central claim holds as the sweep described it. Two corrections follow. First, removing the two input lines leaves `@omnyo/app#typecheck` identical to the generic `typecheck` task, so that whole override block can go too. Second, the release-process step that edits `RELEASE_META` does not exist in this public repository; it lives only in the retired private checkout.
- **Potential:** low. The change is small, but it removes dead machinery completely: two modules nobody imports, and cache inputs that rebuild the app for no effect.
- **Confidence:** high (Proven by inspection).
- **Readiness:** ready.
- **Effort:** under one hour.
- **Risk:** very low. Nothing in the snapshot imports, globs or reads the files. The only residual consumers are outside this repository (see Context).
- **Prerequisites:** none.
- **Related or overlapping RF ids:** none overlap. RF-020 also edits `turbo.json`, but it touches the plugin-SDK task entries, not the `@omnyo/app#*` entries. If both land, rebase the second change; the hunks do not overlap.
- **Why it deserves its place:** this is a zero-judgment deletion of dead code. Today the files still count as cache inputs for three `@omnyo/app` tasks (build, typecheck, test), so any edit to them busts those caches. Their content is a stale pre-rename "bb" release table (last entry `0.46.0`, October 9, 2026) that nothing renders. Keeping them misleads readers into thinking the app has an in-app changelog.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The planned read-only worktree was missing from disk, so every check below ran with `git show`/`git grep` against that commit in `$OMNYO_CHECKOUT`. The snapshot has no `node_modules`, so no build, typecheck or test was executed.

What exists (observed facts):

- `changelog-metadata.ts` (repository root, 79 lines) declares the type `ReleaseMeta` and exports `RELEASE_META: Record<string, ReleaseMeta>`, a map from version to `{ date, headline }`. It runs from `"0.46.0"` (October 9, 2026) down to `"0.0.29"` (July 9, 2026). These are bb-era versions, and nothing has updated the map since.
- `changelog-parser.ts` (repository root, 106 lines) exports the types `ChangelogBlock` and `ChangelogEntry` and the function `parseChangelog(markdown)` (line 16).
- `turbo.json` lists both files as `$TURBO_ROOT$` inputs in three places:
  - `@omnyo/app#test` inputs, lines 57–58;
  - `@omnyo/app#build` inputs, lines 77–78;
  - `@omnyo/app#typecheck`, lines 532–539. Its only inputs are `$TURBO_DEFAULT$` plus the two changelog lines at 536–537, and its `dependsOn: ["topo"]` matches the generic `typecheck` task at lines 529–531.
- The snapshot has no `CHANGELOG.md` (`git ls-tree -r --name-only <C> | grep -i changelog` returns only the two `.ts` files).

Reachability proof (Proven by inspection):

- `git grep -n -E "RELEASE_META|changelog-(metadata|parser)|parseChangelog|ReleaseMeta|CHANGELOG" e9e1b74c3b` (whole tree) returns only the two files themselves, the six `turbo.json` lines, and `docs/api_to_audit.md:505`. That last hit is prose about a CHANGELOG entry for plugin renames and does not reference these files.
- A broader `git grep -n -i changelog` over non-Markdown files finds only unrelated strings: test fixtures, the website's own `/changelog` route in `apps/web/src/landing/site-chrome.test.tsx:12` and `apps/web/src/server/sitemap.test.ts:35`, public skill catalog data, and `packages/connect-db/src/constants.ts:20`. One more hit is the legacy preference key `"bb.settings.updates.dismissed-changelog-version"` at `apps/app/src/lib/legacy-browser-preferences.ts:99`. That key is a string in the browser-preference adoption table and does not import these modules.
- `apps/app/tsconfig.json` includes only `src`, `test`, `tests`, `fixtures` and `stories`. `apps/app/tsconfig.node.json` includes only the named `vite*.ts` files. Neither config pulls in root-level `.ts` files. No `import.meta.glob` or `readdirSync` in `apps/app` or `scripts` addresses the repository root (`git grep -n -E "import\.meta\.glob\([^)]*\.\./\.\./(\.\./)?\*|readdirSync\((repoRoot|root)" <C> -- apps/app scripts`: no hits).
- No package `exports` field, SDK or plugin-SDK entry, Containerfile, desktop or mobile build config, CLI command or migration names either file. The grep above covers the whole tree, including those locations.
- Repository tests that read `turbo.json` (`packages/scripts/test/bundled-plugin-tasks.test.mjs:8`, `packages/scripts/test/omnyo-source-map.test.mjs:425`, `packages/plugin-build/src/bundled-workspace.test.ts:58`) assert on plugin tasks or fixtures. None asserts on `@omnyo/app#*` inputs (`git grep -n -E "@omnyo/app#|TURBO_ROOT" <C> -- packages/scripts/test packages/plugin-build/src scripts` returns only the plugin-input check at `bundled-plugin-tasks.test.mjs:53`).

History (Proven by inspection):

- In the public repository, both files arrived in `060950255` ("Publish Omnyo source") and were never touched again.
- In the retired private checkout `$ARCHIVED_OMNYO_CHECKOUT`, commit `a6c8a703b9` (2026-11-11, "Link the Omnyo website in Settings and drop the bb changelog") deleted the only consumer, `apps/app/src/components/settings/changelog-preview.ts`. That file imported `CHANGELOG.md?raw`, `parseChangelog` and `RELEASE_META` from the repository root. The same commit removed the Updates-section changelog preview, but it left the two root modules and their turbo inputs behind.

Counterevidence and out-of-tree references (observed in the retired private checkout, not in this repository):

- `docs/omnyo-release-process.md:116` there tells the release operator to update `RELEASE_META` in `changelog-metadata.ts`.
- `scripts/private-delivery-plan.mjs:38` there lists `changelog-metadata.ts` as a path to deliver, and its test (`scripts/private-delivery-plan.test.mjs`) uses the name in fixtures.
- Some evidence JSON there (`docs/evidence/bb-stability-2026-10-21/...turbo-run-proof-projection.json`) records the old input hashes. That is historical proof, not a consumer.
- None of these files exists in the public snapshot. Treat them as information for the release-process owner, not as a reason to keep the code.

Current requirement: none. The modules served the in-app Updates changelog preview, which was removed on 2026-11-11.

Maintenance cost today: two modules a reader has to understand and rule out, a stale release table that suggests a release step, and three turbo task definitions that rehash two dead files. Any edit to them (for example, someone following the old release step) invalidates the `@omnyo/app` build, typecheck and test caches.

**Proposed end state and preservation argument**

What disappears:

- `changelog-metadata.ts` and `changelog-parser.ts` at the repository root.
- The two `$TURBO_ROOT$/changelog-*.ts` lines in `@omnyo/app#test` and in `@omnyo/app#build`.
- The whole `@omnyo/app#typecheck` block (`turbo.json:532–539`). Once its two changelog inputs go, it is `{ "dependsOn": ["topo"], "inputs": ["$TURBO_DEFAULT$"] }`, which is what the generic `typecheck` task (`dependsOn: ["topo"]`, default inputs) already gives every package.

What remains unchanged:

- Every other input of `@omnyo/app#test` and `@omnyo/app#build`.
- The generic `typecheck` task.
- The website `/changelog` page in `apps/web`, which is a separate feature with no dependency on these files.
- The legacy preference key `bb.settings.updates.dismissed-changelog-version` in `apps/app/src/lib/legacy-browser-preferences.ts:99` and its test `apps/app/src/lib/legacy-core-browser-preferences.test.ts:60`. They belong to the browser-preference adoption contract, which is out of scope here.
- `"rootDir": "../.."` in `apps/app/tsconfig.json`. App stories still import from `plugins/` (for example `apps/app/src/components/onboarding/Onboarding.stories.tsx:27`), so that setting is still needed.

Preservation argument: no runtime, build, typecheck, test, lint or packaging path reads either file, so the product behaves identically after the change. The cache inputs of the three app tasks shrink by two files each. That can only remove false invalidations and cannot hide a real dependency, because no source in `apps/app` imports these files. Dropping the `@omnyo/app#typecheck` override leaves the resolved task definition equal to the generic one.

Non-goals:

- Do not edit the retired private checkout's release doc or delivery planner.
- Do not touch the website changelog, the legacy preference key or `apps/app/tsconfig.json`.

Remaining uncertainty: an out-of-tree script that imports `RELEASE_META` from a public checkout. None is known. The private delivery planner only lists the path, and the retired checkout is not a delivery target for the public repository.

**Expected gain and cost**

- Handwritten production lines removed: 185 (`git show <C>:changelog-metadata.ts | wc -l` gives 79; `git show <C>:changelog-parser.ts | wc -l` gives 106).
- Configuration lines removed from `turbo.json`: 12 (lines 57–58, 77–78 and the 8-line block at 532–539).
- Tests, generated code, docs and assets: none removed or added.
- Mechanisms removed: one stale release-metadata table, one unused Markdown parser, three redundant cache-input entries and one redundant task override.
- Performance: fewer false cache invalidations of `@omnyo/app` build, typecheck and test when someone touches these files (projection, not measured). Turbo may invalidate caches once when `turbo.json` changes; that one-time cost is expected.
- Cost: nothing is added.

**Execution steps**

1. Reconfirm the baseline. From `$OMNYO_CHECKOUT` (or a fresh worktree off current `main`), run `git grep -n -E "RELEASE_META|changelog-(metadata|parser)|parseChangelog" HEAD`. Expect only the two files and the `turbo.json` lines. Stop and re-plan if any other file now imports or names them, for example a newly added `CHANGELOG.md` consumer, an app import, or a script.
2. Delete `changelog-metadata.ts` and `changelog-parser.ts` at the repository root with `git rm`.
3. Edit `turbo.json`:
   - In `"@omnyo/app#test".inputs`, remove `"$TURBO_ROOT$/changelog-metadata.ts"` and `"$TURBO_ROOT$/changelog-parser.ts"`.
   - In `"@omnyo/app#build".inputs`, remove the same two lines.
   - Remove the whole `"@omnyo/app#typecheck": { ... }` entry, including its trailing comma, so that `"typecheck"` is followed directly by `"@omnyo/host-daemon#build"`.
4. Checkpoint: `node -e 'JSON.parse(require("fs").readFileSync("turbo.json","utf8"))'` at the repository root parses without error. Then run `rg -n "changelog-(metadata|parser)" turbo.json`, which must find nothing.
5. Run the verification below and read the full diff (`git diff --stat` should show exactly two deletions and one `turbo.json` change).
6. In the report, tell the release-process owner (Alex) that step 4 of the retired private `docs/omnyo-release-process.md` (update `RELEASE_META`) no longer has an effect. Also mention that the private `scripts/private-delivery-plan.mjs:38` path list names a file that no longer exists in the public repository. Do not edit those files from this change.

**Verification and acceptance criteria**

Run all commands from the repository root after `pnpm install`. Each command was confirmed to exist in the snapshot's `package.json` files, but none was executed for this card, because the snapshot has no `node_modules`.

- `pnpm exec turbo run typecheck build test --filter=@omnyo/app --dry=json > "$TMPDIR/rf078-dry.json"`. Turbo is a root devDependency (`turbo ^2.10.12`). In the output, the `resolvedTaskDefinition.inputs` of `@omnyo/app#build` and `@omnyo/app#test` must no longer contain the changelog paths. `@omnyo/app#typecheck` must resolve with `dependsOn` containing `topo` and default inputs. For comparison, run the same command before the edit and diff the two files; the only differences should be the removed inputs and the hashes.
- `pnpm --filter @omnyo/app typecheck` (the script is `tsc --noEmit && tsc --noEmit -p tsconfig.node.json`) must pass.
- `pnpm --filter @omnyo/app build` must pass.
- `pnpm --filter @omnyo/scripts test` must pass, which covers the tests that read `turbo.json` (`packages/scripts/test/bundled-plugin-tasks.test.mjs`, `omnyo-source-map.test.mjs`). Running the full app test suite is not required; no app test referenced these modules.
- `pnpm exec oxfmt --check turbo.json` must pass (the root `format:check` script is `oxfmt . --check`).
- Acceptance: `git grep -n -E "RELEASE_META|changelog-(metadata|parser)|parseChangelog" HEAD` returns nothing, and no UI changes (there is no UI surface).

**Rollback and stop conditions**

- Rollback: `git revert <commit>` restores both files and the turbo entries. Nothing persisted, migrated or published depends on them.
- Stop and re-plan if step 1 finds a new consumer, or if `@omnyo/app` typecheck or build fails with an unresolved import of either file.
- Also stop if the dry run shows `@omnyo/app#typecheck` resolving to something other than `dependsOn: ["topo"]` with default inputs. In that case, keep the block with only `"$TURBO_DEFAULT$"` and report the difference.
