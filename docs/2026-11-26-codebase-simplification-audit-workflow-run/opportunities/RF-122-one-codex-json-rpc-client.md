# RF-122 — Replace Account Pooler's inline Codex app-server client in `nativeCodexSnapshot` with the existing `NativeSession` client

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplication is real and is described accurately. The sweep was wrong about test support: the fake app-server fixture it cited was deleted two days before the snapshot. The sweep also missed one consumer (a broken QA harness) and understated two lifecycle differences, close timing and the bounded close.
- **Potential:** medium. One of two hand-written newline JSON-RPC clients disappears, together with one of two spawn paths and one of two kill strategies.
- **Confidence:** medium-high. The structural claim is proven by inspection. The latency of the shared close path against the real Codex CLI is not measured yet.
- **Readiness:** ready, with one named behaviour change. The consolidation moves the native-route spawn onto the portable spawn helper. That fixes a native-Windows defect (see Context, item 6), and the fix lands as its own first commit. The platform contract already covers it: `docs/platform-support.md` lists the native Windows host (alpha) as supported, and the pool route already uses the portable helper. The executing agent must still name the fix in its report.
- **Effort:** about half a day, including one fixture-backed characterization test, which does not exist today.
- **Risk:** low to moderate. The change touches the allowance check that guards spending the user's own ChatGPT subscription on workflow steps. Every failure must still map to "unavailable", and the check must never report allowance it did not read.
- **Prerequisites:** none. RF-019 should preferably land first, because it deletes `tests/qa/composer-predictions/proof.mjs`, the only other importer of `prediction-native.ts`. RF-019 only matters for the optional rename in step 7.
- **Related and overlapping RF ids:**
  - RF-121 removes the Claude branches. It edits the same file: `nativeWorkflowEligibility` in `native-workflow-eligibility.ts:249-254`, plus `workflow-cli.ts`.
  - RF-030 moves the workflow-model RPC contract into the SDK. It touches `workflow-contract.ts` and `host.ts`, but not the two clients.
  - RF-019 deletes the broken harness.
  - RF-128 touches the same plugin, but has no file overlap with this card.
  - Whichever of RF-121 and RF-122 lands second must rebase onto the other. Their edits do not conflict semantically.
- **Why it deserves its place:** a Codex app-server protocol change currently needs two edits in two different framing implementations: a change to `initialize`, a server request that must be refused, or the message envelope. The two implementations already disagree on spawn, cap, kill and server-request handling. That disagreement has already caused one platform defect (Windows spawn). The gain is modest, but it removes duplicated knowledge and does not move code around.

**Context and evidence**

