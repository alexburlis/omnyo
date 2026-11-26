# RF-056 — Give `runServer` one owner for starting and stopping background work, and build its dependency bags from `appDeps`

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplication is real and is located where the sweep said it is. The plan needs two corrections. First, boot cannot call a single start function, because boot starts the prewarms before the startup recovery sweep and the HTTP listener but starts the sweep interval and catalog refresh after them. Second, boot never starts plugin update checks directly. It starts them through `startServerPlugins`, and on the completed-move branch it does not start them at all.
- **Potential:** medium. The change touches one file and removes about 55–70 handwritten production lines. More importantly, it removes the need for coordinated edits across four lifecycle sites and four dependency literals.
- **Confidence:** high for the dependency-bag part, and medium-high for the lifecycle part, because no automated test exercises the maintenance resume and suspend wiring in `start-server.ts`.
- **Readiness:** ready.
- **Effort:** small, about half a day including the ordering review.
- **Risk:** low to moderate. The realistic regressions are lifecycle-ordering mistakes: starting the sweep interval twice, awaiting the recovery sweep where it is fire-and-forget today, or installing the prewarms after the listener starts. No persisted data, wire contract or public export changes.
- **Prerequisites:** none.
- **Related and overlapping items:** ISS-S08-002 records the latent reference from `appUpdate`'s callbacks to `sweepDeps` before `sweepDeps` is declared. This card moves the declaration earlier, which narrows that window, but this card does not depend on that issue. RF-005, RF-006 and RF-008 may edit the early boot section of `apps/server/src/start-server.ts` (lines 130–240). Those edits would cause textual conflicts only, not semantic ones. No other RF item covers this mechanism.
- **Why it deserves its place:** `runServer` is the server's composition root. Every new background service or new shared dependency currently needs up to four matching edits, and none of the resume or suspend paths has a test that would catch a missed edit. The fix is local, mechanical and easy to review.

**Context and evidence**

The snapshot for this card is commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The worktree named in the audit brief no longer existed when this card was written, so every source was read with `git show e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e:<path>` from `$OMNYO_CHECKOUT`. The line numbers below are from that commit.

`apps/server/src/start-server.ts` "runServer" (line 135) builds the server's services, creates the Hono app, starts the HTTP listener and wires maintenance and shutdown. Starting at the prewarm installs, it runs a group of background services when no server move is pending and no maintenance hold is held. Those services are the provider-model catalog prewarm, the voice-input prewarm, project remote sync, a 10-second sweep interval (telemetry prune plus periodic sweeps), plugin periodic update checks and the plugin catalog periodic refresh.

Observed facts. Each one is **Proven by inspection** of the snapshot source.

| Site | Lines | What it does |
|---|---|---|
| Boot, part 1 | 644–657 | Three `let` handles are each guarded by `pendingServerMove === null && !bootMaintenanceHeld`, with `installProviderModelCatalogPrewarm(sweepDeps)`, `installVoiceInputPrewarm(sweepDeps)` and `installProjectRemoteSync(sweepDeps)`. This runs before the awaited `runStartupRecoverySweep` (659–667) and before `startHttpListener` (676). |
| Boot, part 2 | 695, 697–723 | `let sweepInterval` is declared. Inside the same guard: either the completed-move branch (`providerRegistry.markRegistrationsSettled()`, with no plugin start and no update checks) or `void startServerPlugins(...)` (which calls `startPeriodicUpdateChecks` in its `finally`, lines 115–128). Then `pluginCatalogService.startPeriodicRefresh()` and the first copy of the `setInterval` body. This runs after the listener and after `pluginService.bindSdk` (692). |
| Maintenance resume (`start` callback) | 735–755 | `pendingInteractions.start()`, three `??=` installs, fire-and-forget `runStartupRecoverySweep`, `pluginService.startPeriodicUpdateChecks()`, `pluginCatalogService.startPeriodicRefresh()`, and a second, semantically identical copy of the `setInterval` body guarded by `sweepInterval === null`. |
| Maintenance suspend | 756–770 | Stops and nulls the three handles, `stopPeriodicRefresh`, `await stopPeriodicUpdateChecks()`, then clears and nulls the interval. |
| Shutdown (`runShutdown`) | 785–787, 792–797 | Stops the three handles (without nulling them), clears the interval, `stopPeriodicRefresh`, `await stopPeriodicUpdateChecks()`. These lines are interleaved with unrelated steps: `eventLoopStallMonitor.stop()`, `performanceDiagnostics.stop()` and `stopDaemonLivenessChecks()`. |

