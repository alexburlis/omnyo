# RF-002 — Delete the unused @parcel/watcher subprocess backend (proxy, fork channel, child entry) and the shipped `omnyo-parcel-watcher-child.mjs` bundle

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The central claim holds: nothing in production creates the subprocess backend. The sweep report missed two consumers that must change (`apps/server/test/app/omnyo-app-artifact.test.ts:63` and `apps/host-daemon/src/test/fixtures/prepare-workspace-io-fixture.mjs:20`) and two that must stay (`packages/server-archive/src/legacy-runtime-identity-v1.ts:32` and `scripts/omnyo-runtime-path-map.mjs:16`). It also proposed deleting `parcel-watcher-proxy.test.ts` whole, but three of its cases are the only tests of production `RootSubscription` behavior. Those three cases must be ported to a fake in-process backend before the file goes.
- **Potential:** high. About 970 handwritten production lines and one shipped bundle disappear, along with a self-healing process supervisor (ping, respawn, back-off, replay) that nobody runs.
- **Confidence:** high. The absence of callers is proven by inspection and by history (see Context).
- **Readiness:** ready.
- **Effort:** about half a day to one day. The deletions are mechanical; porting the three `RootSubscription` tests takes the most care.
- **Risk:** low. The realistic regression is a partial edit. If the launcher still requires the file after the build stops emitting it, every host start fails with "Missing parcel watcher child". All file lists must change in one commit.
- **Prerequisites:** none.
- **Related and overlapping items:** RF-101 (derive the daemon child-bundle inventory from `bundle-manifest.mjs`). RF-002 can land first and edit the lists by hand, or land after RF-101 and edit only the manifest. Either order works, but whichever lands second must rebase onto the other. RF-012 (retire the BB-to-Omnyo rename tooling) owns `scripts/omnyo-runtime-path-map.mjs`, so RF-002 leaves that file alone.
- **Why it deserves its place:** every `@parcel/watcher` upgrade or event-contract change today has to keep a second, never-executed backend (about 900 lines plus about 2,190 test lines) consistent with the one that runs. Removing it leaves one watcher backend and one fewer artifact that every build, package and launcher check has to know about.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The dedicated snapshot worktree had been removed by the time of verification, so every file was read with `git -C $OMNYO_CHECKOUT show e9e1b74c:<path>` and searched with `git grep <pattern> e9e1b74c -- .`. `git diff --stat e9e1b74c 5f2d3f895` (local `main` at verification time) showed no changes under `packages/host-watcher`, `apps/host-daemon/src/workspace-observer-child.ts`, `apps/host-daemon/scripts/bundle-manifest.mjs`, `packages/omnyo-app` or `tests/qa/worker-update-checkpoint`. No tests were run, because the snapshot has no `node_modules`.

*How file watching works now (Proven by inspection).* The host daemon forks one workspace observer child (`apps/host-daemon/src/workspace-observer-client.ts:77`, bundled as `omnyo-workspace-observer-child.mjs`). That child calls `setParcelWatcherBackend({...})` at `apps/host-daemon/src/workspace-observer-child.ts:35`. The call installs an in-process backend that calls `parcelWatcher.subscribe` directly, converts batches over 10,000 events into the error "Watcher event batch was too large to deliver" (lines 56-61), and reports `backend-failure` to the daemon (lines 47-51, 66-73). `RootSubscription` (`packages/host-watcher/src/root-subscription.ts:157`) reads the backend via `getParcelWatcherBackend()`. When nothing is installed, that getter falls back to `createInProcessBackend()` (`packages/host-watcher/src/parcel-watcher-backend.ts:123-133`). Whole-process isolation of the observer child now provides the crash containment that the subprocess backend used to provide.

