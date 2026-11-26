# RF-072 — Keep one copy of the shared ACP protocol module tests, in `provider-bridge-protocol`, instead of a byte-identical copy in each ACP engine

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplication is real and the move is safe. The sweep overstated two details: the saving is about 885 test lines rather than 950 to 1,000, and the owning package is not short of tests in general (it has 24 test files), only in `src/acp/` (one file).
- **Potential:** low to medium. The change removes no production code. It does end a recurring double edit: every change to four shared protocol modules currently means editing two identical test files in two packages that do not own the code.
- **Confidence:** high. All four test files are byte-identical across the two engines (same git blob ids), and three of them import nothing from the engine except a five-line re-export.
- **Readiness:** ready. One implementation check remains (step 3, checkpoint A): confirm that Vitest resolves the protocol package's imports of its own name (`@omnyo/provider-bridge-protocol/bridge-kit`) when the test runs inside that package.
- **Effort:** small. About one to two hours plus three package test runs.
- **Risk:** low. The change touches tests only. The one behavior that crosses the engine boundary (the `provider/usage` route case) stays in both engines.
- **Prerequisites:** none.
- **Related or overlapping:** RF-001 (retire the classic ACP engine). RF-001's card leaves `packages/provider-bridge-protocol/src/acp/*` to this card. The two are independent. If RF-001 lands first, the duplicate copy disappears with the classic engine and this card shrinks to moving one copy from `provider-bridge-acp-next` into the owning package. That move still pays for itself, because the tests then live beside the code they cover. If this card lands first, RF-001 deletes about 103 fewer classic test lines.
- **Why it deserves its place:** it is cheap, it carries little risk, and it gives four shared modules (1,172 production lines) a single test owner. It ranks below every production-code opportunity because it removes no maintained production mechanism.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The read-only worktree named in the task had already been removed, so every file below was read with `git -C $OMNYO_CHECKOUT show <commit>:<path>` and `git ls-tree`. No tests ran: the snapshot has no `node_modules`.

*The subsystem.* Omnyo ships two ACP (Agent Client Protocol) bridge engines, `packages/provider-bridge-acp` (classic) and `packages/provider-bridge-acp-next`. Code that both engines need sits in `packages/provider-bridge-protocol/src/acp/` and is published through that package's `exports` map (`./acp/launch-spec`, `./acp/cursor-mcp-approval`, `./acp/opencode-usage`, `./acp/provider-maintenance`, `./acp/tool-proxy-mcp` and others, in `packages/provider-bridge-protocol/package.json`). The shared modules moved there earlier, but their tests stayed behind, one copy in each engine.

*Observed facts (Proven by inspection).*

1. The four test files are byte-identical between the engines. The check compared `git rev-parse <commit>:packages/provider-bridge-acp/<f>` with the same path under `provider-bridge-acp-next`, and `wc -l` gave the sizes:

   | Test file (same path in both engines) | Lines | What it imports from outside vitest and Node |
   |---|---|---|
   | `src/bridge/cursor-mcp-approval.test.ts` | 153 | `approveCursorSessionMcpServer`, `buildCursorMcpApprovalIdentifier`, `revokeCursorSessionMcpServer` from `@omnyo/provider-bridge-protocol/acp/cursor-mcp-approval`; type `AcpMcpServerConfig` from `@omnyo/provider-bridge-protocol/acp/tool-proxy-mcp` |
   | `src/bridge/provider-maintenance.test.ts` | 101 | `CURSOR_ACP_MAINTENANCE`, `__testing` from `@omnyo/provider-bridge-protocol/acp/provider-maintenance` |
   | `src/launch-spec.test.ts` | 59 | `acpLaunchSpecSchema`, `normalizeAcpLaunchSpec` from `./launch-spec.js`. That engine file is a 5-line re-export of `@omnyo/provider-bridge-protocol/acp/launch-spec` (identical in both engines) |
   | `src/bridge/opencode-usage.test.ts` | 722 | `readOpenCodeGoUsage` from `@omnyo/provider-bridge-protocol/acp/opencode-usage`, `providerUsageResultSchema` from `@omnyo/provider-bridge-protocol`, `captureBridgeJsonRpcOutput` from `@omnyo/provider-bridge-protocol/testing`, `DatabaseSync` from `node:sqlite`; and, in one case only, a dynamic `import("./bridge.js")` at line 668 |

   Per engine that is 1,035 test lines, or 2,070 in total.
