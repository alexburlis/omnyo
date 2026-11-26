# RF-057 — Remove the private desktop publication-retention writer from the public `@omnyo/process-utils` copy, keeping only the reader lease the server uses

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted and conditional. The central claim holds: in the public repository nothing calls the desktop publication planner, applier, verifier or storage-budget check. Their only callers are private release scripts in the retired private repository, which keeps its own byte-identical copy of the file. The sweep's line estimate and its plan for the test-only digest helper are corrected below.
- **Potential:** medium. About 420 to 470 handwritten production lines disappear from the public repository, together with a second maintained copy of a release-only writer that the public repository can neither run nor test.
- **Confidence:** high that the code is unreachable from public entry points. Medium on the plan, because it depends on how commits move between the two repositories.
- **Readiness:** decision-needed. Alex must decide where private release tooling lives and how changes to `packages/process-utils` reach the private repository (see the investigation gate in step 1).
- **Effort:** about 1.5 to 2.5 hours once the decision is made: the edit, a test-helper move, focused checks and a parity check against the private copy.
- **Risk:** low for public runtime behavior, because the retained reader lease stays byte-identical. The real risk is organizational. If public commits are later ported wholesale into the private repository, or private release tooling is re-pointed at the public checkout, `scripts/private-ship-coordinator.mjs` loses six imports and every private desktop release fails at import time.
- **Prerequisites:** the owner decision in step 1. No other RF is a prerequisite.
- **Related and overlapping:** RF-079 ("Delete small orphaned helpers kept alive only by their own tests"). `runtimePublicationTreeDigest` is the kind of helper RF-079 targets; count its lines here only. RF-112 ("Define desktop release-channel identity once"): deleting `manifestValid` removes one of the restated `["latest", "nightly"]` channel lists. RF-034 and RF-084 cover the separate desktop JSON version feed and do not touch this file.
- **Why this place:** it is a clean, mechanical deletion with a proven reachability argument inside the public repository and a small blast radius. It ranks below behavior-preserving consolidations of live code because it needs an owner decision and its maintenance gain is limited: the writer changes rarely, and only when private release tooling changes.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The prepared snapshot worktree was no longer present when this card was written, so every public file was read with `git show <commit>:<path>` from `$OMNYO_CHECKOUT`. All public files cited here are unchanged between that commit and local `HEAD` 5f2d3f895 (`git diff --stat <commit> HEAD` on those paths printed nothing). The retired private repository was read at its `HEAD` 52b7fdf012 (2026-11-23) with `git -C $ARCHIVED_OMNYO_CHECKOUT show/grep HEAD:...`.

What the subsystem does. Private Omnyo desktop builds download updates from the coordinator's private feed. The server route in `apps/server/src/routes/private-update-feed.ts` serves files from `<dataDir>/private-updates/<channel>/<sourceCommit>/<platform>/<name>`. While it serves a file, it holds a *reader lease*: a JSON file in `<channel>/.readers/` that tells the release-side retention job not to delete that release yet. The release side lives in the private repository. That code publishes new desktop payloads, verifies them against an approved manifest, checks a storage budget, then plans and applies removal of old releases while honoring the reader leases, the approved and previous-approved manifests, and recovery receipts.

Both halves live in one file, `packages/process-utils/src/publication-retention.mjs` (558 lines; 465 non-blank lines, counted with `grep -c -v '^\s*$'`).

Observed facts (Proven by inspection):

| Lines | Symbol | Role | Public consumer at snapshot |
|---|---|---|---|
| 1-24 | imports, `sourcePattern`, `shaPattern`, `filenamePattern`, `absent`, `hash` | shared constants | partly used by the reader half |
| 26 | `physicalDirectory` | directory guard | the reader half |
| 37 | `withPublicationLock` (exported) | `.publication-lock` mkdir lock | called internally by `acquirePublicationReader` only |
| 66 | `acquirePublicationReader` (exported) | reader lease | `apps/server/src/routes/private-update-feed.ts:5` (import) and `:160` (call), through `packages/process-utils/src/index.ts:45` |
| 94 | `jsonFile` | metadata reader | writer half only |
| 104 | `fileIdentity` | streamed sha256 plus stat signature | `verifyDesktopPublication`, `inspectTree`, `runtimePublicationTreeDigest` |
| 127 | `manifestValid` | approved-manifest check | writer half only |
| 148 | `verifyDesktopPublication` (exported, declared in `.d.mts`) | payload verification | none |
| 167, 202, 222, 237 | `readerBindings`, `inspectTree`, `activeReceiptOwner`, `desktopPlan` | retention planner internals | none outside the file |
| 410 | `planDesktopPublicationRetention` (exported) | plan | none |
| 414 | `saveRetentionJournal` | `.retention.json` journal | none outside the file |
| 428 | `applyDesktopPublicationRetention` (exported) | apply | none |
| 492 | `runtimePublicationTreeDigest` (exported, declared) | runtime tree digest written by the private coordinator | test only: `packages/omnyo-app/test/app-update-npm-revision.test.ts:12` and `:164` |
| 521 | `assertPublicationStorageBudget` (exported) | storage budget | none |

