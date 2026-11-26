# RF-129 — Stop Prompt Library from pushing its whole starred list into Skills on every forwarded call

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** conditional. The duplication is real, but the push is not strictly redundant (see the window under Context). The sweep overstated the gain.
- **Potential:** low. About 21 handwritten production lines go, plus one cross-plugin RPC per forwarded Prompt Library call. No importer disappears: all three routes already share the one Skills importer `importLegacy`.
- **Confidence:** high on the facts, medium on the acceptability of the residual window.
- **Readiness:** conditional. Alex has to accept one named behavior, recorded in the investigation gate (step 2): in a rare chain of Skills reload failures, a star saved during the failure stays hidden from Skills until Skills next loads successfully. The star is never lost.
- **Effort:** small. One deletion in one public plugin, one schema deletion, one test rewrite and one documentation sentence.
- **Risk:** low to medium. The change crosses repositories, because the private Skills plugin must keep its `importLegacyPrompts` handler for already-installed Prompt Library builds.
- **Prerequisites:** none in code. The owner acceptance in step 2 is required.
- **Related and overlapping items:** RF-073 (decide how the public Prompt Library relates to its private successor). If RF-073 retires Prompt Library's forwarding or the whole plugin, this card is superseded; do it only if Prompt Library keeps forwarding. Also related: the sweep's ISS-S18-05, which would cache the Skills owner per plugin-list change. That is a separate change and is not part of this card.
- **Why this place:** this is a small, self-contained removal of state-coordination traffic. It sits low in the ranking because the line gain is small, the forwarded path is mostly used by the `omnyo prompts` CLI and external RPC callers once Skills owns the user interface, and the safety argument depends on an owner decision.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The audit worktree for that commit was absent while this card was written, so every snapshot file was read with `git -C $OMNYO_CHECKOUT show e9e1b74c3:<path>`. Private Skills sources were read from `$OMNYO_PLUGIN_CHECKOUT/skill-discovery` at omnyo-plugins `HEAD` `7edbc502e`. The files cited below were byte-identical to `HEAD` (checked with `cmp`).

*Subsystem in plain language.* Prompt Library (`plugins/prompt-library`, built-in id `omnyo--prompt-library`, version `0.2.0`) was merged into the private Skills plugin (`skill-discovery`, version `0.6.0`) on 2026-11-24: omnyo commit `a606eb352` and omnyo-plugins commit `924d6ae3`. When Skills 0.6 or later is running, Prompt Library keeps its CLI (`omnyo prompts …`) and RPCs, but it forwards each call to Skills. Its starred prompts reach Skills by three independent, idempotent routes:

| Route | Where | When it runs | Proven by inspection |
|---|---|---|---|
| 1. Core staging | `apps/server/src/services/plugins/plugin-runtime.ts:2604-2609` calls `stageLegacyPromptLibrary` (`apps/server/src/services/plugins/plugin-consolidations.ts:98-146`). That function copies `plugins/omnyo--prompt-library/data.db` rows into Skills' `prompt_library_legacy_prompts` table. Skills' `createStarredPromptStore` imports the staged rows at construction (`skill-discovery/prompt-store.ts:137-147`). | Every Skills load, just before its factory runs | yes |
| 2. Skills pull | `skill-discovery/prompt-service.ts:38-81` `migrateRunningLegacy` calls Prompt Library's `exportStarred` RPC (`plugins/prompt-library/server.ts:394-410`). It is reached from `ensureMigrated`, which `promptLibraryStatus`, `listStarred`, `unstar`, `markUsed`, `search` and `star` await (`prompt-service.ts:256, 326, 341-362`). The pull is cached per Skills instance by `migratedLegacy = "<source>:<version>"` of Prompt Library (`prompt-service.ts:65-67, 80`). | First call per Skills instance, or after a Prompt Library version change | yes |
| 3. Prompt Library push (this card) | `plugins/prompt-library/server.ts:88-104`, inside `skillsOwner()`. It calls Skills' `importLegacyPrompts` with the full `store.list()`. | Every forwarded call: `listStarred` (l.109), `unstar` (l.124), `markUsed` (l.139), `search` (l.299) and `star` (l.361), all through `skillsOwner()` | yes |

All three routes end in the same Skills transaction `importLegacy` (`skill-discovery/prompt-store.ts:110-135`). That transaction skips any `(source_id, prompt_id)` pair that already has a `prompt_library_imports` receipt. So route 3 normally inserts nothing, and it never updates `lastUsedAt` or re-adds a prompt that was unstarred in Skills.

