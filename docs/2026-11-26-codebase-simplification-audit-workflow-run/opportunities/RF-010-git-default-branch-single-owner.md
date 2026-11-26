# RF-010 — Move the duplicated Git default-branch rules (local default, origin default, ahead/behind relation) out of `host-workspace/src/git.ts` and into the shared `createGitQueries` factory

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The central duplication is real and byte-identical, but the sweep reports overstated the scope in three ways. First, unifying the two `WorkspaceError` classes changes `instanceof` behaviour inside the host daemon, so it is not part of this card. Second, `listBranchRefsWithDefaults` already calls the shared preference rule and is not a separate re-implementation. Third, the server's copy of the base-branch choice cannot move without a new package dependency edge, so it is an optional step that needs an owner decision.
- **Potential:** medium. One rule that three product surfaces must agree on gets one implementation, and about 150 to 185 handwritten non-blank production lines are deleted.
- **Confidence:** high. The identical ranges were proven with `cmp`, and every consumer was found with `git grep -w`.
- **Readiness:** ready for steps 1 to 4. Step 5 (the server copy) is decision-needed. Step 6 (one `readDefaultBranch`) is optional and gated.
- **Effort:** about half a day for a mechanical move, plus a typecheck and the existing focused tests. Add an hour if the optional parity test is written.
- **Risk:** low. The rules move unchanged and keep the call order, so the same Git processes run. The realistic regressions are type drift between the factory's `DefaultBranchRelation` and the one in `@omnyo/domain`, and a runner-option mismatch. Both surface at typecheck.
- **Prerequisites:** none.
- **Related and overlapping opportunities:**
  - RF-062 (share checkout-ref, git-operation and dirty-state inspection through `createGitQueries`) edits the same three files. Run RF-010 and RF-062 one after the other, not in parallel. Their savings do not overlap.
  - RF-066 (let the worktree picker read the default base from the core branches query) may remove the plugin `defaultBaseBranch` handler at `plugins/environment-git-worktree/host.ts:58-69`. It does not remove the provisioning uses of `resolveDefaultBaseBranch`, so this card stays valid either way. RF-066 is the natural place to decide the server copy (step 5).
  - RF-130 (one `git worktree` porcelain parser in environment-provider-host) touches `findWorktreeForBranch` in the same provider file. That code is disjoint from this card.
  - ISS-S10-05 (duplicate Git spawns, such as `ensureGitRepo` on every `hasRef`) is a separate performance follow-up. This card deliberately keeps the process count unchanged.
- **Why it deserves its place:** the branch picker (host daemon), new worktrees and temporary copies (plugin host workers) must report the same default branch and the same local-versus-origin relation. Today that rule exists as two hand-maintained copies that nothing forces to stay equal. The fix reuses a factory both packages already call, so it adds no new layer.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The snapshot worktree named in the audit brief was already gone when this card was written, so every file was read with `git show e9e1b74c…:<path>` from `$OMNYO_CHECKOUT`. The snapshot has no `node_modules`, so no test or typecheck was run. Every claim below is **Proven by inspection** unless it is labelled otherwise.

*The subsystem.* Omnyo needs to know which branch counts as a repository's default and whether the local copy is behind its origin counterpart. There are two Git helper packages:

- `packages/host-workspace` (`@omnyo/host-workspace`) is used by the host daemon. Its runner is `runGit`, built on `@omnyo/process-utils` (execFile, `maxBufferBytes`, `onStderr`).
- `packages/environment-provider-host` (`omnyo-environment-provider-host`) is used by environment plugin host workers. Its runner is `runGit`, built on the plugin SDK's `experimental_runVcsProcess` and `experimental_spawnPortableOutputProcess` (spawn, a 16 MB output cap, process-group kill).

The two runners are deliberately separate and stay separate. Both packages already build their read-only queries through one factory, `packages/environment-provider-host/src/git-queries.ts:28` `createGitQueries(runGit, WorkspaceError)`. That factory is dependency-free apart from `node:path` and is exported as `omnyo-environment-provider-host/git-queries` (`packages/environment-provider-host/package.json` `exports["./git-queries"]`). The callers are `packages/host-workspace/src/git.ts:565-572` and `packages/environment-provider-host/src/git.ts:291-295`. `@omnyo/host-workspace` already lists `omnyo-environment-provider-host` as a dependency (`packages/host-workspace/package.json`).

