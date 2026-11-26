# RF-121 — Remove Account Pooler's unreachable `claude-code` workflow branches and make its workflow path Codex-only

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Potential:** low to medium. The change removes one concept from Account Pooler's workflow path: "a pooled workflow request might be for Claude". About 45 to 55 handwritten production lines across 8 files go, plus about 125 lines of tests and test fixtures that only exercise that dead concept. No user-visible behavior changes.
- **Confidence:** high. Every cited site was re-read at the snapshot. The only possible caller of the Claude branches was traced through current and historical code (see "Context and evidence").
- **Readiness:** ready. The refusal stays where it is actually reached, in `plugins/provider-claude-code`.
- **Effort:** 2 to 3 hours, including test pruning and one targeted test, typecheck and lint run.
- **Risk:** low. The affected contracts are the plugin RPC `poolWorkflowContract` (pool plugin id `account-pool`), the server-to-host RPC `workflowHostContract`, and the hub's internal workflow lease API. The only behavior change reaches a hypothetical caller that does not exist in any public build. Such a caller would get an `invalid_input` RPC error instead of a structured `allowance_unavailable` refusal (see "Proposed end state").
- **Prerequisites:** none.
- **Related and overlapping:**
  - RF-030 (define the State Machines workflow-model RPC contract once in the plugin SDK) rewrites lines 4-84 of `plugins/account-pool/src/workflow-contract.ts` and keeps `poolWorkflowInputSchema` as an extension with `providerId`. RF-121 changes only line 85 (`workflowProviderSchema`) and lines 134-135 (`CLAUDE_WORKFLOW_UNAVAILABLE`). The two cards do not share lines. RF-030's verification says the account-pool Claude-refusal test "must pass unchanged". Whichever card lands second must reconcile that one test: if RF-121 lands first, that test no longer exists.
  - RF-058 (retire the Account Pooler Claude-subscription compatibility layer) works on the same 2026-11-24 retirement aftermath, but in `contracts.ts`, `store.ts`, `rpc.ts`, `server.ts` and non-workflow parts of `hub.ts`. It shares no lines with this card.
  - RF-122 (one Codex app-server JSON-RPC client inside Account Pooler) is unrelated in substance, but may touch `workflow-cli.ts` or `prediction-native.ts`. Land the two in separate commits.
- **Why it deserves its place:** this is a small, safe deletion of a defensive layer whose only caller was removed two minutes before the layer was written. It does not rank high on volume. It ranks because it removes duplicated policy: today the Claude workflow refusal message and code live in `provider-claude-code` and again at nine sites in Account Pooler, and Account Pooler's workflow helpers take a provider argument that only ever receives `"codex"`.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The read-only worktree named in the audit task had already been removed, so every read used `git show <commit>:<path>` and `git grep <commit>` from `$OMNYO_CHECKOUT`. History from before the public squash came from `$ARCHIVED_OMNYO_CHECKOUT`. No tests were run: the snapshot has no `node_modules`.

*What the subsystem is.* The private State Machines plugin (`$OMNYO_PLUGIN_CHECKOUT/state-machines`, a separate repository) asks for short workflow text through the plugin of the provider that the user selected. It calls `workflowModelCapabilities` and `workflowModelComplete` on `provider-codex` or `provider-claude-code` (`omnyo-plugins/state-machines/src/imported/provider.ts:32` maps `claude-code` to `provider-claude-code`; lines 76 and 153 make the calls). `provider-codex` forwards to Account Pooler. Account Pooler (`plugins/account-pool`, bundled plugin id `account-pool`, `apps/server/src/services/plugins/builtin-registry.ts:38-41`) either leases a pooled Codex account or asks the host entry (`plugins/account-pool/src/host.ts`) to run a guarded native Codex CLI.

*Observed facts (Proven by inspection).*

