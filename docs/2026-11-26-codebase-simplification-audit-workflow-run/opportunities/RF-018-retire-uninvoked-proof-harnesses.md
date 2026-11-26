# RF-018 — Retire the uninvoked one-off proof, benchmark and smoke harnesses, and give the kept ones a documented command

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The central claim holds: the repository carries standalone proof, benchmark and smoke programs that no package script, turbo task, vitest `include`, test or document in this tree runs. The sweep reports overstated the scope. Three items have a real invoker or a standing role and are removed from this card (see "Excluded"). The remaining items are split into three tiers by how much owner input they need.
- **Potential:** medium. No shipped code changes. The gain is maintenance: typechecked-but-never-run files that every rename of an internal API must keep compiling, untyped scripts that rot silently, and one plugin file that reaches into core and breaks forkability.
- **Confidence:** high for the reachability facts. Medium for the value judgement on each Tier 3 tool, which only Alex can make.
- **Readiness:** conditional. Tier 1 is verified removable within the inspected scope and needs only the short gate in step 1. Tier 2 needs Alex to close an external record. Tier 3 is a keep-or-retire decision per tool, with "keep and document" as the default.
- **Effort:** small. About 1 hour for Tier 1 and Tier 2, plus about 30 minutes to write README lines for kept Tier 3 tools. Porting the unique `status-process.e2e.ts` assertions adds about 30-60 minutes.
- **Risk:** low. Nothing deleted is bundled or shipped. The realistic loss is a manual recipe that Alex still values. Every deleted file stays recoverable from Git history, and four of them also survive as patch content in the Alex Fixes plugin repository.
- **Prerequisites:** none for Tier 1. Tier 2 needs the owner's confirmation (step 1.3).
- **Related and overlapping:**
  - **RF-005** (retire BB Private desktop continuity). It counts the six orphaned desktop fixtures in Tier 1 inside its "9 fixtures, 1,292 lines". This card deletes those six now, because they already have no consumer. RF-005 should then count only its three live fixtures (581 lines). Count the 711 lines once, here. RF-005 also names `apps/desktop/scripts/measure-packaged-startup.mjs` as its startup-measurement tool, which is one reason that script stays in Tier 3.
  - **RF-012** (retire the BB-to-Omnyo rename tooling). `scripts/omnyo-renderer-map.mjs:405` lists `plugins/agent-annotations/smoke-design.mjs`. Whichever card lands second drops nothing extra; if RF-018 lands first it removes that one list entry.
  - **RF-010** (Git default-branch owner) cites `packages/host-workspace/test/status-process.e2e.ts:276-283` as the only coverage of `readDefaultBranch` for a dangling origin HEAD. Step 4 ports those assertions before deletion.
  - **RF-019** (tests/qa one-off proofs) covers `tests/qa/**`; nothing here overlaps it.
  - **RF-034 / RF-084** (desktop JSON version feed). `measure-packaged-startup.mjs:573` and `smoke-packaged-app.mjs:368` both set `OMNYO_DESKTOP_VERSION_FEED_URL`, which no source file reads. Those cards own that cleanup.
  - **RF-017** (CI-only scripts). It covers `packages/scripts/test/**`; the root `scripts/*.test.mjs` runner gap found here is recorded as an incidental finding instead.
- **Why it deserves its place:** it is low-risk, fast, and removes about 5,400 lines that cost maintenance without protecting anything. It also reduces the "is this used?" question for later audits. It ranks below the large migration retirements because it changes no runtime mechanism.

**Context and evidence**

*Snapshot.* Commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The read-only snapshot worktree named in the audit brief no longer existed when this card was written, so every file was read with `git -C $OMNYO_CHECKOUT show e9e1b74c3:<path>` and searched with `git -C $OMNYO_CHECKOUT grep -n -F <name> e9e1b74c3`. No test suite was run; the snapshot had no `node_modules`.

*What these files are.* The public repository was published from the private repository on 2026-11-24 (`060950255 "Publish Omnyo source"`). That publication carried over proof programs written for past execution plans. Several of their invokers (private plan documents, a private desktop test, a private build script) were not published. In this tree they are standalone programs: each runs with `node` or `tsx`, reads `process.argv`, and exits.

