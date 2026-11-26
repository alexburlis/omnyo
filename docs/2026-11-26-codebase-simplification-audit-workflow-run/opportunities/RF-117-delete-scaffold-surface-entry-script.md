# RF-117 — Retire the Plugin Guide `scaffold:surface-entry` generator, or keep it and repair its drift

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Potential:** low. The change removes one small developer-only generator (237 handwritten tooling lines) and its self-test (182 lines). It removes no runtime path, persisted format or public API.
- **Confidence:** high on the facts and medium on the recommendation. The sweep's central claim, that no document or skill mentions the script, holds only inside the public snapshot. An agent skill in the private Omnyo lineage still tells agents to run the script (see Context).
- **Readiness:** decision-needed. Alex must decide whether the Plugin Guide maintenance workflow keeps a generator step before anyone deletes it.
- **Effort:** under one hour for either branch of the decision.
- **Risk:** low. Nothing at runtime, in the build or in packing consumes the script. The only realistic harm is breaking a documented agent workflow in the private lineage without updating that workflow.
- **Prerequisites:** the owner's decision recorded in the investigation gate (Execution step 1).
- **Related or overlapping RF ids:** none overlap directly. RF-115 (placeholder Plugin API Tester plugin) and RF-116 (manual-only demo examples) are the same class of decision about developer-only machinery. RF-020 also edits `turbo.json`, so a combined change must merge carefully.
- **Why it deserves its place:** this item is small, but the generator encodes a second copy of the fixture schema that has already drifted from the real manifest. Either removing the generator or making it match the manifest ends the drift. It ranks low because the gain is small and the decision is not purely technical.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The named read-only snapshot worktree was absent, so every file below was read with `git show <commit>:<path>` from `$OMNYO_CHECKOUT`. No tests were run because the snapshot has no `node_modules`. All findings are **Proven by inspection** unless labelled otherwise.

*What the subsystem is.* The Plugin Guide plugin (`plugins/plugin-api-docs`, package `omnyo-plugin-plugin-api-docs`) shows the product as annotated wireframes. Each surface card is defined in `plugins/plugin-api-docs/src/surfaces.ts`. Each visual fixture's contract (group, fidelity, required states, labels, source anchors) is in `plugins/plugin-api-docs/src/anatomy-manifest.json` under `surfaceFixtures`. The fixtures themselves are drawn in `plugins/plugin-api-docs/src/wireframes.tsx`.

*What the generator is.* The generator is a developer CLI that prints a JSON skeleton for a new surface card and fixture contract.

- `plugins/plugin-api-docs/scripts/scaffold-surface-entry.mjs` (191 lines) contains the following pieces:
  - `REQUIRED_STATES` (lines 3-8) maps each fidelity level to its required states.
  - `classifyFixtureFidelity` (lines 10-23) derives the fidelity level from four flags.
  - `parseScaffoldArgs` (lines 39-95) parses the command-line flags.
  - `validateInput` (lines 97-124) checks the parsed input.
  - `buildSurfaceEntryScaffold` (lines 126-161) returns `{ schemaVersion: 1, surface, fixture }`.
  - `renderSurfaceEntryScaffold` (lines 163-165) renders that object.
  - `usage` (lines 167-174) gives the invocation `pnpm exec turbo run scaffold:surface-entry --filter=omnyo-plugin-plugin-api-docs -- ...`.
  - `main` (lines 176-191) runs only when the file is executed directly.
- `plugins/plugin-api-docs/scripts/scaffold-surface-entry.d.mts` (46 lines) declares types for the `.mjs` file. It exists because `plugins/plugin-api-docs/tsconfig.json` includes `test`, and the test imports the `.mjs` file.
- `plugins/plugin-api-docs/test/scaffold-surface-entry.test.ts` (182 lines) tests only the generator. Its one link to real data, at lines 155-164, compares the generated fidelity and `apps/app/` sources with `anatomy.surfaceFixtures["command-palette-actions"]`.
- `plugins/plugin-api-docs/package.json:41` declares the script `"scaffold:surface-entry": "node scripts/scaffold-surface-entry.mjs"`. Line 40 carries the trailing comma that must go with it.
- `turbo.json:1074-1076` declares the task `"omnyo-plugin-plugin-api-docs#scaffold:surface-entry": { "cache": false }`.

*Line counts* (command: `git show <commit>:<path> | wc -l` for each file):

| File | Lines | Class |
|---|---|---|
| `scripts/scaffold-surface-entry.mjs` | 191 | handwritten tooling (not shipped) |
| `scripts/scaffold-surface-entry.d.mts` | 46 | handwritten tooling declarations |
| `test/scaffold-surface-entry.test.ts` | 182 | test |
| `package.json` script entry | 1 (plus 1 comma edit) | config |
| `turbo.json` task | 3 | config |

