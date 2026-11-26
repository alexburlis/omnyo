# RF-042 — Retire the pre-plugin kernel-automations export at database open and the Automations plugin's matching importer, keeping a visible refusal

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Potential:** medium. About 590 handwritten production lines disappear across the server and the Automations plugin (net about 575 after a small refusal check), together with a whole cross-package mechanism: a server exporter, a private JSON interchange format, a plugin importer and a plugin storage flag. The code changes rarely, so the main gain is one fewer startup-time coupling and one fewer contract shared between core and a forkable plugin, not frequent edit savings.
- **Confidence:** high that the mechanism is real, one-time, and only does work for a database that still has the pre-July-2026 kernel `automations` table. Whether any install still needs it is unknown from the repository and is the owner decision below.
- **Readiness:** decision-needed. Alex must set a minimum supported upgrade-from release at or after `desktop-v0.0.28` (8 July 2026), the first release that ships migration 0055 and this exporter.
- **Effort:** small, about 2 to 4 hours including the refusal test and the plugin change.
- **Risk:** low with the refusal kept. Without it, a server that jumps directly from `desktop-v0.0.27` or older would silently lose its automations when migration 0055 drops the tables. With the refusal, such a server stops at boot with a clear message and its data stays untouched.
- **Prerequisites:** the investigation gate in step 1 (owner decision and, optionally, a read-only check of owned machines for a pending import file).
- **Related and overlapping:** RF-006 (stopped-state BB-to-Omnyo identity adoption; separate code, but it shares the same "which old installs are still supported" decision, and its `adoptOmnyoPluginStateV1` path calls `migrate` directly, see Context). RF-012, RF-015, RF-039, RF-040, RF-043 (other one-time legacy migrations that need the same kind of support-boundary decision; Alex can decide them together). No line counts are shared with any of them.
- **Why this rank:** the mechanism is fully self-contained and cheap to remove, and the refusal keeps the only real risk visible. Its value is moderate because it is stable code; it ranks below the large dead-machinery retirements but above cosmetic cleanups.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 26 November 2026). The snapshot worktree named in the audit brief was no longer on disk, so every file was read with `git show <commit>:<path>` and `git grep <commit>` from `$OMNYO_CHECKOUT`. No tests ran: the snapshot has no `node_modules`. Release dates come from tags in the public repository and from commit history in the retired private checkout `$ARCHIVED_OMNYO_CHECKOUT`, because the public history is squashed into `060950255` "Publish Omnyo source" (24 November 2026).

*Background.* Before July 2026, automations lived in the core SQLite database in the kernel tables `automations` and `automation_runs`, with script files under `<dataDir>/automation-scripts/<automationId>/`. Commit `138f678027` "Rewrite automations as a builtin plugin (#516)" (6 July 2026, private history) moved them into the Automations plugin, which keeps its own SQLite database under `<dataDir>/plugins/automations/`. Migration `packages/db/drizzle/0055_drop_kernel_automations.sql` drops both kernel tables (`DROP TABLE IF EXISTS automation_runs; DROP TABLE IF EXISTS automations;`). To avoid losing user automations, the server exports them to a file just before migrations run, and the plugin imports that file on its next start.

*What runs today (Proven by inspection).*

