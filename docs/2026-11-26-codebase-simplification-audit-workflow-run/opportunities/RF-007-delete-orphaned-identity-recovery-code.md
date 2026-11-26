# RF-007 — Delete server-archive's orphaned retired-machine identity-recovery code (pre-stop held-fence writer, legacy V1 runtime readers, legacy runtime-archive reader)

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The central claim holds. The production count is slightly higher than the sweep stated (about 840, not 780-830). The test plan is corrected: one canonical-identity assertion in the first legacy test case must survive.
- **Potential:** medium. About 840 handwritten production lines and one whole inventory mode (the legacy `bb-app` V1 runtime identity) disappear from a package that every server, host-daemon, desktop and CLI build imports.
- **Confidence:** high. Every symbol has zero production references at the snapshot. The commit that removed the last callers is identified.
- **Readiness:** ready.
- **Effort:** small, about 2-3 hours including verification.
- **Risk:** low. This is a pure deletion of unreachable code. No persisted format, route, CLI flag or exported symbol with a consumer changes. The realistic regression is deleting a helper that live code shares, and `tsc --noEmit` catches that.
- **Prerequisites:** none.
- **Related and overlapping work:** RF-006 ("Retire the stopped-state BB-to-Omnyo identity adoption") owns the *live* held-fence readers (`readHeldFence`, `heldFenceSchema`, `heldFenceInput`, `restoreUnstagedOmnyoSourceFenceV1`) and the rest of the identity adoption controller. RF-007 must not touch those, and RF-006's line counts must not include the code deleted here. RF-007 can run before or independently of RF-006. If RF-006 is executed first and deletes all of `omnyo-state-root.ts`'s identity code, this card's `omnyo-state-root.ts` steps become part of that change; the `runtime-identity.ts`, `legacy-*-v1.ts` and barrel steps stay valid.
- **Why it deserves its place:** it is the safest large deletion in `packages/server-archive`. It removes a second runtime-identity inventory mode and about 450 lines of pre-stop fencing that still have to compile and stay consistent whenever the identity-adoption request schema, the maintenance hold or the runtime-identity module changes.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 26 November 2026). The paths, line numbers and searches below come from that commit, read with `git show`/`git grep` against the canonical repository. The audit worktree had already been removed. `git diff --stat e9e1b74c3 5f2d3f895 -- packages/server-archive apps/server/src/services/maintenance apps/server/src/omnyo-identity-adoption.ts` was empty, so the local `main` at `5f2d3f895` has the same content in these paths.

*Subsystem.* `@omnyo/server-archive` (`packages/server-archive`, `"private": true`, not published) holds server-move archives, maintenance holds and the stopped-state BB-to-Omnyo identity adoption. Until 10 November 2026 it also supported recovering two retired worker machines (the Mac Air and the 5080 PC). Those machines ran the old `bb-app` runtime at versions `0.46.238`-`0.46.245+private.1` with host-daemon protocol 252. That recovery needed three extra pieces:

1. A *pre-stop held fence*. While a live old worker was held for a desktop update, the fence wrote `held-source-fence-v1.json` and a sentinel `stateMigration` into the source `config.json`. It accepted either an "original held stop" receipt or a "disconnected stopped owner" receipt (`legacy-worker-stop-acquired-v1.json`, `legacy-worker-stop-request-v1.json`).
2. A *legacy installed-runtime identity reader* that inventoried a `bb-app` package by its declared `files`/`bin` role.
3. A *legacy runtime-archive reader* that listed files inside a `bb-app` `.tgz`.