*The duplicated code.* Each range was extracted with `sed -n`, the leading `export ` was stripped, `readDefaultBranchRelation` was renamed to `readBranchRelation`, and the results were compared with `cmp`:

| Function | `environment-provider-host/src/git.ts` | `host-workspace/src/git.ts` | Result |
|---|---|---|---|
| `readLocalBranches` | 313-326 | 1170-1183 | identical (14 lines) |
| `hasRef` | 345-359 (exported) | 1229-1243 (exported) | identical (15) |
| `resolvePreferredLocalDefaultBranch` | 389-409 | 1185-1205 | identical (21) |
| `readOriginDefaultBranch`, `revParseRef`, `isAncestorRef`, `readBranchRelation` / `readDefaultBranchRelation` | 429-550 | 1245-1366 | identical after the rename (122) |
| `readDefaultBranchRefs` | 579-610 | 1368-1399 | identical (32) |
| `readOriginHeadBranchName` | 411-427 (inline parse) | 1207-1227 (`parseOriginHeadBranchName` + reader) | equivalent; host extracted the parse step |

The types are duplicated too. `DefaultBranchRelation` and `DefaultBranchRefs` are at provider `git.ts:38-49`. The host has `interface DefaultBranchRefs` at `host-workspace/src/git.ts:69-73`, which uses `DefaultBranchRelation` from `@omnyo/domain` (`packages/domain/src/git-checkout.ts:115-123`, the same five-value union). `trimOutput` is the same three-line helper in both files (provider `git.ts:56`, host `git.ts:148`).

There is also a pure base-branch choice. Provider `git.ts:552-577` `resolveDefaultBaseBranch` has the same logic as `apps/server/src/services/projects/worktree-base-branch.ts:9-28` `resolveDefaultWorktreeBaseBranch`. Only the argument types differ: the server uses `GitSourceInspection` from `@omnyo/domain`.

*`readDefaultBranch` is not duplicated.* The host version, `host-workspace/src/git.ts:1124-1168` (`readDefaultBranch` → `readRepoDefaultBranch`), runs one `git for-each-ref` over `refs/remotes/origin/HEAD` and `refs/heads`. The provider version, `git.ts:328-343`, runs `symbolic-ref` and then `for-each-ref`. Both apply origin HEAD first and then the shared preference rule, and they agree by inspection for a missing, non-symbolic or dangling origin HEAD. The test at `packages/host-workspace/test/status-process.e2e.ts:276-283` asserts that the host variant returns `"missing"` for a dangling origin HEAD. Their process counts differ, so step 6 is optional.

*`listBranchRefsWithDefaults` is not a re-implementation.* `host-workspace/src/git.ts:1728-1757` already calls `resolvePreferredLocalDefaultBranch` and `readOriginHeadBranchName`. It picks the origin default from the remote refs it has already listed, so it avoids extra `show-ref` processes for the branch picker. It stays as it is and only imports the moved helpers.

*Consumers.* These were found with `git grep -n -w -E "readDefaultBranch|hasRef|readDefaultBranchRefs|resolveDefaultBaseBranch|readBranchRelation|readRepoDefaultBranch|listBranchRefsWithDefaults|resolveDefaultWorktreeBaseBranch" e9e1b74c… -- ':!*.md'` over the whole repository:

- Host daemon: `apps/host-daemon/src/command-handlers/host-branches.ts:203` uses `listBranchRefsWithDefaults` (branch options), and `:311` uses `readDefaultBranchRefs` (the `host.inspect`-style result that carries `defaultBranch`, `defaultBranchRelation` and `originDefaultBranch`). Both come through `packages/host-workspace/src/index.ts:25-26`.
- host-workspace internal: `packages/host-workspace/src/provision.ts:121` uses `readDefaultBranch`, and `packages/host-workspace/src/workspace.ts:726` uses `readRepoDefaultBranch`. The host `hasRef` export has no consumer outside `git.ts`.
- Plugins, through `omnyo-environment-provider-host/git`:
  - `plugins/environment-git-worktree/host.ts:60-69`: `readDefaultBranchRefs` and `resolveDefaultBaseBranch`.
  - `plugins/environment-git-worktree/host/base-branch.ts:1-79`: `hasRef`, `readBranchRelation`, `readDefaultBranchRefs` and `resolveDefaultBaseBranch`.
  - `plugins/environment-git-worktree/host/worktree.ts:644-653`: `hasRef` and `readDefaultBranch`.
  - `plugins/environment-temporary-copy/host/copy.ts:378-385`: `readDefaultBranchRefs` and `resolveDefaultBaseBranch`.
  - `plugins/environment-project-checkout/host/git.ts:70-74`: `hasRef`.
- Server: `apps/server/src/routes/projects.ts:967` and `apps/server/src/services/threads/thread-default-policy.ts:356` use `resolveDefaultWorktreeBaseBranch` on the daemon's inspection result.
- Mocks: `plugins/environment-project-checkout/host/git.test.ts:5` replaces the whole `omnyo-environment-provider-host/git` module with `vi.mock`. Moving the implementation behind the same export names does not affect it.
- Non-obvious consumers checked:
  - Built plugin bundles: none are committed. `git grep -l resolvePreferredLocalDefaultBranch` returns only the two source files. Plugins bundle `omnyo-environment-provider-host` at build time.
  - Forkability: `scripts/forkable-plugins.json` does not list `environment-git-worktree`, `environment-temporary-copy` or `environment-project-checkout`. `packages/scripts/test/plugin-forks.test.mjs:254-270` shows that a forkable plugin may not import `omnyo-environment-provider-host/*` at all. Neither fact changes here.
  - Public SDK: neither package is the packed plugin SDK, and no SDK export is touched.
  - Persisted data: the computed values are not stored. They are returned over RPC as `defaultBranch`, `defaultBranchRelation` and `originDefaultBranch`, and that shape is unchanged.

*Tests that encode the contract.*

- `packages/host-workspace/test/git.refs.test.ts:23-83` covers `readDefaultBranchRefs`: equal, local-behind, local-ahead, diverged and no-origin.
- `plugins/environment-git-worktree/host.test.ts:874-895` covers the default base through `main`, then `origin/main` when equal, then `main` when local is ahead.
- `apps/server/test/services/worktree-base-branch.test.ts` covers the server copy.
- `apps/host-daemon/test/command/host-branches-dispatch.test.ts:212-444` checks the RPC result shape.
- `packages/host-workspace/test/status-process.e2e.ts:276-369` covers dangling origin HEAD, a non-repository and a bare repository for `readDefaultBranch`. It is matched by no vitest `include` (`packages/host-workspace/vitest.config.ts` includes only `test/**/*.test.ts`), and no script that runs it was found, so its runner is unconfirmed.
- `environment-provider-host` has no tests of its own.

*Counterevidence that was checked and narrows the scope.*

- **`WorkspaceError` unification is excluded.** The two classes (host `git.ts:35-42`, provider `git.ts:19-26`) are structurally identical. Inside the daemon, however, `apps/host-daemon/src/environment-lifecycle-script.ts:23` throws the provider class (`setup_script_failed` at lines 70, 178 and 385), and several daemon modules branch on `instanceof WorkspaceError` of the host class: `command-dispatch.ts:169`, `workspace-resolution.ts:79`, `command-handlers/project.ts:121` and `command-handlers/file-read.ts:326`. With one class, errors that do not match those checks today would start to match, which is a behaviour change. The gain is about 7 lines, so the change does not belong in a structural refactor.
- **The server copy is excluded from the ready part.** `apps/server/package.json` depends on neither host package, and `omnyo-environment-provider-host` does not depend on `@omnyo/domain`. Sharing the function therefore needs a new dependency edge (step 5).

