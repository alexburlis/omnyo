# RF-062 — Read checkout ref, in-progress Git operation and dirty state once, in `createGitQueries`, and delete the porcelain v1 path decoder that only served conflict detection

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplication is real and is as the sweep described. Two corrections change the scope. First, the merged plan also lets host-workspace delete its porcelain v1 path decoder (`parsePorcelainEntries` and its quoted-path helpers, about 125 lines), because conflict detection is the decoder's only production consumer and that check reads only the first two status characters. Second, the shared operation reader needs `getAbsoluteGitDir`, so that helper moves into the factory as well.
- **Potential:** medium. One definition of how Omnyo reads a checkout's state, instead of two that must stay identical. A dead decoder also disappears.
- **Confidence:** high that the readers are semantically identical and that the decoder becomes unused. Medium on the exact line counts, which are projections.
- **Readiness:** ready. The merge note asked to confirm identical error semantics, and that is now done by inspection (see "Preservation argument"). There is no product decision involved.
- **Effort:** small to medium, about half a day including the targeted test runs.
- **Risk:** low. The change affects the `host.inspect_git_source` daemon response and the Project checkout plugin's `inspect` and `attach` host RPCs. Possible regressions: a repo-kind guard changes (a bare repository flips between `branch` and `unknown`), `shellPath` or `timeoutMs` stops being forwarded, or operation precedence changes. Existing real-git tests cover all three.
- **Prerequisites:** none.
- **Related or overlapping opportunities:**
  - RF-010 (default-branch discovery into `createGitQueries`) reshapes the same factory file, `packages/environment-provider-host/src/git-queries.ts`. Run the two one after the other, not in parallel. Neither depends on the other.
  - RF-131 (define project-checkout's branch-switch blocker rule once) edits `assertSwitchable` in `plugins/environment-project-checkout/host/checkout.ts`, which consumes these readers. Land RF-062 first, or rebase RF-131's import lines onto it.
  - RF-130 (one worktree porcelain parser in environment-provider-host) works in the same package with a disjoint parser. It does not overlap.
  - RF-065 (worktree deletion-safety rules) owns the broader removal-safety marker lists in `plugins/environment-git-worktree/host/worktree.ts:776-785` and `plugins/storage-retention/src/worktrees/git.ts`. That is a different policy, which includes `REBASE_HEAD`, `BISECT_START` and `sequencer`. RF-062 must not merge with it.
  - RF-079 (small orphaned helpers kept alive only by their own tests) must not also count the porcelain v1 decoder. It becomes dead only through this change.
- **Why it deserves its place:** the change removes duplicated knowledge (four marker files, seven conflict codes, the HEAD classification rules and the dirty-check command line) from two packages that are maintained separately. It also deletes about 125 lines of path-decoding machinery that no production path needs. The work is cheap and bounded, and existing real-git tests in both consumers cover it.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The snapshot worktree named in the task no longer existed, so every file was read with `git -C $OMNYO_CHECKOUT show e9e1b74c3:<path>`. There are no node_modules, so no test ran. Every claim below is **Proven by inspection** unless it carries another label.

*Subsystem.* Omnyo reads a checkout's state on the host in two places.

1. The host daemon answers `host.inspect_git_source` in `apps/host-daemon/src/command-handlers/host-branches.ts` (around lines 270-335). That handler calls `detectGitRepoKind` once and returns early for `"none"`. It then runs these calls in parallel (lines 308-321): `getCheckoutRef`, `hasUncommittedChanges` (work tree only), `getWorkspaceGitOperation` (work tree only) and `detectLinkedWorktree`, all imported from `@omnyo/host-workspace`.
2. The Project checkout environment plugin (`plugins/environment-project-checkout`) runs on the host as a plugin. Its `inspectCheckout` (`host/checkout.ts:256-279`) and `attachCheckout`/`assertSwitchable` (`host/checkout.ts:58-125`, `281-319`) call its own copies of the same readers in `host/git.ts`.

*The two copies.*

| Reader | host-workspace (`packages/host-workspace/src/git.ts`) | Project checkout (`plugins/environment-project-checkout/host/git.ts`) |
|---|---|---|
| Conflict codes | `CONFLICT_PORCELAIN_STATUSES` lines 111-119: DD, AU, UD, UA, DU, AA, UU | `CONFLICT_PORCELAIN_STATUSES` lines 81-89: the same seven |
| Operation markers | `WORKSPACE_GIT_OPERATION_MARKERS` lines 121-126: rebase (`rebase-merge`, `rebase-apply`), merge (`MERGE_HEAD`), cherry-pick (`CHERRY_PICK_HEAD`), revert (`REVERT_HEAD`) | `GIT_OPERATION_MARKERS` lines 91-99: identical, in the same order |
| HEAD sha | `readHeadSha` lines 617-634: `rev-parse --verify HEAD`, `allowFailure`, options forwarded | `readHeadSha` lines 20-33: identical, without options |
| Checkout ref | `getCheckoutRef` lines 636-671: guard `detectGitSource` (bare repositories allowed), then `symbolic-ref --quiet --short HEAD` and HEAD sha in parallel. The result is `branch`, `unborn`, `detached` or `unknown`, with the same two reason strings | `getCheckoutRef` lines 35-64: guard `detectGitRepo` (work tree only), then the identical body |
| Dirty state | `hasUncommittedChanges` lines 1759-1776: `ensureGitRepo`, then `--no-optional-locks status --porcelain=v1 --untracked-files=all`, non-empty after trim | `readPorcelainStatus` and `hasUncommittedChanges` lines 101-117: the same command, no guard |
| Operation | `getWorkspaceGitOperation` lines 904-934: `ensureGitRepo`, then `getAbsoluteGitDir` (lines 544-563) and the same status in parallel. Conflicts come from `parsePorcelainEntries` and `hasPorcelainConflict` (lines 860-886). Markers are checked **sequentially** by `findWorkspaceGitOperationMarker` (lines 586-598), and a switch in `buildActiveWorkspaceGitOperation` (lines 888-902) builds the result | `getWorkspaceGitOperation` lines 119-154: no guard, inline `rev-parse --absolute-git-dir`, the same status. Conflicts come from `line[0]`/`line[1]`/the first two characters. Markers are checked **in parallel**, and the first marker in list order wins |

*The shared factory already exists.* `packages/environment-provider-host/src/git-queries.ts:28-141` "createGitQueries(runGit, WorkspaceError)" holds runner-agnostic queries: `getGitCommonDir`, `detectGitRepoKind`, `detectGitRepo`, `detectGitSource`, `ensureGitRepo` and `getCurrentBranch`. It is instantiated in two places:

- `packages/host-workspace/src/git.ts:565-572`, with host-workspace's `runGit` and `WorkspaceError`;
- `packages/environment-provider-host/src/git.ts:291-293`, with the plugin-SDK-backed `runGit`. The plugin imports `detectGitRepo` and `runGit` from there.

`packages/host-workspace/package.json` already depends on `omnyo-environment-provider-host`, and so does `plugins/environment-project-checkout/package.json`. The plugin is **not** listed in `scripts/forkable-plugins.json` (that list holds `environment-modal-sandbox` and `environment-personal-workspace`), so its existing workspace-package import is allowed under `docs/forkable-plugins.md`.

*Conflict parsing agrees.* `parsePorcelainEntries` derives `indexStatus = line[0]`, `worktreeStatus = line[1]` and `status = line.slice(0, 2).trim() || line.slice(0, 2)`. None of the seven conflict codes contains a space, so trimming does not affect the set lookup. The two filters (`line && !line.startsWith("##")` against `line.length >= 2`) agree for `git status --porcelain=v1` output without `-b`, because every record is at least `XY path`. The path that `parsePorcelainEntries` decodes is never read by `hasPorcelainConflict`. Renamed paths therefore cannot affect conflict detection in either copy.

*The porcelain v1 path decoder becomes dead.* `git grep -n -w "parsePorcelainEntries\|parsePorcelainPath" e9e1b74c3` over the whole snapshot finds only these hits:

- `packages/host-workspace/src/git.ts:780` (the `parsePorcelainPath` definition), `:860` (the `parsePorcelainEntries` definition), `:871` (the call from `parsePorcelainEntries` to `parsePorcelainPath`) and `:924` (the call from `getWorkspaceGitOperation`);
- `packages/host-workspace/test/git.test.ts:13`, `:480-542` (the `describe("parsePorcelainEntries")` block).

`packages/host-workspace/src/index.ts` (lines 1-31) does not re-export `parsePorcelainEntries`, and the package is private. The decoder helpers below are referenced only inside that chain, as checked with `grep -n` over `git.ts`:

- `ParsedPorcelainPathToken` (lines 106-109);
- `GIT_QUOTED_PATH_ESCAPE_BYTES` (lines 128-138);
- `appendUtf8Bytes`, `isOctalDigit`, `readEscapedPorcelainPathBytes`, `parseQuotedPorcelainPathToken`, `parseUnquotedPorcelainPathToken`, `parsePorcelainPathToken` and `parsePorcelainPath` (lines 673-790).

`PorcelainEntry` (lines 94-99) stays, because `parsePorcelainV2StatusZ` (line 802) uses it.

*Tests that encode the contract.*

- `packages/host-workspace/test/git.test.ts:182-224` tests `getCheckoutRef` on a bare repository root (`branch`), a branch, a detached HEAD and an unborn branch. Lines 226-270 test `getWorkspaceGitOperation` for none, merge conflicts and rebase conflicts. Both use real git.
- `packages/host-workspace/test/status-process.e2e.ts:346-368` checks that an invalid path gives `{ kind: "unknown", reason: "Path is not a git repository" }` and that a bare clone gives `kind: "branch"`. This file is outside the vitest `include` (`test/**/*.test.ts`), and `git grep` found no script that references it. **Its runner could not be confirmed.**
- `apps/host-daemon/test/command/host-branches-dispatch.test.ts` (around lines 360-402) covers dirty primary checkouts and a bare repository root that holds sibling worktrees, through the daemon handler.
- `plugins/environment-project-checkout/host.test.ts` drives the plugin host entry against real git repositories (`execFile("git", …)`) through `experimental_createHostEntryHarness`.
- `plugins/environment-project-checkout/host/git.test.ts:1-34` mocks `omnyo-environment-provider-host/git`'s `runGit` and spies on `fs.access`. It asserts that the five marker probes are all pending at once, which means they run in parallel, and that rebase still wins over merge.

*Maintenance cost today.* Recognising a new in-progress state, changing the conflict rule or changing the dirty-check flags is a two-file edit that must stay identical. A separate decoder of about 125 lines, with about 60 lines of tests, is also maintained for a path value that nobody reads.

**Proposed end state and preservation argument**

*End state.*

1. `createGitQueries` in `packages/environment-provider-host/src/git-queries.ts` becomes the single owner of:
   - `getAbsoluteGitDir(cwd, options)`: moved verbatim from host-workspace lines 544-563. It throws `new WorkspaceError("git_command_failed", …)` on empty output and returns `path.resolve(gitDir)`.
   - `readCheckoutRef(cwd, options)`: the unguarded body of today's `getCheckoutRef`, with a private `readHeadSha`.
   - `readHasUncommittedChanges(cwd, options)`: the porcelain status, non-empty after trim. It has no guard.
   - `readGitOperation(cwd, options)`: the git dir and status in parallel, conflicts from the first two characters of each line, and markers probed in parallel with the first match in list order winning (the plugin's algorithm). It has no guard.
   - The module-level constants `CONFLICT_PORCELAIN_STATUSES` and `GIT_OPERATION_MARKERS`, a private `pathExists` (`fs.access` try/catch, identical to `packages/process-utils/src/paths.ts:41-49`) and a private `readPorcelainStatusV1`.
   - The exported result types:
     ```ts
     export type GitCheckoutRefReading =
       | { kind: "branch"; branchName: string; headSha: string }
       | { kind: "unborn"; branchName: string }
       | { kind: "detached"; headSha: string }
       | { kind: "unknown"; reason: string };
     export type ActiveGitOperationKind = "rebase" | "merge" | "cherry-pick" | "revert";
     export type GitOperationReading =
       | { kind: "none" }
       | { kind: ActiveGitOperationKind; hasConflicts: boolean };
     ```
     These shapes are assignable to both the plugin contract types (`plugins/environment-project-checkout/contract.ts:27-56`) and the broader domain types (`packages/domain/src/git-checkout.ts:57-104`, where `headSha` is nullable and the operation union is split per kind). If TypeScript rejects assigning the union-discriminant object to the domain's per-kind union, use one `switch` in the factory that returns per-kind object literals, as today's `buildActiveWorkspaceGitOperation` does, and type `GitOperationReading` per kind.
2. host-workspace keeps its exported names and its guards:
   - `getCheckoutRef` = `detectGitSource` guard, then `readCheckoutRef`;
   - `getWorkspaceGitOperation` = `ensureGitRepo`, then `readGitOperation`;
   - `hasUncommittedChanges` = `ensureGitRepo`, then `readHasUncommittedChanges`;
   - `getAbsoluteGitDir` becomes part of the factory destructure.

   host-workspace deletes its local readers, constants, marker search, `buildActiveWorkspaceGitOperation`, `hasPorcelainConflict`, `parsePorcelainEntries` and the porcelain v1 path decoder.
3. Project checkout keeps `pathExists`, `locateBranch` and a guarded `getCheckoutRef` (a `detectGitRepo` guard, then `readCheckoutRef`) in `host/git.ts`. It imports `readGitOperation` and `readHasUncommittedChanges` from `omnyo-environment-provider-host/git`.

*Preservation argument.*

- **Error semantics.** The factory calls the injected `runGit` and the injected `WorkspaceError` constructor. Command failures therefore keep each caller's error class, codes and messages: host-workspace's `createGitCommandFailedError`, or environment-provider-host's. The guards stay with the callers, so host-workspace still throws `not_git_repo` from `ensureGitRepo` and the plugin still lets a non-repository fail through `runGit`. Both current callers pre-check the repository kind anyway (`host-branches.ts:288-300`; `checkout.ts:263`, `293-309`). The only new error path is the plugin's empty `--absolute-git-dir` output, which now throws `git_command_failed` instead of probing markers relative to the process directory. Git does not produce that output with exit code 0, so this is not an observable change in practice.
- **Bare repositories.** host-workspace keeps `detectGitSource`, so a bare root still reports `branch` (`git.test.ts:183`, `status-process.e2e.ts:367`). The plugin keeps `detectGitRepo`, so a bare root still reports `unknown`.
- **Options.** Every factory function takes `options: GitTimeoutOptions = {}` and spreads `{ cwd, ...options }` into `runGit`, as the existing factory functions do. host-branches forwards only `shellPath` (`apps/host-daemon/src/user-executable-env.ts:1-7`), so nothing it sends is dropped.
- **Precedence and timing.** Marker precedence (rebase, then merge, then cherry-pick, then revert) is preserved by an ordered `find` over the results, as the plugin test asserts. host-workspace changes from sequential to parallel marker probes. That means up to five concurrent `fs.access` calls instead of up to five sequential ones. The returned value is the same. This is a deliberate unification on the plugin's tested behavior, and it is the pattern the global async guidance asks for.
- **Subprocess count.** It is unchanged: the same git commands run the same number of times.
- **Persisted formats, RPC contracts and UI.** Nothing persisted changes. The `checkoutHostContract` zod schemas and the daemon RPC result shapes are untouched, and no UI changes.

*Non-goals.*

- Do not merge the removal-safety marker lists (RF-065).
- Do not reuse one `git status` call for both dirty state and operation, and do not drop the redundant guard spawns. That is a separate performance change; see the incidental finding returned with this card.
- Do not change `parsePorcelainV2StatusZ`.

**Expected gain and cost**

The counting scope is non-blank handwritten production lines, measured with `sed -n 'A,Bp' <file> | grep -cv '^\s*$'` on the snapshot blobs. All after-change figures are projections.

| Item | Lines |
|---|---|
| Plugin `host/git.ts` removed (`readHeadSha` plus `getCheckoutRef` body, lines 20-64: 36; constants, status, dirty and operation, lines 81-154: 62) | −98 |
| host-workspace readers removed (types at lines 89-92 and 101-104: 8; constants at lines 111-126: 15; marker search: 12; `readHeadSha` plus `getCheckoutRef`: 45; conflict, builder and operation: 49; `hasUncommittedChanges`: 16) | −145 |
| host-workspace porcelain v1 decoder removed (lines 106-109: 4; lines 128-138: 11; lines 673-790: 93; `parsePorcelainEntries`: 17) | −125 |
| `getAbsoluteGitDir` moved from host-workspace to the factory | ±17 (moved, not counted as deleted) |
| Factory additions excluding the moved helper (types, constants, `pathExists`, `readHeadSha`, `readCheckoutRef`, status, conflict check, `readGitOperation`, dirty check, return entries) | +110 to +135 (projected) |
| host-workspace guarded wrappers and destructure additions | +20 to +28 (projected) |
| Plugin guarded `getCheckoutRef` wrapper and import changes | +6 to +10 (projected) |
| **Net production** | **about −195 to −230** (projected), of which about 125 is the dead decoder |

- **Tests:** about −63 lines (the `describe("parsePorcelainEntries")` block in `packages/host-workspace/test/git.test.ts:480-542`). The 34-line plugin test `host/git.test.ts` moves to a factory-level test of similar size. Real-git tests stay unchanged.
- **Mechanisms:** two implementations of three checkout readers become one, two copies of the marker and conflict lists become one, two `--absolute-git-dir` readers in these paths become one, and one parser, used only for an unread field, disappears.
- **Maintenance example:** adding display support for a new in-progress state, or correcting the conflict rule, changes from two identical edits in two packages to one edit in `git-queries.ts`.
- **Performance:** neutral for subprocesses. host-workspace's marker probes become concurrent, which is the same or faster. The environment-provider-host factory object is bundled into the git-worktree and temporary-copy host bundles too, which adds about 110 to 135 lines of source to each. **Hypothesis:** the size cost is negligible; it was not measured.
- **Cost:** a new export surface on a private package, and the git-worktree and temporary-copy plugins must keep typechecking because they import `omnyo-environment-provider-host/git`.

**Execution steps**

1. **Reconfirm the anchors** at the target commit. Run `git grep -n -w "getCheckoutRef\|getWorkspaceGitOperation\|hasUncommittedChanges\|parsePorcelainEntries\|parsePorcelainPath\|getAbsoluteGitDir"` and confirm the consumers listed in "Context and evidence". **Stop and re-plan** in any of these cases:
   - a new production caller of `parsePorcelainEntries` or `parsePorcelainPath` exists. Then keep the decoder and drop only the reader duplication.
   - `environment-project-checkout` was added to `scripts/forkable-plugins.json`. Then the shared code must go through the packed plugin SDK instead.
   - RF-010 has already reshaped `createGitQueries`. Then rebase onto its structure.
2. **Checkpoint A: factory.** In `packages/environment-provider-host/src/git-queries.ts`:
   - Add `import fs from "node:fs/promises"` and the module-level `CONFLICT_PORCELAIN_STATUSES`, `GIT_OPERATION_MARKERS` and `pathExists`.
   - Add the exported `GitCheckoutRefReading`, `ActiveGitOperationKind` and `GitOperationReading` types.
   - Inside `createGitQueries`, add:
     ```ts
     async function getAbsoluteGitDir(cwd, options: GitProcessOptions & { signal?: AbortSignal } = {}): Promise<string>  // verbatim move from host-workspace git.ts:544-563
     async function readHeadSha(cwd, options: GitTimeoutOptions = {}): Promise<string | null>
     async function readCheckoutRef(cwd, options: GitTimeoutOptions = {}): Promise<GitCheckoutRefReading>  // no guard
     async function readPorcelainStatusV1(cwd, options: GitTimeoutOptions = {}): Promise<string>
       // runGit(["--no-optional-locks","status","--porcelain=v1","--untracked-files=all"], { cwd, ...options })
     async function readHasUncommittedChanges(cwd, options: GitTimeoutOptions = {}): Promise<boolean>
     async function readGitOperation(cwd, options: GitTimeoutOptions = {}): Promise<GitOperationReading>
       // const [gitDir, status] = await Promise.all([getAbsoluteGitDir(cwd, options), readPorcelainStatusV1(cwd, options)]);
       // hasConflicts = status.split("\n").filter(l => l.length >= 2).some(l => l[0]==="U" || l[1]==="U" || CONFLICT_PORCELAIN_STATUSES.has(l.slice(0,2)));
       // probe all markers with Promise.all; kind = first non-null in GIT_OPERATION_MARKERS order; else { kind: "none" }
     ```
   - Add the four public functions to the returned object.
   - In `packages/environment-provider-host/src/git.ts:293`, extend the destructure to `export const { getGitCommonDir, detectGitRepo, getCurrentBranch, getAbsoluteGitDir, readCheckoutRef, readGitOperation, readHasUncommittedChanges } = gitQueries;`. Before doing so, check that no existing export named `getAbsoluteGitDir` collides; the snapshot has none.
   - Verify with `pnpm --filter omnyo-environment-provider-host typecheck`.
3. **Checkpoint B: host-workspace.** In `packages/host-workspace/src/git.ts`:
   - Add `getAbsoluteGitDir`, `readCheckoutRef`, `readGitOperation` and `readHasUncommittedChanges` to the factory destructure at lines 565-572. Keep `getAbsoluteGitDir` exported under the same name, because `checkout-mutation-lock.ts:7` and `workspace-write-roots.ts:3` import it.
   - Delete the local `getAbsoluteGitDir` (lines 544-563), `ActiveWorkspaceGitOperationKind`, `WorkspaceGitOperationMarker`, `ParsedPorcelainPathToken`, `CONFLICT_PORCELAIN_STATUSES`, `WORKSPACE_GIT_OPERATION_MARKERS`, `GIT_QUOTED_PATH_ESCAPE_BYTES`, `findWorkspaceGitOperationMarker`, `readHeadSha`, the decoder chain from `appendUtf8Bytes` through `parsePorcelainPath` (lines 673-790), `parsePorcelainEntries`, `hasPorcelainConflict` and `buildActiveWorkspaceGitOperation`.
   - Replace the three exported readers with guarded wrappers that keep today's signatures:
     ```ts
     export async function getCheckoutRef(cwd: string, options: GitTimeoutOptions = {}): Promise<GitCheckoutRef> {
       if (!(await detectGitSource(cwd, options))) return { kind: "unknown", reason: "Path is not a git repository" };
       return readCheckoutRef(cwd, options);
     }
     export async function getWorkspaceGitOperation(cwd: string, options: GitProcessOptions = {}): Promise<WorkspaceGitOperation> {
       await ensureGitRepo(cwd, options);
       return readGitOperation(cwd, options);
     }
     export async function hasUncommittedChanges(cwd: string, options: GitProcessOptions = {}): Promise<boolean> {
       await ensureGitRepo(cwd, options);
       return readHasUncommittedChanges(cwd, options);
     }
     ```
   - Remove `pathExists` from the `@omnyo/process-utils` import if nothing else in the file uses it; at the snapshot, line 591 is its only use.
   - In `packages/host-workspace/test/git.test.ts`, delete the `parsePorcelainEntries` import (line 13) and the `describe("parsePorcelainEntries")` block (lines 480-542), because their subject no longer exists. Keep every real-git `getCheckoutRef` and `getWorkspaceGitOperation` test unchanged as the independent baseline.
   - Verify with `pnpm --filter @omnyo/host-workspace typecheck`, `pnpm --filter @omnyo/host-workspace lint` and `pnpm --filter @omnyo/host-workspace test`.
4. **Checkpoint C: Project checkout.**
   - In `plugins/environment-project-checkout/host/git.ts`, delete `readHeadSha`, the body of `getCheckoutRef`, `CONFLICT_PORCELAIN_STATUSES`, `GIT_OPERATION_MARKERS`, `readPorcelainStatus`, `hasUncommittedChanges` and `getWorkspaceGitOperation`. Keep `pathExists` and `locateBranch`.
   - Keep a guarded `getCheckoutRef(cwd)`: `detectGitRepo` returning false gives `{ kind: "unknown", reason: "Path is not a git repository" }`; otherwise return `readCheckoutRef(cwd)`.
   - Drop the `node:path` import and the `WorkspaceGitOperation` type import if they become unused.
   - In `host/checkout.ts:12-18`, import `readGitOperation` and `readHasUncommittedChanges` from `omnyo-environment-provider-host/git`. Rename the call sites at lines 101, 117 and 269-270 to the new names, or alias the imports to the old names in the same statement; choose one form.
   - Move the parallel-probe and precedence test from `host/git.test.ts` to a factory-level test that calls `createGitQueries(fakeRunGit, Error).readGitOperation("/repo")` with the same `fs.access` spy and assertions: five pending probes, and a result of `{ kind: "rebase", hasConflicts: true }`. environment-provider-host has no test script, so place the test in `packages/host-workspace/test/git-queries.test.ts`, which the existing vitest `include` (`test/**/*.test.ts`) picks up. Then delete `plugins/environment-project-checkout/host/git.test.ts`, because the plugin no longer owns that logic. Name the deletion in the change report.
   - Verify with `pnpm --filter omnyo-plugin-environment-project-checkout typecheck` and `pnpm --filter omnyo-plugin-environment-project-checkout test`.
5. **Neighbouring consumers of `omnyo-environment-provider-host/git`.** Run `pnpm --filter omnyo-plugin-environment-git-worktree typecheck` and `pnpm --filter omnyo-plugin-environment-temporary-copy typecheck`. Also run `pnpm --filter @omnyo/host-daemon typecheck` and `pnpm --filter @omnyo/host-daemon test -- test/command/host-branches-dispatch.test.ts`.
6. **Format and lint the changed files** as the global agent instructions require for this Oxc repository: `pnpm exec oxlint --fix <files>`, `pnpm exec oxfmt <files>`, then `pnpm exec oxlint --deny-warnings --format=agent`.
7. **Inspect the full diff.** Confirm that it contains no unrelated edits, that no second copy of the markers, conflict codes or `--absolute-git-dir` reader remains in these two packages, and that the line reduction matches this card. Recount with the same `grep -cv '^\s*$'` method.

**Verification and acceptance criteria**

The commands below come from the package.json scripts at the snapshot and run from the repository root. They were not executed, because the snapshot has no node_modules.

- `pnpm --filter omnyo-environment-provider-host typecheck`. The package has only `typecheck` and `clean` scripts and no tests.
- `pnpm --filter @omnyo/host-workspace typecheck`, `pnpm --filter @omnyo/host-workspace lint` and `pnpm --filter @omnyo/host-workspace test`. Expect `test/git.test.ts` "getCheckoutRef" (bare root gives `branch`; branch; detached; unborn) and "getWorkspaceGitOperation" (none; merge conflicts; rebase conflicts) to pass unchanged, and the new `test/git-queries.test.ts` parallel-probe test to pass.
- `pnpm --filter omnyo-plugin-environment-project-checkout typecheck` and `pnpm --filter omnyo-plugin-environment-project-checkout test`. Expect `host.test.ts` (real git: inspect and attach, including the dirty, conflict and in-progress blockers) and `server.test.ts` to pass unchanged.
- `pnpm --filter @omnyo/host-daemon test -- test/command/host-branches-dispatch.test.ts`. Expect dirty primary checkout and bare-root inspection to pass unchanged. The `--` file filter is standard vitest argument passing; that the filter works was not confirmed.
- `pnpm --filter omnyo-plugin-environment-git-worktree typecheck` and `pnpm --filter omnyo-plugin-environment-temporary-copy typecheck`.
- `packages/host-workspace/test/status-process.e2e.ts` asserts invalid-path `unknown` and bare-clone `branch`. **No runner was found:** it is outside the vitest include, and no script references it. Run it only if a later inspection finds its documented invocation. Its assertions are already covered by `git.test.ts:183` and the wrapper's unchanged guard.
- Behavioural acceptance:
  - The returned values for none, merge, rebase, cherry-pick and revert, each with and without conflicts, are unchanged.
  - A bare root stays `branch` through host-workspace and `unknown` through Project checkout.
  - `shellPath` reaches every git call. Check this by reading the code: each new factory function spreads `options`.
- Structural acceptance:
  - `git grep -n "CHERRY_PICK_HEAD"` in `packages/host-workspace/src` and `plugins/environment-project-checkout` returns no hits.
  - `git grep -n "parsePorcelainEntries\|parsePorcelainPath"` returns no hits.
  - The marker and conflict constants exist only in `git-queries.ts`, apart from the separate removal-safety lists that RF-065 owns.
- Performance: the same commands run with the same counts. No benchmark is required. Spot-check by reading that `hasUncommittedChanges` and `getWorkspaceGitOperation` each still run exactly one `git status`.

**Rollback and stop conditions**

- **Rollback:** a pure code revert of the change commit. Nothing is persisted, no data migration is involved, and the RPC contracts do not change.
- **Stop conditions:**
  - A production caller of `parsePorcelainEntries` appears. Then keep the decoder and ship only the reader consolidation.
  - TypeScript cannot assign the factory's operation type to the domain `WorkspaceGitOperation` without a cast. Then type `GitOperationReading` per kind and build it with one switch in the factory; do not add casts.
  - A real-git test result changes. Treat that as a semantic difference: restore the old behavior, and do not update the expected values.
  - The plugin joins the forkable list. Then the plan is invalid, because shared code must come through the plugin SDK. Keep the plugin's local copy and consolidate only within host-workspace.
- **Smaller safe alternative:** if the cross-package change is blocked, delete the porcelain v1 decoder alone within host-workspace. Replace `hasPorcelainConflict(parsePorcelainEntries(...))` with the two-character check and keep everything else. This keeps about 125 of the lines removed.
