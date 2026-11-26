# RF-123 — Remove the one-shot `importWorktreeHistory` RPC and the `historyImported` flag from Storage & Retention

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The sweep's central claim holds exactly. This card corrects the plan in three places: it adds live evidence that the cutover import already ran, it stops writing the `imported` column rather than writing a constant, and it keeps the unrelated coverage that the import test carries.
- **Potential:** low to medium. One discoverable cross-plugin RPC, one module-level contract, one mutable state variable and one persisted-flag read and write disappear. The gain is small, but the code is pure dead migration machinery.
- **Confidence:** high that nothing in the code calls the RPC. Medium-high that no installation still needs it (see the prerequisites).
- **Readiness:** ready, after the one-line confirmation in step 1. the owner's coordinator already ran the import: its `saved_scan.imported` flag is `1`.
- **Effort:** small, under one hour including focused tests.
- **Risk:** low. The worst case is an installation that never imported its standalone history. That installation loses one past cleanup receipt and one stale inventory. The next scheduled scan, which runs every three hours, replaces the inventory anyway. An imported scan never carried cleanup approvals.
- **Prerequisites:** The owner confirms that he runs no second Omnyo coordinator that had the standalone Local Worktrees plugin installed and never imported it. Hosts joined to the coordinator, such as a connected MacBook (`host_demo`) and the 3090, do not count. `saved_scan` is a single server-side row (`id = 1`) in the coordinator's plugin database, so it has no per-host copy.
- **Related or overlapping RF ids:** none overlap. RF-065 (shared worktree deletion-safety rules) and RF-070 (one background-job runner for cleanup jobs) touch other parts of the same plugin. RF-124 (one reconnect-recovery service helper) also touches `plugins/storage-retention`. None of them edits `historyImport`, `save` or the `saved_scan` read, so they can land in any order. Rebase on line numbers only.
- **Why this deserves its place:** this is the cheapest kind of simplification. It is verified dead migration machinery, it has one owner file and it requires no product decision beyond confirming that the cutover finished. Its only ongoing cost is that every change to `savedRecord` has to keep a legacy merge rule working. That is a small cost, so it ranks low on gain but high on certainty.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The named audit worktree was no longer on disk, so every file was read with `git -C $OMNYO_CHECKOUT show e9e1b74c3:<path>`. All line numbers below refer to that commit. The local `main` checkout (`5f2d3f895`) has the same code four lines lower.

*Subsystem.* Storage & Retention (`plugins/storage-retention`, plugin id `omnyo--storage-retention`) absorbed the standalone Local Worktrees plugin on 23 November 2026. Its worktree half lives in `plugins/storage-retention/src/worktrees/`. The server side keeps one saved scan record: the last inventory, the last error and the last cleanup receipt. That record is a single SQLite row in `saved_scan`, which `registerWorktrees` loads at start and writes on every scan or cleanup. During the cutover, an operator-run RPC copied the standalone plugin's last scan and cleanup receipt into this row once. The `imported` column marks that the copy happened.

*Observed facts (Proven by inspection):*

- `plugins/storage-retention/src/worktrees/server.ts:35-40`, `const historyImport = defineRpcContract({ importWorktreeHistory: { input: savedRecord, output: z.object({ snapshot, receipt }) } })`.
- `server.ts:49-53` reads the row with `SELECT payload, imported FROM saved_scan WHERE id = @id`, typed as `{ payload: string; imported: number }`.
- `server.ts:59`, `let historyImported = row?.imported === 1;`.
- `server.ts:194-202`, `function save(next = record, imported = historyImported)` upserts `(id, payload, imported)` and then assigns `historyImported = imported` (line 200).
- `server.ts:497-529`, `api.rpc.register(historyImport, { importWorktreeHistory: (previous) => {...} }, { experimental_discoverable: true })`. The handler returns `{ snapshot: false, receipt: false }` once `historyImported` is set. Otherwise it adopts the previous snapshot with `items: []` when the current store is empty, and the previous `lastCleanup` when the current one is null. It then calls `save(..., true)`.
- `server.ts:3` imports `defineRpcContract`. Its only use is line 35, so the import must be trimmed.
- `plugins/storage-retention/src/storage.ts:324`, inside `createStorage`'s `api.storage.migrate(db, [...])`: `CREATE TABLE saved_scan (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL, imported INTEGER NOT NULL DEFAULT 0)`. This is an applied migration step and must stay byte-identical. The migration runner is position-based.
- Only test consumer: `plugins/storage-retention/src/worktrees/server.test.ts:5-73`, a single test named "imports the standalone worktree history once without approving cleanup".

