# RF-130 — Replace the two newline-form `git worktree list --porcelain` parsers with git-worktree's NUL-safe parser, owned by environment-provider-host

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplication is real. The sweep overstated the net reduction, and it missed one fact: the git-worktree plugin uses both parsers itself.
- **Potential:** low to medium. One parser and one listing helper own all worktree-list knowledge for the three modules that share `omnyo-environment-provider-host`, and the newline-form parsing goes away.
- **Confidence:** high that the duplication exists and that the consolidation is safe. Medium on the exact line counts, which are projections.
- **Readiness:** ready. No owner decision is needed, and no plugin-forkability rule is crossed (see Context).
- **Effort:** small, about 2 to 4 hours including tests.
- **Risk:** low. The affected behaviors are branch-busy detection in temporary-copy, abandoned-attempt cleanup in git-worktree, origin-checkout detection in temporary-copy, and worktree adoption and removal checks in git-worktree. The one trap is the 500-entry cap in the current parser (see the end state).
- **Prerequisites:** none.
- **Related and overlapping:** RF-065 (shared worktree deletion-safety rules between git-worktree and storage-retention) touches the same removal code in `plugins/environment-git-worktree/host/worktree.ts`. RF-010 and RF-062 (Git query ownership in `createGitQueries`) touch the same package but not these functions. Execute RF-130 before RF-065 or rebase onto it. They do not conflict.
- **Why it deserves its place:** it is a small, low-risk change that removes duplicated parsing knowledge and a latent misparse. The gain is modest, so it belongs in the lower half of the ready list.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The audit snapshot worktree path was not present on disk during verification, so every file was read with `git -C $OMNYO_CHECKOUT show e9e1b74c3…:<path>` and `git grep` against that commit.

`omnyo-environment-provider-host` (`packages/environment-provider-host`) is a private workspace package with shared host-side Git helpers for the bundled environment providers. It exports `./git`, `./git-queries` and others in `package.json`. It has no tests and no `test` script, only `typecheck`. Three modules call `git worktree list --porcelain`, and each parses the output its own way.

Observed facts (Proven by inspection):

1. `packages/environment-provider-host/src/git.ts:361-387` "findWorktreeForBranch" runs `["worktree", "list", "--porcelain"]` in newline form. It splits stdout on `"\n"`, tracks the last `worktree ` line, and returns that path when a line equals `branch refs/heads/<name>`. It has 27 lines (23 non-blank). Callers:
   - `plugins/environment-temporary-copy/host/copy.ts:690-691` "branchBusy";
   - `plugins/environment-git-worktree/host/worktree.ts:173-180` "removeAbandonedAttemptWorktree", which is called from `worktree.ts:629`.
2. `plugins/environment-temporary-copy/host/copy.ts:962-991` "findLinkedWorktree" runs the newline form through the local `git()` helper (`copy.ts:82-93`, which trims stdout). It splits records on `"\n\n"` and returns `{ head, locked }` for the entry whose `comparablePath` (`copy.ts:947-960`, realpath-normalized) equals the target. It has 30 lines (25 non-blank). Callers: "prepareOriginCheckout" at `copy.ts:1035`, a second function at `copy.ts:1203` that returns `null` when `linked.head === null`, and a discard function at `copy.ts:1321`.
3. `plugins/environment-git-worktree/host/worktree-list.ts:3-65` defines `GitWorktreeEntry { path, branch, isMain, isBare, locked, prunable }`, `MAX_ENTRIES = 500` and "parseWorktreeListPorcelain". The parser uses the NUL (`-z`) form, converts `/` to `path.sep` on Windows, strips `refs/heads/`, and caps output at 500 entries. It does not read `HEAD`. The same file keeps "selectAdoptableWorktrees" (`:67-78`) and "findWorktreeEntry" (`:91-101`). `worktree.ts:1001-1011` "listGitWorktrees" runs `["worktree", "list", "--porcelain", "-z"]` with an optional `signal` and parses the result. It is used by:
   - the pre-removal registration check at `worktree.ts:909-920` (`!entry || entry.locked || entry.prunable` throws `worktree_identity`);
   - the post-removal check at `worktree.ts:986-995` (an entry that is still registered throws `worktree_remove_failed`);
   - "listAdoptableWorktrees" (`:1013-1023`), which feeds `host.ts:70-84` `listWorktrees` and "resolveAdoptableWorktree" (`worktree.ts:1025-1050`).