*Readiness gate stays.* `skillsOwner()` first awaits Skills' `promptLibraryStatus` (`server.ts:80-87`). Skills implements that RPC as `await ensureMigrated(); return { version: 1 }` (`prompt-service.ts:359-362`). The Skills README (`skill-discovery/README.md`, section "Prompt history and favorites") documents: "The `promptLibraryStatus` RPC returns `{ "version": 1 }` only after migration". Skills' own test `prompt.test.mjs:225` "readiness waits for RPC migration and retries a failed read without duplicate stars" covers this. Route 2 therefore already runs before any forwarding, for every Skills version that Prompt Library forwards to. Only one Skills commit (`924d6ae3`) touches `prompt-service.ts`, so every Skills `>=0.6` build has `migrateRunningLegacy`. The command was `git -C $OMNYO_PLUGIN_CHECKOUT log -- skill-discovery/prompt-service.ts`.

*Route 2 accepts the same callers.* `exportStarred` accepts a plugin caller only if `isOmnyoSkills` matches it (`server.ts:394-407`). Route 3 targets exactly the plugin that the same `isOmnyoSkills` predicate selects (`server.ts:49-76`). Whenever route 3 can push, route 2 can pull.

*When route 3 is not redundant (counterevidence, Proven by inspection).* Prompt Library writes to its own store only when `skillsOwner()` returns `null`, which means Skills is absent, disabled, older than 0.6, or not `"running"`. A star saved that way reaches Skills by route 1 or route 2 whenever a new Skills instance loads, because each new instance has a fresh `migratedLegacy`. It is missed only if the *same* Skills instance goes from non-running back to `"running"` without reloading. I found one such chain in `apps/server/src/services/plugins/plugin-runtime.ts`:

1. A Skills reload runs the new factory and then hits the maintenance hold. The runtime sets the status `"disabled"` ("Paused for server maintenance", l.2639-2643) or `"error"` (host artifact problem, l.2646-2667). The previous instance is still in `loaded`, because it is only disposed later at l.2681.
2. While Skills shows that status, Prompt Library stars locally.
3. A later reload fails before the factory. `failBeforeFactory` (l.2244-2255) or the factory-failure path (l.2625) sets `"running"` with "reload failed" while it keeps the previous instance.
4. That instance's `migratedLegacy` still matches, so route 2 skips. Without route 3, the step-2 star is invisible in Skills until Skills next loads successfully. On that load, routes 1 and 2 import it from `data.db`.

Other non-running states do not create this window. Suspension (`plugin-service.ts` `suspendPlugins`/`resumeSuspendedPlugins`, around l.3229-3275) disposes the instance and reloads it. The service-driven `"degraded"` and `"needs-configuration"` paths (`plugin-runtime.ts:773, 801-812, 887`) need background services, and a search of `skill-discovery/*.ts` for service registration found none (searched for `api.services`, `.service(`, `registerService` and `defineService`). Load ordering is safe too: `loaded.set`, `handle.activate()` and `setStatus(..., "running")` run without an intervening `await` (`plugin-runtime.ts:2732-2778`).

*Consumers searched.* The scope was `git grep` at the snapshot over the whole tree, plus `grep` in `omnyo-plugins/skill-discovery`, for `importLegacyPrompts`, `skillsPromptImportResultSchema`, `promptLibraryStatus` and `exportStarred`:

- `importLegacyPrompts` has one production caller (`plugins/prompt-library/server.ts:90`). It is also used in the Prompt Library test (`plugins/prompt-library/server.test.ts:99`), and Skills defines its handler, contract and tests (`prompt-service.ts:356`, `prompt-contract.ts:186`, `prompt.test.mjs:87, 101, 110, 122`).
- `skillsPromptImportResultSchema` appears only in `plugins/prompt-library/contract.ts:163` and `plugins/prompt-library/server.ts` (the import and l.103).
- No SDK export, CLI script, persisted format or migration references the push.

*Maintenance cost today.* Every forwarded call serializes and validates the whole starred list across a plugin RPC boundary. The Prompt Library test encodes the push as the evidence that legacy stars reach Skills (`server.test.ts:91-172`, especially l.150-153), even though the real guarantee is the readiness gate plus route 2. Later readers then have to reason about three routes instead of two.

**Proposed end state and preservation argument**