1. `plugins/provider-claude-code/src/workflow-model-service.ts:8-46` `registerWorkflowModelService` never calls Account Pooler. After the caller check, both handlers return a fixed `allowance_unavailable` refusal with the message "Claude workflow steps cannot verify included-only usage through Claude Code." (lines 14-18, 31, 43).
2. `plugins/provider-codex/src/workflow-model-service.ts:29-35` and `:58-64` call `api.sdk.plugins.callRpc({ pluginId: "account-pool", ..., input: { ...input, providerId: "codex" } })`. This is the only provider that calls the pool workflow RPC.
3. Account Pooler authorizes a workflow request only when the caller plugin id is `provider-${input.providerId}` (`plugins/account-pool/src/workflow-service.ts:29-34` `authorized`). A request with `providerId: "claude-code"` therefore needs the caller `provider-claude-code`, which never calls.
4. History: retired private commit `a632243bf9` (2026-11-24 09:28:10 -0500, "Use native Claude auth status without extracting credentials") removed `provider-claude-code`'s two `callRpc({ pluginId: "account-pool", ..., providerId: "claude-code" })` calls. Two minutes later, `e4dd1bb9c2` (09:30:04, "Retire Claude subscription credentials from Account Pooler") replaced Account Pooler's real Claude workflow implementation with the refusals listed below. The public repository's root commit `060950255` ("Publish Omnyo source", 2026-11-24 11:16) is later than both. No public build has ever had a caller of these refusals. Both plugins are bundled together (`builtin-registry.ts:38-41` and `:134-135`), so a private build pairs matching versions.
5. Account Pooler's own composer-prediction path, `plugins/account-pool/src/hub.ts:943-1019` `completePrediction`, always builds its lease input with `providerId: "codex"` (line 954) and calls `forwardWorkflow(..., "codex", ...)` (line 1002).

*The Claude branches at the snapshot.* Found with `git grep -n -E "claude-code|CLAUDE_WORKFLOW_UNAVAILABLE|claude" e9e1b74c3 -- plugins/account-pool/src ':!*.test.*'`, then filtered to the workflow files:

| File | Symbol and line | What it does |
|---|---|---|
| `plugins/account-pool/src/workflow-contract.ts` | 85 `workflowProviderSchema = z.enum(["codex", "claude-code"])`; 134-135 `CLAUDE_WORKFLOW_UNAVAILABLE` | accepts Claude; defines a second copy of the refusal message |
| `plugins/account-pool/src/workflow-service.ts` | 8 import; 74-77 `claudeDenial`; 87-88 in `workflowModelCapabilities`; 122-123 in `workflowModelComplete` | refuses `claude-code` after authorization |
| `plugins/account-pool/src/workflow-cli.ts` | 18 import; 380-386 in `completeWorkflowCli` | host-side refusal |
| `plugins/account-pool/src/workflow-transport.ts` | 4 import; 28-29 in `workflowRequest`; 203-204 in `inspectWorkflowResponse` | throws for `claude-code` |
| `plugins/account-pool/src/native-workflow-eligibility.ts` | 6-9 import; 11 `NativeInput.providerId`; 249-254 in `nativeWorkflowEligibility` | host-side refusal |
| `plugins/account-pool/src/hub.ts` | 7 import; 390-391 in `handle`; 856-857 `hasWorkflowAccounts(provider)`; 864-868 `workflowAccount(provider, signal)`; 911 `prepareWorkflow` provider mapping; 1024 and 1034 `forwardWorkflow(provider)` and its lease-provider comparison; 1002 the `"codex"` argument | provider-generic workflow API with one real value |
| `plugins/account-pool/src/workflow-allowance.ts` | 3 import; 36-37 in `validatePooledWorkflowAllowance` | throws for a Claude account |

*Why each branch is unreachable (reachability argument).*