*Reachability searches.*

- `git grep -n -i 'scaffold-surface\|scaffold:surface\|scaffoldSurface\|buildSurfaceEntryScaffold\|surface-entry\|classifyFixtureFidelity' e9e1b74c3 -- .` searched the whole snapshot. It found only the five locations above.
- Nothing in the app or server bundle imports `scripts/`. `plugins/plugin-api-docs/package.json` builds from `server.ts` and `app.tsx` and has no `files` list. The sweep's statement that "the files list does not include scripts" was wrong: the package has no `files` field. The conclusion still holds, because the bundler only follows imports from those two entries. The one script path that `omnyo-plugin-build` runs by convention is `scripts/stage-assets.mjs` (`packages/plugin-build/src/prepare-plugin-runtime.ts:108`), not this file.
- `scripts/check-plugin-forks.mjs` and `scripts/lib/plugin-fork.mjs:174-185` copy the plugin out of the repository and drop only package scripts whose executable is a dropped workspace binary. `node` is not one of those binaries, so a fork keeps the script and runs its test. Deleting the script removes that test from the fork check and changes nothing else there.
- No document in the snapshot mentions the script: `docs/`, `PLUGIN_OVERVIEW.md` and every `*.md` file returned no hits. The public snapshot has no `AGENTS.md` and no `.omnyo/` directory (`git ls-tree` returns nothing for `.omnyo`).

*Counterevidence the sweep missed (decisive for readiness).*

- The script was added on 2026-08-26 by private commit `7dc6756e20` ("Plugin Guide v1 ... (#2248)"), together with the project skill `.omnyo/skills/plugin-guide-maintenance/SKILL.md` (then under `.bb/skills/`).
- That skill still exists at the retired private repository's HEAD (`$ARCHIVED_OMNYO_CHECKOUT`, commit `52b7fdf012`, 2026-11-23). Its section "Add the Guide entry" (lines 47-58) says: "For a new Guide entry, run the scaffold command", followed by the exact `pnpm exec turbo run scaffold:surface-entry --filter=omnyo-plugin-plugin-api-docs -- ...` invocation.
- The same skill file is tracked in three active private-lineage worktrees dated 2026-11-25:
  - `$AUDIT_WORKTREE`
  - `$AUDIT_WORKTREE`
  - `$AUDIT_WORKTREE`
- The public publication commit `060950255` ("Publish Omnyo source") did not carry `.omnyo/skills/` into the public tree. In the public repository the script is therefore orphaned. In the private lineage, which still produces private releases, it remains a documented agent step.

*Drift between the generator and the real manifest.* Checked with `python3 -I` over `anatomy-manifest.json`:

- All 9 `surfaceFixtures` entries carry a `labels` key, and the generator never emits one. `labels` is not schema-required: only `test/command-palette-interaction.test.ts:108` and `test/responsive-drawer-interaction.test.tsx:83,117` read it, for their own fixtures. Its absence is a gap in the generator, not a broken contract.
- `REQUIRED_STATES` disagrees with 2 of the 9 committed fixtures:
  - `composer-actions` is `fidelity: "flow"` but has `requiredStates: ["anchor", "triggered"]`, with no `outcome` state.
  - `sidebar-footer` is `fidelity: "state"` but has `requiredStates: ["action", "disclosure"]`.
- No code reads `schemaVersion`.
- The generator emits JSON for the surface card, but the card lives in TypeScript (`surfaces.ts`). Contributors therefore hand-translate the card part anyway.

*Guards that remain without the generator.*

- `test/surfaces.test.ts:84-101` ("ties every deterministic fixture contract to its visual surface group") checks four things for every fixture: the group exists, the surface belongs to that group, fidelity is one of `anchor|state|flow`, and `responsiveStrategy` is `scale-together` with at least one source.
- `test/wireframes.test.ts:56` ("draws exactly the surfaces of each visual group on its fixture") fails until the drawn targets match the group's surfaces.
- `apps/app/src/components/plugin/docs-anatomy-manifest.test.tsx:173-191` ("keeps every surface fixture anchored to current product source") fails on any anchor missing from its source file. That includes the generator's placeholder anchor "TODO: Add a stable source anchor".

*What these tests do not guard.* The decision rule in `classifyFixtureFidelity` exists only in the generator and its test. The rule is: no spatial owner gives `none`; an outcome or replacement gives `flow`; a transient state gives `state`; otherwise `anchor`. The private skill text ("Derive fidelity; do not choose it", from the original version of the skill) relies on it. If the generator goes, that rule must move into prose in the maintenance skill, or be dropped as a convention by decision.