The snapshot is commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e`. The audit worktree was gone when this card was written, so the files were read with `git -C $OMNYO_CHECKOUT show e9e1b74c3:<path>`.

Account Pooler (`plugins/account-pool`) contributes a host entry, `src/host.ts`, with two workflow handlers. `workflowModelCapabilities` calls `nativeWorkflowEligibility`, and `workflowModelComplete` calls `completeWorkflowCli`. Both need to talk to the user's installed `codex app-server` over newline-delimited JSON-RPC on stdio.

Observed facts (Proven by inspection unless stated otherwise):

1. **Client A, `NativeSession`.** It lives in `plugins/account-pool/src/prediction-native.ts:44-374`, which is 374 lines, 308 of them non-blank.
   - **Spawn and envelope.** It spawns through `experimental_spawnPortableProcess` (`:151`, which uses cross-spawn underneath: `packages/process-utils/src/spawn.ts:36`). It keeps an id-keyed `pending` map (`:45`). It validates every message with `nativeMessageSchema` (`:13-21`).
   - **Cap.** The 8 MiB cap (`maxMessageBytes`, `:9`) applies to both the inbound buffer and outbound lines (`:264`, `:281`).
   - **Server requests.** It answers server-initiated requests with JSON-RPC error `-32000` (`:311-322`) and fans out notifications (`:324-339`).
   - **Abort.** It aborts through the caller's `AbortSignal` (`:84-87`).
   - **Close.** `close`/`stop` (`:222-258`) ends stdin, sends SIGTERM after 1 s and SIGKILL after 2 s through `experimental_killPortableProcess`, then awaits `close` with no upper bound.
   - **Opener.** Its only public opener is `NativeSession.open` (`:90-137`). That opener builds the pool route: `-c` overrides for `model_providers.omnyo-account-pool`, an isolated environment (`isolatedEnvironment`, `:35-42`) and a temporary `CODEX_HOME`.
   - **Leftover parameter.** The private `start(options, signal, clientName)` (`:139-179`) is a leftover of a second opener. Commit `e941d383a` ("Use pooled Codex subscriptions for composer predictions", 2026-11-24) removed `openPrediction`, `textOnly`, `waitForExit`, `src/prediction-runner.ts`, `src/prediction-native.test.ts` and `src/fixtures/prediction-native.mjs`.
   - **Consumers.** Its only production consumer is `codexText` in `plugins/account-pool/src/workflow-cli.ts:47-58`.
2. **Client B, inline in `nativeCodexSnapshot`.** It lives in `plugins/account-pool/src/native-workflow-eligibility.ts:104-213`, which is 110 lines, 94 of them non-blank.
   - **Spawn.** It uses `node:child_process` `spawn` (`:1`, `:108-114`) with the inherited environment and cwd. It runs `["app-server"]` with no overrides.
   - **Ids and cap.** Request ids 1, 2 and 3 are hard-coded and sequenced inside the `data` handler (`:187-198`). The inbound cap is 256 KiB (`:160`).
   - **Timeouts and kill.** An overall 15 s timer (`:146`) covers spawn, initialize and both reads. `finish` (`:123-132`) sends SIGTERM immediately through `child.kill()`, SIGKILL after 1 s, and rejects with `unavailable` if `close` has not fired within 3 s.
   - **Failure mapping.** Any JSON-RPC `error`, unparsable line, stream error or early exit maps to `unavailable` (`:13-14`).
   - **Requests sent.** It sends `initialize` with `clientInfo: { name: "omnyo_workflow_allowance", version: "1" }`, then `initialized`, `account/read { refreshToken: false }` and `account/rateLimits/read {}`. It resolves `{ account, quota }`.
   - **Caller.** Its only caller is `withNativeWorkflowAccount` (`:215-243`), which validates the result with `validateNativeCodexAllowance` (`:58-88`).
3. **Duplicated command resolution.** Both clients resolve the binary identically, as `process.env.OMNYO_CODEX_BRIDGE_APP_SERVER_COMMAND?.trim() || "codex"` (`native-workflow-eligibility.ts:109` and `workflow-cli.ts:53`). The variable is declared in `packages/config/src/omnyo-environment.ts:34-35`.
4. **Call frequency.** `withNativeWorkflowAccount` runs for every upstream request that the native-route gateway proxies (`workflow-cli.ts:287`, inside `nativeText`). It also runs once per capability check (`nativeWorkflowEligibility`, `:257`). During a native-route workflow step, two app-servers are therefore alive at once:
   - the pool-route `NativeSession` opened by `codexText`;
   - one short-lived snapshot child per gateway request.

   Snapshot latency is on the workflow request path.
5. **Consumers.** I searched with `git -C $OMNYO_CHECKOUT grep -n -E "prediction-native|NativeSession|nativeCodexSnapshot|withNativeWorkflowAccount|nativeWorkflowEligibility|native-workflow-eligibility" e9e1b74c3 -- . ':!*.md'`. Excluding unrelated `*NativeSession*` names in apps/server, packages/db, desktop and chat-importer, the search found:
   - `plugins/account-pool/src/host.ts:1,10`;
   - `plugins/account-pool/src/workflow-cli.ts:3,14-16,52,287`;
   - `plugins/account-pool/src/native-workflow-eligibility.test.ts:3-5`;
   - `plugins/account-pool/src/workflow-cli.integration.test.ts:11` (which mocks `withNativeWorkflowAccount`);
   - `tests/qa/composer-predictions/proof.mjs:345-346,374,613`, which the sweep missed. It imports `NativeSession` by file path, but the harness is already broken at the snapshot: it imports the deleted `prediction-runner.ts` and calls `open` with an outdated four-argument signature. RF-019 deletes it.

   Nothing outside the plugin imports these modules. The plugin's `package.json` declares only `server`, `app`, `host` and `skills` entries, so these modules are not a plugin-SDK export or a public surface. Neither client persists any format.
6. **Windows defect (incidental).** Client B calls `node:child_process` `spawn("codex", …)` without a shell. On Windows, Node resolves a bare command through `PATH` only as `.com` or `.exe`. Since the CVE-2024-27980 fix, Node also refuses to spawn `.cmd` or `.bat` files without `shell: true`. An npm-installed Codex CLI exposes `codex.cmd`, so on the native Windows host the spawn errors. `abort` then makes every native-route capability check return `allowance_unavailable`. Client A uses cross-spawn, which resolves `.cmd` shims. The deleted test from `e941d383a^` wrote a `codex.cmd` wrapper on `win32` for exactly this reason (`git show e941d383a^:plugins/account-pool/src/prediction-native.test.ts`). The code path is proven by inspection. The Windows outcome follows from documented Node behaviour but was not reproduced on Windows.
7. **Test coverage today.**
   - `native-workflow-eligibility.test.ts` covers only `validateNativeCodexAllowance` and the Claude branch. Nothing exercises `nativeCodexSnapshot`.
   - Since `e941d383a`, nothing that runs by default exercises `NativeSession`.
   - `workflow-cli.integration.test.ts` is skipped unless `OMNYO_WORKFLOW_CLI_PROBE=1` is set, needs an installed `codex`, and mocks the snapshot.
   - The fixture the sweep cited (`src/fixtures/prediction-native.mjs`) does not exist at the snapshot. The fake app-server in `plugins/provider-codex/src/bridge/fake-codex-app-server.mjs` belongs to a sibling plugin and must not be imported (`docs/forkable-plugins.md`).
   - The snapshot has no `node_modules`, so no tests were run for this card.
8. **Stale wording.** Several strings in `NativeSession` still say "prediction", although composer predictions no longer use it (they go through `hub.completePrediction`):
   - `"Prediction canceled"` (`:84`, `:149`);
   - `"Native Codex exited before prediction completed"` (`:69`);
   - the refusal text sent to app-server, `"Composer predictions cannot approve or execute tools"` (`:317`).

   Users never see these strings: `completeWorkflowCli` (`workflow-cli.ts:407-421`) maps every non-`WorkflowExecutionFailure` error to a generic message.

Maintenance cost today: every change to the app-server handshake, envelope validation, server-request policy, Windows process handling or the binary-resolution rule must be made twice, in two different styles. The second copy is the one without tests.

Counterevidence and current requirement: the native route must read the signed-in CLI account and its rate limits from the user's real `CODEX_HOME` before it uses those credentials. Client B is deliberately minimal and inherits the environment. Client A's only opener isolates the environment and injects pool overrides, so the replacement needs a second opener that does neither. That is a real requirement, but it is about 10 lines and does not justify a second protocol implementation.

**Proposed end state and preservation argument**

End state:

- **What disappears.** `NativeSession` stays the only app-server client in the plugin. The inline client in `nativeCodexSnapshot` is removed: the `spawn` import, the hard-coded ids, the buffer splitter, the timers, and the close and exit bookkeeping. `NativeSession` gains one opener for the user's own signed-in CLI.
- **Opener sketch.** `NativeSession.openSignedIn(command, signal, clientName)` spawns `[ "app-server" ]` through the existing private `start`, with the inherited environment and no cwd. It must not call `isolatedEnvironment` and must not add `-c` overrides.
- **Spawn options.** `start`'s `options.cwd` and `options.env` become optional. `PortableSpawnRequest` already allows both to be omitted (`packages/process-utils/src/spawn.ts:5-12`).
- **Binary resolution.** One exported helper, `nativeCodexCommand()`, in the session module owns the rule. Both `codexText` and `nativeCodexSnapshot` call it.
- **Snapshot shape.** `nativeCodexSnapshot(signal)` becomes the following:

```ts
async function nativeCodexSnapshot(signal: AbortSignal): Promise<unknown> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  let session: NativeSession | undefined;
  try {
    session = await NativeSession.openSignedIn(
      nativeCodexCommand(),
      bounded,
      "omnyo_workflow_allowance",
    );
    const account = await session.request(
      "account/read",
      { refreshToken: false },
      z.json(),
    );
    const quota = await session.request("account/rateLimits/read", {}, z.json());
    return { account, quota };
  } catch {
    throw new Error(unavailable);
  } finally {
    await session?.close();
  }
}
```

The dependency direction stays the same: `native-workflow-eligibility.ts` imports from the session module, which `workflow-cli.ts` already does. No SDK change and no minimum-version change is needed, because `experimental_spawnPortableProcess` and `experimental_killPortableProcess` are already imported by the plugin, which requires `omnyoPluginSdk >=0.4.102 >=0.6.44`.

Preservation, item by item:

| Behaviour | Today (client B) | After | Kept? |
|---|---|---|---|
| Requests and order | `initialize` → `initialized` → `account/read {refreshToken:false}` → `account/rateLimits/read {}` | Same order. `start` sends `initialized` after the initialize response. | Yes |
| `clientInfo.name` | `omnyo_workflow_allowance` | Passed as `clientName` | Yes |
| `clientInfo.version` | `"1"` | `"0.1.0"` (shared `start`) | Intentional, cosmetic |
| Environment and credentials | Inherited `process.env`, real `CODEX_HOME` | Inherited `process.env` (no isolation, no `-c`) | Yes, must be checked by the test |
| Overall bound | 15 s timer | `AbortSignal.timeout(15_000)` combined with the caller signal | Yes |
| Failure mapping | Everything → `unavailable` | `catch` → `unavailable` | Yes |
| Validation | `validateNativeCodexAllowance` on `{ account, quota }` | Unchanged | Yes |
| Inbound cap | 256 KiB | 8 MiB shared cap | Intentional loosening (see below) |
| Server-initiated request | Numeric id 1–3 would be misread as a response; a string id aborts | Answered with `-32000`, flow continues | Intentional improvement |
| Blank line | Aborts (JSON parse fails) | Skipped | Intentional, harmless |
| Spawn on Windows | `node:child_process`; npm `.cmd` shim fails | cross-spawn | Defect fix, own commit |
| Kill after result | SIGTERM immediately, SIGKILL at 1 s | stdin EOF, SIGTERM at 1 s, SIGKILL at 2 s | Must be measured (step 2) |
| Close bound | Reject after 3 s if `close` never fires | Awaits `close` without a bound | Must be decided (step 2) |

Cap decision: the pool route already accepts 8 MiB from the same binary, and the two snapshot responses are a few kilobytes. Using one cap is the simplest choice. If a reviewer wants the 256 KiB bound kept, add an optional `maxMessageBytes` to `start` (about 4 lines) rather than keeping a second client.

Non-goals:

- Do not change `validateNativeCodexAllowance`, `readAuth`, the before/after token comparison or `nativeWorkflowEligibility`'s result shape.
- Do not change the pool route's `-c` overrides, isolation or close timing.
- Do not share code with `plugins/provider-codex`, because of the forkability rule.
- Do not move the session into the SDK.

**Expected gain and cost**

- **Mechanisms (proven by inspection).** Before: 2 JSON-RPC clients, 2 spawn paths, 2 kill strategies and 2 copies of the binary-resolution rule. After: 1 of each.
- **Production lines (projection).**
  - Removed: about 111 lines from `native-workflow-eligibility.ts`, which is `:104-213` plus the `spawn` import on `:1` (94 of them non-blank).
  - Added: about 20 lines in the new `nativeCodexSnapshot`, about 10 in `NativeSession` (the opener and optional `cwd`/`env`), and about 3 for `nativeCodexCommand`, minus 1 in `workflow-cli.ts`.
  - Net: about 75–85 handwritten production lines.
  - Counting method: `git show e9e1b74c3:<file> | sed -n 104,213p | grep -cv '^\s*$'`.
- **Tests (addition).** One fixture-backed test module adds about 80–120 test lines plus a small fake app-server script. This is new coverage for code that currently has none, not a replacement.
- **Performance.** Unknown until measured. Each check still starts one short-lived child. The only plausible regression is close latency (up to 1 s more per check if `codex app-server` does not exit on stdin EOF), and that latency lies on the native workflow request path. Step 2 measures it.
- **Maintenance link.** A protocol change, such as initialize capabilities, a new server request to refuse or an envelope change, becomes one edit to a tested client instead of two edits, one of them untested.

**Execution steps**

1. **Reconfirm.**
   - **Location.** In a fresh worktree of `$OMNYO_CHECKOUT`, confirm that `plugins/account-pool/src/native-workflow-eligibility.ts` still contains `nativeCodexSnapshot` with `node:child_process` `spawn`, and that `NativeSession` in `plugins/account-pool/src/prediction-native.ts` still has only the `open` opener.
   - **Consumers.** Re-run the consumer search from Context item 5, adding `rg -n "openSignedIn|nativeCodexCommand" plugins/account-pool`.
   - **Re-plan if any of these is true:**
     - another opener or consumer of `NativeSession` has appeared;
     - `nativeCodexSnapshot` has gained methods, notifications or server-request handling;
     - RF-121 or RF-030 has moved these functions;
     - the native route has been retired.
2. **Gate: characterize the current client and measure close.**
   - **Fixture.** Create `plugins/account-pool/src/fixtures/codex-app-server.mjs`, a fake app-server that reads newline JSON-RPC from stdin, answers `initialize`, `account/read` and `account/rateLimits/read`, and appends a trace of the methods it received to a file. Take the previous fixture as a model: `git show e941d383a^:plugins/account-pool/src/fixtures/prediction-native.mjs`.
     - **Mode argument.** It takes a mode argument: `ok`, `rpc-error` (an error on `account/rateLimits/read`), `server-request` (sends `{id: 99, method: "item/tool/call"}` before replying), `hang` (never replies) and `linger` (ignores stdin EOF and exits only on a signal).
     - **Environment check.** It asserts `process.env.CODEX_HOME` equals the test's temporary home, to prove the opener inherits the real environment rather than an isolated one.
   - **Test module.** Add `plugins/account-pool/src/native-workflow-snapshot.test.ts`, or extend `native-workflow-eligibility.test.ts`.
     - **Setup.** Write a temporary `CODEX_HOME/auth.json` that passes `authSchema`. Write a launcher script: on POSIX a `#!/usr/bin/env node` file with mode `0o700`; on Windows a `codex.cmd` wrapper calling `process.execPath`, as in the deleted test. Then `vi.stubEnv("OMNYO_CODEX_BRIDGE_APP_SERVER_COMMAND", launcher)` and `vi.stubEnv("CODEX_HOME", home)`.
     - **Assertions.** Assert `nativeWorkflowEligibility({providerId:"codex", model:"x"}, signal)`:
       - mode `ok` with a valid snapshot (reuse `snapshot()` with `accountId` equal to the `auth.json` account id): `{ available: true }`;
       - mode `rpc-error`: `{ available: false, code: "allowance_unavailable" }`;
       - mode `hang` with an aborted caller signal: `{ available: false, code: "allowance_unavailable" }`;
       - the trace shows exactly `initialize, initialized, account/read, account/rateLimits/read` with `refreshToken:false`.

       Run the test against the **current** inline client first and confirm it passes. This is the independent baseline. Do not include `server-request` in the baseline, because the inline client mishandles it; add that case in step 4.
   - **Close timing.** Measure close timing against the real CLI, if installed (`command -v codex`). Time 10 calls of `nativeWorkflowEligibility` before and after the change with a small `node --import tsx` script in your scratch directory, not in the repository, and record the median and maximum. If `codex` is not installed, use mode `ok` (exits on EOF) and record that real-CLI timing is unverified.
   - **Close decision.** Decide close handling from the measurement:
     - **Exits on EOF.** If the real CLI exits on stdin EOF within about 100 ms, keep `await session?.close()`.
     - **Does not exit on EOF.** Otherwise, add an `immediate` option to `close` that skips the 1 s grace period (SIGTERM at once, SIGKILL after 1 s) and use it only in the snapshot.
     - **Unbounded close.** Either way, decide whether an unbounded wait for `close` is acceptable. Mode `linger` exercises it. The recommended answer: rely on the SIGKILL escalation, which closes the leader's pipes. Accept the change only if mode `linger` still resolves in under 3 s.
