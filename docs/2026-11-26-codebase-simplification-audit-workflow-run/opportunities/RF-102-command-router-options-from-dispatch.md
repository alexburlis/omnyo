# RF-102 — Derive `CommandRouterOptions` from `CommandDispatchOptions` and forward it with one spread

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplication is real and the plan is sound. Two corrections to the sweep report: the router forwards 25 fields, not 21, and the `Omit` type alone does not stop a field from being forwarded at runtime. The plan below therefore puts the router-owned fields after the spread and states why the only excluded test seam, `streamProviderInstallation`, still cannot reach dispatch from any current caller.
- **Potential:** low. The change touches one file and removes about 45 handwritten production lines and one step that every new dispatch dependency needs.
- **Confidence:** high. Every claim below was checked against the snapshot source (Proven by inspection).
- **Readiness:** ready. No owner decision is needed, because the change is type-level plus one object-construction rewrite with the same runtime contents.
- **Effort:** about one hour, plus the host-daemon typecheck and four focused test files.
- **Risk:** low. The realistic regressions are (a) forwarding `pluginHostManager` into dispatch options, (b) letting a caller-supplied `filesystemMutator` or `runtimeUpdate*` value override the router's own, and (c) forwarding a test-only seam. The execution steps prevent all three.
- **Prerequisites:** none.
- **Related or overlapping RF ids:** none in the same files. RF-031 (plugin service factory contexts derived from the runtime type) and RF-118 (`CapturedPluginApp` derived from the collector registration type) apply the same "derive the type instead of restating it" pattern in other areas. They share no edits with this card.
- **Why it deserves its place:** the field list is duplicated knowledge with measured churn. In the private history, `createDispatchOptions` changed in 17 commits between 2 June and 26 October 2026, for example `b9876fc517` (skill trees), `6dc2e2d630` (slash command discovery), `40ec7949a7` (server migration) and `81d66e0d3d` (Browser Automation). Each commit had to add the field in the support interface, the router interface, the router copy and `app.ts`. After this change only the support interface and `app.ts` need an edit. The gain is small, so the item ranks below opportunities that remove a mechanism or a feature-sized body of code.

**Context and evidence**