*The unused machinery (Proven by inspection).*
- `packages/host-watcher/src/parcel-watcher-backend.ts:106` `createSubprocessParcelWatcherBackend` wraps `createParcelWatcherProxy` (`parcel-subprocess/parcel-watcher-proxy.ts:89`) around `createForkChannel` (`parcel-subprocess/fork-channel.ts:88`). The fork channel forks `omnyo-parcel-watcher-child.mjs`, which is built from `parcel-subprocess/parcel-child-entry.ts`. That entry runs `createParcelChildHandler` (`parcel-subprocess/parcel-child-handler.ts:31`) over `realParcelWatcher` (`packages/host-watcher/src/real-parcel-watcher.ts:4`). The two sides talk through `parcel-subprocess/messages.ts`.
- `disposeParcelWatcherBackend` (`parcel-watcher-backend.ts:135`) exists only to dispose an installed proxy. Its callers are tests only.
- `packages/host-watcher/src/index.ts:13-17` exports `createSubprocessParcelWatcherBackend`, `disposeParcelWatcherBackend` and `setParcelWatcherBackend`. The package is `"private": true` (`packages/host-watcher/package.json`), so it is not a published SDK surface and has no external consumers.

*Reachability search (Proven by inspection).* The following command was run at the snapshot over the whole repository:
`git grep -n -E 'createSubprocessParcelWatcherBackend|createParcelWatcherProxy|parcel-child-entry|parcel-child-handler|createForkChannel|parcel-watcher-proxy|parcel-watcher-child|realParcelWatcher|real-parcel-watcher|disposeParcelWatcherBackend|ParcelWatcherBackendLogger|setParcelWatcherBackend|parcel-subprocess' e9e1b74c -- .`
A second, case-insensitive search for `parcel[-_ ]?watcher[-_ ]?child|parcel child|watcherChild|PARCEL_WATCHER|OMNYO_PARCEL|parcelChild` was run over the same scope. Outside `packages/host-watcher`, the searches found only the consumers below. No production module, environment flag, CLI command or dynamic import selects the subprocess backend.

| Consumer | Kind | Action |
|---|---|---|
| `apps/host-daemon/scripts/bundle-manifest.mjs:88-100` (`bundleTargets`, label "parcel watcher child") | build | remove the target |
| `packages/omnyo-app/scripts/build-host.mjs:33` (`hostDaemonFiles`) | build | remove the entry |
| `packages/omnyo-app/scripts/build-host-artifact.mjs:54` (`daemonFiles`) | build | remove the entry |
| `packages/omnyo-app/package.json:49` (`files`) | npm package contents | remove the entry |
| `packages/omnyo-app/src/launcher.ts:2354-2358` (`requiredHostArtifactPaths`) | startup check | remove the entry |
| `packages/omnyo-app/test/startup-runtime-record.test.ts:21`, `test/host-daemon-startup.test.mjs:39`, `test/index.test.ts:2176`, `test/build-host-artifact.test.mjs:91` | test fixtures | remove the entry |
| `apps/server/test/app/omnyo-app-artifact-prepared.test.ts:114`, `apps/server/test/app/omnyo-app-artifact.test.ts:63` (missed by the sweep) | test fixtures | remove the entry |
| `apps/host-daemon/src/server-move/test-fixture.ts:448` | test fixture | remove the entry |
| `apps/host-daemon/src/test/fixtures/prepare-workspace-io-fixture.mjs:20` (`neededWorkers`, missed by the sweep) | test fixture | remove the label |
| `tests/qa/worker-update-checkpoint/proof.mjs:316-319` | QA harness (see RF-019) | remove the entry pair |
| `packages/server-archive/src/legacy-runtime-identity-v1.ts:32` (`legacyFullPackageRoleV1`, `bb-parcel-watcher-child.mjs`) | persisted legacy format | **keep**: it must match the `files` list of already-installed 0.46.x `bb-app` packages exactly (`installedLegacyRuntimeRootsV1` in `packages/server-archive/src/runtime-identity.ts:153-212`) |
| `scripts/omnyo-runtime-path-map.mjs:16` (`runtimeOutputNames`) | BB-to-Omnyo rename tooling | **keep**: it maps an old name and is owned by RF-012 |