*The maintenance cost today.* Changing how the default is chosen needs the same edit in `host-workspace/src/git.ts` and `environment-provider-host/src/git.ts`, and also in the server file if the base choice changes. Examples are preferring `trunk`, honouring `init.defaultBranch`, or treating a stale origin HEAD differently. If one edit is missed, the branch picker shows one default while a new worktree or temporary copy starts from another. Nothing fails at build time, because the copies are independent private functions.

**Proposed end state and preservation argument**

- **Canonical owner:** `packages/environment-provider-host/src/git-queries.ts`.
- **Pure top-level exports:** `trimOutput` (module-private), `parseOriginHeadBranchName`, `resolvePreferredLocalDefaultBranch`, `resolveDefaultBaseBranch` with `ResolveDefaultBaseBranchArgs`, and the types `DefaultBranchRelation` and `DefaultBranchRefs`.
- **Inside the `createGitQueries` closure,** built on the injected `runGit` and the existing `ensureGitRepo`: `readLocalBranches`, `readOriginHeadBranchName`, `hasRef`, `readOriginDefaultBranch`, `revParseRef`, `isAncestorRef`, `readBranchRelation` and `readDefaultBranchRefs`. The returned object gains `readLocalBranches`, `readOriginHeadBranchName`, `hasRef`, `readBranchRelation` and `readDefaultBranchRefs`. The other helpers stay private to the closure.
- **What disappears:** the host copies at `host-workspace/src/git.ts:1170-1399` and the host `interface DefaultBranchRefs` at lines 69-73. The provider copies move rather than disappear: they leave `git.ts` for `git-queries.ts`.
- **What remains:**
  - Each package keeps its own `runGit`, deadlines, output caps, cancellation codes and error mapping.
  - Each package keeps its own `WorkspaceError` class and its own `readDefaultBranch`, unless step 6 is approved.
  - host-workspace keeps `readRepoDefaultBranch` and `listBranchRefsWithDefaults`, which now import the shared helpers.
  - The server keeps `resolveDefaultWorktreeBaseBranch` unless step 5 is decided.
- **Public names stay the same.** Provider `git.ts` re-exports `hasRef`, `readBranchRelation`, `readDefaultBranchRefs`, `resolveDefaultBaseBranch`, `ResolveDefaultBaseBranchArgs`, `DefaultBranchRelation` and `DefaultBranchRefs`. Host `git.ts` re-exports `hasRef` and `readDefaultBranchRefs`. No import in any plugin, daemon or test file changes.
- **Dependency direction:** unchanged. host-workspace → environment-provider-host already exists.
- **Why semantics survive:**
  - The code moves verbatim, already byte-identical, so the same Git commands run in the same order with the same `allowFailure` flags.
  - `readBranchRelation` keeps its `Promise.all` over the two `revParseRef` calls.
  - `hasRef` keeps calling `ensureGitRepo`.
  - `GitQueryRunner` (`git-queries.ts:19-26`) already accepts `cwd`, `allowFailure`, `signal`, `shellPath` and `timeoutMs`, which are the only options these functions pass.
  - Errors still come from each package's own runner (`git_command_failed`, `provision_cancelled`) and from `ensureGitRepo` (`not_git_repo`), which already uses the injected class.
- **Known behaviour kept on purpose:** `ensureGitRepo` runs on every `hasRef` call, so `readDefaultBranchRefs` spawns up to two redundant `rev-parse` processes (ISS-S10-05). It is not fixed here.
- **Simplest sufficient option:** the factory is already the shared route for both packages. A third package would add a layer, and moving the rules into `@omnyo/domain` would add a `domain` dependency to a plugin-bundled package.
- **Non-goals:** changing the selection rule, changing the remote refresh in `host-branches.ts`, merging the two runners, unifying `WorkspaceError`, and changing process counts.

**Expected gain and cost**

All counts below are physical lines from `sed -n … | wc -l` and non-blank lines from `grep -cv '^\s*$'`, measured at the snapshot. Figures marked "projected" are estimates.