*History (Proven by inspection).* In the retired private repository `$ARCHIVED_OMNYO_CHECKOUT`, commit `f0f0aa9a88` ("Remove the old-worker recovery and importers for retired machines", 10 November 2026) deleted every caller. Its body reads: "The Mac Air and the 5080 are retired and ~/.bb-dev is gone, so the protocol-252 recovery route, Windows and Mac worker adoption, and old startup fences go." It removed `packages/omnyo-app/src/legacy-worker-stop-v1.ts` (792 lines), `mac-worker-identity-v1.ts` (2,935), `windows-machine-state.ts` (1,458) and others. `git show f0f0aa9a88` contains the removed call lines `await prepareHeldIdentitySourceFenceV1(control, …)`, `await assertHeldIdentitySourceFenceV1(control)`, `assertOmnyoStateRootRollbackSelected(rollbackOwner)`, `await verifyInstalledLegacyRuntimeIdentityV1(…)`, `readInstalledLegacyRuntimeIdentityV1(…)`, `await readLegacyRuntimeArchiveFilesV1(…)` and `path: projectLegacyAppUpdateInventoryPathV1(paths[index])`. `git log -S assertOmnyoStateRootRollbackSelected -- apps packages scripts` ends at that commit. The commit kept "saved-config and server-archive importers". Those importers are `import.ts` and the `stageOmnyoStateRoot*` paths, which this card does not touch.

*Dead symbols at the snapshot (Proven by inspection).*

| File and lines | Symbol | References outside its own definition |
|---|---|---|
| `packages/server-archive/src/omnyo-state-root.ts:155-204` | `assertOmnyoStateRootRollbackSelected` (50 lines) | the barrel only (`src/index.ts:127`) |
| `packages/server-archive/src/omnyo-state-root.ts:322-363` | `assertHeldIdentitySourceFenceV1` (42) | barrel `index.ts:126`; called only at `:714` and `:765`, both inside `prepareHeldIdentitySourceFenceV1` |
| `packages/server-archive/src/omnyo-state-root.ts:365-468` | `assertDisconnectedStopAcquisitionV1` (104, not exported) | called only at `:561` inside `prepareHeldIdentitySourceFenceV1` |
| `packages/server-archive/src/omnyo-state-root.ts:470-768` | `prepareHeldIdentitySourceFenceV1` (299) | the barrel only (`index.ts:125`) |
| `packages/server-archive/src/legacy-runtime-archive-v1.ts` (whole file, 165) | `readLegacyRuntimeArchiveFilesV1`, `legacyRuntimeArchiveV1Schema` | barrel `index.ts:23-26`; `test/legacy-runtime-archive-v1.test.ts` |
| `packages/server-archive/src/runtime-identity.ts:434-458` | `verifyInstalledLegacyRuntimeIdentityV1` | `test/runtime-identity.test.ts` only (exported via `export *` at `index.ts:104` and the `./runtime-identity` subpath) |
| `packages/server-archive/src/runtime-identity.ts:460-470` | `readInstalledLegacyRuntimeIdentityV1` | `test/runtime-identity.test.ts` only |
| `packages/server-archive/src/runtime-identity.ts:154-212` | `installedLegacyRuntimeRootsV1` (59, not exported) | called only at `:352` inside the `legacyInputV1` branch of `inventoryRuntimeIdentity` |
| `packages/server-archive/src/runtime-identity.ts:325-356` | the `legacyInputV1` parameter of `inventoryRuntimeIdentity` (`:328`, `:338-342`, `:351-352`) | `true` is passed only by the two dead legacy functions (`:445`, `:468`); `createRuntimeIdentity` (`:407`) and `createWorkerRuntimeIdentity` (`:414`) pass `false` |
| `packages/server-archive/src/legacy-runtime-identity-v1.ts` (whole file, 49) | `legacyInstalledRuntimeVersionV1Schema`, `LEGACY_INSTALLED_RUNTIME_V1`, `legacyWorkerPackageRoleV1`, `legacyFullPackageRoleV1` | only the dead code above (`runtime-identity.ts:6-11`, `legacy-runtime-archive-v1.ts:9-13`, `omnyo-state-root.ts:15`, `:399`, `:586`), the barrel `index.ts:17` and the two test files |
| `packages/server-archive/src/legacy-app-update-files-v1.ts:477-481` | `projectLegacyAppUpdateInventoryPathV1` | the barrel only (`index.ts:4`) |