*Consumer search (Reproduced):*

- `git -C $OMNYO_CHECKOUT grep -n -e importWorktreeHistory -e historyImport -e historyImported e9e1b74c3 -- .` returns only `server.ts` lines 35, 36, 59, 194, 200, 498, 500 and 501, and `server.test.ts` lines 43 and 57.
- `git grep -n imported e9e1b74c3 -- plugins/storage-retention` returns only `storage.ts:324`, `server.ts:50-51,59,194,197-198,200` and `server.test.ts:26,66,68`. Neither the CLI (`src/cli.ts`), the app (`src/worktrees/app.tsx`), the skill nor the README reads the flag.
- The same snapshot-wide search of `*.md` for `importWorktree` or `history import` finds no document that describes the RPC.
- `git -C $OMNYO_PLUGIN_CHECKOUT log --all -S importWorktreeHistory` and `-S historyImport` find nothing, so the standalone plugin never called the RPC. Omnyo-plugins commit `3bb4b520` ("Retire the standalone Local Worktrees plugin", 2026-11-23) deleted `local-worktrees/` entirely.
- In the retired private repo, `git -C $ARCHIVED_OMNYO_CHECKOUT log --all -S importWorktreeHistory` finds only `e91d6841d1` (the merge) and `060950255d` (the public source publication). The merge's execplan, `docs/execplans/2026-11-23-worktrees-into-storage-retention.md` (in `e91d6841d1`), step 3 says: "Use the merged plugin's authenticated one-time history import to preserve its cleanup receipt and load its last inventory if the new store is empty."
- Dynamic or string-addressed consumers: a discoverable RPC shows up only in `omnyo plugin rpc list` and `omnyo plugin rpc inspect`, through `apps/cli/src/commands/plugin.ts:882-973`. Callers address it by method name through the generic plugin RPC endpoint, as described in `packages/templates/src/templates/omnyo-guide-plugins.md:1047`. The searches above cover every string occurrence of the method name, so no script, skill or automation calls it. No generated manifest lists the method either, because the snapshot-wide grep would have found it.
- Distribution: the standalone plugin's source lived only in the private `omnyo-plugins` repository. `e91d6841d1` removed its `local-worktrees` entry from `plugins/omnyo-official.json` and recorded it in `plugins/omnyo-plugins.json` as "Its worktree and branch tools are part of Storage & Retention". Hypothesis: no external public user ever installed it. This was not checked against marketplace install records.

*Live installation evidence (Reproduced, read-only).* I copied the database files into scratch and queried the copies, without opening the originals. The copies were removed afterwards.

- `$HOME/.omnyo/plugins/omnyo--storage-retention/data.db` (plus its WAL) has a `saved_scan` row with `imported = 1`. Its `lastCleanup.finishedAt` is `2026-11-25T15:51:01.860Z` and its `snapshot.scannedAt` is `2026-11-26T20:01:34.491Z`, so later live scans and cleanups have already replaced the imported data.
- The standalone plugin's preserved database, `$HOME/.omnyo/plugins/local-worktrees/data.db`, still exists. Its receipt dates from `2026-11-23T18:49:40.040Z`. The import has therefore already run on the owner's coordinator, and the handler would now return `{ snapshot: false, receipt: false }` for any input.