*How "uninvoked" was established (Proven by inspection).*
- `git grep -n -F <basename> e9e1b74c3` for each basename in the tables below finds only the file itself, its own test, or the listed exception.
- Package scripts were read for the root `package.json`, `@omnyo/desktop`, `@omnyo/relay`, `@omnyo/server`, `@omnyo/secret-storage`, `@omnyo/db`, `@omnyo/host-workspace`, `@omnyo/host-daemon`, `omnyo-plugin-omnyo--storage-retention` and `omnyo-plugin-agent-annotations`. None names these files.
- Vitest `include` globs: `apps/host-daemon/vitest.config.ts:18` (`src/**/*.test.ts`, `test/**/*.test.ts`), `packages/db/vitest.config.ts:13` and `packages/host-workspace/vitest.config.ts:13` (`test/**/*.test.ts`), `plugins/storage-retention/vitest.config.ts:12` (`src/**/*.test.ts`, `app.test.tsx`), `apps/server/vitest.config.ts:15-25` (`src/**/*.test.ts`, `test/**/*.test.ts`), `apps/desktop/vitest.config.ts:12` and `apps/relay/vitest.config.ts:12`. None matches `*.e2e.ts`, `*.integration.ts`, `*.integration.mjs` or a plain `.ts` script.
- Root `scripts/*.test.mjs` files use `node:test`. `vitest.config.ts` discovers projects only under `apps`, `packages`, `tests` and `examples/plugins`; `packages/plugin-sdk/vitest.config.ts` `scripts/**/*.test.mjs` is relative to `packages/plugin-sdk`; and `scripts/test-modes.mjs:265` skips the root package. So no runner executes them.
- The snapshot has no `.github/` directory. The retired private checkout `$ARCHIVED_OMNYO_CHECKOUT` (HEAD `52b7fdf012`, 2026-11-23) was searched with `git grep -l -F <basename> HEAD`. Its hits are listed per item below; none is a workflow or package script.
- Outside the repository, `rg -l -uu -F` over `$HOME/.agents`, `.claude` and `$OMNYO_PLUGIN_CHECKOUT` found references only in `omnyo-plugins/alex-fixes` (Tier 2, below).
- Limits: a search with no hits does not prove that nobody runs a file by hand. Skills on other machines and the owner's own habits were not inspectable.

*Maintenance cost today (Proven by inspection).* The `.ts` harnesses under `test/`, `src/` and `scripts/` of `apps/server`, `apps/desktop`, `apps/host-daemon/src`, `packages/db` and `packages/host-workspace` sit inside their package `tsconfig.json` `include`. Every rename of an internal export they import must update them to keep `pnpm typecheck` green, although no check ever runs them. The root `scripts/*.ts` and `.mjs` files and `apps/host-daemon/e2e/` are outside every `tsconfig`, so they rot without a signal. Example: `scripts/benchmark-command-metadata.ts:10` imports `CommandMetadataCatalog` from `apps/host-daemon/src/command-metadata.js`, and no typecheck covers that import. Editing any root `scripts/*.mjs` file also invalidates turbo caches, because `turbo.json:129` and `:221` hash `$TURBO_ROOT$/scripts/*.mjs` into `@omnyo/sdk#test` and `omnyo-app#build`.

*Tier 1: verified removable within the inspected scope (no consumer, purpose finished).*

