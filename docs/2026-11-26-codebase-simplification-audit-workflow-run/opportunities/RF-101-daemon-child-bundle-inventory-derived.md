# RF-101 — Give the host daemon's shipped child-bundle list one owner, and resolve child entries with one helper

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplication is real, and the sweep's counts are roughly right. Two parts of the proposed end state do not survive verification, and one consumer was missed:
  - A `host-daemon/dist/omnyo-*.mjs` glob in `packages/omnyo-app/package.json` `files` would break the build. `packages/omnyo-app/scripts/build.mjs:227-239` deletes every entry of `host-daemon/dist` whose path does not exactly equal a `files` entry (or sit above one). A glob string equals no path, so the build would delete every child bundle (Proven by inspection). The `files` list stays explicit. A cheap test replaces the coordination instead.
  - The launcher cannot simply import `apps/host-daemon/scripts/bundle-manifest.mjs`. That module computes absolute build-machine paths from `import.meta.url`. `packages/omnyo-app` also has `rootDir: "."` and no current imports outside the package. The shared list needs a neutral, path-free home that the plain-Node build scripts and the TypeScript launcher can both import. This card names `@omnyo/host-daemon-contract`, using the existing `.mjs` + `.d.mts` export pattern.
  - The sweep missed one production list: the `apps/host-daemon/package.json` `build` script builds four unbundled `dist/*.js` copies of the children (the second tier of the entry-candidate loops). That tier may be dead; step 2 is the gate that decides.
  - The per-child edit sites drop from 7 production places to about 3, not to 2: the shared list, the explicit `files` entry and the spawning client's call.
- **Potential:** medium. One duplicated inventory and five copies of an entry-resolution loop go away. The saving is about 40-75 handwritten production lines net. The larger gain is that a child is added, renamed or removed in one list instead of seven.
- **Confidence:** medium-high for the inventory part (every site was read at the snapshot). Medium for the `.js` tier, which is a hypothesis until step 2 runs.
- **Readiness:** conditional. The design is decided. Step 1 is a short feasibility gate: the plain-Node build scripts and the esbuild-bundled launcher must both be able to import the shared `.mjs` export. The `.js`-tier removal (step 7) has its own gate and is optional.
- **Effort:** about 1 day including verification. Most of the time goes to rebuilding `omnyo-app` and running its artifact tests.
- **Risk:** medium. Packaging is release-critical. The realistic regressions are: (a) a child missing from the shipped tarball, which makes every host start fail with "Missing <label> at …"; (b) a stale turbo cache when the new shared file is not in the right `inputs`; (c) a changed shipped file set or host artifact contents. The list order only changes the order of `copyFile` calls, not the resulting directory, so it should not change what `npm pack` produces (Hypothesis). The contract checks under "Verification and acceptance criteria" confirm this.
- **Prerequisites:** none. **Sequencing:** RF-002 (delete the `@parcel/watcher` subprocess backend and its `omnyo-parcel-watcher-child.mjs` bundle) edits every list this card consolidates. Land RF-002 first, because it is ready and lower risk. RF-101 then starts from seven children minus the parcel watcher child and never touches `packages/host-watcher/src/parcel-subprocess/fork-channel.ts`. If RF-101 lands first, RF-002 shrinks to one shared-list entry plus its own deletions.
- **Related items:** RF-019 (retire or register the `tests/qa` proof harnesses) owns `tests/qa/worker-update-checkpoint/proof.mjs`, which is already stale against this list (see newIssues). RF-012 (retire the BB-to-Omnyo rename tooling) owns `scripts/omnyo-runtime-path-map.mjs`, which keeps its own historical `bb-*` list. This card leaves that file alone.
- **Why it deserves its place:** this is not the largest line saving in the audit. It removes a recurring seven-site coordinated edit on a release-critical path, and that kind of edit has already gone wrong once in the repository: the QA proof lacks two children.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The dedicated snapshot worktree no longer existed at verification time, so every file was read with `git -C $OMNYO_CHECKOUT show e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e:<path>` and searched with `git grep <pattern> e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e -- .`. No build or test ran, because the snapshot has no `node_modules`. The repository history is squashed ("Publish Omnyo source", 2026-11-24), so no change history was available as evidence.