4. The git-worktree plugin therefore already uses both the newline-form `findWorktreeForBranch` and its own `-z` parser. Two worktree-list grammars live in a single plugin.
5. Out of scope: `plugins/storage-retention/src/worktrees/git.ts:624-665` "worktreeRecords" is a fourth `-z` parser with `head`, `branch`, `locked`, `missing` (prunable) and `bare`. storage-retention does not depend on `omnyo-environment-provider-host` (checked in its `package.json`), and adding that dependency is not justified by this item.

Git contract. `man git-worktree` for the local git 2.54.0 says that `-z` "makes it possible to parse the output when a worktree path contains a newline character". It also says that without `-z` only the lock reason is quoted, not the path. A worktree path that contains a newline is therefore misread by items 1 and 2 (Proven by inspection of the code and the documented contract; not reproduced, because this audit was read-only). This is an edge case, not a user-reported failure.

Search scope. I ran `git grep -n -e 'worktree", "list"' -e 'worktree list' -e '"--porcelain"' -e '"worktree "' e9e1b74c3 -- apps packages plugins scripts`. Outside tests, it found only the four parsers above. The other `--porcelain` hit, `packages/omnyo-app/src/app-update/source-checkout.ts:146`, is not a worktree list. A search with no hits does not prove absence: a parser built from split string literals would be missed. I found no dynamic or string-addressed consumers. None of these functions is an RPC method, CLI command or persisted format. `GitWorktreeEntry` is an internal type. The `listWorktrees` RPC output in `host.ts:76-83` maps only `path`, `branch`, `locked` and `prunable`, so the RPC contract is unchanged. The `listGitWorktrees` name in `plugins/storage-retention/src/storage.test.ts:704,1489` is an unrelated storage-host method name in a test fake.

Forkability. `docs/forkable-plugins.md` and the `omnyo/forkable-plugin-imports` lint rule forbid workspace-package imports only for plugins listed in `scripts/forkable-plugins.json`. Neither `environment-git-worktree` nor `environment-temporary-copy` is listed (only `environment-modal-sandbox` and `environment-personal-workspace` are). Both already depend on `omnyo-environment-provider-host` (`package.json` lines 39 and 32) and import `omnyo-environment-provider-host/git`. Moving the parser there adds no new dependency edge.

Tests that encode the current contract:
- `plugins/environment-git-worktree/host/worktree-list.test.ts` (134 lines): parser and `selectAdoptableWorktrees` cases, with `toEqual` on whole entries.
- `plugins/environment-git-worktree/host.test.ts:803-870`: adoption by real git, covering symlink aliases, main/managed refusal, and missing and prunable worktrees.
- `plugins/environment-temporary-copy/host/copy.test.ts:319` "leaves a branch alone when an origin worktree has it checked out" (covers `branchBusy` and `findWorktreeForBranch`), `:551` origin checkout, and `:955` "locks its checkout so storage cleanup leaves it alone" (covers `findLinkedWorktree` lock and head).
- No test exercises `removeAbandonedAttemptWorktree` directly (searched with `git grep -i abandoned` over the git-worktree tests; no hits).

Maintenance cost today: supporting a new porcelain attribute or fixing path decoding means editing three grammars in three files. Within git-worktree, a reader must know that the branch lookup and the path lookup parse the same output differently.

**Proposed end state and preservation argument**

What remains:
- `packages/environment-provider-host/src/git.ts` owns `GitWorktreeEntry` (with a new `head: string | null` field), "parseWorktreeListPorcelain" (uncapped), "findWorktreeEntry" and a new "listGitWorktrees(cwd, options)". These are exported from `omnyo-environment-provider-host/git`.
- "findWorktreeForBranch" keeps its exact signature and return value `Promise<string | null>`. It becomes `ensureGitRepo`, then `listGitWorktrees`, then find the entry with `branch === branchName`, and return its path or `null`.
- temporary-copy "findLinkedWorktree" keeps its signature and return value `{ head, locked } | null`. It calls `listGitWorktrees(sourcePath)` and matches with its own `comparablePath`, so the realpath semantics stay unchanged.
- git-worktree keeps "selectAdoptableWorktrees" and its private `isInside` locally in `worktree-list.ts`. It imports the type, the parser and `findWorktreeEntry` from the provider. It applies the 500-entry cap only in "listAdoptableWorktrees".

