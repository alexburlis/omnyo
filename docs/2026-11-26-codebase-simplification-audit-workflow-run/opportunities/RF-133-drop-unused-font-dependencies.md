# RF-133 — Drop seven dependency declarations nothing consumes: five font packages and two workspace devDependencies

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The central claim holds for seven declarations. The two "conditional" entries from the sweep (`@radix-ui/react-checkbox` and `@tiptap/suggestion` in `apps/app/package.json`) are **rejected**, because both have real consumers that the sweep missed (see Context and evidence).
- **Potential:** low. No handwritten code disappears. What disappears is seven dependency edges, four installed font packages, and about 41 generated lockfile lines.
- **Confidence:** high for all seven declarations (Proven by inspection).
- **Readiness:** ready. No owner decision is needed, because no feature, API, persisted format or UI depends on these declarations.
- **Effort:** extra small. About 15 minutes of editing, one `pnpm install` to rewrite `pnpm-lock.yaml`, and the four packages' typecheck and build.
- **Risk:** very low. A missed consumer fails loudly at install, typecheck or build time. Nothing in the running product changes.
- **Prerequisites:** none.
- **Related and overlapping items:** RF-011 (retire the unselected landing-lab variants and their lab-only dependencies) removes the other lab-only fonts in `apps/web/package.json` (`fraunces`, `inter-tight`, `jetbrains-mono`, `jost`, `instrument-serif`, and possibly others). RF-133 and RF-011 touch adjacent lines of the same manifest and the same lockfile importer block. Either can land first. Whichever lands second must rebase its `pnpm-lock.yaml` change by rerunning `pnpm install` rather than by hand-merging the lockfile. RF-028 (move the live homepage out of `src/lab`) also touches `apps/web` but not these declarations.
- **Why it has a place in the audit:** the change is nearly free and removes declarations that every dependency-update review, install and Containerfile build currently carries for nothing. It ranks low because the maintenance saving is small and no code mechanism disappears.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The snapshot worktree named in the audit brief had been removed by the time of verification, so every file below was read with `git show <commit>:<path>` and searched with `git grep <commit>` from `$OMNYO_CHECKOUT`. No package install, build or test ran: the snapshot has no `node_modules`.

The repository is a pnpm workspace (`pnpm-workspace.yaml` covers `packages/*`, `apps/*`, `tests/*`, `plugins/*` and `examples/plugins/*`). The lockfile settings are `autoInstallPeers: true`. Turbo orders and caches tasks through a `topo` transit task (`turbo.json` "topo": `dependsOn: ["^topo"]`, used by the generic `build`, `typecheck` and `test` tasks). As a result, a workspace edge in a manifest also determines which other packages' changes invalidate a package's cached typecheck and test results.

Removable declarations (all Proven by inspection):

| Manifest and line | Declaration | Evidence that nothing consumes it |
|---|---|---|
| `apps/web/package.json:25` | `@fontsource-variable/playfair-display` | No import, CSS `@import`, `require.resolve` or family-name string anywhere. |
| `apps/web/package.json:26` | `@fontsource-variable/space-grotesk` | Same. |
| `apps/web/package.json:27` | `@fontsource/ibm-plex-mono` | Same. |
| `apps/web/package.json:29` | `@fontsource/syne` | Same. |
| `apps/app/package.json:24` | `@fontsource-variable/inter` | No file under `apps/app` imports it. Every `@fontsource-variable/inter` import in the repository is under `apps/web` (`apps/web/src/compare/compare.css:1`, `apps/web/scripts/generate-og-card.mjs:138`, `apps/web/src/lab/open-2/styles.css:1`, `apps/web/src/lab/combined-b/page.tsx:4`), and `apps/web` declares the package itself at `apps/web/package.json:21`. The app's own font stack is system fonts (`apps/app/src/components/ui/theme.css:921-923` `--font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", ...`). |
| `apps/relay/package.json:36` | devDependency `@omnyo/connect-client` | No file under `apps/relay` (sources, tests, `scripts/load-smoke.mjs`, `Dockerfile`, `tsconfig.json`, `vitest.config.ts`) names it. None of the relay's other workspace dependencies (`@omnyo/connect-db`, `@omnyo/domain`, `@omnyo/process-utils`, `@omnyo/tunnel-contract`, `@omnyo/tunnel-client`, `omnyo-plugin-automations`) declares it. |
| `packages/omnyo-app/package.json:85` | devDependency `@omnyo/domain` | No file under `packages/omnyo-app` (sources, tests, scripts, tsconfig) names it. Its own imports are `@omnyo/config`, `@omnyo/host-daemon-contract`, `@omnyo/sdk` and `@omnyo/server-archive`, and each of those four declares `@omnyo/domain` itself (`packages/config/package.json:195`, `packages/host-daemon-contract/package.json:41`, `packages/sdk/package.json:56`, `packages/server-archive/package.json:50`). The public-SDK type bundle (`packages/omnyo-app/scripts/build-public-sdk-dts.mjs` "resolveWorkspaceSource") resolves `@omnyo/*` through `packages/<name>/package.json` directly, not through `packages/omnyo-app/node_modules`. `@omnyo/domain` exports TypeScript source and has no build step, so no turbo build ordering depends on the edge. |