`apps/server/src/services/maintenance/server-maintenance.ts` "bindFrameworkResume" (line 192) stores the three callbacks. `release` calls `await resumeFramework?.()` and then `startDeferred?.()` (lines 557–558). `acquire` calls `await suspendFramework?.()` before suspending plugins and checking quiescence (line 282). The suspend callback therefore must finish stopping all background work before quiescence is checked.

There are four dependency bags. Each is **Proven by inspection**:

- `appDeps` (511–534) has 23 fields.
- The literal passed to `disconnectImportedDaemonSessions` (564–582, 19 lines) has 14 fields, all of them in `appDeps`. The parameter type is `LostHostWorkDeps = LoggedPendingInteractionWorkSessionDeps` (`apps/server/src/internal/session-owner-side-effects.ts:53`, `apps/server/src/types.ts:95`), which is a `Pick` of required `AppDeps` fields.
- The literal passed to `startDaemonLivenessChecks` (607–623, 17 lines) has 15 fields, all of them in `appDeps`. The parameter type is `LoggedPendingInteractionWorkSessionDeps & Pick<AppDeps, "sharedPorts">` (`apps/server/src/ws/daemon-protocol.ts:493`).
- `sweepDeps` (625–642, 18 lines) contains 14 `appDeps` fields plus `pluginSchedules: pluginService` and `plugins: pluginService`.

The literals are bound to variables or passed as non-fresh values after this change, so TypeScript's excess-property check does not apply.

Searches for consumers whose behavior would change if they received a superset:

- `git grep -n -E "(sharedPorts|watchInterests|workspaceReadCaches|appUpdate|providerNativeRoots|commandMetadata|appVersion|managedAppConfig|commandCatalogs)\?:" e9e1b74c3 -- apps/server/src` returned one hit: `sharedPorts?:` in `apps/server/src/services/plugins/plugin-service-internal.ts:73` "PluginServiceDeps". Plugin-service construction in `server.ts` uses that type. None of the four call paths here uses it.
- `git grep -n -E "Object\.(keys|entries|values)\(deps\)|structuredClone\(deps|JSON\.stringify\(deps|\.\.\.deps[,} ]"` over `apps/server/src` found only shallow spread-and-override copies, such as `{ ...deps, db: tx }`. None enumerates or serializes the dependency bag.
- The only optional `plugins?` consumers (`apps/server/src/ws/daemon-protocol.ts:188` and the thread routes) are unaffected, because `appDeps` has no `plugins` field and `sweepDeps` already has one today.

Tests that encode the shape of `runServer`:

- `apps/server/test/server-move/imported-daemon-sessions.test.ts:181` reads the source text. It requires that `disconnectImportedDaemonSessions(` appears after `createApp(` and before `startHttpListener({`, and that the text `sessions: serverImport.importedDaemonSessions` follows it.
- `apps/server/test/server-move/pending-boot.test.ts:652` requires that `await refuseInterruptedServerImport({` appears before `initDb(`. This is unaffected.
- `apps/server/test/server-move/connect-hold.test.ts` imports the exported `startServerPlugins`. That export stays unchanged.
- `git grep -n bindFrameworkResume` finds only the source and the call site. No test covers the resume or suspend wiring.

The exports `runServer`, `startServerPlugins` and `getRuntimeBuildIdentity`, and the bundled `dist/start-server.js` entry (`apps/server/package.json` "build"; `packages/omnyo-app/scripts/build.mjs:220`), do not change.

