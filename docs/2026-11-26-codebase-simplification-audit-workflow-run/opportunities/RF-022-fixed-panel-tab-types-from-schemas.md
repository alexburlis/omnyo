# RF-022 — Replace the hand-written fixed-panel tab interfaces with types inferred from their zod schemas

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplication is real and the type-only change is safe, but the sweep overstated the gain. The ready change saves about 60–75 production lines, not 90–100. The optional second phase (building the local schemas from the server-contract thread-tab schemas) is conditional, because it changes runtime validation of stored local state.
- **Potential:** medium. One of two hand-maintained declarations of eleven persisted tab shapes disappears, together with a silent drift hazard (see Context).
- **Confidence:** high for phase 1 (Proven by inspection; not compiled, because the snapshot has no `node_modules`). Medium for phase 2.
- **Readiness:** phase 1 is ready. Phase 2 is conditional on the investigation gate in step 7.
- **Effort:** phase 1 takes 1–2 hours including typecheck and the focused tests. Phase 2 takes about half a day to a day.
- **Risk:** phase 1 is low because it is a type-only change with no runtime or stored-format effect. Phase 2 is medium: stricter local limits could make `parseFixedPanelTabsState` prune a thread's whole local panel state.
- **Prerequisites:** none for phase 1.
- **Related or overlapping RFs:** RF-013 (building secondary-panel tab descriptors once), RF-021 (shared secondary-panel host commands) and RF-038 (terminal tab reconciliation) consume these tab types but do not edit their declarations. RF-022 can land before or after them. If one of those changes lands first, rebase this change and re-run the typecheck.
- **Why it deserves its place:** this is a small change with a clean proof. It removes duplicated knowledge in persisted-state code, where a mismatch fails silently by discarding user panel state. It is not a large line-count win.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26), read through `git show` because the named snapshot worktree was not present. All paths below are repository-relative.

*Subsystem.* Each thread's secondary panel (the right-hand tab strip with file previews, the browser, terminals, plugin panels and similar tabs) keeps per-thread state in localStorage under `omnyo.thread.fixedPanelTabsState…` (version 1, with a 14-day idle expiry). Since July 2026 the server also keeps a revisioned thread-tab document, and the app reconciles the two. The web app (`apps/app`) is the only runtime consumer; `@omnyo/client-core` and `@omnyo/server-contract` are both `"private": true` workspace packages.

*Observed facts (Proven by inspection):*

1. `packages/client-core/src/panel/fixed-panel-tabs-state.ts` declares each tab shape twice in the same file:
   - Strict zod schemas at lines 71–183: `threadInfoFixedPanelTabSchema`, `gitDiffFixedPanelTabSchema`, `pluginPageFixedPanelTabSchema`, `workspaceFilePreviewFixedPanelTabSchema`, `hostFilePreviewFixedPanelTabSchema`, `threadStorageFilePreviewFixedPanelTabSchema`, `attachmentFilePreviewFixedPanelTabSchema`, `browserFixedPanelTabSchema`, `newTabFixedPanelTabSchema`, `terminalFixedPanelTabSchema` and `pluginPanelFixedPanelTabSchema`, combined at lines 185–197 in `secondaryFixedPanelTabSchema` (a `z.union`).
   - Hand-written TypeScript declarations at lines 230–346: the interfaces `ThreadInfoFixedPanelTab` and `GitDiffFixedPanelTab` (not exported), plus the exported `PluginPageFixedPanelTab`, `PluginPanelFixedPanelTab`, `WorkspaceFilePreviewFixedPanelTab`, `HostFilePreviewFixedPanelTab`, `ThreadStorageFilePreviewFixedPanelTab`, `AttachmentFilePreviewFixedPanelTab`, `BrowserFixedPanelTab`, `NewTabFixedPanelTab` and `TerminalFixedPanelTab`, and the unions `FixedPanelViewTab` (248), `SecondaryFixedPanelTab` (323), `SecondaryFileFixedPanelTab` (336) and `FixedPanelTab` (346).
   - Count: `git show e9e1b74c:packages/client-core/src/panel/fixed-panel-tabs-state.ts | sed -n '230,346p' | grep -cv '^\s*$'` gives 103 non-blank lines (117 lines with blanks). The schema block 71–183 is also 103 non-blank lines.
