# RF-083 — Replace app-boot's hand-kept list of last-known caches with registration inside createLastKnownCache

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The coordination rule is real and one cache already escaped it, but the line gain is close to zero and the forget hook keeps two non-cache resets, so this is a small, low-potential cleanup rather than a material reduction.
- **Potential:** low. One hand-kept list disappears for one class of cache; no subsystem or layer disappears.
- **Confidence:** high. Every anchor below was re-read at the snapshot.
- **Readiness:** conditional. The registry starts clearing the plugin nav panel chrome cache on sign-out and on a server identity change, which today it does not. That is a small behaviour change and needs an explicit yes (recommended) or an explicit exemption before implementation.
- **Effort:** small, about 1 to 2 hours including tests.
- **Risk:** low. The main risk is a future cache module that is only reached through a dynamic `import()`, which would not be registered when the forget hook runs (see the preservation argument).
- **Prerequisites:** the decision in Execution step 1.
- **Related or overlapping:** none of RF-001 to RF-139 touches these files. RF-081 (hold-and-reapply for optimistic overlays) and RF-052 also live in the app cache layer but do not touch `last-known-cache.ts` or `app-boot.ts`.
- **Why it deserves its place:** adding a seventh last-known cache today needs a separate, easily forgotten edit in `app-boot.ts`, and the sixth cache was already forgotten. The change makes "a last-known cache is forgotten with the server" a property of the factory. It earns a place at the low end of the index; it should not be scheduled ahead of any item that deletes real machinery.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). Scope: the React web app in `apps/app`, which is also the UI that the Electron desktop app loads. Mobile does not use these modules.

Observed facts (Proven by inspection unless labelled):

- `apps/app/src/lib/last-known-cache.ts:11` "createLastKnownCache" builds a versioned, schema-checked localStorage cache with `key`, `read`, `write` and `clear`. `clear` (lines 128-145) removes every key under its own `prefix.version`. There is no registry: each instance is independent.
- Six production instances exist (`git grep -n createLastKnownCache e9e1b74c -- apps packages`, excluding tests):

  | Module | Instance and prefix | Clear export | Other users of the clear export |
  |---|---|---|---|
  | `apps/app/src/lib/sidebar-bootstrap-cache.ts:7` | `sidebarBootstrapCache`, `omnyo.sidebar-bootstrap` | `clearCachedSidebarBootstrap` (lines 120-124), also resets the in-memory `replay` and `pendingWrite` | none |
  | `apps/app/src/lib/provider-list-cache.ts:5` | `providerListCache`, `omnyo.provider-list` | `clearCachedProviderLists` (line 27) | none |
  | `apps/app/src/lib/environment-provider-list-cache.ts:5` | `environmentProviderListCache`, `omnyo.environment-provider-list` | `clearCachedEnvironmentProviderLists` (lines 29-30) | none |
  | `apps/app/src/lib/thread-execution-options-cache.ts:4` | `threadExecutionOptionsCache`, `omnyo.thread-execution-options` | `clearCachedThreadExecutionOptions` (lines 21-22) | none |
  | `apps/app/src/lib/model-catalog-cache.ts:10` | `modelCatalogCache`, `omnyo.model-catalog` | `clearCachedModelCatalogs` (line 34) | `apps/app/src/hooks/cache-owners/system-cache-effects.ts:237` "resetModelCatalogsAfterStreamerModeChange" |
  | `apps/app/src/lib/plugin-nav-panel-chrome.ts:28` | `chromeCache`, `omnyo.plugin-nav-panels` | none | not applicable |

  "None" was established with `git grep -n -E 'clearCached[A-Za-z]*' e9e1b74c -- .`; the only hits are the definitions, `app-boot.ts` and `system-cache-effects.ts`. No test imports a `clearCached*` export.
