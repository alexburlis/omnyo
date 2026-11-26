# RF-114 — Remove the Docs plugin's deprecated `write`, `mkdir`, `move` and `remove` CLI commands

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The opportunity is real, but the sweep overstated the test reduction (about 60 test lines are affected, not about 100). One test also carries a unique obligation that must be moved to the RPC path rather than deleted. The sweep's claim that the unknown-command error "suggests the nearest command" is wrong for these names (see Context).
- **Potential:** low to medium. One legacy CLI surface disappears: four command definitions, two warning constants, their tests and their documentation. The direct-mutation handlers stay because the UI, RPC, HTTP and sync paths use them.
- **Confidence:** high that the code is removable without breaking anything in the repository. Confidence is unknown on whether anything outside the repository still calls these commands.
- **Readiness:** decision-needed. `plugins/docs/README.md` and `plugins/docs/skills/docs/SKILL.md` promise "one backward-compatibility window". Alex must decide that the window has ended, because the repository history was squashed and cannot show when the window started.
- **Effort:** small. Expect one to two hours, including the test changes.
- **Risk:** low. This is an external contract change: a script or agent that runs `omnyo docs write …` today gets exit 0 plus a warning on stderr. After the change it gets exit 2 and an `unknown_command` error. Nothing changes for the in-app UI, the RPC methods or the token HTTP routes.
- **Prerequisites:** the owner's decision that the window is closed.
- **Related or overlapping RF ids:** none. The card touches only `plugins/docs`. RF-071 (sharing tiptap extensions between Docs and Tasks) changes other files in the same plugin, so the two can land in either order.
- **Why it deserves its place:** the repository already announced this removal, and the code it removes has no first-party caller. Today every change to vault path handling or CLI option conventions has to keep four extra command specs, their option sets and their tests consistent. Agents also see two mutation styles in `omnyo docs --help`, even though the skill tells them to use only one.

**Context and evidence**

The snapshot is commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The worktree named in the audit brief was no longer on disk, so every file was read with `git -C $OMNYO_CHECKOUT show e9e1b74c3…:<path>`.

The Docs plugin (`plugins/docs`, package `omnyo-plugin-simple-notes` 0.2.3, internal plugin id `simple-notes`) registers one CLI, `omnyo docs`, through `api.cli.register(defineCli({ name: "docs", … }))` in `plugins/docs/server.ts:3423`. The supported agent workflow is pull, edit the local files, then push (`pull`, `status`, `push`), plus proposal commands. Four older commands still let a caller change the vault directly.

Observed facts (Proven by inspection unless labelled otherwise):

- `plugins/docs/server.ts:57-61` defines `DEPRECATED_MUTATION_WARNING` and `DEPRECATED_DELETION_WARNING`. Nothing else in the repository references these constants or their text. The search was `git grep -n "DEPRECATED_MUTATION_WARNING\|DEPRECATED_DELETION_WARNING\|direct Docs mutations" e9e1b74c3`, and its only hits are in `server.ts`.
- `plugins/docs/server.ts:3816-3945` holds the four command specs inside `commands:`. Each prints one of the two warnings:
  - `write` (3816-3852): it calls `writeFile({ vaultId, rawPath, content })` and prints `DEPRECATED_MUTATION_WARNING` at 3850.
  - `mkdir` (3853-3878): it calls `handlers.createFolder` and prints the warning at 3876.
  - `move` (3879-3910): it calls `movePath(vault, from, to)` and prints the warning at 3908.
  - `remove` with alias `rm` (3911-3945): it calls `removePath(vault, path, recursive)` and prints `DEPRECATED_DELETION_WARNING` at 3943.
- The handlers stay in use after the change:
  - `writeFile` (1070) is also called at 1320, 1770, 1965, 1999 and 2181.
  - `movePath` (1330) is called by `handlers.movePath` at 2082 and at 2103.
  - `removePath` (1380) is called at 1811, 1827 and 2011.
  - `handlers.createFolder` (2013) backs `routeRpc("/mkdir", …)` at 3289.
  - The token HTTP and RPC routes `routeRpc("/write" | "/mkdir" | "/move" | "/remove", …)` at 3287-3291 do not depend on the CLI.