Counterevidence and current requirements that explain the code:

- Background work must not run while a server move is pending or a maintenance hold is held, and it must restart when maintenance is released.
- Boot deliberately installs the prewarms before the listener. For example, `installVoiceInputPrewarm` runs `prepareNewPrimarySession()` immediately and subscribes to `hub.onChangedMessage` (`apps/server/src/services/ai/voice-prepare.ts:100-124`). Boot also deliberately starts sweeps only after `pluginService.bindSdk`.
- On resume, recovery runs fire-and-forget. Update checks start directly on resume, but on boot they start only after the plugins have started.
- `pendingInteractions.start()` runs at boot under a different guard (398–399: `!bootMaintenanceHeld && !isServerMoveFrozen(db)`), and suspend never stops it.

Those asymmetries are why a single `startBackgroundWork()` call is wrong for boot.

Two corrections to the sweep's claims:

1. **Hypothesis, disproven for the analyzed paths:** the reference from `appUpdate`'s `stopRunningThreads` and `setDraining` callbacks (498, 503) to `sweepDeps` before its declaration (625) is not reachable today. Those callbacks run only after `applyPrivate` sets `pending` (`apps/server/src/services/system/app-update.ts:918`). That happens only through a user request, and the listener is not running before line 676. Launcher `onStatus` and `onDisconnect` (524–548) never reach `setDraining` when `pending === null`.
2. **Reproduced:** spreading `appDeps`, which contains `appUpdate`, into `sweepDeps` does not create a TypeScript inference cycle in this pattern. A scratch reproduction outside the repository used the same shape: a non-generic factory with a declared return type, an expression-bodied callback that references a later `const`, and that `const` spreading an object that holds the factory result. Compiled with the TypeScript 6.0.2 installed in `node_modules` in strict mode, it reported no diagnostics. The real acceptance check is still `typecheck` on the real file.

Maintenance cost today: adding a background service needs four coordinated edits (boot install, resume install, suspend stop, shutdown stop). Adding a shared dependency needs up to three extra literal edits. Nothing fails if one edit is missed, because the resume and suspend paths have no test coverage.

**Proposed end state and preservation argument**

What disappears:

- The 14- and 15-field literals for `disconnectImportedDaemonSessions` and `startDaemonLivenessChecks`.
- The 16-field `sweepDeps` literal, which becomes `{ ...appDeps, pluginSchedules: pluginService, plugins: pluginService }`.
- The second `setInterval` body.
- The three separately managed prewarm handles.
- The duplicated stop sequences in suspend and shutdown.

What remains, owned inside `runServer` (local closures, not a new module):

```ts
// immediately after createApp(...) destructuring
const sweepDeps = {
  ...appDeps,
  pluginSchedules: pluginService,
  plugins: pluginService,
};

let hostServices: { stop(): void }[] | null = null; // prewarms and remote sync
let sweepInterval: ReturnType<typeof setInterval> | null = null;

// Prewarms and remote sync; must run before the listener on boot.
const startHostServices = (): void => {
  hostServices ??= [
    installProviderModelCatalogPrewarm(sweepDeps),
    installVoiceInputPrewarm(sweepDeps),
    installProjectRemoteSync(sweepDeps),
  ];
};

// Catalog refresh and the 10 s sweep; must run after bindSdk on boot.
const startPeriodicWork = (): void => {
  pluginCatalogService.startPeriodicRefresh();
  if (sweepInterval !== null) return;
  sweepInterval = setInterval(() => {
    telemetry.prune();
    if (!isServerMoveFrozen(db)) void runPeriodicSweeps(sweepDeps);
  }, 10_000);
  sweepInterval.unref();
};

const stopBackgroundWork = async (): Promise<void> => {
  for (const service of hostServices ?? []) service.stop();
  hostServices = null;
  pluginCatalogService.stopPeriodicRefresh();
  await pluginService.stopPeriodicUpdateChecks();
  if (sweepInterval !== null) clearInterval(sweepInterval);
  sweepInterval = null;
};
```