- `apps/app/src/lib/app-boot.ts:83-90` "clearLastKnownCaches" calls `resetPluginPageSession()` and then the five `clearCached*` functions, imported at lines 18-22. It does not clear the plugin nav panel chrome cache.
- `apps/app/src/lib/app-boot.ts:103-106` passes `clearLastKnownCaches` plus `queryClient.removeQueries({ queryKey: ["plugin-resource"] })` as the `clearLastKnownCaches` dependency of `startBootCache`. So the forget hook is "every piece of saved server data", not only last-known caches. Commit `a236a32e3` (2026-11-25) added the two plugin resets.
- `apps/app/src/hooks/cache-owners/boot-cache-owner.ts:321-339` "forget" calls `deps.clearLastKnownCaches()`. `settle` calls `forget` on a `signed-out` boot outcome (line 344) and when the confirmed `serverIdentity` differs from the stored snapshot's (lines 354-355). `apps/app/src/hooks/cache-owners/boot-cache-owner.test.tsx:473-540` covers both triggers with an injected `vi.fn()`, so those tests do not depend on what the hook clears.
- Load order: `apps/app/src/app-entry.tsx:5` imports `App` statically and line 14 imports `startAppBootCache`. A static-import walk from `apps/app/src/app-entry.tsx` over the snapshot (a `node -e` script reading files through `git show`, resolving `@/` and relative specifiers, skipping `import type`, and ignoring the `app-boot.ts` edges to the cache modules) reached all six cache modules among 447 modules. Under ES module semantics they are therefore evaluated, and would be registered, before `app-entry` runs `startAppBootCache`. Limit of that check: it is regex-based and counts a named import that contains only `type` specifiers as a value import.
- The plugin nav panel chrome cache is read in `apps/app/src/lib/plugin-nav-panel-chrome.ts:83-86` only while plugin frontends have not settled, and rewritten from live panels by `useRememberPluginNavPanelChrome` (lines 114-126, mounted at `apps/app/src/App.tsx:572`) once plugin frontend boot completes.

Maintenance cost today: a new last-known cache needs a second edit in `app-boot.ts` (an import and a call) plus a single-use `clearCached*` export, and nothing fails when the edit is missing. The nav panel chrome cache shows that this has already happened once.

Counterevidence and corrections to the sweep report:

- The sweep said sign-out clearing "cannot miss one" afterwards. That is true only for `createLastKnownCache` instances. The forget hook keeps `resetPluginPageSession()` and the `plugin-resource` query removal, so `app-boot.ts` still owns a short list.
- The sweep estimated a 10-20 line reduction. The recount below gives about 3 to 8 lines net. The benefit is the removed coordination rule, not lines.
- Impact of the missed nav panel chrome cache (Hypothesis, not reproduced): `forget` runs after the first render has already read `remembered`, and the live rewrite after plugin boot overwrites the stored list. So the stale entries most likely survive only when a session ends signed out, and then show briefly on the next load before plugins settle. They are plugin titles, icons and paths, not thread content.

**Proposed end state and preservation argument**

End state:

- `last-known-cache.ts` keeps a module-level `const registered = new Set<() => void>()`. `createLastKnownCache` adds its own `clear` to that set, and accepts an optional `onClear?: () => void` that runs after the storage removal (for in-memory mirrors).
- `last-known-cache.ts` exports `clearAllLastKnownCaches(): void`, which calls every registered clear.
- `app-boot.ts` "clearLastKnownCaches" becomes `resetPluginPageSession(); clearAllLastKnownCaches();`, and the five cache imports go away.
- `sidebar-bootstrap-cache.ts` passes `onClear: () => { replay = null; pendingWrite = null; }` and drops `clearCachedSidebarBootstrap`. Because the `let replay` and `let pendingWrite` declarations (lines 55 and 79) sit below the factory call (line 7), the hook must only reference them when it runs, never during module evaluation. An arrow function satisfies that.
- `provider-list-cache.ts`, `environment-provider-list-cache.ts` and `thread-execution-options-cache.ts` drop their unused clear exports. `model-catalog-cache.ts` keeps `clearCachedModelCatalogs` for `system-cache-effects.ts:237`.
- The plugin nav panel chrome cache is cleared with the others, unless the owner exempts it in step 1.

What stays the same:

- Storage keys, versions, obsolete-prefix pruning, `maxEntries` pruning and schema checks. `clear` keeps its exact body, so stored data and its upgrade path do not change.
- The forget triggers and their order in `boot-cache-owner.ts`. The individual clears touch disjoint localStorage keys and separate module variables, so running them in registration order instead of the current call order changes nothing observable.
- Sidebar bootstrap semantics: after a clear, `readCachedSidebarBootstrap()` returns `null` without re-reading storage, and a queued idle write is dropped, exactly as `clearCachedSidebarBootstrap` does today.
- The streamer-mode reset of model catalogs.
- Performance: one `Set` of six functions, and one localStorage scan per cache, as today.