3. **Commit 1, Windows defect fix (behaviour change, own commit).** In `nativeCodexSnapshot`, replace `spawn(...)` from `node:child_process` with `experimental_spawnPortableProcess({ command, args: ["app-server"], stdio: ["pipe", "pipe", "ignore"] })`. Replace `child.kill()` and `child.kill("SIGKILL")` with `experimental_killPortableProcess(child, "SIGTERM" | "SIGKILL")`. Guard `child.stdin`/`child.stdout` being null, as `start` does. Run the step-2 tests. The commit message names the Windows fix.
4. **Commit 2, structural consolidation.**
   1. `prediction-native.ts`:
      - Export `nativeCodexCommand = () => process.env.OMNYO_CODEX_BRIDGE_APP_SERVER_COMMAND?.trim() || "codex"`.
      - Make `start`'s `options.cwd` and `options.env` optional.
      - Add `static openSignedIn(command: string, signal: AbortSignal, clientName: string): Promise<NativeSession>`, returning `NativeSession.start({ command, args: ["app-server"], env: process.env }, signal, clientName)`.
      - Add the `immediate` close option only if step 2 required it.
   2. `workflow-cli.ts:52-53`: replace the inline command expression with `nativeCodexCommand()`.
   3. `native-workflow-eligibility.ts`: replace `nativeCodexSnapshot` with the code shown in the end state. Remove the `node:child_process` import. Keep `z`, which is still used by the schemas. Import `NativeSession` and `nativeCodexCommand` from `./prediction-native.js`.
   4. Add the `server-request` mode case to the step-2 test. Expect `available: true`, and expect the fixture trace to record a `-32000` reply.
   5. Checkpoint: the step-2 tests pass unchanged, and mode `linger` meets the decision from step 2.