- Server RPC handlers (`workflow-service.ts:87`, `:122`): reached only after `authorized(context, "claude-code")`, which needs the absent caller (facts 1, 3, 4).
- Host handlers (`workflow-cli.ts:380`, `native-workflow-eligibility.ts:249`): `host.ts:9-12` routes `workflowHostContract` calls to these functions. The only `host.call` sites are `workflow-service.ts:99` and `:134` and `:144`, and they run after the `claude-code` early returns. No server build in public history sends `claude-code` to the host.
- Transport (`workflow-transport.ts:28`, `:203`): reached from `workflow-cli.ts` after its own refusal, and from `hub.ts` `forwardWorkflow` with a lease. Leases come only from `prepareWorkflow`, whose inputs are `codex` (callers `workflow-service.ts:139` after the refusal, and `hub.ts:958`).
- Hub helpers: `hasWorkflowAccounts` is called only at `workflow-service.ts:72` with `"codex"`; `workflowAccount` only at `workflow-service.ts:94` with `"codex"` and at `hub.ts:912` from `prepareWorkflow` (whose input is always `codex`, see above). Search: `git grep -n -E "hasWorkflowAccounts|workflowAccount\(|prepareWorkflow|forwardWorkflow" e9e1b74c3 -- plugins/account-pool`.
- `validatePooledWorkflowAllowance` (`workflow-allowance.ts:36`): called only from `hub.ts:849` in `verifyWorkflowAllowance`, for an account that `workflowAccount` selected through `includedWorkflowQuota` (`hub.ts:803-815`). That helper already returns `false` unless `account.provider === "codex"` (line 814). `verifyWorkflowAllowance` also always fetches `codexUsageUrl` (line 834), and `codexAllowance.parse` (line 39) would reject a Claude-shaped payload.

*Non-obvious consumers checked.*

- Repository-wide: `git grep -n -E "workflowModel(Complete|Capabilities)" e9e1b74c3` outside `plugins/account-pool` finds only the two provider plugins and their tests. `git grep -n -E "poolWorkflowContract|workflowHostContract|CLAUDE_WORKFLOW_UNAVAILABLE|Claude workflow steps" e9e1b74c3` finds no consumer outside `plugins/account-pool` except `provider-claude-code`'s own literal copy of the message.
- Private plugins: `rg -n -l "workflowModel|account-pool" $OMNYO_PLUGIN_CHECKOUT` (working tree at `7edbc502e2`, 2026-11-26). Only `state-machines/src/imported/provider.ts` calls the workflow RPCs, and it addresses provider plugins, not `account-pool`. `sentry/src/workflow-host.ts:860` and `workdesk/server.ts:225` mention `account-pool` for unrelated reasons.
- The core server addresses Account Pooler RPC by string only at `apps/server/src/services/plugins/plugin-agent-contributions.ts:134`, for `experimental_nativeClaudeRouting.v1.select`, which is unrelated.
- The HTTP header `x-omnyo-workflow-token` is sent only by the host-side Codex CLI configuration (`prediction-native.ts:123`, `workflow-cli.ts:244`, `:280`) to the Codex route. The Claude-route guard in `hub.ts:390-391` is still a trust boundary for any HTTP client, so this card keeps it.
- Not Claude-workflow code, and kept: `composer-predictions.test.ts:165` and `:183` use `claude-code` as the source chat's provider; `workflow-hub.test.ts:330-350` checks that a Claude account in the store is never chosen for a Codex lease; `usage-source.ts`, `operations.ts`, `server.ts:502` and `:535` handle Claude chat routing.

*Maintenance cost today.* Changing the Claude workflow refusal policy or copy means editing `provider-claude-code` and also Account Pooler's contract, service, host CLI, transport, eligibility check, allowance validator, hub and their tests. Reading the pooled workflow path requires reasoning about a provider that cannot reach it, and the hub's workflow API looks provider-generic while serving one provider.

**Proposed end state and preservation argument**

*What remains.*

- `plugins/provider-claude-code/src/workflow-model-service.ts` stays the single owner of the Claude workflow refusal. It is unchanged.
- `poolWorkflowInputSchema` keeps its `providerId` field, narrowed to `z.literal("codex")`. `provider-codex` keeps sending `providerId: "codex"`, and the field must stay because `workflowModelInputSchema` is strict (`workflow-contract.ts:26`), so removing the field would make `provider-codex`'s input fail validation.
- `authorized(context, input.providerId)` in `workflow-service.ts:29-34` keeps working unchanged (it now always means `provider-codex`). The caller-denial message and code are unchanged.
- The HTTP guard in `hub.ts` `handle` stays: a request carrying `x-omnyo-workflow-token` on the Claude route still gets HTTP 403 and never reaches `forwardWorkflow`.
- `validatePooledWorkflowAllowance` keeps a provider guard as cheap defense in depth at the spend boundary, with a provider-neutral message (see step 3g).
- All Codex workflow behavior is unchanged: validation, the pool-or-native decision, lease capacity and expiry, single-use capabilities, allowance verification, transport filtering, timeout and cancellation codes.

