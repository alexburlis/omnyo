# RF-009 — Replace the four copied host-local provider-usage source state machines with one Plugin SDK helper

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** Confirmed after an adversarial re-check.
- **Potential:** High. Four maintained copies of one cache, coalescing and inventory state machine become one.
- **Confidence:** High. The four production files differ only in their ownership predicate and description string (Proven by inspection, `diff` output below).
- **Readiness:** Ready. The one piece of counterevidence, a design note in `plugins/provider-usage/README.md`, is stale: the "copied contract" design it describes was already reversed when the contract moved into the SDK (see Context).
- **Effort:** Medium-small, roughly 0.5 to 1 day. That covers the SDK helper and its tests, four plugin call sites, the SDK version bump and SDK floor bumps, and the fork check.
- **Risk:** Low. The `provider-usage.v1` wire contract does not change. The realistic regressions are a wrong ownership predicate, a shared module-level cache instead of one per registration, a changed freshness or coalescing order, and description drift in `omnyo plugin rpc inspect`.
- **Prerequisites:** None. The helper ships in the next packed SDK version from this repository, and nothing has to be published externally.
- **Related and overlapping items:**
  - RF-001 (retire classic ACP): if it lands first, three call sites remain instead of four. The two items do not depend on each other in either order.
  - RF-072 (test the shared ACP protocol modules once) follows the same "test shared behavior once" pattern but covers different code.
  - RF-120 (provider-retry availability contract in the SDK) is an analogous SDK-owned contract and does not overlap.
- **Why it deserves its place:** This is a live state machine with four maintained copies. It has already drifted once: ACP Next uses `api.pluginId`, while the other three hard-code their plugin ids. Any change to freshness, error copy or measurement mapping currently needs four identical edits and four test edits.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The audit worktree for that snapshot was removed before this verification, so every file was read with `git -C $OMNYO_CHECKOUT show e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e:<path>`. The four production files and the SDK contract are byte-identical between that commit and `HEAD` 5f2d3f895 (checked with `cmp`).

*The subsystem.* Provider Usage (`plugins/provider-usage`) shows quota usage. It finds usage sources through RPC discovery: `plugins/provider-usage/server.ts` calls `api.sdk.plugins.experimental_discoverRpc({ method: usageListMethod })` around line 232, and then calls `provider-usage.v1.listResources` and `provider-usage.v1.getResource` on each source plugin. The wire contract is SDK-owned: `packages/plugin-sdk/src/provider-usage.ts:124-151` defines `usageListMethod`, `usageFetchMethod` and `usageSourceRpcContract` and exports them as `experimental_providerUsageSourceV1`, through the package subpath `./provider-usage` (`packages/plugin-sdk/package.json:22-27`). Four provider plugins each publish a host-local source. Each one adapts `api.sdk.system.usageLimits` to that contract.

| Plugin | File | Lines | Registered from |
|---|---|---|---|
| Codex | `plugins/provider-codex/src/usage-source.ts` "registerUsageSource" | 210 | `plugins/provider-codex/server.ts:10` |
| Claude Code | `plugins/provider-claude-code/src/usage-source.ts` "registerUsageSource" | 210 | `plugins/provider-claude-code/server.ts:7` |
| ACP | `plugins/provider-acp/src/usage-source.ts` "registerUsageSource" | 204 | `plugins/provider-acp/server.ts:45` |
| ACP Next | `plugins/provider-acp-next/src/usage-source.ts` "registerUsageSource" | 204 | `plugins/provider-acp-next/server.ts:48` |

Production total: 828 handwritten lines (`wc -l plugins/provider-{codex,claude-code,acp,acp-next}/src/usage-source.ts`). Tests: 258 + 268 + 260 + 273 = 1,059 lines in the matching `usage-source.test.ts` files.

*What each copy implements.* Line numbers below are from the Codex copy:

- `locatorSchema` (line 16) parses the resource id, a JSON `[hostId, providerId]` tuple. `metadataSchema` (18-21) and `windowMetadataSchema` (23-26) apply `.catch` tolerance for older providers.
- `load` (36-132) does the following:
  - It resolves the host and maps a 404 to `"Usage resource no longer exists."` (42-46).
  - It builds an `unavailable(message)` result that keeps the previous `accountKey` and `observedAt` (50-60).
  - It returns `"Machine is disconnected."` for a disconnected host (62-63).
  - It runs the ownership check against `api.sdk.providers.list({ hostId, capability: "usage" })` (65-78).
  - It applies the 60,000 ms freshness rule, which serves only cached `ok` results (80-86).
  - It collects through `api.sdk.system.usageLimits({ hostId, providerId, refresh })` (90-94).
  - It maps the measurement (101-121): window `id` `${index}:${label}`, `cost ?? null`, `observedAt` set only on `ok`.
  - It falls back to `"Usage could not be collected from this machine."` on any failure (126-127).