*Cross-version safety (Proven by inspection).* The launcher that runs the check resolves `daemonBundleDir` from its own `packageRoot` (`packages/omnyo-app/src/launcher.ts:1487-1489`). The host artifact ships `omnyo-app.js` together with the daemon files (`packages/omnyo-app/scripts/build-host-artifact.mjs:101-123`). So the launcher and the bundle list always come from the same version, and an older launcher never validates a newer artifact. The desktop app includes the daemon files through a directory pattern (`apps/desktop/electron-builder.config.json:63`), and `apps/desktop/src/private-update-artifact.ts:234` checks directory prefixes, so neither names the file. The runtime-identity check for current (non-legacy) packages inventories `host-daemon/dist` from disk instead of comparing it to a hard-coded list (`packages/server-archive/src/runtime-identity.ts:325-360`), so a new version without the file produces a correct, different inventory.

*History (Proven by inspection, retired private repository).* `git -C $ARCHIVED_OMNYO_CHECKOUT show b312883ef0` ("fix: isolate workspace filesystem I/O from chats", 2026-10-31) removes `setParcelWatcherBackend(createSubprocessParcelWatcherBackend({...}))` from `apps/host-daemon/src/start-host-daemon.ts` and adds `workspace-observer-child.ts`. That call was the only production caller. It was added in `cba0b9e890` (2026-06-22). The public repository's history does not contain these commits.

*Test coverage that encodes a live contract (Proven by inspection).* `packages/host-watcher/test/parcel-watcher-proxy.test.ts` (897 lines) mostly tests proxy machinery. Three of its cases, however, build a production `RootSubscription` on top of the proxy, and no other test covers them. The search `git grep -n -E 'max_user_watches|too large to deliver|subscribeGate|setParcelWatcherBackend' e9e1b74c -- '*.test.ts' '*.test.mjs'` found no other test.
- line 647 "settles root disposal while native subscribe is pending";
- line 680 "reports an oversized event batch as dropped events without resubscribing";
- line 785 "backs off a root whose subscribe keeps hitting the inotify watch limit". This case asserts the decorated message from `packages/host-watcher/src/watch-error.ts` and the bounded retry count.

`root-recovery-benchmark.test.ts` (1,056 lines, plus fixture `test/fixtures/parcel-recovery-benchmark-child.ts`, 124 lines) is opt-in through `OMNYO_WATCHER_ROOT_RECOVERY_BENCHMARK=1` (line 25) and measures recovery after the proxy child crashes. `fork-channel.test.ts` (112 lines) tests only `createChildChannel`. Both test only the subprocess path.

*Maintenance cost today.* The child handler restates the observer child's rules: `MAX_EVENTS_PER_MESSAGE = 10_000` (`parcel-child-handler.ts:18`) duplicates the 10,000 limit at `workspace-observer-child.ts:56`. Watcher event or option changes must also be made in `messages.ts` and the proxy's replay logic. The build compiles and minifies a ninth daemon bundle, and the launcher refuses to start without it.

**Proposed end state and preservation argument**

- **What disappears:** `packages/host-watcher/src/parcel-subprocess/` (all five files), `packages/host-watcher/src/real-parcel-watcher.ts`, the subprocess factory, the logger type and `disposeParcelWatcherBackend` in `parcel-watcher-backend.ts`, and the shipped file `host-daemon/dist/omnyo-parcel-watcher-child.mjs`, along with every build, package, launcher and fixture list entry for it.
- **What remains:** one watcher backend seam in `packages/host-watcher/src/parcel-watcher-backend.ts`, consisting of the `ParcelWatcherBackend` interface, the parcel type aliases, `createInProcessBackend`, `setParcelWatcherBackend` and `getParcelWatcherBackend`. The workspace observer child (`apps/host-daemon/src/workspace-observer-child.ts`) stays the single production installer of a backend, and `RootSubscription` stays its single reader. `@parcel/watcher` stays a dependency of `@omnyo/host-watcher` for the types and the in-process fallback.
- **Reset seam for tests:** change the signature to `setParcelWatcherBackend(backend: ParcelWatcherBackend | undefined): void`. Tests then reset with `setParcelWatcherBackend(undefined)`, which replaces `disposeParcelWatcherBackend`. The production call site at `workspace-observer-child.ts:35` is unchanged.
- **Why behavior is preserved:** the deleted code is unreachable from every production entry point (see the reachability table), so runtime behavior, the observer recovery semantics (restart, then wait for a new watch request) and the persisted runtime-identity formats do not change. Removing the launcher requirement and the bundle together keeps startup working. The legacy runtime role for old `bb-app` installs is kept byte for byte.
- **Non-goals:** do not change the observer child's restart policy (the proxy's indefinite-respawn behavior is not ported; if Alex wants it, it belongs in `workspace-observer-client.ts` as a separate decision). Do not touch `scripts/omnyo-runtime-path-map.mjs` (RF-012) or derive the bundle lists (RF-101).
- **Remaining uncertainty:** external forks or private release scripts outside this repository that bundle `parcel-child-entry.ts` by path were not inspected (Hypothesis: none exist). The retired private repository keeps its own copy and is not affected.