Searches that establish the table (all run against the snapshot commit, all tracked files, `pnpm-lock.yaml` excluded):

- `git grep -n -F <name> <commit>` for `playfair-display`, `space-grotesk`, `ibm-plex-mono`, `/syne` and `fontsource-variable/inter`, ignoring `package.json` lines. The first four had no hits at all. Inter hits are listed above and are all under `apps/web`.
- `git grep -n -i -E "playfair|space grotesk|ibm plex mono|plex mono|\bsyne\b"` found no family-name strings outside manifests.
- `git grep -n fontsource <commit> -- ':!apps/web' ':!pnpm-lock.yaml'` found only `apps/app/package.json:24`. This covers docs, desktop, mobile, Containerfiles, scripts and plugins.
- `git grep -l "@omnyo/connect-client"` found importers only in `apps/desktop`, `apps/host-daemon`, `apps/mobile`, `plugins/connect`, `plugins/omnyo-account` and the package itself, plus `apps/relay/package.json`.
- `git grep -n domain` over `packages/omnyo-app/{scripts,src,test}`, its tsconfig files and `vitest.config.ts` returned nothing.

Non-obvious consumers checked:

- **Scripts and tests that resolve packages from `apps/app/node_modules`.** These are the reason two sweep entries are rejected. `apps/cli/src/__tests__/plugin-build.test.ts:373-376` and its helper "linkScaffoldDeps" (line 425 onward) resolve `@radix-ui/react-checkbox` with `createRequire(apps/app/package.json)`. `apps/server/test/services/plugins/plugin-install.test.ts:68-80` "linkScaffoldDependencies" resolves every dependency of the scaffolded plugin from the same place, and the scaffold declares `@radix-ui/react-checkbox` (`packages/templates/test/plugin-scaffold.test.ts:111`). `packages/plugin-build/scripts/generate-runtime-export-manifest.mjs:21-23` "appRequire" resolves only `RUNTIME_SHIM_NPM_SPECIFIERS` (`packages/plugin-build/src/runtime-shims.mjs`), which contains neither fonts nor tiptap. `tests/qa/chat-scroll/run.mts:256-267`, `tests/qa/inline-mobile/vite.config.ts` and `apps/app/tests/qa/orca-visual-workflow/vite.config.mjs` resolve React, router, query, jotai and Vite plugins only. `scripts/check-plugin-forks.mjs:247-263` reads app dependency versions but takes radix versions from `packages/plugin-registry/package.json` devDependencies as well.
- **Peer requirements.** `@tiptap/extension-mention@3.30.5` declares a peer dependency on `@tiptap/suggestion` (lockfile package entry). `apps/app` declares and imports the mention extension (`apps/app/src/components/promptbox/editor/prompt-mention-extension.ts`). The `@tiptap/suggestion` declaration at `apps/app/package.json:68` is therefore the app satisfying a peer requirement. It stays.
- **Host-provided plugin runtime modules.** `packages/plugin-build/src/runtime-shims.mjs` "RUNTIME_SLOT_BY_SPECIFIER" lists the npm modules the app supplies to plugins at runtime. None of the seven removed packages is in it.
- **Container builds.** `apps/landing/Containerfile:12` runs `pnpm install --frozen-lockfile --ignore-scripts --filter '@omnyo/web...'`. `apps/relay/Dockerfile:13` runs `pnpm install --frozen-lockfile ... --filter "@omnyo/relay..."` and later `pnpm deploy --prod`, which drops devDependencies anyway. Both need a regenerated lockfile, and neither names a removed package.
- **Published artifacts.** `packages/omnyo-app/scripts/pack-runtime.mjs:103` deletes `devDependencies` from the packed manifest, so the `@omnyo/domain` devDependency never ships. The relay and web apps are private.
- **Turbo cache keys.** Removing `@omnyo/connect-client` from the relay means a connect-client edit no longer invalidates the relay's cached `typecheck` and `test` runs. That outcome is correct, because the relay never loads connect-client. `packages/omnyo-app` still reaches `@omnyo/domain` transitively through four declared dependencies, so its `topo` closure is unchanged.

