# RF-065 — One shared list of worktree-local Git state (private ref namespaces, in-progress operation markers, hidden-index test) for git-worktree and Storage & Retention

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplicated knowledge is real, and the two copies have already diverged. The sweep's proposed end state and its line estimate were overstated, and this card corrects both.
- **Potential:** low. One maintained rule list disappears. The net handwritten production line change is roughly zero to minus 15.
- **Confidence:** high that the duplication and divergence exist (Proven by inspection). Medium on the size of the user-visible data-safety gap that it hides.
- **Readiness:** conditional. Using the shared list in git-worktree makes worktree removal stricter, so it is a behavior change. Alex, as product owner, must accept two things: (a) git-worktree refusing removal when the index hides working files (assume-unchanged or skip-worktree entries), and (b) Storage & Retention taking a workspace dependency on `omnyo-environment-provider-host`.
- **Effort:** small, about half a day to one day, including Git fixture tests for the new git-worktree refusals.
- **Risk:** low to medium. These are data-preservation contracts. If the change is wrong it fails closed (a removal is refused) rather than open, provided the shared list is the union of both lists. The realistic regression is a worktree that the owner expects to be removable being refused, for example a sparse-checkout worktree whose index carries skip-worktree bits.
- **Prerequisites:** the owner decision above. The bug half (git-worktree missing the hidden-index check) is tracked separately as an incidental issue and should land as its own commit before or together with the structural share.
- **Related or overlapping:** RF-130 (one git worktree porcelain parser in environment-provider-host; it touches the same package and the same `listGitWorktrees` area but has no line overlap). RF-062 and RF-131 (other in-progress operation detectors used for branch switching, in `packages/host-workspace/src/git.ts:123` `WORKSPACE_GIT_OPERATION_MARKERS` and `plugins/environment-project-checkout/host/git.ts:96` `GIT_OPERATION_MARKERS`). Those detectors answer a different question ("what kind of operation blocks a branch switch") and must not be merged into this list.
- **Why it deserves its place:** two independently maintained Git safety lists that guard against deleting unrecoverable work have drifted apart. The drift is the maintenance cost: when Git or Omnyo adds a new piece of worktree-local state, someone must remember both sites. The structural gain is small, so this item ranks low on simplification value. Its main justification is that it removes the place where the data-safety gap grew.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The prepared read-only worktree for this snapshot no longer existed when this card was written, so every file was read with `git show e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e:<path>` from `$OMNYO_CHECKOUT`. The snapshot has no `node_modules`, so no test suite was run.

Two plugins delete Git worktrees, and each decides on its own whether deleting one could lose work Git cannot restore.

1. **git-worktree** (`plugins/environment-git-worktree`) removes Omnyo-managed worktrees that it created for chats. `plugins/environment-git-worktree/host/worktree.ts:751-798` `assertNoWorktreeLocalState` runs `for-each-ref` over `refs/worktree/`, `refs/bisect/` and `refs/rewritten/`. It then reads `rev-parse --absolute-git-dir` and checks the Git directory for eight markers: `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `REBASE_HEAD`, `BISECT_START`, `rebase-merge`, `rebase-apply` and `sequencer`. It throws `WorkspaceError` (`worktree_local_refs` or `worktree_git_operation`) on the first problem it finds. `removeWorktree` (`worktree.ts:800`) calls it inside the nested `inspect` closure (`worktree.ts:851-923`), and that closure runs two or three times per removal. The same closure also checks `status --porcelain=v1 --untracked-files=all --ignored=matching -z`, which feeds the setup-output exemption `setupOutputCleanup`. It then requires HEAD to be contained in `refs/heads/`, `refs/tags/` or `refs/remotes/`, and requires an unlocked, non-prunable registration. Git runs through `runGit` from `omnyo-environment-provider-host/git`, which goes through the plugin SDK's `experimental_runVcsProcess` admission and honours an `AbortSignal`.
2. **Storage & Retention** (`plugins/storage-retention`) reviews and cleans worktrees across all projects. Worktrees in use by an Omnyo environment are reported with the reason "Used by Omnyo environment or project source" and are never purged (`plugins/storage-retention/src/worktrees/git.ts:1095` `inUse`, reason at `:1262`). In practice, therefore, the two plugins delete mostly disjoint sets of worktrees. Inside `inspectTargets` (`git.ts:873`), the per-worktree block at `git.ts:1145-1215` runs these commands in one `Promise.allSettled`: `status --porcelain=v1 -z --untracked-files=all`; `ls-files --others --ignored --exclude-standard --directory --no-empty-directory -z`; `ls-files -v -z`, tested with `/^[a-zS] /` to set `hiddenIndex`; `for-each-ref` over the same three namespaces; and `rev-parse --absolute-git-dir`. It then probes twelve markers with `access()`: `MERGE_HEAD`, `MERGE_AUTOSTASH`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `REBASE_HEAD`, `BISECT_HEAD`, `BISECT_EXPECTED_REV`, `AUTO_MERGE`, `BISECT_LOG`, `rebase-merge`, `rebase-apply` and `sequencer`. Each result becomes a boolean, and the booleans become human-readable `reasons` (`git.ts:1253-1269`), such as "Index hides working files", "Git operation in progress" and "Worktree-private references present". Any failure becomes a reason too, so the check fails closed. Git runs through the plugin's own `git()` helper (`git.ts:43`), which has an eight-way concurrency queue, a cleanup-priority lane (`withCleanupPriority`), an AsyncLocalStorage host abort signal (`withHostSignal`), a 15 second timeout, `--no-optional-locks` and `GIT_LITERAL_PATHSPECS=1`. `purgeWorktree` (`git.ts:1680`) re-runs `inspectTargets` before it calls `git worktree remove` at `git.ts:1710`.

Observed divergence (Proven by inspection):

| Rule | git-worktree | Storage & Retention |
|---|---|---|
| Private ref namespaces `refs/worktree/`, `refs/bisect/`, `refs/rewritten/` | yes | yes (same three) |
| `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `REBASE_HEAD`, `rebase-merge`, `rebase-apply`, `sequencer` | yes | yes |
| `BISECT_START` | yes | no (it checks `BISECT_LOG`, which Git writes at the same time) |
| `MERGE_AUTOSTASH`, `AUTO_MERGE`, `BISECT_HEAD`, `BISECT_EXPECTED_REV`, `BISECT_LOG` | no | yes |
| Hidden index (`ls-files -v`, assume-unchanged or skip-worktree) | **no** | yes |