**Expected gain and cost**

Counted at the snapshot with `git show e9e1b74c:<file> | wc -l`:

| Item | Lines |
|---|---|
| `parcel-subprocess/parcel-watcher-proxy.ts` | 568 |
| `parcel-subprocess/parcel-child-handler.ts` | 179 |
| `parcel-subprocess/fork-channel.ts` | 94 |
| `parcel-subprocess/messages.ts` | 37 |
| `parcel-subprocess/parcel-child-entry.ts` | 31 |
| `real-parcel-watcher.ts` | 4 |
| `parcel-watcher-backend.ts` (imports at lines 1-5, logger and factory at lines 98-113, dispose at lines 135-146, with blank lines) | about 35 of 146 |
| `index.ts` export names | 2 |
| `bundle-manifest.mjs` target (lines 88-100) | 13 |
| `build-host.mjs`, `build-host-artifact.mjs`, `package.json`, `launcher.ts` entries | 8 |
| **Handwritten production lines removed (projection from these counts)** | **about 970** |

- **Tests:** about 2,189 lines removed (`parcel-watcher-proxy.test.ts` 897, `fork-channel.test.ts` 112, `root-recovery-benchmark.test.ts` 1,056, its fixture 124). About 100-140 lines are added for the three ported `RootSubscription` cases (an estimate). There are also single-line edits in nine fixture or QA files.
- **Artifacts:** one minified bundle disappears from every host and full package. The build-time and size savings were not measured.
- **Runtime performance:** neutral by construction, because the deleted code never runs. This is an argument from reachability, not a measurement.
- **Why maintenance gets easier:** after the change, an `@parcel/watcher` upgrade or event-contract change touches only `root-subscription.ts`, `parcel-watcher-backend.ts` and the observer child. The build, the packaging lists and the launcher check also stop carrying one bundle that has no runtime purpose.

**Execution steps**

1. **Reconfirm the baseline.** In the canonical checkout or a fresh worktree on current `main`, rerun the two `git grep` searches from Context with `HEAD` in place of the snapshot. Stop and re-plan if any of these turn up: a new production caller of `createSubprocessParcelWatcherBackend`, `createParcelWatcherProxy` or `createForkChannel`; a new list containing `omnyo-parcel-watcher-child.mjs`; or RF-101 having already landed. If RF-101 has landed, only the manifest target and the launcher entry may still need editing. Record `wc -l` for the files in the table above.
2. **Port the unique `RootSubscription` coverage first (checkpoint A).** Create `packages/host-watcher/test/root-subscription.test.ts` with a small fake `ParcelWatcherBackend`. Its `subscribe(dir, callback, opts, signal)` records attempts, can hold a subscribe pending on a gate promise, can reject every subscribe with a given message, and exposes `emit(dir, error, events)`. Install it with `setParcelWatcherBackend(fake)` and reset it in `afterEach` (use `disposeParcelWatcherBackend()` until step 3, then `setParcelWatcherBackend(undefined)`). Port these cases with their original assertions:
   - "settles root disposal while native subscribe is pending": `dispose()` resolves while the subscribe never settles, and exactly one attempt was made.
   - "reports an oversized event batch as dropped events without resubscribing": with the proxy gone, the fake reproduces the observer child's contract. It delivers a 10,000-event batch, then calls back with `new Error("Watcher event batch was too large to deliver")` and `[]`. Assert one delivered batch of 10,000, one dropped-events report and one subscribe attempt.
   - "backs off a root whose subscribe keeps hitting the inotify watch limit": use fake timers, reject every subscribe with `"inotify_add_watch on '/huge/node_modules/pkg' failed: No space left on device"`, advance 60 seconds, then assert between 3 and 10 attempts, no dropped events, and one decorated watch error ending in `(inotify watch limit reached; see fs.inotify.max_user_watches)`.

   Keep the `vi.spyOn(pathExistsModule, "pathExists")` stubbing that the original cases use. Run `pnpm --filter @omnyo/host-watcher test` and confirm the new file passes against the unchanged code, so the ported cases have an independent baseline.
