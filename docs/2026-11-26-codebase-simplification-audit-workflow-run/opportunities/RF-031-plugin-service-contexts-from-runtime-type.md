# RF-031 — Derive the plugin service factory context types from the factories' return types and forward with spreads

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplication is real, but the sweep's projection of 120-220 removed lines does not hold. Most of the hand-written context members are one-line signatures, and a `Pick<>` union also takes one line per name under the repository formatter. The line saving therefore comes almost entirely from call-site forwarding and from the service-side destructure, not from the interfaces. The projected net reduction is about 30-50 handwritten production lines.
- **Potential:** low. **Confidence:** medium (the duplication and the consumers are proven by inspection; the line projection depends on formatter output that was not run).
- **Readiness:** ready. **Effort:** about 2-4 hours, which is smaller than the sweep's 0.5-1.5 days. **Risk:** low. Only types and wiring change, and no runtime logic changes. The main risk is a TypeScript inference cycle if a later step derives a type in both directions between registration and managed artifacts; step 3 avoids that.
- **Prerequisites:** none.
- **Related or overlapping:** RF-033 (one serial job-queue core for plugin install and update jobs) touches `plugin-install-jobs.ts` and `plugin-update-jobs.ts`, not these factories, so it does not conflict. RF-105 (memoize stored marketplace manifest parsing) touches `marketplaceManifestCache` in `plugin-service.ts` near the same wiring block; if both land, rebase rather than merge by hand. No other RF item edits these five factories.
- **Why it deserves its place:** 35 dependency signatures are hand-copied across four context interfaces, and adding one existing runtime function to a factory takes 4-5 coordinated edits. This change removes that duplicated knowledge for a small, mechanical, type-checked diff. It ranks low because the compiler already catches drift between the copies, so the current cost is extra edits, not silent bugs.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The read-only snapshot worktree had been removed by the time this card was written, so every file was read with `git show e9e1b74c3:<path>` from `$OMNYO_CHECKOUT`. The snapshot has no `node_modules`, so no typecheck or test was run (no result here is Reproduced).

The server's plugin service is one large closure, `createPluginService` in `apps/server/src/services/plugins/plugin-service.ts:622`. Its implementation is split across five factories, which `createPluginService` builds in this order and wires together:

| Factory | File and line | Context type | Returns |
|---|---|---|---|
| `createPluginRuntime` | `apps/server/src/services/plugins/plugin-runtime.ts:453` | `PluginRuntimeContext`, lines 429-436 (6 inputs, no borrowed functions) | a 51-name object literal, lines 2961-3013 |
| `createPluginRegistration` | `apps/server/src/services/plugins/plugin-registration.ts:118` | `PluginRegistrationContext`, lines 95-116 | 16 names, lines 1242-1259 |
| `createPluginActivation` | `apps/server/src/services/plugins/plugin-activation.ts:77` | `PluginActivationContext`, lines 40-75 | 3 names, lines 404-408 |
| `createManagedPluginArtifacts` | `apps/server/src/services/plugins/managed-plugin-artifacts.ts:207` | `ManagedPluginArtifactsContext`, lines 105-125 | 6 names, lines 1621-1628 |
| `createPluginUpdates` | `apps/server/src/services/plugins/plugin-updates.ts:118` | `PluginUpdatesContext`, lines 93-116 | the `PluginUpdates` interface |

Observed facts (Proven by inspection):