- **What disappears:** the `importLegacyPrompts` call inside `skillsOwner()` (`plugins/prompt-library/server.ts:88-104`), the `skillsPromptImportResultSchema` import (`server.ts:12`) and its definition (`plugins/prompt-library/contract.ts:163-166`).
- **What remains:** `isOmnyoSkills`, the version and running check, and the `promptLibraryStatus` readiness call with its parse (`server.ts:63-87, 106`). The `exportStarred` RPC and its caller check, all forwarding, and the standalone behavior also remain. Core staging (route 1) and the Skills pull (route 2) are unchanged.
- **Canonical owner:** Skills owns migration. Skills pulls through `exportStarred` and its readiness gate, and core stages at load. Prompt Library only answers `exportStarred` and waits for readiness.
- **Contracts and semantics preserved:**
  - Forwarding still starts only after `promptLibraryStatus` resolves, and that RPC resolves only after migration.
  - The Prompt Library RPC contract `promptLibraryRpcContract` is unchanged. The only removed export, `skillsPromptImportResultSchema`, has no consumer outside the plugin.
  - Persisted formats are unchanged: `starred_prompts` in Prompt Library, and `prompt_library_imports` and the staging tables in Skills.
  - Prompt Library has no user interface change.
- **Intentionally retained limitation:** the window in Context, steps 1-4. With the change, a star saved while a held or failed Skills reload kept the old instance appears in Skills on the next successful Skills load instead of on the next forwarded call. It is never deleted, because Prompt Library's `data.db` keeps it.
- **Non-goals:**
  - Removing Skills' `importLegacyPrompts` handler. Already-installed Prompt Library 0.2.0 builds await that RPC in `skillsOwner()`, so every forwarded call would fail if Skills dropped it. The handler can go only when RF-073 or a Prompt Library minimum-version decision retires 0.2.0.
  - Caching the Skills owner (ISS-S18-05).
  - Removing the redundant `skillsPromptStatusSchema.parse` at l.87.

**Expected gain and cost**

- **Production lines (Proven by inspection; counted with `git show e9e1b74c3:plugins/prompt-library/server.ts | sed -n '88,104p' | wc -l` = 17):** about 21 handwritten lines removed. That is 17 in `server.ts:88-104`, 1 import line, and 3 lines plus a blank in `contract.ts:163-166`. Nothing is added.
- **Tests:** about 10 lines in `plugins/prompt-library/server.test.ts` change. The test should get stronger, not weaker (see the steps).
- **Docs:** one sentence in `plugins/prompt-library/PLUGIN_OVERVIEW.md:6`.
- **Mechanisms:** the migration routes go from three to two. Per forwarded call, the RPCs go from `plugins.list` + `promptLibraryStatus` + `importLegacyPrompts` + the operation to `plugins.list` + `promptLibraryStatus` + the operation. The sweep's claim that this removes one of "three importers" is wrong: the Skills importer `importLegacy` is shared and stays.
- **Performance (Hypothesis, not measured):** each forwarded search and star call saves one RPC whose payload grows with the number of stars. Skills also stops running one receipt lookup per star. The absolute saving is probably small, because forwarded traffic is mostly CLI and RPC calls. There is no performance-sensitive budget here, so no benchmark is required.
- **Cost:** the owner acceptance in step 2, and a cross-repository reasoning dependency on Skills' readiness contract.

**Execution steps**

1. **Reconfirm the snapshot.** Open `plugins/prompt-library/server.ts` and confirm that `skillsOwner()` still awaits `promptLibraryStatus` before it calls `importLegacyPrompts`. In `$OMNYO_PLUGIN_CHECKOUT/skill-discovery/prompt-service.ts`, confirm that `promptLibraryStatus` still awaits `ensureMigrated()` and that `migrateRunningLegacy` still pulls `exportStarred`. **Re-plan or stop if:**
   - Skills no longer pulls in `promptLibraryStatus`.
   - A Skills version below the one that pulls can satisfy Prompt Library's `>=0.6` check.
   - RF-073 has already retired Prompt Library forwarding.
   - Another production caller of `importLegacyPrompts` exists. Check with `rg -n importLegacyPrompts $OMNYO_CHECKOUT $OMNYO_PLUGIN_CHECKOUT --glob '!**/node_modules/**' --glob '!**/dist/**'`.
2. **Investigation gate (owner decision).** Ask the owner to accept the retained limitation: in the rare held-or-failed Skills reload chain, a star saved in Prompt Library meanwhile appears in Skills after the next successful Skills load, not immediately. If Alex declines, stop and record the item as rejected (kept as a deliberate safety net).
3. **Edit `plugins/prompt-library/server.ts`.**
   - In `skillsOwner()`, delete the whole `await api.sdk.plugins.callRpc({ pluginId: skills.id, method: "importLegacyPrompts", … })` statement (l.88-104). Keep `const status = await …promptLibraryStatus…` and `skillsPromptStatusSchema.parse(status);`, then `return skills.id;`.
   - Remove `skillsPromptImportResultSchema` from the `./contract.js` import list (l.12).
   - `store` is still used elsewhere in the file, so it stays.