The search that establishes the public consumers ran across the whole tree at the snapshot, not only under the default ignore scope:

```sh
git grep -n -E "publication-retention|planDesktopPublicationRetention|applyDesktopPublicationRetention|verifyDesktopPublication|assertPublicationStorageBudget|runtimePublicationTreeDigest|withPublicationLock|acquirePublicationReader|omnyo-desktop-publication|omnyo-desktop-retention|omnyo-publication-reader|\.publication-lock|\.retention\.json|\.publication\.json" e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e -- .
```

Outside the file itself, it matched only these locations:

- `packages/process-utils/src/index.ts:45`, which re-exports only `acquirePublicationReader`.
- `apps/server/src/routes/private-update-feed.ts:5,160`.
- `packages/omnyo-app/test/app-update-npm-revision.test.ts:12,164`, which reaches past the package exports through the relative path `../../process-utils/src/publication-retention.mjs`.
- `packages/omnyo-app/src/app-update/npm-revision.ts:130,172,307,422`. These lines read `.publication.json` runtime markers through the module's own reimplementation `runtimeTreeDigest` (`npm-revision.ts:161`). They do not import this file.

`packages/process-utils/package.json` has no subpath export for the file, so the writer functions are not reachable through the package API. No docs, JSON configuration, Containerfile or launch configuration in the public tree names them: a search of `*.md`, `*.json`, `*.yml`, `*.ts`, `*.mjs` and `*.cjs` for `publication retention|publication-retention|\.readers/` matched only the two code references above. The public tree contains no `scripts/private-*` files (`git ls-tree -r --name-only <commit> | grep "^scripts/private"` printed nothing), and the root `package.json` defines no `private:*` scripts.

The real consumers are in the retired private repository. There, `git grep` at `HEAD` finds them in:

- `scripts/private-publication-retention.mjs:5-6,13,32`: `planDesktopPublicationRetention` and `applyDesktopPublicationRetention`.
- `scripts/private-ship-coordinator.mjs:3-8`: it imports `assertPublicationStorageBudget`, `runtimePublicationTreeDigest`, `withPublicationLock`, `verifyDesktopPublication`, `planDesktopPublicationRetention` and `applyDesktopPublicationRetention`, and uses them at `:1193`, `:1249`, `:1311`, `:1435`, `:3858`, `:3877`, `:3924-3934`, `:3954-3955` and `:3967-3971`.
- `scripts/private-publication-retention.test.mjs` (237 lines), which is the only test of the writer half. The public repository has no test of the writer half.

The private copies of `publication-retention.mjs`, `publication-retention.d.mts` and `private-update-feed.ts` are byte-identical to the public ones (`cmp` printed nothing for each pair).

Why both copies exist (Proven by inspection). Public commit 060950255, "Publish Omnyo source" (2026-11-24), is a parentless commit that added 9,010 files. It is a filtered export of the private source that left out `scripts/private-*` and `docs/private-*` but kept all of `packages/process-utils`. The writer half came along with the package even though its callers did not.

Current requirement (Proven by inspection). Private releases still run from the private store:

- Worktree `$AUDIT_WORKTREE` has its Git common directory in `$ARCHIVED_OMNYO_CHECKOUT/.git`, its `HEAD` is "Release private Omnyo 1.0.179 (iOS 96)" from 2026-11-25, and it contains `scripts/private-publication-retention.mjs`.
- The private store also holds commit 9d5d176d4a, "Release private Omnyo 1.0.181", from 2026-11-26, on branch `release/public-macos-1.0.181`.
- The private `AGENTS.md` describes `private:ship` and its retention closeout (lines 36-37, 48 and 54). The global instructions say verified private releases run under the scope set by that file.

Changes still move between the two repositories. Example: private commit 4a4500edbe (10:01) and public commit 936dfbf98 (10:08) on 2026-11-26 carry the same subject, "Keep mobile chats compact when plugin styles fail [skip ci]".

Counterevidence and limits:

- Hypothesis: the porting route between the repositories (cherry-pick, patch or tree reconciliation, and in which direction) is unknown. If `packages/process-utils` changes are reconciled whole-file from public into private, deleting the code here breaks the private release. This is the decision gate.
- The public repository also carries docs that point at missing private files. For example, `apps/desktop/README.md:259` links `docs/private-ship.md`. That gap is separate and outside this card.
- No test suite could run, because the snapshot has no `node_modules`. All claims here come from source inspection.

Maintenance cost today. Any change to the lease format (`schema`, `owner: "omnyo-publication-reader"`, `pid`) or to the lock (`.publication-lock`, 2-second deadline) has to stay compatible with `readerBindings` and `desktopPlan`. Those consumers exist in both repositories, but only the private copy has callers and tests. A public maintainer reading `process-utils` sees about 400 lines of release-retention logic they cannot exercise. Separately, the runtime tree-digest format is defined twice in the public tree: once as the writer `runtimePublicationTreeDigest`, which in public serves only as a test oracle, and once as the reader `runtimeTreeDigest` in `npm-revision.ts:161`.

**Proposed end state and preservation argument**

Preferred outcome (option A: private release tooling stays in the private repository):

- `packages/process-utils/src/publication-retention.mjs` keeps only the reader-lease half: `sourcePattern`, `physicalDirectory`, `withPublicationLock` and `acquirePublicationReader`, byte-identical to lines 16, 26-92 of the snapshot, with the imports trimmed to `randomUUID`, `lstat`, `mkdir`, `realpath`, `rm`, `writeFile`, `isAbsolute`, `join` and `resolve`.
- `withPublicationLock` stops being exported, because nothing outside the file uses it in public. Keep the export instead if the owner wants the retained half to stay a strict textual subset of the private copy.
- `publication-retention.d.mts` declares only `acquirePublicationReader`, plus `withPublicationLock` if it stays exported.
- The `runtimePublicationTreeDigest` oracle moves into `packages/omnyo-app/test/app-update-npm-revision.test.ts` as a local test helper. It stays an independent implementation of the writer's digest format and does not import `runtimeTreeDigest` from production. That keeps the test's cross-check meaningful: the reader must accept a marker produced by a separately written writer.
- The private repository keeps its complete copy and remains the only owner of the writer, its CLI wrapper and its test.

What survives unchanged:

- The `/private-updates/:channel/:platform/:file` route and its lease semantics: the lease file name, contents and mode, the lock path and deadline, and every error message.
- The `pruneNpmRevisions` behavior and its test expectations.
- The private release pipeline, which never imported the public copy.

Why this is the simplest option: it removes only code with no public caller and changes no runtime path. Moving the scripts into public (option B) would add about 4,000 lines of private release tooling and secrets wiring to a public repository. Keeping both full copies (option C) preserves today's duplication.

Alternatives the owner may choose instead:

- **Option B:** private release tooling moves into the public repository. Then this card closes as *retain*. Moving the scripts is a separate migration project, not a simplification, and is out of scope here.
- **Option C:** the two repositories are deliberately kept identical for `packages/process-utils`, for example by tree reconciliation. Then this card closes as *retain*, and the index should record that the writer half is kept for private-repository parity.

Non-goals:

- Retiring the reader lease or the private update feed in public. The route serves only private-release installations, but removing it changes server behavior and belongs to the private-feed or desktop-feed decisions, not here.
- Renaming the file.
- Merging the reader-side `runtimeTreeDigest` with the writer digest.
- Fixing the public docs that link missing private files.

Reachability proof and remaining uncertainty. Supported public entry points reach the file only through `@omnyo/process-utils` `index.ts:45` (`acquirePublicationReader`) and through one test's relative import. The package has no subpath export, so external plugins and older clients cannot import the writer: process-utils is `"private": true` and is not part of the published SDK or plugin SDK. The remaining uncertainty is only the cross-repository porting route.

**Expected gain and cost**

All figures are projections from the snapshot. Raw lines are counted with `sed -n` ranges; non-blank lines with `grep -c -v '^\s*$'`.

| Item | Option A1: keep the digest in production | Option A2 (preferred): move the digest oracle into the test |
|---|---|---|
| Production lines removed from `publication-retention.mjs` | about 420 raw (about 350 non-blank): lines 94-103, 127-491 and 521-558, plus about 8 import and constant lines | about 470 raw (about 390 non-blank): adds lines 104-125 and 492-519 |
| Production lines removed from `publication-retention.d.mts` (13 lines) | 4 | 8 |
| Test lines added | 0 | about 30, a local digest helper in `app-update-npm-revision.test.ts` |
| Production exports removed | `verifyDesktopPublication`, `planDesktopPublicationRetention`, `applyDesktopPublicationRetention`, `assertPublicationStorageBudget` | the A1 exports plus `runtimePublicationTreeDigest` and, optionally, `withPublicationLock` |