The call sites become the following:

- **Boot, part 1** (the old 644–657): `if (pendingServerMove === null && !bootMaintenanceHeld) startHostServices();`. It stays in the same position, before the awaited recovery sweep and the listener.
- **Boot, part 2** (the old 715–723): `startPeriodicWork();` stays inside the existing guard, after the completed-move or `startServerPlugins` branch. That branch is unchanged, so the completed-move boot still starts no update checks.
- **Resume:** `pendingInteractions.start(); startHostServices(); void runStartupRecoverySweep(...)` with the same `.catch` and log message, then `pluginService.startPeriodicUpdateChecks(); startPeriodicWork();`. The order matches the old order exactly.
- **Suspend:** `stopBackgroundWork` is passed as the third argument of `bindFrameworkResume`.
- **Shutdown:** `await stopBackgroundWork();` replaces lines 785–787 at the position of the old prewarm stop, and lines 792–797 are removed.
- `disconnectImportedDaemonSessions(appDeps, { sessions: serverImport.importedDaemonSessions });` and `startDaemonLivenessChecks(appDeps)`.

How the current semantics survive:

- **Guards:** boot uses the same `pendingServerMove === null && !bootMaintenanceHeld` guard. Resume has no guard, as today.
- **No double start:** `??=` on `hostServices` matches today's per-handle `??=`, because the three handles are always set and cleared together. The `sweepInterval !== null` early return matches today's `sweepInterval === null` guard on resume, and on boot the interval is always null at that point.
- **Recovery sweep:** the boot recovery stays awaited at its current position and is untouched. The resume recovery stays fire-and-forget.
- **Suspend order:** handles stop, catalog stops, update checks stop (awaited), then the interval clears. This is identical to today's order, and it still finishes before `maintenance.acquire` suspends plugins.
- **Intentional shutdown reorder:** today, shutdown clears the interval and stops the catalog and update checks after `eventLoopStallMonitor.stop()`, `performanceDiagnostics.stop()` and `stopDaemonLivenessChecks()`. After the change they run before those three steps. None of the three uses the sweep interval, the catalog refresh or the update checks, so this only stops background work earlier. If a reviewer prefers zero reordering, put `await stopBackgroundWork()` at the old interval position (792) instead. The prewarms would then stop after the stall monitor and diagnostics, which is equally harmless.
- **Shutdown with a pending move:** shutdown still calls `stopPeriodicUpdateChecks()` even though checks never started, as today.
- **Dependencies:** the objects passed are the same service instances. The extra fields are ignored by every consumer, as the searches above show.
- **Formatting:** the source-text test anchors stay literally present: `disconnectImportedDaemonSessions(` after `createApp(` and before `startHttpListener({`, followed by `sessions: serverImport.importedDaemonSessions`.

Non-goals:

- Do not move `pendingInteractions.start()` into the helpers. It has its own boot guard and is never stopped on suspend.
- Do not change `startServerPlugins` or the completed-move branch.
- Do not change the boot recovery sweep.
- Do not change `server-maintenance.ts`.
- Do not extract a new module.
- Do not fix ISS-S08-002 beyond the earlier `sweepDeps` declaration this card already makes.
- Optional, separate and not counted: the 14-field `PendingInteractionLifecycle` literal (382–396) cannot use `appDeps`, because `appDeps` contains `pendingInteractions`. A shared `workSessionDeps` base object could serve both, but that is outside this card.

Why this is the simplest sufficient option: it uses two start closures because boot really has two phases, and one stop closure because every stop site stops everything. It adds no new types, module or abstraction beyond three local closures.

**Expected gain and cost**