What disappears: the newline-form parsing in `findWorktreeForBranch` and in `findLinkedWorktree`; the git-worktree copy of the parser, the entry type and `findWorktreeEntry`; and the git-worktree `listGitWorktrees` wrapper.

Preservation argument:
- **Branch matching.** The old code matched `branch refs/heads/<name>` exactly. The parser strips `refs/heads/` only when present, so a non-`refs/heads/` ref keeps its full value. Matching `entry.branch === branchName` returns the same holder for every `refs/heads/` branch. A theoretical `branch refs/remotes/x` line would never have equalled `refs/heads/<name>` before, and its stored value `refs/remotes/x` still cannot equal a local branch name unless the caller passes that literal string. No caller does: both pass local branch names.
- **Path value on Windows.** The parser converts `/` to `\` on Windows, while the old `findWorktreeForBranch` returned git's forward-slash form. The consumers are `isPathInside(ownWorktreesRoot, holder)` (path-module based) and `branchBusy` (`!== null` only), so both accept either form. `findLinkedWorktree` compares through `realpath`, which normalizes separators. This is Proven by inspection for the callers. Confirm on Windows CI if it is available.
- **HEAD and lock.** `head` is read from the `HEAD <sha>` field and is `null` when absent (bare entries), matching the old `?? null`. `locked` already treats both `locked` and `locked <reason>` as true, matching `line === "locked" || line.startsWith("locked ")`.
- **The 500 cap.** The old `findWorktreeForBranch` and `findLinkedWorktree` were uncapped. Moving the capped parser unchanged into either would make repositories with more than 500 worktrees regress, because a branch or origin checkout beyond entry 500 would read as absent. The cap therefore leaves the parser. `listAdoptableWorktrees` applies `entries.slice(0, 500)` before `selectAdoptableWorktrees`, matching today's order: the cap counts raw entries, including the main checkout. The git-worktree removal checks (`worktree.ts:909` and `:986`) become uncapped. This is an intentional, safer behavior change: today a registration beyond entry 500 is invisible to the post-removal check (see newIssues). Name it in the commit message.
- **Signals and timeouts.** The provider `listGitWorktrees` accepts `GitTimeoutOptions & { signal?: AbortSignal }` and forwards them to `runGit`. This covers both the git-worktree callers, which pass `signal`, and `findWorktreeForBranch`, which passes `GitTimeoutOptions`.
- **No contract changes.** RPC outputs, CLI output, persisted data and UI states are unchanged.

Non-goals: storage-retention's `worktreeRecords` (it would need a new dependency edge, which is weighed separately in RF-065), adding new porcelain attributes, and changing `comparablePath`.

This is the simplest sufficient option. The package that both plugins already import becomes the one owner, and no new package or abstraction is introduced.

**Expected gain and cost**

Line counts come from `git show e9e1b74c3:<file> | sed -n '<a>,<b>p' | grep -c -v '^\s*$'`:

| Code | Before (total / non-blank) | After (projection) |
|---|---|---|
| `findWorktreeForBranch` (`git.ts:361-387`) | 27 / 23 | about 10 |
| `findLinkedWorktree` (`copy.ts:962-991`) | 30 / 25 | about 14 |
| Parser, entry type and `findWorktreeEntry` (`worktree-list.ts:3-65,91-101`) | 74 / about 63 | moved: about +4 for `head`, and the cap line leaves |
| git-worktree `listGitWorktrees` (`worktree.ts:1001-1011`) | 11 / 10 | moved, about the same size |
| Cap in `listAdoptableWorktrees` | 0 | about +2 |

- **Projected net:** about 25 to 35 handwritten production lines removed. The sweep's 30 to 45 counted the moved parser optimistically. Moved code is not counted as removed.
- **Tests:** worktree-list parser tests gain a `head` field in their `toEqual` expectations and one newline-path case. The net test change is small and positive.
- **Mechanisms:** three worktree-list grammars become one, and the newline-form parsing disappears. In git-worktree, two grammars become one.
- **Performance:** neutral by inspection. The same single `git worktree list` call runs per lookup, and `-z` output is the same size. Parsing all fields instead of stopping at the first branch match is negligible. No benchmark was run.
- **Cost:** provider-host gains about 70 lines of moved code and a public `./git` export surface for these four symbols. This is only a workspace-internal surface, not a published SDK.

**Execution steps**

1. **Reconfirm the baseline.** In a fresh worktree on current `main`, rerun `git grep -n -e 'worktree", "list"' -e '"--porcelain"' -- apps packages plugins scripts` and confirm that the four parsers and their callers are still at or near the cited symbols. Re-plan if any of these hold: a new caller depends on the 500 cap, `environment-git-worktree` or `environment-temporary-copy` has been added to `scripts/forkable-plugins.json` (a workspace-package import would then be forbidden, and this plan would have to move into the plugin SDK instead), or RF-065 has already rewritten `worktree.ts:890-995`.
2. **Add missing behavior evidence first, against the old code.**
   - In `plugins/environment-git-worktree/host/worktree-list.test.ts`, add a parser case for a path that contains `\n` (for example `record(["worktree /tmp/a\nb", "HEAD abc", "branch refs/heads/x"])`) and assert that the path is preserved.
   - In `plugins/environment-temporary-copy/host/copy.test.ts`, confirm that `:319` and `:955` still pass unchanged. They are the behavioral baseline for `findWorktreeForBranch` and `findLinkedWorktree`.
   - Optional: a real-git test in `plugins/environment-git-worktree/host.test.ts` that adds a worktree on branch `b` under the managed root and checks that `findWorktreeForBranch(source, "b")` returns its path. This closes the untested `removeAbandonedAttemptWorktree` path.
3. **Checkpoint A, a mechanical move.**
   - Move `GitWorktreeEntry`, `parseWorktreeListPorcelain` and `findWorktreeEntry` from `plugins/environment-git-worktree/host/worktree-list.ts` into `packages/environment-provider-host/src/git.ts`. Add `import path from "node:path"` (git.ts has no `node:path` import at the snapshot). Export them.
   - Move `listGitWorktrees` from `worktree.ts:1001-1011` into `git.ts` as:
     ```ts
     export async function listGitWorktrees(
       cwd: string,
       options: GitTimeoutOptions & { signal?: AbortSignal } = {},
     ): Promise<GitWorktreeEntry[]>;
     ```
     It runs `runGit(["worktree", "list", "--porcelain", "-z"], { cwd, ...options })`. First check that `RunGitOptions` accepts `signal`; the current git-worktree wrapper already passes it to the same `runGit`.
   - In `worktree-list.ts`, keep `selectAdoptableWorktrees` and `isInside`, and import `type GitWorktreeEntry` from `omnyo-environment-provider-host/git`.
   - In `worktree.ts`, import `findWorktreeEntry`, `listGitWorktrees` and `type GitWorktreeEntry` from the provider. Change the two callers at `:909` and `:986` from `listGitWorktrees({ sourcePath, ...signalOptions(signal) })` to `listGitWorktrees(sourcePath, signalOptions(signal))`.
   - Update the `worktree-list.test.ts` imports.
   - Verify: git-worktree typecheck and tests.
4. **Checkpoint B, the semantic changes.**
   - Remove `MAX_ENTRIES` from the parser and its `break` and `slice`. In `listAdoptableWorktrees` (`worktree.ts:1013`), apply `entries.slice(0, 500)` before `selectAdoptableWorktrees`, using a local `MAX_ADOPTABLE_SCAN = 500` constant with a one-line reason.
   - Add `head: string | null` to `GitWorktreeEntry`. Initialize it to `null` and set it on `key === "HEAD"`. Update the `toEqual` expectations in `worktree-list.test.ts` with the `HEAD` values already present in the fixtures (`abc123`, `def456`, `789abc`, and `null` for bare). This extends the expectations; it does not weaken them.
   - Rewrite `findWorktreeForBranch` (`git.ts:361`) as:
     ```ts
     await ensureGitRepo(cwd, options);
     const entry = (await listGitWorktrees(cwd, options)).find(
       (worktree) => worktree.branch === branchName,
     );
     return entry?.path ?? null;
     ```
     Keep the signature.
   - Rewrite `findLinkedWorktree` (`copy.ts:962`) to import `listGitWorktrees` from `omnyo-environment-provider-host/git`. Loop over the entries, `continue` while `(await comparablePath(entry.path)) !== target`, and return `{ head: entry.head, locked: entry.locked }` on a match, or `null`. Keep the sequential `await` order, because `comparablePath` touches the filesystem.
   - Verify: both plugins' typecheck and tests, and the provider-host typecheck.
5. **Cleanup.** Confirm that no `split("\n")` worktree parsing remains:
   ```sh
   git grep -n '"worktree "' -- packages/environment-provider-host plugins/environment-git-worktree plugins/environment-temporary-copy
   ```
   It should show only the shared parser's key check, if that uses a literal. Remove the now-unused `MAX_ENTRIES`. Optionally add one sentence to `packages/environment-provider-host/README.md` naming worktree listing as a shared primitive. Do not touch storage-retention.
6. **Final review.** Run the verification below, read the full diff for unrelated changes, and recount the removed lines with the same `sed`/`grep -c` method against this baseline.

**Verification and acceptance criteria**

Commands:
- The scripts were confirmed in the package.json files at the snapshot. Run `pnpm --filter omnyo-plugin-environment-git-worktree test`, `pnpm --filter omnyo-plugin-environment-git-worktree typecheck`, `pnpm --filter omnyo-plugin-environment-temporary-copy test` and `pnpm --filter omnyo-plugin-environment-temporary-copy typecheck` from `$OMNYO_CHECKOUT` (or the lane root). Each plugin's `test` is `vitest run --config vitest.config.ts`, and `typecheck` is `tsc --noEmit`. The `--filter` invocation follows standard pnpm usage and was not run here.
- `pnpm --filter omnyo-environment-provider-host typecheck` (script confirmed). The package has no test script, so the parser tests stay in `plugins/environment-git-worktree/host/worktree-list.test.ts` and import from the provider.
- `pnpm --filter omnyo-host-daemon typecheck` and `pnpm --filter @omnyo/host-workspace typecheck` cover the other provider-host importers. Read their package.json files first to confirm the package names and that they have a `typecheck` script; this was not confirmed here.
- Lint the touched packages the way the repository does. Root `pnpm lint` runs `turbo run lint`. For a narrower run, use each package's own `lint` script if it has one (unconfirmed for these three).
- The test suites could not be run during this audit, because the snapshot has no `node_modules`.

Behavior that must hold:
- `copy.test.ts:319` (a branch checked out in an origin worktree is left alone) and `:502` (a rebasing worktree) still pass.
- `copy.test.ts:551` and `:955` (origin checkout creation, lock, and head) still pass.
- `host.test.ts:803-870` (adoption aliases, refusals, and missing and prunable worktrees) still pass.
- The new newline-path parser case passes.
- `worktree-list.test.ts` passes with the added `head` expectations.
- If the cap needs coverage, add a unit test on `listAdoptableWorktrees` or on a small exported cap helper. Do not change the cap value.

Structural completion:
- `git grep -n 'worktree", "list"' -- packages plugins/environment-git-worktree plugins/environment-temporary-copy` shows exactly one call, inside the provider's `listGitWorktrees`.
- `plugins/environment-git-worktree/host/worktree-list.ts` contains only `selectAdoptableWorktrees` and `isInside`.
- No UI is affected, and no performance comparison is needed beyond noting that the number of git invocations is unchanged.

**Rollback and stop conditions**

Rollback: the change is source-only in three packages, with no data, persisted format or RPC change. Revert the commit or commits; checkpoints A and B can be reverted independently.

Stop and re-plan if any of these hold:
- either plugin has joined `scripts/forkable-plugins.json`, so a workspace import would be forbidden (move the parser into the packed plugin SDK instead, or drop the item);
- a test shows that a consumer depends on the forward-slash path form on Windows;
- a caller is found that relies on the 500 cap outside adoption listing;
- RF-065 restructured the removal checks first (rebase onto it and keep its semantics).

Safer smaller alternative: switch `findWorktreeForBranch` alone to the shared `-z` parser. That removes the newline form in the provider and the dual grammar inside git-worktree, and leaves temporary-copy for later.
