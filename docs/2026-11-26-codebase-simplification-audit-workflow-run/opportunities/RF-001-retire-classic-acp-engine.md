# RF-001 — Retire the classic ACP engine (`packages/provider-bridge-acp`) and plugin (`plugins/provider-acp`), so ACP Next is the only ACP implementation

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Potential:** high. This is the largest single maintained-code reduction in the audit. It removes a whole second ACP engine, a whole second ACP plugin, their duplicated test suites, and the plugin-replacement framework that exists only to keep the two mutually exclusive.
- **Confidence:** high for the facts (line overlap, consumers, coordination machinery). Medium for behavioural parity, because no executed parity evidence for Next exists in the repository (see "Context and evidence").
- **Readiness:** decision-needed. Retiring classic removes a capability users can see today: switching back to the original adapter. It also changes how reasoning levels appear in the model picker for users who are still on classic. The owner (Alex) has to decide that Next has replaced classic. The repository records that this decision is still open (`docs/api_to_audit.md:1349` "Decide when this kit replaces the original").
- **Effort:** large. About 3 to 6 working days. The work covers a one-time plugin-row migration, the SDK subpath re-point, about 33 test files that use `provider-acp` as a fixture id, docs, CI and turbo entries, and a parity pass on the five shipped agents. The agents need real CLIs installed on a host.
- **Risk:** medium. The contracts at risk are persisted plugin rows and settings keyed by `provider-acp`, the shared `acp-*` provider ids in the disabled-provider list, the published SDK subpath `@omnyo/plugin-sdk/provider-bridge/acp`, and reasoning-level semantics. The change is reversible through Git as long as the migration never deletes data that classic owned during the release that ships it.
- **Prerequisites:** the owner's decision; executed parity evidence for Next on the shipped agents (Gate A below); the sweep's incidental finding ISS-S14-01 (Next is not covered by the first-party replay map or the runtime integration suites), which this plan resolves in step 6.
- **Related and overlapping:**
  - **Fallback (mutually exclusive):** if the owner keeps both engines, the byte-identical modules can be shared once instead. See the "Fallback" section at the end of this card. Count savings from only one of the two paths.
  - RF-009 (one SDK-owned host-local provider-usage source): classic `plugins/provider-acp/src/usage-source.ts` (204 lines) is one of the four copies that RF-009 counts. If RF-001 lands first, RF-009 shares three copies instead of four. Count the classic copy only here.
  - RF-072 (test the shared ACP protocol modules once): it is independent, but it gets smaller once only one engine re-tests those modules.
  - RF-119 (delete ACP Next's unused second permission-request decoder): it is independent and survives this change. Do it before or after, but not in the same commit.
  - RF-041 (scheduled SDK next-major removal batch): the `provider-bridge/acp-next` alias created here should join that batch.
- **Why it deserves its place:** 7,461 of the classic engine's 7,854 production lines and 2,203 of the classic plugin's 2,215 production lines already exist in Next. In the private history, 17 of the 27 commits that touched the classic engine since 2026-10-01 also had to touch Next. Every ACP fix is made twice today and every ACP test is kept twice. Nothing else in the audit removes this much maintained code and coordination at once.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The read-only worktree named in the task had been removed, so all reads below used `git archive` of that commit into disposable scratch, plus `git log` on the retired private store at `$ARCHIVED_OMNYO_CHECKOUT` for history from before the public squash. No tests were run: the snapshot has no `node_modules`.

*What the subsystem is.* The Agent Client Protocol (ACP) lets Omnyo drive third-party coding agents (Cursor, opencode, oh-my-pi, Grok Build, Hermes and user-added agents) over one JSON-RPC protocol. Each first-party ACP plugin registers providers with ids such as `acp-cursor`. Its `omnyo.host` artifact re-exports a bridge engine through the plugin SDK. Omnyo ships two complete copies of this stack:

| Layer | Classic | Next |
|---|---|---|
| Engine package | `packages/provider-bridge-acp` (hand-rolled JSON-RPC transport) | `packages/provider-bridge-acp-next` (official `@agentclientprotocol/sdk` 1.7.0 transport, session model, elicitation, auth guidance) |
| SDK subpath | `@omnyo/plugin-sdk/provider-bridge/acp` (`packages/plugin-sdk/src/provider-bridge-acp.ts`) | `@omnyo/plugin-sdk/provider-bridge/acp-next` (`packages/plugin-sdk/src/provider-bridge-acp-next.ts`, which adds `experimental_registerAcpDialect`) |
| Plugin | `plugins/provider-acp`, id `provider-acp`, "ACP Providers" | `plugins/provider-acp-next`, id `omnyo--provider-acp-next`, "ACP Providers (New Adapter)", which adds the ACP registry and an app settings page |

*Observed facts. All are Proven by inspection unless another label is given.*

1. **Line counts.** These are handwritten production `.ts` files, excluding `*.test.*`, fixtures and `vitest.config.ts`. The count was a `find <dir> -name '*.ts' -not -name '*.test.ts' -not -path '*fixture*' -not -name vitest.config.ts | xargs cat | wc -l` over the extracted snapshot:
   - Classic engine: 7,854 production lines, 11,878 test lines, and 1,240 lines of test fixtures (`src/bridge/fake-acp-agent.mjs`, `src/bridge/issue-1688-cursor-list-models.txt`).
   - Next engine: 11,500 production lines and 14,744 test lines.
   - Classic plugin: 2,215 production lines and 2,216 test lines. It also has six SVG icons, a README, `PLUGIN_OVERVIEW.md` and `skills/acp-provider/SKILL.md`.
   - Next plugin: 2,979 production `.ts` lines, 345 production `.tsx` lines (`app.tsx`) and 2,848 test lines.
2. **Overlap.** A Python `difflib.SequenceMatcher` comparison (`autojunk=False`) matched each classic file against the file with the same path in Next and counted the matching lines.
   - **Engine:** 7,461 of 7,854 classic lines are common. `bridge-protocol.ts` (185), `cursor-model-selection.ts` (164), `interactions.ts` (230) and `launch-spec.ts` (5) are identical. The rest are near-identical: `bridge/bridge.ts` 3,404/3,489, `delta-translation.ts` 1,242/1,257, `dialect.ts` 522/528, `bridge/model-catalog.ts` 493/571, `session-params.ts` 351/358, `wire.ts` 318/352 and `bridge/agent-connection.ts` 308/474. Only Next has `session/*`, `client/*`, `elicitation.ts` and `auth-guidance.ts`.
   - **Plugin:** 2,203 of 2,215 classic lines are common. `declaration.ts`, `configured-agents.ts` and all eight `native-roots/*` files are identical. `server.ts` differs only in the SDK subpath import and the Next-only `registerAcpRegistry` call. Only Next has `registry.ts`, `registry-service.ts`, `registry-icons.ts`, `plugin-id.ts` and `app.tsx`.
   - **Tests:** 11,816 of the classic engine's 11,878 test lines and 2,196 of the classic plugin's 2,216 test lines also exist in Next. That leaves 82 unique classic test lines, in `bridge.test.ts`, `model-catalog.test.ts`, `delta-translation.test.ts`, `probe.test.ts`, `wire.test.ts`, `server.test.ts`, `agents.test.ts` and `usage-source.test.ts`.
3. **Dual-edit burden.** In the private history (`$ARCHIVED_OMNYO_CHECKOUT`, ref `dd75fa32ba`), 27 commits touched `packages/provider-bridge-acp` since 2026-10-01, and 17 of them also touched `packages/provider-bridge-acp-next`. 21 commits touched `plugins/provider-acp`, and 17 of those also touched `plugins/provider-acp-next`. Next was added on 2026-10-09 in `fe1a02d7b9` "Add an opt-in rebuilt ACP adapter…". The public repository's history begins at the 2026-11-24 squash `060950255`, so it cannot show this.
4. **Real behavioural differences that classic users would notice.**
   - **Reasoning levels.** `packages/provider-bridge-acp/src/bridge/model-catalog.ts:110-160` maps the agent's native thought-level values onto Omnyo `ReasoningLevel`s through `ACP_NATIVE_REASONING_LEVEL_BY_VALUE` (for example `minimal` becomes `low`) and sorts them with `compareReasoningLevels`. Next (`packages/provider-bridge-acp-next/src/bridge/model-catalog.ts:110-185`) publishes the native `option.value` as `reasoningEffort`, adds a `label` and the option description, and keeps the agent's order. Stored Omnyo-level selections still resolve on Next, because `ACP_NATIVE_REASONING_VALUE_ALIASES_BY_LEVEL` maps `low` to `minimal`, `ultracode` and `max` to `xhigh`, and `ultra` to `max`. However, the picker shows different entries.
   - **Stop reasons.** Classic `wire.ts` `acpStopReasonSchema` is a closed `z.enum` of five values. Next's is `z.string()`. Classic also keeps its own `acpInitializeResultSchema`, which Next replaces with the SDK's types.
   - **Dialects.** Next adds the dialect registry (`registerAcpDialect` in `dialect.ts`) and `clientRequestMethods`.
5. **"Off by default", yet onboarding prefers Next.**
   - Both built-ins are `defaultEnabled: false` (`apps/server/src/services/plugins/builtin-registry.ts:148-157`). `docs/configuration.md:1296-1300` and `docs/api_to_audit.md:1315-1321` call Next an "experimental preview (2026-10-09)… published beside the original kit so the two can be compared before one replaces the other".
   - Onboarding already enables Next first. `apps/app/src/components/onboarding/provider-selection.ts:10` lists `pluginIds: ["omnyo--provider-acp-next", "provider-acp"]`, and `onboardingProviderChanges` (`provider-selection.ts:110-118`) enables `installed[0]` unless `preferredAcpPluginId` names another plugin. The server's `resolveOnboardingAcpDetection` (`apps/server/src/services/system/onboarding-provider-detection.ts:11-30`) orders Next first, and `routes/hosts.ts:586-611` returns its choice as `acpPluginId`.
   - So a new user who picks ACP during onboarding gets Next. Existing users who enabled ACP by hand before that change may still be on classic. How many there are is unknown.
6. **The coordination machinery that exists only for the pair.**
   - `BundledPluginReplacement` and `BUNDLED_PLUGIN_REPLACEMENTS` (`builtin-registry.ts:294-307`) have exactly one entry: Next replaces classic and carries `customAgents`.
   - The only production consumer is `createPluginService` → `pluginReplacements` (`apps/server/src/services/plugins/plugin-service.ts:654-655`), with the `setEnabled` counterpart and `carrySettings` branch at `plugin-service.ts:2118-2165`. The dependency-injection field is `bundledPluginReplacements` (`plugin-service-internal.ts:26,110`), and its only test is `apps/server/test/services/plugins/plugin-replacement.test.ts`.
   - `reviewBundledPluginReplacement` in `apps/cli/src/bundled-plugin-source.ts:298` is unrelated: it handles bundled-source artifact replacement. Keep it.
   - Other places that encode the pair: the contract union `HostProviderCliDetectionResponse.acpPluginId: "omnyo--provider-acp-next" | "provider-acp" | null` (`packages/server-contract/src/api/hosts.ts:186`), and the onboarding ordering in three places (`provider-selection.ts`, `onboarding-provider-detection.ts`, `routes/hosts.ts:587`). The only consumer of `preferredAcpPluginId` is `OnboardingFlow.tsx:659`. A search of `apps/mobile`, `apps/desktop`, `packages/client-core`, `packages/sdk/src` and `apps/cli/src` for `acpPluginId` found no other consumer.
7. **Other consumers of classic, found by searching the whole extracted tree for `provider-bridge-acp`, `provider-bridge/acp` and `provider-acp`. 95 files matched. These are the ones outside the four ACP directories:**
   - SDK: `packages/plugin-sdk/src/provider-bridge-acp.ts`, and `packages/plugin-sdk/src/provider-bridge.ts:416-420`, which re-exports `hostDaemonAcpLaunchSpecSchema` and `normalizeHostDaemonAcpLaunchSpec` from `@omnyo/provider-bridge-acp/launch-spec`. That file is a 5-line re-export of `@omnyo/provider-bridge-protocol/acp/launch-spec`.
   - SDK package metadata: `packages/plugin-sdk/package.json:40-50` (exports) and `:159-160` (workspace dependencies). `turbo.json:959-960` lists both bundled type outputs.
   - Bundling: `packages/bundled-plugins/package.json:33-34`, `pnpm-lock.yaml`, the marketplace catalog `plugins/omnyo-official.json:58-65` (generated by `apps/server/scripts/generate-omnyo-official-marketplace.ts`), and `plugins/plugin-api-docs/src/first-party-plugins.json:153-160` (checked by `packages/scripts/test/plugin-guide-first-party.test.mjs`).
   - Release smoke checks: `packages/omnyo-app/scripts/smoke-boot.mjs:17` and `smoke-tarball.mjs:30` (`EXPECTED_DISABLED_BUILTIN_PLUGINS = ["provider-acp", "resources"]`), and `smoke-tarball.mjs:770-781` (model/list smoke against `builtin-plugins/provider-acp/dist/host.js`).
   - Test harnesses that run classic only: `FIRST_PARTY_BRIDGE_MODULES.acp` (`packages/provider-bridge-protocol/src/testing/first-party-replay.ts:36-40`, consumed by `packages/provider-parity/src/index.ts:168`), `PROVIDER_BRIDGE_PLUGIN_IDS` (`packages/agent-runtime/src/test/integration-global-setup.ts:19-24`), `packages/agent-runtime/src/runtime.acp-topology.test.ts:53`, `packages/provider-parity/src/parity.self.test.ts:275-282`, and `tests/integration/native-roots-golden/pipeline.ts:27`, which imports classic native roots.
   - CI and lint configuration: `turbo.json:634-636` (provider-parity inputs) and `:1465-1474` (classic typecheck and test tasks), `scripts/ci-test-shards.json:154,165`, `scripts/forkable-plugins.json:25`, `scripts/check-provider-literal-ratchet.mjs:37`, and `.oxlintrc.json:123` (a rule scoped to classic `bridge/agent-connection.ts`).
   - User-facing text: `packages/config/src/managed-app-config.ts:47`, the migration message that tells users to run `omnyo plugin config provider-acp set customAgents`. Docs: `docs/configuration.md` "Custom ACP Agents", `docs/api_to_audit.md` (10 mentions), `docs/provider-plugin-api.md:239`, `packages/templates/src/templates/omnyo-guide-providers.md`, `packages/templates/src/templates/omnyo-guide-plugins.md`, and `plugins/omnyo-guide/skills/omnyo-plugin-authoring/references/{providers.md,provider-bridge-api-index.md}`.
   - Not affected: the `"omnyo-provider-acp"` User-Agent and Cursor client-version strings in `packages/provider-bridge-protocol/src/acp/opencode-usage.ts:252` and `provider-maintenance.ts:415`. They are wire identifiers sent to vendors, not plugin ids. Keep them.
   - About 33 test files outside the four directories use `provider-acp` as a fixture id. For example, 4 are in `apps/server/test/services/plugins` and 3 in `apps/server/test/system`.
8. **External SDK consumers.**
   - `@omnyo/plugin-sdk` is `"private": true` and is not published to npm (`docs/forkable-plugins.md:7` "this private fork does not publish it"). Forks and external plugins install the packed SDK.
   - Host artifacts bundle the SDK code at build time: `packages/plugin-build/src/build-plugin-host.ts:489-494` uses `bundle: true` and resolves the installed SDK. An already-built external plugin therefore keeps the classic engine it was built with. Re-pointing the subpath changes its behaviour only when it is rebuilt against the new SDK. Proven by inspection of the build configuration; it was not run.
   - Searching the private plugins repository (`git -C $OMNYO_PLUGIN_CHECKOUT grep` at `7edbc502` for `provider-bridge/acp`, `provider-bridge-acp`, `"provider-acp"` and `omnyo--provider-acp-next`) found no matches. Unknown third-party forks cannot be checked.
9. **Data hazard in the existing removal path.** If the classic bundled entry is deleted without a migration, `start()` runs `reconcileBundled()` and then `removeUnbundledBuiltins()` (`plugin-service.ts:1741-1742`, and again at `:3220-3221`). That deletes the orphaned `provider-acp` row through `deleteRemovedPluginData` (`plugin-service.ts:1498-1523`), which:
   - calls `deleteAllPluginSettings`, which deletes the user's classic `customAgents`;
   - calls `forgetPluginProviders(db, "provider-acp", providerIds)` (`packages/db/src/data/app-settings.ts:363-381`), which **removes every `acp-*` id from the global disabled-provider list**. Next registers the same ids, so a provider the user had turned off would come back on.

   The migration must therefore run before `removeUnbundledBuiltins` and must not forget the shared provider ids. Proven by inspection.
10. **Parity evidence gap.** `FIRST_PARTY_BRIDGE_MODULES.acp`, the agent-runtime integration setup and the topology test point only at classic. Next has its own `bridge.conformance-calibration.test.ts`. `apps/server/test/provider-corpus` holds no ACP recordings (a `find -iname '*acp*'` over it and `scripts/provider-corpus` found none). The repository therefore holds no executed, recorded evidence that Next matches classic on real agents. This is the sweep's ISS-S14-01.

*Counterevidence and the current requirement.* The docs define the side-by-side period as a comparison window. They also say that turning one plugin on turns the other off and that `customAgents` follows the switch (`docs/configuration.md:1298-1305`), so "switch back to the original adapter" is a documented, supported capability today. Classic's reasoning-level normalisation is a behaviour some users may rely on. These facts make the item decision-needed. They do not make it unreal.

*Maintenance cost today.* Changing how a Cursor permission option is presented means editing `interactions.ts` in both engines and both 444-line `interactions.test.ts` files. Adding a shipped ACP agent means editing `known-agents.ts`, the icons and both `package.json` manifests in two plugins. A fork-safety or SDK change has to be repeated in two subpath entries.

**Proposed end state and preservation argument**

*What disappears:*
- `packages/provider-bridge-acp` and `plugins/provider-acp`.
- `BundledPluginReplacement`, `BUNDLED_PLUGIN_REPLACEMENTS`, the `bundledPluginReplacements` dependency, and the counterpart/`carrySettings` branch of `setEnabled`.
- The two-id ordering in onboarding.
- Classic's turbo, CI-shard, forkable-list, lint and ratchet entries.

*What remains:*
- One engine (`packages/provider-bridge-acp-next`, keeping its package name, because a rename is cosmetic).
- One plugin (`plugins/provider-acp-next`, id `omnyo--provider-acp-next`, unchanged because the id is persisted).
- Both SDK subpaths:
  - `@omnyo/plugin-sdk/provider-bridge/acp` becomes the canonical entry and exports the Next members, including `experimental_registerAcpDialect`.
  - `@omnyo/plugin-sdk/provider-bridge/acp-next` becomes a `@deprecated` alias that re-exports the same named members from `./provider-bridge-acp.js`, scheduled for removal at the next SDK major (RF-041).

*Why keep the Next plugin id rather than moving Next's code under `provider-acp`?*
- Onboarding already enables `omnyo--provider-acp-next` for new users (fact 5).
- The `omnyo--` prefix is the owned-plugin convention (`packages/domain/src/legacy-plugin-id-v1.ts`).
- Keeping the id means only classic rows need migrating, and classic rows are the ones that would otherwise be deleted.

The alternative of keeping `provider-acp` as the surviving id is valid but needs a migration for every Next row. Choose it only if the owner prefers the shorter id.

*Canonical data flow after the change:* plugin `omnyo--provider-acp-next` → host artifact re-exports `experimental_acpProviderBridge` from `@omnyo/plugin-sdk/provider-bridge/acp` → `@omnyo/provider-bridge-acp-next`. `provider-bridge.ts` imports the launch spec straight from `@omnyo/provider-bridge-protocol/acp/launch-spec`.

*One-time migration.* It runs inside `createPluginService().start()` before `removeUnbundledBuiltins()`, under `REGISTRATION_MUTATION_KEY`, and must be idempotent. When an installed builtin row `provider-acp` exists:
1. If the Next row is missing, let `reconcileBundled()` create it first. The migration runs after `reconcileBundled()`.
2. If the classic row is enabled and Next is not, enable Next. Then copy `customAgents` from classic to Next **only when Next has no non-empty `customAgents`**. This matches today's "carry on switch" semantics without overwriting registry-added agents.
3. If the classic row is disabled and Next is enabled, copy nothing: Next's value is already the live one, because carry-on-switch kept them in step.
4. Delete the classic row without calling `forgetPluginProviders` for the shared `acp-*` ids, so the disabled-provider list survives. Delete classic's provider catalog key (`pluginProviderCatalogKey("provider-acp")`) and classic's settings, schedules and secrets directory only after steps 2 and 3 have committed. Classic has no schedules or secrets today; deleting them guards against leftovers.

The simplest correct shape is a small named function, for example `retireClassicAcpPluginRow(db)`, beside `removeUnbundledBuiltins`. It needs its own unit test. A cleaner alternative is to give `deleteRemovedPluginData` a `retainProviderIds` parameter rather than a special-case branch. Choose whichever keeps one deletion path.

*Contracts preserved:*
- Provider ids (`acp-cursor`, `acp-opencode`, `acp-omp`, `acp-grok`, `acp-hermes-agent`, and custom agent ids) are unchanged, so existing threads keep their provider.
- Thread resume across engines already happens today whenever a user toggles the pair. This change makes the direction one-way; it adds no new cross-engine path.
- Next's `legacy-config-option-id-v1.ts` shim covers only `_bb/*` option ids. Gate A checks that classic-created sessions resume on Next.
- Stored reasoning selections at Omnyo levels resolve through Next's alias table (fact 4).
- The SDK type names stay the same. `AcpDialect` only gains an optional field, so plugins compiled against the classic subpath still type-check. Proven by inspection of `dialect.ts`; not compiled.

*Intentional behaviour changes, which the owner must accept:*
- Classic users see Next's reasoning entries: native values with labels, in agent order.
- Unknown stop reasons are accepted instead of rejected.
- ACP registry browsing becomes available. It fetches `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json` on demand, with a cache (`plugins/provider-acp-next/src/registry.ts:6`, `registry-service.ts:104-199`).
- The "switch back to the original adapter" capability is removed.
- The Next plugin's display name and description (`plugins/provider-acp-next/package.json`, `"ACP Providers (New Adapter)"` and "Turning it on turns ACP providers off.") need new copy. Changing that copy is a product decision. Read `docs/product-ui-and-copy.md` under `~/.agents` first.

*Non-goals:*
- No rename of the Next package or directory.
- No change to provider ids.
- No change to `packages/provider-bridge-protocol/src/acp/*` (shared, and owned by RF-072).
- No work on RF-119's decoder.
- No restyle of the Next settings page.

*Remaining uncertainty:*
- Runtime parity on real agents has not been tested (Gate A).
- Unknown third-party forks that build against `provider-bridge/acp` will move to Next's behaviour on their next rebuild.
- The number of users still on classic is unknown.

**Expected gain and cost**

*Production, handwritten (measured with the counting command above, plus projected additions):*
- Removed: 7,854 engine lines + 2,215 plugin lines = 10,069.
- Also removed: about 70 to 90 lines of pair coordination. That is `builtin-registry.ts:294-307` (14), `plugin-service.ts:2118-2165` (about 48), the internal dependency field (2), the onboarding preference logic and orderings (about 15 to 25), and the contract union (1).
- Also removed: about 40 to 60 lines of duplicated SDK doc comment once `provider-bridge-acp-next.ts` becomes an alias.
- Added: about 80 to 150 lines of migration code, the alias re-export and replay-map entries (a projection).
- **Net: about 9,900 to 10,100 production lines removed.**

*Tests and fixtures (reported separately):*
- 11,878 classic engine test lines, 2,216 classic plugin test lines and 1,240 fixture lines are removed.
- About 33 external test files need mechanical id updates.
- The 82 unique classic test lines mostly pin classic-only behaviour (reasoning normalisation, the stop-reason enum, the initialize schema). Port them only where they cover behaviour Next must keep.
- Added: migration tests (about 100 to 200 lines, a projection).

*Assets and docs:* six classic SVG icons, a README, `PLUGIN_OVERVIEW.md` and a provider skill are removed. Next already has identical copies of the icons.

*Mechanisms, before → after:*
- ACP engines: 2 → 1. ACP plugins: 2 → 1.
- SDK subpaths with their own implementation: 2 → 1, plus 1 alias.
- Plugin-replacement framework (1 entry): present → gone.
- Places that order ACP plugin ids: 3 → 0.
- Copies of native roots, usage source, declaration and configured agents: 2 → 1.
- Turbo and CI targets for ACP plugins: 2 → 1.

*Maintenance:* a Cursor permission fix, a new shipped agent or an SDK fork-safety change is made once instead of twice. The private history shows that 17 of 27 classic engine commits would not have needed a second edit.

*Performance:* runtime effect is uncertain. Classic users move onto the SDK transport, so latency and memory per turn need a before-and-after measurement on the shipped agents (Gate A). Build and CI should improve, with one less engine package to typecheck and test and smaller SDK `dist` and bundled types, but this has not been measured.

**Execution steps**

1. **Reconfirm the snapshot and decision.**
   - Check out a fresh worktree at the current `origin/main`.
   - Rerun the line-count and `difflib` comparisons in "Context and evidence" against it, and rerun the consumer search: `rg -l 'provider-bridge-acp|provider-bridge/acp|provider-acp' --hidden -g '!node_modules'`.
   - Get the owner's recorded decision that Next replaces classic. The decision must cover the reasoning-picker change, the loss of the switch-back capability and the new plugin copy.
   - **Stop and re-plan** if any of these is true: the owner keeps classic (use the Fallback); a new non-ACP plugin has been added to `BUNDLED_PLUGIN_REPLACEMENTS`; a consumer of `provider-bridge/acp` appears in `$OMNYO_PLUGIN_CHECKOUT`.
2. **Gate A: parity evidence before any deletion (investigation only, no product edits).**
   1. Point `FIRST_PARTY_BRIDGE_MODULES.acp` (`packages/provider-bridge-protocol/src/testing/first-party-replay.ts:36-40`) at `plugins/provider-acp-next/src/host.ts` with `pluginId: "omnyo--provider-acp-next"`. Keep classic's paths in `legacyModulePaths` for now.
   2. Point `PROVIDER_BRIDGE_PLUGIN_IDS` (`packages/agent-runtime/src/test/integration-global-setup.ts:19-24`) and `runtime.acp-topology.test.ts:53` at Next.
   3. Run the agent-runtime integration suite and the provider-parity CLI for each shipped agent available on a host: Cursor, opencode, omp, Grok Build and Hermes. Record which agents were not installed.
   4. Check three scenarios by hand on one real agent:
      - Resume a classic-created thread on Next, so that `session/load` and the config option ids are exercised.
      - Run a turn with a stored reasoning selection such as `low` on an agent whose native value is `minimal`.
      - Check the model picker's reasoning entries.
   5. Measure turn latency and resident memory with classic and with Next on the same agent and prompt.
   6. **Stop condition:** a failure that Next cannot fix inside its own package, or a measured regression the owner does not accept. In that case, keep classic and use the Fallback.

   This step resolves ISS-S14-01 on its own and is worth committing even if retirement waits.
3. **Checkpoint 1: SDK re-point (behaviour-preserving for in-repo plugins).**
   - Rewrite `packages/plugin-sdk/src/provider-bridge-acp.ts` so it imports from `@omnyo/provider-bridge-acp-next`, adds `experimental_registerAcpDialect`, and keeps every existing named export, including the deprecated `AcpAgentProfile`. Replace its doc comment with the Next comment, which documents dialect registration.
   - Reduce `provider-bridge-acp-next.ts` to `@deprecated` named re-exports from `./provider-bridge-acp.js`. Named exports only, never `export *`, as the file's own rule says. Its deprecation note should say "use `provider-bridge/acp`; removal at the next major".
   - In `provider-bridge.ts:416-420`, import from `@omnyo/provider-bridge-protocol/acp/launch-spec`.
   - Switch `plugins/provider-acp-next/src/host.ts`, `server.ts`, `agents.ts`, `contract.ts` and `probe-capabilities.ts` imports to `provider-bridge/acp`. Raise `engines.omnyoPluginSdk` in `plugins/provider-acp-next/package.json` to the SDK version that ships this change, as `docs/forkable-plugins.md:97` ("SDK floor") requires.
   - Add the API change to the next SDK entry in `docs/api_to_audit.md`.
   - Run the SDK, Next plugin and Next engine checks listed under Verification.
4. **Checkpoint 2: migration and the coordination teardown, in one commit.**
   - Add the classic-row migration described above in `apps/server/src/services/plugins/plugin-service.ts`, called inside `start()` and `resumeMaintenancePlugins()` before `removeUnbundledBuiltins()`.
   - Remove the `provider-acp` entry from the bundled list (`builtin-registry.ts:148-152`).
   - Delete `BundledPluginReplacement`, `BUNDLED_PLUGIN_REPLACEMENTS`, the `bundledPluginReplacements` field (`plugin-service-internal.ts:26,110`), the `pluginReplacements` binding (`plugin-service.ts:654-655`) and the counterpart/carry branch (`plugin-service.ts:2118-2165`). `setEnabled` then only calls `applyEnabled(id, enabled)`, `syncCliSkill()` and `notifyPluginsChanged()`.
   - Replace `apps/server/test/services/plugins/plugin-replacement.test.ts` with migration tests for these cases:
     - classic enabled with agents, Next absent → Next is enabled with the agents;
     - classic enabled, Next already has agents → Next's agents are kept;
     - classic disabled, Next enabled → nothing is copied;
     - a disabled `acp-cursor` stays disabled;
     - a second start is a no-op.
   - Onboarding:
     - `provider-selection.ts:10`: set `pluginIds: ["omnyo--provider-acp-next"]` and delete the `preferredAcpPluginId` branch (lines 110-118).
     - `onboarding-provider-detection.ts`: one id.
     - `routes/hosts.ts:586-611`: read one plugin.
     - `server-contract/src/api/hosts.ts:186`: `acpPluginId: "omnyo--provider-acp-next" | null`. Keep the field for older app clients.
     - `OnboardingFlow.tsx:659`: drop the argument.
     - Update `provider-selection.test.ts` and `apps/server/test/services/system/onboarding-provider-detection.test.ts`.
5. **Checkpoint 3: delete classic.**
   - Delete `packages/provider-bridge-acp` and `plugins/provider-acp`.
   - Remove `@omnyo/provider-bridge-acp` from `packages/plugin-sdk/package.json:159`, and `omnyo-plugin-provider-acp` from `packages/bundled-plugins/package.json:33`.
   - Update `pnpm-lock.yaml` through `pnpm install`, never by hand.
   - Remove `turbo.json:1465-1474`, retarget `turbo.json:634-636` to the Next plugin's paths, and remove the classic bundled-types line `turbo.json:959` only if the SDK no longer emits it. It still emits the file, because the `acp` subpath stays, so keep that line and confirm the `acp-next` line still matches.
   - Remove the classic entries from `scripts/ci-test-shards.json:154,165`, `scripts/forkable-plugins.json:25` and `scripts/check-provider-literal-ratchet.mjs:37`. Retarget `.oxlintrc.json:123` to `packages/provider-bridge-acp-next/src/bridge/agent-connection.ts` if that rule applies to the Next transport; check the rule's purpose first.
   - Release smoke checks:
     - `smoke-boot.mjs:17` and `smoke-tarball.mjs:30`: replace `"provider-acp"` with `"omnyo--provider-acp-next"`.
     - `smoke-tarball.mjs:770-781`: set the host path to `builtin-plugins/provider-acp-next/dist/host.js` and `pluginId: "omnyo--provider-acp-next"`.
   - Drop classic's `legacyModulePaths` in `first-party-replay.ts` and update `packages/provider-parity/src/parity.self.test.ts:275-282`. Point `tests/integration/native-roots-golden/pipeline.ts:27` at the Next plugin's native roots.
   - Regenerate `plugins/omnyo-official.json` with its generator (`apps/server/scripts/generate-omnyo-official-marketplace.ts`), and update `plugins/plugin-api-docs/src/first-party-plugins.json`.
   - Mechanically update the roughly 33 test files that use `provider-acp` as a generic fixture id. Change an id only where the test reads the real bundled list; leave arbitrary ids alone.
6. **Checkpoint 4: copy and docs.**
   - `packages/config/src/managed-app-config.ts:47` message: `omnyo plugin config omnyo--provider-acp-next set customAgents '<json>'`.
   - `docs/configuration.md` "Custom ACP Agents" (lines 1285-1320): one plugin, no switch, the new CLI id.
   - `docs/api_to_audit.md`: merge the two ACP kit sections and record the alias's removal condition.
   - `docs/provider-plugin-api.md:239`, `packages/templates/src/templates/omnyo-guide-providers.md`, `omnyo-guide-plugins.md`, `plugins/omnyo-guide/skills/omnyo-plugin-authoring/references/providers.md` and `provider-bridge-api-index.md`.
   - Next plugin README, `PLUGIN_OVERVIEW.md`, `skills/acp-provider/SKILL.md`, and the display name and description in `plugins/provider-acp-next/package.json` (use the owner-approved copy).
7. **Final pass.**
   - Run `rg -n 'provider-bridge-acp[^-]|plugins/provider-acp[^-]|"provider-acp"'`, excluding `node_modules`. The only expected hits are the migration and its tests, and the vendor wire strings `omnyo-provider-acp` and `cli-omnyo-provider-acp` in `provider-bridge-protocol/src/acp`.
   - Recount production lines with the same command as the baseline. Inspect the full diff for unrelated changes.

**Verification and acceptance criteria**

All commands run from the repository root of the implementation worktree after `pnpm install`. Script names were read from the `package.json` files at the snapshot. None was run here, because the snapshot had no `node_modules`.

- Engine and plugin: `pnpm --filter @omnyo/provider-bridge-acp-next test`, `pnpm --filter @omnyo/provider-bridge-acp-next typecheck`, `pnpm --filter omnyo-plugin-omnyo--provider-acp-next test` and `pnpm --filter omnyo-plugin-omnyo--provider-acp-next typecheck`. All must pass with no weakened assertions.
- SDK: `pnpm --filter @omnyo/plugin-sdk test` and `pnpm --filter @omnyo/plugin-sdk typecheck`. Also check that `bundled-types/omnyo-plugin-sdk-provider-bridge-acp.d.ts` exports `experimental_registerAcpDialect` and every name it exported before. Diff the export lists before and after; the new list must be a superset.
- Server migration and onboarding: `pnpm --filter @omnyo/server test -- test/services/plugins test/services/system`, `pnpm --filter @omnyo/app test -- src/components/onboarding`, and `pnpm --filter @omnyo/cli test` (for `managed-app-config` users and the plugin-config output tests). The filter-argument form passes through to `vitest run`; confirm it on first use.
- Runtime and parity (Gate A): `pnpm --filter @omnyo/agent-runtime test:integration`, `pnpm --filter @omnyo/agent-runtime test` (topology), and `pnpm --filter @omnyo/provider-parity parity`. The parity CLI's arguments are unverified: read `packages/provider-parity/src/cli.ts` for its options. It needs real agent CLIs on the host. Record every agent that was skipped.
- Forkability: `pnpm check:plugin-forks -- plugins/provider-acp-next` (root script `check:plugin-forks` runs `node scripts/check-plugin-forks.mjs [plugins/<name> ...]`).
- Repo-wide: `pnpm typecheck` and `pnpm lint` (turbo). `pnpm --filter @omnyo/scripts test` covers `plugin-guide-first-party.test.mjs`.
- Release smoke (needs a built tarball): `pnpm --filter omnyo-app smoke:boot` and `pnpm --filter omnyo-app smoke:tarball`. The ACP model/list smoke must pass against the Next host artifact.
- Manual, on a real install with a copy of a database that has classic enabled with `customAgents` and a disabled `acp-cursor`:
  - After upgrade, Next is enabled, the custom agents appear, `acp-cursor` is still disabled, and a classic-created thread resumes.
  - The plugin list shows one ACP plugin.
  - The onboarding ACP step enables Next.
  - Alex checks the copy and the settings page.
- Performance: per-turn latency and memory on the same agent and prompt, classic versus Next, from Gate A. No claim of neutrality without that measurement.
- Structural completion: no `BUNDLED_PLUGIN_REPLACEMENTS`, no `@omnyo/provider-bridge-acp` workspace package, no `plugins/provider-acp`, one entry in `ONBOARDING_PROVIDERS[0].pluginIds`, and a recount showing about 9,900 to 10,100 fewer production lines.

**Rollback and stop conditions**

- *Reversible boundary:* checkpoints 1 to 4 are separate commits. Checkpoint 1 (SDK re-point) can ship alone. Checkpoint 2 holds the migration and must never be split from removing the classic bundled entry, because without the migration `removeUnbundledBuiltins` would delete classic settings and re-enable disabled `acp-*` providers (fact 9).
- *Data implications:* the migration copies before it deletes and is idempotent. To roll back after release, restore the packages from Git and re-add the classic bundled entry. `reconcileBundled()` recreates a fresh, disabled `provider-acp` row. Classic `customAgents` are not restored automatically, but Next's copy keeps them. If keeping the classic settings row matters, delay its deletion by one release: leave classic settings in place and delete only the installed row, then clean up in the following release.
- *Stop conditions:*
  - Gate A shows a Next defect on a shipped agent that cannot be fixed in Next.
  - The owner rejects the reasoning-picker change or the loss of switch-back.
  - A live external plugin is found importing `provider-bridge/acp` that depends on classic-only behaviour (the closed stop-reason enum, or reasoning normalisation).
  - A measured latency or memory regression the owner does not accept.
  - The test-file id updates turn out to test real bundled-plugin semantics that need redesign rather than renaming.
- *Safer alternative:* the Fallback below.

**Fallback (mutually exclusive with the plan above): share the byte-identical modules if both engines stay**

Use this only if the owner keeps classic. These modules are byte-identical at the snapshot (`$HOME/.omnyo/thread-storage/thr_demo/audit-work/duplicate-files.txt`, rechecked with `difflib`):
- Engine: `interactions.ts` (230) and `cursor-model-selection.ts` (164).
- Plugin: `native-roots/*` (1,132), `declaration.ts` (104) and `configured-agents.ts` (71).

The plan has two parts:
- Move the engine helpers into `packages/provider-bridge-protocol/src/acp/`. They first need the wire types they import (`AcpPermissionOptionKind`, `AcpToolCallUpdateEvent`, `AcpToolKind` from each engine's `wire.ts`, and `agentModelFamilyId` from the engines' differing `bridge/model-catalog.ts`). Each engine keeps its own `acpStopReasonSchema` and dialect registry.
- Ship the plugin-side modules once from an SDK host-side ACP entry, because `docs/forkable-plugins.md` forbids sibling-plugin imports. Both plugins pass their `KNOWN_ACP_AGENTS` and raise `engines.omnyoPluginSdk`.

Estimate: about 1,450 to 1,650 production lines and about 1,750 test lines removed; 2 to 4 days. It adds vendor-specific native-root logic to the public SDK surface, and all of it becomes wasted work if RF-001 is later approved. Do not count this saving together with RF-001.