- **Dependency literals (Proven by inspection, exact counts):** lines 564–582 (19), 607–623 (17) and 625–642 (18) total 54 lines. They become about 9 lines (a 3-line `disconnectImportedDaemonSessions` call, a 1-line liveness call and a 5-line `sweepDeps`). That saves about 45 lines.
- **Lifecycle (projection):** the cited spans 644–657, 695, 715–723, 737–740, 744–754, 757–769, 785–787 and 792–797 total 61 lines. They become about 35 to 40 lines: about 28 lines of helpers after formatting with oxfmt's blank-line style, plus single-line call sites. That saves about 20 to 25 lines.
- **Net projection:** about 55 to 70 handwritten production lines removed from `apps/server/src/start-server.ts`. There are no test, generated-code or documentation changes.
- **Mechanisms (before and after):** four start and stop sites become two start functions and one stop function. Two interval bodies become one. Three handwritten dependency literals become one spread extension.
- **Maintenance effect:** a new background service becomes one edit in `startHostServices` or `startPeriodicWork`, and the shared stop function covers it automatically. A new shared dependency added to `appDeps` reaches all four consumers with no further edit.
- **Cost:** three small closures that a reader must follow, and one intentional shutdown reorder.
- **Performance:** neutral by inspection. The change adds one extra object spread at boot. The sweep path passes the same instances, plus eight extra properties that per-call `{ ...deps }` copies carry along. No measurement was taken, and none is needed for a boot-time object.

**Execution steps**

1. **Reconfirm the baseline.** In a fresh worktree of the current `main`, open `apps/server/src/start-server.ts` "runServer". Confirm that the spans in the Context table still exist with the same semantics: the guard expression, the `??=` resume installs, the `sweepInterval === null` guard, the suspend order and the shutdown steps.
   - Run `git log --oneline e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e..HEAD -- apps/server/src/start-server.ts apps/server/src/services/maintenance/server-maintenance.ts`.
   - Re-plan if any of the following holds:
     - A new background service was added to only some of the four sites. Decide its intended behavior first.
     - `bindFrameworkResume` changed its call order or signature.
     - A consumer type gained an optional field that `appDeps` supplies.
     - The resume callback started awaiting recovery.
2. **Record the before sequence.** Write a short scratch table (not committed) listing the exact order of background starts at boot, at resume, at suspend and at shutdown. You will compare against it in step 6.
3. **Checkpoint A: dependency bags (mechanical).**
   - Move `sweepDeps` to immediately after the `createApp(...)` destructuring (after line 562) as `{ ...appDeps, pluginSchedules: pluginService, plugins: pluginService }`. Delete the old literal at 625–642.
   - Replace the first argument of `disconnectImportedDaemonSessions` with `appDeps`, keeping `{ sessions: serverImport.importedDaemonSessions }` literally.
   - Replace the argument of `startDaemonLivenessChecks` with `appDeps`.
   - Run typecheck and the four focused test files (see the next section).
4. **Checkpoint B: lifecycle owner (semantic restructuring).**
   - Add `hostServices`, `sweepInterval`, `startHostServices`, `startPeriodicWork` and `stopBackgroundWork`, as in the end-state sketch, right after `sweepDeps`.
   - Delete the `let sweepInterval` at line 695.
   - Replace lines 644–657 with the guarded `startHostServices()` call.
   - Replace lines 715–723 with `startPeriodicWork();`.
   - Rewrite the resume callback in the order `pendingInteractions.start()`, `startHostServices()`, fire-and-forget recovery (keep the message "Released maintenance recovery failed"), `pluginService.startPeriodicUpdateChecks()`, then `startPeriodicWork()`.
   - Pass `stopBackgroundWork` as the suspend callback.
   - In `runShutdown`, replace lines 785–787 with `await stopBackgroundWork();` and delete lines 792–797.