| File | Lines | Evidence |
|---|---|---|
| `scripts/claude-question-savings.mjs` | 993 | Measurement for a finished change. `resolveCommand` (:912) enters `check` when `OMNYO_AUTOMATION_ID` is set, and :974 pauses the automation when complete. The only automation that ran it, `auto_yqqmadyiyeu` "BB > Time sinks > Claude question savings check", was disabled by 2026-11-15 (`enabled: false` in `$HOME/.omnyo/thread-storage/thr_demo/approved-repair-20261115/after-overview.json`). It runs its own stored copy, `$HOME/.omnyo/plugins/automations/scripts/auto_yqqmadyiyeu/claude-question-savings.mjs`, which differs from the repository file (`cmp`: first difference at line 33). Deleting the repository file therefore cannot affect the automation. Its day-7 report already exists next to that stored copy. |
| `scripts/claude-question-savings.test.mjs` | 468 (test) | `node:test`; no runner (see above). |
| `scripts/verify-command-metadata-watchers.mjs` | 399 | One-off native file-watcher proof; writes into `~/scratch/omnyo/fswatch-native-proof-*` (:13-18). Self-reference only (:52). No private reference. |
| `scripts/benchmark-command-metadata.ts` | 134 | One-off benchmark for metadata-only slash-command discovery. Not typechecked. Private: self only. |
| `scripts/benchmark-command-search.mjs` | 173 | One-off benchmark; hard-codes `http://127.0.0.1:6115/?story=promptbox--command-search--large-catalog` (:16). The story still exists (`apps/app/src/components/promptbox/mentions/CommandSearch.stories.tsx:74` `LargeCatalog`), so the story is not affected. Private: self only. |
| `plugins/agent-annotations/smoke-design.mjs` | 447 | Live-desktop capture proof. Reads positional argv (:9-17). Dynamically imports core paths outside the plugin: `packages/sdk/src/node.ts` (:31-32), `plugins/browser-automation/contracts.ts` (:37) and `apps/desktop/src/desktop-browser-capture.ts` (:66-70). A fork of this plugin cannot run it, contrary to `docs/forkable-plugins.md`. Not in the plugin `tsconfig.json` `include` or `package.json` scripts. Only reference: `scripts/omnyo-renderer-map.mjs:405`. Private: `docs/omnyo-migration/coverage.tsv` only. |
| `apps/server/test/provider-corpus/benchmark-shell-parsing.ts` | 138 (test) | Timing benchmark (`WARMUPS`, `SAMPLES`). Typechecked by `apps/server/tsconfig.json`. Private: an evidence JSON only. Its imports (`buildThreadTimelineWithProfile`, `clearTimelineSelectionMemo`, `createSyntheticThread`) all have other consumers, so nothing is orphaned. |
| Six desktop fixtures in `apps/desktop/test/fixtures/`: `desktop-keychain-creator-cleanup-v1.cjs` 102, `desktop-keychain-namespace-v1.cjs` 150, `desktop-keychain-fixture-cleanup-v2.m` 78, `desktop-keychain-query-guard-probe-v1.m` 141, `desktop-origin-window-continuity-v2.ts` 146, `legacy-profile-keychain-cleanup-v1.m` 94 | 711 (fixtures) | No reference anywhere in the snapshot. In the private store their consumers were `apps/desktop/scripts/prepare-profile-continuity-v2.mjs` and `apps/desktop/test/desktop-profile-adoption-native-v2.test.ts`, neither of which was published. `desktop-origin-window-continuity-v2.ts` is typechecked (`apps/desktop/tsconfig.json` includes `test`). The three neighbouring fixtures that are live (`desktop-profile-continuity-v1.cjs`, `-v2.cjs`, `desktop-protected-store-forged-parent-v2.c`) stay; RF-005 owns them. |

*Tier 2: measurement fixtures for landed performance repairs (retire after Alex closes the external record).*

| File | Lines | Evidence |
|---|---|---|
| `apps/host-daemon/e2e/native-child-idle-reaper.e2e.ts` | 811 (test) | `--owner-replay` argv mode (:121-127); imports `RuntimeManager` and `packages/agent-runtime/src/runtime-background-work-state.js`. Outside every `tsconfig`. |
| `packages/db/test/data/event-inserts.e2e.ts` | 580 (test) | Statement-preparation timing proof. Typechecked. |
| `packages/host-workspace/test/status-process.e2e.ts` | 443 (test) | Git-launch-count proof. Typechecked. **Unique assertions:** :276-283 asserts `readDefaultBranch` returns `"missing"` for a dangling origin HEAD; RF-010 cites :276-369 for non-repository and bare-repository cases. `git grep -i dangling` over `packages/host-workspace/test/*.test.ts` finds no vitest equivalent. |
| `packages/host-workspace/test/fingerprint-process.e2e.ts` | 133 (test) | Fingerprint-byte proof. Typechecked. |

