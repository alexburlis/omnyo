# RF-128 — Delete Composer Predictions' failure parsers for Account Pooler messages that no longer exist, and decide separately whether to add typed codes for the five that do

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The sweep's central claim is true: Composer Predictions classifies Account Pooler failures by matching their English text. Two parts of the sweep report were wrong, though. Most of the literal table it cites no longer has a producer on the predict path. And the plugin RPC envelope cannot carry a handler-specific code today. The opportunity splits into two stages:
  - **Stage 1 (the simplification):** delete the dead parsers. This is small, low-risk and needs one owner decision on version skew.
  - **Stage 2 (typed codes for the live messages):** a design decision that adds machinery before it removes any, so it is not recommended now.
- **Potential:** low. Stage 1 removes about 40 production lines and one false cross-plugin coupling. Stage 2 removes no lines until the minimum host and Account Pooler versions rise.
- **Confidence:** high for the facts, which are proven by inspection. Medium for the line counts, which are projected.
- **Readiness:** conditional. Stage 1 is ready once Alex answers the Gate A question below. Stage 2 is decision-needed.
- **Effort:** Stage 1 takes about 1–2 hours including spec edits. Stage 2 takes about 1–2 days across the plugin SDK, the server, the fake plugin host and both plugins.
- **Risk:** Stage 1 can change only the `cause` and `native` fields of newly written failure diagnostics, and only if a newer Composer Predictions runs against an Account Pooler build older than commit `e941d383a`. It does not change retry timing, user-facing messages or persisted-format parsing. Stage 2 touches a public plugin SDK contract (`PluginRpcError`).
- **Prerequisites:** none for Stage 1. Stage 2 needs a plugin SDK release and a decision about the minimum supported host version.
- **Related and overlapping items:**
  - RF-122 ("One Codex app-server JSON-RPC client inside Account Pooler") rewrites `plugins/account-pool/src/prediction-native.ts`. After Stage 1, Composer Predictions no longer appears to depend on that file's `Native Codex …` messages, so RF-122 can reword them freely. In fact Composer Predictions does not depend on them today either.
  - RF-120 (provider-retry contract in the plugin SDK) is a different retry mechanism with no shared code.
  - RF-041 and the BB-retirement items own the `BB request timed out` alternative in `sdkTimeoutMs`. That alternative is a non-goal here.
- **Why it deserves its place:** the parsers look like live contracts. A maintainer changing Account Pooler's native Codex client (RF-122) or reading Composer Predictions' failure taxonomy has to work out that they are dead. Deleting them leaves the real cross-plugin contract visible: five messages.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The audit inspected it with `git show <commit>:<path>` because the named snapshot worktree was absent. No tests were run, because the snapshot has no `node_modules`.

How the subsystem works:

- After a chat turn completes, Composer Predictions (`plugins/composer-predictions/server.ts`) calls Account Pooler's RPC `experimental_composer-predictions.v1.predict` through `api.sdk.plugins.callRpc` (server.ts:1409–1425, `requestPrediction`).
- When that call rejects, the `.catch` block (server.ts:1569–1640) turns the error into three things:
  - A user-facing message, through `predictionFailureMessage` (server.ts:207–228).
  - A retry schedule, through `retryDelay` (server.ts:195–205) and `scheduleRetry` (server.ts:1096–1109).
  - A persisted diagnostic record, through `recordFailure` (server.ts:483–520). That record holds `native: nativeFailure(error)` and `cause: failureCause(error)`, and is stored under the kv key `prediction-failure:v1:<threadId>` with the shape of `predictionFailureSchema` (contract.ts:135–151).

How a handler error crosses the RPC boundary (Proven by inspection):

- Any error that an RPC handler throws becomes `{ ok: false, error: { code: "handler_error", message } }` (`apps/server/src/services/plugins/plugin-service.ts:2622–2626`, inside `invokeRpcHandler`).
- The route answers that envelope with HTTP 500 (`apps/server/src/routes/plugins.ts:1236–1241`).
- `PluginRpcErrorCode` is a closed union of six transport categories (`packages/plugin-sdk/src/rpc-contract.ts:11–17`).
- `OmnyoHttpError` reads only a top-level `code` (`packages/sdk/src/response.ts:318–331`, `readHttpErrorCode`), so the caller sees `code === null` and the message `HTTP 500: <handler message>`.
- Only the message text and `error.body` reach Composer Predictions. A typed per-failure code would need a change to the SDK or the server envelope, or a new in-band result shape.