2. The two declarations agree field by field. The repository uses zod 4 (`package.json` override `"zod": "4.6.7"`). In zod 4 output types, a `.nullable().default(null)` field becomes the required type `T | null`, which matches the interface fields such as `HostFilePreviewFixedPanelTab.environmentId: string | null`. A `.optional()` field becomes `key?: T | undefined`, which is equivalent to the interface's `key?: T` because `exactOptionalPropertyTypes` is off. The shared `packages/tsconfig/base.json` only sets `strict`; the only `exactOptionalPropertyTypes` hit at the snapshot is `tests/scripted-echo-provider/tsconfig.json` (searched with `git grep -n exactOptionalPropertyTypes e9e1b74c -- '*.json'`). The nested field types already come from schemas: `OmnyoDesktopBrowserTarget` (`packages/desktop-contract/src/browser.ts:23`), `TerminalCreateTarget` (`packages/server-contract/src/api/terminals.ts:105`) and `ThreadTabFileOpenerOwner` (`packages/server-contract/src/api/thread-tabs.ts:95`) are all `z.infer` aliases. The local helper schemas `environmentFilePreviewSourceSchema`, `workspaceFilePreviewStatusLabelSchema` and `filePreviewLineRangeSchema` (lines 40–69) are explicitly annotated `z.ZodType<…>` with the `file-preview.ts` types, so inference reproduces those exact names.
3. Only one direction of agreement is enforced today. `parseFixedPanelTabsStateForStorage` (line 1037) passes `fixedPanelTabsStateSchema.safeParse(...).data` into `normalizeFixedPanelTabsState({ state })`, which is typed `FixedPanelTabsState`. That makes the compiler check that schema output is assignable to the interfaces. The opposite direction is not checked. Suppose someone adds an optional field to an interface, writes it from a factory, and forgets the schema. The code compiles, but the `.strict()` schema rejects the unknown key on the next load. The parse then returns `shouldPrune: true` (line 1062) and the thread's whole local panel state silently resets. Deriving the types from the schemas removes that hazard.
4. Consumers. `git grep -lE 'SecondaryFixedPanelTab|BrowserFixedPanelTab|FixedPanelViewTab|TerminalFixedPanelTab' e9e1b74c` finds them only in `packages/client-core/src/panel/` and `apps/app/src/` (about 31 files, many of them tests and stories). Nothing in `plugins/`, `packages/plugin-sdk`, `apps/mobile` or `apps/desktop` matches. Nothing `extends`, `implements` or module-augments these interfaces: `git grep -nE '(extends|implements)\s+…FixedPanel…Tab\b'` and ``git grep -n "declare module ['\"]@omnyo/client-core"`` both return no hits. `packages/client-core/src/index.ts:83` re-exports the module with `export *`, and the app shim `apps/app/src/lib/fixed-panel-tabs-state.ts:10–49` re-exports 21 values and 14 types by name. Both keep working with type aliases under the same names.
5. A third, server-side declaration exists. `packages/server-contract/src/api/thread-tabs.ts:99–192` `threadTabSchema` declares the same ten shared kinds plus `side-chat`, without the local-only `plugin-page-fixed` kind. It adds max-length limits (`THREAD_TAB_ID_MAX_LENGTH` and the others at lines 4–18), and it requires several fields that the local schema defaults to `null` for older stored data: workspace `lineRange` and `projectId`; host and thread-storage `environmentId` and `threadId`; browser `environmentId`. Its browser `desktopTarget` (lines 161–168) is an inline copy of `omnyoDesktopBrowserTargetSchema`, because `server-contract` does not depend on `desktop-contract`. The bridge is `apps/app/src/lib/thread-tabs-sync.ts`: `persistedThreadTabs` (line 46) filters out `side-chat` and `plugin-page-fixed`, `reconcileFixedPanelTabsState` (line 72) assigns server `ThreadTab` values into local `FixedPanelTab[]`, which gives a compile-time check of server output against the local types, and `persistThreadTabs` and `migrateLocalThreadTabs` validate local tabs with `threadTabsSchema.parse` before each server write (lines 260 and 282).
6. Runtime fixtures exist: `apps/app/src/lib/fixed-panel-tabs-state.test.ts` covers the round trip, legacy ownerless host and storage tabs (line 475), dropping old state shapes (168), side-chat removal (643), terminal targets (578) and plugin file-opener owners (522). Related tests are `apps/app/src/lib/thread-tabs-sync.test.ts`, `fixed-panel-tabs-sync.test.ts` and `fixed-panel-tabs.plugin-terminal.test.ts`. `packages/client-core/test` has no fixed-panel tests.