Maintenance cost today (observed): every dependency-update pass and `pnpm install` covers four web fonts and one app font that no page loads. The landing image build installs the four unused web fonts. Two workspace edges claim relationships that do not exist, which misleads anyone reading the dependency graph.

Rejected sweep entries (do not repeat):

- `apps/app/package.json:43` `@radix-ui/react-checkbox`: two tests resolve it from `apps/app` (above). Removing it would break `apps/cli` and `apps/server` plugin scaffold tests. Moving it to devDependencies would also work but saves nothing material.
- `apps/app/package.json:68` `@tiptap/suggestion`: peer requirement of `@tiptap/extension-mention`, which the app imports.

**Proposed end state and preservation argument**

After the change:

- `apps/web/package.json` no longer lists `@fontsource-variable/playfair-display`, `@fontsource-variable/space-grotesk`, `@fontsource/ibm-plex-mono` or `@fontsource/syne`. `@fontsource-variable/inter` and every font that RF-011 has not yet removed stay.
- `apps/app/package.json` no longer lists `@fontsource-variable/inter`.
- `apps/relay/package.json` devDependencies no longer list `@omnyo/connect-client`.
- `packages/omnyo-app/package.json` devDependencies no longer list `@omnyo/domain`.
- `pnpm-lock.yaml` is regenerated by pnpm. The four font packages disappear from the `packages:` and `snapshots:` sections. Their importer entries, plus the three other importer entries, disappear from `importers:`. `@fontsource-variable/inter` keeps its package entry because `apps/web` still uses it.

Why behavior survives: none of the seven packages is imported, `@import`ed, resolved by path, provided to plugins, required as a peer, or shipped, so no bundle, stylesheet, type graph or runtime module changes. The website's fonts come from `apps/web`'s own surviving declarations, and the app keeps its system-font stack. Remaining uncertainty: a consumer outside this repository that reaches into `apps/app/node_modules/@fontsource-variable/inter` by path. None is known, the app is private, and no repository script does so.

Non-goals: removing other fonts (RF-011 owns the lab-only fonts), changing the app's font stack, and moving `@radix-ui/react-checkbox` or `@tiptap/suggestion`.

**Expected gain and cost**

- Handwritten production code: 0 lines removed, 0 added.
- Manifests: 7 lines removed across 4 `package.json` files (observed line count).
- Generated lockfile: about 41 lines removed (projection from the snapshot lockfile: 4 web font importer entries × 3 lines, 4 package entries × 3 lines, 4 snapshot entries × 2 lines, and 3 other importer entries × 3 lines). The exact number depends on pnpm's output.
- Installed packages: 4 fewer font packages in a full install and in the landing image install. Install time savings are unmeasured. Visitors and app users see no change.
- Mechanisms: none disappears. Dependency edges go from 7 unneeded to 0.
- Cost: one lockfile regeneration that conflicts textually with any concurrent lockfile change, especially RF-011.

**Execution steps**