5. **Neutral wording (optional, same commit or a follow-up).** In `NativeSession`, change `"Prediction canceled"` to `"Native Codex request canceled"`, `"Native Codex exited before prediction completed"` to `"Native Codex exited before the request completed"`, and the `-32000` refusal message to `"Omnyo does not approve or execute tools in this session"`. These strings are diagnostic only (Context item 8). No test asserts them: run `rg -n "Prediction canceled|before prediction completed|Composer predictions cannot" plugins/account-pool` to confirm before you edit.
6. **Clean up.** Confirm that no `node:child_process` import remains in `native-workflow-eligibility.ts`, and that `rg -n "OMNYO_CODEX_BRIDGE_APP_SERVER_COMMAND" plugins/account-pool/src` finds only `nativeCodexCommand`. Update `plugins/account-pool/PLUGIN_OVERVIEW.md` if it describes the eligibility probe. At the snapshot it does not mention `nativeCodexSnapshot`; re-check with `rg -n "app-server|eligib" plugins/account-pool/PLUGIN_OVERVIEW.md`.
7. **Rename (optional, mechanical, separate commit, only after RF-019 deletes `tests/qa/composer-predictions/proof.mjs`).** Run `git mv plugins/account-pool/src/prediction-native.ts plugins/account-pool/src/native-session.ts` and update the two imports. If RF-019 has not landed, skip this step rather than editing the broken harness.
8. **Recount and review.** Recount with the same `grep -cv '^\s*$'` method against `e9e1b74c3`. Inspect the full diff for unrelated changes.