- `collect` (134-154) coalesces requests per resource. A forced refresh waits for a running non-forced read and then starts its own read.
- `api.rpc.register(usageSourceRpcContract, …)` (156-209) contains the `listResources` handler. It lists every host, lists the owned providers per host, builds resource rows with `scope: { kind: "host" }`, and prunes cache entries for resources that disappeared (195-197). The same call registers the `getResource` handler (201-202), `experimental_discoverable: true` and `experimental_description` (206-207).

*Differences between the copies.* Proven by inspection, from `diff` of each pair:

- Codex and Claude Code differ only at lines 74-75 and 173-174 (`provider.pluginId === "provider-codex" && provider.id === "codex"` against the claude-code literals) and at line 207 (the description).
- Codex and ACP differ only in the predicate and the description. ACP checks `provider.id === providerId && provider.pluginId === "provider-acp"` (ACP line 73) and filters with `provider.pluginId === "provider-acp"` (line 169), with no provider-id restriction. That difference is necessary: ACP providers are declared dynamically, custom agents included (`plugins/provider-acp/src/declaration.ts:87` "usage: agent.providerUsage === true").
- ACP and ACP Next differ only at lines 73 and 169, where ACP Next uses `api.pluginId` instead of the literal.

*Plugin ids.* The built-in ids match the literals (`apps/server/src/services/plugins/builtin-registry.ts:129-155`): `provider-codex`, `provider-claude-code`, `provider-acp`, and `omnyo--provider-acp-next` for ACP Next. Replacing the literals with `api.pluginId` therefore does not change built-in behavior. Each Codex and Claude Code manifest declares exactly one provider (`omnyo.experimental_providers` in `package.json`: `codex` and `claude-code` respectively).

*Tests.* Each test file contains the same three cases:

1. "publishes only its own maintenance providers…" covers ownership, the missing host, a foreign provider, the cache hit, forced refresh, the disconnected host and the removed resource.
2. "forwards validated provider-owned identity and normalization metadata…"
3. "coalesces concurrent reads and makes a forced refresh wait for a fresh collection".

The files are 0.91 to 0.96 similar pairwise (Python `difflib.SequenceMatcher` over lines, with 241 to 256 matching lines). The Codex and Claude Code tests use the fake host's default plugin id `"test-plugin"` (`packages/plugin-sdk/src/testing/fake-plugin-host.ts:736`). The ACP Next test passes `pluginId: "omnyo--provider-acp-next"`. No test covers the 60 s expiry or the error-without-previous-measurement path. The test suites were not run, because the snapshot has no `node_modules`.

*Searches for other consumers.* Command: `git grep -l experimental_providerUsageSourceV1 e9e1b74c3` over the whole repository, plus `git grep` for `provider-usage.v1`, `usageListMethod` and `registerUsageSource`.

- The only other source is `plugins/account-pool/src/usage-source.ts`. It is a shared-scope source with different logic and is out of scope.
- The only documentation mentions are `docs/api_to_audit.md:1257-1271` and the `plugins/plugin-api-docs/src/surfaces.ts:1156` export list.
- `rg` over `$OMNYO_PLUGIN_CHECKOUT` (the private plugins) finds no usage source.
- The registration functions are called only from each plugin's own `server.ts`. Nothing reads them by string id or through dynamic import.