*Counterevidence and limits.* Public history at this snapshot is one squashed commit (`060950255 Publish Omnyo source`), so past drift between the two declarations cannot be measured; the hazard in fact 3 is established by inspection, not by an observed incident. Equivalence in fact 2 is Proven by inspection, not compiled. Step 2 below makes it a compiler-checked proof.

*Maintenance cost today.* Adding or changing a persisted tab field takes edits to the local schema, the local interface and the server schema, and, for browser targets, to the desktop-contract schema. If the first two disagree, nothing fails at build time in the dangerous direction.

**Proposed end state and preservation argument**

*Phase 1 (ready).* The hand-written interfaces and the member lists of the unions at lines 230–346 disappear. The zod schemas become the only declaration of local tab shapes, and every exported type name survives as an alias:

```ts
type ThreadInfoFixedPanelTab = z.infer<typeof threadInfoFixedPanelTabSchema>;
type GitDiffFixedPanelTab = z.infer<typeof gitDiffFixedPanelTabSchema>;
export type PluginPageFixedPanelTab = z.infer<typeof pluginPageFixedPanelTabSchema>;
export type PluginPanelFixedPanelTab = z.infer<typeof pluginPanelFixedPanelTabSchema>;
// …the same for WorkspaceFilePreview, HostFilePreview, ThreadStorageFilePreview,
// AttachmentFilePreview, Browser, NewTab and Terminal…
export type SecondaryFixedPanelTab = z.infer<typeof secondaryFixedPanelTabSchema>;
export type FixedPanelViewTab = Extract<
  SecondaryFixedPanelTab,
  { kind: "thread-info" | "git-diff" | "plugin-page-fixed" }
>;
export type SecondaryFileFixedPanelTab = Exclude<SecondaryFixedPanelTab, FixedPanelViewTab>;
export type FixedPanelTab = SecondaryFixedPanelTab;
```

(The formatter will wrap the longer lines.) Several declarations stay hand-written on purpose. `FixedPanelTabGroupState`, `FixedSecondaryPanelTabGroupState` and `FixedPanelTabsState` (lines 348–362) carry semantics the schemas do not: `readonly` tab arrays, the local-only transient `previousActiveTabId?`, and a version literal type. All function argument interfaces stay too. The export list, the module paths, the stored JSON format, the storage keys and version, and the runtime validation all stay exactly as they are. Phase 1 changes no runtime code, so no UI state, persistence path or performance property can change.

*Preservation argument.* Each alias resolves to the same structural type as the interface it replaces (fact 2). The one structural difference between an interface and an object-type alias is that an alias is implicitly assignable to index-signature types such as `Record<string, unknown>`. That only loosens assignability, so it cannot break a consumer, and the search in fact 4 found nothing that extends, implements or augments these interfaces.

*Phase 2 (conditional, separate change).* This phase would build each local schema from the matching server-contract variant, which means exporting the variant schemas from `thread-tabs.ts`. The local legacy `.default(null)` fields would be re-applied with `.extend(...)`, and the local-only `plugin-page-fixed` variant would stay in client-core. The server-contract browser variant could also import `omnyoDesktopBrowserTargetSchema`; `desktop-contract` depends only on `domain` and `host-daemon-contract`, so the new dependency would create no cycle. The end state would be one shape owner (server-contract) plus explicit local extensions. This phase changes runtime behavior, because local parsing would start enforcing the server's max lengths and list rules. For that reason it is gated in step 7, and it must not be bundled with phase 1.

*Non-goals.* This card does not retire the legacy `.default(null)` fields (the test at `fixed-panel-tabs-state.test.ts:475` encodes them as a contract), does not remove the app re-export shim, does not change storage versioning, and does not change server validation.

**Expected gain and cost**

| Item | Before | After (projection) |
|---|---|---|
| Local declarations of each tab shape | 2 (schema and interface) | 1 (schema) |
| Lines 230–346 of `fixed-panel-tabs-state.ts` | 117 (103 non-blank) | about 45–55 (about 35 non-blank) |
| Imports | `type OmnyoDesktopBrowserTarget` used once | removed (used only by `BrowserFixedPanelTab`) |
| Phase 1 net handwritten production lines | — | about −60 to −75 (projection; recount after formatting) |
| Phase 2 additional net lines | — | about −40 to −60 (projection; server-contract gains about 10–20 lines of named variant exports) |
| Tests, generated code, docs | unchanged | unchanged |

