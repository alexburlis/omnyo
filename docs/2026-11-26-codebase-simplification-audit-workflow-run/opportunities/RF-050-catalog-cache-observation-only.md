# RF-050 — Remove CatalogCache's in-process watcher mode so the command catalog has one watch-and-invalidate owner

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The central claim holds: production never constructs the watcher-backed mode of `CatalogCache`. The scope is slightly larger than the sweep reported. `CatalogCache.retain()` and the per-entry `scope` are also reachable only through the watcher-mode branch. The benchmark belongs to RF-018, and `createHostDaemonApp`'s `hostWatcher` option has to stay because the `WatchManager` and `RuntimeManager` test seams also use it.
- **Potential:** medium. A second implementation of root subscription, dirty tracking and 75 ms debounced change notification disappears, and `CatalogCache` becomes a pure stamp-and-validate cache.
- **Confidence:** high that the code is unreachable in production (Proven by inspection). Medium on the exact line count (projection).
- **Readiness:** ready. No product decision is needed: the removed mode is a test seam, not a supported configuration. The work is careful test migration.
- **Effort:** 1 to 2 days, mostly test migration.
- **Risk:** medium. The stamp, rescan and version logic is subtle. The realistic regression is stale slash-command or skill metadata after edits, or a snapshot whose `watches` list differs from today's for the same filesystem, which would change what `CatalogWatchOwner` subscribes to.
- **Prerequisites:** none. Coordinate with RF-018, which deletes `scripts/benchmark-command-metadata.ts` and `scripts/verify-command-metadata-watchers.mjs`.
- **Related or overlapping:** RF-018 (retires the benchmark that measures the removed mode; the sweep's incidental note on that benchmark is ISS-005 / ISS-S10-03). RF-002 (deletes the `@parcel/watcher` subprocess backend in the same package) touches `packages/host-watcher` but different files. RF-106 (WatchInterestCoordinator) is unrelated machinery.
- **Why it deserves its place:** a change to which paths invalidate the command catalog, or to its debounce, currently has to be reasoned about in two places, and the copy in `CatalogCache` runs only in unit tests. After this change, one owner remains and the remaining cache is easier to reason about, because it has no shared cross-entry root map and no timers.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The snapshot worktree named in the audit brief no longer existed, so every file was read with `git show e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e:<path>`. All files below are byte-identical between the snapshot and the main checkout's HEAD `5f2d3f895` (`git diff --stat` printed nothing for each file).

*How command metadata works in production (Proven by inspection).* The host daemon answers `host.list_command_metadata` (slash commands, shared skills and project skills for a working directory and provider). The work is split across two processes:

1. The main daemon process builds `IsolatedCommandMetadataCatalog` (`apps/host-daemon/src/workspace-read-client.ts:475`). For each working directory it forks a `workspace-read-child` process (`WorkspaceReadProcess`, used at `:546`). It wraps every read in `CatalogWatchOwner.read` (`apps/host-daemon/src/catalog-watch-owner.ts:65`).
2. The read child constructs `new CommandMetadataCatalog({ mode: "observation-only" })` (`apps/host-daemon/src/workspace-read-child.ts:37`). It answers `metadata` requests with `catalog.listSnapshot(...)` (`:189`), and handles `invalidate` with `catalog.invalidate()` (`:120-121`). The read protocol has no `retain` request: the request kinds in `apps/host-daemon/src/workspace-read-protocol.ts` are `access`, `mutate`, `rpc`, `metadata`, `provision`, `context`, `collect-local`, `invalidate` and `shutdown`.
3. The child returns `{ result, watches }`. `CatalogWatchOwner` in the main process subscribes to each `CatalogWatch.rootPath` through `HostWatcher.watchPathRoot` (`catalog-watch-owner.ts:194` `acquire`). It filters events with `catalogWatchTouches` (`:255` `changed`, `:263`), invalidates the child (`invalidateReader`) and debounces a scoped notification by 75 ms (`:276-285`). `app.ts:758-760` turns that into `{ type: "command-catalog-change", scopes }`.

*The second mode (Proven by inspection).* `packages/host-watcher/src/catalog-cache.ts` (636 lines, `wc -l`) `CatalogCache` has two constructor overloads (`:76-91`): `(watcher: HostWatcher, onChange)` and `(options: CatalogObservationOptions)`. In watcher mode it does the same job as `CatalogWatchOwner`, inside the cache:

- It keeps a cross-entry root map `this.roots` (`:66`) and per-entry `Entry.roots` (`:49`), used at `:184-188`, `:618-620` and `:623-635` `release`.
- `subscribe` (`:367`) registers `this.watcher.watchPathRoot` (`:431-436`, `:512-535`).
- A local `dirty` closure (`:480-510`) filters with `catalogWatchTouches`, bumps `version` and `rescanVersion`, and schedules a 75 ms `notifyTimer` calling `onChange` (`:502-509`).
- `stopping` (`:68`), `notifyTimer` (`:71`), `watcher` (`:73`) and `onChange` (`:74`) are fields that serve only this mode. Mode branches sit at `:163`, `:184-188`, `:347`, `:374`, `:379`, `:433`, `:512-535` and `:538-542`. `retain` (`:112-117`) and `dispose` (`:273`, `:277`) also carry timer and stop handling.

In observation mode `watcher` is `null`, `onChange` is a no-op, `watch` is `undefined`, so `subscribe` only computes the root and its ignore list and resolves `ready` at once (`:535`). Each build uses fresh local `roots` and `rootKeys` maps (`:184-188`). Cache hits recompute `watches` from stored stamps through `observeStamps` (`:160-165`, `:553`).

*Reachability of the watcher mode (Proven by inspection).*

- Search: `git grep -n -E "CommandMetadataCatalog|CatalogCache\b|CatalogObservationOptions|observation-only|catalogWatchTouches|CatalogWatchOwner" e9e1b74c -- . ':!*.md'`. The only watcher-mode constructions are `apps/host-daemon/src/app.ts:761` (`new CommandMetadataCatalog(hostWatcher, ...)`), `apps/host-daemon/src/command-metadata.ts:44` (inside that class), `scripts/benchmark-command-metadata.ts:60`, and tests (`packages/host-watcher/test/catalog-cache.test.ts:40`, `:398`, `:442`; `apps/host-daemon/src/command-metadata.test.ts:25`, `:138`, `:325`).
- `app.ts:756-763` picks watcher mode only when `options.hostWatcher !== undefined`. Search: `git grep -n -w hostWatcher e9e1b74c`. Among `createHostDaemonApp` callers (`git grep -n "createHostDaemonApp(" e9e1b74c`), only `apps/host-daemon/src/app.test.ts:1405-1419` (test "retired environment", fake watcher at `:1400-1403` with no `watchPathRoot`) passes it. The production caller `apps/host-daemon/src/start-host-daemon.ts:184-209` does not. Neither do `tests/integration/helpers/harness.ts:434`, `tests/qa/worker-update-checkpoint/worker.mjs:46`, `apps/host-daemon/src/test/fixtures/workspace-io-isolation-child.ts:119` or the other `app.test.ts` fixtures (`:465`, `:953`, `:1078`). The `hostWatcher:` hits in `plugin-host-manager.test.ts:211` and `:1217` are `PluginHostManager` options, not `createHostDaemonApp` options.
- `@omnyo/host-watcher` is `"private": true` (`packages/host-watcher/package.json`) and its only workspace dependent is `apps/host-daemon` (`git grep -l "@omnyo/host-watcher" e9e1b74c -- '*/package.json'`). It is not part of the SDK or plugin SDK, so no external plugin or older client can construct it.
- No Markdown doc mentions `CatalogCache`, `CommandMetadataCatalog` or `observation-only` (`git grep -i ... -- '*.md'`, no hits).

*Additional dead path the sweep did not list (Proven by inspection).* `CatalogCache.retain()` (`:100-118`), the `scope` argument of `getSnapshot` (`:127`) and `Entry.scope` (`:41`, `:135-138`) are called only from `CommandMetadataCatalog.retain` (`command-metadata.ts:52-54`). That method is called only through `app.ts:1291` `onCatalogRetain: (scopes) => commandMetadata.retain(scopes)`. In production `commandMetadata` is `IsolatedCommandMetadataCatalog`, whose `retain` (`workspace-read-client.ts:525-536`) goes to `CatalogWatchOwner.retain`, not to the child. The child never calls `retain` (its only `catalog.` calls are `dispose` at `:86`, `invalidate` at `:121` and `listSnapshot` at `:189`). Without `retain`, an entry can leave the map only through `prune` (`:597-607`, which skips pending entries) or `dispose`. So `Entry.retained` (`:42`, checks at `:236`, `:266`) is always `true` while a build can still publish. Treat this as a follow-on checkpoint, because it changes more test fixtures.

*What must stay (Proven by inspection).*

- `options.hostWatcher` in `createHostDaemonApp` (`app.ts:210`). It also selects the in-process `WatchManager` (`:746-753`), the synchronous workspace-status publish (`:701-705`), and the watcher passed to `RuntimeManager` (`:802`) and plugin hosting (`:1051`). Those seams are outside this card.
- The server and contract handling of a scope-less `command-catalog-change`. `packages/host-daemon-contract/src/session.ts:953` and `packages/host-daemon-contract/test/contract.test.ts:3389` ("legacy") keep it for older daemons, and `apps/server/src/ws/daemon-protocol.ts:279` consumes it. Only the removed `app.ts:762` branch sends the scope-less form from this daemon, but older daemons still can.
- `catalogWatchTouches`, `CatalogWatch`, `CatalogSnapshot` and `CatalogCacheScope` exports (`packages/host-watcher/src/index.ts:4-11`), which `CatalogWatchOwner` uses.

*Tests that encode watcher mode (Proven by inspection).*

- `packages/host-watcher/test/catalog-cache.test.ts` (738 lines): the `fixture` helper (`:14-48`) builds a watcher-mode cache. The `describe("watched command catalog")` block (`:50-436`) has 12 cases, and `:438` "returns the same roots and filters as native watching without subscribing" compares observation mode against watcher mode. The cases split into two groups:
  - Generic cache semantics that observation mode also relies on: `:51` sibling stamps run while one is pending, `:97` unrelated nested changes, `:121` in-flight sharing and missed-event revalidation, `:149` never publishing a generation changed during its scan, `:170` rebuilding when a header changes during its scan, `:222` creation under an initially missing root, and `:295` memory accounting for an evicted pending read.
  - Watch lifecycle that `CatalogWatchOwner` owns in production: `:193` lost watch, recovery and eviction release, `:243` and `:268` root release, `:349` and `:392` release during preflight or readiness.
- `apps/host-daemon/src/command-metadata.test.ts` (407 lines): `:13`, `:207`, `:241`, `:292` and `:320` use watcher mode. `:207` and `:292` assert subscribed `rootPath`s, `:241` asserts `retain`, and `:13` and `:320` assert discovery and refresh. `:259` already uses observation mode.
- `apps/host-daemon/src/catalog-watch-owner.test.ts` (160 lines) has three cases (`:42`, `:76`, `:125`). None covers `onWatchError` followed by `onReady` recovery. That obligation is unique to `catalog-cache.test.ts:193` today.

*Maintenance cost today.* Two independent implementations of "subscribe to the catalog roots, filter events by target, invalidate, debounce 75 ms and notify" exist (`catalog-cache.ts:425-535` and `catalog-watch-owner.ts:194-286`), with different root-sharing rules (cross-entry `this.roots` versus subscriptions keyed by `[rootPath, ignoredPaths]`). Only the second runs in production, yet the first shapes the cache's core paths (`getSnapshot`, `observe`, `subscribe`, `remove`, `release`) with `this.watcher !== null` branches and `entry.retained` guards.

**Proposed end state and preservation argument**

- `CatalogCache<T>` has no constructor arguments and no `HostWatcher` dependency. It stamps observed targets, revalidates stamps on each `getSnapshot`, bumps versions on `invalidate()`, bounds itself with `prune`, and returns `{ value, watches }`, where `watches` comes from per-build root computation (`subscribe` minus registration) and `snapshotWatches`.
- `CatalogObservationOptions` is deleted from `catalog-cache.ts` and from `index.ts:9`. If a reviewer prefers a self-describing call site, keeping `new CatalogCache({ mode: "observation-only" })` with a one-variant type is acceptable, but it is a type with no alternative, so the default is to drop it.
- `CommandMetadataCatalog` has one parameterless constructor (`private readonly cache = new CatalogCache<Metadata>()`). `workspace-read-child.ts:37` becomes `new CommandMetadataCatalog()`.
- `app.ts` always constructs `IsolatedCommandMetadataCatalog(onChange, hostWatcher)` and drops the `CommandMetadataCatalog` import (`:9`). With the test fake at `app.test.ts:1400`, this only constructs a `CatalogWatchOwner` and forks no child until a metadata read, which that test does not perform. Other `app.test.ts` fixtures already run the isolated catalog.
- The canonical owner of catalog subscription, event filtering, invalidation and debounce is `CatalogWatchOwner` (`catalog-watch-owner.ts`), unchanged.

*Preservation argument.* The production path (`IsolatedCommandMetadataCatalog`, `CatalogWatchOwner` and the child's observation cache) keeps the same code paths: every line removed from `catalog-cache.ts` sits behind `this.watcher !== null`, `watch !== undefined` or `entry.retained === false`, and none of those conditions can hold in the child. The behavior that must stay byte-for-byte is the `watches` array the child returns for a given filesystem: root choice (`subscribe` `:375-426`, including the pre-stat "covered by an existing non-shallow root" check at `:379-386` and the post-stat check at `:419-425`), ignore list order (`"**/node_modules/**"`, `"**/.git/**"`, then sorted child directories for shallow roots, `:474-478`) and target sorting (`snapshotWatches` `:569-595`). `CatalogWatchOwner.stabilize` keys subscriptions on the JSON of the ordered watches (`catalog-watch-owner.ts:121-124`), so any change there would churn native watches.

*Error ordering to preserve.* In `subscribe`, the call that creates a root runs the shallow `readdir` itself and throws before registering its target (`:458-472`). Concurrent observers of the same root register their target and then await `root.ready`, which rejects with the same error (`:544-550`). Keep a per-root `ready` promise and that ordering. Do not reorder it into "register the target, then await the preflight".

*Non-goals.* Do not change `CatalogWatchOwner`, `IsolatedCommandMetadataCatalog`, the read protocol, the 75 ms debounce, the 32-entry and 16 MiB limits, the scope-less `command-catalog-change` contract, or `createHostDaemonApp`'s `hostWatcher` option for `WatchManager` and `RuntimeManager`. Whether that whole in-process `hostWatcher` seam should also go is a separate question.

*Remaining uncertainty.* A developer could construct the watcher mode by hand from a local script that is not in the repository. No such script was found (searches above), and the package is private.

**Expected gain and cost**

Observed counts (`wc -l` at the snapshot): `catalog-cache.ts` 636, `command-metadata.ts` 222, `catalog-watch-owner.ts` 318, `app.ts` 1534. Tests: `catalog-cache.test.ts` 738, `command-metadata.test.ts` 407, `catalog-watch-owner.test.ts` 160. Benchmark: `scripts/benchmark-command-metadata.ts` 134.

Projected handwritten production reduction, from reading the branches listed above (not measured):

| File | Checkpoint B (watcher mode) | Checkpoint C (`retain`, `scope`, `retained`) |
|---|---|---|
| `packages/host-watcher/src/catalog-cache.ts` | about 95 to 115 lines (`HostWatcher` import, 4 fields, 16-line constructor, `dirty`/`notifyTimer`/registration block of about 60 lines, mode guards, `Entry.roots`, `this.roots`, `stopping`, `release` stop handling) | about 20 to 25 lines |
| `apps/host-daemon/src/command-metadata.ts` | about 13 lines (overloads, two imports) | about 5 lines (`retain`, scope argument) |
| `apps/host-daemon/src/app.ts` | about 6 lines (`:9`, `:756-763`) | 0 |
| `packages/host-watcher/src/index.ts` | 1 line | 0 |

Total projection: about 115 to 165 production lines. Tests: roughly 150 to 250 lines net fewer, because the lifecycle cases are deleted or moved and the generic cases are ported to observation mode (estimate, not counted). One new `CatalogWatchOwner` recovery case is added (about 30 lines). The benchmark (134 lines) is removed under RF-018, or retargeted here if RF-018 is declined.

Mechanisms before and after: two implementations of catalog root subscription, dirty tracking and debounced notification become one (`CatalogWatchOwner`). `CatalogCache` loses its timer, its cross-entry root map and its stop/settle bookkeeping.

Performance: Hypothesis that production is unchanged, because no production line executes differently. The guard checks removed from hot paths are constant-time. No benchmark is needed. The existing benchmark measures the removed mode and is not a valid baseline for production.

Cost: test migration effort, and a review of subtle cache code. Ported tests must keep their assertions; they drive change through `cache.invalidate()` or real file edits instead of `watched[0].onChange(...)`.

**Execution steps**

1. **Reconfirm (stop and re-plan if any check fails).**
   1. In the target checkout, run `git grep -n -E "new (CatalogCache|CommandMetadataCatalog)\(" -- . ':!*.md'` and `git grep -n -w hostWatcher -- apps tests scripts`. Expect only the call sites listed in Context. A new production caller of the watcher overload, or a `createHostDaemonApp` caller outside tests that passes `hostWatcher`, invalidates this plan.
   2. Confirm that `workspace-read-protocol.ts` still has no `retain` request and that `workspace-read-child.ts` still calls only `dispose`, `invalidate` and `listSnapshot` on the catalog. If the child gained `retain`, skip Checkpoint C.
   3. Check whether RF-018 has landed. If `scripts/benchmark-command-metadata.ts` still exists and RF-018 is still planned, leave the benchmark to RF-018 and note it in the change description. Do not let it block this change: it is outside every `tsconfig` (RF-018 card, "Maintenance cost today"), so `pnpm typecheck` will not fail on it. It will fail at run time, so it must not be left behind silently. Either delete it under RF-018 in the same series, or apply step 5.3.
2. **Checkpoint A: tests first (no production change).** Goal: every obligation the watcher-mode tests carry is either expressed against observation mode or owned by `CatalogWatchOwner` tests, while the old mode still exists. Then the production edits in Checkpoint B can be checked against an independent baseline.
   1. In `packages/host-watcher/test/catalog-cache.test.ts`, change `fixture` (`:14-48`) to build `new CatalogCache<string>({ mode: "observation-only" })` and to stop returning `watched` and `stopped`. Port the generic cases from the watcher `describe` into the observation `describe`, driving change with real file edits plus `cache.invalidate()` in place of `watched[0].onChange(...)` and `onRescanRequired()`:
      - `:51` sibling stamps: unchanged apart from the fixture.
      - `:97` unrelated nested changes: drop the `onChange` call. The assertion `value === "metadata"` must still hold, because the stamp of `references/guide.md` is not observed.
      - `:121` in-flight sharing: keep the `Promise.all` sharing and cache-hit assertions. Replace the `onChange` step with the plain file edit (the observation cache revalidates stamps). Drop `expect(watched).toHaveLength(1)`; assert instead that `getSnapshot(...).watches` has one root.
      - `:149` changed generation: call `cache.invalidate()` inside the first build in place of `onRescanRequired()`. Expect `"current"`.
      - `:170` header change during scan: drop the `onChange` call. The stamp comparison at `:209-214` must still force the rebuild.
      - `:222` missing root: drop the `onChange` call. Assert `"SKILL.md"` on the second read.
      - `:295` evicted pending read: this case depends on `retain([])`. Keep it in watcher form until Checkpoint C. In Checkpoint C, delete it, because no observation-only path can evict a pending entry (see Context). Record that reason in the commit message.
   2. Delete the lifecycle cases `:193`, `:243`, `:268`, `:349` and `:392` from `catalog-cache.test.ts` only after the equivalent obligation exists in `apps/host-daemon/src/catalog-watch-owner.test.ts`. Compare each case against `catalog-watch-owner.test.ts:42`, `:76` and `:125`. Add one case there for the obligation not covered today: after a read succeeds, `onWatchError` makes the next read reject with the watch error, and `onReady` then makes reads succeed again and calls `notify` with that scope after 75 ms (fake timers). Model it on `catalog-cache.test.ts:193` and `CatalogWatchOwner.acquire` `:225-243`. If a released-root case (`:243`, `:268`) has no clear owner equivalent, write it against `CatalogWatchOwner.retain` and `stabilize`'s release of replaced leases.
   3. Replace `:438` "returns the same roots and filters as native watching without subscribing" with a fixed-expectation test. Keep the literal `expect(observed.watches).toEqual([...])` assertion it already contains and drop the `direct` comparison cache.
   4. In `apps/host-daemon/src/command-metadata.test.ts`:
      - Make `linkedSkillFixture` (`:115-191`) always build the observation catalog, and remove `watched`, `stopped`, `changed` and the `observationOnly` flag.
      - Rewrite `:207` and `:292` to assert on `(await catalog.listSnapshot(command)).watches.map((w) => w.rootPath)` with the same expected roots. The pre-stat cover check means observation mode may return fewer roots than the old subscription list, so compare against a hand-written expected list taken from the old run, not from the new code.
      - Delete `:241` (retain) once the scope-retention obligation is confirmed in `catalog-watch-owner.test.ts:125`.
      - In `:13` and `:320`, construct `new CommandMetadataCatalog({ mode: "observation-only" })`. For `:13`, assert on `listSnapshot().watches` in place of the `watched` subscriptions and drop `changed`.
   5. Run the Checkpoint A verification (below). All tests must pass against the unchanged production code. This is the baseline.
3. **Checkpoint B: remove watcher mode.**
   1. `packages/host-watcher/src/catalog-cache.ts`:
      - Delete the `HostWatcher` import (`:4`), the fields `roots` (`:66`), `stopping` (`:68`), `notifyTimer` (`:71`), `watcher` (`:73`) and `onChange` (`:74`), and the constructor (`:76-91`).
      - In `retain`, delete `:112-117`. Keep `retain` itself until Checkpoint C.
      - In `getSnapshot`, delete the `this.watcher === null` term at `:163`, and make `roots` and `rootKeys` plain `new Map()` and `new Set()` (`:184-188`).
      - In `dispose`, delete `:273` and `:277`.
      - In `observe` and `subscribe`, delete the guards at `:347` and `:374`, and make the cover-check loop at `:379-386` unconditional.
      - In the root-creation block: delete `watch` and its error (`:431-436`) and the whole `dirty` closure (`:480-510`). Replace `:512-535` with a single `ready()` after `state.ignoredPaths` is set. Delete `:538-542`.
      - Keep `Root.ready`, `Root.error` and the creating-call throw order described in the preservation argument. Delete `Root.stop` and `Root.finishReady`.
      - Delete `Entry.roots` (`:49`, `:146`) and the `entry.roots` loop in `remove` (`:618-620`).
      - Reduce `release` (`:623-635`) to deleting the entry's targets from the local root and deleting the root when it has none. It is now only used at `:228` with the build-local map, so make `roots` a required parameter.
   2. Delete `CatalogObservationOptions` (`catalog-cache.ts:19-21`) and its export (`index.ts:9`).
   3. `apps/host-daemon/src/command-metadata.ts`: replace `:32-46` with `private readonly cache = new CatalogCache<Metadata>();`, and drop the `CatalogObservationOptions` and `HostWatcher` imports (`:16`, `:19`).
   4. `apps/host-daemon/src/workspace-read-child.ts:37`: `new CommandMetadataCatalog()`.
   5. `apps/host-daemon/src/app.ts`: replace `:756-763` with `const commandMetadata = new IsolatedCommandMetadataCatalog((scopes) => { sendServerMessage({ type: "command-catalog-change", scopes }); }, hostWatcher);` and delete the `CommandMetadataCatalog` import at `:9`. Leave `:736-754` (the `WatchManager` choice) unchanged.
   6. Update the test constructors from Checkpoint A (`new CatalogCache<string>()`, `new CommandMetadataCatalog()`).
   7. Run the Checkpoint B verification.
4. **Checkpoint C: remove `retain` and per-entry scope (separate commit).**
   1. In `catalog-cache.ts`, delete `retain` (`:100-118`), the `scope` parameter of `getSnapshot` (`:127`), and `Entry.scope` (`:41`, `:135-138`).
   2. Re-prove that no pending entry can be removed (only `prune`, which skips pending entries, and `dispose`, which awaits pending builds first). Then delete `Entry.retained` (`:42`, `:139`, `:614`), the `if (current.retained)` guard at `:236` (keep the byte accounting unconditional) and the ternary at `:266`. If that proof fails, keep `retained`.
   3. In `command-metadata.ts`, delete `retain` (`:52-54`) and the `command` scope argument at `:114`, and drop the `CatalogCacheScope` import if unused.
   4. Delete `catalog-cache.test.ts:295` and any remaining `retain` uses in tests, recording the reason from step 2.1.
   5. `command-dispatch-support.ts:68` types `commandMetadata` as `Pick<CommandMetadataCatalog, "list">`; it still typechecks, so no edit is needed.
5. **Remove superseded support.**
   1. `git grep -n -E "observation-only|CatalogObservationOptions|watchPathRoot" -- packages/host-watcher/src/catalog-cache.ts apps/host-daemon/src/command-metadata.ts` must print nothing.
   2. No doc mentions the mode, so no doc edit is needed.
   3. Only if RF-018 is declined, retarget `scripts/benchmark-command-metadata.ts:48-61`: build `new CommandMetadataCatalog()`, call `listSnapshot`, and report `watches.length` in place of `watcherCount`. Correct its `method` string (`:117-118`), which today calls the removed mode the "Actual daemon metadata owner".
6. **Finish.** Run all verification, then read the complete diff for leftover `this.watcher`, `notifyTimer`, `stopping` or `onChange` references and for unrelated edits. Recount with `wc -l` on the same files and compare against the counts in "Expected gain and cost".

**Verification and acceptance criteria**

Commands. The scripts exist in each `package.json` at the snapshot: `@omnyo/host-watcher` and `@omnyo/host-daemon` both define `typecheck` (`tsc --noEmit`) and `test` (`vitest run --config vitest.config.ts`). The root defines `format:check` (`oxfmt . --check`). Run from the repository root:

- `pnpm --filter @omnyo/host-watcher test`
- `pnpm --filter @omnyo/host-daemon exec vitest run --config vitest.config.ts src/command-metadata.test.ts src/catalog-watch-owner.test.ts src/workspace-read-client.test.ts src/app.test.ts`. The `exec vitest run <files>` form is standard vitest usage but was not run in this audit, because the snapshot has no `node_modules`.
- `pnpm --filter @omnyo/host-watcher typecheck` and `pnpm --filter @omnyo/host-daemon typecheck`
- `pnpm exec oxlint --deny-warnings --format=agent <changed files>` and `pnpm exec oxfmt --check <changed files>`. Root `oxlint` and `oxfmt` are root devDependencies, and `.oxlintrc.json` and `.oxfmtrc.json` exist at the root.

Behavior and contract checks:

- Stale-metadata regressions: the ported `catalog-cache.test.ts` cases (in-flight sharing, generation changed during scan, header changed during scan, missing root created later, sibling stamping) and `command-metadata.test.ts:320` (refresh from real files without native events) pass with unchanged expectations.
- Watch-shape stability: `catalog-cache.test.ts` "returns the same roots..." (fixed expectation), `:484`, `:625` and `:668`, and the rewritten `command-metadata.test.ts:207` and `:292` assert the exact `rootPath`, `ignoredPaths` and `targets` that the baseline produced. Do not regenerate expectations from the new code.
- Lifecycle: the `catalog-watch-owner.test.ts` cases, including the new watch-error recovery case, pass. `app.test.ts` "retired environment" passes with the isolated catalog constructed.
- Optional native proof, only if RF-018 has not deleted it yet: `node --conditions=source --import tsx scripts/verify-command-metadata-watchers.mjs` exercises the production pair with real `@parcel/watcher`. The invocation is unverified; read the script first. It writes under `~/scratch/omnyo/fswatch-native-proof-*`, which must be removed afterwards.

Structural completion: `catalog-cache.ts` has no `HostWatcher` import, timer, `onChange`, `stopping` or `this.roots`. `CommandMetadataCatalog` has one constructor. `app.ts` constructs only `IsolatedCommandMetadataCatalog`. The only `catalogWatchTouches` call site in production code is `catalog-watch-owner.ts`.

Performance: no measurement required, because the production code path is unchanged apart from removed constant-time guards. Do not cite `scripts/benchmark-command-metadata.ts` receipts as before/after evidence, because they measure the removed mode.

**Rollback and stop conditions**

- Each checkpoint is a separate commit with no persisted data, protocol or contract change, so `git revert` of a checkpoint commit restores the previous state. The scope-less `command-catalog-change` contract and server handling are untouched, so older daemons keep working.
- Stop if a production or supported caller of the watcher overload, or of `CommandMetadataCatalog.retain`, appears (step 1). Stop if the read protocol gains a `retain` request (skip Checkpoint C).
- Stop if a ported test needs a changed expectation to pass, especially a different `watches` array for the same filesystem. That signals a semantic change in `subscribe`, `observeStamps` or `snapshotWatches`. Restore the original branch structure for that function and re-plan instead of updating the expectation.
- Stop if a lifecycle obligation from `catalog-cache.test.ts:193`, `:243`, `:268`, `:349` or `:392` has no equivalent `CatalogWatchOwner` behavior. That would be a production gap; record it as an issue, fix `CatalogWatchOwner` separately, and keep the old test until that fix lands.
- Smaller safe alternative if Checkpoint A proves costly: land only Checkpoint B's `app.ts` change (always use `IsolatedCommandMetadataCatalog`) plus the test migration. Then delete the overload in a follow-up once no caller remains.