Intentional behaviour change: the plugin nav panel chrome cache is now forgotten on sign-out and on a server identity change. This brings it in line with the requirement that a signed-out or different-server session must not paint the previous server's data. It is named here so it is not a silent fix.

New invariant to document in the `createLastKnownCache` JSDoc: every instance holds server-derived data and is forgotten with the server. A device preference must not use this factory. All six current instances hold server data.

Non-goals: no change to the boot snapshot store, to `resetPluginPageSession`, to the `plugin-resource` query removal, to the cache key formats, or to which caches exist.

Remaining uncertainty: a module evaluated only after `forget` runs is not registered when the clear happens. Today all six are in the eager graph (evidence above). A future cache reached only through a dynamic `import()` would keep its stored data across a sign-out. Execution step 7 offers a guard test for the current six.

**Expected gain and cost**

Recount at the snapshot (Proven by inspection, from the line ranges cited above):

| Change | Production lines |
|---|---|
| `app-boot.ts`: 5 cache imports and 5 calls removed; 1 import and 1 call added | -8 |
| `provider-list-cache.ts:27`, `environment-provider-list-cache.ts:29-30`, `thread-execution-options-cache.ts:21-22` clear exports removed | -5 |
| `sidebar-bootstrap-cache.ts:120-124` export replaced by an `onClear` option of about 4 lines | about -1 |
| `last-known-cache.ts`: registry set, `onClear` option and type, registration, `clearAllLastKnownCaches` and JSDoc | about +8 to +12 |
| **Net handwritten production change** | **about -2 to -6** (projection) |

Tests: about +15 to +25 lines in `last-known-cache.test.ts` for the registry behaviour (projection). No generated code, assets or docs change.

Causal maintenance gain: a new last-known cache needs no edit outside its own module to be forgotten on sign-out or a server change, and three single-use exports disappear. Cost: a registry is module-level state. It is implicit where the old list was explicit, so the invariant must be written into the factory's JSDoc.

**Execution steps**

1. **Investigation gate: decide the nav panel chrome behaviour.** Ask the owner (Alex) whether `omnyo.plugin-nav-panels.1.*` should be forgotten on sign-out and on a server identity change. Recommended answer: yes. If the answer is no, add `forgetWithServer?: boolean` (default `true`) to `createLastKnownCache`, pass `false` in `plugin-nav-panel-chrome.ts:28`, and record the reason in a one-line comment. Do not start step 3 until this is decided.
2. **Reconfirm anchors.** On the working branch, re-run `rg -n 'createLastKnownCache|clearCached[A-Za-z]*|clearLastKnownCaches' apps packages` from the repository root. Stop and re-plan if a new instance exists, if any `clearCached*` export gained another caller, or if a cache module is now imported only through `import(` (check with `rg -n 'import\(' apps/app/src` against the importers of each cache module).
3. **Add the registry** in `apps/app/src/lib/last-known-cache.ts`:
   - Above the factory, add `const registeredClears = new Set<() => void>();`.
   - Add `onClear?: () => void` to the options object type and its destructuring.
   - Build the returned object in a local `cache` constant. Its `clear` keeps the current body and then calls `onClear?.()` after the `try` block, so the in-memory reset still runs if localStorage throws, which matches `clearCachedSidebarBootstrap` today, where `replay` and `pendingWrite` are reset before the storage call.
   - Call `registeredClears.add(cache.clear)` and return `cache`.
   - Export `clearAllLastKnownCaches(): void` that iterates `registeredClears` and calls each one.
   - Add the JSDoc invariant from the end state.