The causal link to easier maintenance is direct. A new persisted field becomes a one-line schema edit in client-core, and the TypeScript type follows automatically. The silent prune-on-drift mode in fact 3 becomes impossible for local tabs. The tradeoff is that editor hovers show expanded inferred types instead of interface names. Compile-time cost is negligible for eleven small object schemas, but it was not measured. Runtime performance is unaffected by phase 1, because no emitted JavaScript changes.

**Execution steps**

1. **Reconfirm the baseline.** In a fresh worktree of current `main`, confirm that `packages/client-core/src/panel/fixed-panel-tabs-state.ts` still has the schema block and the interface block described in Context (search by symbol, because line numbers may drift). Confirm that zod is still major version 4 and that `exactOptionalPropertyTypes` is still off for `packages/client-core` and `apps/app`. Run `pnpm --filter @omnyo/client-core typecheck` and `pnpm --filter @omnyo/app typecheck` and record whether they pass before any edit. Re-plan in any of these cases: zod is no longer major version 4; `exactOptionalPropertyTypes` is on; a consumer now `extends`, `implements` or augments one of these interfaces; or new hand-written fields exist on an interface but not on its schema. The last case is a live drift bug: report it separately before continuing.
2. **Prove equivalence with the compiler (temporary checkpoint).** In `fixed-panel-tabs-state.ts`, rename each existing interface and union to `Legacy<Name>` without deleting it, and add the aliases from the proposed end state. Add a temporary block:
   ```ts
   type Equals<A, B> =
     (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
   type AssertTrue<T extends true> = T;
   type _Check = [
     AssertTrue<Equals<BrowserFixedPanelTab, LegacyBrowserFixedPanelTab>>,
     // …one entry per tab type and per union…
   ];
   ```
   Run `pnpm --filter @omnyo/client-core typecheck`. If an `Equals` check fails only because of `?: T` versus `?: T | undefined`, it is acceptable to replace that entry with mutual assignability checks (`AssertTrue<A extends B ? (B extends A ? true : false) : false>`). Any other mismatch means the schema and the interface already disagree. In that case, stop and record it as an incidental issue instead of choosing a side silently.
3. **Delete the legacy declarations.** Remove every `Legacy*` interface and union and the temporary assertion block. Keep `FixedPanelTabGroupState`, `FixedSecondaryPanelTabGroupState`, `FixedPanelTabsState` and all `*Args` interfaces unchanged. Remove the now-unused `type OmnyoDesktopBrowserTarget` import from line 6. Keep `type TerminalCreateTarget` and `type ThreadTabFileOpenerOwner`, which other code in the file still uses (for example around lines 433, 950 and 1232). Place the aliases directly after `fixedPanelTabsStateSchema` (line 228), so that each schema is declared before its type is used.
4. **Leave consumers untouched.** `packages/client-core/src/index.ts`, `packages/client-core/src/panel/secondaryPanelTabState.ts`, `apps/app/src/lib/fixed-panel-tabs-state.ts` and all `apps/app` importers keep the same names. If the typecheck flags a consumer, the cause is a real semantic difference, so go back to step 2 instead of patching the consumer.
5. **Format and lint the changed file.** From the repository root, run `pnpm exec oxfmt packages/client-core/src/panel/fixed-panel-tabs-state.ts`, then `pnpm exec oxlint --deny-warnings --format=agent packages/client-core/src/panel/fixed-panel-tabs-state.ts`.
6. **Inspect and recount.** Check that `git diff` touches only `fixed-panel-tabs-state.ts` and contains no runtime edits: no schema, function or constant changes. Recount with `git diff --stat` and report handwritten production lines removed against the 117-line baseline block. This is the end of phase 1; commit it as its own change.
7. **Phase 2 investigation gate (only if the owner wants a single shape owner).** Do not start phase 2 until each of these is answered with evidence:
   - (a) For every server max length and list rule (`threadTabsSchema` `.max(200)`, the JSON payload cap, duplicate-id check, and the field limits at `thread-tabs.ts:4–18`), decide whether it should apply locally. Adding any of them to the local schema makes `parseFixedPanelTabsStateForStorage` prune the whole state for a thread whose stored tabs exceed the limit. Such tabs already fail the server write through `threadTabsSchema.parse` in `thread-tabs-sync.ts:260` and `:282`, but today they still restore locally. Getting this wrong loses user-visible panel state, so the safe default is to strip limits when deriving the local schema, or to keep local limits no stricter than today.
   - (b) Confirm that the zod 4 `.extend()` and `.strict()` combination reproduces the exact local legacy defaults, and that the `fixed-panel-tabs-state.test.ts` fixtures at lines 78, 168, 475 and 643 pass unchanged.
   - (c) Decide whether `server-contract` may depend on `desktop-contract` for `omnyoDesktopBrowserTargetSchema`, or whether that schema moves to a package both already depend on.

   If (a) cannot be met without stricter local validation, stop phase 2; phase 1 stands on its own. Otherwise, export named variant schemas from `packages/server-contract/src/api/thread-tabs.ts`, rebuild `threadTabSchema` from them, derive the client-core variants with `.extend({...legacy defaults})`, keep `pluginPageFixedPanelTabSchema` local, and repeat steps 2–6 with the same `Equals` proof against the phase 1 types.

