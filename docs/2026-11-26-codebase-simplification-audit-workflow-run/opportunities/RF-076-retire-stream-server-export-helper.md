# RF-076 — Retire the standalone `stream-server-export` data-directory export helper (owner decision)

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Potential:** medium. Two tooling files (749 lines) and one 573-line child-process test disappear, together with a second export entry point and a second manifest-fact reader that every change to the server-move snapshot code must keep working.
- **Confidence:** high that nothing in the repository invokes the helper; medium on whether Alex still wants it as an operator tool. History shows it was a real production tool in October 2026, not an abandoned experiment.
- **Readiness:** decision-needed. Alex must decide whether an offline "export a data directory without the server running" tool is still a supported operator capability.
- **Effort:** small, about 2 hours including the test port.
- **Risk:** low for the product; no runtime, API, persisted-format or UI change. The real risk is losing an operator recovery path that lives in someone's notes rather than in the repository.
- **Prerequisites:** the owner's decision (investigation gate below). No other RF item must land first.
- **Related or overlapping items:** none overlap directly. It is the same kind of decision as RF-017, RF-018 and RF-019 (uninvoked scripts and harnesses), but those cards do not cover this file. Nearby server-move code is not touched by any other RF item.
- **Why it deserves its place:** it is the only second caller of `withServerDataSnapshot` and `withSqliteReadSnapshot`, so it doubles the contract surface of the server-move snapshot code. The 2026-11-19 secret-vault work had to update it as a separate export path, and the slowest server-move test file spawns it as a child process. If Alex does not need it, removing it is a clean subtraction. If he does, the card's alternative records why "route its facts through `@omnyo/db`" is not the simple fix the sweep suggested.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The linked worktree named in the task no longer existed when this card was written, so every file was read with `git show e9e1b74c3…:<path>` and searched with `git grep` against that commit from `$OMNYO_CHECKOUT`. The snapshot has no `node_modules`, so no test was run.

What the subsystem does. Omnyo's server can export its data directory as a server archive (`.tar.gz` plus manifest) for a server move or backup. The supported in-product route is `omnyo server export` and server moves, served by `apps/server/src/routes/server-move.ts:146` calling `streamServerExport` in `apps/server/src/services/server-move/export.ts:132`. That route needs a running server: it backs up the live database through the server's own connection (`withLiveServerSnapshot`, `export.ts:66`) and reads manifest facts with `countAppliedMigrations` and `getExperiments` from `@omnyo/db` (`serverManifestInput`, `export.ts:88-100`).

The helper is a second, out-of-process entry point:

- `apps/server/scripts/stream-server-export.ts` (600 lines). It parses its own CLI with `parseCli` (line 161): `--data-dir`, `--work-dir`, `--margin-bytes`, `--sqlite-module` (a path to a `better-sqlite3` build, loaded by `loadSqliteModule` at line 235), `--omnyo-app` (an installed runtime directory whose identity `loadRuntime` reads at line 265), and optionally `--listen`, `--token-file` and `--max-wait-seconds`. Without the serve options, `runStdoutExport` (line 288) writes the archive to stdout. With them, `runServeExport` (line 364) runs a one-shot HTTP listener that refuses unspecified addresses (`parseListen`, line 139), checks a bearer token in constant time (`bearerDigest`, line 330), serves exactly one `GET /export`, writes a `<token-file>.result.json` sidecar (`writeSidecar`, line 334), and exits with codes 0, 1, 2 (usage), 3 (no client before the timeout) or 129/130/143 for signals.
- `apps/server/scripts/stream-server-export-core.ts` (149 lines). `exportDataDirArchive` (line 98) calls `withServerDataSnapshot` with a database backup taken inside `withSqliteReadSnapshot`, then `streamServerArchive` from `@omnyo/server-archive`. `readServerManifestFacts` (line 65) reads the migration count and the `serverMove` experiment with raw SQL against `__drizzle_migrations` and `system_experiments`. `readOmnyoAppRuntime` (line 54) maps `readRuntimeIdentity` to an app version and protocol version.

