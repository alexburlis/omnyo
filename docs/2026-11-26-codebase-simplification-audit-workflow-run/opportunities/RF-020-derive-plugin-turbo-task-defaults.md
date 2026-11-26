# RF-020 — Replace the 92 hand-copied per-plugin `#typecheck`/`#test` Turbo entries with SDK-aware default tasks

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplication is real, and Turbo can derive these dependencies. The sweep's proposed end state does not work as written, though. Three corrections, each checked against the real task graph (Reproduced, see Context):
  1. `^build:types` and `^build:runtime` fail in Turbo 2.10.12 unless generic `build:types` and `build:runtime` task keys exist. The error reads: `Could not find "@omnyo/tsconfig#build:types" in root turbo.json or "build:types" in package`.
  2. A default `test` that depends on `^build:runtime` schedules `@omnyo/plugin-sdk#build:runtime` alongside `@omnyo/plugin-sdk#build` in the same `turbo run test`, because `@omnyo/server#test` and three other tasks still need `#build`. Both run `node scripts/build-runtime.mjs` and own `dist/**`, so they would write the same directory concurrently. The fix is to turn `@omnyo/plugin-sdk#build:runtime` into a scriptless transit node that depends on `build`, and to delete the duplicate script.
  3. Five source-condition packages (`@omnyo/server`, `@omnyo/agent-runtime`, `@omnyo/client-core`, `omnyo-environment-provider-host`, `@omnyo/plugin-build`) need a 3-line `typecheck` opt-out each. Without it they would start waiting for the roughly 20-second declaration build, which `turbo.json:930` says only real consumers should wait for.

  The sweep's "browser-automation drift bug" is also wrong. That plugin has its own `plugins/browser-automation/turbo.json` with equivalent `typecheck` and `test` blocks. The real drift is narrower (listed under Context).
- **Potential:** medium. About 625 to 640 config lines go from `turbo.json`, along with one hand-maintained rule in `docs/forkable-plugins.md` and one duplicate package script. No production code changes.
- **Confidence:** high. Before/after task graphs came from the repository's own Turbo binary (2.10.12) against the snapshot's manifests.
- **Readiness:** ready. The remaining performance change is small and comes with a measurement gate (see Verification).
- **Effort:** two to four hours: the edit, two dry-run graph comparisons, one cold run of a few affected packages, and the docs bullet.
- **Risk:** low. Only the Turbo task graph and cache keys change. The dry-run comparison catches every dependency change before anything executes.
- **Prerequisites:** none.
- **Related and overlapping items:** RF-117 retires `omnyo-plugin-plugin-api-docs#scaffold:surface-entry`, whose 3-line entry (`turbo.json:1074-1076`) sits inside the block this card deletes. Keep it here, and let RF-117 delete it. RF-001 (retire the classic ACP engine) deletes `omnyo-plugin-provider-acp` and edits the same block, so whichever lands second rebases. RF-041 (the SDK next-major batch) also edits `packages/plugin-sdk/package.json`. The merge note flagged RF-017 (CI-only scripts), but RF-017 has no dependency on this card: `@omnyo/scripts#test` keeps its own entry.
- **Why it deserves its place:** every new plugin, and every plugin added to the forkable list, needs two hand-copied Turbo entries chosen by a rule nobody wrote down. The entries already disagree with the rule they encode. The private history shows the cost: from 2026-08-26 to the snapshot, `turbo.json` changed in 112 commits, and at least 20 of those touched `plugin-sdk#build` lines (`git log -G'plugin-sdk#build' -- turbo.json` in `$ARCHIVED_OMNYO_CHECKOUT`). With the change, Turbo derives these dependencies from `package.json`. A package missing from the remaining opt-out list runs slower; it does not go stale.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The snapshot worktree had been removed by the time of verification, so files were read with `git -C $OMNYO_CHECKOUT show e9e1b74c:<path>`. Task graphs came from extracting every `package.json`, `turbo.json`, `pnpm-workspace.yaml` and `pnpm-lock.yaml` at that commit into a scratch directory, then running `node_modules/.bin/turbo run <tasks> --dry=json` (2.10.12, matching the root `"turbo": "^2.10.12"`) on the original and on edited copies. No task executed and no tests ran, because the snapshot has no `node_modules`.