**Verification and acceptance criteria**

Commands (exact package names and scripts were read from each `package.json` at the snapshot; none were run, because the snapshot has no `node_modules`):

- From the repository root: `pnpm --filter @omnyo/client-core typecheck` (the script is `tsc --noEmit`). Expected result: it passes, including the temporary `Equals` block from step 2 while that block exists.
- From the repository root: `pnpm --filter @omnyo/app typecheck` (the script is `tsc --noEmit && tsc --noEmit -p tsconfig.node.json`). Expected result: it passes with no consumer edits.
- From `apps/app`: `pnpm exec vitest run --config vitest.config.ts src/lib/fixed-panel-tabs-state.test.ts src/lib/thread-tabs-sync.test.ts src/lib/fixed-panel-tabs-sync.test.ts src/lib/fixed-panel-tabs.plugin-terminal.test.ts`. The app's `vitest.config.ts` accepts plain `src/…test.ts` filters. Expected result: all tests pass with no fixture or assertion changes. For phase 1 this check is a guard only, because no runtime code changes. For phase 2 it is the primary behavioral proof.
- From the repository root: `pnpm exec oxlint --deny-warnings --format=agent packages/client-core/src/panel/fixed-panel-tabs-state.ts` and `pnpm exec oxfmt --check packages/client-core/src/panel/fixed-panel-tabs-state.ts`.

Acceptance:

- Behavior and contract: phase 1 leaves the emitted JavaScript unchanged; the diff contains no runtime edits. The stored JSON, storage keys and version are untouched. The phase 2 behavioral checks are listed in step 7 and in the tests above; do not edit expected values to make them pass.
- UI: no visual check is needed for phase 1, because no runtime code changes. Phase 2 needs a manual restore check of a thread with each tab kind open, and Alex tests UI changes himself.
- Performance: no runtime effect in phase 1. Typecheck time is not budgeted, so no comparison is required.
- Structural completion: no interface named `*FixedPanelTab` remains in `fixed-panel-tabs-state.ts`. Every exported tab type is a `z.infer` alias or an `Extract`/`Exclude` of the inferred union. No `Legacy*` or temporary assertion code remains.

**Rollback and stop conditions**

- **Rollback.** Phase 1 is a single-file, type-only commit. Reverting it restores the interfaces, and there are no data or compatibility implications because nothing runtime or persisted changes. Phase 2 is a separate commit. Reverting it restores the independent local schemas. Local state written under phase 2 uses the same JSON shape, so it remains readable after the revert.
- **Stop conditions:**
  - The `Equals` proof in step 2 fails for any reason other than `?:` optional-versus-`undefined`. That means an existing drift; file it as an incidental issue and fix it deliberately first.
  - zod is upgraded to a version whose inferred output types differ from these semantics, or `exactOptionalPropertyTypes` is enabled.
  - A consumer outside `apps/app` and `packages/client-core` is found, such as a plugin or the mobile app importing these types.
  - For phase 2, any stricter local validation that would prune existing stored state, or any change to the legacy-default fixtures.
- **Safer smaller alternative.** If the aliases are unwelcome for readability, keep the interfaces and add the step 2 `Equals` assertions permanently, about 15 lines. That closes the drift hazard without the line reduction.