1. `apps/server/src/db.ts`:15-18 imports `exportLegacyAutomationsForPluginImport` and `hasLegacyAutomationsToExport`. In `initDb`, lines 57-67 run before `migrate(db, ...)` at line 69: when both `options.dataDir` and `options.logger` are set, the exporter runs; otherwise, if the kernel `automations` table exists with rows, `initDb` throws "Cannot migrate legacy automations without dataDir and logger; ...".
2. `apps/server/src/legacy-automations-export.ts` (310 lines): `exportLegacyAutomationsForPluginImport`:254 returns early if `<dataDir>/plugins/automations/import/legacy-automations.json` exists or the `automations` table is absent or empty. Otherwise it reads all rows of `automations` and `automation_runs` (zod schemas `automationRowSchema`:18, `runRowSchema`:46), reads each referenced script from `<dataDir>/automation-scripts/<id>/` (`readLegacyAutomationScripts`:113, path containment through `resolveContainedPath`), and writes the JSON file with mode `0o600`. `hasLegacyAutomationsToExport`:308 is the table-and-count check used by the refusal branch.
3. The only production caller of `initDb` that passes `dataDir` and `logger` is `apps/server/src/start-server.ts`:194-200, so the export runs on every server start, costing one `sqlite_master` lookup (plus `existsSync` and a `COUNT(*)` when the table exists).
4. `plugins/automations/src/legacy-import.ts` (264 lines): `ingestLegacyImport`:189 returns unless the plugin storage key `legacy-import-done` (`LEGACY_IMPORT_DONE_KEY`:17) is unset and `<pluginDataDir>/import/legacy-automations.json` exists. It then validates and normalizes each row (`normalizeExecution`:127 maps old permission modes `workspace-write` and `readonly` to `accept-edits` and moves `environment` into agent execution), inserts with `INSERT OR IGNORE`, writes scripts with `automationScriptDir`, sets the flag and renames the file to `legacy-automations.json.imported`. It is called once at plugin start in `plugins/automations/src/server.ts`:31 (import) and :77 (`await ingestLegacyImport({ api, db, pluginDataDir })`).
5. `.oxlintrc.json`:285 lists `apps/server/src/legacy-automations-export.ts` in an override block that bans synchronous `child_process` calls.

*When the work stopped being needed (observed).* `git tag --contains 138f678027` in the private checkout lists `desktop-v0.0.28` as the first desktop release that contains migration 0055 and the exporter; `desktop-v0.0.27` (2 July 2026) is the last release without them. `git log -1 --format=%ad desktop-v0.0.28` gives 8 July 2026. The current desktop version at the snapshot is `1.0.171` (`apps/desktop/package.json`). The Automations plugin declares `"omnyo": ">=1.0.129"` in `plugins/automations/package.json`, so no current plugin build can run on a host old enough to still hold kernel automations. Any server that has booted any release from `desktop-v0.0.28` onward has already exported (if it had rows) and then dropped the kernel tables, after which the exporter is a no-op forever.

*Consumers searched (Proven by inspection for the stated scope).* `git grep -n -E 'legacy-automations|legacy-import|hasLegacyAutomationsToExport|exportLegacyAutomationsForPluginImport|automation-scripts|legacyAutomation' e9e1b74c3 -- .` finds only the files above, `.oxlintrc.json`:285, and the tests below. A search of `*.md`, `*.json`, `*.yml`, `*.yaml`, `*.mjs` and `*.toml` for `legacy.?(automation|import)`, `legacy-import-done` and `kernel automation` finds only `.oxlintrc.json`. Neither symbol is exported from a published package (`@omnyo/sdk`, `@omnyo/plugin-sdk`); `legacyImportFileSchema` is exported from the plugin's own module only for tests.

*Other database-open paths (counterevidence checked).*

- `migrate` is also called directly, without the exporter, by `apps/server/src/services/plugins/omnyo-plugin-state-v1.ts`:581 (BB-to-Omnyo identity adoption, RF-006), `apps/server/scripts/watch-interest-benchmark.mjs`:38 and `packages/scripts/src/commands/seed-perf-db.ts`:179. The two scripts build fresh databases. The adoption path stages the database of a BB server that requested adoption; that code was added on 12 November 2026, so the staged database comes from a server that has already booted a post-0055 release (Hypothesis, strong: the request has to come from a recent BB coordinator binding). Removing the exporter does not change any of these paths.
- Server move (`apps/server/src/services/server-move/export-snapshot.ts`, `SERVER_DATABASE_ARCHIVE_PATH = "app.db"`) was added on 16 September 2026 (`40ec7949a7`), after 0055, and archives a database from a running, already-migrated server. It cannot carry kernel automations.
- Test and fixture callers of `initDb` without `dataDir`/`logger` (`apps/server/test/helpers/test-app.ts`:181/207, `apps/server/test/machine-auth.test.ts`, `apps/server/test/app/skeleton.test.ts`, `apps/server/test/server-move/pending-boot.test.ts`:88, `tests/integration/helpers/harness.ts`:205, `tests/qa/instant-chat-history/*.mts`) open fresh or post-0055 databases and only reach the refusal branch's cheap check.
- Core migrations `0000_baseline.sql` and `0041_add_automations.sql` create the kernel tables on a fresh install before 0055 drops them. These applied migrations stay (repository policy keeps applied migrations; nothing here proves their removal safe).