*What the subsystem does.* The host daemon (`apps/host-daemon`) runs a few helpers as separate processes or worker threads: the workspace observer child, the workspace read child, the plugin host worker, the file search worker, the process launcher worker, the provider bridge worker and (until RF-002) the parcel watcher child. `apps/host-daemon/scripts/build-bundles.mjs:22-63` bundles each one with esbuild into `apps/host-daemon/dist/omnyo-*.mjs`, driven by `bundleTargets` in `apps/host-daemon/scripts/bundle-manifest.mjs:19-101`. The npm package `omnyo-app` then copies those files and ships them in two forms: the full app package and the enrolled-host artifact tarball. At start, the launcher refuses to run when any of them is missing.

*Where each child is named today (Proven by inspection).* The command was `git grep -n -E 'omnyo-workspace-read-child|omnyo-parcel-watcher-child|omnyo-file-search-worker|omnyo-process-launcher-worker|omnyo-plugin-host-worker|omnyo-provider-bridge-worker|omnyo-workspace-observer-child|daemon-bundle\.mjs' e9e1b74c3 -- . ':!*.md'`, followed by reading each hit.

| # | Site | What it holds | Production? |
|---|---|---|---|
| 1 | `apps/host-daemon/scripts/bundle-manifest.mjs:19-101` `bundleTargets` | label, source entry and outfile for 7 children, the daemon and the CLI | yes (build) |
| 2 | `packages/omnyo-app/scripts/build-host.mjs:31-40` `hostDaemonFiles` | the 7 child file names plus `daemon-bundle.mjs` (10 lines) | yes (build) |
| 3 | `packages/omnyo-app/scripts/build-host-artifact.mjs:50-61` `daemonFiles` | `omnyo`, `omnyo.cmd`, the 7 children and `daemon-bundle.mjs` (12 lines) | yes (build) |
| 4 | `packages/omnyo-app/package.json:45-55` `files` | `host-daemon/dist/<name>` for each child (lines 48-54) | yes (npm contents and the prune allowlist) |
| 5 | `packages/omnyo-app/src/launcher.ts:2334-2385` `requiredHostArtifactPaths` | `{kind, label, path}` for each child (lines 2349-2383, 35 lines). The labels are identical to the `bundleTargets` labels. | yes (startup check, via `assertOmnyoHostArtifacts` and `assertOmnyoAppArtifacts`) |
| 6 | `apps/host-daemon/package.json:14` `build` | four `build-node-entry.mjs` steps emitting `dist/plugin-host-worker.js`, `dist/file-search-worker.js`, `dist/workspace-observer-child.js` and `dist/workspace-read-child.js` | yes (build; missed by the sweep) |
| 7 | each spawning client's candidate list (below) | `omnyo-X.mjs`, then `X.js`, then `X.ts` | yes (runtime) |

The **entry-candidate loops** (Proven by inspection) all try the bundled name first, then the unbundled `.js`, then the `.ts` source, each relative to the caller's `import.meta.url`:

| Site | Lines | Error text on failure |
|---|---|---|
| `apps/host-daemon/src/workspace-read-client.ts:95-109` `entryPath` | 15 | "Workspace read child entry is missing" |
| `apps/host-daemon/src/workspace-observer-client.ts:75-87` `childEntry` | 13 | "Workspace observer child entry is missing" |
| `apps/host-daemon/src/plugin-host-manager.ts:209-225` `defaultWorkerEntryPath` | 17 | "host plugin worker entry not found beside … (looked for …)" |
| `apps/host-daemon/src/command-handlers/file-search-client.ts:16-20` `WORKER_ENTRY_CANDIDATES` and `:121-131` `workerEntryPath` | 16 | "file search worker entry not found beside … (looked for …)" |
| `packages/process-utils/src/process-launcher.ts:19-23` `WORKER_ENTRY_CANDIDATES` and `:194-204` `workerEntryPath` | 16 | "process launcher worker entry not found beside … (looked for …)" |
| `packages/host-watcher/src/parcel-subprocess/fork-channel.ts:8-28` `resolveChildEntry` | 21 | deleted by RF-002; out of scope here |