*What disappears.* `CLAUDE_WORKFLOW_UNAVAILABLE`, every `providerId === "claude-code"` branch, `claudeDenial`, the `provider` parameter of `hub.hasWorkflowAccounts`, `hub.workflowAccount` and `hub.forwardWorkflow`, the codex/claude mappings at `hub.ts:911` and `:1034`, and the Claude branch of the test stream fixture.

*Contract changes, stated exactly.*

- `poolWorkflowContract` and `workflowHostContract` input: `providerId: "codex" | "claude-code"` becomes `providerId: "codex"`. A `claude-code` request now fails RPC input validation (`invalid_input`) instead of returning `{ available: false, code: "allowance_unavailable", message: CLAUDE_WORKFLOW_UNAVAILABLE }` or the matching `ok: false` result. No public build sends such a request (facts 1 to 4). A hypothetical old or forked `provider-claude-code` that still forwards would hit its own `catch` (as the pre-`a632243bf9` code did) and return `allowance_unavailable` from capabilities or `request_failed` from complete, with its own message. The workflow stays unavailable either way. This difference is accepted, not hidden.
- The 403 body for a workflow token on the Claude route changes from `CLAUDE_WORKFLOW_UNAVAILABLE` to the existing neighbouring message "Workflow capabilities only allow text inference." The status code stays 403. No supported client sends that request.
- `validatePooledWorkflowAllowance` error message for a non-Codex account changes; that path is unreachable (see the reachability argument).

*Why this is the simplest sufficient option.* It deletes branches and one parameter. It adds no layer. The alternative of keeping the enum and only removing duplicated messages would keep the dead concept.

*Non-goals.* Do not touch `provider-claude-code`, State Machines' Claude binding (a separate product question), the Claude chat routing in Account Pooler, RF-030's shared base schema, or RF-058's legacy-account layer.

*Remaining uncertainty.* Hypothesis: no install pairs a bundled `account-pool` from after this change with a `provider-claude-code` from before `a632243bf9`. Bundled plugins ship together, so this needs a marketplace-updated `account-pool` on a private build older than 2026-11-24 09:28. Even then the user-visible result stays "unavailable".

**Expected gain and cost**

- **Production code (projection from the site list, counting each branch body, its import and the blank line after it):** about 45 to 55 lines removed and 0 to 3 added. By file: `workflow-service.ts` about 12, `hub.ts` about 10, `native-workflow-eligibility.ts` about 10, `workflow-cli.ts` about 9, `workflow-transport.ts` about 7, `workflow-allowance.ts` about 2 to 4, `workflow-contract.ts` about 3, `host.ts` 0 to 1. The formatter may reflow a few lines.
- **Tests and fixtures (projection):** about 125 lines removed, and one assertion rewritten. `workflow-service.test.ts:109-154` (46 lines); `workflow-hub.test.ts:241-250` and the `CLAUDE_WORKFLOW_UNAVAILABLE` import (about 11); `native-workflow-eligibility.test.ts:83-95` (about 13); `workflow-allowance.test.ts:25-31` and `:68-78` (about 19); the Claude branch of `fixtures/workflow-stream.ts:69-100` plus its `providerId` parameter (about 34).
- **Mechanisms:** before, the Claude workflow refusal lived in `provider-claude-code` plus nine Account Pooler sites, with two copies of the message. After, it lives only in `provider-claude-code`. The hub workflow API goes from provider-generic with one real value to Codex-specific. One HTTP guard remains.
- **Maintenance example:** changing the Claude workflow refusal copy or code today touches `provider-claude-code` and seven Account Pooler source files and four test files. Afterwards it touches only `provider-claude-code`.
- **Performance:** neutral. The removed checks are constant-time comparisons.
- **Cost:** a small contract narrowing documented above. No data, persisted format, UI or migration is involved.

