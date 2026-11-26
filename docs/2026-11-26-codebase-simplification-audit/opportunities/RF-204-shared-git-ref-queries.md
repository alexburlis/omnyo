# RF-204 — Share default-branch and ref-relation policy through the existing query factory

## Rank and disposition

- **Potential** Moderate to high. One owner maintains host workspace and environment-provider ref policy. Server-lane impact rank 5, execution order 4.
- **Confidence/readiness** High for duplicate policy, medium for exact removal. Ready after the paired-entry-point fixture baseline.
- **Effort/risk** Medium, approximately 1–2 days with real local Git fixtures. Medium risk to branch selection, merge bases and plugin provisioning.
- **Dependencies** None. Preserve standalone plugin/SDK boundaries. Do not combine this with process-runner or lock redesign.

## Context and evidence

Snapshot `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e`. `packages/host-workspace/src/git.ts` and `packages/environment-provider-host/src/git.ts` both inject their `runGit` and `WorkspaceError` into `environment-provider-host/src/git-queries.ts::createGitQueries`, which already owns common repo detection, common-dir and current-branch queries.

Yet both implementations separately maintain `resolvePreferredLocalDefaultBranch`, local/origin branch reads, `hasRef`, `revParseRef`, `isAncestorRef`, default-ref selection and ahead/behind classification. The public provider `readBranchRelation` and host private `readDefaultBranchRelation` have the same state mapping: missing inputs → undefined. Missing commit refs → unknown. Equal SHA → equal. Ancestor checks → behind/ahead/diverged, with unexpected merge-base exit → unknown. Both SHA reads already start together. Keep this concurrency.

Real consumers include host `command-handlers/host-branches.ts::listHostBranchOptions`, `host-workspace/src/provision.ts`, `plugins/environment-git-worktree/host.ts`, `host/base-branch.ts`, `host/worktree.ts`, and `plugins/environment-temporary-copy/host/copy.ts`. The caller search covered these packages/apps/plugins. `packages/host-workspace/test/git.refs.test.ts` exercises equal/behind/ahead/diverged/no-origin and contains real local Git fixtures.

Counterevidence narrows the earlier audit: host `readRepoDefaultBranch` now uses one `for-each-ref` call to read origin HEAD and local heads together. Provider `readDefaultBranch` still uses symbolic-ref and local branch calls. The host runner supports output caps/streaming and uses process-utils. The provider runner uses the public plugin SDK host API and distinct cancellation/error handling. These runners and their fast paths are not interchangeable. Do not erase the host optimization by moving the older provider query wholesale.

## Proposed end state and preservation argument

Extend the existing `createGitQueries` owner with the common ref helpers, `readBranchRelation` and `readDefaultBranchRefs`. Export shared `DefaultBranchRelation`/`DefaultBranchRefs` shapes there, so the provider does not need to import a private domain package. The host can assign that structural type to its existing domain/API shape without a new dependency edge. Keep the current public host/provider function names through direct delegation, including the provider's exported `readBranchRelation`.

Share the pure default-preference and origin-symbolic-ref parser as small named exports used by the host's existing combined `readRepoDefaultBranch` and the provider's query implementation. Preserve the current command sequences for the simple default readers in this card. Changing query batching/parallelism independently would need a separately measured performance change. Keep command options/timeout/signal forwarding, error constructor and runner ownership injected. Preserve public exports and package `./git-queries` surface.

The maintained policy is then one set of branch preference/ref-relation decisions with two transport adapters. No fetch, remote lookup, branch mutation, lock change, provider fallback, persisted format or UI behavior is added. Local-only origin refs remain local-only. Preserve custom default/main/master/first-local ordering and existing unknown/error outcomes.

## Expected gain and cost

The duplicate source clusters occupy parts of host lines approximately 1124–1400 and provider lines 314–610. Unrelated functions within those ranges are excluded. Projected deletion is 320–400 production lines, addition to the existing factory/pure exports 190–240 lines, for **80–210 net lines removed**. Shared tests may add 60–130 lines. Caller smoke coverage stays in each plugin. Moving a function once is not counted as deletion: the saving is the second maintained copy. No dependency/config/generated savings are assumed.

A branch-preference or relation fix would change one implementation and one common matrix, with adapter tests preserving each runner's errors/options. Runtime is expected to remain similar only if query sequences remain equal. Verify that hypothesis through invocation counts and timings. Runtime speed remains unmeasured.

## Execution steps

1. Reconfirm duplicate bodies and exports/callers. Stop if policies now intentionally differ or a fork consumes an incompatible published `git-queries` contract.
2. Add a paired fixture in the existing host-workspace Git tests that invokes both public modules on the same local repositories. Cover empty/unborn and bare repositories, main/master/custom defaults, missing/stale origin HEAD, missing origin refs, equal/behind/ahead/diverged/unrelated histories, invalid refs and controlled nonstandard Git exit codes. Use only filesystem remotes. Capture error codes plus default/ref results and command counts.
3. Add shared relation/default-ref query implementations to `git-queries.ts`, retaining simultaneous SHA queries, sequential dependent ancestry checks and unchanged option forwarding. Return their functions from `createGitQueries`. Keep `ensureGitRepo` checks at the same public boundaries.
4. Delegate host/provider public entry points and remove private duplicate implementations. Keep host `readRepoDefaultBranch`'s one-call scan. Use shared pure parsing/preference functions there. Re-export provider types from the common owner while preserving names. Do not move the host process runner or its error class into the plugin package.
5. Run paired behavior/options tests, existing Git/ref/admission tests and affected plugin host tests. Remove stale imports/types and confirm no caller reaches the old copies. Recount actual production reduction and inspect dependency/package export changes.

## Verification and acceptance

From repository root with existing dependencies:

```sh
pnpm --filter @omnyo/host-workspace test test/git.refs.test.ts test/git.test.ts test/git-admission.test.ts test/git-ref-mutation-lock.test.ts
pnpm --filter omnyo-plugin-environment-git-worktree test host.test.ts host/worktree-list.test.ts
pnpm --filter omnyo-plugin-environment-temporary-copy test host/copy.test.ts
pnpm --filter @omnyo/host-workspace typecheck
pnpm --filter omnyo-environment-provider-host typecheck
```

Package scripts and test paths are inspected. **Commands were not run** because the audit has no dependencies. Reconfirm plugin manifest package names before invoking filters on a newer snapshot. Tests must preserve the actual public defaults/relation results, runner errors, timeout/signal forwarding and absence of remote network I/O. Keep host admission/ref-lock tests even though lock code is unchanged: the injected runners must retain their existing scheduler/lock path.

Compare Git invocation count and local elapsed/CPU on identical representative repos before/after if claiming neutral or better performance. The host simple default reader must retain its single scan. No full UI redraw is needed for a query refactor. Branch-picker and provisioning response equality are required. If a fork/package export is changed, run the repository's existing packed-SDK/fork check under its documented prerequisites. Typechecking the monorepo alone does not establish standalone compatibility.

Structural acceptance: one preference policy, one ref-relation algorithm, existing public signatures, two unchanged runners and no new runtime dependency on private host internals.

## Rollback and stop conditions

No schema/data migration. Revert only the implementing source/test commit or exact owned edits. Do not reset the shared worktree. Stop for intentional policy divergence, a standalone-fork contract gap, changed error/option behavior, added Git invocations, lost parallel SHA reads or a repeatable performance regression. The smaller alternative is sharing only the pure policy functions. Do not add per-caller policy switches to preserve an overbroad extraction.