*Why plugins need the SDK built first (Proven by inspection).* Most packages typecheck and test against `@omnyo/plugin-sdk` sources through the `source` export condition. They opt in through `packages/tsconfig/typecheck-overrides.json` (`"customConditions": ["source"]`) and `vitest.shared.ts:411` `defineWorkspaceTestConfig` (`conditions: ["source"]`). Plugin packages cannot use either, because they must stay forkable. Their tsconfig `paths` (for example `plugins/connect/tsconfig.json`) or the package `types` field point at `packages/plugin-sdk/bundled-types/*.d.ts`. Their standalone `vitest.config.ts` files resolve the SDK's `dist/`. Both are build outputs of `@omnyo/plugin-sdk#build:types` and `#build`. Forkable plugins also map `@/components/ui/icon` onto `packages/plugin-registry/flavors/components/ui/icon.tsx` (for example `plugins/account-pool/tsconfig.json` `paths`). Plugins do not depend on `@omnyo/plugin-registry`, so the flavor files must be declared as a Turbo input.

*The current mechanism (Proven by inspection).* `turbo.json:1043-1045` opens a comment block, and lines 1046-1704 hold 92 package-specific entries. Each one repeats one of four bodies:

| Body | Count | Example |
|---|---|---|
| `typecheck`: `dependsOn ["@omnyo/plugin-sdk#build:types","topo"]` | 24 | `omnyo-plugin-provider-codex#typecheck` (`turbo.json:1503`) |
| `typecheck`: same, plus `inputs ["$TURBO_DEFAULT$","$TURBO_ROOT$/packages/plugin-registry/flavors/**"]` | 28 | `omnyo-plugin-account-pool#typecheck` (`turbo.json:1110`) |
| `test`: `dependsOn ["//#ensure-native-modules","@omnyo/plugin-sdk#build","topo"]` | 13 | `omnyo-plugin-push-notifications#test` (`turbo.json:1366`) |
| `test`: same, plus the flavors `inputs` | 27 | `omnyo-plugin-account-pool#test` (`turbo.json:1117`) |

These 92 entries take 656 lines, plus the 3-line comment. A comment-stripped parse confirmed the four groups. `@omnyo/plugin-sdk#typecheck` (`turbo.json:1021`) has the first body too, but it must stay, because the SDK needs its own `build:types`. `docs/forkable-plugins.md:91-93` makes the entries a manual rule: "`turbo.json` gives the plugin's `typecheck` and `test` tasks the registry flavors as inputs, and `test` depends on `@omnyo/plugin-sdk#build`."

A root `pkg#task` key replaces the generic task completely. Each plugin `#test` entry therefore also drops the default test's `$TURBO_ROOT$/vitest*.ts` input and its `passThroughEnv: ["TMPDIR", "UPDATE_PARITY_ROW_COUNTS", "UPDATE_TRANSCRIPT_EXPECTATIONS"]` (`turbo.json:650-662`).

*Actual drift (Proven by inspection).* These comparisons used tsconfig `paths`, vitest config style and `scripts/forkable-plugins.json`:
- `plugins/provider-codex/tsconfig.json` and `plugins/push-notifications/tsconfig.json` map `@/components/ui/icon` onto the flavors, but their `#typecheck` and `#test` entries lack the flavors input. A flavor edit can therefore return a stale cached typecheck pass for them.
- Twelve forkable plugins lack the flavors input. Five non-forkable plugins have it (for example `omnyo-plugin-omnyo--git`). For two of those five (`account-usage`, `composer-predictions`), the tsconfig maps no flavors at all, so the forkable list does not determine the flavors input.
- Three plugins with `#test` entries (`account-usage`, `chat-importer`, `composer-predictions`) use the source-condition `defineWorkspaceTestConfig` and do not need the SDK dist. Nine SDK dependents with source-condition tests have no `#test` entry (`connect`, `environment-git-worktree`, `environment-project-checkout`, `environment-temporary-copy`, `omnyo-account`, `storage-retention`, `scripted-echo-provider`, `echo-provider`, `slack-bot`). Those nine are correct as they stand.
- `plugins/browser-automation` is not a gap. `plugins/browser-automation/turbo.json` (`"extends": ["//"]`) declares `typecheck` and `test` with the same dependencies and flavors input, plus `cache: false` on `test`.

