# RF-066 — Delete the Worktree plugin's `defaultBaseBranch` RPC chain and read the picker's default base from the core branches query through `BranchesState`

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** confirmed, with small adjustments. The central claim holds: the Worktree picker fetches its "Branch from:" default through a private app → server → host RPC chain, while the branches query it already runs returns the same value, computed for the same project source by an equivalent rule. Adjustments to the sweep report: (1) name the new SDK field `defaultBaseBranch` without an `experimental_` prefix, because fields of the already-experimental `BranchesState` and `CheckoutState` carry no prefix; (2) the net production reduction is about 74 lines, not 55-70; (3) two SDK-guide documents describe the `BranchesState` shape and must be updated; (4) the deleted host test is also named as a verification check in the RF-010 card, so whichever of RF-010 and RF-066 lands second must adjust.
- **Potential:** medium. One plugin RPC, one host-worker RPC handler, one host contract entry, one app effect with its own stale-result bookkeeping and one refresh counter disappear. The picker then has one data path for everything it shows.
- **Confidence:** high. Source selection and the default-base rule were compared line by line (see Context).
- **Readiness:** ready.
- **Effort:** small, two to four hours including test rewrites.
- **Risk:** low. The only public contract touched is the experimental app SDK type `BranchesState`, which gains one field. The realistic regression is a label that stays on "default" or shows a stale branch after switching machine or project; the acceptance tests below target both.
- **Prerequisites:** none.
- **Related and overlapping items:**
  - RF-010 (one owner for Git default-branch discovery in `createGitQueries`). RF-066 removes the plugin host handler at `plugins/environment-git-worktree/host.ts:59-69`, one of RF-010's listed consumers, and deletes `host.test.ts:874-895`, which RF-010 names as a verification check. RF-010 stays valid either way, because the provisioning path (`host/base-branch.ts`) keeps using `readDefaultBranchRefs` and `resolveDefaultBaseBranch`. RF-066 does not need to decide RF-010's step 5 (the server copy `resolveDefaultWorktreeBaseBranch`): that copy stays and becomes the single source of the picker label.
  - ISS-S18-01 (the create path's fallback rule differs from the label rule) is a separate defect. RF-066 does not change what a worktree is created from.
- **Why it deserves its place:** today a change to default-base semantics, source selection or refresh behavior must be kept consistent in two places (core's branches route and the plugin's server/host pair). After this change only core decides, and the plugin renders what core returns. It also removes a server RPC, a host-worker round trip and about five Git processes each time the picker mounts or opens.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The snapshot worktree had been removed before verification, so every file was read with `git -C $OMNYO_CHECKOUT show e9e1b74c:<path>` and searched with `git grep <pattern> e9e1b74c -- <scope>`. No tests were run, because the snapshot has no `node_modules`.

*What the picker shows.* The Worktree environment provider (`plugins/environment-git-worktree`) registers an inputs control, `WorktreeInputsControl` in `app.tsx:93`. Its trigger reads "Branch from: <base>" for a new worktree, where `baseBranchLabel = branchName ?? defaultBase ?? "default"` (`app.tsx:246`). The same component already calls `experimental_useBranches({ hostId, projectId, query })` (`app.tsx:140-144`) for its branch list.

*The plugin's own default-base chain (Proven by inspection).*
- `app.tsx:119-125` holds `baseResult` state (scoped by `projectId` and `hostId`) and a `baseRefresh` counter.
- `app.tsx:200-216` is an effect that, when no branch is named and no existing worktree is selected, calls `rpc.call("defaultBaseBranch", { projectId, hostId })` and stores the result, with an `active` flag to drop late results.
- `app.tsx:241-244` discards a result whose `projectId` or `hostId` no longer matches.
- `app.tsx:262-265` (in `updateOpen`) waits for `branchState.refresh()` and then bumps `baseRefresh` so the effect re-reads the default after the blocking remote fetch.
- `server.ts:56-64` declares `defaultBaseBranch` in `worktreeRpcContract`. `server.ts:267-286` implements it: `api.sdk.projects.get`, filter `local_path` sources, pick the source on `hostId` (or, for a null host, the `isDefault` source, else the first), then `host.call("defaultBaseBranch", { sourcePath })`.
- `contract.ts:24-27` declares `defaultBaseBranch` in `worktreeHostContract`. `host.ts:59-69` implements it with `readDefaultBranchRefs` and `resolveDefaultBaseBranch` from `omnyo-environment-provider-host/git`, imported at `host.ts:5-8` only for this handler (the provisioning path imports them separately in `host/base-branch.ts:1-6`).

*The core path the picker already runs (Proven by inspection).*
- `apps/app/src/components/plugin/usePluginBranchPickerState.ts:11-64` `usePluginBranches` is the app's implementation of `experimental_useBranches` (wired at `apps/app/src/lib/plugin-sdk-app-impl.tsx:129`). For a null `hostId` it picks the project's `local_path` source with `isDefault`, else the first `local_path` source (lines 24-29), and calls `useProjectSourceBranches(projectId, branchHostId, …)`. It maps only `branches`, `remoteBranches`, `isLoading` and `refresh` into `BranchesState` (lines 49-63).
- `useProjectSourceBranches` (`apps/app/src/hooks/queries/project-queries.ts:91-189`) reads `readProjectBranchOptions` (background remote refresh) normally and `sdk.projects.branches` (blocking refresh) after `refreshFromRemote()`. Its query key includes project, host and search query; `resolveProjectSourceBranchesPlaceholder` (`apps/app/src/hooks/queries/query-placeholders.ts:99-128`) keeps previous data while the search query changes but returns `undefined` when project or host changes.
- Both routes go through `readProjectBranches` (`apps/server/src/routes/projects.ts:914-969`), which calls `host.inspect_git_source` and returns `defaultWorktreeBaseBranch: resolveDefaultWorktreeBaseBranch(result)` (line 967). The field is in the response schema at `packages/server-contract/src/api/projects.ts:216` and is already used by core's own composer at `apps/app/src/components/promptbox/dock/NewChatDock.tsx:1134`.

*Equivalence of the two paths (Proven by inspection).*
- Source: the server resolves the source with `getProjectSourceByHost` (`apps/server/src/services/projects/project-workspace.ts:38-49`, requiring `type === "local_path"`). `project_sources_project_host_idx` is a unique index on `(project_id, host_id)` (`packages/db/drizzle/0000_baseline.sql:332`), so "the source on this host" is the same row the plugin's `sources.find(source.hostId === hostId)` picks. The null-host choice is the same rule in both (`isDefault`, else first `local_path`).
- Refs: core's `host.inspect_git_source` (`apps/host-daemon/src/command-handlers/host-branches.ts:271-335`) calls `readDefaultBranchRefs` from `packages/host-workspace/src/git.ts:1368`. The plugin calls the copy in `packages/environment-provider-host/src/git.ts:579`. A function-by-function comparison found `resolvePreferredLocalDefaultBranch`, `readOriginDefaultBranch` and `readLocalBranches` byte-identical, `readDefaultBranchRelation` identical to `readBranchRelation` apart from the name, and `readOriginHeadBranchName` equivalent (host-workspace factors the parse into `parseOriginHeadBranchName`, git.ts:1207).
- Rule: `apps/server/src/services/projects/worktree-base-branch.ts:9-28` `resolveDefaultWorktreeBaseBranch` and `packages/environment-provider-host/src/git.ts:558-577` `resolveDefaultBaseBranch` have identical bodies.
- Failure: a non-git path makes core return null refs, so `defaultWorktreeBaseBranch` is null; the plugin host's `ensureGitRepo` throws, so the app's `.catch` stores null. An offline host fails both paths. Either way the label falls back to "default".

*Consumer search (Proven by inspection; a search with no hits is not proof of absence).*
- `git grep -n "defaultBaseBranch" e9e1b74c -- ':!plugins/environment-git-worktree'` over the whole tree, all file types: no hits. Inside the plugin the hits are the four production sites above plus tests (`app.test.tsx:59,159,291,329,408`, `server.test.ts:453,464`, `host.test.ts:878,888,893`). The plugin README does not mention it.
- `git grep -n -e BranchesState -e experimental_useBranches -e usePluginBranches e9e1b74c -- ':!*.md'`: implementations are `usePluginBranches` and the SDK test harness (`packages/plugin-sdk/src/testing/app.tsx:1669-1671`, defaults at 3230-3235, option type at 2337). The Ladle shim (`apps/app/.ladle/plugin-sdk-app.ts`) re-exports the app implementation, so it needs no edit. Other consumers are `plugins/environment-project-checkout/app.tsx:355` (does not need the new field), `apps/app/src/components/plugin/PluginBranchPicker.tsx:17`, the CLI bundling fixture `apps/cli/src/__tests__/packaged-plugin-build.test.ts:80-128`, and symbol lists in `plugins/plugin-api-docs/src/surfaces.ts:1263-1265` and `apps/server/test/services/plugins/plugin-authoring-docs.test.ts:819-821`. Adding a field breaks none of them.
- Docs that spell out the `BranchesState` shape: `plugins/omnyo-guide/skills/omnyo-plugin-authoring/references/frontend-components.md:125-128` and `docs/api_to_audit.md:1019-1026`.
- Distribution: `plugins/environment-git-worktree/package.json` is `"private": true` with `engines.omnyo >=0.0` and is not in `scripts/forkable-plugins.json`, so no fork or SDK-floor rule applies. Its plugin RPC is called only by its own app bundle, which the server ships together with `server.ts`, so removing the RPC cannot strand an older caller.

*Current requirement.* The trigger label needs a default base, and `BranchesState` did not expose one when the label was added. That requirement remains; only its data path changes.

**Proposed end state and preservation argument**

*What remains.* Core's `readProjectBranches` stays the only producer of the default base for every picker. `BranchesState` (`packages/plugin-sdk/src/app-contract.ts:3744-3749`) gains:

```ts
/**
 * The branch a new worktree starts from when the caller names none: the
 * origin default when the local default is equal or behind it, otherwise the
 * local default. Null when unknown, still loading or not a git repository.
 */
defaultBaseBranch: string | null;
```

`usePluginBranches` fills it from `branchesQuery.data?.defaultWorktreeBaseBranch` (null when disabled or without data). The SDK test harness defaults it to `null` and accepts it through `branchesState?: Partial<BranchesState>`. The Worktree app computes `baseBranchLabel = branchName ?? branchState.defaultBaseBranch ?? "default"`, and `updateOpen` keeps `void branchState.refresh().catch(() => undefined)`.

*What disappears.* The `defaultBaseBranch` entries in `worktreeRpcContract` and `worktreeHostContract`, their handlers, the `host.ts` imports used only by that handler, the app's `baseResult` state, effect, scoping check and `baseRefresh` counter, and the tests of that chain.

*Why semantics survive.*
- Label states: "default" before data arrives, when the source is missing, not a repository or offline; the resolved branch once data arrives; the named branch when one is picked; "Reuse: <path>" for an existing worktree. All four are unchanged.
- Stale results: today the app drops a late answer for a previous project or machine (`app.tsx:241-244`). After the change the query key includes project and host, and the placeholder function refuses previous data across a project or host change, so a previous answer is never shown.
- Refresh on open: today the plugin re-reads the default after `branchState.refresh()`. After the change `refreshFromRemote()` refetches through the blocking route, whose response carries a freshly computed `defaultWorktreeBaseBranch`.
- Typing in the search box changes the query key, but the placeholder keeps the previous response (including the default base) until the new one arrives, so the label does not flicker.
- Field naming: no `experimental_` prefix, matching `CheckoutState` and the existing `BranchesState` fields; the hook itself is the experimental surface.

*Behavior differences to accept or check (Hypothesis unless stated).*
- On mount the core route starts a background remote fetch; the plugin host read did not fetch. The label can therefore change to a newer value after that fetch lands and a realtime refetch happens. This matches what the core composer already shows.
- Core runs Git with the user's shell environment (`host-branches.ts:279-286`); the plugin host worker uses its own process environment. A repository whose Git setup depends on shell environment could resolve differently; this is the same environment the branch list already uses.
- A non-standard project makes the branches route return 404 (`requirePublicStandardProject`, `apps/server/src/services/lib/entity-lookup.ts:240-251`). The branch list is already empty there, and the label then shows "default".
- If a client app runtime is older than the server (and so lacks the new field), the label shows "default". The created worktree is unaffected because the server-side create path resolves the base itself.

*Non-goals.* Do not change `host/base-branch.ts` or the create path (ISS-S18-01), do not merge the two Git helper copies (RF-010), do not change `experimental_BranchPicker`, and do not touch `listExistingWorktrees`.

**Expected gain and cost**

Counts are from the snapshot line ranges cited above; post-change formatting may shift them by a line or two.

| Area | Removed | Added |
|---|---|---|
| `plugins/environment-git-worktree/app.tsx` | 33 (119-125, 200-217, 241-245, and 262-265 shrinking to one line) | 0 |
| `plugins/environment-git-worktree/server.ts` | 29 (56-64, 267-286) | 0 |
| `plugins/environment-git-worktree/host.ts` | 15 (5-8, 59-69) | 0 |
| `plugins/environment-git-worktree/contract.ts` | 4 (24-27) | 0 |
| `packages/plugin-sdk/src/app-contract.ts` | 0 | about 6 (field and doc comment) |
| `packages/plugin-sdk/src/testing/app.tsx` | 0 | 1 |
| `apps/app/src/components/plugin/usePluginBranchPickerState.ts` | 0 | about 2 (field and memo dependency) |
| **Handwritten production, net** | **about 81** | **about 9 → net about −72 (range −65 to −78)** |

Tests (separate): about −110 net. `server.test.ts:418-471` (54 lines) and `host.test.ts:874-896` (23 lines) go; `app.test.tsx` loses 8 mock lines and its 53-line "default branch label scope" block, replaced by about 20 lines; `usePluginBranchPickerState.test.tsx` gains about 8. Docs: about +2 lines.

Mechanisms: two fetch paths for one value become one. The plugin no longer owns a source-selection rule or a default-base rule. Performance: by inspection, one plugin server RPC, one `api.sdk.projects.get`, one host-worker RPC and the Git reads behind `readDefaultBranchRefs` (about five `git` processes) stop running on every mount and every open. The size of the latency gain is unmeasured.

**Execution steps**

1. **Reconfirm.** At the current base, rerun `git grep -n "defaultBaseBranch" -- . ':!plugins/environment-git-worktree'` and `git grep -n -e BranchesState -e experimental_useBranches -- ':!*.md'`. Re-plan if any new caller of the plugin RPC appears, if `BranchesState` gained another implementer (for example a mobile runtime), if `readProjectBranches` no longer returns `defaultWorktreeBaseBranch`, or if RF-010 has already merged the Git helpers in a way that changes `resolveDefaultWorktreeBaseBranch`. If RF-010 has landed, remove its reference to `host.test.ts:874` in the same change.
2. **SDK type.** In `packages/plugin-sdk/src/app-contract.ts`, add `defaultBaseBranch: string | null` with the doc comment above to `BranchesState`.
3. **SDK harness.** In `packages/plugin-sdk/src/testing/app.tsx` (defaults near line 3230), add `defaultBaseBranch: options.branchesState?.defaultBaseBranch ?? null`. The option type at line 2337 already accepts it through `Partial<BranchesState>`.
4. **App implementation.** In `apps/app/src/components/plugin/usePluginBranchPickerState.ts` `usePluginBranches`, add `defaultBaseBranch: enabled ? (branchesQuery.data?.defaultWorktreeBaseBranch ?? null) : null` to the returned object and `branchesQuery.data?.defaultWorktreeBaseBranch` to the `useMemo` dependencies. Add one case to `usePluginBranchPickerState.test.tsx` that resolves `BRANCHES` with `defaultWorktreeBaseBranch: "origin/main"` and expects `result.current.defaultBaseBranch` to be `"origin/main"`, and one that expects `null` when `projectId` is null. Update the `usePluginBranches` mock in `PluginBranchPicker.test.tsx` only if typecheck requires the new field.
   *Checkpoint:* `@omnyo/plugin-sdk` typecheck and the app hook tests pass (commands below).
5. **Worktree app.** In `plugins/environment-git-worktree/app.tsx` `WorktreeInputsControl`: delete `baseResult`/`setBaseResult` and `baseRefresh`/`setBaseRefresh` (119-125), the `defaultBaseBranch` effect (200-216), and `defaultBase` (241-244). Set `const baseBranchLabel = branchName ?? branchState.defaultBaseBranch ?? "default";`. In `updateOpen`, replace the `.then(() => setBaseRefresh(…))` chain with `void branchState.refresh().catch(() => undefined);`. Keep `useRpc` (still used by `listExistingWorktrees`) and every React import that is still used.
6. **Worktree server and host.** Delete `defaultBaseBranch` from `worktreeRpcContract` (`server.ts:56-64`) and its handler (`server.ts:267-286`). Delete `defaultBaseBranch` from `worktreeHostContract` (`contract.ts:24-27`), its handler (`host.ts:59-69`), and the now-unused `readDefaultBranchRefs`/`resolveDefaultBaseBranch` import (`host.ts:5-8`). Leave `host/base-branch.ts` untouched.
7. **Tests.** In `app.test.tsx`, remove the five `defaultBaseBranch` RPC mocks and replace the "default branch label scope" block (390-442) with: (a) `branchesState: { defaultBaseBranch: "origin/main" }` shows `Branch from:origin/main`; (b) `defaultBaseBranch: null` shows `Branch from:default`; (c) a named branch value shows the name even when `defaultBaseBranch` is set; (d) no call reaches `onChange` other than the mount default and no `listExistingWorktrees` call occurs before the user picks "Existing worktree". Delete `server.test.ts` "default branch label routing" (418-471) and `host.test.ts` "resolves the default label from the same refs used for creation" (874-895). Its obligation (the rule's equal/behind/ahead cases) is covered by `apps/server/test/services/worktree-base-branch.test.ts`; at the snapshot it covers missing origin, equal, local-behind, local-ahead, diverged and unknown; reconfirm before deleting.
8. **Docs.** Add `defaultBaseBranch` to the result list in `plugins/omnyo-guide/skills/omnyo-plugin-authoring/references/frontend-components.md:125-128` and in `docs/api_to_audit.md:1019-1022`, with one sentence: the host computes the default worktree base for the same project source.
9. **Review.** Inspect the full diff for leftover `defaultBaseBranch` RPC references (`git grep -n '"defaultBaseBranch"'` should find nothing), unrelated changes and formatting churn. Recount production lines against the table above.

**Verification and acceptance criteria**

Commands were read from the snapshot's `package.json` files and `turbo.json`; none were run in this audit. Run from `$OMNYO_CHECKOUT` (or the lane's root) after `pnpm install`.

- `pnpm turbo run typecheck --filter=@omnyo/plugin-sdk --filter=@omnyo/app --filter=omnyo-plugin-environment-git-worktree` — the plugin's typecheck depends on `@omnyo/plugin-sdk#build:types` (`turbo.json:1231-1233`), which turbo runs first. Expected: no errors.
- `pnpm --filter omnyo-plugin-environment-git-worktree test` (script `vitest run --config vitest.config.ts`; vitest resolves the SDK through its `source` condition, so no SDK build is needed). Expected: all app, server and host tests pass, with the new label cases.
- `pnpm --filter @omnyo/app exec vitest run --config vitest.config.ts src/components/plugin/usePluginBranchPickerState.test.tsx src/components/plugin/PluginBranchPicker.test.tsx src/components/plugin/PluginNewThreadComposer.test.tsx` — expected: pass, including the new `defaultBaseBranch` cases.
- `pnpm --filter @omnyo/plugin-sdk test` — expected: pass (harness change).
- `pnpm --filter @omnyo/server exec vitest run --config vitest.config.ts test/services/worktree-base-branch.test.ts test/services/plugins/plugin-authoring-docs.test.ts` — the package `@omnyo/server` runs `vitest run --config vitest.config.ts`. Expected: pass; the first file already covers missing-origin, equal, local-behind, local-ahead, diverged and unknown relations, so it replaces the deleted host test's rule coverage.
- `pnpm --filter omnyo-plugin-omnyo-guide test` — the guide plugin owns the edited reference doc.
- Lint and format for touched files: `pnpm exec oxlint --deny-warnings <files>` and `pnpm exec oxfmt --check <files>` (root `format:check` is `oxfmt . --check`).

Behavioral acceptance (Alex tests UI changes himself; list these for him):
- Open the new-chat screen with the Worktree environment on a repository whose local `main` equals `origin/main`: the trigger reads "Branch from: origin/main". Commit locally so `main` is ahead, reopen the picker: it reads "Branch from: main" after the refresh.
- Switch machine and then project while a slow host is answering: the trigger shows "default" and then the new source's value, never the previous one.
- Pick a named branch, then an existing worktree: the trigger shows the name, then "Reuse: <path>".
- In the browser network panel, opening the picker no longer issues a plugin RPC named `defaultBaseBranch`.

**Rollback and stop conditions**

- Rollback: revert the single commit. No persisted data, migration, setting key or stored input format changes (`worktreeInputsSchema` is untouched), so a revert is complete.
- Stop and re-plan if: the label shows a different branch from the one the core composer shows for the same project and machine; the label shows a previous project's or machine's value after a switch; `BranchesState` turns out to have another implementer that cannot supply the value; or a caller of the plugin `defaultBaseBranch` RPC exists outside the plugin.
- Do not fix ISS-S18-01 or merge Git helpers (RF-010) in this change; if either becomes necessary, land it separately.