**Execution steps**

1. **Reconfirm the snapshot and the caller set.** In a worktree on current `main` (repository root `$OMNYO_CHECKOUT`), run:
   - `git grep -n -E "claude-code|CLAUDE_WORKFLOW_UNAVAILABLE" -- plugins/account-pool/src` and compare with the table in "Context and evidence".
   - `git grep -n -E "pluginId: \"account-pool\"" -- plugins apps packages` and confirm that only `plugins/provider-codex/src/workflow-model-service.ts` calls `workflowModelCapabilities` or `workflowModelComplete`.
   - `sed -n 1,50p plugins/provider-claude-code/src/workflow-model-service.ts` and confirm it does not call Account Pooler.
   - `rg -n "workflowModel|account-pool" $OMNYO_PLUGIN_CHECKOUT --glob '!node_modules' --glob '!**/dist/**'` and confirm no private plugin calls Account Pooler's workflow RPCs.
   - **Stop and re-plan** if `provider-claude-code` (or any other plugin) calls `account-pool` with `providerId: "claude-code"`, or if someone has restored Claude workflow support in Account Pooler.
   - If RF-030 has landed, the base schemas come from `@omnyo/plugin-sdk/workflow-model`; the edits below still apply to the pool-only lines.
2. **Baseline.** Run the targeted account-pool tests once (commands under "Verification") and record the result, so pre-existing failures are not attributed to this change.
3. **Edit by file and symbol.** Make all edits in one commit; each file compiles only once the contract is narrowed.
   - a. `plugins/account-pool/src/workflow-contract.ts`: change `workflowProviderSchema` (line 85) to `z.literal("codex")`. Delete `CLAUDE_WORKFLOW_UNAVAILABLE` (lines 134-135) and its blank line. `PoolWorkflowInput["providerId"]` becomes `"codex"`.
   - b. `plugins/account-pool/src/workflow-service.ts`: remove the `CLAUDE_WORKFLOW_UNAVAILABLE` import (line 8), the `claudeDenial` constant (lines 74-77), and the two `if (input.providerId === "claude-code")` returns (lines 87-88 and 122-123). Keep `authorized`, `denial`, `validate`, `hasConfiguredPool` and both catch blocks unchanged. Change `hub.hasWorkflowAccounts("codex")` to `hub.hasWorkflowAccounts()` and `hub.workflowAccount("codex", context.experimental_signal)` to `hub.workflowAccount(context.experimental_signal)`.
   - c. `plugins/account-pool/src/workflow-cli.ts`: remove the import (line 18) and the early return in `completeWorkflowCli` (lines 380-386).
   - d. `plugins/account-pool/src/workflow-transport.ts`: remove the import (line 4) and the two throws in `workflowRequest` (lines 28-29) and `inspectWorkflowResponse` (lines 203-204). Keep the `input` parameters: they still supply `model`, `prompt` and `maxOutputBytes`.
   - e. `plugins/account-pool/src/native-workflow-eligibility.ts`: replace the import block (lines 6-9) with `import type { WorkflowModelCapabilities } from "./workflow-contract.js";`. Delete the `NativeInput` type (line 11) and the early return (lines 249-254). Change the signature to `nativeWorkflowEligibility(signal: AbortSignal): Promise<WorkflowModelCapabilities>`. In `plugins/account-pool/src/host.ts:9-10`, change the handler to `workflowModelCapabilities: (_input, context) => nativeWorkflowEligibility(context.signal)`. The host contract still validates the input.
   - f. `plugins/account-pool/src/hub.ts`:
     - Remove `CLAUDE_WORKFLOW_UNAVAILABLE` from the import (line 7).
     - In `handle` (lines 389-399), fold the Claude guard into the existing condition: `if (provider !== "codex" || request.method !== "POST" || routePath !== "/v1/responses") return adapter.errorResponse(403, "Workflow capabilities only allow text inference.");`, then `return this.forwardWorkflow(request, workflowCapability);`. TypeScript narrows `provider` to `"codex"` after the guard. Keep the guard before any lease lookup.
     - `hasWorkflowAccounts(): Promise<boolean>`: delete line 857 and filter on `account.provider === "codex"`.
     - `workflowAccount(signal: AbortSignal): Promise<Account>`: delete line 868; use `"codex"` in both provider filters (lines 877 and 893).
     - `prepareWorkflow`: delete line 911 and call `this.workflowAccount(signal)`.
     - `completePrediction`: drop the `"codex"` argument (line 1002).
     - `forwardWorkflow(request, capability, validateSource?)`: drop the `provider` parameter (line 1024), use `this.adapter("codex")` at line 1027, and delete the lease-provider clause at line 1034, keeping the `!this.accepting`, missing-lease and aborted-lease checks and the 401 response.
   - g. `plugins/account-pool/src/workflow-allowance.ts`: remove the import (line 3). Replace lines 36-37 with `if (account.provider !== "codex") throw new Error("Workflow inference requires a Codex subscription.");`. This keeps the spend-boundary guard without the Claude-specific constant. (Deleting the guard outright is also correct, because `includedWorkflowQuota` and `codexAllowance.parse` already enforce it; choose the guard if in doubt.)
   - **Checkpoint:** `pnpm -C plugins/account-pool typecheck` must pass before touching tests.