*Which packages the defaults would reach (Proven by inspection).* 62 workspace packages declare `@omnyo/plugin-sdk` as `workspace:*` in `dependencies` or `devDependencies`. Only `@omnyo/plugin-sdk` defines `build:types` and `build:runtime` scripts (`packages/plugin-sdk/package.json:139-141`). So `^build:types` and `^build:runtime` only ever reach the SDK, and only from its direct dependents. The SDK dependents that typecheck from source and have no override are exactly the five packages named in the verdict; each one's tsconfig extends `typecheck-overrides.json`. `@omnyo/app#typecheck` (`turbo.json:532`) and `@omnyo/plugin-registry#typecheck` (`turbo.json:1705`) already override. `@omnyo/integration-tests#typecheck` (`turbo.json:573`) reaches the SDK transitively and keeps its explicit entry.

*The duplicate SDK build script (Proven by inspection).* `packages/plugin-sdk/package.json:139` `build` and `:140` `build:runtime` are the same command (`node scripts/build-runtime.mjs`). `turbo.json:1011` `@omnyo/plugin-sdk#build` and `:1033` `@omnyo/plugin-sdk#build:runtime` declare the same inputs and `outputs: ["dist/**"]`. The only consumer of `build:runtime` is `@omnyo/server#dev` (`turbo.json:393-407`); this search found no other: `git grep -n 'build:runtime' e9e1b74c` over the whole repository, excluding `docs/2026*`.

*Graph comparison (Reproduced).* The baseline was `turbo run typecheck test --dry=json` (402 tasks). The proposed end state below gave these results:
- No `typecheck` task changes its transitive real dependencies.
- 49 `test` tasks change dependencies. In 40 of them, `@omnyo/plugin-sdk#build` arrives through `^build:runtime` instead of an explicit entry, so the effective dependency is the same. The other nine are the source-condition SDK dependents listed above; each newly waits for `@omnyo/plugin-sdk#build`.
- `turbo run build lint prepare:bundled smoke:tarball test:integration --dry=json` is identical before and after.
- `turbo run dev --filter=@omnyo/server` swaps `@omnyo/plugin-sdk#build:runtime` for `@omnyo/plugin-sdk#build`, which is the same command.
- With the sweep's literal proposal (no generic keys), every variant failed with the "Could not find … build:types" error. With generic keys but a real `build:runtime` script, both `#build` and `#build:runtime` (same command, same `dist/**`) sat in one test graph.

*Consumers of `turbo.json` (Proven by inspection).* The search was `git grep -n 'turbo\.json' e9e1b74c -- '*.mjs' '*.ts' '*.mts' '*.js'`. `packages/scripts/test/bundled-plugin-tasks.test.mjs:8-10` parses `turbo.json` after removing whole-line `//` comments, using `replace(/^\s*\/\/.*$/gm, "")`, and asserts only `@omnyo/bundled-plugins#build`, `prepare:bundled` and `@omnyo/plugin-build#build`. `packages/scripts/test/omnyo-source-map.test.mjs` and `packages/plugin-build/src/bundled-workspace.test.ts` use their own fixture `turbo.json` files. `scripts/check-plugin-forks.mjs:360-372` runs `turbo run build build:types --filter=@omnyo/plugin-sdk --filter=@omnyo/cli`, which this change does not affect. Nothing generates or scaffolds per-plugin Turbo entries.

*Counterevidence considered.* Turbo has no glob task keys. Moving each block into a per-plugin `turbo.json` would replace 92 root entries with about 40 files, so it is not a simplification. That option does not break forks, though: browser-automation already ships one. The sweep also argued that explicit entries let source-condition packages skip the SDK build. That holds for `typecheck`, and the five opt-outs preserve it exactly. For `test`, nine packages lose it (see Expected gain and cost).

**Proposed end state and preservation argument**

What remains in `turbo.json`:

```jsonc
// Packages that import @omnyo/plugin-sdk typecheck against its bundled
// .d.ts (a build output); ^build:types reaches only the SDK, the one package
// with that script. Forkable plugins map @/components/ui/* onto the registry
// flavors, so flavor edits must re-run them.
"typecheck": {
  "dependsOn": ["^build:types", "topo"],
  "inputs": ["$TURBO_DEFAULT$", "$TURBO_ROOT$/packages/plugin-registry/flavors/**"]
},
// SDK dependents that typecheck with customConditions ["source"]
// (packages/tsconfig/typecheck-overrides.json) skip the declaration build.
"@omnyo/server#typecheck": { "dependsOn": ["topo"] },
"@omnyo/agent-runtime#typecheck": { "dependsOn": ["topo"] },
"@omnyo/client-core#typecheck": { "dependsOn": ["topo"] },
"omnyo-environment-provider-host#typecheck": { "dependsOn": ["topo"] },
"@omnyo/plugin-build#typecheck": { "dependsOn": ["topo"] },
// Generic no-op keys so ^build:types / ^build:runtime resolve in packages
// without the script (Turbo errors otherwise).
"build:types": {},
"build:runtime": {},
"test": {
  "dependsOn": ["//#ensure-native-modules", "^build:runtime", "topo"],
  "inputs": ["$TURBO_DEFAULT$", "$TURBO_ROOT$/vitest*.ts", "$TURBO_ROOT$/packages/plugin-registry/flavors/**"],
  "passThroughEnv": [/* unchanged */]
},
// Transit node (no script): plugin tests reach the SDK dist through
// ^build:runtime, and this resolves to the one real build task so the
// same dist/** is never built twice in one run.
"@omnyo/plugin-sdk#build:runtime": { "dependsOn": ["build"] },
```

The following disappear: the comment at `turbo.json:1043-1045`; the 92 entries at `turbo.json:1046-1704` (but not `omnyo-plugin-plugin-api-docs#scaffold:surface-entry`, lines 1074-1076); the `inputs`/`outputs` of `@omnyo/plugin-sdk#build:runtime`; the `build:runtime` script at `packages/plugin-sdk/package.json:140`; and the "Turbo entries" bullet in `docs/forkable-plugins.md:91-93`, whose rule becomes "nothing to add".

These stay unchanged: `@omnyo/plugin-sdk#typecheck`, `@omnyo/plugin-sdk#test`, `@omnyo/integration-tests#typecheck`, every `@omnyo/app#*`, `@omnyo/plugin-registry#*`, `@omnyo/server#test` and the other non-plugin test overrides, `@omnyo/server#dev` (its `@omnyo/plugin-sdk#build:runtime` reference still resolves), `scripts/forkable-plugins.json`, and `plugins/browser-automation/turbo.json`.

*Why semantics survive.* The typecheck graph is identical (Reproduced). Each plugin test still runs after `@omnyo/plugin-sdk#build`, now through the transit node. Build, lint, bundling and integration graphs are identical (Reproduced). `@omnyo/server#dev` still builds the SDK dist before the server starts.

*Intentional changes, all in caching and scheduling only, not in product behavior:*
1. Every package's typecheck and test cache now keys on the three flavor files. In the private history those files changed 5 times between 2026-08-26 and the snapshot, against 135 commits to `packages/shared-ui/src` over the same period.
2. Plugin tests gain the `$TURBO_ROOT$/vitest*.ts` input and the `TMPDIR` passthrough that every other test already has. This fixes stale caches after root vitest edits, and plugin tests now honor a caller's `TMPDIR`, as in sandboxed agent sessions.
3. The nine source-condition SDK dependents' tests wait for the SDK runtime build on a cold cache. Their hash additionally covers `@omnyo/plugin-sdk#build`'s three root build-script inputs (`scripts/build-utils.mjs`, `scripts/public-beta-collection.mjs`, `packages/plugin-build/src/zod-locale-stub.mjs`). SDK source edits already invalidate them through `topo`.
4. The drift is fixed: `provider-codex` and `push-notifications` gain the flavors input.

*Non-goals.* This card does not change plugin forkability, `scripts/forkable-plugins.json`, the `check:plugin-forks` script or any SDK published surface. It also does not fix the incidental cache issues reported separately: `push-notifications` lacks an `@omnyo/shared-ui` dependency, and the outputs of `build:types:internal` omit `plugin-resource.d.ts`.

**Expected gain and cost**

| Item | Before | After |
|---|---|---|
| Per-plugin `#typecheck`/`#test` entries in `turbo.json` | 92 entries, 656 lines, plus a 3-line header | 0 |
| Added `turbo.json` lines (projection, before `oxfmt`) | — | About 20 to 30: the default `inputs`, 5 opt-outs, 2 generic keys and comments |
| `@omnyo/plugin-sdk#build:runtime` | 9-line duplicate of `#build`, plus a duplicate script | About 3-line transit node; script deleted |
| Net config change | — | About 625 to 640 lines removed from `turbo.json`, 1 from `packages/plugin-sdk/package.json` |
| Handwritten production code | 0 | 0 |
| Manual rules | Docs bullet plus two copies per plugin, chosen by an unwritten rule | One derived rule; a 5-entry opt-out list whose failure mode is "slower", not "stale" |