The impact of the marker gap is mostly theoretical (Hypothesis). `AUTO_MERGE` and `MERGE_AUTOSTASH` normally appear together with `MERGE_HEAD` or with unmerged paths that the status check already blocks, and bisect is caught by `BISECT_START` and `refs/bisect/`. The hidden-index gap is real. `git status` does not report edits to an assume-unchanged file, so git-worktree's status check passes, and `git worktree remove` then deletes the edited file. Storage & Retention's own integration script encodes this contract: `plugins/storage-retention/src/worktrees/tests/git.integration.ts:153-162` edits an assume-unchanged file in a linked worktree and asserts `purgeReady === false`. That script also lists "assume-unchanged edit protection" among its checks at `:835`. git-worktree has no equivalent test. Its preservation tests at `plugins/environment-git-worktree/host.test.ts:286` (`untracked`, `ignored`, `detached`, `locked`, `broken`) and `:344-434` (`refs/worktree/saved`, `refs/bisect/saved`, `refs/rewritten/saved`, `MERGE_HEAD`) cover only the rules it has today. This gap is recorded as an incidental issue, not fixed by this card.

Searches run against the snapshot from `$OMNYO_CHECKOUT`:

- `git grep -n -e MERGE_HEAD -e refs/worktree/ -e MERGE_AUTOSTASH -e BISECT_START e9e1b74c… -- . ':!*.md'` found only the two sites above, their tests, the branch-switch detectors named under Related, the reserved branch names in `packages/domain/src/git-checkout.ts:9`, and `plugins/environment-temporary-copy/host/copy.ts:50` (`SENT_REF`, which writes a ref and is not a check).
- Searches for production `worktree remove` call sites, including arguments split across lines, found three: `worktree.ts:953`, `git.ts:1710`, and `plugins/environment-temporary-copy/host/copy.ts:1330-1336` `removeOriginCheckout`. Temporary Copy deliberately runs `worktree remove --force --force` after `keepBeforeDiscarding` saves the tip. That is a different, intentional policy and stays out of scope.
- Neither plugin appears in `scripts/forkable-plugins.json`, so a workspace-package dependency does not break the forkability rule in `docs/forkable-plugins.md`. git-worktree already depends on `omnyo-environment-provider-host`. Storage & Retention's `package.json` does not, although it already has workspace dependencies (`@omnyo/domain`, `@omnyo/shared-ui`).
- Neither copy has external consumers. `assertNoWorktreeLocalState` is module-private, and the Storage & Retention block is inline code inside `inspectTargets`. No SDK, CLI, persisted data or migration references either copy. The reason strings are UI copy shown by the Storage & Retention sidebar and must stay unchanged.

Corrections to the sweep proposal:

- The sweep proposed a shared `inspectWorktreePreservation(path)` that would run Git and return typed blockers for refs, operations, changed, untracked or ignored files, hidden index and unreferenced HEAD. That is not a sound shared unit. (a) The two plugins use different Git runners: Storage & Retention's queue, priority lane and host signal would be bypassed by `runGit`, or the helper would need runner injection. (b) Status handling differs: one combined status with `--ignored=matching` feeds `setupOutputCleanup`, while the other uses a separate collapsed ignored listing and keeps `dirtyFiles` for the UI. (c) The HEAD policy differs on purpose. git-worktree accepts HEAD contained in any named ref. Storage & Retention blocks a detached HEAD and requires the head to be merged into another retained local branch, plus clean reflog and recovery-ref checks (`hasUnpreservedReflog`, `hasUnpreservedRecovery`, `git.ts:1271-1294`). (d) git-worktree throws on the first problem, while Storage & Retention collects every reason in parallel. Only the knowledge of which local state exists is shared meaning.
- The sweep estimated 40 to 80 production lines. A non-blank recount of the duplicated regions, done with `node -e` over the extracted snapshot files, gives 42 lines in `worktree.ts:751-798` and 38 lines in the relevant parts of `git.ts:1162-1215`. Most of those lines are runner and error plumbing that stays. The removable part is the two marker lists (8 and 12 entries), the two namespace triples and the regex.

**Proposed end state and preservation argument**

Add one pure module, with no process execution and no runtime imports, to `packages/environment-provider-host`:

```ts
// packages/environment-provider-host/src/worktree-local-state.ts
/** Ref namespaces that live only in one linked worktree's Git directory. */
export const WORKTREE_PRIVATE_REF_NAMESPACES = [
  "refs/worktree/", "refs/bisect/", "refs/rewritten/",
] as const;

/** Files or directories in a worktree Git directory that mean an operation is in progress
 *  or holds state (autostash, bisect log) that removal would discard. Union of both former lists. */
export const WORKTREE_OPERATION_MARKERS = [
  "MERGE_HEAD", "MERGE_AUTOSTASH", "AUTO_MERGE",
  "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD",
  "BISECT_START", "BISECT_LOG", "BISECT_HEAD", "BISECT_EXPECTED_REV",
  "rebase-merge", "rebase-apply", "sequencer",
] as const;

/** Argument list for the index listing that hasHiddenIndexEntries reads. */
export const HIDDEN_INDEX_LIST_ARGS = ["ls-files", "-v", "-z"] as const;

/** True when `git ls-files -v -z` output has an assume-unchanged (lowercase tag) or skip-worktree (S) entry. */
export function hasHiddenIndexEntries(lsFilesVerboseZ: string): boolean {
  return lsFilesVerboseZ.split("\0").some((entry) => /^[a-zS] /.test(entry));
}
```

Export it through a new subpath `"./worktree-local-state"` in `packages/environment-provider-host/package.json`, with the same `source`, `types` and `default` triple as the existing subpaths. Use a separate subpath so that Storage & Retention's host bundle does not import `./git` and, through it, `@omnyo/plugin-sdk/host` process code.

What remains, deliberately separate:

- Each plugin keeps its own Git runner, its own error style (git-worktree's `WorkspaceError` codes and messages; Storage & Retention's reason strings), its own status and ignored-file handling, its HEAD and reflog policy, and git-worktree's setup-output exemption and process and registration checks.
- Temporary Copy's forced removal keeps its own policy.
- The branch-switch operation detectors (RF-062 and RF-131) keep their own kind-tagged lists.

Preservation argument. Storage & Retention's behavior is unchanged: it probes the same twelve markers plus `BISECT_START`, which Git writes together with `BISECT_LOG`, so no new refusals are expected in practice. Its namespaces, regex and reason strings are identical. git-worktree becomes stricter only, in two ways. It refuses removal when one of the five added markers is present, with the existing `worktree_git_operation` code and message format. It refuses removal when the index hides working files, with a new code `worktree_hidden_index` and the message "Cannot remove <path>: the Git index hides working-file changes (assume-unchanged or skip-worktree entries); clear them first." Both refusals fail closed, and the worktree and its metadata are left intact, which matches the existing test pattern at `host.test.ts:396-410`. Error codes and messages surface in the provisioning result `{ status: "failed", message }`. No other UI changes.

Non-goals: aligning the HEAD, reflog or detached-HEAD policies; sharing a Git executor; changing Storage & Retention reason text; merging with Temporary Copy or with the branch-switch detectors.

**Expected gain and cost**