External record (Proven by inspection): `$OMNYO_PLUGIN_CHECKOUT/alex-fixes/docs/performance-repairs.md` names all four as the "source fixtures" of three core repairs and tells a future re-applier to run `node --conditions=source --import tsx packages/host-workspace/test/fingerprint-process.e2e.ts`. `repairs/performance/measured-optimizations.json` and `measured-benchmarks.json` bind them by path and hash. The patches `core-event-inserts.patch:170`, `core-git.patch:29`, `core-status-validation.patch:140` and `core-native-child-guard.patch:5` each add the full file, so the content survives there even after deletion. The repairs themselves have landed in core (the files exist at the snapshot). Note that `native-child-idle-reaper.e2e.ts` has moved since the patch was made (the patch adds it at `apps/host-daemon/src/`, the snapshot has it at `apps/host-daemon/e2e/`).

*Tier 3: manual tools with standing value; default is keep and document (retire only on the owner's word).*

| File | Lines | Why it is not dead |
|---|---|---|
| `apps/desktop/scripts/measure-packaged-startup.mjs` | 826 | The only packaged-app startup measurement. RF-005's card names it as its performance check. Private: `docs/omnyo-migration/coverage.tsv` only. |
| `apps/desktop/scripts/smoke-private-updater.mjs` + `apps/desktop/test/fixtures/private-updater-native.mts` | 633 + 307 (fixture) | End-to-end proof of the supported private desktop updater (`apps/desktop/src/private-update-*.ts`). The fixture is used only at :175. Imports `createRuntimeIdentity` (:22, `packages/server-archive/src/runtime-identity.js`) and `redactCredentialText` (:23), so RF-007 must keep those names. Private: `docs/private-desktop-updates-plan.md`. |
| `apps/relay/scripts/load-smoke.mjs` + `apps/relay/src/tunnel/load-smoke-relay.ts` | 655 + 121 | Capacity smoke for the relay service. Linted (`oxlint --deny-warnings src scripts`) and typechecked (`apps/relay/tsconfig.json` includes `src` and `scripts`). `load-smoke-relay.ts` is not imported by `src/main.ts` and is not shipped. Its helper `./harness.js` `startTunnelHarness` is also used by four relay tests, so it stays either way. Private: `docs/plans/2026-11-08-omnyo-hosted-relay.md`. |
| `packages/secret-storage/scripts/key-store-selftest.mjs` | 109 | The only check that exercises the real OS key store through `keyStoreForProtection` and `openSecretVault`. Private: `docs/execplans/2026-11-19-secret-vault.md`. |
| `scripts/provider-corpus/classify-row-diff.ts` | 96 | Small CLI over `apps/server/test/provider-corpus/row-diff-classes.js`, which is live (`row-diff-classes.test.ts`, `row-snapshots.test.ts`, `allowlists/README.md`). Private: `docs/debugging-and-qa.md`, which was not published. |
| `apps/host-daemon/src/provider-installation.windows.e2e.ts` | 372 (test) | Windows provider-installation proof (`streamProviderInstallation`). The native Windows 11 host is a listed, alpha-stage platform (`docs/platform-support.md:10`, `:35`), and nothing else exercises provider installation on it. |
| `plugins/storage-retention/src/worktrees/tests/git.integration.ts` + `cleanup-scaling.integration.mjs` | 857 + 439 (test) | Real-Git proofs for worktree cleanup safety (`runCleanup`, `planCleanup`; :25-50 asserts that cleanup inspection preserves full safety eligibility). This protects user data, so it should be registered or kept rather than deleted. |
| `apps/server/test/performance/chat-open-prepare.ts` | 153 (test) | Not orphaned: it writes the manifest that the env-gated `chat-open-isolation.test.ts` (303 lines; `it.skipIf(!process.env.OMNYO_CHAT_OPEN_FIXTURE)` at :33) reads. Keep or retire the pair together. |

*Excluded from this card (sweep claims refuted).*
- `apps/server/scripts/desktop-browser-broker-smoke.mjs` (504): it has an invoker. `apps/desktop/scripts/smoke-browser-broker.mjs:106` runs it, and `apps/desktop/package.json:33` registers `smoke:browser-broker`. Report RF-S08-007 missed this.
- `apps/server/scripts/watch-interest-benchmark.mjs` (196): it is documented. `apps/server/scripts/watch-interest-benchmark.md` gives the exact commands and method. Report X2-RF-003 missed this.
- `scripts/performance.mjs` (386) and `scripts/performance.test.mjs` (49): this is the entry point of a standing app-performance scorecard, not a one-off. It drives `apps/server/test/performance/app-performance.ts` (1,682), `scorecard.ts` (331), `checkpoint.ts` and `frontend-loading.test.ts` (:157-168 list its suite files). Retiring it would be a separate decision about the whole suite. Its usage text points at `docs/performance-scorecard.md`, which exists only in the private store (incidental finding).

**Proposed end state and preservation argument**

*What disappears.* Tier 1 (13 files) always. Tier 2 (4 files) once The owner confirms. Any Tier 3 tool that Alex explicitly retires.

*What remains.* Every kept Tier 3 tool gets one line in the nearest existing README naming its exact command and prerequisites, so it has a documented invoker:
- `apps/desktop/README.md`: `measure-packaged-startup.mjs`, `smoke-private-updater.mjs`.
- `plugins/storage-retention/README.md`: `git.integration.ts`, `cleanup-scaling.integration.mjs`.
- `apps/server/test/provider-corpus/allowlists/README.md`: `classify-row-diff.ts`.
- `docs/repository-overview.md`, in a short "Manual verification tools" list, for packages that have no README: relay `load-smoke.mjs`, `key-store-selftest.mjs`, `provider-installation.windows.e2e.ts`, and the `chat-open-prepare.ts` / `chat-open-isolation.test.ts` pair.

*Preservation argument.* No deleted file is bundled, shipped, imported by product code, discovered by a plugin manifest, or run by a test, build or check (reachability evidence above). Product behavior, APIs, persisted formats, UI and performance are therefore unchanged. The unique `readDefaultBranch` assertions in `status-process.e2e.ts` are ported to `packages/host-workspace/test/git.test.ts` before that file goes, so the deletion loses no behavioral knowledge; the port makes them run for the first time. The other Tier 2 assertions are measurement assertions about launch or prepare counts on a fixed workload; they are recorded in Alex Fixes and recoverable from Git and the patches.

*Non-goals.* Changing any product code; rewriting kept tools; wiring kept tools into CI or turbo; the `OMNYO_DESKTOP_VERSION_FEED_URL` cleanup (RF-034/RF-084); `tests/qa/**` (RF-019); the root `node:test` runner gap (incidental finding); editing the Alex Fixes repository (the owner's call).

*Remaining uncertainty.* A manual habit or an off-machine skill that runs a Tier 1 file. Step 1.2 asks Alex once.

**Expected gain and cost**

Counting scope: `git show e9e1b74c3:<path> | wc -l`. Shipped production lines removed: 0.

| Tier | Tooling-script lines | Test, fixture and harness lines | Files |
|---|---|---|---|
| Tier 1 (ready) | 2,146 | 1,317 (468 test + 711 fixtures + 138 benchmark) | 13, plus 1 list entry in `scripts/omnyo-renderer-map.mjs:405` |
| Tier 2 (after confirmation) | 0 | 1,967, minus about 20-60 lines added to `git.test.ts` (projection) | 4 |
| **Default total** | **2,146** | **about 3,220-3,260 net** | **17** |
| Tier 3 (only if Alex retires; default keep) | up to 2,440 | up to 2,128, or 2,431 with `chat-open-isolation.test.ts` | up to 10 |

Additions: about 8-10 README lines for kept Tier 3 tools, and about 20-60 test lines ported from `status-process.e2e.ts`.

The 711 fixture lines are also inside RF-005's fixture count; count them here only.

*Mechanisms before and after.* Before: 17 unowned harness programs (Tier 1 and 2), 11 of which compile against internal APIs on every typecheck, plus 10 undocumented manual tools. After: 0 unowned harnesses; up to 10 documented manual tools; one plugin file fewer reaching into core.

*Maintenance example.* Today, renaming `Workspace` methods in `packages/host-workspace/src/workspace.ts` forces edits to `status-process.e2e.ts` and `fingerprint-process.e2e.ts` to keep `pnpm typecheck` green, although neither ever runs. Renaming `apps/desktop/src/desktop-browser-capture.ts` silently breaks `plugins/agent-annotations/smoke-design.mjs`. Afterwards, those edits and those silent breaks disappear, and a later audit no longer has to re-establish whether each file is used.

*Performance.* Neutral for the product. Fewer `scripts/*.mjs` edits invalidate the `omnyo-app#build` and `@omnyo/sdk#test` turbo caches (Hypothesis; not measured).

**Execution steps**

1. **Investigation gate (before any edit).**
   1. Reconfirm the anchors at the working commit: rerun `git grep -n -F <basename> HEAD` for every file in Tiers 1-2. Stop and re-plan if any new reference appears outside the file itself, its own test and `scripts/omnyo-renderer-map.mjs:405`.
   2. Ask the owner once, in one message, with the tier tables: (a) "Do you still run any Tier 1 file by hand?" (b) "May the four Tier 2 fixtures go? Their content survives in the Alex Fixes patches, and `alex-fixes/docs/performance-repairs.md` would then point at removed paths." (c) "For each Tier 3 tool: keep and document (default), or retire?" Proceed with Tier 1 unless (a) names a file. Skip Tier 2 unless (b) is yes.
   3. Confirm that automation `auto_yqqmadyiyeu` is still disabled and still uses its stored script copy (read-only `omnyo automation` listing; the `omnyo-global-skills:automations` skill documents the command). Stop on `claude-question-savings.mjs` if the automation's `execution.scriptFile` points into the repository.
   4. Check whether RF-012 has already deleted `scripts/omnyo-renderer-map.mjs` and whether RF-005 has already deleted any of the six fixtures. Skip what is gone; do not recount it.
2. **Checkpoint A: Tier 1 root scripts.** Delete `scripts/claude-question-savings.mjs`, `scripts/claude-question-savings.test.mjs`, `scripts/verify-command-metadata-watchers.mjs`, `scripts/benchmark-command-metadata.ts` and `scripts/benchmark-command-search.mjs`. Run `git grep -n -e claude-question-savings -e verify-command-metadata-watchers -e benchmark-command- HEAD`; expect no hits.
3. **Checkpoint B: Tier 1 plugin, server and desktop files.**
   1. Delete `plugins/agent-annotations/smoke-design.mjs`. If `scripts/omnyo-renderer-map.mjs` still exists, remove only the `"plugins/agent-annotations/smoke-design.mjs",` entry from the `embeddedRendererFiles` set (about line 405).
   2. Delete `apps/server/test/provider-corpus/benchmark-shell-parsing.ts`. Keep `synthetic-thread.ts`, which `timeline-perf.test.ts` uses.
   3. Delete the six fixtures named in Tier 1 from `apps/desktop/test/fixtures/`. Do not touch `desktop-profile-continuity-v1.cjs`, `desktop-profile-continuity-v2.cjs`, `desktop-protected-store-forged-parent-v2.c`, `private-updater-native.mts`, `browser-broker-smoke.ts`, `browser-cdp-smoke.ts`, `startup-retry-smoke.cjs` or `deferred.ts`; each has a live consumer.
   4. Tell the RF-005 owner that its fixture deletion list shrinks to the three live fixtures (581 lines).
4. **Checkpoint C: Tier 2 (only with the owner's yes).**
   1. Port the `readDefaultBranch` cases from `packages/host-workspace/test/status-process.e2e.ts` (dangling `refs/remotes/origin/HEAD` returns `"missing"`, around :276-283; the non-repository and bare-repository cases RF-010 cites at :276-369) into a new `describe` block in `packages/host-workspace/test/git.test.ts`, creating repositories with `fs.mkdtemp` as that file already does (for example around :145 and :289). Drop the timing and launch-count measurement.
   2. Run `pnpm --filter @omnyo/host-workspace test` and confirm the new cases pass.
   3. Delete `apps/host-daemon/e2e/native-child-idle-reaper.e2e.ts` (and the `e2e/` directory if it is then empty), `packages/db/test/data/event-inserts.e2e.ts`, `packages/host-workspace/test/status-process.e2e.ts` and `packages/host-workspace/test/fingerprint-process.e2e.ts`.
   4. Tell Alex that `alex-fixes/docs/performance-repairs.md` and `repairs/performance/measured-optimizations.json` now name removed paths. Do not edit that repository without his instruction.
5. **Checkpoint D: Tier 3 per the owner's answers.** For each kept tool, add the one-line command (copied from the tool's own usage text, with prerequisites such as a packaged app, Windows, or `pnpm install`) to the README named in "Proposed end state". For each retired tool, delete it together with its exclusive companions: `smoke-private-updater.mjs` with `private-updater-native.mts`; `load-smoke.mjs` with `load-smoke-relay.ts` (keep `harness.ts`); `chat-open-prepare.ts` with `chat-open-isolation.test.ts`.
6. **Close out.** Inspect the full diff for unrelated changes. Recount the removed lines with `git diff --stat` against the same baseline and update the totals in this card and the index if they differ.

**Verification and acceptance criteria**

All commands run from the repository root after `pnpm install --frozen-lockfile`. The script names were confirmed in the snapshot's `package.json` files; none was run for this card because the snapshot had no `node_modules`.

- `pnpm typecheck` (root `turbo run typecheck`): passes. Catches any live import of a deleted `.ts` harness or fixture.
- `pnpm lint` (root `turbo run lint`) and `pnpm format:check`: pass.
- `pnpm --filter @omnyo/desktop test` (needs `pnpm --filter @omnyo/desktop test:prepare` first): passes. Proves that no desktop test read a deleted fixture.
- `pnpm --filter @omnyo/host-workspace test`: passes, including the ported `readDefaultBranch` cases (Checkpoint C only).
- `pnpm --filter @omnyo/server typecheck`: passes.
- `pnpm check:plugin-forks plugins/agent-annotations` (root script, `node scripts/check-plugin-forks.mjs`): passes. This proves the plugin still forks cleanly.
- Structural check: `git grep -n -e smoke-design -e benchmark-shell-parsing -e keychain-namespace-v1 -e query-guard-probe -e origin-window-continuity-v2 -e legacy-profile-keychain-cleanup -e keychain-creator-cleanup -e keychain-fixture-cleanup HEAD` returns nothing. After Tier 2, the same check for `native-child-idle-reaper`, `event-inserts.e2e`, `status-process.e2e` and `fingerprint-process.e2e` returns nothing.
- Every kept Tier 3 tool has exactly one README line naming its command: `git grep -n -F <basename> HEAD -- '*.md'` returns that line.
- No UI, API, persisted format or runtime path is touched, so no visual or performance comparison is needed.

**Rollback and stop conditions**

- *Rollback.* Each checkpoint is one commit. `git revert <commit>` restores its files exactly. No data, migration or compatibility implications exist. The Tier 2 contents also survive as patches in `omnyo-plugins/alex-fixes/repairs/performance/`.
- *Stop conditions.*
  - A new reference to a Tier 1 or Tier 2 file appears (step 1.1). That file becomes Tier 3: keep and document it.
  - Alex names a Tier 1 file he still runs. Move it to Tier 3.
  - Automation `auto_yqqmadyiyeu` is re-enabled or now points at the repository copy. Keep `claude-question-savings.mjs` until it is retired.
  - Alex declines Tier 2. Skip Checkpoint C entirely; still consider porting the `readDefaultBranch` assertions as part of RF-010.
  - A desktop test fails after Checkpoint B because it reads a fixture by a computed name. Restore that fixture and record the consumer here.
- *Smaller alternative.* If Alex prefers to keep everything, do Checkpoint D only: document each tool's command. That removes the "unowned" cost but none of the typecheck burden.