2. In `opencode-usage.test.ts`, only the last case touches the engine: `it("routes bridge usage requests to Go with the configured launch environment", …)` at lines 667-721. It loads the engine's `handleLine` from `./bridge.js`, sends a `provider/usage` JSON-RPC request with `acpDialect: "opencode"` and an `acpLaunchSpec.env.OPENCODE_API_KEY`, and asserts that the launch key reaches the fetch `Authorization` header. Everything else (lines 1-665: module-level `reportedUsage`, `fetchUsage`, `beforeEach`/`afterEach` at lines 36-48, the helpers `writeAuth`, `writeAccount`, `writeCredentials`, and the `describe("OpenCode Go usage")` cases from line 130) calls `readOpenCodeGoUsage(env)` directly.
3. None of the four files reads `__dirname`, `import.meta`, `process.cwd()` or spawns the engine. The only `process.execPath` is inside the route case (line 684). `rg`-equivalent check: `grep -nE "__dirname|import\.meta|process\.cwd|spawn|execPath"` over the four files.
4. `packages/provider-bridge-protocol/src/acp/` holds one test, `tool-call-operation.test.ts` (83 lines), which imports its subject with a relative path (`./tool-call-operation.js`). The package as a whole has 24 test files (`git ls-tree -r --name-only <commit> packages/provider-bridge-protocol | grep -c '\.test\.ts$'`).
5. The protocol package already runs tests from `src/` automatically. `packages/provider-bridge-protocol/vitest.config.ts` uses `sharedWorkerProjects({ include: ["src/**/*.test.ts", "test/**/*.test.ts"] })` from the root `vitest.shared.ts`, which classifies each file into a shared or isolated project by scanning its source (`partitionTestFiles`, `requiresIsolation`). New files need no registration. Turbo task `@omnyo/provider-bridge-protocol#test` (`turbo.json:616`) uses `$TURBO_DEFAULT$` inputs, so new files under `src/` invalidate it.
6. Dependencies are covered. `vitest` 4.1.11 is a root devDependency (root `package.json:71`), which is how the existing 24 protocol tests run. The sweep's worry about `@modelcontextprotocol/sdk` does not apply: `cursor-mcp-approval.test.ts` takes only a type from `acp/tool-proxy-mcp`, and the protocol module itself imports nothing from that SDK. `node:sqlite` is already used by protocol production code (`acp/opencode-usage.ts:4`, `acp/provider-maintenance.ts:6`), and the root `engines.node` is `>=22.19.0`, where `node:sqlite` needs no flag.
7. No file references these test paths. `git grep -nE 'opencode-usage\.test|cursor-mcp-approval\.test|provider-maintenance\.test|launch-spec\.test' <commit>` over the whole tree returned no matches. That search covers `scripts/ci-test-shards.json`, turbo configuration and docs. A dynamic or computed path built from fragments would not show up, but the root `vitest.shared.ts` discovers test files by directory walk rather than by list, so it is not a plausible consumer.
8. The shared modules have no other test owner. A `git grep` for `provider-bridge-protocol/acp/(cursor-mcp-approval|opencode-usage|provider-maintenance|launch-spec)` and the symbols `readOpenCodeGoUsage`, `normalizeAcpLaunchSpec`, `approveCursorSessionMcpServer` and `CURSOR_ACP_MAINTENANCE`, excluding `*.md` and the protocol `src/acp/` directory itself, found only the two engines (bridge, dialect, index, session-params, launch-spec and the four tests) and `packages/plugin-sdk/src/provider-bridge.ts`, which re-exports the launch spec.

*Counterevidence and caveats.*