*Counterevidence considered:*

- The execplan's Progress list still shows "Push, activate the merged plugin, and retire the standalone package" unchecked. The omnyo-plugins retirement commit and the live `imported = 1` flag show that this work happened anyway; the list is stale.
- The execplan's recovery section says "An import preserves a newer cleanup receipt and is safe to repeat." That rationale existed for the cutover window only.

*Maintenance cost today:* every change to the `savedRecord` schema (`plugins/storage-retention/src/worktrees/contract.ts:126`) also changes the input schema of a published, discoverable RPC and its merge rules. `save` carries a second parameter, and the module carries a second mutable state variable, only for this path. `omnyo plugin rpc list` also advertises a dead migration method to agents.

**Proposed end state and preservation argument**

*What disappears:* the `historyImport` contract, the `importWorktreeHistory` registration and handler, the `historyImported` variable, the `imported` parameter of `save`, the `imported` field in the `saved_scan` read, the `defineRpcContract` import and the import-specific test.

*What remains:* the `saved_scan` table and its migration step at `storage.ts:324`, unchanged. The `imported` column stays in the schema as an inert column. On update its value is left as it is (`1` on the owner's coordinator); new rows get its `DEFAULT 0`. `registerWorktrees` keeps sole ownership of the saved scan record. `savedScan`, `rescan`, `cleanSaved`, `catalog` and the rest of `rpcContract` keep their behavior exactly.

*New `save` shape:*

```ts
function save(next = record) {
  lifetime.signal.throwIfAborted();
  db.prepare(
    "INSERT INTO saved_scan (id, payload) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload",
  ).run(JSON.stringify(next));
  record = next;
  publish();
}
```

The callers at `server.ts:295`, `:302` and `:359` already call `save()` with no arguments, so they do not change.

*Why this shape is the simplest sufficient option:* dropping the column would need an appended `ALTER TABLE saved_scan DROP COLUMN imported` step. That adds a migration to remove a harmless column, and it would break rollback to a build that still selects `imported`. Writing a constant `0` would reset the owner's persisted flag, so a rollback to the old build would accept a second import. Leaving the column out of the write avoids both problems.

*Preserved semantics:* saved-scan load, save, publish (`scan-changed`) and cleanup behave identically for every existing caller. The persisted format is unchanged: the same table, the same payload JSON, and the column is still present.

*Removed contract (intentional):* the method `importWorktreeHistory` on plugin `omnyo--storage-retention` disappears from the plugin RPC endpoint and from `omnyo plugin rpc list` and `omnyo plugin rpc inspect`. This is the only externally visible change.

*Reachability proof and remaining uncertainty:* no code, script, skill or document calls the method (searches above). The only installation known to have needed it has already used it. The remaining uncertainty is limited to a coordinator Alex runs that this audit cannot see; step 1 closes it.

*Non-goals:* do not drop or rename the `imported` column, do not edit the migration array, and do not delete the standalone plugin's preserved `local-worktrees/data.db` on any machine. That file is user data and outside this change. Do not touch `savedRecord` itself.

**Expected gain and cost**

Projected from the snapshot, not measured after an edit:

- **Production code** in `plugins/storage-retention/src/worktrees/server.ts` (703 lines at the snapshot): about 44 lines removed (41 non-blank). That is lines 35-41 (7), 59-60 (2), 200 (1) and 497-530 (34). Lines 3, 50-51, 194 and 197-198 are edited in place. Net is roughly -44 lines, to about 659.
- **Mechanisms removed:** one discoverable cross-plugin RPC, one module-level contract, one mutable state variable kept in sync with SQLite, and one persisted-flag read and write path.
- **Tests:** `server.test.ts` (73 lines) goes away. If the optional replacement test described in step 3 is added, it is about 35-45 lines, for a net of roughly -30 to -40 test lines.
- **Additions:** none in production.
- **Tradeoff:** an unknown installation could no longer carry its pre-cutover cleanup receipt into Storage & Retention. A fresh scan already supersedes the imported inventory.
- **Performance:** neutral. One fewer RPC registration at startup is negligible, and the upsert writes one fewer bound value. No measurement is needed.
- **Maintenance:** a `savedRecord` change no longer widens a published RPC input or needs merge-rule review, and `save` has one parameter.

**Execution steps**

1. **Investigation gate (do this before any edit).**
   - Ask the owner: "Do you run any Omnyo coordinator, other than the one at `$OMNYO_COORDINATOR_HOST`, that had Local Worktrees installed and never imported it?" If he says yes, or does not know, stop and see the stop conditions below.
   - Optionally re-read the flag on the coordinator to confirm it is still `1`. Copy the files first, never open the live database directly: `cp ~/.omnyo/plugins/omnyo--storage-retention/data.db ~/.omnyo/plugins/omnyo--storage-retention/data.db-wal "$TMPDIR/rf123/"`, then run `sqlite3 "$TMPDIR/rf123/data.db" 'SELECT imported FROM saved_scan'` and expect `1`. Remove `$TMPDIR/rf123` afterwards.
   - Re-run the consumer searches against your base commit and confirm they still return only `server.ts` and `server.test.ts`. From `$OMNYO_CHECKOUT`, run `git grep -n -e importWorktreeHistory -e historyImport -e historyImported` and `git grep -n "saved_scan\|imported" -- plugins/storage-retention`. Any new caller invalidates this plan.
2. **Baseline.** In `plugins/storage-retention`, run `pnpm test`, `pnpm typecheck` and `pnpm lint` (listed under Verification) and record the results. The snapshot has no `node_modules`, so this audit could not run them; install dependencies in a real working lane first.
3. **Edit `plugins/storage-retention/src/worktrees/server.ts`.**
   - Line 3: change the import to `import { type PluginApi } from "@omnyo/plugin-sdk";`.
   - Delete lines 35-41, the `historyImport` constant and its trailing blank line. `z` stays imported because lines 26 and 227 use it, and `savedRecord` stays because lines 56-57 use it.
   - Lines 49-53: change the statement type to `{ payload: string }` and the SQL to `SELECT payload FROM saved_scan WHERE id = @id`.
   - Delete line 59 (`let historyImported = ...`) and its blank line 60.
   - Lines 194-202: replace `save` with the one-parameter version shown in the end state. That removes the `imported` argument, the `imported` column in the INSERT and the `historyImported = imported` line.
   - Delete lines 497-530, the whole `api.rpc.register(historyImport, ...)` call and its trailing blank line. Leave the `api.rpc.register(rpcContract, ...)` call at line 531 untouched.
   - Checkpoint: `rg -n "historyImport|importWorktreeHistory|imported" plugins/storage-retention/src` should print only `storage.ts:324`.
4. **Tests in `plugins/storage-retention/src/worktrees/server.test.ts`.** This is the only server-level test that drives `registerWorktrees` through the real plugin entry. Apart from the import, it is the only test that checks two behaviors: that `savedScan` returns the persisted record, and that `cleanSaved` rejects a snapshot with no items ("No safe items remain in this scan.", `server.ts:383`). `app.test.tsx` mocks these RPCs, and `tests/git.test.ts` checks only the host contract.
   - Preferred: replace the file with one test, about 40 lines, named something like "rescans into the saved scan and refuses cleanup when no safe items remain". Use `createFakePluginHost({ pluginId: "omnyo--storage-retention", experimental_hostEntry: true, experimental_callHostRpc })`, following the pattern in `src/storage.test.ts:60-62`. Make the fake host answer the worktree `inventory` call with `{ entries: [], issues: [] }`, plus whatever other host calls `plugin(api)` makes at start; check `src/storage.test.ts` for that set. Then call `rescan`, wait for the scan to finish, assert that `savedScan` returns a snapshot with `items: []`, and assert that `cleanSaved({ snapshotId })` rejects with "No safe items remain".
   - If the fake host cannot drive a scan without large scaffolding, delete the file instead and say so in the report as lost incidental coverage. Do not keep any assertion about `imported`.
5. **Cleanup of support machinery.** No README, skill, CLI, generated artifact or marketplace entry mentions the RPC (searches in Context). Leave `storage.ts:324` and the execplan history unchanged.
6. **Final check.** Format the changed files with `pnpm exec oxfmt <files>` from the repository root. Run the verification below, review `git diff` to confirm only `server.ts` and `server.test.ts` changed, and recount lines with `wc -l plugins/storage-retention/src/worktrees/server.ts`. Expect about 659 lines, or the equivalent of a 44-line reduction from your baseline.

**Verification and acceptance criteria**

Commands. The scripts were read from `plugins/storage-retention/package.json` and the root `package.json` at the snapshot. None of them were run in this audit because the snapshot has no `node_modules`.

- `cd plugins/storage-retention && pnpm test`, which runs `vitest run --config vitest.config.ts`. Expect all tests to pass, including the replacement test from step 4 if you added it.
- `cd plugins/storage-retention && pnpm typecheck` (`tsc --noEmit`). Expect it to be clean, which proves no lingering reference to `historyImported` or to the two-argument `save`.
- `cd plugins/storage-retention && pnpm lint` (`oxlint ...`). Expect it to be clean, with no unused `defineRpcContract` import.
- From the repository root: `pnpm exec oxfmt --check plugins/storage-retention/src/worktrees/server.ts plugins/storage-retention/src/worktrees/server.test.ts`, and `pnpm exec oxlint --deny-warnings --format=agent plugins/storage-retention/src/worktrees`.

Behavior and contract checks:

- Persisted format: `storage.ts` is byte-identical to the base (`git diff --exit-code -- plugins/storage-retention/src/storage.ts`).
- On an existing database, `save` leaves `imported` untouched. Optionally prove this in the replacement test by writing `UPDATE saved_scan SET imported = 1` before a rescan and asserting it still reads `1` afterwards.
- `savedScan`, `rescan`, `cleanSaved` and `catalog` keep their behavior, which the existing `app.test.tsx` and `src/storage.test.ts` suites cover.
- Live check, only on an authorized deployment of a build containing this change (not part of the change itself): `omnyo plugin rpc list omnyo--storage-retention` no longer lists `importWorktreeHistory`, and `omnyo storage worktrees status` still shows the current receipt. The subcommand name comes from the execplan and was not re-verified here.

Structural completion: `rg -n "historyImport|importWorktreeHistory|historyImported" plugins/storage-retention` prints nothing. `save` takes one parameter. No UI is affected, so no visual comparison is needed.

**Rollback and stop conditions**

- **Rollback:** revert the one commit. The table schema and its data are unchanged, so the old build reads the row again. Because `imported` was never reset, the old build still refuses a second import on the owner's coordinator. No data migration is involved.
- **Stop if** Alex names, or is unsure about, another coordinator with standalone Local Worktrees data that was never imported. In that case, run the existing RPC once on that coordinator before removing it. The input is the standalone `saved_scan.payload` from its preserved `~/.omnyo/plugins/local-worktrees/data.db`, posted through the plugin RPC endpoint. Running it is an owner-authorized operation on that installation.
- **Stop if** a new caller of `importWorktreeHistory` appears (a script, skill, automation or plugin), or if a published plugin-SDK or marketplace document lists the method as a supported API.
- **Stop if** the replacement test in step 4 shows that `savedScan` or `cleanSaved` behaves differently from the baseline. That points to a separate defect: report it and do not fold a fix into this change.
- **Safer smaller alternative** if the owner wants to keep a manual route: keep the RPC but drop `experimental_discoverable: true`, so agents no longer see it. This saves almost nothing, so prefer deferring the item.