4. **Edit `plugins/prompt-library/contract.ts`.** Delete `export const skillsPromptImportResultSchema = …` (l.163-165) and its trailing blank line.
5. **Edit `plugins/prompt-library/server.test.ts`**, test "forwards old commands only after Skills imports the unchanged legacy data" (l.91-172).
   - Rename it to say forwarding waits for Skills readiness.
   - Remove the `importLegacyPrompts` branch and the `imported` array (l.93, 99-103).
   - Replace the assertion at l.150-153 with two checks. First, the forwarded methods never include `"importLegacyPrompts"`. Second, for each forwarded operation, a `"promptLibraryStatus"` call comes before it. Compare indexes in `forwarded.mock.calls.map(([c]) => c.method)`.
   - Keep the `exportStarred` assertion at l.166-168, which proves that the local star remains available for Skills' pull.
   - Optionally add a case where `promptLibraryStatus` rejects, and assert that the operation fails and is not forwarded. This proves that readiness still gates forwarding.
6. **Update docs.** In `plugins/prompt-library/PLUGIN_OVERVIEW.md:6`, change "this plugin imports its starred prompts into Skills and forwards its existing commands and RPCs" to say that Skills imports this plugin's starred prompts and that this plugin forwards its existing commands and RPCs once Skills reports readiness. `plugins/prompt-library/skills/prompt-library/SKILL.md:8` is already accurate and needs no change.
7. **Version.** Repository rules on bumping the version of a built-in plugin whose code changed were not confirmed. Follow the convention of the latest Prompt Library change: commit `a606eb352` changed `plugins/prompt-library/package.json`. A version change also makes Skills re-pull once, because `migratedLegacy` keys on the version, and that is harmless.
8. **Format, lint and review the diff.** Confirm that the diff touches only the four files above (five with `package.json`). Recount the removed lines against the same baseline.
9. **Optional follow-up (separate change, private repository, not part of this card):** once Prompt Library 0.2.0 can no longer be installed alongside Skills 0.6+, remove Skills' `importLegacyPrompts` handler and contract entry and move its tests to `store.importLegacy`. That retirement belongs to RF-073.

**Verification and acceptance criteria**

The snapshot had no `node_modules`, so none of these commands were run for this card.

- `cd plugins/prompt-library && pnpm test`: the package script `test` is `vitest run --config vitest.config.ts`. Expect every test to pass, including the rewritten forwarding test.
- `cd plugins/prompt-library && pnpm typecheck` (`tsc --noEmit`) and `pnpm lint` (`oxlint …`). Both are package scripts and should pass.
- `cd $OMNYO_CHECKOUT && pnpm exec oxfmt plugins/prompt-library/server.ts plugins/prompt-library/contract.ts plugins/prompt-library/server.test.ts`, then `pnpm exec oxlint --deny-warnings --format=agent`. The workflow follows the owner's global formatting rule; the root `format` script is `oxfmt .`.
- `cd $OMNYO_CHECKOUT && pnpm check:plugin-forks`: a root script, which should pass because no sibling-plugin import is added.
- Cross-repository contract check, with no edits there: `cd $OMNYO_PLUGIN_CHECKOUT/skill-discovery && pnpm run test:prompts`. That script runs `node --experimental-strip-types --test prompt.test.mjs` and should pass unchanged. Its test "readiness waits for RPC migration…" is the independent baseline for the guarantee this card relies on.
- Structural completion: `rg -n "importLegacyPrompts|skillsPromptImportResultSchema" $OMNYO_CHECKOUT --glob '!**/node_modules/**'` returns no hits outside docs that record this audit.
- Manual acceptance, optional, needing a running Omnyo with Skills 0.6 and a Prompt Library database that holds stars:
  - `omnyo prompts list --json` shows the legacy stars after Skills loads.
  - Disable Skills, run `omnyo prompts star "x"`, re-enable Skills, and `omnyo prompts list --json` includes "x". Re-enabling reloads Skills, so route 1 and route 2 carry the star.
- No user interface changes, so no visual check is needed.

**Rollback and stop conditions**

- **Rollback:** revert the single commit. No persisted data, schema or migration changes, so a rollback has no data implications. Already-imported stars stay in Skills either way.
- **Stop if:**
  - Step 1 finds a Skills build in the field that satisfies `>=0.6` but whose `promptLibraryStatus` does not pull.
  - Another production caller depends on `skillsPromptImportResultSchema`.
  - Alex declines the retained limitation in step 2.
  - RF-073 decides to retire Prompt Library forwarding. In that case this card is superseded by that retirement.
- **Safer smaller alternative if declined:** leave the code unchanged. Do not add a dirty flag that pushes only after a local write: that keeps the mechanism and adds state, which is not a simplification.