- **Mechanisms (observed):** two independently maintained lists of worktree-local state become one. Before this change, adding a marker means editing `worktree.ts:779-788` and `git.ts:1187-1200` and remembering that both exist; the snapshot already shows the cost of forgetting. After it, a marker is added in one file.
- **Handwritten production lines (projection):** about 30 lines removed (two marker arrays, two namespace triples, the inline regex) and about 25 lines added (the module and its subpath export), plus about 10 lines in git-worktree for the new hidden-index refusal. Net change is roughly zero to minus 15 lines. This item is justified by removing duplicated safety knowledge, not by line count.
- **Tests (projection):** about 30 to 60 lines added to `plugins/environment-git-worktree/host.test.ts` (new `it.each` cases). Optionally a small pure unit test for `hasHiddenIndexEntries`.
- **New coupling:** Storage & Retention gains one workspace dependency on `omnyo-environment-provider-host`, and only on a pure subpath.
- **Performance (Hypothesis, not measured):** Storage & Retention is neutral. git-worktree adds one `ls-files -v -z` run and five more `readdir` membership lookups per `inspect` pass. `inspect` runs two or three times per removal, so the cost is proportional to index size per pass. On very large repositories this adds measurable latency to chat-worktree removal, and `runGit` caps output at 16 MiB (`packages/environment-provider-host/src/git.ts:15` `MAX_OUTPUT_BYTES`). If that cap is exceeded the removal fails closed. The same class of issue already exists in Storage & Retention at a 4 MiB cap (see incidental issues). Measure before and after on a large repository before accepting the change.

**Execution steps**

Investigation gate (complete it before any edit):

1. Reconfirm the anchors at the current `main`: `assertNoWorktreeLocalState` and its marker array in `plugins/environment-git-worktree/host/worktree.ts`, and the `markers` array and `hiddenIndex` regex in `inspectTargets` in `plugins/storage-retention/src/worktrees/git.ts`. If either site has gained, lost or reordered rules, recompute the union. If a third production removal site with its own local-state check has appeared, search it with `git grep -n -e MERGE_HEAD -e refs/worktree/ -- ':!*.md'` and with the multi-line `"worktree",` / `"remove"` search, and re-plan.
2. Ask the owner for the owner decision and record it in the commit message. Ask three things: whether git-worktree should refuse removal of a chat worktree whose index has assume-unchanged or skip-worktree entries; whether Storage & Retention may depend on `omnyo-environment-provider-host`; and whether to fix the git-worktree gap before or with this refactor. If Alex declines the hidden-index refusal, still share the lists, but have git-worktree import only `WORKTREE_PRIVATE_REF_NAMESPACES` and `WORKTREE_OPERATION_MARKERS`, and record the declined rule in a code comment that names the decision.
3. Check whether Omnyo-managed worktrees can legitimately carry skip-worktree bits. Search `plugins/environment-git-worktree` and `packages/host-workspace` for `sparse-checkout` or `update-index`; at the snapshot there were none. If an Omnyo flow creates sparse worktrees, every such worktree would become unremovable, so stop and re-plan: either limit the test to assume-unchanged (lowercase tags only) or compare against the sparse pattern.

Implementation (two commits):