Which matchers still have a producer on the predict path (Proven by inspection). Account Pooler's predict handler is `registerComposerPredictions` (`plugins/account-pool/src/composer-predictions.ts:57–262`). It calls `hub.completePrediction` (`plugins/account-pool/src/hub.ts:943–1018`), which forwards an HTTP `/v1/responses` request through `forwardWorkflow`, and then calls `predictionResult` (`plugins/account-pool/src/prediction-contract.ts:200–257`).

| Composer Predictions matcher (server.ts) | Producer at snapshot | Status |
|---|---|---|
| `predictionFailureMessage`: `includes("fresh included Codex allowance")` (:212), which then drives `ALLOWANCE_UNAVAILABLE` (:104) retries of 30 and 90 minutes and `settleWithoutAllowance` (:1609–1617) | `hub.ts:960` and `hub.ts:1010` `"Predictions need fresh included Codex allowance."` | **Live.** It changes retry behaviour and the stored state. |
| Exact match on `"Enable Codex routing in Account Pooler to generate predictions."` (:215–219) | `composer-predictions.ts:239–241` | **Live.** The failure is permanent and waits for Retry. |
| `includes("thread’s machine is unavailable")` (:221), which maps to the "Reconnect…" message, a member of `machineFailures` (:182–185) | `composer-predictions.ts:212` | **Live.** It drives machine-reconnect handling (:1619 and :1991–2002). |
| `includes("conversation context is unavailable or too large")` (:224) | `prediction-context.ts:4–5` `PREDICTION_CONTEXT_ERROR` | **Live.** The failure is permanent. |
| `failureCause` map entry `"Codex returned an invalid prediction."` mapping to `invalid_prediction` (:295) | `prediction-contract.ts:210`, `:231` and `:240` | **Live.** It affects diagnostics only. |
| `nativeFailure` regex `^Codex did not complete the prediction \(status=…, code=…\)` (:230–249), used at :277 and :503 | None. The producer was deleted by `e941d383a` ("Use pooled Codex subscriptions for composer predictions", 2026-11-24), which removed `prediction-runner.ts`. | **Dead** against the snapshot's Account Pooler. |
| `native-rpc` regex `^Native Codex request failed \((-?\d{1,5})\)$` (:279–286) | `prediction-native.ts:358` only. `NativeSession` is imported only by `plugins/account-pool/src/workflow-cli.ts:13–16`, which is the host workflow-model path in `host.ts:2` and `:12`, not predict. | **Dead** on the predict path. |
| Map entries `Native Codex could not start`, `exited before prediction completed`, `connection closed`, `session closed`, `returned an invalid message` and `notification handler failed` (:289–294) | `prediction-native.ts` only, which is the workflow path | **Dead** on the predict path. |
| Map entries `Native Codex returned cyclic prediction lineage.` and `Native Codex changed the prediction source model.` (:297–301) | None anywhere. They were removed by `6edf5bebf` on 2026-11-24. | **Dead.** |
| Map entry `Claude returned an invalid prediction.` (:296) | None anywhere | **Dead.** |

Search commands, run from `$OMNYO_CHECKOUT` with `C=e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e`:

- `git grep -n "did not complete the prediction\|prediction lineage\|prediction source model\|returned an invalid prediction" $C` found hits only in `server.ts`, `server.spec.ts` and `prediction-contract.ts` (the "Codex returned an invalid prediction." producer).
- `git grep -n "Native Codex" $C -- plugins apps packages` found no hits outside `prediction-native.ts`, `server.ts` and the tests.
- `git log --oneline -S"did not complete the prediction" $C` named `e941d383a` and `6edf5bebf` as the last changes.
- `git grep -n "prediction-native" $C -- plugins/account-pool` found only `workflow-cli.ts` among non-test files.
- `hub.ts` imports only a type from `prediction-contract.js`.

Other consumers checked:

- No UI code matches these strings. `plugins/composer-predictions/app.tsx` and `apps/app/src` match only the allowance message, and only in a story and in tests.
- The CLI `diagnostics` command prints the stored record as it is.
- The stored records keep parsing through `predictionFailureSchema.safeParse` (server.ts:392). Its `native` field and its `native`, `native-rpc` and `native-process` cause variants must stay so that old records remain readable.