*Maintenance cost today.* There are two copies of fixture-contract knowledge: the manifest and its tests, and the generator's `REQUIRED_STATES` and output shape. The generator copy has silently diverged (no `labels`, 2 of 9 state lists disagree). Its own test pins only one representative fixture, so the drift goes undetected. Every manifest-shape change carries an implicit, already-skipped obligation to update the generator.

**Proposed end state and preservation argument**

Alex chooses one of two end states. Both remove the duplicated fixture knowledge.

*Option A (recommended if no one uses the generator): retire it.*

- These files disappear: `scripts/scaffold-surface-entry.mjs`, `scripts/scaffold-surface-entry.d.mts` and `test/scaffold-surface-entry.test.ts`. If the `scripts/` directory is then empty, it disappears too.
- These config entries disappear: the `scaffold:surface-entry` entry in `plugins/plugin-api-docs/package.json` and the `turbo.json` task.
- The canonical owners become `surfaces.ts` for cards and `anatomy-manifest.json` for fixture contracts. The existing tests named above keep guarding them.
- In the private lineage, the "Add the Guide entry" section of `.omnyo/skills/plugin-guide-maintenance/SKILL.md` replaces the command with direct instructions:
  - Add the card to `surfaces.ts`.
  - Add the `surfaceFixtures` entry, with `labels` where interaction tests read them.
  - State the fidelity rule in one sentence: no spatial owner means a headless card and no fixture; an outcome or replacement means `flow`; a transient state means `state`; otherwise `anchor`.
- *Preservation:* no product behavior, UI, API, persisted data or shipped artifact changes. The plugin bundle (`app.js`, `server.js`) never included the script.
- *Remaining uncertainty:* the script may be used outside the skill in personal workflows. Step 1 asks Alex.

*Option B (if Alex wants the generator kept): repair and document it.*

- Fix the generator so that it does three things:
  - It emits a `labels` object keyed by required state, with empty arrays.
  - It stops asserting a fixed state list that real fixtures contradict. Either the generator emits `REQUIRED_STATES` only as a starting suggestion, or the two disagreeing fixtures are corrected; Alex decides which side is wrong.
  - It drops the unread `schemaVersion`.
- Add the `plugin-guide-maintenance` skill (or its "Add the Guide entry" section) to the public repository, so the public tree documents the command.
- This option removes no lines. It ends the drift and the orphan status.

*Non-goals:* no change to `surfaces.ts`, `anatomy-manifest.json` fixture data (except under Option B if Alex rules a fixture wrong), `wireframes.tsx`, or any test other than `test/scaffold-surface-entry.test.ts`.

**Expected gain and cost**

- *Option A, measured line removal at the snapshot:* 237 handwritten tooling lines (191 + 46) and 182 test lines. The config edit removes 1 line from `package.json` (plus a comma edit on line 40) and 3 lines from `turbo.json`. The private skill would gain about 4-6 prose lines (projection).
- *Mechanisms removed:* one CLI generator, one second copy of the fidelity-to-states rule, one type-declaration shim and one turbo task.
- *Maintenance link:* a future change to the fixture-contract shape (as when `labels` was added) no longer creates a hidden obligation to update the generator.
- *Cost:* agents lose a deterministic starting skeleton and the enforced fidelity rule. The rule survives as one sentence in the skill.
- *Performance:* neutral by inspection. The turbo task is uncached and runs only on demand. Removing the test shortens the plugin test run negligibly (not measured).
- *Option B:* adds a few lines. Its gain is correctness of the generator and a documented public workflow, not simplification.

**Execution steps**

1. **Investigation gate (required before any edit).**
   - Ask the owner: "The Plugin Guide `scaffold:surface-entry` generator is documented only by the private-lineage skill `.omnyo/skills/plugin-guide-maintenance/SKILL.md` and is absent from public docs. Do you or your agents still use it to add Guide entries? Should it be retired (Option A) or repaired and documented publicly (Option B)?"
   - Record the answer in the change description.
   - Stop and re-plan in any of these cases:
     - Alex picks Option B.
     - Someone names a consumer outside the skill, such as a script, automation or CI job.
     - Fresh `main` shows the generator changed after `e9e1b74c3`.
2. **Reconfirm the baseline on fresh `main`** in your own worktree:
   - Run `git grep -n -i 'scaffold-surface\|scaffold:surface\|buildSurfaceEntryScaffold\|classifyFixtureFidelity\|renderSurfaceEntryScaffold\|parseScaffoldArgs' -- .` from the repository root. Expect only the five locations in Context. Treat any new hit as a consumer and re-plan.
   - Run `wc -l plugins/plugin-api-docs/scripts/scaffold-surface-entry.* plugins/plugin-api-docs/test/scaffold-surface-entry.test.ts` to capture the baseline counts.
   - Confirm that `plugins/plugin-api-docs/scripts/` holds only the two scaffold files. If a `stage-assets.mjs` or another file has appeared, keep the directory.
