# RF-058 — Retire Account Pooler's Claude-subscription compatibility layer (legacy-account guards, the retired-thread route family, parent-pool env clearing, stub sign-in RPCs and the core Sentry string match) behind one data reconciliation

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Potential:** medium. The change removes one whole concept from Account Pooler: "a Claude account or thread that belongs to the retired subscription pool". About 240 handwritten production lines across 10 files in three packages go. Every future change to Claude routing, env contribution, account status or account mutation would otherwise have to keep that concept in mind.
- **Confidence:** high for the facts. Every span below was re-read at the snapshot and counted mechanically. Confidence is medium that the data and version gates will pass on every supported install, because nobody has checked the installs yet.
- **Readiness:** decision-needed. The layer is two days old. It deliberately protects persisted legacy data and older nested servers, so it is not dead code yet. Retiring it needs four owner decisions (D1 to D4 below) and one data check (Gate A).
- **Effort:** 1 to 2 hours for Gate A. About 1 working day for the code change, the reconciliation function, its test and the doc updates.
- **Risk:** moderate. The affected contracts are persisted account rows and secrets, the persisted `retry-route:<threadId>` KV values, the env contract with older parent Account Pooler servers, two plugin RPC methods, and core crash-report filtering. Deleting the account rows cannot be undone, so it needs the owner's authorization (D1).
- **Prerequisites:** decisions D1 to D4 and Gate A, all described under "Execution steps".
- **Related and overlapping:**
  - RF-121 (remove Account Pooler's unreachable Claude workflow branches) works on the same retirement aftermath, but in `workflow-*.ts`. None of the symbols in this card are in those files (`git grep isLegacyClaudeAccount` finds no workflow file). The two plans are independent. Count no shared lines.
  - RF-120 (define the provider-retry availability contract once) touches `retryAvailability` in `plugins/account-pool/src/server.ts`. This card only narrows `retryRouteSchema` next to it. Land them in separate commits.
  - Gate B of the sweep report (the Anthropic unified rate-limit header parser) is **not** part of this card. See "Out of scope" under the proposed end state.
- **Why it deserves its place:** the layer is spread across `contracts`, `store`, `hub`, `server`, `rpc`, the settings UI, the usage source, the Account Usage plugin and the core server. Its knowledge is also duplicated across the plugin boundary: the core server matches the plugin's exact 409 message text. Removing the layer is one well-bounded upgrade-window decision. After it, Claude has one meaning in Account Pooler: a pooled Anthropic API key.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The read-only worktree named in the task had been removed, so every read used `git show <commit>:<path>` and `git grep <commit>` from `$OMNYO_CHECKOUT`. History from before the public squash came from `$ARCHIVED_OMNYO_CHECKOUT`. No tests were run, because the snapshot has no `node_modules`. All facts below are **Proven by inspection** unless another label is given.

*What the subsystem is.* Account Pooler (`plugins/account-pool`, plugin id `account-pool`, bundled through `packages/bundled-plugins/package.json`) runs a local HTTP hub. It routes Claude Code and Codex requests through pooled accounts. On 2026-11-24, private commit `e4dd1bb9c2` "Retire Claude subscription credentials from Account Pooler" removed Claude OAuth (subscription) sign-in. The commit touched 51 files with 5,760 deletions. Private commit `1369941608` did the same for Account Usage. Claude pooling is now API-key only. Several kinds of state can still exist on an install that ran an earlier build, so a compatibility layer handles them:

1. Account rows with `provider: "claude"` and `kind: "oauth"`, stored in the plugin KV key `accounts:v1` (`plugins/account-pool/src/store.ts:35` `ACCOUNTS_KEY`), together with their per-account secrets.
2. Threads whose `retry-route:<threadId>` KV value is `"claude"`. Builds before the retirement wrote that value for every Claude-routed thread. Current builds write `"claude-api-key"` (`server.ts:280` `claudeApiKeyRoute`, `server.ts:472-475`).
3. Affinity bindings that point at a legacy account. These expire after 65 idle minutes (`hub.ts:135` `AFFINITY_IDLE_TTL_MS`).
4. Nested Omnyo servers whose parent server runs an Account Pooler build from before the retirement. Such a parent injects `ENABLE_PROMPT_CACHING_1H` and `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL`. The search `git grep -n -E 'ENABLE_PROMPT_CACHING_1H|_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL' e9e1b74c3` finds only the clearing code in `server.ts:369-370` and a test, so no current build sets them.
5. Older callers of the removed sign-in RPCs.

*Support boundary.* The public repository's root commit `060950255` "Publish Omnyo source" (2026-11-24 11:16 -0500) is later than `e4dd1bb9c2` (09:30 the same day). An install built only from public source therefore never created states 1 and 2. They can exist only where a private build from before 2026-11-24 09:30 ran on the same data directory: the owner's machines, and possibly the approved worker clones on a connected MacBook. It is a **Hypothesis** that nobody else received a private build. D3 asks Alex to confirm it. No current code path creates a Claude OAuth row: `operations.ts:125` `addCodexOAuth` is the only caller of `saveLogin` (`operations.ts:158`), and it passes `provider: "codex"`.

*The layer, by file.* The table lists line spans that disappear in full. Small condensed conditions and imports are counted separately below the table.

| File | Symbols and lines | Role |
|---|---|---|
| `plugins/account-pool/src/contracts.ts` | 161-168 `CLAUDE_POOL_THREAD_RETIRED`, `isLegacyClaudeAccount`; 378-391 `loginStartSchema`, `loginCompleteInputSchema` | message, predicate, stub RPC schemas |
| `plugins/account-pool/src/rpc.ts` | 110-117 contract entries and 183-188 handlers for `"login.start"` and `"login.complete"`, which always throw `CLAUDE_POOL_LOGIN_RETIRED` | stub RPCs |
| `plugins/account-pool/src/store.ts` | 115-120 `listRoutable` (filters out legacy rows); 169-170 `setEnabled` guard; 286-287 `readSecret` guard; 320-322 `storeSecret` guard | store guards |
| `plugins/account-pool/src/hub.ts` | 279-299 `hasClaudeApiKeyAffinity`; 1565 legacy filter in `status().enabledAccountCount`; 1578-1582 and 1607-1610 status overrides (forced `enabled: false`, `status: "disabled"`, retired error); 1650-1654 `candidateIds` legacy filter; 1678-1699 retired-affinity and legacy-only checks returning `adapter.errorResponse(409, CLAUDE_POOL_THREAD_RETIRED)` in `forward` | hub guards |
| `plugins/account-pool/src/server.ts` | 92 `RETIRED_CLAUDE_PATH`; 367-383 `legacyClaudeOverrides`; 391 and 504 its spreads; 394-417 `canKeepOldClaudeRoute`; 419-444 `retiredClaudeEntries`; 462-470 retired branch in `contributeFor`; 623-635 the `/retired-claude-pool/*` 409 routes | retired route family and env clearing |
| `plugins/account-pool/src/usage-source.ts` | 76 and 93 legacy filters | usage-source guards |
| `plugins/account-pool/app.tsx` | 486, 500, 1701, 1709 `disabled={… isLegacyClaudeAccount(account)}`; 1737-1741 retired notice | UI disabled states |
| `plugins/account-usage/server.ts` | 343-347 `refreshAccount` Claude-OAuth branch; 370-377 `signInFinish` (constant error) | Account Usage stubs |
| `plugins/account-usage/contract.ts` | 187-196 `signInFinish` contract entry | stub RPC |
| `apps/server/src/services/threads/provider-error-reporting.ts` | 28-30 `RETIRED_CLAUDE_POOL_ERROR`; 115-119 its clause in `captureActionableProviderFailures` | core crash-report filter |

*A consumer the sweep missed.* The last row is a core-server consumer outside the plugin. `RETIRED_CLAUDE_POOL_ERROR` is a hand-copied string. A `python3 -I` comparison confirmed it equals `"API Error: 409 " + CLAUDE_POOL_THREAD_RETIRED`. The core server uses it to keep retired-pool 409s out of crash reports. It is covered by `apps/server/test/services/threads/provider-error-reporting.test.ts:105` "excludes the retired Claude pool response while reporting other conflicts". The core server's knowledge of a plugin's message text is exactly the coupling `docs/forkable-plugins.md` discourages. It goes away with the layer. Its helper `loadFailedTurnErrorMessage` stays, because `plugin-service.ts:1624` and `thread-continue.ts:164` also call it.

*Corrections to the sweep report.*

- **The CLI branch is not compatibility code.** `cli.ts:280-283` rejects `omnyo pool account add --provider claude --login` with the code `claude_pool_login_retired`. It validates a flag combination that users can still type, whatever their stored data. Keep it, and keep `CLAUDE_POOL_LOGIN_RETIRED`, which it and the `claude-adapter.ts:45` credential-kind guard still use.
- **The `"claude"` route value stays readable until the reconciliation removes it.** `server.ts:282-284` `retryRouteSchema` accepts `"claude"`. After the reconciliation it can drop `"claude"`, so the schema accepts exactly the values that current code writes. The persisted value `"claude-api-key"` stays.
- **The performance cost was overstated.** The `threads.events.list` lookup in `canKeepOldClaudeRoute` (`server.ts:402`) runs only for threads whose stored route is `"claude"`. Every other Claude env contribution pays one `isRoutingEnabled` check and one `kv.get(routeKey)` (`server.ts:465-466`).
- **`signInFinish` and the two `login.*` RPCs have no current caller.** `git grep -n -E '"login\.(start|complete)"' e9e1b74c3` finds the Account Pooler definitions and their test (`account-login.test.ts:255,262`). Connect and Omnyo Account also define `login.start`, but on plugin id `omnyo-account` (`plugins/connect/src/account-client.ts:4`). In Account Usage, `signInFinish` appears only in `server.ts`, `contract.ts` and `components/account-repair.test.tsx:118,196`. The components call only `signInStart` and `signInPoll` (`account-repair.tsx:87,130`). Old callers did exist: before `1369941608`, Account Usage `server.ts:350,377` called `login.start` and `login.complete`, and before `e4dd1bb9c2` the Account Pooler `app.tsx:1218,1810` did. Both plugins ship bundled with the server, so only a stale browser tab or a forked older plugin could still call these methods. After removal, such a caller gets an unknown-method error instead of the friendly retired message.

*Designed behavior that is not a defect.* After the 65-minute affinity TTL, a thread still marked `"claude"` is always sent to the retired route, even if it had actually used an API key. `docs/configuration.md:1853-1854` documents this: "Use bypass to continue a chat with Claude Code's sign-in if Account Pooler cannot confirm that the chat previously used an API key."

*Tests that encode the current contract.*

- `plugins/account-pool/src/account-login.test.ts:202` "retires saved Claude OAuth without opening its secret or changing native authentication" and `:399` "blocks a historical nested Claude route without asking the parent to choose an account". Together they cover about 270 lines (202-471). The legacy fixture `RETIRED` is at 182-195.
- `plugins/account-pool/app.test.tsx:492` "keeps the retired Claude account visible with recovery and removal".
- `plugins/account-usage/components/account-repair.test.tsx:195-204`, the `signInFinish` and `refreshAccount` assertions.
- `apps/server/test/services/threads/provider-error-reporting.test.ts:105-155`.
- `plugins/account-pool/src/store.test.ts:37` "loads account metadata written before account UUIDs were stored". It uses a Claude OAuth row only as a persisted-format fixture. It is not a compatibility test, and its parse obligation must survive.

*Maintenance cost today.* Any edit to Claude routing has to keep two Claude route meanings consistent across `server.ts`, `hub.ts` and the core server. So does any edit to account status, account mutation, usage-source listing or Claude Code env contribution. Each has to answer "what if this is a legacy OAuth account, a `"claude"`-marked thread, or an older parent pool?"

**Proposed end state and preservation argument**

*What disappears.* Everything in the table except the CLI branch: the predicate `isLegacyClaudeAccount` and all 14 call sites, `CLAUDE_POOL_THREAD_RETIRED`, `listRoutable`, `hasClaudeApiKeyAffinity`, `legacyClaudeOverrides`, `canKeepOldClaudeRoute`, `retiredClaudeEntries`, `RETIRED_CLAUDE_PATH` and its routes, the `login.start` and `login.complete` RPCs and schemas, Account Usage `signInFinish` and the Claude-OAuth branch of `refreshAccount`, the four UI `disabled` conditions and the retired notice, and the core `RETIRED_CLAUDE_POOL_ERROR` clause.

*What replaces it.* One idempotent startup reconciliation. It turns the legacy state into ordinary current state, and the rest of the code stops knowing about it. Place it in a new module `plugins/account-pool/src/legacy-claude-retirement.ts` and call it from `server.ts` activation once `accounts`, `operations` and `routing` exist, before `api.providers.experimental_contributeEnv` and the HTTP routes are registered:

```ts
const DONE_KEY = "migration.legacy-claude-oauth-retired:v1";

export async function retireLegacyClaudeState(deps: {
  kv: PluginKvStorage;
  accounts: AccountStore; // list()
  operations: PoolOperations; // remove(id): account row, secret, rejected-refresh key, quota row
  routing: RoutingStore; // setBypassed(threadId, true)
}): Promise<void> {
  if ((await deps.kv.get(DONE_KEY)) === true) return;
  for (const account of await deps.accounts.list())
    if (account.provider === "claude" && account.kind === "oauth")
      await deps.operations.remove(account.id); // D1
  for (const key of await deps.kv.list("retry-route:"))
    if ((await deps.kv.get(key)) === "claude") {
      await deps.routing.setBypassed(key.slice("retry-route:".length), true); // D2 (recommended option)
      await deps.kv.delete(key);
    }
  await deps.kv.set(DONE_KEY, true);
}
```

`operations.remove` (`operations.ts:241`) already deletes the account row, its secret, its rejected-refresh key (`store.ts:155-163`) and its quota row (`quotas.remove`). `RoutingStore.setBypassed` (`store.ts:654`) is the existing per-thread bypass that `omnyo pool bypass` uses. `kv.list(prefix)` is part of the plugin KV API, as `store.ts:669` and `packages/plugin-sdk/src/testing/__tests__/fake-plugin-host.test.ts:276` show.

*Owner decisions.*

- **D1 (data deletion; needs the owner's authorization).** Approve permanently deleting legacy Claude OAuth account rows and their stored credentials. Those credentials can no longer serve any request (`store.ts:286` refuses to read them). The rows keep only labels, priority and history.
- **D2 (old `"claude"` threads).** Choose what happens to a thread that still carries the pre-retirement marker:
  - (a) **Recommended:** bypass it. Its next turn then uses the machine's own Claude Code sign-in. This is the first remedy the current 409 message offers, and it never moves a subscription conversation onto paid API billing without the user's consent.
  - (b) Delete the marker. The thread then routes through pooled Anthropic API keys, which changes who pays for that conversation, silently.
  - (c) Keep the retired route family. About 95 lines stay in `server.ts` and about 25 in `hub.ts`.

  Today the user sees a 409 telling them to bypass. With (a), the thread continues on the local Claude Code sign-in, and if that sign-in is missing, Claude Code reports its own authentication error. That difference is a visible UX change for old threads, so Alex has to choose.
- **D3 (support window).** Confirm the support boundary: only installs that ran a private build from before 2026-11-24 09:30 can hold legacy state. Also confirm that no supported nested setup runs under a parent Omnyo server older than that. The env clearing in `legacyClaudeOverrides` protects only that parent-version skew. It does not depend on local data, and the reconciliation cannot replace it.
- **D4 (RPC surface).** Accept removing the Account Pooler `login.start` and `login.complete` methods and the Account Usage `signInFinish` method. This decision needs no data gate and can ship on its own.

*Preservation.*

- Codex OAuth sign-in, Claude and Codex API-key pooling, bypass, failover, quota, affinity and retry availability are unchanged for every current account and thread.
- The CLI `--provider claude --login` error (`claude_pool_login_retired`) is kept.
- Accounts whose provider is Claude and kind is `"api-key"` already pass every guard today. Removing the guards changes nothing for them.
- `status().enabledAccountCount` and `accounts[].status` give the same values for every non-legacy account.
- After the reconciliation, no legacy row exists, so the removed `enabled: false` override has nothing to act on.
- In the UI, the Enable and Refresh usage controls keep exactly the `pending` disabled state they already have. The retired notice had nothing left to describe. No layout, copy or styling changes for current accounts.
- The persisted `accounts:v1` schema (`accountSchema`, which is `.strict()`) is unchanged. In particular `accountUuid` stays, so existing rows still parse.

*Reachability proof for the deletions.* Every removed guard acts only on an account where `provider === "claude" && kind === "oauth"`, on a KV route value of `"claude"`, or on an env var that only an older parent sets. After Gate A and the reconciliation, the first two cannot exist. No current code path creates them: Claude OAuth creation was removed in `e4dd1bb9c2`, and `addCodexOAuth` is the only OAuth writer. D3 covers the third. The `/retired-claude-pool/*` routes are reachable only through `ANTHROPIC_BASE_URL` values that `retiredClaudeEntries` handed out. One uncertainty remains (**Hypothesis**): a Claude Code process spawned with the retired base URL that keeps running across the server upgrade would get a 404 instead of the friendly 409. Fresh spawns get the new env.

*Non-goals.* Renaming the persisted `"claude-api-key"` route value. Removing `accountUuid`, `subscriptionType` or `rateLimitTier` from `accountSchema`. Changing the CLI. Changing the native Claude profile routing (`native-claude-routing.ts`, which has no legacy references).

*Out of scope: the sweep's Gate B.* The sweep proposed deleting the Anthropic unified rate-limit header parser (`quota.ts:65-178` `scopedHeaderValues` and `quotaFromHeaders`, and the unified-header part of `isQuotaRejection` at 455-469). The idea behind it is a **Hypothesis**: that API-key responses never carry `anthropic-ratelimit-unified-*` headers. No live response was captured. That parser also feeds persisted SQLite quota columns (`store.ts:726-807`), selection logic (`quota.ts:354,384`) and two UIs (`app.tsx:373,1763`, `account-usage/lib/normalise.ts:155`). Removing it is therefore not compatibility cleanup. It would retire a quota model and needs its own opportunity, backed by evidence from one live pooled API-key response. This card counts none of its lines.

**Expected gain and cost**

- **Production lines removed (measured).** A Python span count over `git show` output of the snapshot found 227 lines in spans that disappear in full: contracts 22, rpc 14, store 13, hub 46, server 94, app 7, account-usage server 13, account-usage contract 10, core 8. About 10 import lines and about 9 lines from condensing conditions come on top (hub 1565, 1608-1610 and 1650-1654; app 486 and 500; usage-source 93). That makes about 240 to 250 lines removed in total.
- **Production lines added (projected).** The reconciliation module and its call take 25 to 35 lines. Replacing the 14 `listRoutable()` calls with `list()` adds no lines (`hub.ts:523, 541, 767, 859, 875, 888, 1052, 1069, 1297, 1449, 2262, 2983`, `operations.ts:368`, `server.ts:272`).
- **Net (projected).** About 205 to 225 production lines with D2 option (a). With option (c), about 120 fewer lines are removed.
- **Tests.** About 270 lines of `account-login.test.ts`, about 50 lines in the core test, and the `app.test.tsx:492` and `account-repair.test.tsx` legacy assertions go. A reconciliation test of about 60 to 90 lines replaces them.
- **Docs.** `docs/configuration.md:1853-1854` and `plugins/account-pool/skills/account-pool/references/accounts-and-routing.md:56-59` are updated. If the sweep's ISS-S15-02 (README) concerns the same retired text, it is fixed by the same edit.
- **Mechanisms, before and after.**

  | Measure | Before | After |
  |---|---|---|
  | Claude route meanings | two (`"claude"` legacy, `"claude-api-key"` current) | one |
  | Legacy-account guard sites | 14 across 6 files, plus 2 store-level filters | 0, with the state converted once at startup |
  | Plugin message text duplicated in core | 1 | 0 |
  | Retired HTTP routes | 3 | 0 |
  | Stub RPC methods | 3 | 0 |

- **Maintenance.** Today, a change to the Claude env contribution has to preserve the ordering between `retiredClaudeEntries`, `canKeepOldClaudeRoute`, `legacyClaudeOverrides` and the API-key path. A change to account status has to keep the `retired` overrides. Afterwards the Claude path is just "bypassed, or served by an API key, or neutralized".
- **Performance.** Neutral to slightly better (**Hypothesis**, not measured). One `kv.get` per Claude env contribution goes away. The reconciliation costs one `kv.list("retry-route:")` plus one `kv.get` per routed thread, once per install, and the `DONE_KEY` flag skips it after that.
- **Effort.** Gate A takes 1 to 2 hours. The code takes about 1 day.

**Execution steps**

1. **Reconfirm the baseline.** Check out current `main`. Re-run the anchor search below, then compare its hits with the table in "Context and evidence":

   `rg -n 'isLegacyClaudeAccount|CLAUDE_POOL_THREAD_RETIRED|RETIRED_CLAUDE|retired-claude-pool|hasClaudeApiKeyAffinity|legacyClaudeOverrides|canKeepOldClaudeRoute|retiredClaudeEntries|listRoutable|signInFinish|"login\.(start|complete)"' plugins/account-pool plugins/account-usage apps/server`

   Stop and re-plan in any of these cases: a new caller of `login.start` or `login.complete` on plugin id `account-pool` appears; a new code path writes a Claude OAuth account; current code writes `"claude"` as a route value again; or a current build sets `ENABLE_PROMPT_CACHING_1H` or `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL`.

2. **Gate A: decisions and data check. Do this before any code edit.**
   1. Ask the owner for D1 to D4, in one batch. If D1 is refused, stop. If D2 is (c), drop steps 5.3 and 5.4 and keep the retired route family.
   2. Data check, on each machine D3 names (the owner's machines and, if they are still in use, the worker clones on a connected MacBook). Both commands are read-only:
      - Run `omnyo --version` and record the build.
      - Run `omnyo pool account list --json` and count entries with `"provider": "claude"` and `"kind": "oauth"`.
      - To count `"claude"` thread markers, open that machine's Omnyo SQLite database read-only (find the data directory through `docs/configuration.md`) and run `SELECT key, value FROM plugin_kv WHERE plugin_id = 'account-pool' AND key LIKE 'retry-route:%';`, then count rows whose decoded value is `claude`. The exact encoding of the `value` column is unconfirmed; inspect one row first.
   3. Version-skew check: on every machine that runs nested Omnyo servers, confirm with `omnyo --version` that the outer server's build includes the retirement. Its build must be from after 2026-11-24, at or after public commit `060950255`.
   4. Record the counts in the PR description. Non-zero counts are expected and fine, because the reconciliation handles them. An outer server older than the retirement blocks step 5.5 until that server is upgraded.

3. **Checkpoint 1: RPC stubs (D4 only; ships independently).**
   - `plugins/account-pool/src/rpc.ts`: delete the `"login.start"` and `"login.complete"` contract entries (110-117), their handlers (183-188), and the `loginStartSchema` and `loginCompleteInputSchema` imports.
   - `plugins/account-pool/src/contracts.ts`: delete those two schemas (378-391).
   - `plugins/account-usage/contract.ts`: delete the `signInFinish` entry (187-196).
   - `plugins/account-usage/server.ts`: delete the handler (370-377). Keep the `SignInResult` import, because `signInPoll` still uses it.
   - Tests: remove the `login.start` and `login.complete` assertions in `account-login.test.ts` (around 255-271). Remove `signInFinish` from the harness map (`account-repair.test.tsx:118`) and its assertion (195-201).
   - Run the Account Pooler and Account Usage tests (see "Verification").

4. **Checkpoint 2: the reconciliation (D1 and D2).**
   - Add `plugins/account-pool/src/legacy-claude-retirement.ts` with `retireLegacyClaudeState`, following the pseudocode above. Await it in `server.ts` activation after `operations` and `routing` are built and before `api.providers.experimental_contributeEnv` (currently `server.ts:501`).
   - Add a test, for example `src/legacy-claude-retirement.test.ts`, or replace the two retired cases in `account-login.test.ts`. Reuse the `RETIRED` fixture (182-195) and the existing host harness. Seed four things:
     - one legacy Claude OAuth row with its secret at `accounts/account-<id>.json` and a quota row;
     - one Claude API-key row;
     - `retry-route:old-thread = "claude"`;
     - `retry-route:new-thread = "claude-api-key"`.

     Start the plugin and assert all of the following:
     - The legacy row, its secret and its quota row are gone.
     - The API-key row is unchanged.
     - `old-thread` is bypassed and its route key is deleted.
     - `new-thread` is untouched.
     - `DONE_KEY` is set.
     - A second start changes nothing.
   - Stop here and run the tests before you delete any guard.

5. **Checkpoint 3: delete the layer.**
   1. `store.ts`:
      - Delete `listRoutable` (115-120) and replace its 14 calls with `list()` (call sites listed under "Expected gain and cost").
      - Delete the guards at 169-170, 286-287 and 320-322.
      - Drop the `isLegacyClaudeAccount` import. Keep the `CLAUDE_POOL_LOGIN_RETIRED` import only if something in the file still uses it after the guards go.
   2. `hub.ts`:
      - Delete `hasClaudeApiKeyAffinity` (279-299).
      - In `status()`, make `enabledAccountCount` `accounts.filter((account) => account.enabled).length`. Remove `retired` and its three ternaries, so that `error: quota.error` and `status: accountStatus(account, quota, settings.switchThreshold, now)`.
      - In `forward`, make `candidateIds` `new Set(accounts.map((account) => account.id))` and delete the 1678-1699 block.
      - Remove the three imports at 44-46.
   3. `server.ts`:
      - Delete `RETIRED_CLAUDE_PATH`, `legacyClaudeOverrides` and its two spreads (391, 504), `canKeepOldClaudeRoute`, `retiredClaudeEntries`, the retired branch at 462-470 and the retired route registration at 623-635.
      - Drop the `CLAUDE_POOL_THREAD_RETIRED` import.
      - The surviving `contributeFor` body is unchanged apart from that branch.
   4. `server.ts:282-284`: narrow `retryRouteSchema` to `z.enum(["claude-api-key", "codex"]).transform((route) => (route === claudeApiKeyRoute ? "claude" : route))`.
   5. Delete `contracts.ts:161-168` (`CLAUDE_POOL_THREAD_RETIRED`, `isLegacyClaudeAccount`). Keep `CLAUDE_POOL_LOGIN_RETIRED`, which `cli.ts:281` and `claude-adapter.ts:45` still use.
   6. `usage-source.ts`: remove the filter at 76 and the `&& !isLegacyClaudeAccount(account)` at 93, and fix the import at 2.
   7. `app.tsx`:
      - At 486 and 500, change `disabled={pending || isLegacyClaudeAccount(account)}` to `disabled={pending}`.
      - At 1701 and 1709, delete the `disabled` props.
      - Delete 1737-1741.
      - Drop the imports at 87 and 89.
      - Change nothing else in the markup.
   8. `plugins/account-usage/server.ts`: delete the `refreshAccount` branch at 343-347. Its remaining Claude-subscription messages in `oauthAccount` (247-250) stay, because they also cover Claude API-key accounts.
   9. `apps/server/src/services/threads/provider-error-reporting.ts`: delete `RETIRED_CLAUDE_POOL_ERROR` and the `thread.providerId === "claude-code" && … === RETIRED_CLAUDE_POOL_ERROR` clause. Keep the `loadFailedTurnErrorMessage` import only if that file still uses it after the edit; other files use it, so keep its export in `turn-failed.ts`. Delete the test at `provider-error-reporting.test.ts:105`, but only after confirming the other tests in that file still cover 409 conflicts from other sources (it seeds "upstream" and "other provider" cases; move those assertions into a surviving test if no other test covers them).
   10. Tests:
       - Delete the two retired cases in `account-login.test.ts` (202-471) if step 4 did not already replace them, and `app.test.tsx:492`.
       - Update `account-repair.test.tsx:202-204`.
       - Keep `store.test.ts:37`, whose persisted-format obligation must survive. Its fixture may switch to a Codex OAuth row, as long as it still omits `accountUuid`.
   11. Docs:
       - `docs/configuration.md:1853-1854`: drop "if Account Pooler cannot confirm that the chat previously used an API key" and describe bypass plainly.
       - `accounts-and-routing.md:56-59`: drop the "Old Claude subscription pool entries remain visible…" sentences.
       - Read `$HOME/.agents/skills/marketing-copywriting/SKILL.md` before rewriting these.

6. **Final check.** Re-run the step 1 search. The only hits allowed are `listRoutable` (none), the CLI `claude_pool_login_retired` branch, `CLAUDE_POOL_LOGIN_RETIRED`, and the new reconciliation module and its test. Review the full diff for unrelated changes. Recount removed and added production lines against this card's baseline.

**Verification and acceptance criteria**

The commands below come from the package scripts at the snapshot: `test`, `typecheck` and `lint` in `plugins/account-pool/package.json` and `plugins/account-usage/package.json`, and `test` and `typecheck` in `apps/server/package.json`. The `--filter` forms below were not executed here.

- Run these from the repository root:
  - `pnpm --filter omnyo-plugin-account-pool test`, `pnpm --filter omnyo-plugin-account-pool typecheck` and `pnpm --filter omnyo-plugin-account-pool lint`.
  - `pnpm --filter omnyo-plugin-omnyo--account-usage test` and `pnpm --filter omnyo-plugin-omnyo--account-usage typecheck`.
- From `apps/server`, run `pnpm exec vitest run --config vitest.config.ts test/services/threads/provider-error-reporting.test.ts` and `pnpm typecheck`.
- Format and lint the changed files with the repository's Oxc tools: `pnpm exec oxlint --fix <files>`, `pnpm exec oxfmt <files>`, then `pnpm exec oxlint --deny-warnings --format=agent`. The root also has `pnpm format:check`.

Acceptance:

- **Reconciliation contract.** The step 4 test passes, including the second start that changes nothing. Existing tests for Codex OAuth sign-in, API-key routing, bypass, retry availability (`provider-retry` consumers) and the store's persisted format pass unchanged. Do not edit their assertions.
- **Routing.** A fresh Claude thread with an enabled API-key account still gets `ANTHROPIC_BASE_URL` set to the hub and `retry-route = "claude-api-key"`. A bypassed thread gets no env, or neutralized env under a parent. Existing `server.test.ts` cases cover both. The parent-pool neutralization case (`neutralized`) still clears `PROVIDER_ROUTING_ENV` names.
- **UI.** Alex checks the Account Pooler settings list and the account detail dialog for a Codex OAuth account and a Claude API-key account. The rows, menus and buttons must look and behave as before. No screenshot round is required beyond what Alex chooses.
- **Crash reporting.** Other 409 conflicts are still reported (the surviving `provider-error-reporting` tests).
- **Structure.** The step 6 search is clean. `isLegacyClaudeAccount` and `/retired-claude-pool` no longer appear anywhere in the repository.
- **Performance.** No benchmark is needed. Startup gains one bounded, one-time KV scan.

**Rollback and stop conditions**

- **Reversible boundary.** Ship the three checkpoints as separate commits. Reverting checkpoint 3 or checkpoint 1 restores the code. The reconciliation's effects are different: deleted legacy rows and secrets cannot be restored (D1 accepts this, and the credentials were already unusable). Bypass flags can be undone per thread with `omnyo pool bypass <thread-id> --off`. Rolling back the code after the reconciliation has run is harmless, because the restored guards simply find no legacy state.
- **Stop conditions.**
  - Alex refuses D1. Then keep the layer.
  - An outer server older than the retirement must stay supported. Then keep `legacyClaudeOverrides` (about 17 lines) and ship the rest.
  - Gate A finds legacy state on an install outside the D3 boundary. Re-confirm the support boundary with Alex.
  - A current code path is found that writes Claude OAuth rows or the `"claude"` route value. Re-plan.
  - A test outside the listed legacy cases fails because it relied on a guard. Investigate before editing that test.
- **Smaller alternatives.** Checkpoint 1 (D4) alone removes about 32 lines of stub surface with no data dependency. D2 option (c) keeps the thread-route family but still removes the account guards, the UI states and the core string match.