Intra-plugin text matching (observed, and out of Stage 1's scope):

- `retryDelay` also matches Composer Predictions' own display strings: `transientFailures` and `startsWith("Checking ")` or `startsWith("Could not check ")`. Those prefixes come from `PredictionReadinessError` in `plugins/composer-predictions/readiness.ts:6–14`.
- `machineFailures.has(entry.state.message)` (:1997) reads the persisted `state.message` after a restart, so the display message also acts as persisted state.

Version skew (observed facts):

- Both plugins are bundled, both at version `0.1.0`, and they "ship inside the selected private runtime" (`plugins/omnyo-guide/skills/omnyo-plugin-authoring/references/distribution.md:160`).
- One bundled plugin can be updated alone with `omnyo plugin update <id> --directory …` (`packages/templates/src/templates/omnyo-guide-plugins.md:611–613`).
- An Account Pooler build older than `e941d383a` still accepts today's Composer Predictions input, because its input schema defaulted `cliPath` to `"codex"` (`git show e941d383a^:plugins/account-pool/src/prediction-contract.ts:90`). That build would still emit the native messages.
- Composer Predictions already tolerates one skew case: `FORCE_UNAVAILABLE_MESSAGE` (server.ts:159–160) and `refusedForce` (:175–180).

Tests that encode the contract (`plugins/composer-predictions/server.spec.ts`, 4,094 lines):

- The retry table at :2486–2491.
- The safe-message table at :2964–2995.
- The diagnostics-cause table at :2996–3057.
- `"Codex did not complete…"` used as arbitrary failure text at :1077–1081 and :3697–3701. Both uses stay valid after Stage 1.

Maintenance cost today: the dead matchers make a 2026-11-24 transport change look like a live contract. A maintainer editing `prediction-native.ts` under RF-122 would believe Composer Predictions' diagnostics depend on those exact strings. Someone reading `failureCause` must hold a 10-entry message table and two regexes in mind when only one entry can still match.

**Proposed end state and preservation argument**

Stage 1 end state:

- `failureCause` keeps the timeout, `TimeoutError`, transport-code and HTTP-status classification, plus one exact match: `"Codex returned an invalid prediction."` maps to `{ kind: "native-process", code: "invalid_prediction" }`.
- `nativeFailure`, the `native-rpc` regex and the other nine map entries disappear.
- `recordFailure` writes `native: null`.
- `predictionFailureMessage`, `retryDelay`, `transientFailures`, `machineFailures` and every user-facing message stay unchanged. Retry timing, the state machine and the realtime payloads therefore stay identical.
- `contract.ts` stays unchanged, so `nativeFailureSchema`, `predictionFailureCauseSchema` and `predictionFailureSchema` still parse records that older builds stored with `native` populated or with `native`, `native-rpc` or `native-process` causes. That preserves the persisted format.

Preservation argument (Proven by inspection):

- `predictionFailureMessage` never looks at the deleted patterns, so the user message is the same for every input.
- `retryDelay` receives the output of `predictionFailureMessage`, so retries are unchanged.
- The only observable difference arises when the input is one of the dead strings: a newly written diagnostic then records `cause: { kind: "http", status: 500 }` (or `unknown`) and `native: null` instead of the native categories. With the snapshot's Account Pooler no such input can occur. It occurs only if a newer Composer Predictions runs against an Account Pooler build older than `e941d383a`.
- `FAILURE-MODES.md:18–24` requires "a fixed cause category for … native RPC failures and native process/output failures". That requirement described the native runner, which no longer exists on this path. The document must be updated in the same change, keeping the "old records remain readable" clause.

Stage 2 end state (only if Alex chooses it):

- Account Pooler throws its five live failures with a stable reason token.
- The RPC envelope carries that token as an optional `reason` on `PluginRpcError`. The server passes it through, and the SDK exposes it on `OmnyoHttpError.body.error.reason`.
- Composer Predictions classifies by reason and falls back to the current text matching only when no reason is present.
- The text fallback can be deleted only after both of these hold:
  - Composer Predictions' `engines.omnyo` floor reaches the host release that propagates `reason`. The floor is `>=0.46.0` today (`plugins/composer-predictions/package.json`).
  - Account Pooler's code-emitting version is the supported minimum.

  Until then Stage 2 adds code and removes none.
- An in-band alternative, a failure variant in the predict result, is worse. Older Composer Predictions builds would fail `poolPredictionSchema` output parsing and lose the 30- and 90-minute allowance retries and the machine handling.

Non-goals:

- Turning the intra-plugin display-string retry keys and the readiness prefixes into typed kinds. `state.message` doubles as persisted state for `machineFailures`, so this needs a persisted kind or a fallback for restored entries. The value is small, so it is excluded.
- The `BB request timed out` alternative in `sdkTimeoutMs`, which belongs to the BB-retirement items.
- Changing any schema in `contract.ts`.
- Rewording any message.

**Expected gain and cost**

Stage 1 (projected; method: `awk` line counts over the snapshot file):

- Production lines removed from `plugins/composer-predictions/server.ts`:
  - `nativeFailure`, :230–249: 20 lines, 17 of them non-blank.
  - The :277 line.
  - The `native-rpc` block, :279–286: 8 lines.
  - Nine map entries, :289–294 and :296–301: 12 lines.
  - The `nativeFailureSchema` import, :18.
- Collapsing the one-entry Map into an `if` saves 3–5 more lines.
- Total: about 40–46 handwritten production lines removed and 1–3 added. The net reduction is about 40.
- Tests: about 25–35 lines of `server.spec.ts` change, by removing or rewriting four diagnostics cases and one retry case.
- Docs: about 3 lines change in `FAILURE-MODES.md`.
- Mechanisms: one dead regex parser, one dead regex classifier and nine dead message mappings disappear. The apparent coupling between Composer Predictions and `prediction-native.ts` disappears. The cross-plugin text contract shrinks from 14 apparent literals to 5 real ones.
- Maintenance example: before, rewording `"Native Codex session closed"` under RF-122 looks as if it changes Composer Predictions diagnostics, so a maintainer edits or checks two plugins. After, that wording belongs to Account Pooler's workflow path alone.

Stage 2: the gain is unknown and deferred. The cost is about 30–60 production lines across `rpc-contract.ts`, `plugin-service.ts`, `fake-plugin-host.ts`, Account Pooler and Composer Predictions, plus a plugin SDK release. The text fallback stays during the support window. Performance is neutral for both stages, because both act on cold error paths only.

**Execution steps**

1. **Reconfirm the snapshot.** In the working checkout, confirm that `plugins/composer-predictions/server.ts` still contains `nativeFailure`, `failureCause` and the map at the cited symbols. Re-run the searches in Context against `HEAD`:
   - `rg -n "did not complete the prediction|prediction lineage|prediction source model|Claude returned an invalid prediction" plugins packages apps` must match only Composer Predictions' own files.
   - `rg -n "prediction-native" plugins/account-pool/src --glob '!*.test.ts'` must match only `workflow-cli.ts`.
   - `rg -n "completePrediction" plugins/account-pool/src` must not reach `NativeSession`.

   If Account Pooler's predict handler again routes through `NativeSession` or emits any of these strings, stop and re-plan.

2. **Gate A (owner decision, required before step 3).** Ask the owner: "Must a newer Composer Predictions keep classifying diagnostics precisely when it runs against an Account Pooler build older than `e941d383a` (2026-11-24)? Bundled plugins ship together, so that happens only when one plugin is updated alone." Two outcomes are possible:
   - **No:** proceed with step 3.
   - **Yes:** stop. Record that the native parsers stay until Account Pooler's minimum supported build is `e941d383a` or later, and add a comment naming that removal condition above `nativeFailure`.

3. **Edit `plugins/composer-predictions/server.ts`.**
   - Delete `function nativeFailure` (:230–249).
   - In `failureCause`, delete `if (nativeFailure(error) !== null) return { kind: "native" };` (:277) and the `rpc` and `rpcCause` block (:279–286).
   - Replace the `nativeCode` Map and the `nativeCause` parse (:288–309) with an exact match:

     ```ts
     if (message === "Codex returned an invalid prediction.")
       return { kind: "native-process", code: "invalid_prediction" };
     ```

   - In `recordFailure` (:503), replace `native: nativeFailure(error),` with `native: null,`. Keep the field, because `predictionFailureSchema` requires it.
   - Remove `nativeFailureSchema` from the import list (:18) if nothing else in the file uses it.
   - Leave `predictionFailureMessage`, `retryDelay`, `sdkTimeoutMs`, `transientFailures`, `machineFailures` and `contract.ts` untouched.

4. **Edit `plugins/composer-predictions/server.spec.ts`.**
   - In the diagnostics table (:2996–3057), delete the two `"Codex did not complete the prediction (…httpStatus=401/429)"` cases that expect `native` details. Delete the `"Native Codex request failed (-32603)"` and `"Native Codex exited before prediction completed"` cases.
   - Keep the `"…code=private-secret…"` case, which still expects `{ kind: "http", status: 500 }`, and the `"Codex returned an invalid prediction."` case.
   - Add one case asserting that an old native message (for example `"Native Codex session closed"`) now records `native: null` with an `http 500` cause. That records the intended behaviour change instead of hiding it.
   - Add or keep a test that a stored record with `native` populated and `cause: { kind: "native-rpc", code: -32603 }` still comes back unchanged from the `diagnostics` RPC. Search the spec for an existing persisted-record fixture first and reuse it if one exists.
   - In the retry table (:2486–2491), see newIssue ISS "stale permanent retry case". Fix that case in a separate commit before step 3 so the baseline is green.

5. **Update `plugins/composer-predictions/FAILURE-MODES.md:18–24`.** State that native categories remain readable in stored records and that current classification records invalid prediction output, deadlines, HTTP status and allowlisted transport codes. Keep the "Old records without a cause remain readable" sentence.

6. **Verify and recount.** Run the commands below and inspect the full diff for unrelated changes. Recount the removed lines in `server.ts` against the snapshot with `git diff --stat`.

7. **Gate B (Stage 2, optional, separate change).** Implement Stage 2 only if Alex asks for typed codes. Before any code, write down:
   - The token set, for example `allowance_unavailable`, `routing_disabled`, `machine_unavailable`, `context_unavailable`, `invalid_prediction` and `generation_failed`.
   - The SDK field: `PluginRpcError.reason?: string`, bounded to `/^[a-z][a-z0-9_]{0,63}$/`.
   - How a handler sets the token: an exported plugin SDK helper, or an Error property read by `invokeRpcHandler`.
   - The plugin SDK version that introduces the field and the matching `engines` floors.
   - The exact condition that deletes the text fallback.

   Then edit, in this order:
   1. `packages/plugin-sdk/src/rpc-contract.ts`.
   2. `apps/server/src/services/plugins/plugin-service.ts` (:2622–2626).
   3. `packages/plugin-sdk/src/testing/fake-plugin-host.ts` (:2218).
   4. Account Pooler's throw sites: `hub.ts:960` and `:1008–1012`, `composer-predictions.ts:212` and `:239–241`, `prediction-context.ts`, and `prediction-contract.ts`.
   5. Composer Predictions' `predictionFailureMessage` and `failureCause`, which read `error.body?.error?.reason` first.

   Keep every message identical so that older Composer Predictions builds behave the same.

**Verification and acceptance criteria**

The commands below follow the package scripts in the snapshot. Their package names come from each `package.json` `name` field. None of them was run in this audit, because the snapshot has no `node_modules`. Run them from `$OMNYO_CHECKOUT` or the implementing worktree:

- `pnpm --filter omnyo-plugin-omnyo--composer-predictions test`, which runs `vitest run --config vitest.config.ts` and includes `**/*.{test,spec}.{ts,tsx}`. Expected result: pass, including the updated diagnostics table and the retry table at :2486.
- `pnpm --filter omnyo-plugin-omnyo--composer-predictions typecheck`, which runs `tsc --noEmit`.
- `pnpm --filter omnyo-plugin-omnyo--composer-predictions lint`, which runs `oxlint`.
- `pnpm exec oxfmt --check plugins/composer-predictions/server.ts plugins/composer-predictions/server.spec.ts plugins/composer-predictions/FAILURE-MODES.md`. The root script `format:check` is `oxfmt . --check`.
- Stage 2 only:
  - `pnpm --filter omnyo-plugin-account-pool test`.
  - `pnpm --filter omnyo-plugin-account-pool typecheck`.
  - The plugin SDK and server package tests for the RPC envelope. Read `packages/plugin-sdk/package.json` and `apps/server/package.json` for the exact script names first; they are not confirmed here.

Behaviour checks:

- The safe-message table (:2964–2995) and the retry table (:2486–2491) produce identical messages and call counts before and after Stage 1.
- The allowance, routing-disabled, machine-unavailable and context-too-large messages keep their current retry classes.
- An old stored diagnostic with native fields still parses.

Structural completion:

- `rg -n "nativeFailure\(|Native Codex|did not complete the prediction|Claude returned an invalid prediction" plugins/composer-predictions/server.ts` returns nothing.
- `contract.ts` is unchanged.
- No UI is affected, so no visual check is needed.

**Rollback and stop conditions**

Stage 1 is one commit confined to `plugins/composer-predictions/`. Reverting it restores the parsers. No persisted data changes: records written with `native: null` already conform to the existing schema.

Stop if any of these is true:

- Gate A is answered "yes".
- Account Pooler's predict path emits any deleted string again. This could happen if RF-122 or a later change routes predictions through `NativeSession`.
- A test shows that a user message or retry timing changed.
- Removing a schema variant becomes necessary. It should not.

For Stage 2, stop if the plugin SDK envelope change cannot stay optional and backward compatible, or if the host-floor decision leaves the text fallback in place indefinitely. In that case the smaller alternative is to keep the five messages as an explicit contract: add exact-string assertions for `"The thread’s machine is unavailable"` and `PREDICTION_CONTEXT_ERROR` to Account Pooler's tests (`plugins/account-pool/src/composer-predictions.test.ts`), beside the existing `"Enable Codex routing"` and allowance assertions, each with a comment naming Composer Predictions as the consumer.