*Search method and scope.*

- Reproduced: `git grep -n -w <symbol> e9e1b74c3 -- .` over every tracked file in the snapshot, once per symbol in the table. Only the definitions, the barrel and the two named test files matched.
- Reproduced: case-insensitive substring searches for `HeldIdentitySourceFence`, `LegacyRuntimeArchive`, `LegacyRuntimeIdentity`, `RollbackSelected`, `LegacyAppUpdateInventoryPath`, `DisconnectedStopAcquisition`, `legacy-runtime-archive` and `legacy-runtime-identity` returned the same set. A substring search for `legacy-worker-stop-acquired-v1`, `legacy-worker-stop-request-v1`, `legacy-worker-bridge-acquired` and `disconnected-stopped-owner-v1` matched only `omnyo-state-root.ts`. Nothing in the snapshot writes those receipt files any more.
- Reproduced: every importer of `@omnyo/server-archive`, its `./runtime-identity` subpath and its raw `src/runtime-identity.(js|ts)` path imports by name. These include `apps/desktop/src/private-update-artifact.ts:12-17`, `apps/desktop/src/private-windows-update-artifact.ts:9-14`, `apps/desktop/scripts/smoke-private-updater.mjs:22`, `packages/omnyo-app/test/build-host-artifact.test.mjs:8-11`, `packages/omnyo-app/test/runtime-package-install.test.mjs:10-13`, `tests/qa/private-native/proof.mjs:35-38` and `apps/server/scripts/stream-server-export-core.ts:8`. They import only `createRuntimeIdentity`, `verifyRuntimeIdentity`, `readRuntimeIdentity`, `verifyWorkerRuntimeIdentity`, `parseRuntimeIdentity` and `runtimeIdentityDigest`. No file uses `import * as` from the package. The one dynamic import (`apps/server/test/services/plugins/omnyo-plugin-state.test.ts:439`) takes `stageOmnyoStateRoot`.
- Reproduced: `git grep` in `$OMNYO_PLUGIN_CHECKOUT` for `server-archive` and the legacy symbol names returned nothing. No first-party plugin imports this private package, and the plugin SDK does not re-export it.
- Proven by inspection: the bundled identity-adoption entry, `apps/server/src/omnyo-identity-adoption.ts:26-59`, accepts only the phases `preflight`, `preflight-database`, `stage`, `verify-database` and `rollback`. It imports `OmnyoStateWorkPendingError`. The controller it drives, `apps/server/src/services/maintenance/omnyo-identity-controller-v1.ts:20-36`, imports none of the dead symbols.
- Reproduced: no docs, `*.md` file, `.oxlintrc.json`, Containerfile or turbo/CI configuration names the dead files or symbols (`git grep` over the whole snapshot, plus `-i "pre-stop|held source fence|legacy runtime archive|installed legacy runtime"` over docs and Markdown).
- Limit: a search with no matches does not prove there is no consumer outside the inspected repositories. The package is `"private": true` and is consumed only as a pnpm workspace dependency (`apps/cli`, `apps/desktop`, `apps/host-daemon`, `apps/server`, `packages/omnyo-app`), so no external or older client can import it.

