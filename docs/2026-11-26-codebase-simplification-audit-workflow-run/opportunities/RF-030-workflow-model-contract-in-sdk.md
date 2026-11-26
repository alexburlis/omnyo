# RF-030 — Replace the three copied State Machines workflow-model contracts with one `@omnyo/plugin-sdk/workflow-model` export

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplication is real and byte-identical, but two parts of the sweep plan needed correcting. The shared definition cannot go into the SDK root entry, because Account Pooler's host entry receives a stub root SDK. The floor bump is a fork build requirement, not a runtime one. The net reduction is about 150-170 handwritten production lines, not 125-180.
- **Potential:** medium. One wire contract that carries spend and security limits (128 KiB prompt, 64 KiB output, 60 s deadline, strict objects, failure codes) is maintained in three forkable plugins that cannot import each other, and no check keeps the copies in parity.
- **Confidence:** high. The files were compared with `cmp`, every importer was found with `git grep`, and the precedent for an SDK contract subpath (`./provider-usage`) is already registered by the same three plugins.
- **Readiness:** ready.
- **Effort:** 2-4 hours of implementation and focused checks. Add the fork check (`pnpm check:plugin-forks`, which needs a network install) and the SDK version step, which should be shared with RF-009 and RF-120.
- **Risk:** low. Method names, wire shapes and limits stay identical. The regressions to watch for are a lost `.strict()`, a lost UTF-8 byte refinement, a host-entry bundle that no longer resolves, and a missing SDK floor for forks.
- **Prerequisites:** none. Ship it in the same SDK version as RF-009 (the SDK host-usage-source helper) and RF-120 (the provider-retry contract), so forks take one floor bump.
- **Related and overlapping:** RF-121 (remove Account Pooler's unreachable Claude workflow branches) edits the pool-only part of `plugins/account-pool/src/workflow-contract.ts` (`workflowProviderSchema`, `CLAUDE_WORKFLOW_UNAVAILABLE`). The two items are independent and their line counts do not overlap: RF-030 removes lines 4-84 and RF-121 touches lines 85-138. The older draft card `RF-306-workflow-model-contract.md` in this directory describes the same opportunity, so the index should keep only one of them. RF-306 suggests placing the export in `./provider-bridge`; this card recommends a dedicated small subpath instead (reason below).
- **Why it deserves its place:** it removes a three-way copy of a boundary that protects spending. Today a limit or failure-code change needs three lockstep edits across forkable plugins, and nothing detects drift. The change is mechanical and has an established SDK pattern.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e`. The audit worktree for that commit had already been removed, so every file was read with `git show <commit>:<path>` in `$OMNYO_CHECKOUT`. A `git diff --stat` between the snapshot and local `HEAD` (`5f2d3f895`) shows no change to the six affected plugin files. No node_modules were present, so no tests or builds ran. Every claim below is either proven by inspection or labelled as a projection.

How the subsystem works. The private State Machines plugin (a separate repository, `$OMNYO_PLUGIN_CHECKOUT/state-machines`) asks for included-subscription workflow text through the plugin of the provider the user selected. It calls the `workflowModelCapabilities` and `workflowModelComplete` RPCs on `provider-codex` or `provider-claude-code`. The Codex provider checks that the caller is `state-machines` and forwards the call to Account Pooler with `providerId: "codex"`. Account Pooler checks that the caller is `provider-${providerId}`, validates the host and model, then routes the request to its host entry through a pool or native route. The Claude provider checks the caller and then refuses. Every hop parses the same bounded schemas.

Observed facts (Proven by inspection):

- `plugins/provider-codex/src/ai/workflow-contract.ts` (94 lines) and `plugins/provider-claude-code/src/workflow-contract.ts` (94 lines) are byte-identical (`cmp` reports no difference). Each file defines `id` (line 4), `boundedText` (lines 6-11, which includes the `Buffer.byteLength(value, "utf8") <= max` refinement), `workflowModelInputSchema` (lines 13-26, strict, prompt limit `128 * 1024`, `timeoutMs` up to `60_000`, `maxOutputBytes` up to `64 * 1024`, model regex), `workflowModelFailureCodeSchema` (lines 28-36), `workflowModelFailureSchema` (lines 38-45), `workflowModelResultSchema` (lines 47-56), `workflowModelCapabilitiesSchema` (lines 58-71), the types `WorkflowModelCapabilities`, `WorkflowModelInput`, `WorkflowModelResult` and `WorkflowModelFailureCode` (lines 73-83), and `workflowModelContract` (lines 85-94).
- Lines 1-84 of `plugins/account-pool/src/workflow-contract.ts` (138 lines) are byte-identical to lines 1-84 of the provider copy. The check was `head -83` of both files plus `cmp`, and line 84 is blank in both. The pool-only additions are `workflowProviderSchema` (line 85), `poolWorkflowInputSchema` (lines 87-89, `.extend({ providerId })`), `PoolWorkflowInput` (line 91), `poolWorkflowContract` (lines 93-106), `workflowHostContract` (lines 108-132, which adds a `route` union), `CLAUDE_WORKFLOW_UNAVAILABLE` (lines 134-135) and `WORKFLOW_SYSTEM_PROMPT` (lines 137-138).
- Consumers, found with `git grep -n -E 'workflow-contract|workflowModel(Contract|Complete|Capabilities|InputSchema|ResultSchema|FailureSchema|FailureCode)|poolWorkflowContract|workflowHostContract|WorkflowModel(Input|Result|Capabilities|FailureCode)\b|CLAUDE_WORKFLOW_UNAVAILABLE|WORKFLOW_SYSTEM_PROMPT' <commit> -- . ':!*.md'` over the whole snapshot. The `plugins/automations/src/workflow-contract.ts` hits are an unrelated file with the same name.
  - `plugins/provider-codex/src/workflow-model-service.ts:2-8` imports `workflowModelContract`, `workflowModelCapabilitiesSchema`, `workflowModelResultSchema` and two types. It registers the contract at line 16 and parses the Account Pooler replies at lines 28-35 and 57-64.
  - `plugins/provider-claude-code/src/workflow-model-service.ts:2-6` imports `workflowModelContract` and two types, and registers the refusals at line 20.
  - `plugins/provider-codex/src/workflow-model-service.test.ts:4` and `plugins/provider-claude-code/src/workflow-model-service.test.ts:4` import `workflowModelInputSchema` for identical "rejects invalid limits" `it.each` blocks (Codex lines 85-94, Claude lines 88-97).
  - Account Pooler: `src/workflow-service.ts:7-15` imports `poolWorkflowContract`, `workflowHostContract`, `CLAUDE_WORKFLOW_UNAVAILABLE` and the types `WorkflowModelCapabilities` and `WorkflowModelResult`. `src/native-workflow-eligibility.ts:6-9` imports `WorkflowModelCapabilities`. `src/host.ts:3` and `src/workflow-cli.ts:17-23` import `workflowHostContract`. `src/hub.ts`, `src/workflow-transport.ts`, `src/workflow-allowance.ts` and the tests import only pool-only symbols (`PoolWorkflowInput`, `CLAUDE_WORKFLOW_UNAVAILABLE`, `WORKFLOW_SYSTEM_PROMPT`).
  - No file imports `WorkflowModelInput` or `WorkflowModelFailureCode`. `workflowModelFailureSchema` and `workflowModelFailureCodeSchema` are used only inside the contract files.
- The external caller, State Machines (repository HEAD `7edbc502e`), uses only the method names: `state-machines/src/imported/provider.ts:74-79` and `:151-163`. It keeps its own loose response schemas at lines 14-27 and builds against a vendored SDK tarball (`state-machines/package.json:28`, `omnyo-plugin-sdk-0.6.56`, floor `>=0.6.52`). A `git grep workflowModel` over `$OMNYO_PLUGIN_CHECKOUT` found only that file and its tests. The RPC method names and wire shapes are therefore an external boundary that must not change.
- SDK precedent. `packages/plugin-sdk/src/provider-usage.ts` exports `experimental_providerUsageSourceV1` (a `defineRpcContract` contract plus schemas) through the `./provider-usage` subpath (`packages/plugin-sdk/package.json:22-27`). `plugins/provider-codex/src/usage-source.ts:3` and `plugins/account-pool/src/usage-source.ts:4` already import it and register it with `api.rpc.register`. A cross-plugin contract owned by the SDK is therefore an established pattern for these exact plugins.
- Entry-point constraint (this corrects the sweep's "or inside an existing entry" option). In host entries, `packages/plugin-build/src/build-plugin-host.ts:54-57` (`PLUGIN_SDK_ROOT_RUNTIME`) replaces the bare `@omnyo/plugin-sdk` import with a stub that exports only `PLUGIN_CLI_OUTPUT_MAX_BYTES`, `defineRpcContract` and `experimental_defineHostEntry`. Account Pooler's host entry (`plugins/account-pool/src/host.ts` → `workflow-contract.ts`) would lose any workflow-model export placed in the root entry. Other SDK subpaths resolve normally and are bundled. Server entries do the same: per `packages/plugin-build/src/build-plugin-server.ts:35-39` and the message at `:277`, Omnyo serves only the bare root at load time, and subpaths are bundled from the plugin's own SDK install. A subpath is therefore required, and older Omnyo hosts can run rebuilt plugins without any runtime SDK floor change. `./provider-bridge` would work too, but it would bundle provider-bridge code into Account Pooler's host and server bundles for a 100-line schema file, so a dedicated subpath is the simpler option.
- Build wiring for a new subpath is derived automatically. `packages/plugin-sdk/scripts/runtime-entries.mjs` (`runtimeEntries`) builds every `exports` entry, with `zod` kept external. `packages/plugin-sdk/scripts/build-bundled-dts.mjs` (`groupOf`) assigns an unrecognised name to the `backend` group. The only hand-maintained list is the expected subpath list in `packages/plugin-sdk/src/__tests__/package-exports.test.ts:35-56`.
- All three plugins are listed in `scripts/forkable-plugins.json`. Their floors are `plugins/provider-codex/package.json:18` `">=0.5.23 >=0.6.44"`, `plugins/provider-claude-code/package.json:18` `">=0.4.90 >=0.6.44"` and `plugins/account-pool/package.json:18` `">=0.4.102 >=0.6.44"`. `docs/forkable-plugins.md:97-98` says the floor names the SDK version that introduced the newest hook the plugin calls. The SDK version at the snapshot is `0.6.57`.
- The lockfile resolves a single `zod@4.6.7`, so `.extend`/`.pick` on SDK-built schemas inside Account Pooler see the same zod major. `.pick` and `.extend` on a strict zod 4 object keep it strict, which is the same behaviour the current local definitions rely on.

Maintenance cost today: raising `maxOutputBytes`, changing the model regex or adding a failure code means editing three files in three plugins plus the State Machines loose schema. Nothing fails if one copy is missed, and the copies would only disagree at runtime, where one hop rejects what another accepts.

Counterevidence considered. These are not independently varying policies. The authorization callbacks, refusal messages and routing differ per plugin and stay local. Only the schema vocabulary is shared, and every hop already uses it byte-for-byte. Moving the limits into the SDK means a limit change needs an SDK version, but today it needs three plugin edits, so this is not a new burden.

**Proposed end state and preservation argument**

What remains and who owns it:

- A new file, `packages/plugin-sdk/src/workflow-model.ts`, exposed as the subpath `@omnyo/plugin-sdk/workflow-model`. It contains, character for character, the current `id`, `boundedText`, input, failure-code, failure, result and capabilities schemas and the `workflowModelContract` contract, using `defineRpcContract` from `./rpc-contract.js` (as `provider-usage.ts` does). It exports one bundle, following the provider-usage naming:

  ```ts
  export const experimental_workflowModelV1 = {
    inputSchema,          // was workflowModelInputSchema
    resultSchema,         // was workflowModelResultSchema
    capabilitiesSchema,   // was workflowModelCapabilitiesSchema
    contract,             // was workflowModelContract (methods workflowModelCapabilities, workflowModelComplete)
  } as const;
  export type ExperimentalWorkflowModelV1Input = z.infer<typeof inputSchema>;
  export type ExperimentalWorkflowModelV1Result = z.infer<typeof resultSchema>;
  export type ExperimentalWorkflowModelV1Capabilities = z.infer<typeof capabilitiesSchema>;
  ```

  The failure and failure-code schemas stay module-private, because no consumer imports them. `WorkflowModelInput` and `WorkflowModelFailureCode` had no importers, so only the three types above are exported. `Buffer.byteLength` is acceptable here because the SDK runtime is built with `platform: "node"` and every consumer is a server or host entry.
- `plugins/account-pool/src/workflow-contract.ts` keeps only its pool and host extensions (current lines 85-138), built from `experimental_workflowModelV1.inputSchema`, `.capabilitiesSchema` and `.resultSchema`.
- Both provider `workflow-model-service.ts` files import from the SDK subpath.

What disappears: `plugins/provider-codex/src/ai/workflow-contract.ts`, `plugins/provider-claude-code/src/workflow-contract.ts`, and lines 4-84 of `plugins/account-pool/src/workflow-contract.ts`. The plugins go from three base definitions to one.

Preservation:

- The RPC method names `workflowModelCapabilities` and `workflowModelComplete` are unchanged, and so are the input and output shapes, the strictness, the limits and the failure codes. State Machines and any older provider build exchange identical JSON.
- Authorization, refusal text, the error mapping in the `catch` blocks, the Account Pooler route and lease logic, and the `AbortSignal` handling stay unchanged in their current files.
- The `workflowModelCapabilities` input stays `pick({ hostId, model })` in the provider contract and `pick({ hostId, model, providerId })` in the pool contracts.
- No persisted data, UI, CLI command or settings key is involved.

Non-goals:

- Removing the provider hop so State Machines calls Account Pooler directly. That would change the provider-addressed contract and the "requested by the selected provider" check in `plugins/account-pool/src/workflow-service.ts:29-39`, so it is an owner decision and outside this card.
- Changing RF-121's Claude branches.
- Changing the State Machines repository. Adopting the SDK result schema there is an optional follow-up, and it needs a new vendored SDK tarball in that repository.
- Merging the duplicated Claude refusal text (`plugins/provider-claude-code/src/workflow-model-service.ts:14-18` against `CLAUDE_WORKFLOW_UNAVAILABLE`). Each plugin owns its own message.

**Expected gain and cost**

Measured: `wc -l` gives 94 + 94 + 138 lines, and 271 of them form the duplicated base (94 + 94 + lines 4-84 of the pool file, which is 81 lines plus 2 shared import lines).

Projected handwritten production TypeScript:

- About 269 lines removed: two whole files (188 lines) and about 81 lines from the pool file.
- About 100-110 lines added for the new SDK module, including the export bundle and type aliases.
- About 2-6 net import lines added across five plugin files.
- **Net reduction of about 150-170 lines.**

Configuration: 6 lines in `packages/plugin-sdk/package.json` and a 1-line edit to each of the three plugin `package.json` floors.

Tests (projected, optional): move the two identical 10-line "rejects invalid limits" blocks into one SDK test of about 25-35 lines that also covers strictness. The test count stays roughly flat.

Docs: add one short `docs/api_to_audit.md` section, following "Provider usage source v1" (lines 1257-1270), and add `experimental_workflowModelV1` to the apiSymbols list next to `experimental_providerUsageSourceV1` in `plugins/plugin-api-docs/src/surfaces.ts:1156`.

Mechanisms: three in-repo base definitions become one. The State Machines loose copy is unchanged unless the optional follow-up is done.

Maintenance example: raising `maxOutputBytes` today means three identical edits in three plugins. Afterwards it is one SDK edit plus one shared floor bump.

Performance: expected neutral. This is a schema relocation, and the bundles gain at most a duplicate of the tiny `defineRpcContract` identity function. Nothing was measured.

**Execution steps**

1. **Reconfirm.**
   - In a worktree on current `main`, run `cmp plugins/provider-codex/src/ai/workflow-contract.ts plugins/provider-claude-code/src/workflow-contract.ts` and compare `head -84` of the provider copy with `head -84` of `plugins/account-pool/src/workflow-contract.ts`.
   - Rerun the `git grep` from Context and `git grep -n workflowModel` in `$OMNYO_PLUGIN_CHECKOUT`.
   - Confirm that `PLUGIN_SDK_ROOT_RUNTIME` in `packages/plugin-build/src/build-plugin-host.ts` still stubs the root.
   - **Stop and re-plan** if the copies now differ in limits or codes (they are then divergent policy), if a new consumer imports the deleted files, or if the SDK has since gained a workflow-model export.
2. **Baseline.**
   - Run, once, `pnpm -C plugins/provider-codex test -- src/workflow-model-service.test.ts`, `pnpm -C plugins/provider-claude-code test -- src/workflow-model-service.test.ts` and `pnpm -C plugins/account-pool test -- src/workflow-service.test.ts src/workflow-hub.test.ts src/workflow-transport.test.ts`. Record that they pass.
   - Write the SDK schema test from step 3c before moving any code, so it first runs against a copy of the current definitions.
3. **Checkpoint A: SDK (structural move, no behaviour change).**
   - a. Create `packages/plugin-sdk/src/workflow-model.ts`. Copy lines 4-71 of `plugins/provider-codex/src/ai/workflow-contract.ts` verbatim, keeping `.strict()` and the `boundedText` refinement. Keep the contract body from lines 85-94, with `import { defineRpcContract } from "./rpc-contract.js";` and `import { z } from "zod";`. Export the `experimental_workflowModelV1` bundle and the three `ExperimentalWorkflowModelV1*` types shown above.
   - b. Add the `"./workflow-model"` entry to `packages/plugin-sdk/package.json` `exports`, directly after `"./provider-usage"`, in the same four-field shape: `source ./src/workflow-model.ts`, `types ./bundled-types/omnyo-plugin-sdk-workflow-model.d.ts`, `import`/`default ./dist/workflow-model.js`. Add `"./workflow-model"` to the expected list in `packages/plugin-sdk/src/__tests__/package-exports.test.ts:35-56` at the same position.
   - c. Add `packages/plugin-sdk/src/__tests__/workflow-model.test.ts`. Move the four invalid-limit cases from the provider tests into it, and add accept cases (a minimal valid input, and a prompt of exactly 128 KiB in ASCII), an extra-key rejection for input and result, and a check that `contract.workflowModelCapabilities.input` rejects a `prompt` key, because the pick is strict.
   - d. Build and verify the SDK (see Verification, SDK).
4. **Checkpoint B: providers.**
   - a. `plugins/provider-codex/src/workflow-model-service.ts`: replace the import at lines 2-8 with `import { experimental_workflowModelV1, type ExperimentalWorkflowModelV1Capabilities, type ExperimentalWorkflowModelV1Result } from "@omnyo/plugin-sdk/workflow-model";`. Destructure `const { contract, capabilitiesSchema, resultSchema } = experimental_workflowModelV1;` at module scope, as `usage-source.ts` does, and rename the uses at lines 16, 20, 28, 34, 49, 57 and 63. Delete `plugins/provider-codex/src/ai/workflow-contract.ts`. If `src/ai/` becomes empty, the directory disappears with it (check with `git ls-files plugins/provider-codex/src/ai`).
   - b. `plugins/provider-claude-code/src/workflow-model-service.ts`: make the same import change for lines 2-6 and line 20, then delete `plugins/provider-claude-code/src/workflow-contract.ts`.
   - c. In both `workflow-model-service.test.ts` files, delete the `workflowModelInputSchema` import (line 4) and the "rejects invalid limits" `it.each` block, which moved to the SDK test in 3c. Keep every caller, delegation and abort test.
   - d. Both plugins already list `@omnyo/plugin-sdk` and `zod` in `dependencies`, so no manifest dependency change is needed.
5. **Checkpoint C: Account Pooler.**
   - a. `plugins/account-pool/src/workflow-contract.ts`: delete lines 4-84. Import `experimental_workflowModelV1` from `@omnyo/plugin-sdk/workflow-model` and destructure `inputSchema`, `capabilitiesSchema` and `resultSchema`. Rewrite `poolWorkflowInputSchema` as `inputSchema.extend({ providerId: workflowProviderSchema })`, and use `capabilitiesSchema`/`resultSchema` in `poolWorkflowContract` and `workflowHostContract`. Keep `defineRpcContract` imported from the root `@omnyo/plugin-sdk`, because the host stub provides it. Keep lines 85-138 otherwise unchanged.
   - b. `plugins/account-pool/src/workflow-service.ts:12-15` and `plugins/account-pool/src/native-workflow-eligibility.ts:8`: import `ExperimentalWorkflowModelV1Capabilities`/`ExperimentalWorkflowModelV1Result` from the SDK subpath (aliased to the current local names if that keeps the diff smaller). Do not add a re-export layer in `workflow-contract.ts`.
   - c. Account Pooler has `@omnyo/plugin-sdk` in `devDependencies` (`plugins/account-pool/package.json:49`) and already bundles the `./provider-usage` subpath that way, so no manifest dependency change is needed. Confirm this with the bundle build in Verification.
6. **Checkpoint D: floors and docs.**
   - Raise the second comparator of `engines.omnyoPluginSdk` in the three plugin `package.json` files to the SDK version that first contains `./workflow-model`, for example `">=0.5.23 >=0.6.58"`.
   - Set that SDK version through the same `packages/plugin-sdk/package.json` `version` change as RF-009/RF-120. Check how earlier SDK bumps were made with `git log -p -- packages/plugin-sdk/package.json`. Do not pack or publish the SDK without separate authority.
   - Add the `docs/api_to_audit.md` section and the `surfaces.ts` apiSymbols entry.
7. **Final pass.**
   - Format the touched files with the repository formatter (`pnpm exec oxfmt <files>`) and lint (`pnpm -C <plugin> lint`).
   - Check that `git grep -n -E 'workflowModelInputSchema|workflowModelContract|ai/workflow-contract|src/workflow-contract' -- plugins/provider-codex plugins/provider-claude-code` is empty, and that the base schemas are defined only in `packages/plugin-sdk/src/workflow-model.ts`.
   - Recount with `wc -l` against the baseline above, and report production, test, config and docs lines separately.

**Verification and acceptance criteria**

All script names below come from `package.json` files at the snapshot. Run them from the repository root of the implementation worktree after `pnpm install`. None of them were run in this audit, because the snapshot has no node_modules.

- **SDK:**
  - `pnpm --workspace-root exec turbo run build:types build --filter=@omnyo/plugin-sdk`. This is the command the SDK `prepack` script uses. Expect `bundled-types/omnyo-plugin-sdk-workflow-model.d.ts` and `dist/workflow-model.js` to exist.
  - Then `pnpm -C packages/plugin-sdk test` and `pnpm -C packages/plugin-sdk typecheck`. `package-exports.test.ts` must pass with the new subpath, and `workflow-model.test.ts` must pass.
- **Providers:** `pnpm -C plugins/provider-codex test`, `typecheck` and `lint`, then the same three for `plugins/provider-claude-code`. The existing caller-refusal, delegation (`providerId: "codex"`) and catch-mapping tests must pass unchanged.
- **Account Pooler:** `pnpm -C plugins/account-pool test`, `typecheck` and `lint`. `workflow-service.test.ts` (caller authorization, Claude refusal, cancellation and timeout codes), `workflow-hub.test.ts`, `workflow-transport.test.ts` and `workflow-cli.integration.test.ts` must pass unchanged.
- **Bundles:** `pnpm -C plugins/account-pool prepare:bundled`, then the same for `plugins/provider-codex` and `plugins/provider-claude-code` (all three run `omnyo-plugin-build prepare-bundled`). This proves that the server entries and Account Pooler's host entry resolve `@omnyo/plugin-sdk/workflow-model` despite the host root stub. The output location of these commands was not confirmed; write any retained output to scratch.
- **Forks:** run `pnpm check:plugin-forks plugins/account-pool plugins/provider-codex plugins/provider-claude-code` (from `scripts/check-plugin-forks.mjs`; it installs published packages and needs network access). Each fork must install, typecheck, test and build against the packed SDK.
- **Contract equality:** the new SDK test and the unchanged plugin tests must show the same accepted and rejected inputs as the baseline. That covers extra keys, the model regex, the deadline and output limits, multibyte prompt bytes, and every result and capabilities variant. Do not edit any existing assertion to make it pass.
- **Structure:** the base schemas exist only in `packages/plugin-sdk/src/workflow-model.ts`, the two provider contract files are gone, and the Account Pooler file contains only pool and host extensions plus its two constants.
- **No UI, persisted data or performance surface is affected**, so no visual or benchmark checks are required.

**Rollback and stop conditions**

- **Rollback:** each checkpoint is a separate revert. Reverting C or B restores the local copies. Reverting A removes the subpath once no plugin imports it. No data or persisted format is involved. Forks built against the new floor stay valid after a rollback, because the floor only rises.
- **Stop** if any of the following holds:
  - The three base definitions have diverged on current `main`. That is policy, so keep them local and record the reason.
  - A host-entry or server-entry bundle cannot resolve the new subpath. Investigate `build-plugin-host.ts` resolution before trying another placement, and do not move the export into the root entry.
  - A plugin test that encodes the wire contract changes outcome.
  - The fork check fails because the packed SDK lacks the subpath, which is a floor or release-ordering issue. Fix the release order; do not drop the floor.
  - A consumer outside these three plugins turns out to import the deleted files.
- **Safer smaller alternative:** if the SDK release cannot ship soon, keep the plugins as they are and add a parity test that compares the three copies. This is a weaker option that detects drift but removes nothing.