- **Deleted from `host-workspace/src/git.ts`** (handwritten production code): 230 lines (189 non-blank) at 1170-1399, plus 5 lines for `interface DefaultBranchRefs`.
- **Moved, not counted as savings:** 219 non-blank provider lines, from provider `git.ts` 38-49, 313-326, 345-359 and 389-610 (excluding `findWorktreeForBranch` at 361-387), into `git-queries.ts`.
- **Added (projected):** about 12 non-blank lines of re-export wiring in each `git.ts`, and 3 for `trimOutput` in `git-queries.ts`.
- **Net (projected):** about 150 to 185 fewer non-blank production lines, or about 185 to 215 physical lines.
- **Optional step 6 (projected):** about 14 more non-blank lines, the provider `readDefaultBranch` body.
- **Optional step 5 (projected):** about 20 more lines, the server copy.
- **Tests:** none are deleted. An optional parity test adds about 30 to 50 test lines.
- **Mechanisms:**
  - Before: 2 independent implementations of the default-branch, origin-default and relation rules, 2 `DefaultBranchRefs` declarations, and 3 copies of the base-branch choice.
  - After: 1 implementation and 1 type declaration, plus 2 copies of the base-branch choice (1 if step 5 is done).
- **Maintenance:** changing the default preference becomes one edit in `git-queries.ts`, covered by the existing tests in `git.refs.test.ts` and the plugin `host.test.ts`. Today the same change needs two matching edits.
- **Performance:** neutral by construction, because the same commands run in the same order. This is not measured. Step 6 would reduce provider `readDefaultBranch` from about three processes to about two. That is a hypothesis until it is measured, and it is optional.
- **Cost and tradeoff:** `git-queries.ts` grows from 141 to about 365 lines. The factory now owns a policy (which branch counts as the default) as well as plumbing. The plan accepts this because both callers need exactly that policy.

**Execution steps**

1. **Reconfirm the baseline.** In a fresh worktree of current `main`:
   - Check that the ranges above still hold. Run `git grep -n "async function readDefaultBranchRefs" -- packages`, then repeat the `cmp` comparison: extract each range with `sed -n`, strip `export `, rename `readDefaultBranchRelation` to `readBranchRelation`, and compare.
   - Re-run the consumer `git grep -w` from Context.
   - Check `git log --oneline -5 -- packages/environment-provider-host/src packages/host-workspace/src/git.ts` for landed work from RF-062 or RF-130, and rebase this plan onto it.
   - **Stop and re-plan** if the two copies now differ in substance, because someone has intentionally diverged them. Also stop if a new consumer imports a host-private helper.
2. **Checkpoint A: add to the factory without changing callers.** In `packages/environment-provider-host/src/git-queries.ts`:
   - Copy in, verbatim from provider `git.ts`, `DefaultBranchRelation` and `DefaultBranchRefs` (38-49) and `ResolveDefaultBaseBranchArgs` with `resolveDefaultBaseBranch` (552-577), as top-level exports.
   - Add a module-private `trimOutput` (identical to provider `git.ts:56-58`).
   - Add top-level exported pure functions: `parseOriginHeadBranchName(output: string): string | undefined` (from host `git.ts:1207-1215`) and `resolvePreferredLocalDefaultBranch` (provider 389-409).
   - Inside `createGitQueries`, after `getCurrentBranch`, add `readLocalBranches` (313-326), `readOriginHeadBranchName` (host 1217-1227, which calls `parseOriginHeadBranchName`), `hasRef` (345-359), `readOriginDefaultBranch`, `revParseRef`, `isAncestorRef` and `readBranchRelation` (429-550), and `readDefaultBranchRefs` (579-610).
   - Add `readLocalBranches`, `readOriginHeadBranchName`, `hasRef`, `readBranchRelation` and `readDefaultBranchRefs` to the returned object.
   - Do not import `@omnyo/domain`.