Costs that are still unknown and must be measured, not assumed: the cold-cache wall-clock effect of the nine extra test waits on SDK `build`, which is esbuild and probably only seconds (Hypothesis). The effect of the added flavor and vitest inputs on cache hit rate is projected as negligible, based on the churn counts above.

**Execution steps**

1. **Reconfirm.** In a fresh lane from current `main`, check that `turbo.json` still has the four bodies (rerun the grouping from Context) and that `packages/plugin-sdk/package.json` still has identical `build` and `build:runtime` scripts. Search for new consumers of `build:runtime` with `git grep -n 'build:runtime'`. Re-plan if any of these hold: a plugin `#typecheck`/`#test` entry gained a fifth, distinct body; another package gained a `build:types` or `build:runtime` script; a new source-condition SDK dependent appeared without an override (add it to the opt-outs); or Turbo was upgraded past 2.10.x (redo the dry-run proof).
2. **Capture baselines** before any edit, from the repository root:
   - `pnpm exec turbo run typecheck test --dry=json > "$TMPDIR/rf020-before-tt.json"`
   - `pnpm exec turbo run build lint prepare:bundled smoke:tarball test:integration --dry=json > "$TMPDIR/rf020-before-other.json"`
   - `pnpm exec turbo run dev --filter=@omnyo/server --dry=json > "$TMPDIR/rf020-before-dev.json"`
3. **Edit `turbo.json` default tasks.** Replace `"typecheck"` at `turbo.json:529-531` with the block in the end state. Add the five opt-out entries and the generic `"build:types": {}` and `"build:runtime": {}` keys next to it. In `"test"` (`turbo.json:650`), add `"^build:runtime"` between `//#ensure-native-modules` and `topo`, and append the flavors glob to `inputs`. Leave `passThroughEnv` unchanged. Put every comment on its own line: `bundled-plugin-tasks.test.mjs` strips only whole-line `//` comments, so a trailing comment would break its parse.
4. **Make `@omnyo/plugin-sdk#build:runtime` a transit node.** At `turbo.json:1033-1041`, replace the body with `{ "dependsOn": ["build"] }` plus the comment from the end state. Delete `"build:runtime": "node scripts/build-runtime.mjs",` from `packages/plugin-sdk/package.json:140`. Do not touch `@omnyo/server#dev`.
5. **Delete the per-plugin block.** Remove `turbo.json:1043-1045` and every entry from 1046 to 1704 whose body equals one of the four bodies. Keep `omnyo-plugin-plugin-api-docs#scaffold:surface-entry` unless RF-117 has already landed. Keep `@omnyo/plugin-registry#typecheck` and `#test` (lines 1705-1712).
6. **Checkpoint: compare graphs.** Rerun the three dry runs into `rf020-after-*.json`. Compare each task's transitive set of real dependencies, ignoring tasks whose `command` is `<NONEXISTENT>`, plus its `resolvedTaskDefinition` inputs, env and passThroughEnv. Use a short `node -e` script. The expected result is the acceptance criteria below; stop on any other difference.
7. **Update the docs.** In `docs/forkable-plugins.md:91-93`, replace the "Turbo entries" bullet with one sentence: the root `turbo.json` default `typecheck` and `test` tasks already build the SDK's declarations and runtime first and hash the registry flavors, so a listed plugin needs no Turbo entry. Search `docs/`, `AGENTS.md` and `plugins/*/README.md` for other text that tells authors to add per-plugin Turbo entries (none was found at the snapshot).
8. **Optional, same commit.** The `typecheck` block in `plugins/browser-automation/turbo.json` now equals the default and can be deleted (7 lines). Its `test` block must keep `cache: false`, and its `dependsOn`/`inputs` can be dropped only if a dry run shows the same closure. Skip this step if you want the smallest diff.
9. **Format and check.** Run `pnpm exec oxfmt turbo.json packages/plugin-sdk/package.json docs/forkable-plugins.md`, then `pnpm format:check`. Inspect the whole diff for leftover per-plugin entries (`rg -n '"omnyo-plugin-[^"]+#(typecheck|test)"' turbo.json` should print nothing) and recount the removed lines with `git diff --numstat`.

**Verification and acceptance criteria**

All commands run from the repository root, using root `package.json` scripts or the repository's own Turbo.