Mechanism change, before and after:

- **Before:** two maintained copies of the release-side retention writer, one of them with no callers or tests, and one public module mixing a runtime lease with release tooling.
- **After:** the writer has one owner, the private repository, next to its callers and its test. The public module contains only what the public server runs. The runtime-digest format appears in public production once, in `npm-revision.ts`.

Maintenance example. Today a change to the lease format requires reading `readerBindings` and `desktopPlan` in the public tree to judge compatibility, even though they cannot run there. After the change, the public change touches only `acquirePublicationReader`, and the private repository's own test (`scripts/private-publication-retention.test.mjs:98`, "withReader") guards compatibility where the reader of the lease actually lives.

Costs and tradeoffs:

- The public and private copies of `publication-retention.mjs` stop being byte-identical. Any later port of this file must be path-aware.
- Performance: neutral. No runtime code path changes, and the server bundle loses unused code only.

**Execution steps**

1. **Investigation gate (do not edit before this passes).**
   - Ask the owner which option applies (A, B or C) and how commits reach the private repository for `packages/process-utils`.
   - Confirm the current state:
     - From `$OMNYO_CHECKOUT`, run `git grep -n -E "planDesktopPublicationRetention|applyDesktopPublicationRetention|verifyDesktopPublication|assertPublicationStorageBudget|runtimePublicationTreeDigest|withPublicationLock" HEAD -- .`. It should still match only the file itself, `publication-retention.d.mts` and `packages/omnyo-app/test/app-update-npm-revision.test.ts`.
     - Run `git -C $ARCHIVED_OMNYO_CHECKOUT grep -n "publication-retention.mjs" HEAD -- scripts`. It should show the private scripts importing their own `../packages/process-utils/src/publication-retention.mjs`, not a path into `$OMNYO_CHECKOUT`.
     - Search the private release scripts for any reference to the public checkout path. Run `git -C $ARCHIVED_OMNYO_CHECKOUT grep -n -E "projects/omnyo[^-]" HEAD -- scripts` and inspect the hits for source-directory resolution that could point at the public tree.
   - **Stop** and close this card as *retain* if:
     - Alex chooses B or C;
     - porting is whole-file or tree reconciliation from public into private;
     - any private script resolves `packages/process-utils` from the public checkout;
     - a new public caller of the writer exists.
   - If Alex chooses A with path-aware porting, record that decision wherever he keeps repository policy, so a later reconcile does not copy the deletion into private.

2. **Baseline.** Record:
   - `wc -l packages/process-utils/src/publication-retention.mjs packages/process-utils/src/publication-retention.d.mts`;
   - `git show HEAD:packages/process-utils/src/publication-retention.mjs | sed -n '16p;26,92p' | shasum` (the retained half, used for the later parity check).

3. **Checkpoint A: move the test oracle (option A2 only).**
   - In `packages/omnyo-app/test/app-update-npm-revision.test.ts`, replace the import at line 12 with a local `async function writerTreeDigest(root: string): Promise<string>`. It must reproduce the snapshot's `runtimePublicationTreeDigest` (lines 492-519) exactly:
     - walk with `readdir(...).sort()`;
     - skip `.publication.json` at the top level only;
     - for a symbolic link push `{ path, link: readlink }`; for a directory push `{ path, directory: true }` and recurse; for a regular file push `{ path, bytes, sha256 }` of its content;
     - throw for anything else;
     - return the sha256 hex digest of `JSON.stringify(records)`.
   - Read the file with `readFile` from `node:fs/promises` and hash it with `createHash`. The stat-signature check in `fileIdentity` is a writer-side race guard that the test does not need.
   - Do not import `runtimeTreeDigest` from `npm-revision.ts`. The test must keep an independent oracle.
   - Use the helper at line 164.
   - Run the omnyo-app test named below. It must pass unchanged in its expectations.