Total: 77 lines in the five in-scope loops. The provider bridge worker is resolved differently (`packages/agent-runtime/src/shared/bridge-path.ts:6` `BRIDGE_WORKER_BUNDLE_FILE_NAME`, plus a presence probe at `apps/host-daemon/src/index.ts:38-42` `resolveEntrypointBridgeBundleDir`). It has no candidate loop and stays as it is.

No test or other code matches the five error strings (`git grep -n -E 'entry is missing|entry not found|looked for' e9e1b74c3 -- apps/host-daemon packages/process-utils packages/host-watcher packages/omnyo-app tests`; the only hits were the throw sites and an unrelated CLI test name).

*Why the `files` list cannot become a glob (Proven by inspection).* `packages/omnyo-app/scripts/build.mjs:171-175` copies all of `apps/host-daemon/dist`, including `index.js`, `start-host-daemon.js`, `title`, the four `.js` children and the children's sourcemaps, into `packages/omnyo-app/host-daemon/dist`. Lines 227-239 then keep an entry only when `packageJson.files.some((included) => included === path || included.startsWith(path + "/"))`. A glob string never equals a path, so a glob would delete every child. The runtime identity hashes everything under `host-daemon/dist` (`packages/server-archive/src/runtime-identity.ts:16`, `:201`). This exact allowlist is therefore what keeps build-only files out of both the tarball and the identity. It is a real requirement.

*Tests and fixtures that restate the list (Proven by inspection).*
- **Independent assertions, to keep explicit:** `packages/omnyo-app/test/build-host-artifact.test.mjs:87-98` (fixture inputs, plus the unpacked tarball check after line 136), `packages/omnyo-app/test/index.test.ts:2150-2156` (`metadata.files` contents) and `packages/omnyo-app/test/host-daemon-startup.test.mjs:100-104` (`it.each` cases: removing a named child blocks start).
- **Fixture writers that only create files:** `packages/omnyo-app/test/host-daemon-startup.test.mjs:35-47`, `packages/omnyo-app/test/index.test.ts:2175-2186`, `packages/omnyo-app/test/startup-runtime-record.test.ts:18-27`, `apps/host-daemon/src/server-move/test-fixture.ts:445-460`, `apps/server/test/app/omnyo-app-artifact-prepared.test.ts:110-123` and `apps/server/test/app/omnyo-app-artifact.test.ts:60-67`.
- **Other consumers:** `apps/host-daemon/src/test/fixtures/prepare-workspace-io-fixture.mjs:4,43-49` filters `bundleTargets` by `label`, so the labels are a contract. `tests/qa/worker-update-checkpoint/proof.mjs:305-330` hand-bundles a subset of the children.

*Must not change (Proven by inspection):* `packages/server-archive/src/legacy-runtime-identity-v1.ts:28-38` (the frozen `bb-*` file list of a historical persisted format), `scripts/omnyo-runtime-path-map.mjs` (RF-012), `apps/desktop/electron-builder.config.json:63` (the whole `host-daemon/dist` directory, no per-child names) and `apps/server/src/assets/install-machine-windows.mjs:494,877` (`daemon-bundle.mjs` only).

*Maintenance cost today.* Adding or removing a child means editing sites 1-7 in one commit plus about nine test fixtures. RF-002 is a live example: its card lists eleven list edits for one child. A missed site fails late. Missing a build list ships no file, and every host start then fails at `assertOmnyoHostArtifacts`. Missing the launcher list leaves a dead startup requirement or an unchecked new child.

**Proposed end state and preservation argument**

*One owner for the shipped child inventory.* Add a path-free data module to `@omnyo/host-daemon-contract`, the package that already defines the daemon-to-app contract and that both `apps/host-daemon` (`apps/host-daemon/package.json:30`) and `omnyo-app` (devDependency) depend on:

```js
// packages/host-daemon-contract/src/daemon-child-bundles.mjs
export const daemonChildBundles = Object.freeze([
  { file: "omnyo-workspace-observer-child.mjs", label: "workspace observer child", sourceEntry: "apps/host-daemon/src/workspace-observer-child.ts" },
  { file: "omnyo-workspace-read-child.mjs",     label: "workspace read child",     sourceEntry: "apps/host-daemon/src/workspace-read-child.ts" },
  { file: "omnyo-provider-bridge-worker.mjs",   label: "provider bridge worker",   sourceEntry: "packages/provider-bridge-protocol/src/bridge-worker-entry.ts" },
  { file: "omnyo-plugin-host-worker.mjs",       label: "plugin host worker",       sourceEntry: "apps/host-daemon/src/plugin-host-worker.ts" },
  { file: "omnyo-file-search-worker.mjs",       label: "file search worker",       sourceEntry: "apps/host-daemon/src/command-handlers/file-search-worker.ts" },
  { file: "omnyo-process-launcher-worker.mjs",  label: "process launcher worker",  sourceEntry: "packages/process-utils/src/process-launcher-worker.ts" },
]);
```

It gets a matching `daemon-child-bundles.d.mts` (`readonly { file: string; label: string; sourceEntry: string }[]`) and a package export `"./daemon-child-bundles": { "types": "./src/daemon-child-bundles.d.mts", "default": "./src/daemon-child-bundles.mjs" }`. This follows the existing pattern of `@omnyo/config` `./release-version` (`packages/config/package.json:177-181`) and `@omnyo/server-archive` `./mac-state-acl-v1`. A plain `.mjs` file is used because the host-daemon build scripts run under plain Node without a TypeScript loader. `sourceEntry` is workspace-relative, so the module carries no machine paths. The launcher embeds a few short strings it does not use, which is negligible.

The order of the list must keep the current esbuild build order: children first, then the daemon, the CLI and (until RF-002) the parcel child. Build order affects only log output, not artifacts.

*Consumers after the change:*
- `bundle-manifest.mjs` `bundleTargets` = `daemonChildBundles.map(...)` (adds `banner`, resolves `entryPoint` against `workspaceRoot` and builds `outfile` as `dist/<file>`), followed by the unchanged daemon and CLI targets. The labels and outfiles stay byte-identical, so `build-bundles.mjs` and `prepare-workspace-io-fixture.mjs` keep working.
- `build-host.mjs` `hostDaemonFiles` = `[...daemonChildBundles.map((b) => b.file), "daemon-bundle.mjs"]`.
- `build-host-artifact.mjs` `daemonFiles` = `["omnyo", "omnyo.cmd", ...daemonChildBundles.map((b) => b.file), "daemon-bundle.mjs"]`.
- `launcher.ts` `requiredHostArtifactPaths` keeps the daemon entry, CLI and chunk-dir entries, and replaces the seven literal child objects with `...daemonChildBundles.map(({ file, label }) => ({ kind: "file", label, path: join(context.daemonBundleDir, file) }))`. The error text stays identical ("Missing workspace read child at …"), because the labels are the same strings.
- `package.json` `files` stays explicit, which keeps the npm and prune allowlist. A new unit test in `packages/omnyo-app/test/` asserts that every `daemonChildBundles` file appears as `host-daemon/dist/<file>` in `files` and that `files` names no `host-daemon/dist/omnyo-*.mjs` outside the list. A missed `files` edit then fails in the unit test instead of at host start.

*One entry resolver.* Add `resolveBundledOrSourceEntry` to `@omnyo/process-utils`. `apps/host-daemon` already depends on that package, and `file-search-client.ts:4` already imports from it.

```ts
// Returns the first existing sibling of callerUrl: `${bundle}`, then `${source}.js`, then `${source}.ts`.
export function resolveBundledOrSourceEntry(
  callerUrl: string,
  names: { bundle: string; source: string },
  label: string,
): string
// throws new Error(`${label} entry not found beside ${fileURLToPath(callerUrl)} (looked for ${candidates.join(", ")})`)
```

Each caller passes its own `import.meta.url`. This matters: in source mode each module's URL differs (`file-search-client.ts` lives in `command-handlers/`), while in the bundled daemon every caller's URL is `daemon-bundle.mjs`. The five in-scope loops become one-line calls. Behavior is identical (same candidates, same order, same `existsSync` probe, sync and throwing), with one deliberate diagnostic change: the workspace read and observer clients now report the searched path and candidates instead of "… entry is missing". No test or code matches the old strings (search above).