- One caveat remains a **Hypothesis**: whether Vitest resolves self-referencing imports inside `provider-bridge-protocol`. `acp/provider-maintenance.ts:16-21` value-imports `@omnyo/provider-bridge-protocol/bridge-kit`, and `acp/tool-proxy-mcp.ts:3-7` does the same. `acp/cursor-mcp-approval.ts:6-9` value-imports `ACP_BRIDGE_MCP_SERVER_NAME` from `./tool-proxy-mcp.js`, so the Cursor approval test reaches that self-import too. `acp/opencode-usage.ts:5` self-imports a type only, which is erased. No existing protocol test loads either module (checked with `git grep` for `acp/`, `provider-maintenance`, `tool-proxy-mcp` and `opencode-usage` in protocol test files). Node supports package self-reference through `exports`, `tsc` already compiles these files in the package's own `typecheck`, and `defineWorkspaceTestConfig` sets `resolve.conditions: ["source"]` (`vitest.shared.ts:417-418`). Whether Vite's resolver handles a self-reference under pnpm was not run. Step 3, checkpoint A, settles it.
- Other identical engine tests exist (`interactions.test.ts` 444 lines, `cursor-model-selection.test.ts` 102 lines, `tool-proxy-mcp.test.ts` 291 lines, `mcp-server-entry.test.ts` 337 lines). They are **out of scope**. The first two test engine-local copies of `interactions.ts` and `cursor-model-selection.ts`, which belong to RF-001 or its fallback. The last two start the local engine `bridge.ts` (`BRIDGE_MODULE`), so they are engine integration tests and must stay per engine.

*Maintenance cost today.* Changing OpenCode Go usage parsing in `packages/provider-bridge-protocol/src/acp/opencode-usage.ts` (305 lines) means editing two 722-line engine test files that must stay identical. The same holds for `cursor-mcp-approval.ts` (261), `provider-maintenance.ts` (509) and `launch-spec.ts` (97). A reviewer of a protocol change also finds no tests beside the module, and the protocol package's own test task does not run them.

**Proposed end state and preservation argument**

*What remains.*

- `packages/provider-bridge-protocol/src/acp/cursor-mcp-approval.test.ts`, `provider-maintenance.test.ts`, `launch-spec.test.ts` and `opencode-usage.test.ts` hold the single copy of every case now in the engine files, except the route case. They import their subjects with relative paths (`./cursor-mcp-approval.js` and so on), following `tool-call-operation.test.ts`.
- Each engine keeps `src/bridge/opencode-usage.test.ts`, trimmed to the route case at lines 667-721 and the module-level fixture it needs (`reportedUsage`, `fetchUsage`, the `beforeEach`/`afterEach` at lines 36-48). The two trimmed copies stay byte-identical, as they are today.
- The engines' `src/launch-spec.ts` re-exports stay. `packages/plugin-sdk/src/provider-bridge.ts` consumes the classic one, and each engine's `index.ts` exports it.

*What disappears.* The second copy of 313 lines of pure protocol tests, the second copy of the 667 pure lines of the OpenCode usage test, and six of the eight engine files' worth of duplicate cases. Afterward the canonical test owner of each shared module is the package that owns the module.

*Preservation argument.* The tests move unchanged, apart from import specifiers, so every assertion keeps running against the same production modules. The only test that crosses the protocol-to-engine boundary (launch-spec environment reaching the Go usage request through `handleLine`) still runs in both engines. The launch-spec test previously reached `normalizeAcpLaunchSpec` through a one-line engine re-export. It now tests the module directly. The re-export cannot change behavior, and each engine's `typecheck` still checks its signature. No production code, API, persisted format or UI changes.

*Non-goals.* Do not change any production file. Do not consolidate the engine-local `interactions`, `cursor-model-selection`, `tool-proxy-mcp` or `mcp-server-entry` tests. Do not change Vitest or turbo configuration unless checkpoint A fails.

**Expected gain and cost**

Counts are projections from `wc -l` at the snapshot, not measured diffs.

| | Before | After (projected) |
|---|---|---|
| Production lines | 0 changed | 0 changed |
| Test files covering these four modules | 8 (4 per engine) | 6 (4 in protocol, 1 per engine) |
| Test lines | 2,070 (2 × 1,035) | about 1,185: 313 + about 666 in protocol, plus about 103 per engine |
| Net test lines removed | | about 885 |
| Places to edit for an OpenCode usage parsing change | 2 identical files | 1 file |

The per-engine figure of about 103 lines comes from lines 1-48 of setup, minus the now-unused `DatabaseSync` and `readOpenCodeGoUsage` imports, plus a `describe` wrapper and the 55-line route case. The protocol figure of about 666 is 722 minus the 55-line route case and the now-unused `captureBridgeJsonRpcOutput` import. Final numbers depend on which helpers oxlint reports as unused.

CI time should fall slightly, because about 885 duplicate test lines stop running twice. This is not measured. The cost is about one to two hours and three package test runs.

**Execution steps**