Snapshot: `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 26 November 2026), read with `git show <commit>:<path>` because the read-only worktree was not present on disk. The files cited below are byte-identical between that commit and the `main` checkout used for reading (`cmp` against the working copy, Reproduced).

The host daemon receives commands from the server and runs each one through `CommandRouter` (`apps/host-daemon/src/command-router.ts`). The router owns serialization lanes, server-move admission and plugin-host calls. It then hands each command to `dispatchCommand` or `dispatchOnlineRpcCommand` (`apps/host-daemon/src/command-dispatch.ts`), whose handlers receive a `CommandDispatchOptions` dependency bag.

Observed facts (Proven by inspection):

- `apps/host-daemon/src/command-dispatch-support.ts:63-135` `interface CommandDispatchOptions` declares 30 fields.
- `apps/host-daemon/src/command-router.ts:70-101` `export interface CommandRouterOptions` declares 26 fields. 22 of them are typed as `CommandDispatchOptions["x"]`. `eventSink` is `CommandDispatchOptions["eventSink"] & Pick<EventSink, "markThrough">`. `runtimeManager: RuntimeManager`, `threadStorageRootPath: string` and `logger: CommandRouterLogger` restate the dispatch types under other names (`CommandRouterLogger` at line 45 is `Pick<HostDaemonLogger, "debug" | "warn">`, identical to the dispatch `logger` type). Only `pluginHostManager?: PluginHostManager` (line 93) is router-specific.
- `apps/host-daemon/src/command-router.ts:417-454` `private createDispatchOptions()` copies all 25 non-plugin router fields one by one, then adds four router-owned values: `runtimeUpdateOwnCommands: 1`, `runtimeUpdatePluginBlockers` and `closeRuntimeUpdatePluginLeases` (closures over `this.options.pluginHostManager`), and `filesystemMutator: this.filesystemMutator`.
- The five dispatch fields that the router does not accept are exactly those four router-owned values plus `streamProviderInstallation` (`command-dispatch-support.ts:118`), a test seam that `command-dispatch.ts:376` falls back from to the real `streamProviderInstallation` import. No field is currently missing from the copy. The 25 declared fields and the 25 copied fields match, so there is no latent forwarding bug.
- `createDispatchOptions` is called once per command at `command-router.ts:324`, `:328` and `:362`.
- Line counts (Reproduced): `git show <commit>:apps/host-daemon/src/command-router.ts | sed -n 70,101p | wc -l` gives 32; `sed -n 417,454p` gives 38.

Consumers and search scope (Proven by inspection, `git grep -n "createDispatchOptions\|new CommandRouter(\|CommandRouterOptions" <commit> -- .`):

- Production: one construction, `apps/host-daemon/src/app.ts:1132-1184`, an object literal with 26 properties.
- Tests: `apps/host-daemon/test/command/command-router.test.ts:98` (and indexed types `CommandRouterOptions["eventSink"]`, `["logger"]`, `["resolveInteractiveRequest"]`, `["serverMove"]`, `["fetchPluginHostArtifact"]`, `["providerInstallationRun"]` at lines 73-79 and 393), `apps/host-daemon/test/command/thread-stop-races.test.ts:347`, `apps/host-daemon/src/provider-installation-operations.test.ts:452`, `apps/host-daemon/src/thread-storage-deletion.test.ts:151`, `tests/integration/fake/server-move/local-preparation-daemon-admission.test.ts:95` and `tests/integration/fake/server-move/local-preparation-runtime-recovery.test.ts:407`.
- Two tests spread a full `CommandDispatchOptions` into the router constructor: `provider-installation-operations.test.ts:452` spreads `harness.dispatchOptions(...)`, which includes a test `filesystemMutator` (`apps/host-daemon/test/command/dispatch-helpers.ts:525-549`), and `thread-storage-deletion.test.ts:151` spreads `makeDispatchOptions(...)` (`dispatch-helpers.ts:564-579`). Today the explicit copy drops those extra runtime keys. After the change the spread carries them, so the router-owned values must come after the spread to keep overriding them. Neither helper sets `streamProviderInstallation`, `runtimeUpdateOwnCommands`, `runtimeUpdatePluginBlockers` or `closeRuntimeUpdatePluginLeases`.
- Not a public contract: `@omnyo/host-daemon` exports only `./test` (`apps/host-daemon/package.json`), and `apps/host-daemon/src/test/index.ts` does not re-export the router or the dispatch options. Outside `apps/host-daemon`, only the two integration tests import `command-router.js`. Nothing is persisted, string-addressed or plugin-visible.
- Key presence: today absent optional fields exist on the dispatch object with the value `undefined`; after the spread they are absent. A search for `in options`, `Object.keys(options` and `Object.entries(options` in `apps/host-daemon/src` found no presence check. The only spreads of the dispatch object (`command-dispatch.ts:1272` into `installGlobalSkills`) place their own keys after the spread, so presence does not change their result.
- `tsconfig`: `apps/host-daemon/tsconfig.json` extends the shared base, and `exactOptionalPropertyTypes` is enabled only in `tests/scripted-echo-provider/tsconfig.json`, so it does not affect this change.

Counterevidence considered: the explicit list documents exactly what handlers receive. The derived type keeps that guarantee at compile time, and the `Omit` list names the excluded fields in one place. The previous audit (`docs/2026-11-25-material-simplification-audit.md`) does not mention this item.

**Proposed end state and preservation argument**

What remains: `CommandDispatchOptions` stays the single declaration of handler dependencies. `CommandRouterOptions` becomes a derived type:

```ts
export type CommandRouterOptions = Omit<
  CommandDispatchOptions,
  | "eventSink"
  | "filesystemMutator"
  | "streamProviderInstallation"
  | "runtimeUpdateOwnCommands"
  | "runtimeUpdatePluginBlockers"
  | "closeRuntimeUpdatePluginLeases"
> & {
  eventSink: CommandDispatchOptions["eventSink"] &
    Pick<EventSink, "markThrough">;
  pluginHostManager?: PluginHostManager;
};
```

`createDispatchOptions` becomes:

```ts
private createDispatchOptions(): CommandDispatchOptions {
  const { pluginHostManager, ...dispatchOptions } = this.options;

  return {
    ...dispatchOptions,
    runtimeUpdateOwnCommands: 1,
    runtimeUpdatePluginBlockers: () =>
      (pluginHostManager?.getRuntimeUpdateBlockers() ?? []).map(
        (blocker) => blocker.pluginId,
      ),
    closeRuntimeUpdatePluginLeases: async (pluginIds) =>
      (await pluginHostManager?.closeLeasedWorkers(pluginIds)) ?? [],
    filesystemMutator: this.filesystemMutator,
  };
}
```

What disappears: the 26-line field-by-field interface, the 25-line field-by-field copy, the `CommandRouterLogger` alias and its `HostDaemonLogger` import, and the value import `RuntimeManager` (used only in the deleted interface). `this.logger` keeps its type through inference from `options.logger`.

Why the semantics survive:

- In production, `app.ts:1132` passes exactly the 25 forwarded fields plus `pluginHostManager`, so the dispatch object has the same values as today. The router-owned values are identical, and `pluginHostManager` is destructured out.
- The router-owned values are written after the spread, so a caller-supplied `filesystemMutator` (as in `provider-installation-operations.test.ts:452`) is still overridden by the router's `IsolatedFilesystemMutator`, as it is today.
- `streamProviderInstallation` stays outside the router type. No current caller passes it at runtime (checked above), so dispatch still falls back to the real stream. If a future caller spreads an object that carries it, the seam would be honored rather than silently dropped. That is acceptable for a test seam. Keeping the name in the `Omit` list still stops any typed caller from passing it directly.
- The closures capture the destructured `pluginHostManager` instead of reading `this.options.pluginHostManager` when they run. `options` is a `private readonly` field that nothing reassigns or mutates (`git grep -n "options\.pluginHostManager *=\|this\.options *=" <commit> -- apps/host-daemon/src` returned no matches, and `app.ts` passes a fresh object literal), so the result is the same. An implementer who prefers the literal current behavior may keep `this.options.pluginHostManager` in the closures; the rest of the plan is unchanged.
- One object is still allocated per command. Performance is neutral by inspection and was not measured.

Non-goals: no change to `CommandDispatchOptions`, handler code, `app.ts`, lane logic or tests. No public API or persisted format is affected.

**Expected gain and cost**

- Before (Reproduced count): 70 handwritten production lines across the interface (32) and the copy (38), plus 3 import or alias lines that exist only for the interface.
- After (projection, before `oxfmt`): about 13 lines for the derived type and about 15 for the method, so roughly 43-45 production lines removed in `apps/host-daemon/src/command-router.ts`. No test, generated or documentation lines change.
- Maintenance: adding a dispatch dependency goes from four edit sites (support interface, router interface, router copy, `app.ts`) to two (support interface, `app.ts`). A new router-owned or test-only dispatch field needs one entry in the `Omit` list and, for router-owned values, one line after the spread.
- Cost: the reader must read the `Omit` list to see what the router excludes, instead of reading a positive list. Unknown: whether future dispatch fields will more often be router-owned, which would shift the balance; the history above shows nearly all were plain pass-through dependencies.

**Execution steps**

1. Reconfirm the baseline. Run `git -C <repo> show HEAD:apps/host-daemon/src/command-router.ts | sed -n 70,101p` and `sed -n 417,454p` and confirm that the interface and the copy still list the same 25 forwarded fields and the same four router-owned values. Confirm that `CommandDispatchOptions` in `apps/host-daemon/src/command-dispatch-support.ts` still has exactly five fields the router does not accept. Re-plan if any router field is now transformed rather than passed through, if a new caller passes `streamProviderInstallation` or `runtimeUpdate*` into the router, or if a handler now checks property presence (`git grep -n "in options\|Object.keys(options\|Object.entries(options" -- apps/host-daemon/src`).
2. No new behavioral evidence is needed. The existing router tests construct the router through all three shapes (literal fields, spread `makeDispatchOptions`, spread `harness.dispatchOptions`) and exercise dispatch, online RPC, server-move admission and provider installation.
3. Edit `apps/host-daemon/src/command-router.ts`:
   1. Replace `export interface CommandRouterOptions { ... }` (lines 70-101) with the derived `export type CommandRouterOptions` shown above.
   2. Replace the body of `private createDispatchOptions()` (lines 417-454) with the destructure and spread shown above, keeping the four router-owned values after `...dispatchOptions`.
   3. Delete `type CommandRouterLogger` (line 45) and `import type { HostDaemonLogger } from "./logger.js"` (line 35) once nothing else uses them, and delete `import { RuntimeManager } from "./runtime-manager.js"` (line 37), which is used only by the old interface. Keep `EventSink`, `PluginHostManager` and `CommandDispatchOptions` imports.
   4. Checkpoint: run the host-daemon typecheck (below). Expect no errors in `command-router.ts` or in any router test, including the indexed types in `command-router.test.ts:73-79,393`.
4. Format and lint the one changed file (commands below).
5. There is no superseded machinery beyond the deleted lines: no exports, registrations, configuration or documentation name the old interface's fields.
6. Run the focused tests and the integration-test typecheck, then inspect the diff. It should touch only `apps/host-daemon/src/command-router.ts`. Recount with `git diff --stat` and compare against the 70-line baseline.

**Verification and acceptance criteria**

Commands (scripts confirmed in the snapshot's `package.json` files; run from the repository root after `pnpm install`):

- `pnpm --filter @omnyo/host-daemon typecheck` (`tsc --noEmit`; its `tsconfig.json` includes `src` and `test`). Expected: passes.
- `pnpm --filter @omnyo/host-daemon test -- test/command/command-router.test.ts test/command/thread-stop-races.test.ts src/provider-installation-operations.test.ts src/thread-storage-deletion.test.ts src/command-dispatch.test.ts` (the script is `vitest run --config vitest.config.ts`, and its `include` covers `src/**/*.test.ts` and `test/**/*.test.ts`; passing file filters after `--` is standard vitest usage but was not executed here). Expected: all pass with unchanged assertions.
- `pnpm --filter @omnyo/integration-tests typecheck` (covers the two `tests/integration/fake/server-move/local-preparation-*.test.ts` constructions).
- `pnpm --filter @omnyo/integration-tests test:local-server-move` (its config `tests/integration/vitest.local-move.config.ts` includes `fake/server-move/local-preparation*.test.ts`). Expected: passes. These tests use `mkfifo` and need macOS or Linux.
- `pnpm exec oxfmt apps/host-daemon/src/command-router.ts`, then `pnpm exec oxlint --deny-warnings --format=agent apps/host-daemon/src/command-router.ts` (root `.oxfmtrc.json` and `.oxlintrc.json` exist; the per-file form follows the repository's global formatting guidance and was not executed here).

Acceptance:

- Behavior: dispatch receives the same values for every field in production. The router's `filesystemMutator` and the three runtime-update values still override any caller-supplied values. `pluginHostManager` is not present on the dispatch object. `streamProviderInstallation` is not accepted by the router type.
- Structure: `command-router.ts` no longer lists any `CommandDispatchOptions` field by name except the six in the `Omit` list and the four router-owned values. Adding a hypothetical optional field to `CommandDispatchOptions` requires no edit in `command-router.ts` (check by reasoning or by a scratch local edit that is reverted).
- No UI, persisted data or performance budget is affected. No benchmark is required for one unchanged per-command allocation.

**Rollback and stop conditions**

- Rollback boundary: one commit that edits only `apps/host-daemon/src/command-router.ts`. Reverting it restores the explicit list. No data or compatibility implications exist.
- Stop if the typecheck shows a router field whose type differs from its dispatch type (for example a narrowed `eventSink` beyond `markThrough`, or a router-only wrapper type). Keep that field in the intersection part of the derived type rather than reverting the whole change.
- Stop if a caller is found that passes extra runtime keys which must not reach handlers. In that case, prefer an explicit `Pick` of the forwarded fields in the type plus a small destructure for the excluded ones, or keep the current explicit copy.
- Stop if a focused test changes behavior. Investigate key presence (`undefined` property versus absent property) first, since that is the only runtime difference in the object shape.