5. **Format and lint the file** (see the next section). Remove any comment or variable that only described the old per-handle `let`s.
6. **Review and recount.**
   - Compare the new start and stop sequences against the step-2 table. The only allowed difference is the documented shutdown reorder.
   - Confirm with `rg -n "installProviderModelCatalogPrewarm|installVoiceInputPrewarm|installProjectRemoteSync|setInterval|stopPeriodicUpdateChecks|startPeriodicRefresh|stopPeriodicRefresh" apps/server/src/start-server.ts`:
     - each `install*` appears once, outside the imports;
     - `setInterval` appears once;
     - `stopPeriodicUpdateChecks` appears once;
     - `startPeriodicRefresh` and `stopPeriodicRefresh` appear once each.
   - Recount with `git diff --stat -- apps/server/src/start-server.ts` and confirm a net reduction in the 55–70 line range.

**Verification and acceptance criteria**

All commands run from the repository root with dependencies installed. The script names come from `apps/server/package.json` ("typecheck": `tsc --noEmit`; "test": `vitest run --config vitest.config.ts`) and the root `package.json` ("format", "format:check"). The exact pass-through of file arguments through `pnpm --filter ... test --` was not executed in this audit, because the snapshot has no `node_modules`.

- `pnpm --filter @omnyo/server typecheck` should report no errors. This also confirms on the real file that the `sweepDeps` spread creates no inference cycle.
- `pnpm --filter @omnyo/server test -- test/server-move/imported-daemon-sessions.test.ts test/server-move/pending-boot.test.ts test/server-move/connect-hold.test.ts test/app/startup-diagnostics.test.ts` should pass. These files cover the source-order anchors, the `startServerPlugins` export and the build entry.
- `pnpm --filter @omnyo/server test -- test/system/server-maintenance.test.ts test/services/periodic-sweeps.test.ts test/providers/provider-model-catalog-prewarm.test.ts test/services/projects/project-remote-sync.test.ts` should pass, unchanged. These tests do not exercise `runServer`, but they guard the consumed contracts.
- `pnpm exec oxfmt apps/server/src/start-server.ts`, then `pnpm exec oxlint --deny-warnings --format=agent apps/server/src/start-server.ts`, should report no warnings.
- Optional: `pnpm --filter @omnyo/server build` should succeed and produce `dist/start-server.js`.
- **Lifecycle acceptance.** No automated test covers resume and suspend, so acceptance is the step-6 sequence comparison. It must show:
  - (a) Boot installs the prewarms before `runStartupRecoverySweep` and before `startHttpListener`, and starts the interval and catalog refresh after `pluginService.bindSdk`.
  - (b) The completed-move boot starts no update checks.
  - (c) Resume order is unchanged, and resume never awaits recovery.
  - (d) Suspend finishes all stops before returning.
  - (e) A repeated resume cannot create a second interval.
- **Optional characterization.** Add one only if a reviewer wants automated proof. A worthwhile one would drive `maintenance.acquire` and then `maintenance.release` against a running test server through `apps/server/src/routes/server-maintenance.ts` (acquire at line 126, release at line 132) and assert that `runPeriodicSweeps` stops and restarts. This needs a desktop-update hold fixture; that fixture has not been confirmed to exist.
- **Structural completion:** one interval body, one stop function, no handwritten subset literal of `appDeps` among the four bags, and the `rg` check from step 6 passes.

**Rollback and stop conditions**

- **Rollback boundary.** The whole change is confined to `apps/server/src/start-server.ts` and has no data or compatibility implications. Revert that one commit, or keep checkpoint A alone if checkpoint B is in doubt.
- **Stop if any of the following happens:**
  - Typecheck reports a circularity or excess-property error that would need a type assertion to silence. In that case keep the `sweepDeps` literal and land only the lifecycle part.
  - A consumer turns out to branch on an optional field that `appDeps` supplies. In that case keep that call's literal.
  - Step 1 finds a background service that intentionally runs on only some paths. Encode that service outside the helpers, or re-plan.
  - A reviewer finds that a shutdown step depends on the interval or the update checks still running. Use the zero-reorder placement at the old line 792.
- **Safer alternatives.** The smallest fallback is checkpoint A alone, which saves about 45 lines with no lifecycle change. Another option is to deduplicate only the interval body behind `startPeriodicWork`.