3. **Delete the subprocess backend (checkpoint B).**
   - Delete `packages/host-watcher/src/parcel-subprocess/parcel-watcher-proxy.ts`, `parcel-child-handler.ts`, `fork-channel.ts`, `messages.ts` and `parcel-child-entry.ts`, then `packages/host-watcher/src/real-parcel-watcher.ts`.
   - In `packages/host-watcher/src/parcel-watcher-backend.ts`, remove the imports at lines 1-5, `ParcelWatcherBackendLogLevel`, `ParcelWatcherBackendLogger`, `createSubprocessParcelWatcherBackend` (lines 98-113) and `disposeParcelWatcherBackend` (lines 135-146). Widen `setParcelWatcherBackend` to accept `ParcelWatcherBackend | undefined`.
   - In `packages/host-watcher/src/index.ts:13-17`, export only `setParcelWatcherBackend`.
   - Delete `packages/host-watcher/test/parcel-watcher-proxy.test.ts`, `test/fork-channel.test.ts`, `test/root-recovery-benchmark.test.ts` and `test/fixtures/parcel-recovery-benchmark-child.ts`. Switch the new test's reset to `setParcelWatcherBackend(undefined)`.
   - Run `pnpm --filter @omnyo/host-watcher typecheck` and `pnpm --filter @omnyo/host-watcher test`, then `pnpm --filter @omnyo/host-daemon typecheck`.
4. **Stop building and requiring the bundle, all in the same commit (checkpoint C).**
   - `apps/host-daemon/scripts/bundle-manifest.mjs`: remove the `bundleTargets` element labelled "parcel watcher child" (lines 88-100).
   - `packages/omnyo-app/scripts/build-host.mjs:33`, `packages/omnyo-app/scripts/build-host-artifact.mjs:54` and `packages/omnyo-app/package.json:49`: remove the entry.
   - `packages/omnyo-app/src/launcher.ts:2354-2358`: remove the `requiredHostArtifactPaths` element labelled "parcel watcher child".
   - Fixtures: remove the entry from `packages/omnyo-app/test/startup-runtime-record.test.ts:21`, `test/host-daemon-startup.test.mjs:39`, `test/index.test.ts:2176`, `test/build-host-artifact.test.mjs:91`, `apps/server/test/app/omnyo-app-artifact-prepared.test.ts:114`, `apps/server/test/app/omnyo-app-artifact.test.ts:63` and `apps/host-daemon/src/server-move/test-fixture.ts:448`. Remove `"parcel watcher child"` from `neededWorkers` in `apps/host-daemon/src/test/fixtures/prepare-workspace-io-fixture.mjs:20`, and remove the `[parcel-child-entry.ts, omnyo-parcel-watcher-child.mjs]` pair from `tests/qa/worker-update-checkpoint/proof.mjs:316-319`.
   - Leave `packages/server-archive/src/legacy-runtime-identity-v1.ts` and `scripts/omnyo-runtime-path-map.mjs` unchanged.
5. **Sweep for leftovers.** `git grep -n -E 'parcel-subprocess|parcel-child|omnyo-parcel-watcher-child|createSubprocessParcelWatcherBackend|disposeParcelWatcherBackend|realParcelWatcher|createForkChannel|OMNYO_WATCHER_ROOT_RECOVERY_BENCHMARK'` must return only `scripts/omnyo-runtime-path-map.mjs` (which contains `parcel-watcher-child` as a name fragment) and nothing else. Check docs with `git grep -n -i 'parcel watcher child\|subprocess backend' -- '*.md'`; none were found at the snapshot.
6. **Format, verify and recount.** Format the changed files with the repository's formatter, run the verification below, read the full diff for unrelated edits, and recount the lines against the step 1 baseline.