3. **Option A edits (one checkpoint):**
   - Delete `plugins/plugin-api-docs/scripts/scaffold-surface-entry.mjs`.
   - Delete `plugins/plugin-api-docs/scripts/scaffold-surface-entry.d.mts`.
   - Delete `plugins/plugin-api-docs/test/scaffold-surface-entry.test.ts`.
   - In `plugins/plugin-api-docs/package.json` `scripts`, remove `"scaffold:surface-entry": "node scripts/scaffold-surface-entry.mjs"` and the trailing comma after `"prepare:bundled": "omnyo-plugin-build prepare-bundled"`.
   - In `turbo.json`, remove the `"omnyo-plugin-plugin-api-docs#scaffold:surface-entry": { "cache": false },` block (snapshot lines 1074-1076). Keep the surrounding entries' commas valid; `turbo.json` allows comments, so validate by running turbo rather than strict JSON parsing.
   - Do not edit `pnpm-lock.yaml`, because no dependency changes.
4. **Update the documenting skill (separate change, private lineage).** The skill lives at `.omnyo/skills/plugin-guide-maintenance/SKILL.md` in the private lineage, `$ARCHIVED_OMNYO_CHECKOUT` and its worktrees.
   - Replace lines 49-58 (the scaffold command block) with the direct-edit instructions and the one-sentence fidelity rule from the Option A end state.
   - Do this only in the private lineage's owning checkout, under that repository's rules. If the skill is later published to the public repository, publish the updated text.
   - Do not leave the old command text in place, because it would point agents at a deleted task.
5. **Inspect the diff:**
   - Run `git diff --stat`. Expect exactly three deleted files and two config edits.
   - Rerun the grep from step 2 and expect zero hits.
   - Recount the removed lines against the step 2 baseline.

**Verification and acceptance criteria**

All commands are run from the repository root of a worktree with dependencies installed (`pnpm install`). The scripts below exist at the snapshot (read from `plugins/plugin-api-docs/package.json` and root `package.json`); none were executed in this audit.

- **Plugin checks:** `pnpm exec turbo run test typecheck lint --filter=omnyo-plugin-plugin-api-docs`. Expected outcome:
  - `test/surfaces.test.ts`, `test/wireframes.test.ts` and the interaction tests pass unchanged.
  - Typecheck passes with no leftover reference to the `.d.mts` file.
  - No assertion is weakened or rewritten.
- **App-side anchor contract:** `pnpm exec turbo run test --filter=@omnyo/app -- src/components/plugin/docs-anatomy-manifest.test.tsx`. The file-filter pass-through to `vitest run` is unverified; if it is not accepted, run the full `@omnyo/app` test task. Expected outcome: it passes unchanged.
- **Fork independence:** `pnpm run check:plugin-forks -- plugins/plugin-api-docs`. The script is `node scripts/check-plugin-forks.mjs [plugins/<name> ...]`, and its usage text accepts a plugin path. Expected outcome: the forked Plugin Guide installs, typechecks and tests without the scaffold.
- **Formatting:** `pnpm run format:check` (root `oxfmt . --check`) on the touched files.
- **Turbo task removed:** `pnpm exec turbo run scaffold:surface-entry --filter=omnyo-plugin-plugin-api-docs` should report no such task, or run nothing. Expected behavior is unverified; treat a configuration error that names the missing task as acceptable.
- **Structural completion:**
  - The repository-wide grep from step 2 returns nothing.
  - `plugins/plugin-api-docs/scripts/` no longer exists, unless it holds other files.
  - The private skill no longer names the command.
- **UI:** none affected. No visual check is needed.

**Rollback and stop conditions**

- *Rollback:* the change consists of three deleted tracked files and two config edits in one commit. Reverting that commit restores them exactly. No persisted data, migration, published SDK export or shipped artifact is involved.
- *Stop conditions:*
  - Alex says the generator is still used, or picks Option B.
  - A new reference appears on fresh `main`, such as a doc, skill, CI job or automation that runs `scaffold:surface-entry`.
  - The private-lineage skill cannot be updated in the same delivery window. Then do not delete the script, because that would leave a documented agent command pointing at nothing; land both changes together.
  - Any surviving Plugin Guide or `@omnyo/app` test fails. That would mean a hidden dependency on the generator; investigate before continuing.
- *Safer smaller alternative:* if Alex wants to defer the decision, do the Option B repair only. Add `labels`, resolve the two `requiredStates` disagreements and drop `schemaVersion`. That stops the drift without retiring the workflow.
