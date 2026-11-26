# RF-118 — Replace the hand-kept `CapturedPluginApp` field list with an alias of the collector's `CollectedPluginAppRegistrations`

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The central claim holds exactly: the public test type restates 31 of the collector's 33 fields and silently omits `projectSidebarItems` and `commandPaletteActions`. Two corrections to the sweep report. First, the gain is about 60 handwritten production lines, not about 30, because the 31 type-only imports that exist solely for the interface also disappear. Second, the drift already has a cost in the repository: `plugins/composer-predictions/app.spec.tsx` validates `commandPaletteActions` with a hand-written zod schema because the type does not expose the field.
- **Potential:** low. One file changes in production code, and one maintained list disappears. The gain is real but small.
- **Confidence:** high. The field lists were compared mechanically, every consumer was searched, and the declaration-bundle constraints were read (Proven by inspection). No test or build was run, because the snapshot has no `node_modules`.
- **Readiness:** ready. No owner decision is needed. The change is type-only and additive for every observed caller.
- **Effort:** under one hour, plus the SDK declaration build and three focused test files.
- **Risk:** low. The realistic regressions are (a) a re-export form that the authoring-docs test does not recognize, (b) a bundled declaration that gains a forbidden `@omnyo/*` import, and (c) an external caller that builds a `CapturedPluginApp` literal by hand. The execution steps check all three; no caller of kind (c) was found.
- **Prerequisites:** none.
- **Related or overlapping RF ids:** none touch the same lines. RF-003 (one backend registration core shared by the production plugin API and the SDK fake plugin host) works in the SDK testing area but on the backend fake host in `packages/plugin-sdk/src/testing/fake-plugin-host.ts`, not on `testing/app.tsx`. RF-031 (plugin service factory contexts derived from the runtime type) and RF-102 (`CommandRouterOptions` derived from `CommandDispatchOptions`) apply the same "derive the type instead of restating it" pattern elsewhere. RF-041 (scheduled SDK next-major removal batch) also edits the plugin SDK; if both land in one release, apply them in either order, since they share no symbols. The incidental issue ISS-S13-04 (the two missing captured kinds) is fixed by this change.
- **Why it deserves its place:** every new frontend slot kind must currently be added to the collector type, the collector's empty initializer, the collector's `seenIds` table, the app's slot store in `apps/app/src/lib/plugin-slots.ts`, and `CapturedPluginApp`. All of those except `CapturedPluginApp` are checked by the compiler. The two most recent kinds, project sidebar items (private commit `f7ed982174`, 13 November 2026) and rebindable plugin commands (private commit `3262aadccd`), both missed it. The item ranks low because it removes one list and about 60 lines, not a mechanism or a feature-sized body of code.

**Context and evidence**