*Non-goals.* No change to the shipped file set, the tarball layout, the runtime identity, the `files` allowlist semantics, the provider bridge path resolution, `legacy-runtime-identity-v1.ts` or the RF-012 rename map. The fixture lists that serve as independent assertions are not derived.

**Expected gain and cost**

Counting scope: handwritten production source only. The line numbers above came from `git show <commit>:<path> | sed -n '<a>,<b>p' | nl`.

| Item | Before (lines) | After (projected) | Net |
|---|---|---|---|
| `build-host.mjs` list | 10 | about 2 + import | about −7 |
| `build-host-artifact.mjs` list | 12 | about 2 + import | about −9 |
| `launcher.ts` child entries | 35 | about 6 + import | about −28 |
| `bundle-manifest.mjs` child targets (about 60 of the 101 lines) | about 60 | about 12 (map) | about −48 |
| new `daemon-child-bundles.mjs` + `.d.mts` + export | 0 | about 45 | +45 |
| five candidate loops | 77 | about 15 (helper) + 5 × 3 (calls) | about −47 |
| **Total** | | | **about −40 to −95; planning figure −40 to −75** |

The figures are projections. The range is wide because the formatter decides how many lines each `map` and object literal takes. Tests: about 6 fixture writers can shrink to a `map` over the shared list (about −30 test lines), and one guard test is added (about +20).

*Mechanisms.* Before: 6 independent production lists of child names (sites 1-5 plus the loop candidates) and 5 copies of the resolution loop. After: 1 shared list, 1 resolver, and 1 explicit `files` allowlist that a test checks against the list.

*Maintenance example.* Adding a new daemon child today touches `bundle-manifest.mjs`, `build-host.mjs`, `build-host-artifact.mjs`, `package.json` `files`, `launcher.ts`, the new client's candidate loop, possibly `apps/host-daemon/package.json` `build`, and about nine test fixtures. After: one `daemonChildBundles` entry, one `files` line (enforced by the guard test), and a one-line `resolveBundledOrSourceEntry` call in the client.

*Performance.* Neutral by inspection. The launcher does the same `existsSync` checks in the same order. Build scripts do the same copies. Bundle size changes by a few hundred bytes of strings.

*Costs.* One new cross-package edge (`omnyo-app` build scripts and the launcher importing `@omnyo/host-daemon-contract/daemon-child-bundles`). The launcher edge exists already as a devDependency. The build-script edge is new but follows the existing practice of scripts importing sibling packages (`build-host.mjs:11` imports `../../plugin-sdk/scripts/private-artifact.mjs`). New turbo inputs are needed (step 5).

**Execution steps**

1. **Reconfirm and run the feasibility gate.**
   - Diff the touched files against the snapshot: `git -C $OMNYO_CHECKOUT diff --stat e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e HEAD -- apps/host-daemon/scripts apps/host-daemon/package.json apps/host-daemon/src/workspace-read-client.ts apps/host-daemon/src/workspace-observer-client.ts apps/host-daemon/src/plugin-host-manager.ts apps/host-daemon/src/command-handlers/file-search-client.ts packages/process-utils/src/process-launcher.ts packages/omnyo-app packages/host-daemon-contract turbo.json`. Check whether RF-002 has landed; if so, drop the parcel child from everything below.
   - Gate A: create the `.mjs` + `.d.mts` + export (step 3a) and confirm three things. (i) `node -e 'import("@omnyo/host-daemon-contract/daemon-child-bundles").then(m => console.log(m.daemonChildBundles.length))'`, run from `apps/host-daemon` and from `packages/omnyo-app`, prints the count. (ii) `pnpm --filter omnyo-app typecheck` accepts a type-only import in `launcher.ts`. (iii) An esbuild bundle of `launcher.ts` (via `pnpm --filter omnyo-app build:host`) inlines the module. **Stop and re-plan** if Node cannot resolve the export from a plain `.mjs` script, or if TypeScript rejects `.d.mts` for this export. The fallback is to keep the launcher's list explicit, add a launcher test asserting it equals `daemonChildBundles`, and derive only the build scripts.