3. **Checkpoint B: switch the provider package.** In `packages/environment-provider-host/src/git.ts`:
   - Delete lines 38-49, 313-326, 345-359, 389-550 and 552-610, keeping `findWorktreeForBranch` (361-387).
   - Extend the destructuring at 291-295 to `export const { getGitCommonDir, detectGitRepo, getCurrentBranch, hasRef, readBranchRelation, readDefaultBranchRefs } = gitQueries;` and `const { detectGitSource, ensureGitRepo, readLocalBranches, readOriginHeadBranchName } = gitQueries;`.
   - Add `export { resolveDefaultBaseBranch, resolvePreferredLocalDefaultBranch } from "./git-queries.js";` and `export type { DefaultBranchRelation, DefaultBranchRefs, ResolveDefaultBaseBranchArgs } from "./git-queries.js";`. Only export `resolvePreferredLocalDefaultBranch` if `readDefaultBranch` needs it. Otherwise import it without re-exporting.
   - Keep `readDefaultBranch` (328-343). It now uses the destructured `readOriginHeadBranchName` and `readLocalBranches` and the imported `resolvePreferredLocalDefaultBranch`.
   - `trimOutput` stays in `git.ts`, because `readGitRepositoryState` and the runner use it.
   - Run `pnpm --filter omnyo-environment-provider-host typecheck`, then the plugin checks in Verification.
4. **Checkpoint C: switch host-workspace.** In `packages/host-workspace/src/git.ts`:
   - Delete 1170-1399 and `interface DefaultBranchRefs` (69-73).
   - Change the destructuring at 565-572 to also export `hasRef` and `readDefaultBranchRefs` and to bind (unexported) `readLocalBranches` and `readOriginHeadBranchName`.
   - Import `parseOriginHeadBranchName` and `resolvePreferredLocalDefaultBranch` from `omnyo-environment-provider-host/git-queries`.
   - `readRepoDefaultBranch` (1133-1168), `listBranches` (1697-1704) and `listBranchRefsWithDefaults` (1728-1757) keep their bodies and call the imported or destructured helpers.
   - The `@omnyo/domain` `DefaultBranchRelation` import at line 7 becomes unused here unless other code uses it. Remove it only if `tsc` and `oxlint` report it unused.
   - The `export const {…} = createGitQueries(…)` at line 565 sits above `readRepoDefaultBranch` in the file, so the bindings exist before the function bodies run. Check that no module-top-level code calls these helpers before line 565.
   - Run the host-workspace and host-daemon checks.
5. **Optional and decision-needed: the server base-branch copy.** Choose one of these:
   - (a) Leave `apps/server/src/services/projects/worktree-base-branch.ts` as it is. This is the default. Note that RF-066 may later make the server value the only one the picker shows.
   - (b) Add `omnyo-environment-provider-host` as an `apps/server` dependency (`pnpm install` updates the lockfile) and replace the body with an adapter that calls `resolveDefaultBaseBranch`. This adds a server → host-package edge.
   - (c) Move the pure function to `packages/domain/src/git-checkout.ts` next to `DefaultBranchRelation`, and add `@omnyo/domain` to `omnyo-environment-provider-host`. This puts domain code into every environment plugin bundle.

   Do not choose (b) or (c) without the owner's decision. Keep `apps/server/test/services/worktree-base-branch.test.ts` unchanged under any option.
6. **Optional and gated: one `readDefaultBranch`.** Move the host `readRepoDefaultBranch` (single `for-each-ref`) into the factory, and make both packages' `readDefaultBranch` call `ensureGitRepo` and then that function. The gate: a parity test (Verification) shows that both runners return the same value for no origin, a non-symbolic `refs/remotes/origin/HEAD`, a dangling origin HEAD, a bare clone, and an origin HEAD naming a branch with no local copy. Skip this step if any case differs.
7. **Clean up and recount.** Run `git grep -n "function resolvePreferredLocalDefaultBranch\|function readDefaultBranchRefs\|function isAncestorRef"`. Each must match only `git-queries.ts`. Recount with `git diff --stat` and a non-blank count of the deleted ranges, using the same method as in Expected gain. Inspect the full diff for unrelated edits. Format the changed files with the repository formatter.

**Verification and acceptance criteria**

Run from the repository root `$OMNYO_CHECKOUT`, or from the worktree. The script names come from each package's `package.json` at the snapshot. None of these commands were run for this card, because the snapshot has no `node_modules`.