*Counterevidence, and why it does not block.* `plugins/provider-usage/README.md:30-34` says the contract "is owned here and copied into each source; no additional adapter plugin, provider-kit helper, or core runtime convention is required." The history in the retired private repository shows where that wording came from. Commit `c7d2c7f593` (2026-09-14, #3449) chose "copied contracts. No shared schema package or core adapter". Commit `e635dd396c` (2026-11-24, "Share the Provider Usage v1 wire contract") then deleted the five copied `usage-contract.ts` files and moved the contract into `packages/plugin-sdk/src/provider-usage.ts`. The README sentence is therefore stale (Proven by inspection). The proposed helper is opt-in: other providers can still implement the contract by hand.

*Maintenance cost today.* Changing the freshness window, the disconnected-host copy, the window-id format or the measurement mapping takes four identical edits and four test edits. The copies have already drifted once (literal plugin ids against `api.pluginId`).

**Proposed end state and preservation argument**

*What disappears.* The four duplicated `load`, `collect`, list and fetch implementations disappear, together with their schemas (`locatorSchema`, `metadataSchema`, `windowMetadataSchema`) and their copied behavioral tests.

*What remains.* One SDK function sits beside the contract in `packages/plugin-sdk/src/provider-usage.ts`:

```ts
import type { PluginApi } from "@omnyo/plugin-sdk"; // type-only self-reference, as machine-provider.ts does

export function experimental_registerHostProviderUsageSource(
  api: PluginApi,
  options: {
    /** Exact registration description shown by `omnyo plugin rpc inspect`. */
    description: string;
    /** Restrict to these provider ids; omit to publish every usage-capable provider this plugin registers. */
    providerIds?: readonly string[];
  },
): void;
```

Ownership becomes `provider.pluginId === api.pluginId && (options.providerIds?.includes(provider.id) ?? true)`. The ownership check inside `load` keeps its current form, `provider.id === providerId && owns(provider)`. Every call creates its own `cache` and `pending` maps inside the function, so each registration keeps a separate cache. The function body is today's Codex body with the predicate and description replaced. The 60,000 ms rule, both error messages, the 404 mapping, the window `id`, `cost` and `observedAt` rules, the coalescing order and the pruning all stay exactly as they are.

Each plugin's `src/usage-source.ts` keeps its exported `registerUsageSource(api)`, so `server.ts` and the ownership tests do not change their imports. The body becomes one call:

- Codex: `{ providerIds: ["codex"], description: "Host-local usage owned by the codex provider plugin. Inventory reads metadata only. Independent of display plugins." }`
- Claude Code: `{ providerIds: ["claude-code"], description: "Host-local usage owned by the claude-code provider plugin. …" }` (the description copied verbatim from line 207).
- ACP and ACP Next: `{ description: "Host-local usage owned by the acp provider plugin. Inventory reads metadata only. Independent of display plugins." }`, with no `providerIds`.

The plugin depends only on the packed SDK (`@omnyo/plugin-sdk/provider-usage`), so the forkability rule in `docs/forkable-plugins.md` (no sibling-plugin imports) still holds.

*Preservation.* The RPC method names, the input and output schemas, `experimental_discoverable` and every description string stay unchanged, and so does the per-call sequence: `hosts.get`, then `providers.list`, then `system.usageLimits`. For built-in installs `api.pluginId` equals the old literals (see `builtin-registry.ts` above), so the built-in output is identical. The only intentional behavior change is for a fork renamed under a new plugin id. Its Codex, Claude Code or ACP source would now list its own providers instead of none, which matches ACP Next today and is a fix (listed separately as an incidental issue).

*Why this is the simplest sufficient option.* A declarative `providerIds` list covers all three predicate variants without a free-form callback, and it reuses the existing SDK subpath, so no new package or entry point is needed. A free-form `owns(provider)` predicate is an acceptable alternative if a future source needs it, but no current caller does.

*Non-goals:*

- Account Pooler's shared usage source.
- Provider Usage's own fetch coalescing (`plugins/provider-usage/server.ts:185-221`). That code throws on error states and has different semantics.
- Any change to `api.sdk.system.usageLimits`.
- Stabilizing the experimental export.

**Expected gain and cost**

All figures are projections from `wc -l` and `diff`, not measurements of a finished change.

- **Production code:**
  - Removed: about 828 lines, the four bodies.
  - Added: about 180 to 200 lines in `packages/plugin-sdk/src/provider-usage.ts` for the helper and its schemas, and 4 × about 8 to 12 lines of wrappers.
  - Net: about 590 to 620 fewer handwritten production lines, and 4 copies of the mechanism become 1.
- **Tests:**
  - Removed: about 1,059 lines.
  - Added: one SDK suite of about 300 to 340 lines (the three existing cases plus two new cases for 60 s expiry and error without a previous measurement), and 4 × about 30 to 50 lines of ownership tests.
  - Net: about 550 to 640 fewer test lines.
- **Documentation:** a few changed lines (README, API audit, plugin-api-docs export list).
- **Costs:**
  - The public experimental SDK surface gains one function.
  - The SDK version has to be bumped, and the four plugins raise their `engines.omnyoPluginSdk` floor.
  - A fork pinned to an older packed SDK fails to build until it meets the floor. That is the intended effect of the floor.
  - Each plugin bundle shrinks slightly, and the SDK `provider-usage` entry grows by the same code.
- **Performance:** Hypothesis: neutral. The number of calls per fetch and the cache lifetimes are unchanged. No benchmark exists or is needed for this path.

**Execution steps**

1. **Reconfirm the baseline.**
   - Run `diff` on the four `src/usage-source.ts` files and confirm that they still differ only at the predicate and description lines listed in Context.
   - Re-run `wc -l` on the four production files and the four test files.
   - Confirm the built-in plugin ids in `apps/server/src/services/plugins/builtin-registry.ts`.
   - Re-plan if any copy has gained source-specific logic (for example a new field or a different freshness rule), if RF-001 has already removed `plugins/provider-acp`, or if a new host-local source has appeared. A new source would become an extra call site.
2. **Write the SDK helper as a mechanical move.** In `packages/plugin-sdk/src/provider-usage.ts`:
   - Add `import type { PluginApi } from "@omnyo/plugin-sdk";`.
   - Move `locatorSchema`, `metadataSchema` and `windowMetadataSchema` in as module-private constants.
   - Add `experimental_registerHostProviderUsageSource(api, { description, providerIds })` with the Codex body copied verbatim. The only edits are the predicate, which becomes `owns(provider)` built from `api.pluginId` and `providerIds`, and `experimental_description: options.description`.
   - Keep `cache` and `pending` inside the function.
   - Export the function as a named export. Do not add it to `experimental_providerUsageSourceV1`, because that object is the wire contract.
   - Checkpoint: `pnpm --filter @omnyo/plugin-sdk typecheck`.
3. **Write the SDK tests.** Add `packages/plugin-sdk/src/__tests__/provider-usage-host-source.test.ts`, using `createFakePluginHost` from `../testing/index.js` as `src/__tests__/rpc-contract.test.ts` does.
   - Port the three existing cases from `plugins/provider-codex/src/usage-source.test.ts` without weakening any assertion. Give the fake host an explicit `pluginId`.
   - Add a case for 60 s expiry (use `vi.useFakeTimers()` or stub `Date.now`) and a case where collection fails with no previous measurement. The second case expects `observedAt: null` and the message `"Usage could not be collected from this machine."`.
   - Add a case showing that two registrations, from two fake hosts, do not share a cache.
   - Add a case showing that `providerIds: undefined` lists several provider ids of the plugin and excludes foreign plugins. This is the ACP behavior.
   - Assert the registered description through the fake host's RPC registration or discovery inspection.
4. **Bump the SDK version.** Run `node scripts/bump-plugin-sdk.mjs --patch` from the repository root. It rewrites `packages/plugin-sdk/package.json` "version" and `packages/domain/src/plugin-sdk-version.ts` "PLUGIN_SDK_VERSION". Record the new version `V`.
5. **Rewire the four plugins, one checkpoint per plugin.** For each of `plugins/provider-codex`, `plugins/provider-claude-code`, `plugins/provider-acp` and `plugins/provider-acp-next`:
   - Replace the body of `src/usage-source.ts` "registerUsageSource" with the single helper call described in the end state. Copy the description strings verbatim.
   - In `package.json`, change `engines.omnyoPluginSdk` from `">=… >=0.6.44"` to keep the first comparator and replace `>=0.6.44` with `>=V`.
   - Shrink `src/usage-source.test.ts` to one ownership test. It registers through `registerUsageSource`, uses the plugin's real built-in id, lists resources, and checks that foreign plugins are excluded, that providers not in `providerIds` are excluded (Codex and Claude Code only), and that one fetch reaches `usageLimits` with the right `providerId`. Add one case that registers under a renamed `pluginId` (for example `"fork-of-provider-codex"`) and lists that fork's own provider.
6. **Update the documentation.**
   - In `plugins/provider-usage/README.md:30-34`, replace the stale "copied into each source; no … provider-kit helper" sentence. The new text says the contract lives in `@omnyo/plugin-sdk/provider-usage`, that the host-local sources call `experimental_registerHostProviderUsageSource`, and that other providers still opt in explicitly.
   - Add one sentence about the helper to `docs/api_to_audit.md` "Provider usage source v1" (around line 1257).
   - Add `"experimental_registerHostProviderUsageSource"` next to `"experimental_providerUsageSourceV1"` in `plugins/plugin-api-docs/src/surfaces.ts:1156`.
7. **Clean up and review.** Confirm that no copy of `locatorSchema`, `metadataSchema` or `windowMetadataSchema` remains in the four plugins (`rg -n "locatorSchema|windowMetadataSchema" plugins/provider-*`). Format the changed files and inspect the full diff for unrelated edits. Then recount with `wc -l` against the step 1 baseline and record the actual net change.

**Verification and acceptance criteria**

Run all commands from `$OMNYO_CHECKOUT` or the lane's worktree root. Commands marked (confirmed) exist in a `package.json` or a script's usage text at the snapshot. Turbo filter names come from each `package.json` "name".

- SDK: `pnpm --filter @omnyo/plugin-sdk typecheck` and `pnpm --filter @omnyo/plugin-sdk test`, which run the scripts "typecheck" and "test" in `packages/plugin-sdk/package.json` (confirmed). The new suite passes, `src/__tests__/package-exports.test.ts` still passes without edits, and the subpath list is unchanged.
- SDK build and declarations: `pnpm --filter @omnyo/plugin-sdk build` and `pnpm --filter @omnyo/plugin-sdk build:types` (confirmed). Inspect `packages/plugin-sdk/bundled-types/omnyo-plugin-sdk-provider-usage.d.ts`. It should declare the new function and refer to `PluginApi` through an import from `@omnyo/plugin-sdk`, not an inlined copy of the backend contract. Compare its size with the previous build.
- Plugin tests run through turbo, because each plugin's `test` task depends on `@omnyo/plugin-sdk#build` (`docs/forkable-plugins.md`, "Turbo entries"): `pnpm exec turbo run test typecheck --filter=omnyo-plugin-provider-codex --filter=omnyo-plugin-provider-claude-code --filter=omnyo-plugin-provider-acp --filter=omnyo-plugin-omnyo--provider-acp-next`. The package names are confirmed. The exact combined turbo invocation was not run here.
- Consumer: `pnpm exec turbo run test --filter=omnyo-plugin-omnyo--provider-usage`. It should pass unchanged, because the consumer's contract did not change. The package name comes from `turbo.json:1541-1548`.
- Fork independence: `pnpm check:plugin-forks plugins/provider-codex plugins/provider-claude-code plugins/provider-acp plugins/provider-acp-next` (confirmed from `scripts/check-plugin-forks.mjs` usage). All four copies build and test against the packed SDK at version `V`.
- Lint and format: `pnpm exec oxfmt <changed files>`, then `pnpm exec oxlint --deny-warnings --format=agent` (the root devDependencies include `oxfmt` and `oxlint`; the global oxlint workflow is confirmed). Each plugin's `lint` script also runs its own oxlint, which applies the `omnyo/forkable-plugin-imports` rule.
- Contract checks:
  - The window `id` is `${index}:${label}`.
  - `accountKey` and `plan` degrade to `null` on malformed metadata.
  - `observedAt` advances only on `ok` and keeps the previous value on error.
  - A disconnected host returns the error state without calling `usageLimits`.
  - A removed resource rejects with "no longer exists".
  - A non-forced read within 60 s is served from the cache, and a read after 60 s collects again.
  - A forced refresh during a running non-forced read waits for it and then collects once more.
  - Cache pruning drops removed ids on list.
  - The description string for each plugin is byte-identical to the baseline.
- Optional runtime check, only if a local server is already running: `omnyo plugin rpc inspect provider-codex provider-usage.v1.listResources --json` shows the unchanged description, and `omnyo plugin rpc list --method provider-usage.v1.listResources --json` still lists all four sources. Not confirmed here.
- Structural completion:
  - `rg -n "pending = new Map" plugins/provider-{codex,claude-code,acp,acp-next}/src` returns nothing.
  - Each plugin's `usage-source.ts` has about 15 lines or fewer.
  - Exactly one implementation exists, in `packages/plugin-sdk/src/provider-usage.ts`.

**Rollback and stop conditions**

- **Rollback boundary.** The change consists of one SDK commit and one commit per plugin (or a single commit). No persisted data or wire format changes, so reverting the commits restores the previous behavior completely. Revert the SDK floor bumps together with the plugin edits.
- Stop if:
  - A copy has gained behavior specific to its source since this snapshot. In that case decide whether it belongs in the helper as an option or should stay local.
  - Any description string or RPC output differs from the baseline in the tests.
  - The bundled declarations for `./provider-usage` inline the whole `PluginApi` surface or fail to build. In that case type the parameter as a narrow structural `Pick` of `PluginApi` (`pluginId`, `rpc.register`, `sdk.hosts`, `sdk.providers.list`, `sdk.system.usageLimits`) instead of importing the full interface.
  - The fork check fails for a reason other than the new floor.
  - Alex prefers that provider plugins keep their adapters local. In that case the smaller alternative is to make only the predicate consistent (`api.pluginId` everywhere) and fix the stale README.
- If RF-001 lands mid-change, drop the classic ACP step; the rest of the plan is unchanged.