2. **Gate B (optional `.js` tier): decide whether the unbundled `dist/*.js` children are reachable.** Hypothesis: they are dead. `apps/host-daemon/package.json:14` always finishes with `build-bundles.mjs`, which emits the `omnyo-*.mjs` files, and the `.mjs` candidate always wins over `.js`. Tests run from source and use the `.ts` tier. Check these consumers: `git grep -n -E 'dist/(plugin-host-worker|file-search-worker|workspace-observer-child|workspace-read-child)\.js|dist/index\.js' -- . ':!*.md'` (known: `packages/scripts/src/commands/run-host-daemon.ts:146` and `tests/qa/src/standalone/start.ts:107,141` run `apps/host-daemon/dist/index.js`, and the `.mjs` files sit beside it), plus CI workflows and Containerfiles. If nothing starts a child while its `.mjs` is absent, step 7 may proceed. Otherwise skip step 7 and keep three candidates.
3. **Checkpoint 1: shared list and build scripts (mechanical).**
   a. Add `packages/host-daemon-contract/src/daemon-child-bundles.mjs`, `daemon-child-bundles.d.mts` and the `exports` entry in `packages/host-daemon-contract/package.json`, as described in the end state.
   b. `apps/host-daemon/scripts/bundle-manifest.mjs`: import `daemonChildBundles` and replace the six (or seven, before RF-002) child objects with a `map` producing `{ banner: NODE_ESM_REQUIRE_BANNER, entryPoint: resolve(workspaceRoot, b.sourceEntry), label: b.label, outfile: resolve(packageRoot, "dist", b.file) }`. Keep the daemon and CLI targets literal and keep `bundleTargets` exported with the same shape.
   c. `packages/omnyo-app/scripts/build-host.mjs:31-40` and `build-host-artifact.mjs:50-61`: derive `hostDaemonFiles` and `daemonFiles` as shown in the end state.
   d. Verify: `pnpm --filter @omnyo/host-daemon build`, then confirm that `ls apps/host-daemon/dist/omnyo-*.mjs` matches the list and that the bundle size log lines (`<label>: <bytes> bytes`) show the same labels as before.
4. **Checkpoint 2: launcher and guard test.**
   a. `packages/omnyo-app/src/launcher.ts:2334-2385` `requiredHostArtifactPaths`: replace the child entries with the `map`. Keep the first three entries and their order (daemon entry, CLI, chunk dir), because `find` reports the first missing artifact and the existing tests expect that order.
   b. Add `packages/omnyo-app/test/daemon-child-files.test.ts`, which asserts that `package.json` `files` lists each `host-daemon/dist/<file>` from `daemonChildBundles` and no other `host-daemon/dist/omnyo-*.mjs`.
   c. Optionally map the pure fixture writers (`host-daemon-startup.test.mjs:35-47`, `index.test.ts:2175-2186`, `startup-runtime-record.test.ts:18-27`, `apps/host-daemon/src/server-move/test-fixture.ts:445-460`, `apps/server/test/app/omnyo-app-artifact-prepared.test.ts:110-123`) over `daemonChildBundles`. Keep `build-host-artifact.test.mjs`'s expected tarball contents, `index.test.ts:2150-2156` and the `host-daemon-startup.test.mjs:100-104` cases as literal, independent baselines.
5. **Turbo inputs.** Add `$TURBO_ROOT$/packages/host-daemon-contract/src/daemon-child-bundles.mjs` to `turbo.json` `omnyo-app#build:host` `inputs` (around line 227) and to the test task whose inputs list `packages/omnyo-app/scripts/build-host-artifact.mjs` (around line 610). Confirm `@omnyo/host-daemon#build` already sees the file through its dependency graph. If it does not (its default inputs cover only its own package), add the file to that task's inputs too.
6. **Checkpoint 3: entry resolver.**
   a. Add `resolveBundledOrSourceEntry` (the signature above) to `packages/process-utils/src/`, export it from `packages/process-utils/src/index.ts`, and add a small unit test in `packages/process-utils` covering candidate order and the error text.
   b. Replace the loops: `workspace-read-client.ts:95-109` → `resolveBundledOrSourceEntry(import.meta.url, { bundle: "omnyo-workspace-read-child.mjs", source: "workspace-read-child" }, "Workspace read child")`. Do the same in `workspace-observer-client.ts:75-87`, `plugin-host-manager.ts:209-225` (label "host plugin worker"), `file-search-client.ts:16-20,121-131` (label "file search worker"; keep the `.ts` check in `createWorker` at line 101) and `process-launcher.ts:19-23,194-204` (label "process launcher worker"; keep the eager `workerEntryPath()` call in `enableProcessLauncherWorker`). Each call passes the caller's own `import.meta.url`. Do not move the call into the helper module.