*Live neighbours that must stay (Proven by inspection).* In `omnyo-state-root.ts`, `heldFenceSchema` (`:206-219`), `heldFenceInput` (`:221-234`) and `readHeldFence` (`:236-320`) are still read by live code at `:1345` and `:1956` and by `restoreUnstagedOmnyoSourceFenceV1` (`:3011-3049`). That function is exported and imported by `omnyo-identity-controller-v1.ts:32`. `jobSchema` keeps its `"rollback-selected"` phase because live code still parses the schema at `:868`, `:1168`, `:1516`, `:1960` and `:2518` (the last is inside `rollBackOmnyoStateRoot`). In `legacy-app-update-files-v1.ts`, `adoptLegacyAppUpdateFilesV1` and `assertLegacyAppUpdateOwnerStoppedV1` are live (imported at `omnyo-state-root.ts:1-4`), and so is the module constant `pairs` (`:23`). After the deletions, the remaining live uses of every helper the dead functions share were counted: `writeFence` 4, `readConfig` 16, `binding` 37, `assertInput` 6, `fileDigest` 10, `optionalInfo` 45, `withFileLock` 6, `parseAppManagedConfig` 4, `readMaintenanceHold` 4, `readOmnyoStateAdmission` 5, `createHash` 5, `realpath` 8. None become unused. Only these imports become unused: `identityAdoptionBindingSchema` (`omnyo-state-root.ts:46`), the whole `./runtime-identity.js` import (`:74-78`) and the `./legacy-runtime-identity-v1.js` import (`:15`).

*Current maintenance cost.* A change to `identityAdoptionControlRequestSchemaV1`/`identityAdoptionBindingSchema` in `@omnyo/domain`, to `readMaintenanceHold` semantics, or to `runtimeIdentitySchema`/`verifyWorkerRuntimeIdentity` still has to keep about 450 lines of unreachable fencing compiling and plausibly correct. Anyone editing `inventoryRuntimeIdentity` also has to reason about a second package-name, version-allowlist and role-inference mode that no supported runtime uses.

**Proposed end state and preservation argument**

*What disappears:* the pre-stop fence writer and its two assertions, the rollback-selected assertion, the legacy runtime-archive reader, the legacy installed-runtime identity readers, the legacy package-role tables, the projection helper, the `legacyInputV1` mode of `inventoryRuntimeIdentity`, and their barrel exports.

*What remains:*
- `inventoryRuntimeIdentity(root, labels, worker = false)` keeps one mode. The package name must be `"omnyo-app"` and `labels.runtimeVersion` must equal `package.json` `version`. When `worker` is true, `assertWorkerPackageRole` runs and the roots are `["dist", "host-daemon/dist", "package.json"]`; otherwise the roots are `roots`.
- `createRuntimeIdentity`, `createWorkerRuntimeIdentity`, `verifyRuntimeIdentity`, `verifyWorkerRuntimeIdentity`, `readRuntimeIdentity`, `parseRuntimeIdentity` and `runtimeIdentityDigest` keep their exact signatures and behavior. With `legacyInputV1 === false`, each removed condition was already `false`, so the canonical path computes the same result. The error text "Runtime package version mismatch" is unchanged.
- The held-fence *readers* and `restoreUnstagedOmnyoSourceFenceV1` stay unchanged and belong to RF-006.

*Contracts affected:* only the exported names in the barrel and the `./runtime-identity` subpath, none of which has a consumer. No persisted file format changes. The deleted code was the only writer of `held-source-fence-v1.json`, and its readers stay, so a job directory that still holds such a file is handled exactly as today. There are no routes, CLI flags, settings keys or UI states involved.

*Non-goals:* do not touch `readHeldFence`, `heldFenceSchema`, `heldFenceInput`, `restoreUnstagedOmnyoSourceFenceV1`, the `acquisitionKind` enum inside `heldFenceSchema` (`:211-214`), the `legacy-worker-stop-acquired-v1.json` check inside `readHeldFence` (`:302-317`), `jobSchema` phases, `adoptLegacyAppUpdateFilesV1`, `assertLegacyAppUpdateOwnerStoppedV1`, `legacy-state-marker-path-v1.ts`, or the import/archive code. All of these are live or belong to RF-006.

*Why this is the simplest sufficient option:* it is deletion only. Nothing is moved and no new abstraction is added.

**Expected gain and cost**

Production lines removed (Reproduced, counted from `git show e9e1b74c3:<file>` with a line-range script, including one trailing blank line per deleted block):