1. **The context interfaces copy sibling signatures by hand.** A Python classifier over each interface body (member names matched against each factory's return list) found these copied members:

   | Interface | Copied from runtime | Copied from registration | Copied from activation | Factory-specific |
   |---|---|---|---|---|
   | `PluginRegistrationContext` (22 lines) | 8 names, 13 lines: `withLifecycleLock`, `disposeOne`, `disposeForReplacement`, `loadOne`, `statuses`, `checkEngineRange`, `checkPluginSdkRange`, `safeModeActivationRefusal` | none | none | `deps`, `bundledPlugins`, `validateInstallDir` (from managed artifacts), `syncCliSkill`, `notifyPluginsChanged`, `list`, `runInstallHandlers` |
   | `PluginActivationContext` (36 lines) | 8 names, 11 lines: `stabilizingPluginIds`, `statuses`, `statusListeners`, `withArtifactLock`, `withLifecycleLock`, `disposeOne`, `disposeForReplacement`, `loadOne` | 5 names, 13 lines: `restoreRegistration`, `provenanceForRow`, `registrationMatchesForActivation`, `emptyPluginUpdateState`, `sourceFingerprint` | none | `deps`, `now`, `artifactRetentionMs`, `stabilizationWindowMs`, `scheduleStabilizationWindow`, `syncCliSkill`, `notifyPluginsChanged` |
   | `ManagedPluginArtifactsContext` (21 lines) | 5 names, 10 lines: `withArtifactLock`, `sourceKind`, `checkEngineRange`, `checkPluginSdkRange`, `isPackagedBuiltinEntry` | 3 names, 7 lines: `registerInstalled`, `assertInstallRegistrationAvailable`, `refuseBuiltinShadow` | `activateManagedUpdate` (1 line) | `deps` |
   | `PluginUpdatesContext` (24 lines) | 3 names, 5 lines: `withLifecycleLock`, `withPluginOperationLock`, `safeModeActivationRefusal` | 2 names, 4 lines: `installedUpdateVersion`, `npmIntentForRow` | already derived with `ReturnType<typeof createPluginActivation>[...]` | `deps`, `bundledPlugins`, `checkCompatibility`, `registrationMutationKey`, `notifyPluginsChanged`, `managedArtifacts` (already a `Pick<ReturnType<...>>`) |

   In total, 35 copied members take 64 lines. `plugin-updates.ts:97-112` already derives three members with `ReturnType<typeof ...>`, so the derived style has a precedent in this code.

2. **Several copies are deliberately narrower than the source.** The runtime's `disposeOne(id, strict = false)` (`plugin-runtime.ts:2865`) is copied as `(id: string) => Promise<void>`. `loadOne(row, allowPersistedGeneration = false)` (`plugin-runtime.ts:2188`) is copied as a one-argument function. The runtime's `statuses` is a mutable `Map` (`plugin-runtime.ts:482`), but `PluginRegistrationContext` declares it as `ReadonlyMap`. A search of `plugin-registration.ts` and `plugin-activation.ts` for `statuses.set`, `statuses.delete` and two-argument `disposeOne(`/`loadOne(` calls found none, so these narrowings only restrict callers and do not change behavior.

3. **Wiring forwards each name by hand.** `plugin-service.ts:733-799` destructures 51 runtime names from `createPluginRuntime`. Then `plugin-service.ts:815-848` destructures 16 registration names, `850-875` destructures 3 activation names, `877-888` builds managed artifacts and `893-908` builds updates. Each call lists its arguments one name per line. Of the 35 copied members, 32 are forwarded as bare names (`registrationMutationKey: REGISTRATION_MUTATION_KEY` is renamed, and `checkCompatibility` composes two runtime functions in a lambda).
4. **Sixteen destructured names exist only to be forwarded.** A script that searched `plugin-service.ts` for each destructured name outside lines 732-908 found no use for `checkEngineRange`, `checkPluginSdkRange`, `isPackagedBuiltinEntry`, `safeModeActivationRefusal`, `stabilizingPluginIds`, `statusListeners`, `assertInstallRegistrationAvailable`, `emptyPluginUpdateState`, `installedUpdateVersion`, `npmIntentForRow`, `provenanceForRow`, `registerInstalled`, `registrationMatchesForActivation`, `restoreRegistration`, `sourceFingerprint` or `activateManagedUpdate`.
5. **Consumers.** `git grep -n -E "createPluginActivation|createPluginRegistration|createManagedPluginArtifacts|createPluginUpdates|createPluginRuntime|PluginRegistrationContext|PluginActivationContext|ManagedPluginArtifactsContext|PluginUpdatesContext|PluginRuntimeContext" e9e1b74c3 -- .` found only the five factory files, `plugin-service.ts` and `apps/server/test/services/plugins/plugin-dev-build-problems.test.ts:9,20`. That test calls only `createPluginRuntime`, and this card does not change the runtime's context. None of the context interfaces are exported, and none of them reach `@omnyo/plugin-sdk`, `@omnyo/sdk` or `@omnyo/server-contract`. No plugin, CLI command, persisted format or migration addresses them.
6. **Import graph.** `plugin-runtime.ts` imports none of the other four factories. `plugin-registration.ts:56-59` imports the types `InstallRegistrationIdentity` and `RegisterInstalledArgs` from `managed-plugin-artifacts.ts`. `plugin-updates.ts:42-45` imports activation and managed artifacts as types. `.oxlintrc.json` has no import-cycle rule.
7. **The `managedValidateInstallDir` definite assignment is a real construction-order cycle.** `plugin-service.ts:811` declares `let managedValidateInstallDir!` and assigns it at line 890. Registration needs managed artifacts' `validateInstallDir`, and managed artifacts needs registration's `registerInstalled`. The call site already wraps the variable in a lazy arrow at line 842. The sweep's suggestion to "pass a lazy accessor instead" describes what the code already does, so it is rejected and this card keeps the variable.

Counterevidence and maintenance cost. The hand-written interfaces document each factory's exact dependencies, and the compiler checks every copy against its source when the object is passed. A signature change therefore fails to compile instead of drifting silently. The real cost is edit count. For example, to give activation access to the runtime's existing `withPluginOperationLock`, a developer must add it to the `PluginActivationContext` interface with a hand-typed generic signature, to the activation destructure, to the `createPluginActivation` call, and to the runtime destructure in `plugin-service.ts` if it were not already there. That is 3-4 edits, and one of them retypes a generic signature.

**Proposed end state and preservation argument**

What remains:
- The five factories, their files, their construction order in `createPluginService` and the `managedValidateInstallDir` late binding.
- Each factory's own `const { ... } = context` destructure.
- Every factory-specific context field (timers, `deps`, `bundledPlugins`, service-level callbacks such as `syncCliSkill`, `list` and `runInstallHandlers`).
- `validateInstallDir` stays hand-typed in `PluginRegistrationContext`. Deriving it from `ReturnType<typeof createManagedPluginArtifacts>` while managed artifacts derives from `ReturnType<typeof createPluginRegistration>` would make each inferred return type depend on the other, which risks TypeScript errors TS7022/TS7023.
- The deliberately narrower types for `statuses` in registration (`ReadonlyMap`), and for `disposeOne` and `loadOne` in every context, stay as explicit members outside the `Pick<>`. This keeps the current capability narrowing. Spreading passes the wider runtime values, which are assignable to the narrower declarations.

What changes:
1. Each factory exports its return type once: `export type PluginRuntime = ReturnType<typeof createPluginRuntime>;` in `plugin-runtime.ts`, and the same for `PluginRegistration` in `plugin-registration.ts` and `PluginActivation` in `plugin-activation.ts`.
2. Each context interface takes its copied members by name: `interface PluginActivationContext extends Pick<PluginRuntime, "stabilizingPluginIds" | "statuses" | ...>, Pick<PluginRegistration, "restoreRegistration" | ...> { ...factory-specific fields }`. Type dependencies then flow one way: runtime, then registration, then activation, then managed artifacts, then updates.
3. `createPluginService` keeps named objects: `const runtime = createPluginRuntime(...)`, `const registration = createPluginRegistration(...)` and `const activation = createPluginActivation(...)`. Each object is destructured only into the names the service uses outside the wiring block. Each factory call passes `...runtime`, `...registration` or `...activation` first and then lists only its factory-specific fields.

Why behavior is preserved: destructuring and spreading both copy the same property references once, at construction time. Every runtime value is a function, a `Map`, a `Set`, an array or a constant, and no `let` binding is returned, so a snapshot copy is equivalent to the current destructure. No key in any factory-specific field collides with a key in the spread objects (checked by the classifier above). Explicit fields are listed after the spreads, so an explicit field would win even if a collision appeared later. TypeScript does not apply excess-property checks to spread members, so the extra properties are allowed and unused. The spread happens once per server start (four object copies of at most 51 keys), which is negligible next to plugin loading.

Non-goals: merging the factories, changing the factory order, changing any function body, removing the `managedValidateInstallDir` cycle, and changing `PluginRuntimeContext` or the test in `plugin-dev-build-problems.test.ts`.

**Expected gain and cost**

Measured at the snapshot (Proven by inspection): 103 context-interface lines, of which 64 copy 35 sibling signatures; 63 factory destructure lines; about 176 lines of wiring in `plugin-service.ts:733-908`.

Projected, not measured (assumes oxfmt with `printWidth: 80` breaks a long `Pick<>` union into one name per line):

| Part | Before | After | Net |
|---|---|---|---|
| Copied interface members | 64 lines | about 35 name lines plus about 25 lines of `Pick<` scaffolding and kept narrow members | about -5 |
| Bare-name forwarding at the four call sites | about 32 lines | 1 spread line per source | about -25 |
| Wiring-only names in the service destructures | 16 lines | 0 | -16 |
| New `const runtime/registration/activation =` lines and 3 type exports | 0 | about 6 | +6 |
| **Total** | | | **about -30 to -50 handwritten production lines** |

There are no test, generated, documentation or asset line changes.

Maintenance gain: each borrowed signature has one source. Giving a factory another existing sibling function takes two edits (one name in a `Pick<>` union and one name in the factory destructure) instead of 3-5, and the generic lock signatures are never retyped. Cost: a reader sees `Pick<PluginRuntime, ...>` instead of a literal signature, and needs editor hover to see the type. The spreads also make it less visible at the call site which names a factory receives; the `Pick<>` list in the factory file becomes the only place that says so.

Performance: Hypothesis, neutral. Four object spreads run once at service construction.

**Execution steps**

1. **Reconfirm the baseline.** In a fresh worktree on current `main`, confirm that the anchors above still match, with `rg -n "interface Plugin(Registration|Activation|Updates)Context|interface ManagedPluginArtifactsContext|managedValidateInstallDir" apps/server/src/services/plugins`. Rerun the consumer search from fact 5. Record a baseline line count with `wc -l` for the six files. Re-plan if any of these holds: a context interface has become exported or is used outside `apps/server/src/services/plugins`, a factory now returns a reassignable binding (a `get` accessor or a returned `let`), or a factory-specific field name now collides with a key of the object to be spread.
2. **Baseline checks.** From the repository root, run `pnpm --filter @omnyo/server typecheck` and the targeted tests listed under Verification. Both must pass before any edit. No new tests are needed, because the change is type-level and wiring-only, and the existing install, update, rollback and relocation tests exercise every forwarded function.
3. **Checkpoint A: export the return types (type-only).**
   - `apps/server/src/services/plugins/plugin-runtime.ts`: after `createPluginRuntime`, add `export type PluginRuntime = ReturnType<typeof createPluginRuntime>;`.
   - `apps/server/src/services/plugins/plugin-registration.ts`: add `export type PluginRegistration = ReturnType<typeof createPluginRegistration>;`.
   - `apps/server/src/services/plugins/plugin-activation.ts`: add `export type PluginActivation = ReturnType<typeof createPluginActivation>;`.
   - Run the typecheck.
4. **Checkpoint B: derive the context interfaces.** Use `interface X extends Pick<...>, Pick<...> { ... }` so each file keeps a named interface. Import the source types with `import type`.
   - `PluginRegistrationContext` (`plugin-registration.ts:95`): extend `Pick<PluginRuntime, "withLifecycleLock" | "disposeForReplacement" | "checkEngineRange" | "checkPluginSdkRange" | "safeModeActivationRefusal">`. Keep `statuses` (`ReadonlyMap`), `disposeOne` (one argument), `loadOne` (one argument) and `validateInstallDir` as explicit members. Delete the other copied members.
   - `PluginActivationContext` (`plugin-activation.ts:40`): extend `Pick<PluginRuntime, "stabilizingPluginIds" | "statuses" | "statusListeners" | "withArtifactLock" | "withLifecycleLock" | "disposeForReplacement">` and `Pick<PluginRegistration, "restoreRegistration" | "provenanceForRow" | "registrationMatchesForActivation" | "emptyPluginUpdateState" | "sourceFingerprint">`. Keep `disposeOne` and `loadOne` explicit. Activation's `statuses` is already declared as a mutable `Map`, so picking it changes nothing.
   - `ManagedPluginArtifactsContext` (`managed-plugin-artifacts.ts:105`): extend `Pick<PluginRuntime, "withArtifactLock" | "sourceKind" | "checkEngineRange" | "checkPluginSdkRange" | "isPackagedBuiltinEntry">` and `Pick<PluginRegistration, "registerInstalled" | "assertInstallRegistrationAvailable" | "refuseBuiltinShadow">`. Use `Pick<PluginActivation, "activateManagedUpdate">` and import it with `import type`. Keep the non-exported `ActivateManagedUpdateArgs` interface only if something else in the file still uses it.
   - `PluginUpdatesContext` (`plugin-updates.ts:93`): extend `Pick<PluginRuntime, "withLifecycleLock" | "withPluginOperationLock" | "safeModeActivationRefusal" | "REGISTRATION_MUTATION_KEY">`, `Pick<PluginRegistration, "installedUpdateVersion" | "npmIntentForRow">` and `Pick<PluginActivation, "activateManagedUpdate" | "runArtifactGc">`. Delete the `registrationMutationKey` member, and change the destructure at `plugin-updates.ts:123` from `registrationMutationKey: REGISTRATION_MUTATION_KEY` to `REGISTRATION_MUTATION_KEY`. Keep `checkCompatibility`, `bundledPlugins` and `managedArtifacts`.
   - Run the typecheck. Stop here if TS7022, TS7023 or "implicitly has type any" appears. Such an error means a two-way derivation slipped in; see Rollback and stop conditions.
5. **Checkpoint C: forward with spreads in `createPluginService`** (`plugin-service.ts:733-908`).
   - Replace `const { ...51 names } = createPluginRuntime({...})` with `const runtime = createPluginRuntime({...});`, followed by `const { ... } = runtime;` that lists only the names used outside the wiring block. Drop `checkEngineRange`, `checkPluginSdkRange`, `isPackagedBuiltinEntry`, `safeModeActivationRefusal`, `stabilizingPluginIds` and `statusListeners`. Keep the `bindSdk: bindRuntimeSdk` rename.
   - Do the same for registration (`const registration = createPluginRegistration({...})`). Drop `assertInstallRegistrationAvailable`, `emptyPluginUpdateState`, `installedUpdateVersion`, `npmIntentForRow`, `provenanceForRow`, `registerInstalled`, `registrationMatchesForActivation`, `restoreRegistration` and `sourceFingerprint` from its destructure.
   - Do the same for activation (`const activation = createPluginActivation({...})`), keeping `recoverIncompletePluginRollbacks` and `runArtifactGc` and dropping `activateManagedUpdate`.
   - Rewrite the calls:
     ```ts
     createPluginRegistration({
       ...runtime,
       deps, bundledPlugins, runInstallHandlers, syncCliSkill,
       notifyPluginsChanged, list,
       validateInstallDir: (args) => managedValidateInstallDir(args),
     });
     createPluginActivation({
       ...runtime, ...registration,
       deps, now, artifactRetentionMs, stabilizationWindowMs,
       scheduleStabilizationWindow, syncCliSkill, notifyPluginsChanged,
     });
     createManagedPluginArtifacts({ ...runtime, ...registration, ...activation, deps });
     createPluginUpdates({
       ...runtime, ...registration, ...activation,
       deps, bundledPlugins,
       checkCompatibility: (manifest) =>
         runtime.checkEngineRange(manifest) ?? runtime.checkPluginSdkRange(manifest),
       notifyPluginsChanged,
       managedArtifacts: managedPluginArtifacts,
     });
     ```
     The formatter decides the final layout. Put spreads first and explicit fields after them.
   - Run the typecheck and the targeted tests.
6. **Clean up and recount.** Remove any type imports that the deleted members leave unused (for example `PluginRuntimeStatus`, `PluginProvenance`, `NpmSourceIntentForResolution`, `PluginResolvedUpdateVersion` or `SafeModeActivationRefusalArgs`, wherever a file no longer references them). Format and lint the six files. Then rerun `wc -l` and compare it with the step 1 baseline. If the net handwritten reduction is under 20 lines, keep the change only if reviewers agree that the two-edit dependency rule is worth it; otherwise drop it (see Rollback and stop conditions). Inspect `git diff` to confirm that no function body changed.

**Verification and acceptance criteria**

Commands. Each comes from a script at the snapshot unless it is labelled otherwise; none could be run here because the snapshot has no `node_modules`.
- From the repository root: `pnpm --filter @omnyo/server typecheck` (runs `tsc --noEmit` from `apps/server/package.json`). It must pass with no new errors.
- From the repository root: `pnpm --filter @omnyo/server test -- test/services/plugins/plugin-install.test.ts test/services/plugins/plugin-update.test.ts test/services/plugins/builtin-plugin-update.test.ts test/services/plugins/plugin-instance-lifecycle.test.ts test/services/plugins/plugin-relocate.test.ts test/services/plugins/plugin-install-hook.test.ts test/services/plugins/plugin-install-jobs.test.ts test/services/plugins/plugin-update-jobs.test.ts test/services/plugins/plugin-dev-build-problems.test.ts`. The `test` script is `vitest run --config vitest.config.ts`; passing file filters after `--` is standard vitest usage but was not run here. These files cover install, update, rollback, relocation and lifecycle, which together reach every forwarded function. They must pass unchanged, with no assertion edits.
- From the repository root: `pnpm exec oxfmt <changed files>`, then `pnpm exec oxlint --deny-warnings --format=agent <changed files>`. The global agent instructions prescribe these; `apps/server` has no `lint` script of its own. Root `pnpm run format:check` is the repository-wide check.

Acceptance criteria:
- **Behavior:** `git diff` shows changes only in type declarations, imports, destructure lists and the arguments of the five factory calls. No function body changes. Install, update, rollback, relocation and lifecycle tests pass unchanged.
- **Structure:** no context interface restates a signature that a sibling factory returns, except the documented narrow members (`statuses` in registration, `disposeOne`, `loadOne` and `validateInstallDir`). `plugin-service.ts` destructures no name that it only forwards. `PluginRuntimeContext` and `plugin-dev-build-problems.test.ts` are unchanged.
- **Gain:** the recount shows a net reduction near the projection, and the two-edit rule holds: adding an existing runtime function to a factory touches only that factory's `Pick<>` union and its destructure.
- No UI or performance check is needed. The change does not touch UI, and runtime work changes only by four object spreads at startup.

**Rollback and stop conditions**

Each checkpoint is one commit, and nothing persisted or public changes, so reverting the commit restores the previous state exactly.

Stop conditions:
- TS7022 or TS7023, or a context member that silently resolves to `any`. This means a two-way derivation exists (most likely through `validateInstallDir`, or an `activateManagedUpdate` path back into registration). Keep the offending member hand-typed instead of restructuring the factories.
- A factory returns a getter or a reassignable binding, so a spread snapshot would differ from a live read. Keep explicit forwarding for that name.
- A key of a spread object collides with a factory-specific field or with a key of another spread object. Rename it or forward that factory explicitly.
- Reviewers decide that the explicit signatures are wanted as documentation. Then apply only Checkpoint C (spreads and the trimmed service destructure), which carries most of the line saving and leaves the interfaces as they are.
- The measured net reduction is under 20 lines and reviewers see no edit-count benefit. Then drop the item; it is low potential.