4. **Move the sidebar mirror reset** in `apps/app/src/lib/sidebar-bootstrap-cache.ts`: pass `onClear: () => { replay = null; pendingWrite = null; }` to the factory call at line 7 and delete `clearCachedSidebarBootstrap` (lines 120-124). Keep `resetSidebarBootstrapCacheForTest`.
5. **Switch app-boot** in `apps/app/src/lib/app-boot.ts`: delete the imports at lines 18-22, import `clearAllLastKnownCaches` from `./last-known-cache`, and make `clearLastKnownCaches` (line 83) call `resetPluginPageSession()` and then `clearAllLastKnownCaches()`. Leave lines 103-106 unchanged.
6. **Delete the single-use exports**: `clearCachedProviderLists` (`provider-list-cache.ts:27`), `clearCachedEnvironmentProviderLists` (`environment-provider-list-cache.ts:29-30`) and `clearCachedThreadExecutionOptions` (`thread-execution-options-cache.ts:21-22`). Keep `clearCachedModelCatalogs`.
   - Checkpoint: `rg -n 'clearCached' apps packages` must return only `model-catalog-cache.ts` and `system-cache-effects.ts`.
7. **Tests** in `apps/app/src/lib/last-known-cache.test.ts`: add one case where two caches with different prefixes write values, `clearAllLastKnownCaches()` runs, both reads return `null`, and an unrelated localStorage key survives. Add one case where `onClear` runs on both `cache.clear()` and `clearAllLastKnownCaches()`. Optionally add a guard test that imports the six cache modules and asserts that each module's stored keys are gone after `clearAllLastKnownCaches()`, so the registry is proven to include them.
8. **Format and review**: run the formatter and lint on the changed files, inspect the full diff for unrelated changes, and recount the production line change against the table above.

**Verification and acceptance criteria**

Commands (run from the repository root `$OMNYO_CHECKOUT` or the working worktree; the script names come from `apps/app/package.json` and the root `package.json` at the snapshot, but they were not executed in this audit because the snapshot has no `node_modules`):

- `pnpm --filter @omnyo/app exec vitest run --config vitest.config.ts src/lib/last-known-cache.test.ts src/hooks/cache-owners/boot-cache-owner.test.tsx src/lib/plugin-nav-panel-chrome.test.tsx src/components/sidebar/AppNavRail.test.tsx`. Expected: all pass, including the new registry cases.
- `pnpm --filter @omnyo/app typecheck`. Expected: no errors. This catches any leftover import of a deleted export.
- `pnpm exec oxlint --fix <changed files>`, `pnpm exec oxfmt <changed files>`, then `pnpm exec oxlint --deny-warnings --format=agent`. Expected: clean.

Behaviour checks:

- The sidebar bootstrap mirror: after `clearAllLastKnownCaches()`, `readCachedSidebarBootstrap()` returns `null`, and a write queued before the clear never reaches storage. Assert this through the existing sidebar bootstrap or query-cache tests if they cover it; otherwise add it to the registry test.
- Streamer-mode reset: `resetModelCatalogsAfterStreamerModeChange` still clears model catalogs (covered by the type check plus the unchanged export).
- Manual check, optional, because Alex tests UI himself: sign out in the web app and confirm with browser devtools that no `omnyo.sidebar-bootstrap.1`, `omnyo.provider-list.2.*`, `omnyo.environment-provider-list.1.*`, `omnyo.thread-execution-options.1.*`, `omnyo.model-catalog.1.*` or (unless exempted) `omnyo.plugin-nav-panels.1.*` key remains in localStorage.

Structural completion:

- `app-boot.ts` imports no individual cache module.
- Exactly one place, `createLastKnownCache`, decides that a cache is forgotten with the server.
- No `clearCached*` export remains without a caller.

Performance: no comparison is needed. The work per forget is unchanged (one localStorage scan per cache) and the forget runs at most once per boot.

**Rollback and stop conditions**

- Rollback: the change is local to seven files with no persisted-format change, so reverting the commit restores the previous behaviour exactly. Stored data written under either version stays readable by the other.
- Stop if a cache module is reachable only through a dynamic import, because registration would then happen after `forget`. In that case keep the explicit list, or import that module eagerly from `last-known-cache.ts` consumers, and re-plan.
- Stop if the owner wants the nav panel chrome to survive sign-out but does not want an exemption flag. The smaller alternative is to add `chromeCache.clear` to the existing list in `app-boot.ts` and leave the registry idea out.
- Stop if a new `createLastKnownCache` use appears that holds device preferences rather than server data. The registry would then wrongly forget it; add the `forgetWithServer` option from step 1 before continuing.