- `renderCliResult` (3312) and `formatSyncHumanOutput` (3219) have no branch specific to these four commands. The formatter branches only on `pull`, `status` and `push`. The other helpers the specs use (`attemptCli`, `VAULT_OPTION`, `JSON_OPTION`) are used by other commands too. Removing the specs therefore leaves no orphaned helper.
- The documentation that announces the window:
  - `plugins/docs/README.md:169-172`: "The legacy `write`, `mkdir`, `move`, and `remove` CLI commands remain for one backward-compatibility window and emit a deprecation warning…"
  - `plugins/docs/skills/docs/SKILL.md:76-78`: "The direct `write`, `mkdir`, `move`, and `remove` commands are deprecated…"
  - `plugins/docs/README.md:183-186` lists the token HTTP routes `/write`, `/mkdir`, `/move` and `/remove`. Those routes are a separate supported contract and stay.
- The tests in `plugins/docs/server.test.ts` that use the commands:
  - 1292-1333 "supports whole-vault and single-file scopes and deprecates direct writes": the final `write legacy.md --content legacy` call and its `Deprecated` assertion are at 1324-1332.
  - 1335-1410 "renders top-level help successfully and rejects inapplicable flags before mutation": `remove plan.md --dry-run --json` at 1372-1381, `write plan.md` (missing `--content`) at 1390-1394, and `move` (missing `<from>, <to>`) at 1396-1400.
  - 1412-1438 "keeps CLI removal non-recursive unless --recursive is passed". This is the only test that asserts `files.remove` receives `recursive: false` when the caller omits it. The RPC tests at 649 and 1992 call `deletePath` but never assert the `recursive` argument. This obligation must survive the change.
- The search for callers found none. The command was `git grep -n -E "docs (write|mkdir|move|remove|rm)\b" e9e1b74c3 -- .` over the whole snapshot tree, and its only hits are in the dated audit docs. A second pattern, `\[\s*"docs",\s*"(write|mkdir|move|remove|rm)"`, also returned nothing. The same check with `rg` over `$OMNYO_PLUGIN_CHECKOUT`, `$HOME/.agents`, `$HOME/.omnyo/skills` and `$HOME/.claude/skills` found nothing. These searches do not cover the owner's ad hoc shell history, other machines, or third-party agents and scripts.
- No other registration surface exposes these commands. The plugin has no agent-tool or MCP wrapper. The `api.http.route` and `routeRpc` entries are the only other entry points, and they stay. `plugins/docs/PLUGIN_OVERVIEW.md` does not mention the commands.
- The error a removed command produces (Reproduced as pure computation). `packages/plugin-sdk/src/cli-spec.ts:678` `unknownCommandError` suggests a name from aliases and `suggestFor`, or from `nearest()` (341: edit distance ≤ 2, or a prefix relation). Running the `nearest()` logic in `node -e` against the remaining command names (`accept`, `reject`, `undo`, `redo`, `proposal`, `propose`, `proposal-update`, `vaults`, `vault-add`, `vault-remove`, `list`, `read`, `pull`, `status`, `push`) gives `null` for `write`, `mkdir`, `move`, `remove` and `rm`. After the change, a caller gets `unknown command 'docs write'` with exit 2 and the command list, but no "Did you mean" hint. The README's statement at 163-166 that the nearest name is suggested still holds in general. Here it simply finds no near name, so the CLI cannot misdirect a caller to an unrelated command such as `vault-remove` or `undo`.

Counterevidence and limits:

- The squashed history (`060950255 Publish Omnyo source` is the only commit touching `server.ts`) means nobody can tell from the repository when the window opened. The decision belongs to Alex.
- The test suites were not run, because the snapshot has no `node_modules`.

Maintenance cost today: the CLI carries two mutation styles. Every change to vault option conventions, path validation messages or CLI result rendering has to be checked against four extra command specs and three test fragments. Agents also see the deprecated commands in `omnyo docs --help`, which contradicts the skill.