**Verification and acceptance criteria**

All commands run from the repository root. The script names were read from the snapshot's `package.json` files, but none of the commands could be executed during this audit (there is no `node_modules` in the snapshot).

- `pnpm --filter @omnyo/host-watcher typecheck` and `pnpm --filter @omnyo/host-watcher test` (scripts `typecheck` and `test` in `packages/host-watcher/package.json`). The test run must pass the new `root-subscription.test.ts` and the existing `watch-path.test.ts`, `thread-storage-watch.test.ts`, `path-watch-bounds.test.ts`, `watch-status.test.ts`, `workspace-root-ignores.test.ts` and `catalog-cache.test.ts`, with no assertion weakened.
- `pnpm --filter @omnyo/host-daemon typecheck` and `pnpm --filter @omnyo/host-daemon test`. These cover the observer child's import of `setParcelWatcherBackend` and the workspace-io fixture that builds `bundleTargets`.
- `pnpm --filter omnyo-app typecheck` and `pnpm --filter omnyo-app test`. The vitest config includes `test/**/*.test.{mjs,ts}`, so the launcher, startup-record, host-daemon-startup and build-host-artifact tests all run. These catch any mismatch between the launcher's required list and the fixtures.
- `pnpm --filter @omnyo/server test -- test/app/omnyo-app-artifact` (file filter syntax unverified; running `pnpm --filter @omnyo/server test` also works).
- Build check: `pnpm --filter @omnyo/host-daemon build`, then `pnpm --filter omnyo-app build:host`. Confirm that `apps/host-daemon/dist/` no longer receives a fresh `omnyo-parcel-watcher-child.mjs` (a stale copy from an earlier build may remain; delete `dist` first with `pnpm --filter @omnyo/host-daemon clean`), that the host package builds without "Missing" errors, and that `packages/omnyo-app/host-package/host-daemon/dist/` lacks the file.
- Startup check, recommended because this is packaging and startup code: `pnpm --filter omnyo-app smoke:tarball` (script exists in `packages/omnyo-app/package.json`; its runtime prerequisites were not confirmed). It must start the packed host without the "Missing parcel watcher child" error.
- Lint: `pnpm exec oxlint --deny-warnings --format=agent` on the changed files, and `pnpm format:check`.
- **Structural completion:** the step 5 search is clean. `packages/host-watcher/src` contains no `parcel-subprocess` directory. `setParcelWatcherBackend` has exactly one production caller (`apps/host-daemon/src/workspace-observer-child.ts`). None of the production lists (`bundleTargets`, `hostDaemonFiles`, `daemonFiles`, the `omnyo-app` `files` array and `requiredHostArtifactPaths`) or the fixture lists names the parcel watcher child.
- **Performance:** no runtime measurement is required, because the deleted code is unreachable. If the owner wants build-time or artifact-size evidence, compare `du -k` of the host package before and after on the same machine.

**Rollback and stop conditions**

- **Rollback boundary:** one commit, or two if checkpoint A lands first. Reverting restores the code and all lists together. No persisted data, migration, settings key or protocol changes, and the legacy runtime role for old `bb-app` installs is untouched, so rollback has no data implications.
- **Stop** if step 1 finds any production caller of the subprocess factory, proxy or fork channel, or any environment or configuration switch that selects the subprocess backend.
- **Stop** if any updater, worker-update or server-move path is found where an older launcher validates a newer daemon bundle directory. In that case, keep shipping an empty placeholder file for one release, or keep the launcher requirement until the old launchers are gone, and record the removal condition.
- **Stop** if a ported `RootSubscription` case cannot pass against the unchanged code in checkpoint A. That would mean the original case depended on proxy behavior, and the contract has to be re-derived before anything is deleted.
- **Stop and ask Alex** if anyone wants the proxy's indefinite-respawn resilience preserved. That is a behavior decision for `workspace-observer-client.ts`, not a reason to keep this unused layer.
- **Safer smaller alternative:** if packaging changes must wait, do checkpoints A and B only, keeping the `parcel-child-entry.ts` entry point and the bundle lists. This is not recommended, because it leaves a shipped bundle with no source rationale.