*Tests that encode the mechanism (observed).* `apps/server/test/legacy-automations-export.test.ts` (261 lines; includes the refusal case at :76-89), `tests/integration/fake/legacy-automations-roundtrip.test.ts` (278 lines; exporter plus importer round trip), and in `plugins/automations/src/automations.test.ts` the `legacyAutomationRow` helper (:149-191), the `ingestLegacyImport` import (:41) and the `describe("legacy import")` block (:3302-3423), about 168 lines.

*Maintenance cost today.* Every database-opening entry point must either pass `dataDir` and `logger` or accept the refusal branch, and the server and a forkable plugin share an unversioned file format (`legacy-automations.json`) whose schema is restated in two places (`automationRowSchema` in the server, `legacyAutomationRowSchema` in the plugin). Any change to automations execution fields or permission modes must keep `normalizeExecution` able to read July-2026 rows.

*Not known from the repository.* Whether any install (self-hosted server, worker machine, Docker volume, backup) still holds a pre-`desktop-v0.0.28` database, or an un-ingested `plugins/automations/import/legacy-automations.json` because the Automations plugin has been disabled since that upgrade. The repository records no minimum upgrade-from version (search of `*.md` for "minimum upgrade", "upgrade-from", "oldest supported", "upgrade path" found nothing).

**Proposed end state and preservation argument**

*What disappears.* `apps/server/src/legacy-automations-export.ts`; the import and the export/refusal branch in `apps/server/src/db.ts`; `plugins/automations/src/legacy-import.ts` and its call in `plugins/automations/src/server.ts`; the `.oxlintrc.json`:285 entry; the exporter, round-trip and plugin legacy-import tests.

*What remains.* A small refusal in `apps/server/src/db.ts`, run unconditionally in `initDb` before `migrate`, independent of `dataDir` and `logger`:

```ts
function assertNoKernelAutomations(db: DbConnection): void {
  const table = db.$client
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'automations'")
    .get();
  if (table === undefined) return;
  const row = db.$client.prepare("SELECT 1 FROM automations LIMIT 1").get();
  if (row === undefined) return;
  throw new Error(
    "This database still holds automations from a release before July 2026. Start Omnyo <last release with the exporter> once to move them into the Automations plugin, then upgrade.",
  );
}
```

The release named in the message is the last release that still ships the exporter, which is the release before this change lands; Alex chooses the exact wording (see the gate). Migrations 0000, 0041 and 0055 are unchanged. `initDb`'s `dataDir` and `logger` options stay, because state-write admission and checkpoint and migration logging still use them.

*Preservation argument.* For every database that has booted `desktop-v0.0.28` or later, behavior is identical: the kernel table is absent, the exporter returned early, and the refusal returns early with the same `sqlite_master` lookup. For the Automations plugin on such a host, `legacy-import-done` is either already `true` or the import file is absent, so `ingestLegacyImport` returned without effect; removing it changes nothing observable. The persisted plugin storage key `legacy-import-done` and any `legacy-automations.json.imported` files stay on disk untouched; nothing reads them afterwards, and deleting user files is not part of this change.

*Intentional behavior changes (only for unsupported inputs).*

1. A pre-0055 database with rows is refused at boot instead of being exported and migrated. Data stays intact in the database, so the user can boot an intermediate release.
2. Today, if the import file already exists but the kernel rows are still present (a previous boot exported and then crashed before migrating), the exporter skips and migration 0055 drops the rows. The refusal now stops that boot instead. This is safer and only affects the same unsupported case.
3. A host whose Automations plugin was disabled since its July-2026 upgrade keeps `<dataDir>/plugins/automations/import/legacy-automations.json` on disk, but re-enabling the plugin no longer imports it. The data is not destroyed. The gate below decides whether the plugin keeps a few-line visible error for that file; the default is no plugin-side check because the precondition is narrow and verifiable on the owner's machines.

*Non-goals.* Do not remove or edit applied migrations; do not delete `.imported` files or the `legacy-import-done` key; do not change `migrate` callers in RF-006's adoption path or the perf scripts.