**Proposed end state and preservation argument**

What disappears:

- The `write`, `mkdir`, `move` and `remove`/`rm` entries in the `commands` object of the `docs` CLI.
- `DEPRECATED_MUTATION_WARNING` and `DEPRECATED_DELETION_WARNING`.
- The README paragraph and the SKILL.md paragraph that announce the window.
- The test fragments that exist only to exercise the deprecated commands.

What remains:

- The CLI keeps `pull`, `status`, `push`, the proposal commands (`proposal`, `propose`, `proposal-update`, `accept`, `reject`, `undo`, `redo`), `vaults`, `vault-add`, `vault-remove`, `list` and `read`.
- `writeFile`, `movePath`, `removePath`, `handlers.createFolder`, `handlers.deletePath`, `handlers.movePath` and `handlers.saveNote` all remain.
- The RPC and token HTTP routes `/list`, `/read`, `/write`, `/mkdir`, `/move`, `/remove`, `/sync/snapshot` and `/sync/apply` remain, with their compare-and-swap behaviour.
- The UI editing paths are untouched.

The canonical way for a CLI caller to change a vault becomes pull, edit, then push. Direct programmatic mutation stays available through RPC and the token HTTP API, which the README already documents as supported.

How current semantics survive:

- No persisted format changes. `.omnyo-docs-state.json` and the vault files are untouched.
- No route, RPC method or UI state changes.
- The non-recursive default of `removePath` stays covered by moving its test to the `deletePath` RPC (step 4 below).
- Behaviour changes only for a caller of the four commands, which now gets exit 2 and an `unknown_command` error instead of exit 0 plus a warning. This is the change the documentation announced.

Non-goals:

- Removing or changing the HTTP or RPC `/write`, `/mkdir`, `/move` and `/remove` routes.
- Changing `push --delete` semantics.
- Renaming the plugin or its id.
- Adding a compatibility shim. An optional one-line hint is discussed in step 3c and is the owner's choice, not part of the default plan.

Reachability proof: the four specs are reachable only through CLI dispatch of the literal command names. The only in-repository callers are the tests listed above. Remaining uncertainty: callers outside the repository (see Context).

**Expected gain and cost**

| Surface | Before (observed) | After (projected) |
|---|---|---|
| Handwritten production code in `plugins/docs/server.ts` | 4,093 lines. The specs span 130 lines (3816-3945) and the constants 6 lines including blank separators (57-62). | About 136 fewer lines. |
| Tests in `plugins/docs/server.test.ts` | About 60 lines exercise the commands. | About 35-45 fewer lines net. The removal-recursion test (about 27 lines) is rewritten against RPC, not deleted. Two usage-error checks and one rejected-flag check are retargeted to surviving commands. |
| Docs | README 169-172 (4 lines plus a blank) and SKILL.md 76-78 (3 lines plus a blank). | About 9 fewer lines. |
| Mechanisms | Two CLI mutation styles, with deprecation warnings. | One CLI mutation style. Direct mutation stays through RPC and HTTP only. |

Counting method: line spans were read with `sed -n` on the extracted snapshot files, and totals came from `wc -l`.

- **Performance:** neutral. CLI registration builds four fewer command specs, which is negligible, and no hot path changes.
- **Cost:** callers outside the repository break visibly with exit 2. Nobody can measure how many such callers exist.

**Execution steps**

Investigation gate (step 0) comes first: do not edit until it passes.

0. **Decision gate.** Get the owner's explicit decision that the backward-compatibility window announced in `plugins/docs/README.md:169-172` has ended. While waiting, run the read-only caller searches below again on the current tree and on the owner's other local repositories:
   - `git -C $OMNYO_CHECKOUT grep -n -E "docs (write|mkdir|move|remove|rm)\b" -- . ':!docs/2026-*'`
   - `rg -n "(omnyo|bb) docs (write|mkdir|move|remove|rm)\b" $HOME/projects $HOME/.agents`

   If a live caller appears (an automation, a skill, a project action or a script), stop and either migrate it to pull/edit/push or to the HTTP API first, or leave the commands in place.