| File | Lines removed |
|---|---|
| `src/omnyo-state-root.ts` | 500 for the four functions, plus 7 for imports (`:15`, `:46`, `:74-78`), about 507 |
| `src/runtime-identity.ts` | 110 (imports `:6-11`, `installedLegacyRuntimeRootsV1`, legacy branches, the two legacy functions), minus about 1-2 if the formatter reflows the surviving ternary, about 108-110 |
| `src/legacy-runtime-archive-v1.ts` | 165 (whole file) |
| `src/legacy-runtime-identity-v1.ts` | 49 (whole file) |
| `src/legacy-app-update-files-v1.ts` | 6 |
| `src/index.ts` | 11 (`:4`, `:17-18`, `:23-27`, `:125-127`) |
| **Total** | **about 840-850 removed, 0 added** (8,802 lines are in `packages/server-archive/src` today) |

- Tests: delete `test/legacy-runtime-archive-v1.test.ts` (120 lines). In `test/runtime-identity.test.ts` (290 lines), replace the legacy cases at `:49-170` (122 lines) and drop the legacy imports (`:9-10`, `:15-18`) with one canonical test of about 15 lines. That is a net of about 113 lines, so about 230 test lines in total.
- Mechanisms: before, there are two runtime-identity inventory modes (canonical `omnyo-app` and legacy V1 `bb-app` with role inference and a version allowlist) and two held-fence entry points (the writer `prepare…` plus `assert…`) beside the live readers. After, there is one inventory mode and only the live held-fence readers. One whole module of shared legacy constants disappears.
- Maintenance example: today a field added to `identityAdoptionBindingSchema` must be checked against four strict zod parses in dead code (`:394`, `:434`, `:581`, `:636`). After this change only live code parses it.
- Performance: neutral at runtime, because the code is never executed. Bundles that include the barrel (`packages/omnyo-app/scripts/build.mjs`, `build-host.mjs`) may shrink slightly. That is a hypothesis and has not been measured.
- Cost: about 2-3 hours, almost all of it verification.

**Execution steps**

1. **Reconfirm the baseline.** In a clean worktree of current `main`, rerun the symbol search:
   `git grep -n -w -E "assertOmnyoStateRootRollbackSelected|assertHeldIdentitySourceFenceV1|assertDisconnectedStopAcquisitionV1|prepareHeldIdentitySourceFenceV1|readLegacyRuntimeArchiveFilesV1|legacyRuntimeArchiveV1Schema|verifyInstalledLegacyRuntimeIdentityV1|readInstalledLegacyRuntimeIdentityV1|installedLegacyRuntimeRootsV1|projectLegacyAppUpdateInventoryPathV1|legacyInstalledRuntimeVersionV1Schema|LEGACY_INSTALLED_RUNTIME_V1|legacyWorkerPackageRoleV1|legacyFullPackageRoleV1"`.
   Expect matches only in `packages/server-archive/src/**`, `src/index.ts`, `test/legacy-runtime-archive-v1.test.ts` and `test/runtime-identity.test.ts`. **Re-plan** if any other file matches, if a new caller of `prepareHeldIdentitySourceFenceV1` appears, or if RF-006 has already changed `omnyo-state-root.ts` (in that case, re-derive the line ranges by symbol name). Line numbers below refer to the snapshot; locate everything by symbol.