*Reachability proof.* The exporter has one production caller (`initDb` via `start-server.ts`:194), and the importer has one (`server.ts`:77). Both act only on state that exists solely for databases last booted before `desktop-v0.0.28`. Remaining uncertainty: whether such a database still exists anywhere, which only Alex can settle.

**Expected gain and cost**

Counts are `wc -l` over `git show e9e1b74c3:<path>`; the refusal and new test are projections.

| Scope | Removed | Added (projected) | Net |
| --- | --- | --- | --- |
| Server production | 310 (`legacy-automations-export.ts`) + 15 (`db.ts`:15-18, 57-67) | about 14 (refusal function and call) | about −311 |
| Plugin production | 264 (`legacy-import.ts`) + 2 (`server.ts`:31, :77) | 0 (or about 8 if the optional plugin warning is chosen) | −266 (or about −258) |
| Configuration | 1 (`.oxlintrc.json`:285) | 0 | −1 |
| Tests | 261 + 278 + about 168 (plugin block and helper) | about 30 (refusal test) | about −677 |

*Mechanisms before and after.* Before: one exporter, one JSON interchange file format with schemas restated in core and plugin, one plugin importer, one plugin storage flag, and a `dataDir`/`logger` coupling branch in `initDb`. After: one refusal check with no file format and no core-plugin contract.

*Maintenance.* Before, a change to automations execution fields, permission modes or script storage had to keep `normalizeExecution` and the server schemas able to read July-2026 rows, and a new database-opening entry point had to choose between passing `dataDir`/`logger` or relying on the refusal. After, neither concern exists, and the Automations plugin no longer depends on a file the core writes.

*Performance.* Neutral: the refusal keeps the same `sqlite_master` lookup per database open; the `existsSync` call and the plugin's KV read and `stat` at plugin start disappear. Not measured; the difference is negligible.

*Cost.* Users who skipped every release from July 2026 to the removal release must boot an intermediate release once. That is the decision Alex owns.

**Execution steps**

1. **Investigation gate (must pass before any edit).**
   1. Ask the owner to set the minimum supported upgrade-from release. This card is executable only if that release is `desktop-v0.0.28` or later. Also ask him to approve the refusal message wording and whether the plugin keeps the optional warning for a pending import file.
   2. Optional, read-only, on machines Alex owns and names: check whether `<OMNYO_DATA_DIR>/plugins/automations/import/legacy-automations.json` (without the `.imported` suffix) exists, for example `ls -l ~/.omnyo/plugins/automations/import/`. If such a file exists, stop and report it; that host's automations have not been imported yet.
   3. Re-confirm anchors at the current `HEAD`: `rg -n 'exportLegacyAutomationsForPluginImport|hasLegacyAutomationsToExport|ingestLegacyImport|legacy-automations' apps plugins tests packages .oxlintrc.json`. If a new caller appears (for example, a restore or import feature that can open old databases), stop and re-plan.
2. **Server checkpoint.**
   1. In `apps/server/src/db.ts`, delete the import at :15-18. Add `assertNoKernelAutomations(db: DbConnection)` (shape in the end state) above `initDb`, and replace the `if/else if` block at :57-67 with a single `assertNoKernelAutomations(db);` as the first statement inside the existing `try`, so the connection is still closed on refusal.
   2. Delete `apps/server/src/legacy-automations-export.ts`.
   3. Remove the `"apps/server/src/legacy-automations-export.ts",` line from the override `files` list in `.oxlintrc.json` (:285 at the snapshot).
   4. Delete `apps/server/test/legacy-automations-export.test.ts`. Add `apps/server/test/db-kernel-automations-refusal.test.ts` with: (a) a file database holding `CREATE TABLE automations (id text PRIMARY KEY NOT NULL); INSERT INTO automations VALUES ('auto_legacy');` makes `initDb(dbPath, { dataDir, logger: testLogger })` throw the new message, and afterwards a fresh `createConnection(dbPath)` still reads that row (nothing dropped); (b) the same without `dataDir`/`logger` also throws; (c) an empty `automations` table does not throw from the refusal (assert by calling `assertNoKernelAutomations` directly if it is exported for tests, or keep only cases a and b).
   5. Delete `tests/integration/fake/legacy-automations-roundtrip.test.ts`.
   6. Run the server and integration checks in Verification items 1 to 3.