4. **Checkpoint B: trim the module.** In `packages/process-utils/src/publication-retention.mjs`:
   - Delete these symbols: `jsonFile`, `manifestValid`, `verifyDesktopPublication`, `readerBindings`, `inspectTree`, `activeReceiptOwner`, `desktopPlan`, `planDesktopPublicationRetention`, `saveRetentionJournal`, `applyDesktopPublicationRetention` and `assertPublicationStorageBudget`.
   - Under A2, also delete `fileIdentity` and `runtimePublicationTreeDigest`.
   - Delete the now-unused `shaPattern`, `filenamePattern`, `absent` and `hash`, and the unused imports: `createHash`, `createReadStream`, `readFile`, `readdir`, `readlink` and `rename`, plus `lstat` only if nothing still uses it (`physicalDirectory` does, so keep it).
   - Leave `sourcePattern`, `physicalDirectory`, `withPublicationLock` and `acquirePublicationReader` textually unchanged. Optionally drop `export` from `withPublicationLock`.
   - Under A1, keep `fileIdentity`, `hash`, `createHash`, `createReadStream`, `readdir`, `readlink` and `runtimePublicationTreeDigest`.

5. **Checkpoint C: declarations.** In `packages/process-utils/src/publication-retention.d.mts`, remove the `verifyDesktopPublication` declaration. Under A2, also remove `runtimePublicationTreeDigest`, and remove `withPublicationLock` if it is no longer exported. `packages/process-utils/src/index.ts:45` stays as it is.

6. **Parity and cleanup.**
   - Recompute the shasum of the retained functions from the edited file and compare it with the step 2 baseline. They must match, apart from a removed `export` keyword if you chose that.
   - From `$OMNYO_CHECKOUT`, rerun the step 1 `git grep`. It must find no writer symbol anywhere.
   - Inspect the full diff. Only the three files named above may change.
   - Recount with `wc -l` against the step 2 baseline and report the real reduction.

**Verification and acceptance criteria**

Run these from `$OMNYO_CHECKOUT` in a lane with installed dependencies. The package scripts were read from each `package.json` at the snapshot. None was executed for this audit, because the snapshot has no `node_modules`.

- `pnpm --filter @omnyo/process-utils typecheck` (script `tsc --noEmit`) and `pnpm --filter @omnyo/process-utils lint` (script `oxlint src`). Expected: pass. `index.ts:45` still resolves `acquirePublicationReader` through the `.d.mts`.
- `pnpm --filter @omnyo/server exec vitest run --config vitest.config.ts test/system/private-update-feed.test.ts`. This runs the test the `test` script would run, filtered to one file. Expected: pass. It exercises the live route that calls `acquirePublicationReader`, including the HEAD and GET paths and byte verification.
- `pnpm --filter omnyo-app exec vitest run --config vitest.config.ts test/app-update-npm-revision.test.ts`. Expected: all four `pruneNpmRevisions` cases pass, including "retires an owned superseded future candidate only after its publisher and exact contents close" (`:138`), which consumes the digest.
- `pnpm --filter omnyo-app typecheck` and `pnpm --filter @omnyo/server typecheck`.
- Formatting and lint for the changed files: `pnpm exec oxfmt --check packages/process-utils/src/publication-retention.mjs packages/process-utils/src/publication-retention.d.mts packages/omnyo-app/test/app-update-npm-revision.test.ts`, then `pnpm exec oxlint --deny-warnings --format=agent` with the same three paths. The root defines `format:check` as `oxfmt . --check`.
- Private side, unchanged, to confirm nothing there depended on the public copy. From `$ARCHIVED_OMNYO_CHECKOUT`, run `node --test scripts/private-publication-retention.test.mjs`. This runner is unconfirmed: the file uses `node:assert`, so `node --test` is likely but not proven, and the root `package.json` names no direct script for it. Running it needs that checkout's dependencies, and it must not start any release.
- Structural acceptance:
  - the writer symbols are absent from the public tree;
  - the retained lease code is byte-identical to the snapshot;
  - the private copy is untouched;
  - only the three named files changed.

**Rollback and stop conditions**

Rollback: revert the single commit. No persisted format, data directory or migration changes. Lease files, `.publication-lock` and `.retention.json` keep their formats because the private writer still owns them.

Stop and re-plan in any of these cases:

- The gate in step 1 shows whole-file porting into private, or a private script that resolves process-utils from the public checkout.
- Alex chooses option B or C.
- A new public caller of any writer symbol appears.
- The retained functions cannot stay byte-identical. That would change lease semantics, which belongs to a separate, tested change.
- The omnyo-app digest test fails after the oracle moves. That means the copied helper diverged from the writer format: compare it with the private `runtimePublicationTreeDigest`, and do not edit the test's expectations.

The safer smaller alternative, if the gate is inconclusive: delete only `verifyDesktopPublication` from the public `.d.mts` and leave the module alone. That is worth little, so prefer closing the card as *retain* with the decision recorded.