1. **Reconfirm the baseline.** From `$OMNYO_CHECKOUT` on the branch you will change, run:
   ```sh
   for f in src/bridge/cursor-mcp-approval.test.ts src/bridge/provider-maintenance.test.ts src/launch-spec.test.ts src/bridge/opencode-usage.test.ts; do cmp "packages/provider-bridge-acp/$f" "packages/provider-bridge-acp-next/$f" && wc -l "packages/provider-bridge-acp/$f"; done
   ls packages/provider-bridge-protocol/src/acp/
   ```
   Re-plan if any pair now differs. That would mean an engine-specific case was added: keep it in that engine. Re-plan as well if RF-001 has already removed `packages/provider-bridge-acp`: then move from `provider-bridge-acp-next` only and drop the classic deletion steps. Also re-plan if a protocol `src/acp/*.test.ts` with one of these names already exists: merge the cases rather than overwrite them. Confirm the route case is still the only use of `./bridge.js` in `opencode-usage.test.ts` with `grep -n 'bridge.js' packages/provider-bridge-acp*/src/bridge/opencode-usage.test.ts`.

2. **Record a passing baseline** before editing (commands are in the verification section): the protocol test, both engine tests. Note the number of passing tests per file in the engine runs for the four files, so you can compare the totals afterward.

3. **Move the three pure test files (checkpoint A).**
   - Create `packages/provider-bridge-protocol/src/acp/provider-maintenance.test.ts` from `packages/provider-bridge-acp-next/src/bridge/provider-maintenance.test.ts`. Change the import specifier `@omnyo/provider-bridge-protocol/acp/provider-maintenance` to `./provider-maintenance.js`.
   - Create `packages/provider-bridge-protocol/src/acp/cursor-mcp-approval.test.ts` from the engine copy. Change `@omnyo/provider-bridge-protocol/acp/cursor-mcp-approval` to `./cursor-mcp-approval.js` and `@omnyo/provider-bridge-protocol/acp/tool-proxy-mcp` to `./tool-proxy-mcp.js`.
   - Create `packages/provider-bridge-protocol/src/acp/launch-spec.test.ts` from the engine copy. Change `./launch-spec.js` (the engine re-export) to `./launch-spec.js` in the protocol directory. The specifier text stays the same, but it now points at `packages/provider-bridge-protocol/src/acp/launch-spec.ts`.
   - Run the protocol package test. **Checkpoint A:** `provider-maintenance.test.ts` passes, which proves that Vitest resolves the module's self-import of `@omnyo/provider-bridge-protocol/bridge-kit`. If that import fails to resolve, stop and see the rollback section. Do not change production imports as part of this card.
   - Delete the six engine copies: `packages/provider-bridge-acp/src/bridge/provider-maintenance.test.ts`, `packages/provider-bridge-acp/src/bridge/cursor-mcp-approval.test.ts`, `packages/provider-bridge-acp/src/launch-spec.test.ts`, and the same three paths under `packages/provider-bridge-acp-next`. These are clean tracked files inside the requested change.

4. **Split the OpenCode usage test (checkpoint B).**
   - Create `packages/provider-bridge-protocol/src/acp/opencode-usage.test.ts` from the engine copy with lines 667-721 (the route case) removed. Change `@omnyo/provider-bridge-protocol/acp/opencode-usage` to `./opencode-usage.js`. Remove the `captureBridgeJsonRpcOutput` import, which only the route case used. Keep the `providerUsageResultSchema` import, because other cases use it (for example the overage case near line 646). Import it from `../index.js`, which avoids a value self-import of the package name.
   - In both engines, reduce `src/bridge/opencode-usage.test.ts` to: the `node:fs/promises`, `node:os`, `node:path` and vitest imports, `providerUsageResultSchema`, `captureBridgeJsonRpcOutput`, `reportedUsage`, the `directory`/`env`/`fetchUsage` declarations, the `beforeEach`/`afterEach` at lines 36-48, and one `describe("OpenCode Go usage bridge route", () => { … })` that contains the route case unchanged. Drop `writeAuth`, `writeAccount`, `writeCredentials`, the `DatabaseSync` import and the `readOpenCodeGoUsage` import. Keep the `fetch` stub and the temporary directory exactly as they are, because the route case asserts on `fetchUsage` and relies on the per-test stubs being reset. Keep the two engine copies byte-identical.
   - **Checkpoint B:** run the protocol test and both engine tests. The protocol run gains every moved case. Each engine still runs and passes the route case.