7. **Optional, only if gate B passed.** Remove the four `build-node-entry.mjs` steps for the children from `apps/host-daemon/package.json:14` and the `.js` tier from the resolver (two candidates: bundle, then `.ts` source).
8. **Structural completion.** Run `git grep -n -E 'omnyo-(workspace-(read|observer)-child|plugin-host-worker|file-search-worker|process-launcher-worker)\.mjs' -- . ':!*.md'`. Expected production hits: the shared module, `packages/omnyo-app/package.json` and each client's single resolver call. Any other production literal is a leftover. Format with the repository formatter (`pnpm exec oxfmt <changed files>`) and lint (`pnpm exec oxlint --deny-warnings <changed files>`). Recount the lines against the table above.

**Verification and acceptance criteria**

Commands come from the `package.json` scripts at the snapshot and run from `$OMNYO_CHECKOUT` unless stated. Install dependencies first (`pnpm install`). The snapshot had none, so no command below was run during the audit.

- `pnpm --filter @omnyo/host-daemon-contract typecheck` and `pnpm --filter omnyo-app typecheck`: the launcher import types correctly.
- `pnpm --filter @omnyo/process-utils test` and `pnpm --filter @omnyo/process-utils lint`: the new resolver test passes.
- `pnpm --filter @omnyo/host-daemon build`: the same `omnyo-*.mjs` set and bundle log labels as before (save `ls apps/host-daemon/dist` before and after the change, then diff).
- `pnpm --filter @omnyo/host-daemon test`: covers the observer, read, plugin host and file search clients from source (`.ts` tier).
- `pnpm --filter omnyo-app test`: must pass with the literal baselines unchanged, including `build-host-artifact.test.mjs` (the tarball contains exactly the expected files), `host-daemon-startup.test.mjs` (removing a child blocks start with the same label), `index.test.ts` and the new guard test.
- `pnpm --filter @omnyo/server test -- test/app/omnyo-app-artifact-prepared.test.ts test/app/omnyo-app-artifact.test.ts`: the prepared host artifact still builds from the derived `daemonFiles`.
- `pnpm exec turbo run build:host --filter=omnyo-app`, then compare `packages/omnyo-app/host-package/host-daemon/dist` file names before and after.
- Release-bound check (run when Alex asks for release verification, per repository policy): `pnpm exec turbo run build --filter=omnyo-app`, then `pnpm --filter omnyo-app smoke:tarball`. Unverified detail: whether `smoke:tarball` needs extra arguments; read `packages/omnyo-app/scripts/smoke-tarball.mjs` first.
- Contract checks: (1) the set of `host-daemon/dist` entries in the packed `omnyo-app` tarball is unchanged (`npm pack --dry-run --json` in `packages/omnyo-app` after a build, diffed before and after); (2) the host artifact tarball file list is unchanged; (3) "Missing <label> at <path>" messages are unchanged for each child.
- Structural: step 8's search returns only the expected hits, and the five loop bodies are gone.

**Rollback and stop conditions**

- Each checkpoint is a separate commit that reverts cleanly. No persisted data, migration or wire format changes. The runtime identity and the tarball contents must stay identical, so a rollback cannot strand installed hosts.
- Stop if gate A fails. Then take the smaller alternative: derive only the two `omnyo-app` build scripts from `bundleTargets` basenames, keep the launcher list explicit, and add a launcher test asserting that it equals the manifest's children.
- Stop if the packed tarball or host artifact file list differs in any way from the baseline, or if `build-host-artifact.test.mjs` needs its expected list changed. Do not update the baseline to make the refactor pass.
- Stop step 7 if any CI job, Containerfile, script or test starts a child from `apps/host-daemon/dist/*.js` while the `.mjs` is absent.
- If RF-002 lands during the work, rebase and remove the parcel child from the shared list rather than carrying both changes.