4. **Prune tests and fixtures, preserving unique obligations.**
   - `plugins/account-pool/src/workflow-service.test.ts`: delete the test "rejects Claude workflow without checking a pool account or dispatching to the host" (lines 109-154). In "rejects client, wrong provider and wrong routed model before dispatch", replace the `providerId: "claude-code"` assertion (lines 164-170) with `await expect(harness.callRpc("workflowModelCapabilities", { hostId: input.hostId, model: input.model, providerId: "claude-code" }, principal)).rejects.toMatchObject({ code: "invalid_input" });`. That keeps "wrong provider is refused before dispatch" coverage at the new boundary. The fake host rejects invalid input with `code: "invalid_input"` (`packages/plugin-sdk/src/testing/__tests__/fake-plugin-host.test.ts:795-800`). Keep the trailing `account` and host-call assertions.
   - `plugins/account-pool/src/workflow-hub.test.ts`: delete "refuses Claude workflow leases even with accounts configured" (lines 241-250) and the `CLAUDE_WORKFLOW_UNAVAILABLE` import (line 13). **Keep** "does not use a Claude account when it is the only enabled account" (lines 330 onward): it checks the Codex account filter. Update any `hub.workflowAccount` or `hub.hasWorkflowAccounts` calls in tests to the new signatures (none were found at the snapshot).
   - `plugins/account-pool/src/native-workflow-eligibility.test.ts`: delete "reports Claude workflow as unavailable without native allowance probing" (lines 83-95). At the snapshot that test holds the file's only `nativeWorkflowEligibility` call (`git grep` shows the import at line 4 and the call at line 85), so also drop `nativeWorkflowEligibility` from the import at line 4. If a newer revision has other calls, change them to `nativeWorkflowEligibility(signal)`.
   - `plugins/account-pool/src/workflow-allowance.test.ts`: replace the Claude case (lines 68-78) with one case asserting that `{ provider: "claude", subscriptionType: "max" }` with Codex-shaped data throws "Workflow inference requires a Codex subscription." if step 3g kept the guard; otherwise delete it. Delete the `claude()` fixture (lines 25-31) either way.
   - `plugins/account-pool/src/fixtures/workflow-stream.ts`: remove the `providerId` parameter and the Anthropic-shaped event branch (lines 69-100); keep the Codex events. Update the callers at `workflow-cli.integration.test.ts:77` (`syntheticStream()`), `workflow-hub.test.ts:96` (`syntheticStream(responseText)`) and `workflow-transport.test.ts:132`, `:144`, `:170`, `:222` (`syntheticStream()`).