5. **Remove leftovers.** Run `pnpm exec oxlint --deny-warnings` on the changed files (see the verification section) and remove any import or helper it reports as unused. Do not touch engine `launch-spec.ts` files, the protocol `exports` map, Vitest configuration or turbo configuration.

6. **Inspect and recount.** Review `git diff --stat` and confirm it only adds four files under `packages/provider-bridge-protocol/src/acp/`, deletes six engine test files and shrinks two. Confirm `cmp packages/provider-bridge-acp/src/bridge/opencode-usage.test.ts packages/provider-bridge-acp-next/src/bridge/opencode-usage.test.ts` still succeeds. Recount with `wc -l` and report the actual net reduction against the 2,070-line baseline.

**Verification and acceptance criteria**

Run from `$OMNYO_CHECKOUT` (or your linked worktree of it) after `pnpm install`. The scripts below were read from the packages' `package.json` files at the snapshot. They were not run during this audit.

- `pnpm --filter @omnyo/provider-bridge-protocol test` (script: `vitest run --config vitest.config.ts`). It should pass, and the output should list the four new `src/acp/*.test.ts` files.
- `pnpm --filter @omnyo/provider-bridge-acp test` and `pnpm --filter @omnyo/provider-bridge-acp-next test` (same script). Both should pass, and each should still run `src/bridge/opencode-usage.test.ts` with one case.
- `pnpm --filter @omnyo/provider-bridge-protocol typecheck`, plus the same for `@omnyo/provider-bridge-acp` and `@omnyo/provider-bridge-acp-next` (script: `tsc --noEmit`). The protocol `tsconfig.json` includes `src`, so the new tests are type-checked.
- `pnpm --filter @omnyo/provider-bridge-protocol lint` and the same for both engines (script: `oxlint --ignore-pattern "**/*.mjs" src`). Then `pnpm exec oxfmt <changed files>` and `pnpm exec oxlint --deny-warnings --format=agent` from the repository root, per the repository's formatting policy. Root `format:check` is `oxfmt . --check`.

Acceptance criteria:

- **Coverage is preserved.** The number of passing cases in the protocol run grows by exactly the number that the six deleted engine files and the removed parts of `opencode-usage.test.ts` held in one engine (compare against the step 2 baseline). No assertion text changed; `git diff -M` shows the moved files as renames or copies, with only import lines altered.
- **The boundary test survives.** Both engines still run "routes bridge usage requests to Go with the configured launch environment" and it passes.
- **Ownership is structurally complete.** Afterward, `git grep -n "provider-bridge-protocol/acp/\(cursor-mcp-approval\|opencode-usage\|provider-maintenance\)" -- 'packages/provider-bridge-acp*/**/*.test.ts'` returns no matches, and `launch-spec.test.ts` no longer exists in either engine.
- No UI, performance or production behavior is involved, so no visual or benchmark check applies.

**Rollback and stop conditions**

The change consists of test files only, in one commit, so reverting that commit restores the previous layout exactly. No data or compatibility concerns apply.

Stop and re-plan when any of these occurs:

- **Checkpoint A fails because Vitest cannot resolve `@omnyo/provider-bridge-protocol/bridge-kit` from inside the protocol package.** Do not patch production imports under this card. Two options remain. One is to add a narrowly scoped `resolve.alias` in `packages/provider-bridge-protocol/vitest.config.ts` that maps `@omnyo/provider-bridge-protocol` to `./src`, and record that choice in the commit message. The other is to move only `launch-spec.test.ts` and `opencode-usage.test.ts`, whose subjects do not value-import the package's own name. In the moved OpenCode test, import `providerUsageResultSchema` from `../index.js` instead of `@omnyo/provider-bridge-protocol`. Leave `provider-maintenance.test.ts` and `cursor-mcp-approval.test.ts` (which reaches `tool-proxy-mcp.ts`) in the engines, and report why.
- **Step 1 finds that the engine copies diverge.** Move only the common cases and keep the engine-specific case in its engine.
- **A moved case passes in an engine but fails in the protocol package.** This would show a hidden dependency on engine state or module loading order. Keep that case in the engines and report the dependency.
- **RF-001 is mid-flight on the same files.** Coordinate with it so only one change edits the classic engine's test files, rather than producing conflicting deletions.