4. **Commit A, structural, no behavior change in Storage & Retention.** Create `packages/environment-provider-host/src/worktree-local-state.ts` as shown above and add the `"./worktree-local-state"` export to `packages/environment-provider-host/package.json`. Add `"omnyo-environment-provider-host": "workspace:*"` to `plugins/storage-retention/package.json` `dependencies` (lockfile update through the normal `pnpm install`, under the executing agent's own authority). In `plugins/storage-retention/src/worktrees/git.ts` `inspectTargets`, replace the literal namespaces at `:1163-1169` with `["for-each-ref", "--format=%(refname)", ...WORKTREE_PRIVATE_REF_NAMESPACES]`, the `ls-files -v -z` arguments with `[...HIDDEN_INDEX_LIST_ARGS]`, the regex at `:1176-1178` with `hasHiddenIndexEntries(requireGitOutput(indexFiles))`, and the `markers` array at `:1187-1200` with `WORKTREE_OPERATION_MARKERS`. Keep its `Promise.allSettled`, its `git()` runner, its `access()` probes and its reason strings unchanged. Checkpoint: Storage & Retention typecheck and tests pass (commands below), and the integration script still reports "assume-unchanged edit protection" and "worktree-private ref preservation".
5. **Commit B, behavior change in git-worktree (the incidental-issue fix).** In `plugins/environment-git-worktree/host/worktree.ts` `assertNoWorktreeLocalState`, import from `omnyo-environment-provider-host/worktree-local-state`. Replace the namespace literals at `:759-763` with the spread constant, and the marker array at `:779-788` with `WORKTREE_OPERATION_MARKERS.find((entry) => entries.has(entry))`. Add `const index = await runGit([...HIDDEN_INDEX_LIST_ARGS], options);` followed by `if (hasHiddenIndexEntries(index.stdout)) throw new WorkspaceError("worktree_hidden_index", ...)`, placed after the operation check and before `return directory;`. Keep the existing order of checks so that existing error codes still win for existing states.
6. Add tests to `plugins/environment-git-worktree/host.test.ts`, following the pattern at `:344-434` (create a worktree, put it in the state, expect `failed` with the worktree and Git directory present, resolve the state, then expect `removed`). Cover these states: an assume-unchanged file with an edit (`update-index --assume-unchanged file`, then write the file); `AUTO_MERGE` or `MERGE_AUTOSTASH` present (write the marker file directly into the absolute Git directory, as `git.integration.ts` does for its fixtures); and `BISECT_LOG` alone. Checkpoint: these new cases fail on commit A and pass on commit B. Watching them fail first is the regression proof.
7. Inspect the full diff. No old marker array or namespace literal should remain in either plugin: `git grep -n '"BISECT_EXPECTED_REV"\|"refs/rewritten/"' -- plugins packages` should hit only the new module and tests. Recount production lines against this card's baseline.

**Verification and acceptance criteria**

Commands, all run from the repository root `$OMNYO_CHECKOUT`. The scripts were confirmed in the snapshot `package.json` files; the commands were not run because the snapshot has no `node_modules`.

- `pnpm --filter omnyo-plugin-environment-git-worktree test` runs the `test` script, `vitest run --config vitest.config.ts`. Expect the existing preservation suites at `host.test.ts:286` and `:344` to pass, and the new cases from step 6 to pass.
- `pnpm --filter omnyo-plugin-environment-git-worktree typecheck`, `pnpm --filter omnyo-plugin-omnyo--storage-retention typecheck`, and `pnpm --filter omnyo-environment-provider-host typecheck`.
- `pnpm --filter omnyo-plugin-omnyo--storage-retention test` runs `vitest run`, which covers `src/**/*.test.ts` including `src/worktrees/tests/git.test.ts`, and `pnpm --filter omnyo-plugin-omnyo--storage-retention lint` runs that plugin's `oxlint` script. git-worktree has no lint script, so run `pnpm exec oxlint --deny-warnings --format=agent <changed files>` for its files.
- `plugins/storage-retention/src/worktrees/tests/git.integration.ts` is a standalone assertion script that writes evidence to `LOCAL_WORKTREES_EVIDENCE` (default `evidence`). No package script or test config references it (searched with `git grep -n "git.integration"`). An invocation such as `LOCAL_WORKTREES_EVIDENCE="$TMPDIR/rf065" pnpm --filter omnyo-plugin-omnyo--storage-retention exec tsx src/worktrees/tests/git.integration.ts` is **unverified**; first confirm that `tsx` or an equivalent loader is available. Expected output is `PASS: …`, with the check list including "assume-unchanged edit protection".
- Behavior acceptance: Storage & Retention gives the same `purgeReady` and `reasons` for every fixture in the integration script before and after commit A. git-worktree refuses every new state without touching the worktree or its Git directory, and removes the worktree normally once the state is cleared.
- Performance acceptance, required before merging commit B: time `removeWorktree` (the `remove` host call) on a large repository (more than 100k index entries) before and after the change, using the same machine and a warm cache, and report the delta. No baseline exists today. If the delta is material to chat archive flows, stop and consider running `ls-files -v` only once per removal (before the first `inspect`) instead of on every pass.
- Structural completion: one definition of the namespaces, markers and hidden-index test; both plugins import it; and no copy of the literals remains.

**Rollback and stop conditions**

- The two commits revert independently. Commit A is behavior-neutral, and reverting it restores the inline lists. Reverting commit B removes only the stricter git-worktree refusals. No persisted data, migration or wire contract is involved, so rollback has no compatibility implications.
- Stop if Alex declines making git-worktree stricter. In that case land commit A only, with git-worktree importing the shared lists but not the hidden-index test, if Alex accepts the marker union; otherwise drop the item.
- Stop if an Omnyo flow creates sparse or skip-worktree checkouts (step 3), if the large-repository timing shows a material removal slowdown, or if the plugin bundler cannot resolve the new subpath for Storage & Retention's host bundle. The smaller alternative is to keep the lists separate, add only the missing hidden-index check to git-worktree, and add a comment in each list that cross-references the other.