Line counts (Reproduced, `git show <commit>:<file> | wc -l` and `grep -cv '^\s*$'`):

| File | Lines | Non-blank |
|---|---|---|
| `apps/server/scripts/stream-server-export.ts` | 600 | 497 |
| `apps/server/scripts/stream-server-export-core.ts` | 149 | 133 |
| `apps/server/test/server-move/stream-server-export-cli.test.ts` | 573 | 480 |
| `apps/server/test/server-move/export-stream.test.ts`, describe block at lines 619-816 | 198 | 173 |

Reachability (Proven by inspection, with the stated searches):

- `git grep -n -I -e stream-server-export -e streamServerExport -e exportDataDirArchive -e max-wait-seconds -e sqlite-module -e result.json e9e1b74c3… -- .` finds the helper only in its own two files, `apps/server/test/server-move/stream-server-export-cli.test.ts`, `apps/server/test/server-move/export-stream.test.ts:32,620` and the prose at `docs/api_to_audit.md:4747`. All other hits are unrelated (`streamServerExport` is the server route's function, and `result.json` hits are other harnesses).
- `git grep -e token-file -e margin-bytes -e EXIT_NO_CLIENT` outside the helper and its CLI test finds nothing relevant.
- `apps/server/package.json` "scripts" has no entry for it, and its "build" script bundles no `scripts/stream-server-export*` entry. `packages/omnyo-app/package.json` "files" ships `server/dist` and host-daemon bundles only, so the helper is not in any installed runtime.
- No `knip` configuration exists, and no JSON configuration or doc outside `docs/api_to_audit.md` names `apps/server/scripts`.
- Outside the repository: `rg -l -uu stream-server-export` over `$HOME/.agents`, `$OMNYO_PLUGIN_CHECKOUT`, `$HOME/projects/chibistack`, `$HOME/bin`, `$HOME/.codex/skills` and `$HOME/.claude/skills` found nothing. A wider search of `$HOME/projects` (excluding `omnyo` checkouts and `node_modules`) found only the archived receipt described next and copies inside the retired private checkout.
- What these searches cannot rule out: operator notes kept outside these directories, or a bundled copy of the helper on a remote machine.

Counterevidence: why the helper exists (Proven by inspection of history and an archived receipt):

- The retired private repository (`$ARCHIVED_OMNYO_CHECKOUT`) records that commit `681374c41a` (2026-10-15, "fix(server-move): stream server export and clean up on disconnect") added it as "a helper that exports a data dir from outside the server, to stdout or to one authorized GET".
- `$HOME/projects/.worktree-archive-20261015/bb-server-export-freeze-proof/RECEIPT.md` shows the helper was bundled with `node ../../scripts/build-node-entry.mjs scripts/stream-server-export.ts <out>` and run against production during the October 2026 BB purge. An export at 13:17Z on 2026-10-15 ended with exit 1 `digest_mismatch`, the snapshot code was fixed, and the receipt notes that "the bb-vps backup still does not exist." The `--sqlite-module` and `--omnyo-app` flags exist so a bundled helper can borrow the installed runtime's native SQLite module on a host without a source checkout.
- Later commits kept it compiling and correct: `53ed71ff8e` (2026-11-06, 52 lines changed across the helper and CLI test), `3b890f8ca7` (2026-11-09, rename copy), and `455a792774` (2026-11-19, the sealed-secret vault hookup). `docs/execplans/2026-11-19-secret-vault.md` in the private repository lists `stream-server-export-core.ts` as a separate export path that had to decrypt sealed files.
- Whether that BB-era backup operation is finished, and whether Omnyo still needs an export path for a server that cannot start, is not recorded anywhere searched. That is the owner decision.

Corrections to the sweep report:

1. The standalone describe block in `export-stream.test.ts` cannot simply be deleted. Its test "decrypts sealed secrets and their plugin snapshot copies in memory, and archives no vault entry" (line 666) also asserts server-path behavior through `streamServerExport`: no plaintext appears in the work directory during streaming, a sealed file larger than 1 MiB and a `plugins/snapshots/...` copy round-trip as plaintext, and no `vault/` entry is archived. `apps/server/test/server-move/export.test.ts:54-170` covers sealed secrets and the missing `vault/` entry only for `exportServerArchive` (the file-writing path), not for the streaming route. The test "takes one consistent snapshot while the server keeps writing through its own connection" (line 754) is the only test of `withSqliteReadSnapshot` plus `backup` against a concurrent writer, and the server path still uses that mechanism for plugin databases (`snapshotSqliteDatabase`, `export-snapshot.ts:263-273`).
2. The sweep's "if retained" alternative, "make the core call the `@omnyo/db` helpers", is not a drop-in change. `countAppliedMigrations` (`packages/db/src/migrate.ts:517`) and `getExperiments` (`packages/db/src/data/experiments.ts:12`) take a Drizzle `DbConnection`, while the helper deliberately opens the database with a caller-supplied `better-sqlite3` module and has no Drizzle connection. Sharing the facts would need raw-client variants in `@omnyo/db`, a new export added for one tooling caller.

Maintenance cost today. Every change to `withServerDataSnapshot`, `ServerDataSnapshotArgs`, `withSqliteReadSnapshot`, the archive manifest or sealed-secret handling must keep a second, unpackaged caller and a child-process CLI test passing. The CLI test spawns `node --conditions=source --import tsx` for each case (`stream-server-export-cli.test.ts:115-117`), which runs in the default `@omnyo/server` suite. The manifest rule "migration count plus `serverMove` experiment with the domain default" has two owners: `serverManifestInput` and `readServerManifestFacts`.

**Proposed end state and preservation argument**

If Alex retires the helper:

- These disappear: `apps/server/scripts/stream-server-export.ts`, `apps/server/scripts/stream-server-export-core.ts`, `apps/server/test/server-move/stream-server-export-cli.test.ts`, the helper-only assertions in `export-stream.test.ts`, and the words "and the standalone export helper" in `docs/api_to_audit.md:4747`.
- These remain unchanged: the server route and `streamServerExport`/`exportServerArchive` in `export.ts`, all of `export-snapshot.ts` behavior, the archive format in `@omnyo/server-archive`, and `omnyo server export`/`omnyo server move`. The single owner of export manifest facts becomes `serverManifestInput` (`export.ts:88`).
- The unique test obligations survive: the sealed-secret streaming test moves to the "streaming server export" describe block (`export-stream.test.ts:256`) without the helper comparison, and the concurrent-writer consistency test is re-pointed at `withSqliteReadSnapshot` directly, which is the surviving mechanism used for plugin databases.
- Preservation argument: no product code imports the helper (reachability above), it is not shipped in `omnyo-app`, and it adds no route, setting, persisted format or UI state. Removing it removes only the out-of-process capability "export a data directory without a running server". That capability is the decision Alex is asked to make.
- Non-goals: do not remove or change `streamServerArchive` in `packages/server-archive/src/write-archive.ts:336` even though the core is its only production caller; `packages/server-archive/test/stream-archive.test.ts:110-276` uses it to exercise `planServerArchive` and `pipeServerArchive`, which the server route depends on. Do not drop `export` keywords in `export-snapshot.ts`; the gain is negligible and `OpenSqliteSnapshotSource` is part of the exported `ServerDataSnapshotArgs`.
- Remaining uncertainty: an off-repository runbook or a bundled copy on a remote host. Git history keeps the helper restorable from this snapshot.

If Alex keeps the helper, the smallest sufficient change is documentation, not refactoring. Add a short operator section (for example in `docs/configuration.md` near the `omnyo server export` text at line 2398) stating when to use it, the bundle command from the receipt, and its flags and exit codes. Leave `readServerManifestFacts` as is, with a one-line comment that it must match `serverManifestInput`, rather than adding raw-client variants to `@omnyo/db`. This alternative removes nothing and is listed only so the decision is complete.

**Expected gain and cost**

Observed baseline (Reproduced counts above). Projected effect of retirement:

- Production (tooling, unpackaged) code: minus 749 lines (630 non-blank), two files. Production server code: no change.
- Tests: minus 573 lines for the CLI test. In `export-stream.test.ts`, roughly minus 60 to 100 of the 198 lines in the standalone block; the exact figure depends on how compactly the two surviving tests are re-homed. Total test reduction is about 630 to 670 lines (projection).
- Docs: one clause.
- Mechanisms: export entry points go from 2 to 1, manifest-fact readers from 2 to 1, and callers of `withServerDataSnapshot` from 2 to 1. One child-process test file leaves the default server suite, which projects a shorter `@omnyo/server` test run. That runtime saving is unmeasured.
- Cost: about 2 hours. Tradeoff: an offline export of a server that cannot start would need to be restored from Git history and re-bundled.
- Causal link to easier maintenance: the next change to snapshot arguments, sealed-file handling or the manifest touches one caller and one set of tests instead of two.

**Execution steps**

Investigation gate (must pass before step 1):

0. Ask the owner one question: "Is the standalone `apps/server/scripts/stream-server-export.ts` helper (offline data-directory export to stdout or a one-shot token-protected HTTP listener, last used for the October 2026 bb-vps backup) still a tool you want to keep?" Include the history facts above. If he says keep, do only the "keep" alternative in the previous section and stop. If he says retire, continue. Do not proceed on silence.

Retirement:

1. Reconfirm the baseline on the current branch. From the repository root run `git grep -n -I -e stream-server-export -e exportDataDirArchive -e readOmnyoAppRuntime -- .` and confirm the only hits are the files named in this card. Run `wc -l` on the four files. Any new consumer (a package script, a CI job, an `omnyo` CLI command, a desktop or host-daemon spawn, or a doc runbook) invalidates the plan: stop and re-plan.
2. Re-home the unique tests in `apps/server/test/server-move/export-stream.test.ts` before deleting anything.
   - Move the test "decrypts sealed secrets and their plugin snapshot copies in memory, and archives no vault entry" (currently line 666) into the `describe("streaming server export", …)` block that starts at line 256. Delete only the `helperOutput` section (the `exportDataDirArchive` call at lines 712-723) and the assertion `expect(helperOutput.bytes().equals(serverOutput.bytes())).toBe(true)` (line 726). Keep every other assertion: `plaintextOnDisk` is empty, `vault/vault.json` exists, no `vault/` manifest entry, and every secret round-trips as plaintext.
   - Replace the test "takes one consistent snapshot while the server keeps writing through its own connection" (line 754) with a direct test of `withSqliteReadSnapshot` from `../../src/services/server-move/export-snapshot.js`. Keep the same fixture writer (`export_writes` table written every 1 ms through `fixture.db.$client`). Open a read-only `better-sqlite3` connection as `openReadonly` does, call `withSqliteReadSnapshot(openReadonly, join(fixture.dataDir, "app.db"), (source) => source.backup(dest, { progress: () => 100 }))`, and assert `integrity_check` is `ok` and `COUNT(*) === MAX(id)` on the backup, as the original does. Use `AbortSignal.timeout(45_000)`-equivalent bounding if needed.
   - Delete the test "produces the same archive bytes as the server export of the same data" (line 632); it exists only to compare the helper with the server.
   - Delete the now-empty `describe("standalone data dir export for the stream-server-export helper", …)` wrapper, its `serverRuntime` constant and `openReadonly` helper if unused, and the import of `exportDataDirArchive` (line 32). Remove any import that becomes unused.
   - Checkpoint: run the `export-stream.test.ts` command under Verification and confirm the re-homed tests pass while the helper still exists.
3. Delete `apps/server/test/server-move/stream-server-export-cli.test.ts`. Its subjects (CLI parsing, token serving, sidecar, exit codes) exist only in the helper.
4. Delete `apps/server/scripts/stream-server-export.ts` and `apps/server/scripts/stream-server-export-core.ts`.
5. Edit `docs/api_to_audit.md:4747`: change "`omnyo server export`, server moves and the standalone export helper decrypt" to "`omnyo server export` and server moves decrypt", and re-wrap the paragraph only as far as that sentence requires.
6. Run the verification below, then inspect `git diff --stat` and the full diff: only the four touched paths and the doc line should change, and `git grep -n -e stream-server-export -e exportDataDirArchive -e readOmnyoAppRuntime -- .` should return nothing. Recount the removed lines against the step 1 baseline and report the actual figures.

**Verification and acceptance criteria**

Commands (the package scripts exist in `apps/server/package.json` and the root `package.json` at the snapshot; they were not executed because the snapshot has no dependencies installed):

- From `apps/server`: `pnpm exec vitest run --config vitest.config.ts test/server-move/export-stream.test.ts` (the config at `apps/server/vitest.config.ts` accepts an exact `test/**/*.test.ts` path as the include filter). Expected: all tests pass, including the re-homed sealed-secret test and the new `withSqliteReadSnapshot` concurrent-writer test.
- From `apps/server`: `pnpm exec vitest run --config vitest.config.ts test/server-move/export.test.ts` to confirm the file-writing export is untouched.
- From the repository root: `pnpm --filter @omnyo/server typecheck` (runs `tsc --noEmit`; `apps/server/tsconfig.json` includes `scripts` and `test`, so a dangling import fails here).
- From the repository root, on the changed test file: `pnpm exec oxlint --fix apps/server/test/server-move/export-stream.test.ts`, `pnpm exec oxfmt apps/server/test/server-move/export-stream.test.ts`, then `pnpm exec oxlint --deny-warnings --format=agent`. The root also defines `pnpm format:check` (`oxfmt . --check`).
- Optional, before merging to a shipping branch only: `pnpm --filter @omnyo/server test -- test/server-move` for the whole server-move folder. Not required per edit.

Acceptance:

- Behavior: the streaming route still decrypts sealed files (including files over 1 MiB and `plugins/snapshots` copies) in memory, leaves no plaintext in the work directory, archives no `vault/` entry, and `withSqliteReadSnapshot` still yields a consistent backup under a concurrent writer. These are the assertions that previously lived in the standalone block; none is weakened.
- Structure: no file in the repository references `stream-server-export`, `exportDataDirArchive`, `readOmnyoAppRuntime` or `readServerManifestFacts`. `serverManifestInput` is the only manifest-fact reader. `withServerDataSnapshot` has one production caller (`withLiveServerSnapshot`).
- No UI, API, persisted format or packaged artifact changes, so no visual or performance comparison is needed. Any claimed test-suite speedup must be measured before it is reported.

**Rollback and stop conditions**

- Rollback: the change is two deleted scripts, one deleted test file, one edited test file and one doc clause in a single commit. `git revert <commit>` restores everything. No data, migration or compatibility state is involved.
- Stop if Alex chooses to keep the helper, or does not answer (then do nothing beyond reporting).
- Stop if step 1 finds any consumer not listed here, for example a package script, CI workflow, runbook, CLI command or a spawn from the desktop app or host daemon. Re-plan with that consumer's owner.
- Stop if the re-homed sealed-secret test fails against the server path. That would mean the helper comparison was masking a server-path defect; report it as a separate issue before continuing the retirement.
- Safer smaller alternative if the decision is "keep but reduce cost": move `stream-server-export-cli.test.ts` behind the existing `omnyoTestOptIn` list in `apps/server/package.json` so the child-process test leaves the default suite, and add the operator documentation described in the "keep" alternative.