5. **Remove leftovers.** Run `git grep -n -E "claude-code|CLAUDE_WORKFLOW_UNAVAILABLE|claudeDenial" -- plugins/account-pool/src/workflow-* plugins/account-pool/src/native-workflow-eligibility* plugins/account-pool/src/fixtures plugins/account-pool/src/host.ts`. Expect only the rewritten `invalid_input` test case. Search `plugins/account-pool` docs and skills for a statement that Account Pooler refuses Claude workflows (`git grep -n -i "claude workflow" -- plugins/account-pool docs`; none was found at the snapshot) and update any that appear.
6. **Format and review.** Format the changed files with the repository formatter (`pnpm exec oxfmt <files>` from the repository root; the root script is `"format": "oxfmt ."`), then inspect the full diff: only the files named above should change.

**Verification and acceptance criteria**

Commands (scripts confirmed in `plugins/account-pool/package.json:33-36` and the root `package.json:36-40` at the snapshot; run after `pnpm install` in the worktree):

- `pnpm -C plugins/account-pool test -- src/workflow-service.test.ts src/workflow-hub.test.ts src/workflow-transport.test.ts src/native-workflow-eligibility.test.ts src/workflow-allowance.test.ts src/composer-predictions.test.ts` — all pass. `workflow-cli.integration.test.ts` is skipped unless `OMNYO_WORKFLOW_CLI_PROBE=1` (its line 27); run it with that variable on a machine with the Codex CLI installed if available, otherwise report it as not run.
- `pnpm -C plugins/account-pool typecheck` — passes.
- `pnpm -C plugins/account-pool lint` — passes.
- `pnpm -C plugins/provider-codex test -- src/workflow-model-service.test.ts` and `pnpm -C plugins/provider-claude-code test -- src/workflow-model-service.test.ts` — pass unchanged (they do not import Account Pooler, but they prove the provider contracts were not touched).
- `pnpm check:plugin-forks` from the repository root — passes (no sibling-plugin import was added).
- `pnpm exec oxfmt --check <changed files>` from the repository root — clean.

Behavior that must hold:

- Codex capabilities: `available: true` with a configured pool, native host delegation without one, and `allowance_unavailable` with the thrown message on validation failure. Existing `workflow-service.test.ts` cases cover these.
- Codex completion: pool route with a single-use capability, native route, `cancelled`, `timeout` and `allowance_unavailable` codes. Existing `workflow-service.test.ts` and `workflow-hub.test.ts` cases cover these, including the lease "rechecks %s at actual dispatch" cases.
- A Claude account in the store is never leased for a workflow or prediction (`workflow-hub.test.ts:330`).
- A wrong-provider request is refused before any account lookup or host dispatch (the rewritten `invalid_input` assertion).
- A workflow token on the Claude HTTP route still returns 403. No test covers this at the snapshot. Add one small case to `workflow-hub.test.ts` that sends a request with `x-omnyo-workflow-token` to the hub's Claude route and expects status 403 and no upstream call, because this card edits that guard.

Structural completion: no `claude-code` or `CLAUDE_WORKFLOW_UNAVAILABLE` remains in Account Pooler's workflow files; `hasWorkflowAccounts`, `workflowAccount` and `forwardWorkflow` take no provider argument; the Claude workflow refusal exists only in `plugins/provider-claude-code/src/workflow-model-service.ts`. Recount removed lines with `git diff --stat main -- plugins/account-pool/src` and report production and test lines separately.

No UI, persisted data or performance-sensitive path is affected, so no visual or benchmark check is needed.

**Rollback and stop conditions**

- The change is one commit confined to `plugins/account-pool`. Reverting that commit restores the previous behavior exactly. No data, settings or migration is involved.
- Stop and re-plan if step 1 finds any caller of the pool workflow RPCs with `providerId: "claude-code"`, a plan to restore Claude workflow support through Account Pooler, or a non-bundled distribution channel that pairs a new `account-pool` with a `provider-claude-code` older than 2026-11-24 09:28 and must keep the structured refusal. In that last case, the safer smaller alternative is to keep `workflowProviderSchema` as the enum and the single refusal in `workflow-service.ts`, and delete only the host, transport, hub and allowance branches, which stay unreachable either way.
- Stop if the narrowed schema breaks `provider-codex`'s calls (for example, if RF-030 changed the base schema to non-strict or renamed `providerId`); reconcile with RF-030 first.