3. **Plugin checkpoint.**
   1. In `plugins/automations/src/server.ts`, delete `import { ingestLegacyImport } from "./legacy-import.js";` (:31) and the call at :77. Keep `pluginDataDir` (:76) because later code uses it; confirm with the plugin typecheck.
   2. Delete `plugins/automations/src/legacy-import.ts`. If Alex chose the optional warning, add instead, in `server.ts` after `pluginDataDir`, a check that logs `api.log.error` with the file path when `<pluginDataDir>/import/legacy-automations.json` exists, and nothing else.
   3. In `plugins/automations/src/automations.test.ts`, delete the import at :41, the `legacyAutomationRow` helper at :149-191 and the `describe("legacy import", ...)` block at :3302-3423. Remove any `node:fs/promises` or other imports that become unused (the linter reports them).
   4. Run Verification items 4 and 5.
4. **Cleanup and recount.** Run Verification items 6 to 8, inspect the full diff for unrelated changes, and recount removed lines with `git diff --stat` against the starting commit.

**Verification and acceptance criteria**

None of these commands ran during the audit (no `node_modules`). The script names come from `package.json` files at the snapshot; the vitest file-filter form is standard vitest usage, not a repository script.

1. From the repository root: `pnpm --filter @omnyo/server exec vitest run --config vitest.config.ts test/db-kernel-automations-refusal.test.ts test/app/omnyo-startup-admission.test.ts test/app/skeleton.test.ts test/server-move/pending-boot.test.ts test/machine-auth.test.ts`. Expect all to pass; the refusal test proves a pre-0055 database is refused without data loss, and the other files prove fresh and migrated databases still open.
2. From the repository root: `pnpm --filter @omnyo/server typecheck` (script `typecheck: tsc --noEmit` in `apps/server/package.json`).
3. From the repository root: `pnpm --filter @omnyo/integration-tests typecheck` (script in `tests/integration/package.json`), to catch imports of the deleted files.
4. From the repository root: `pnpm --filter omnyo-plugin-automations test` and `pnpm --filter omnyo-plugin-automations typecheck` (scripts in `plugins/automations/package.json`).
5. From the repository root: `pnpm --filter omnyo-plugin-automations lint`, then `pnpm check:plugin-forks` (root script `node scripts/check-plugin-forks.mjs`) to confirm the plugin stays independently forkable.
6. From the repository root: `pnpm exec oxlint --deny-warnings --format=agent` and `pnpm exec oxfmt --check apps/server/src/db.ts apps/server/test/db-kernel-automations-refusal.test.ts plugins/automations/src/server.ts plugins/automations/src/automations.test.ts .oxlintrc.json`.
7. Structural completion: `rg -n 'exportLegacyAutomationsForPluginImport|hasLegacyAutomationsToExport|ingestLegacyImport|legacyImportFileSchema|legacy-import-done|legacy-automations' apps plugins tests packages .oxlintrc.json` returns no matches.
8. Behavior check of the retained contract: a database that has run migration 0055 boots exactly as before (covered by item 1). No UI changes; no visual verification is needed.

Acceptance: all commands above pass, the refusal test shows the row survives a refused boot, and the structural search is empty.

**Rollback and stop conditions**

*Rollback.* The change is two independent commits (server, then plugin) touching only code and tests; no persisted format or migration changes. Reverting either commit restores the old behavior. A host that hit the refusal keeps its untouched database and can boot the intermediate release or a reverted build.

*Stop conditions.*

- Alex does not set a minimum upgrade-from release at or after `desktop-v0.0.28`, or wants direct upgrades from older installs kept: stop; the mechanism is a current requirement.
- The gate finds an un-ingested `legacy-automations.json` on any host: stop the plugin checkpoint (step 3) until that host's plugin has imported it; the server checkpoint can still land.
- A new code path appears that opens historical databases (backup restore, import of an old data directory): stop and re-plan, because the refusal message and support boundary must then cover it.
- Any existing server or integration test that opens a real fixture database starts failing on the refusal: stop and inspect that fixture; it may be a pre-0055 fixture that needs its own decision.

*Smaller alternative.* If Alex wants to keep direct upgrades from old installs but reduce coupling, keep the exporter and importer and only make the refusal branch independent of `dataDir`/`logger`; that saves almost nothing and is not recommended as a separate opportunity.