**Verification and acceptance criteria**

Commands (from `package.json` scripts at the snapshot):

- In `plugins/account-pool`: `pnpm test` (runs `vitest run --config vitest.config.ts`, which includes `**/*.test.{ts,tsx}`), `pnpm typecheck` (`tsc --noEmit`) and `pnpm lint` (oxlint).
- Equivalent from the repository root: `pnpm --filter omnyo-plugin-account-pool test`. This command was not run here, because the snapshot has no `node_modules`.
- Formatting, from the repository root: `pnpm exec oxfmt <changed files>`, then `pnpm format:check` (root script `oxfmt . --check`).
- Optional live probe, which needs an installed Codex CLI and changes nothing remote: `OMNYO_WORKFLOW_CLI_PROBE=1 pnpm test -- workflow-cli.integration` in `plugins/account-pool`. It covers the pool-route `NativeSession`. It mocks the snapshot, so it does not prove the snapshot.

Acceptance:

- **Behaviour and contract.** The step-2 tests pass before and after commit 2 without edits to their assertions. This covers the method order, `refreshToken:false`, the inherited `CODEX_HOME`, JSON-RPC error → unavailable, abort → unavailable, and success → available. The existing `validateNativeCodexAllowance` cases and the Claude case still pass unchanged.
- **Lifecycle.** Mode `linger` resolves within the decided bound. No child process remains after the test: the fixture writes its pid to the trace, and the test asserts `process.kill(pid, 0)` throws `ESRCH` after the call. The pool-route close timing is unchanged, because `open` does not use the `immediate` option.
- **Performance.** The median latency of `nativeWorkflowEligibility` over 10 calls against the real CLI is within measurement noise of the step-2 baseline on the same machine, or the deviation is explained. Record both numbers in the report. If the real CLI is unavailable, say so and state that only fixture timing was compared.
- **Windows.** The Windows check is not runnable from macOS. It is verified by inspection that both spawns go through `experimental_spawnPortableProcess`. If a native Windows host is available, run the fixture test there with the `codex.cmd` wrapper.
- **Structural.** `rg -n "child_process" plugins/account-pool/src/native-workflow-eligibility.ts` returns nothing. `rg -n "\"initialize\"" plugins/account-pool/src` returns only the session module. The binary-resolution rule appears once.

**Rollback and stop conditions**

- **Rollback.** Each commit reverts cleanly with `git revert`: commit 2 (structure) can be reverted without reverting commit 1 (Windows fix). No data, persisted format, SDK export or wire contract changes, so rollback has no compatibility implications.
- **Stop if any of these happens:**
  - The baseline test cannot be made to pass against the current inline client, which means a characterization gap exists. Investigate before refactoring.
  - The real CLI does not exit on EOF, and even the `immediate` option leaves median latency measurably above baseline.
  - The real CLI rejects `clientInfo.version: "0.1.0"` or behaves differently with it. If so, pass the version through `start` instead.
  - A new consumer needs the inline client's 256 KiB bound for a stated reason. If so, add the optional cap rather than abandoning the change.
  - The native route is being retired, in which case delete `nativeCodexSnapshot` with it instead.
- **Safer smaller alternative.** If the consolidation stalls, land commit 1 (the Windows fix) and the shared `nativeCodexCommand` alone, and keep the inline client.