1. **Reconfirm anchors.** On the working branch, confirm that `plugins/docs/server.ts` still has the two constants near line 57 and the four specs right after the `push` spec inside the `docs` `defineCli` call. If the RPC routes `/write`, `/mkdir`, `/move` or `/remove` have been removed, or if a new caller of the specs exists, re-plan.

2. **Baseline.** From `plugins/docs`, run `pnpm test` and `pnpm typecheck` and record that both pass, so that later failures can be attributed to this change.

3. **Production edits in `plugins/docs/server.ts`.**
   - a. Delete the `write`, `mkdir`, `move` and `remove` keys (with the `aliases: ["rm"]` entry) from the `commands` object of `api.cli.register(defineCli({ name: "docs", … }))`. The `push` spec then becomes the last entry before the closing `},` of `commands`.
   - b. Delete `DEPRECATED_MUTATION_WARNING` and `DEPRECATED_DELETION_WARNING` (lines 57-61) and the blank line that follows them.
   - c. Optional, and only if Alex wants a migration hint: add `"write", "mkdir"` to a `suggestFor` array on `push`, and `"move", "remove", "rm"` to one on `pull`, so the error says "Did you mean docs push?". The default plan omits this, because a plain unknown-command error with the command list is enough, and a hint pointing at a different command could mislead.
   - d. Do not touch `writeFile`, `movePath`, `removePath`, the `handlers`, `renderCliResult`, `attemptCli`, `VAULT_OPTION`, `JSON_OPTION` or any `routeRpc` call. All of them have other callers.
   - **Checkpoint:** `pnpm typecheck` in `plugins/docs` passes, so no other code referenced the removed constants.

4. **Test edits in `plugins/docs/server.test.ts`.**
   - a. In "supports whole-vault and single-file scopes and deprecates direct writes" (about 1292), delete the `direct` block (about 1324-1332) and rename the test to "supports whole-vault and single-file scopes".
   - b. In "renders top-level help successfully and rejects inapplicable flags before mutation" (about 1335), handle three fragments:
      - Replace the `unsafeRemove` block (about 1372-1381) with an inapplicable-flag check on a surviving mutating command. Use `harness.runCli(["vault-remove", "<id of the loaded vault>", "--dry-run", "--json"])`, expect `exitCode` 2, and assert that `harness.runCli(["vaults", "--json"])` still lists the vault. Read `loadVirtualSyncVault` for the vault id. If that is awkward, it is acceptable to drop the block, because the `unsafePull` check above it already covers "unknown option rejected before mutation".
      - Retarget `missingOptions` to `harness.runCli(["propose", "plan.md"])` and expect stderr to contain `missing required options:`. `propose` requires `--version`, `--expected-sha256` and `--file`, so check the exact message order against `packages/plugin-sdk/src/cli-spec.ts` before pinning the full string.
      - Retarget `missingArguments` to `harness.runCli(["vault-add"])` and expect `missing required arguments: <name>, <absolute-root>`.
   - c. Replace "keeps CLI removal non-recursive unless --recursive is passed" (about 1412-1438) with "keeps deletePath non-recursive unless recursive is true". Keep the same `loadNotebook` setup and the same `harness.sdk.callsTo("files.remove")` assertion. Drive it with `harness.callRpc("deletePath", { path: "empty" })` and `harness.callRpc("deletePath", { path: "archive", recursive: true })`, following the `callRpc` style at about 649. Keep `vaultId` omitted, as the CLI test did.
   - d. Add a short regression check to the help test: `harness.runCli(["write", "x.md", "--content", "x"])` returns `exitCode` 2 and stderr contains `unknown command`. This pins the intended contract change.
   - **Checkpoint:** `pnpm test` in `plugins/docs` passes.

5. **Docs.**
   - Delete the paragraph at `plugins/docs/README.md:169-172`.
   - Delete the paragraph at `plugins/docs/skills/docs/SKILL.md:76-78`.
   - Leave the README's HTTP route list (183-186) and line 21 ("all list/read/write/mkdir/move/remove calls") unchanged, because they describe the host-routed operations and HTTP routes that remain.
   - Optionally add one sentence to the README CLI section: "Direct mutation is available through the token HTTP API below."