- **Graph equivalence (required).** Compare the step 2 and step 6 dry runs:
  - `typecheck test`: no `typecheck` task changes its real dependencies. Among `test` tasks, only these nine gain `@omnyo/plugin-sdk#build`: `omnyo-plugin-connect`, `omnyo-plugin-echo-provider`, `omnyo-plugin-environment-git-worktree`, `omnyo-plugin-environment-project-checkout`, `omnyo-plugin-environment-temporary-copy`, `omnyo-plugin-omnyo--storage-retention`, `omnyo-plugin-omnyo-account`, `omnyo-plugin-scripted-echo-provider` and `omnyo-plugin-slack-bot`. No graph may contain `@omnyo/plugin-sdk#build:runtime` with a real command.
  - Input changes are limited to the flavors glob, plus `$TURBO_ROOT$/vitest*.ts` and the default `passThroughEnv` on the 40 former plugin test entries.
  - `build lint prepare:bundled smoke:tarball test:integration` is identical.
  - `dev --filter=@omnyo/server` differs only by `#build:runtime` turning into `#build`.
- **Ordering proof on a clean SDK (required).** In a lane where `packages/plugin-sdk/dist` and `packages/plugin-sdk/bundled-types` do not exist, run `pnpm exec turbo run typecheck test --force --filter=omnyo-plugin-provider-codex --filter=omnyo-plugin-account-pool --filter=omnyo-plugin-connect --filter=@omnyo/server`. Expected: all pass. The SDK `build:types` and `build` run once each, and neither `@omnyo/server#typecheck` nor `omnyo-plugin-connect#typecheck` waits on `build:types`; check the dependency list in `--summarize`.
- **Cache invalidation proof (required).** After a cached run of `pnpm exec turbo run typecheck --filter=omnyo-plugin-provider-codex`, append a blank line to `packages/plugin-registry/flavors/components/ui/icon.tsx` in a scratch lane. The next dry run must show a new hash for `omnyo-plugin-provider-codex#typecheck`. That task could not be invalidated before.
- **Existing tests.** Run `pnpm exec turbo run test --filter=@omnyo/scripts`; `bundled-plugin-tasks.test.mjs` must still parse `turbo.json` and pass. Before handing off, run `pnpm typecheck` once (root script `turbo run typecheck`).
- **Performance (required, small).** On the same machine, with the same `node_modules` and a forced cold cache, time `pnpm exec turbo run test --force --filter=omnyo-plugin-connect --filter=omnyo-plugin-environment-git-worktree` before and after. Expected cost: the SDK `build` duration, once. No regression allowance exists in the repository, so record both numbers in the commit message and let Alex judge any increase beyond a few seconds.
- **Structural completion.** `rg -n '"omnyo-plugin-[^"]+#(typecheck|test)"' turbo.json` prints nothing. `rg -n 'build:runtime' packages/plugin-sdk/package.json` prints nothing. `docs/forkable-plugins.md` no longer asks for Turbo entries.

**Rollback and stop conditions**

- *Rollback.* The change is one commit touching `turbo.json`, `packages/plugin-sdk/package.json` and `docs/forkable-plugins.md`, plus optionally `plugins/browser-automation/turbo.json`. Reverting it restores the old graph exactly. No persisted data, published SDK surface or client contract changes. Turbo cache entries are keyed by hash, so old and new entries coexist without corruption.
- *Stop conditions.*
  - The dry run shows a `typecheck` dependency change, or a `test` dependency change beyond the nine listed tasks. Re-derive the opt-out list before continuing.
  - Turbo rejects the generic no-op keys or the scriptless transit node in a newer version.
  - Something outside `turbo.json` calls `pnpm --filter @omnyo/plugin-sdk build:runtime`, for example a CI workflow or an external script found later. Keep the script and instead make `@omnyo/plugin-sdk#build` depend on `build:runtime`, after checking that this introduces no double build.
  - Alex rejects the measured cold-cache cost of the nine extra test waits.
- *Smaller alternative if the change is rejected.* Keep the entries. Correct the drift (add the flavors input to `provider-codex` and `push-notifications`). Add a `packages/scripts/test` assertion, next to `bundled-plugin-tasks.test.mjs`, that every SDK-dependent plugin with a non-source tsconfig or vitest config has the matching entries, and that every plugin whose tsconfig maps `plugin-registry/flavors` declares that input. That alternative removes no lines, but it stops further drift.