2. **`packages/server-archive/src/omnyo-state-root.ts`.**
   - Delete `assertOmnyoStateRootRollbackSelected` (the whole function, `:155-204`).
   - Delete `assertHeldIdentitySourceFenceV1`, `assertDisconnectedStopAcquisitionV1` and `prepareHeldIdentitySourceFenceV1` (`:322-768`, contiguous).
   - Keep `heldFenceSchema`, `heldFenceInput` and `readHeldFence` exactly as they are.
   - Remove the now-unused imports: `legacyInstalledRuntimeVersionV1Schema` (`:15`), `identityAdoptionBindingSchema` (`:46`, keeping `identityAdoptionControlRequestSchemaV1` and `type IdentityAdoptionControlRequestV1`), and the whole `./runtime-identity.js` import (`:74-78`). Leave every other import, because each still has live uses (see Context).
   - Checkpoint: `pnpm --filter @omnyo/server-archive typecheck` must pass with no unused-import or missing-name errors (`noUnusedLocals` may or may not be on; inspect the diff for unused names either way).
3. **`packages/server-archive/src/runtime-identity.ts`.**
   - Delete the import of `./legacy-runtime-identity-v1.js` (`:6-11`).
   - Delete `installedLegacyRuntimeRootsV1` (`:154-212`).
   - Change `inventoryRuntimeIdentity` to `(root, labels, worker: boolean = false)`. Replace the guard with `actual.name !== "omnyo-app" || labels.runtimeVersion !== actual.version`. Replace the roots argument with `worker ? ["dist", "host-daemon/dist", "package.json"] : roots`.
   - Change the callers: `createRuntimeIdentity` calls `inventoryRuntimeIdentity(root, labels)`, and `createWorkerRuntimeIdentity` calls `inventoryRuntimeIdentity(root, labels, true)`.
   - Delete `verifyInstalledLegacyRuntimeIdentityV1` (`:434-458`) and `readInstalledLegacyRuntimeIdentityV1` (`:460-470`).
4. **Delete files.** Delete `packages/server-archive/src/legacy-runtime-archive-v1.ts` and `packages/server-archive/src/legacy-runtime-identity-v1.ts`. Both are clean tracked files; name them in the change report.
5. **`packages/server-archive/src/legacy-app-update-files-v1.ts`.** Delete `projectLegacyAppUpdateInventoryPathV1` (`:477-481`) and the blank line before it. Keep `pairs`.
6. **`packages/server-archive/src/index.ts`.** Remove `projectLegacyAppUpdateInventoryPathV1` from the first export block. Remove the `legacyInstalledRuntimeVersionV1Schema` export line (`:17`). Remove the `legacyRuntimeArchiveV1Schema`/`readLegacyRuntimeArchiveFilesV1` block (`:23-26`). Remove `prepareHeldIdentitySourceFenceV1`, `assertHeldIdentitySourceFenceV1` and `assertOmnyoStateRootRollbackSelected` from the `./omnyo-state-root.js` block (`:125-127`). `export * from "./runtime-identity.js"` stays and now simply exports fewer names.
7. **Tests.**
   - Delete `packages/server-archive/test/legacy-runtime-archive-v1.test.ts`. It tests only the deleted reader.
   - In `packages/server-archive/test/runtime-identity.test.ts`, remove `verifyInstalledLegacyRuntimeIdentityV1` and `readInstalledLegacyRuntimeIdentityV1` from the import (`:9-10`), and remove the `../src/legacy-runtime-identity-v1.js` import (`:15-18`).
   - Replace the `it.each([...])` case (`:49-123`) and the "reads only the positively declared finite V1 worker role" case (`:125-170`) with one canonical case that preserves the two non-legacy obligations from the first case: (a) `verifyRuntimeIdentity(f.root, f.identity)` resolves to `f.identity` for a canonical `omnyo-app` fixture; (b) after rewriting `package.json` to `{ name: "bb-app", version: <same> }`, both `createRuntimeIdentity(f.root, f.identity)` and `verifyRuntimeIdentity(f.root, f.identity)` reject with `/package version/`. Keep `fixture()`, the worker case (`:172+`), the digest-mismatch case (`:246`) and the example-limit case (`:270`) unchanged. Remove `createHash`/`readFile` from the imports only if they become unused.