Snapshot: `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 26 November 2026). The read-only worktree named for this audit was not present on disk, so files were read with `git -C $OMNYO_CHECKOUT show <commit>:<path>`. The three files cited below are byte-identical between that commit and the `main` working copy (`cmp`, Reproduced).

The plugin SDK collects a plugin app's slot registrations in one validating function, `collectPluginAppRegistrations`. The Omnyo app uses it at runtime. The public frontend test harness, `@omnyo/plugin-sdk/testing/app`, uses the same function in `loadPluginApp`, so a plugin test sees the same normalized registrations as the host. The harness declares its own return type for that result.

Observed facts (Proven by inspection unless labeled):

- `packages/plugin-sdk/src/internal/plugin-app-collector.ts:363-397` `export interface CollectedPluginAppRegistrations` declares 33 fields. `collectPluginAppRegistrations` (line 494) returns it, and the initializer at lines 501-535 is typed against it, so the compiler already checks that the collector fills every field.
- `packages/plugin-sdk/src/testing/app.tsx:1949-1981` `export interface CapturedPluginApp` declares 31 fields (33 lines including braces). `loadPluginApp` (lines 1995-2012) is declared to return `Promise<CapturedPluginApp>` and returns `collectPluginAppRegistrations(definition)` at line 2011. TypeScript accepts the wider object for the narrower type, so the missing fields produce no error.
- The two lists were compared after sorting (Reproduced: `git show <commit>:packages/plugin-sdk/src/testing/app.tsx | sed -n 1950,1980p | sed 's/^ *//' | sort` against the same for `plugin-app-collector.ts` lines 364-396, then `diff`). The only differences are the two fields missing from `CapturedPluginApp`: `projectSidebarItems: ExperimentalProjectSidebarItemsRegistration[]` (collector line 364) and `commandPaletteActions: CollectedPluginCommandRegistration[]` (collector line 390). The other 31 fields have identical names and types.
- Each of the 31 field types is referenced exactly twice in `testing/app.tsx`: once in the import and once in the interface (Reproduced: `grep -c -w <type>` per type over the file). 29 are type specifiers in the `@omnyo/plugin-sdk` import block (lines 22-124, one specifier per line, for example line 27 `type ComposerCustomization,` and line 119 `type PluginMachineProviderInputsRegistration,`). Two, `CollectedPluginProviderIconRegistration` and `CollectedExperimentalSidebarFooterItem`, are imported from `../internal/plugin-app-collector.js` at lines 138-142. All 31 imports become unused when the interface goes.
- History (Proven by inspection of the retired private repository at `$ARCHIVED_OMNYO_CHECKOUT`): `CapturedPluginApp` never contained either field (`git log --all -S commandPaletteActions -- packages/plugin-sdk/src/testing/app.tsx` returns nothing). Commit `f7ed982174` added `projectSidebarItems` to the collector and touched `testing/app.tsx` only for `renderSlot` host state, not for the captured type. Nothing records a decision to hide either kind, so the omission is drift, not a deliberate boundary.

Consumers (searched with `git grep -n -E 'CapturedPluginApp|CollectedPluginAppRegistrations'` over the whole snapshot, and `rg -n 'CapturedPluginApp|mountPluginContentScripts|commandPaletteActions|projectSidebarItems'` over `$OMNYO_PLUGIN_CHECKOUT`, excluding `node_modules`):

- In the snapshot, `CapturedPluginApp` is used only in `testing/app.tsx` (lines 1949, 1997 and 2068, the `app` parameter of `mountPluginContentScripts`) and named in `plugins/omnyo-guide/skills/omnyo-plugin-authoring/references/frontend-testing-api-index.md:26`.
- There are 111 `loadPluginApp(` calls in the snapshot. Every `mountPluginContentScripts` caller found passes a `loadPluginApp` result (`packages/plugin-sdk/src/testing/__tests__/app-harness.test.tsx` lines 838-1150, `plugins/provider-usage/app.test.tsx` lines 228, 553 and 647). No `as CapturedPluginApp`, `satisfies CapturedPluginApp` or hand-built `CapturedPluginApp` literal exists (`git grep -n -E 'as CapturedPluginApp|satisfies CapturedPluginApp|: CapturedPluginApp = \{'`, no hits).
- In the private plugins repository, `glance/tests/ui.test.tsx:55` declares `let app: CapturedPluginApp` and assigns `await loadPluginApp(...)` at line 60, and `sentry/tests/callback-ui.test.tsx:36` passes a `loadPluginApp` result to `mountPluginContentScripts`. Both stay valid with a wider type.
- The cost of the drift is visible in `plugins/composer-predictions/app.spec.tsx:35-47` and `:55-57`. The spec defines `capturedCommandsSchema`, a zod schema for `commandPaletteActions`, and parses the `loadPluginApp` result with it at lines 249-251 to reach a field the type hides. Private commit `7ccc0f49bb` ("feat(predictions): force a suggested reply", 1 November 2026) added it.

Contracts the change must respect (Proven by inspection):

- `apps/server/test/services/plugins/plugin-authoring-docs.test.ts:94-102` `exportedNames` finds frontend test exports with the regex `^export (?:async )?(?:interface|type|function|const|class) ([A-Za-z0-9_]+)` over `testing/app.tsx` (lines 145-150, `FRONTEND_TEST_EXPORT_NAMES`), and compares the names with the authoring API index. `export type CapturedPluginApp = ...` matches; an `export type { ... as CapturedPluginApp }` re-export would not, and the docs test would then report the indexed name as missing.
- `packages/plugin-sdk/src/__tests__/bundled-types.test.ts:99-107` requires that `bundled-types/omnyo-plugin-sdk-testing-app.d.ts` imports no `@omnyo/*` or `@bb/*` module other than `@omnyo/plugin-sdk`. The collector imports its registration types from `@omnyo/plugin-sdk` (line 43), `ExperimentalProjectSidebarItemsRegistration` from `../app-contract.js` (line 1), and `z` from `zod` (line 2). `testing/app.tsx` already imports from `../app-contract.js` (line 3 and line 329), and `packages/plugin-sdk/scripts/build-bundled-dts.mjs:110-118` lists `zod` as external, while `zod` is a runtime dependency of the SDK (`packages/plugin-sdk/package.json` `dependencies`). Hypothesis: the testing-app bundle gains at most an `import { z } from "zod"` for the `CollectedCommandShortcut` alias, which the test allows. Step 4 confirms this on the built file.
- The collector type is already public: `packages/plugin-sdk/package.json` exports `./internal/plugin-app-collector` with its own bundled declaration, and `testing/app.tsx` already exposes two collector types (`CollectedPluginProviderIconRegistration`, `CollectedExperimentalSidebarFooterItem`) through `CapturedPluginApp`. The alias therefore adds no new kind of exposure.

Line counts (Reproduced): `git show <commit>:packages/plugin-sdk/src/testing/app.tsx | sed -n 1949,1981p | wc -l` gives 33; the file has 3,353 lines.

**Proposed end state and preservation argument**

`packages/plugin-sdk/src/testing/app.tsx` keeps the exported name `CapturedPluginApp` and defines it as:

```ts
/** Slot registrations captured by `loadPluginApp`, exactly as the host collects them. */
export type CapturedPluginApp = CollectedPluginAppRegistrations;
```

`CollectedPluginAppRegistrations` in `plugin-app-collector.ts` becomes the only list of captured slot kinds. The 31 now-unused type imports are removed from `testing/app.tsx`, and the collector import becomes `collectPluginAppRegistrations, type CollectedPluginAppRegistrations`.

Why this preserves behavior:

- Runtime is unchanged. `loadPluginApp` already returns the full collector object, including `projectSidebarItems` and `commandPaletteActions`; only the declared type changes.
- The 31 existing fields keep their exact types, so every existing read typechecks as before. The type only gains two fields, which is additive for readers. The only callers who could break are those that construct a `CapturedPluginApp` value by hand; none was found in the snapshot or in `$OMNYO_PLUGIN_CHECKOUT`.
- `mountPluginContentScripts(app: CapturedPluginApp, ...)` keeps its signature and reads only `app.contentScripts`.
- The public symbol name, its subpath (`@omnyo/plugin-sdk/testing/app`), and its entry in the authoring API index stay the same.

Why a plain alias and not the alternatives: an empty `interface CapturedPluginApp extends CollectedPluginAppRegistrations {}` adds nothing and conflicts with common empty-interface lint rules; an `Omit<...>` would only be justified if a kind had to stay hidden from tests, and nothing records such a requirement. `commandPaletteActions` uses an internal shortcut type (`CollectedCommandShortcut`, a `z.infer` of the unexported `commandShortcutSchema`), but that type is already published through the `./internal/plugin-app-collector` subpath.

Non-goals: no change to the collector, its initializer, its `seenIds` table, `apps/app/src/lib/plugin-slots.ts`, `renderSlot`, or any runtime behavior. Unifying the other slot-kind lists is out of scope; they are compiler-checked.

**Expected gain and cost**

- Production code (projection from the counts above): about 62 handwritten lines removed from `packages/plugin-sdk/src/testing/app.tsx` (the 33-line interface plus 31 import specifier lines) and about 2 to 3 added (the alias, its one-line doc comment, and one import specifier). Net about 59 to 61 lines. The formatter may change the count by a line.
- Test code, optional step 5: about 15 lines of the zod workaround in `plugins/composer-predictions/app.spec.tsx` can be replaced by a typed lookup of 3 to 5 lines.
- Mechanisms: one hand-maintained list of slot kinds disappears. Adding a frontend slot kind afterwards needs no edit to the test harness type, and plugin tests see the new kind immediately.
- Cost: the public testing type gains two fields, so the next SDK release carries an additive type change. Performance is unaffected because the change is type-only.

**Execution steps**

1. Reconfirm the baseline. In the working checkout, check that `packages/plugin-sdk/src/testing/app.tsx` still declares `export interface CapturedPluginApp` with 31 fields, that `packages/plugin-sdk/src/internal/plugin-app-collector.ts` still exports `CollectedPluginAppRegistrations`, and that `loadPluginApp` still returns `collectPluginAppRegistrations(definition)`. Re-run the consumer searches from Context against the current tree and `$OMNYO_PLUGIN_CHECKOUT`. Re-plan if `loadPluginApp` no longer returns the collector object directly, if a caller builds a `CapturedPluginApp` literal or uses `satisfies CapturedPluginApp`, or if a code comment or document now says a kind is deliberately hidden from tests (then use `Omit<CollectedPluginAppRegistrations, "<kind>">` and document why).
2. In `packages/plugin-sdk/src/testing/app.tsx`:
   - Replace lines 1949-1981 (`export interface CapturedPluginApp { ... }`) with the two-line doc comment and alias shown in the end state. Keep the `export type CapturedPluginApp =` form so the authoring-docs regex still finds it.
   - In the collector import at lines 138-142, remove `type CollectedPluginProviderIconRegistration` and `type CollectedExperimentalSidebarFooterItem` and add `type CollectedPluginAppRegistrations`.
   - In the `@omnyo/plugin-sdk` import block (lines 22-124), remove the 29 type specifiers that only the interface used. Before removing each one, confirm with `grep -n -w <Type> packages/plugin-sdk/src/testing/app.tsx` that no other reference remains; at the snapshot each type had exactly two occurrences. The 29 are `ComposerCustomization`, `ExperimentalAppOverlayRegistration`, `ExperimentalSidebarFooterCardRegistration`, `ExperimentalTitleBarCenterRegistration`, `ExperimentalSidebarEntryRegistration`, `ExperimentalThreadCompanionRegistration`, `PluginContentScriptRegistration`, `PluginFileOpenerRegistration`, `PluginHomepageSectionRegistration`, `PluginMessageActionRegistration`, `PluginMessageDirectiveRegistration`, `ExperimentalCodeFenceRendererRegistration`, `PluginDiffRendererRegistration`, `PluginNavPanelRegistration`, `PluginNewThreadPanelActionRegistration`, `PluginPendingInteractionRegistration`, `ExperimentalIconRegistration`, `PluginTimelineRendererRegistration`, `PluginSettingsSectionRegistration`, `PluginSidebarFooterActionRegistration`, `PluginSourceCodeRendererRegistration`, `PluginThreadHeaderActionRegistration`, `PluginThreadActionRegistration`, `ExperimentalPluginBrowserToolbarActionRegistration`, `PluginThreadListRegistration`, `PluginThreadPanelActionRegistration`, `PluginThreadViewRegistration`, `PluginEnvironmentProviderInputsRegistration` and `PluginMachineProviderInputsRegistration`.
3. Checkpoint: run the SDK typecheck (Verification, command 1). It must pass with no unused-import or type errors.
4. Build the bundled declarations (command 2) and open `packages/plugin-sdk/bundled-types/omnyo-plugin-sdk-testing-app.d.ts`. Confirm that `CapturedPluginApp` now includes `projectSidebarItems` and `commandPaletteActions`, and that the only `@omnyo/*` import is `@omnyo/plugin-sdk`. A new `import { z } from "zod"` is acceptable. Then run the SDK declaration and export tests (command 3).
5. Optional test cleanup, which can be dropped without losing the production gain: in `plugins/composer-predictions/app.spec.tsx`, replace `capturedCommandsSchema` (lines 35-47), the `suggestCommand` declaration (lines 55-57) and the parse at lines 249-251 with a typed lookup:

   ```ts
   type AppCommand = Extract<
     CapturedPluginApp["commandPaletteActions"][number],
     { target: "app" }
   >;
   let suggestCommand: AppCommand;
   // in beforeEach:
   const command = registrations.commandPaletteActions.find(
     (entry): entry is AppCommand =>
       entry.target === "app" && entry.id === "suggest-reply",
   );
   ```

   The narrowing to `target: "app"` is needed because `CollectedPluginCommandRegistration` is a union, and only the app branch's `run(context: PluginCommandContext)` accepts the `{ threadId, projectId, openPanel }` contexts the spec passes. Check that `PluginCommandContext` (`packages/plugin-sdk/src/app-contract.ts:2340`) covers the fields the spec's local `CommandContext` interface (lines 27-31) uses; if it does, delete `CommandContext` and `isFunction` too, otherwise keep `CommandContext` for the test's call sites. Import `type CapturedPluginApp` from `@omnyo/plugin-sdk/testing/app`, and remove `import { z } from "zod"` (line 11) if nothing else in the spec uses `z`. Keep `zod` in the plugin's `package.json`, because the plugin uses it at runtime. The old schema also checked at runtime that `run` is a function; the typed lookup drops that check, which the collector already performs during `loadPluginApp`. Note for forks: a fork of Composer Predictions that pins an older packed SDK would lose type access to `commandPaletteActions` in this test, so take this step only together with, or after, the SDK change.
6. Format and lint the changed files with the repository's tools (command 5), review the full diff for unrelated changes, and recount: `git diff --stat` on `packages/plugin-sdk/src/testing/app.tsx` should show about 62 deletions and 3 insertions.

**Verification and acceptance criteria**

Commands come from the snapshot's `package.json` files and `turbo.json`. None was run during this audit, because the snapshot has no `node_modules`.

1. From `packages/plugin-sdk`: `pnpm typecheck` (`tsc --noEmit`). Expected: passes.
2. From the repository root: `pnpm exec turbo run build:types --filter=@omnyo/plugin-sdk`. The `@omnyo/plugin-sdk#build:types` task depends on the backend, providers, app and internal groups, so this builds every bundled declaration that the tests in command 3 read. Expected: succeeds.
3. From `packages/plugin-sdk`: `pnpm test -- src/__tests__/bundled-types.test.ts src/__tests__/package-exports.test.ts src/__tests__/public-types.test.ts src/testing/__tests__/app-harness.test.tsx`. Expected: all pass. In particular, `bundled-types.test.ts` "ships portable declarations for every exported subpath" must still find only `@omnyo/plugin-sdk` among `@omnyo/*` imports in `omnyo-plugin-sdk-testing-app.d.ts`.
4. From `apps/server`: `pnpm test -- test/services/plugins/plugin-authoring-docs.test.ts`. Expected: passes, which shows `CapturedPluginApp` is still found as a frontend test export and still matches the API index.
5. Formatting and lint, from the repository root, on the changed files only: `pnpm exec oxfmt <files>` and `pnpm exec oxlint --deny-warnings <files>` (root `.oxlintrc.json` and `.oxfmtrc.json` exist; the root `format:check` script is `oxfmt . --check`).
6. If step 5 was taken, from `plugins/composer-predictions`: `pnpm typecheck` and `pnpm test -- app.spec.tsx`. Expected: both pass with unchanged assertions. The `suggestCommand.isAvailable` and `suggestCommand.run` tests at lines 727-792 must keep their current expectations.
7. Optional external check, if Alex wants it: typecheck the private plugins that use the type, `$OMNYO_PLUGIN_CHECKOUT/glance` and `$OMNYO_PLUGIN_CHECKOUT/sentry`, against the new SDK build. The repository's own scripts for that checkout were not inspected, so read its `package.json` before running anything there.

Structural completion: `testing/app.tsx` no longer lists any slot kind; `CapturedPluginApp` is an alias of `CollectedPluginAppRegistrations`; the 31 interface-only type imports are gone; no runtime code changed. Performance needs no measurement, because the change affects types only.

**Rollback and stop conditions**

The change is one commit that touches `packages/plugin-sdk/src/testing/app.tsx` and, optionally, `plugins/composer-predictions/app.spec.tsx`. Reverting that commit restores the interface. No persisted data, runtime format or wire contract is involved.

Stop and re-plan if:

- a caller, in this repository or in `$OMNYO_PLUGIN_CHECKOUT`, builds `CapturedPluginApp` values by hand or uses `satisfies CapturedPluginApp`. The wider type would then require those callers to add two fields. In that case either update them in the same change or keep the interface and add the two missing fields to it, which fixes ISS-S13-04 without the derivation;
- the testing-app bundled declaration gains a forbidden `@omnyo/*` import, or `rollup-plugin-dts` fails on the inlined collector types. Then try `export type CapturedPluginApp = import("@omnyo/plugin-sdk/internal/plugin-app-collector").CollectedPluginAppRegistrations` only if the bundled-types test allows that subpath; otherwise fall back to the "add the two fields" alternative above;
- an owner or document states that `projectSidebarItems` or `commandPaletteActions` must stay out of the public test type. Then use `Omit<CollectedPluginAppRegistrations, ...>` and record the reason next to the alias.