1. Reconfirm the baseline in a fresh worktree of current `main`. Run `git grep -n -F` for each of the seven package names and confirm that the only hits are still the manifest lines listed above, the Inter hits under `apps/web`, and the `connect-client` importers outside `apps/relay`. Also rerun `git grep -l -E "createRequire\(.*app.*package\.json"` and read any new hit for an app-rooted resolution of `@fontsource-variable/inter`. Stop and re-plan if any new consumer appears. Note that `apps/relay/package.json` changed by one line between the snapshot and `main` on 2026-11-26, so locate entries by name, not by line number.
2. No new behavioral evidence is needed. The existing typecheck and build fail on any missed import.
3. Edit the manifests by removing these keys, and nothing else:
   - `apps/web/package.json` "dependencies": `@fontsource-variable/playfair-display`, `@fontsource-variable/space-grotesk`, `@fontsource/ibm-plex-mono`, `@fontsource/syne`.
   - `apps/app/package.json` "dependencies": `@fontsource-variable/inter`.
   - `apps/relay/package.json` "devDependencies": `@omnyo/connect-client`.
   - `packages/omnyo-app/package.json` "devDependencies": `@omnyo/domain`.
4. From the repository root, run `pnpm install` to rewrite `pnpm-lock.yaml`. Do not hand-edit the lockfile. If RF-011 has already landed or is in flight, rebase first and regenerate the lockfile afterwards. Checkpoint: `git diff --stat` shows exactly the four manifests and `pnpm-lock.yaml`, and the lockfile diff contains only deletions for the seven entries and the four font packages.
5. Format the changed manifests with the repository formatter (`pnpm exec oxfmt apps/web/package.json apps/app/package.json apps/relay/package.json packages/omnyo-app/package.json`) if the formatting hook did not already run.
6. Run the verification below, inspect the full diff for unrelated changes, and recount the removed lines.

**Verification and acceptance criteria**

All commands run from the repository root. Script names come from each package's `package.json` at the snapshot. The commands themselves were not run during this audit, because the snapshot has no `node_modules`.

- `pnpm install --frozen-lockfile` succeeds after the regenerated lockfile is committed locally. This proves the lockfile matches the manifests and that the Containerfiles' `--frozen-lockfile` installs will accept it.
- `pnpm --filter @omnyo/web typecheck` and `pnpm --filter @omnyo/web build` (`apps/web/package.json` scripts "typecheck" = `tsc --noEmit`, "build" = `vite build`) succeed. Then confirm with `rg -l "playfair|space-grotesk|ibm-plex-mono|syne" apps/web/dist` that the output contains no file for the removed fonts. The output directory name is assumed; check the Vite config if it differs.
- `pnpm --filter @omnyo/app typecheck` succeeds. `pnpm --filter @omnyo/app build` succeeds (script "build" generates PWA icons, runs `vite build` and precompresses `dist`).
- `pnpm --filter @omnyo/relay typecheck` and `pnpm --filter @omnyo/relay build` succeed.
- `pnpm --filter omnyo-app typecheck` succeeds (script "typecheck" = `tsc --noEmit`). A full `omnyo-app` build needs the app, server and host-daemon builds first and is not required for this change.
- Optional broader check: `pnpm exec turbo run typecheck --filter=@omnyo/web --filter=@omnyo/app --filter=@omnyo/relay --filter=omnyo-app`.
- Structural completion: `git grep -n -E "playfair-display|space-grotesk|ibm-plex-mono|@fontsource/syne"` returns nothing. `git grep -n "@fontsource-variable/inter" -- apps/app` returns nothing. `git grep -n "@omnyo/connect-client" -- apps/relay` and `git grep -n "@omnyo/domain" -- packages/omnyo-app` return nothing.
- No visual check is needed. No CSS, component or font stack changes.
- No performance comparison is needed. Runtime bundles do not change, because the removed packages were never bundled.

**Rollback and stop conditions**

- Rollback: revert the single commit. It touches four manifests and the lockfile, carries no data or compatibility implications, and a `pnpm install` restores the previous tree.
- Stop if step 1 finds a new consumer of any of the seven packages. Keep that declaration and remove the rest.
- Stop if `pnpm install` changes lockfile entries other than deletions for these packages, for example re-resolving unrelated versions. Rerun it with the existing lockfile intact, or ask the lockfile owner. Do not accept an unrelated dependency upgrade as part of this change.
- Stop if any listed typecheck or build fails with a module-resolution error naming a removed package. Restore that one declaration and record the consumer in this card.
- If RF-011 is mid-flight on the same lines, land one of the two first and regenerate the lockfile for the other. Do not merge two lockfile versions by hand.