8. **Formatting and lint.** From the repository root, run `pnpm exec oxlint --fix <changed files>`, `pnpm exec oxfmt <changed files>`, then `pnpm exec oxlint --deny-warnings --format=agent`.
9. **Final review.** Rerun the step 1 `git grep`. It must return nothing. Inspect `git diff --stat` and confirm that only the files named above changed. Recount with `wc -l packages/server-archive/src/*.ts` against 8,802 at the snapshot and record the actual reduction.

**Verification and acceptance criteria**

Working directory is the repository root unless stated. The scripts named here exist in the snapshot's `package.json` files (read for this card). They were not run during the audit, because the snapshot had no `node_modules`.

- `pnpm --filter @omnyo/server-archive typecheck` (script `tsc --noEmit`; `tsconfig.json` includes `src` and `test`). Expected: passes.
- `pnpm --filter @omnyo/server-archive test` (script `vitest run --config vitest.config.ts`). Expected: passes. In particular, `test/runtime-identity.test.ts` still covers the canonical, worker, digest-mismatch and example-limit cases, and `omnyo-state-root*.test.ts` and `identity-hold-v1.test.ts` pass unchanged, which shows that the surviving held-fence readers and staging paths are untouched.
- Consumer typechecks, because the barrel shrinks: `pnpm --filter @omnyo/server typecheck`, `pnpm --filter @omnyo/host-daemon typecheck`, `pnpm --filter @omnyo/desktop typecheck`, `pnpm --filter @omnyo/cli typecheck` and `pnpm --filter omnyo-app typecheck`. Alternatively, run `pnpm typecheck` (turbo) once at the end. Expected: all pass with no change outside `packages/server-archive`.
- Focused live-path test: `pnpm --filter @omnyo/server exec vitest run test/system/omnyo-identity-controller.test.ts` (direct vitest invocation; the file exists at the snapshot, but this exact invocation is unconfirmed). It exercises `restoreUnstagedOmnyoSourceFenceV1` and the `held-source-fence-v1.json` reader. Expected: passes unchanged.
- Lint and format: `pnpm exec oxlint --deny-warnings --format=agent` and `pnpm format:check`. Expected: clean.
- Structural completion: the step 1 `git grep` returns nothing. `packages/server-archive/src/legacy-runtime-archive-v1.ts` and `legacy-runtime-identity-v1.ts` no longer exist. `inventoryRuntimeIdentity` has no `legacyInputV1` parameter. No test or production assertion was weakened. In particular, the canonical rejection of a `bb-app` package name survives as an explicit test.
- No UI, performance or persisted-data checks apply: the deleted code had no UI, ran on no supported path and wrote no file that any live path still produces.

**Rollback and stop conditions**

- *Rollback:* the change is one self-contained commit confined to `packages/server-archive`. Revert that commit to restore everything. There are no data, migration or compatibility implications, because no deleted code runs on any supported path.
- *Stop and re-plan if:*
  - the step 1 search finds a consumer outside `packages/server-archive` (for example, a reintroduced worker-recovery route or a script);
  - Alex says a retired worker (the Mac Air, the 5080, or a `~/.bb-dev` `bb-app` 0.46.x install) still needs recovery. That is a product decision: keep the code and record it under RF-006;
  - a consumer typecheck fails on a removed name, which means a caller was missed. Restore that symbol and investigate the caller rather than stubbing it;
  - any `omnyo-state-root*.test.ts` or the identity-controller test starts failing, which means a shared helper was removed by mistake. Restore it.
- *Smaller safe alternative:* if `omnyo-state-root.ts` is mid-change under RF-006, land steps 3-7 for `runtime-identity.ts`, the two `legacy-*-v1.ts` files and `projectLegacyAppUpdateInventoryPathV1` first. Those changes are independent. The four `omnyo-state-root.ts` functions then go with RF-006. In that order `legacy-runtime-identity-v1.ts` cannot be deleted yet, because `omnyo-state-root.ts:399` and `:586` still import its version schema.