- `pnpm --filter omnyo-environment-provider-host typecheck` (script `typecheck`: `tsc --noEmit`).
- `pnpm --filter @omnyo/host-workspace typecheck` and `pnpm --filter @omnyo/host-workspace lint` (script `lint`: `oxlint src`).
- `pnpm --filter @omnyo/host-workspace exec vitest run --config vitest.config.ts test/git.refs.test.ts test/git.test.ts test/provision.test.ts test/workspace.test.ts`. Expected result: the five `readDefaultBranchRefs` cases pass unchanged.
- `pnpm --filter @omnyo/host-daemon typecheck` and `pnpm --filter @omnyo/host-daemon exec vitest run --config vitest.config.ts test/command/host-branches-dispatch.test.ts`.
- `pnpm --filter omnyo-plugin-environment-git-worktree typecheck` and `pnpm --filter omnyo-plugin-environment-git-worktree exec vitest run --config vitest.config.ts host.test.ts`. Expected result: "resolves the default label from the same refs used for creation" (`host.test.ts:874`) passes.
- `pnpm --filter omnyo-plugin-environment-temporary-copy typecheck` and `pnpm --filter omnyo-plugin-environment-temporary-copy exec vitest run --config vitest.config.ts host/copy.test.ts`.
- `pnpm --filter omnyo-plugin-environment-project-checkout exec vitest run --config vitest.config.ts host/git.test.ts`. The package name `omnyo-plugin-environment-project-checkout` was confirmed in its `package.json` at the snapshot.
- If step 5 is executed: `pnpm --filter @omnyo/server exec vitest run --config vitest.config.ts test/services/worktree-base-branch.test.ts` and `pnpm --filter @omnyo/server typecheck`.
- Lint the changed files per the repository's Oxc setup (`pnpm exec oxlint --deny-warnings --format=agent <files>` from the root, per the global instructions).
- **Optional parity test** (recommended, and required for step 6): add it to `packages/host-workspace/test/git.refs.test.ts`, which already uses `git-test-repos.ts`. `packages/host-workspace/test/git-admission.test.ts:4` shows the package already imports the provider `runGit`. The test runs `readDefaultBranchRefs` imported from `omnyo-environment-provider-host/git` against the same fixtures as the host function and expects equal results. Add the fixtures that are missing today: a dangling `refs/remotes/origin/HEAD`, and an origin HEAD naming a branch with no local copy. Keep the existing host expectations as the independent baseline, and do not rewrite them.
- **Structural acceptance:**
  - Each moved function name has exactly one definition, in `git-queries.ts`.
  - `host-workspace/src/git.ts` no longer defines `DefaultBranchRefs`.
  - No import path in a plugin, daemon or test file changed.
  - The net non-blank reduction in handwritten production code falls within the projected range.
- **Performance:** the change is neutral by construction. Compare the Git argv sequence for `readDefaultBranchRefs` before and after, for example by wrapping `runGit` in the parity test to record `args`. It must be identical. No benchmark is needed unless step 6 is executed.

**Rollback and stop conditions**

- **Rollback:** each checkpoint (A, B, C) is one commit that can be reverted independently. A alone is additive. B and C each switch one package. No data, persisted format or RPC shape changes, so a revert has no compatibility consequence. Plugins pick up the change only with their next build, and reverting before that build ships nothing.
- **Stop if:**
  - The two copies have diverged in substance since the snapshot. Treat that as an intentional policy difference and ask the owner whether the plugins and the daemon should differ.
  - The factory would need caller-specific switches, such as one package needing `maxBufferBytes` or `onStderr` for these queries. Then keep the explicit copies.
  - Typecheck shows that `@omnyo/domain`'s `DefaultBranchRelation` no longer equals the factory union. Then reconcile the type first, as a separate change.
  - A recorded Git argv sequence differs.
  - `git.refs.test.ts` or the plugin `host.test.ts` fails in a way that is not a trivial import error.
- **Smaller alternative if stopped:** share only the pure `resolvePreferredLocalDefaultBranch` and `parseOriginHeadBranchName` from `git-queries.ts`. That removes about 30 lines and keeps the preference rule in one place, while the relation logic stays duplicated.