6. **Version.** Bump `plugins/docs/package.json` `version` (0.2.3 to 0.3.0, because a CLI command was removed) only if the repository's plugin release practice at execution time requires it. Check how recent official-plugin changes were versioned before deciding, and leave the version unchanged if that practice is unclear. No `engines.omnyoPluginSdk` change is needed.

7. **Final review.**
   - Run `git diff --stat` and confirm that only `plugins/docs/server.ts`, `plugins/docs/server.test.ts`, `plugins/docs/README.md`, `plugins/docs/skills/docs/SKILL.md` and optionally `plugins/docs/package.json` changed.
   - Confirm that `git grep -n "DEPRECATED_MUTATION_WARNING\|Deprecated: write a UTF-8\|aliases: \[\"rm\"\]" -- plugins/docs` returns nothing.
   - Recount: `wc -l plugins/docs/server.ts` should be about 4,093 − 136.

**Verification and acceptance criteria**

Commands. The scripts come from `plugins/docs/package.json` and the root `package.json` at the snapshot. They were not run, because the snapshot has no `node_modules`.

- From `plugins/docs`: `pnpm test` (runs `vitest run --config vitest.config.ts`). All Docs tests should pass, including the rewritten `deletePath` recursion test and the new unknown-command check.
- From `plugins/docs`: `pnpm typecheck` (runs `tsc --noEmit`). It should pass.
- From `plugins/docs`: `pnpm lint` (runs `oxlint …`). It should pass.
- From `$OMNYO_CHECKOUT`: `pnpm exec oxfmt --check plugins/docs/server.ts plugins/docs/server.test.ts`. It should pass. The root `format:check` script runs `oxfmt . --check`.
- From `$OMNYO_CHECKOUT`: `pnpm run check:plugin-forks` (the script exists in the root `package.json`). Docs must remain independently forkable.

Behaviour and contract checks:

- `omnyo docs write a.md --content x` and `omnyo docs rm a.md` exit 2 with `unknown_command`. With `--json`, stdout carries the `{"ok":false,"error":{"code":"unknown_command",…}}` envelope. The test from step 4d covers this.
- `omnyo docs --help` no longer lists the four commands but still lists `pull`, `status` and `push`. The existing help assertions cover this.
- The RPC methods `deletePath`, `movePath`, `createFolder` and `saveNote` behave as before. The existing RPC tests (about 600-650, 1460-1500 and 1964-2030) and the ported recursion test cover this.
- `files.remove` receives `recursive: false` unless `recursive: true` is passed. The ported test covers this.

UI: no UI is affected, so no visual check is needed.

Performance: no comparison is needed. The change only removes four command specs from CLI registration, and no hot path is involved.

Structural completion:

- No deprecation constant, deprecated summary text or `rm` alias remains in `plugins/docs`.
- The README and the skill describe only pull/edit/push for CLI mutation.
- The handlers still have their RPC, HTTP and sync callers.

**Rollback and stop conditions**

Rollback: the change is one self-contained commit across four files (five with a version bump) in `plugins/docs`. Reverting that commit restores the commands and warnings. No data, persisted format or migration is involved.

Stop conditions:

- Alex does not confirm that the window has ended.
- The step 0 search finds a live caller (an automation, a project action, a skill in `$OMNYO_PLUGIN_CHECKOUT` or `~/.agents`, or a script) that has not migrated.
- The `routeRpc` mutation routes were removed or changed since the snapshot, so the "direct mutation remains via RPC/HTTP" preservation argument no longer holds. In that case, re-plan.
- A surviving test depends on the deprecated commands in a way that a retarget cannot keep. Stop and characterize the obligation before deleting anything.

Smaller alternative if Alex wants to keep the window open: change nothing now, but record a removal date in the README and SKILL.md sentences, so that a later session can act on a dated condition instead of an undated "window".
