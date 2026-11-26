# RF-120 — Replace the two copied `provider-retry.v1.availability` contracts and their core equivalence test with one `@omnyo/plugin-sdk/provider-retry` export

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplication is real and byte-identical, but the sweep report missed two facts. First, the drift is not silent: a core test, `apps/server/test/services/plugins/provider-retry-availability-contract.test.ts`, loads both copies and asserts that they are equal. That 57-line test is extra machinery that also disappears. Second, the net reduction in handwritten production code is smaller than reported (about 15-25 lines, not 30-36), because each consumer needs import boilerplate for an SDK bundle export and the new subpath needs a `package.json` entry.
- **Potential:** low. The value is structural rather than about line count. One contract owner replaces two plugin copies plus a cross-package test that reaches into plugin source paths, and third-party availability sources get a canonical contract instead of a third copy.
- **Confidence:** high. The files were compared with `cmp`, every importer was found with `git grep`, and the build path for SDK subpaths was read.
- **Readiness:** ready, provided it ships in the same SDK version as RF-030 and RF-009.
- **Effort:** 1-2 hours on top of the shared SDK version step. That step is the SDK version bump plus the fork check (`pnpm check:plugin-forks`), which needs a network install.
- **Risk:** low. The method name, the wire shape and the description text stay identical. The regressions to watch for are a lost discriminated-union member or enum value, changed `experimental_description` text, and a missing SDK floor for forks.
- **Prerequisites:** none. Ship it in the same SDK version as RF-030 (the State Machines workflow-model contract) and RF-009 (the SDK host-local usage source), so each fork takes only one floor bump.
- **Related and overlapping:** RF-030 sets the pattern this card follows: a dedicated SDK subpath for a cross-plugin RPC contract. RF-009 edits the same SDK area and the same Account Pooler plugin. RF-121 and RF-122 edit `plugins/account-pool/src/hub.ts` and `server.ts`. They do not touch the lines this card changes, but expect small merge conflicts around the import blocks.
- **Why it deserves its place:** it is small, safe and mechanical. It completes the SDK-owned contract pattern for the last discoverable cross-plugin RPC that is still copied between first-party plugins. Taken alone it is marginal, so it should not be scheduled except together with RF-030.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The prepared snapshot worktree was no longer on disk, so every read used `git show e9e1b74c3:<path>` and `git grep` in `$OMNYO_CHECKOUT`. `git diff --stat e9e1b74c3 HEAD -- plugins/account-pool plugins/provider-retry packages/plugin-sdk` was empty at the time of the audit, so the cited lines are also current at local HEAD `5f2d3f895`. No test suites were run: the audit had no `node_modules`, and the task rules forbade running them.

How the subsystem works. When a turn fails with a rate limit, the Provider Retry plugin decides when to retry. It asks every plugin that registered the discoverable RPC `provider-retry.v1.availability` whether an account is available. Account Pooler is the only producer. It answers `not-routed`, `ready`, `blocked` with `retryAt`, or `unavailable` with a reason. Provider Retry validates the answer with the contract's output schema. If validation or the call fails, it logs a warning and records `lookup-failed`.

Observed facts (Proven by inspection):

- `plugins/account-pool/src/retry-contract.ts` and `plugins/provider-retry/src/retry-contract.ts` are byte-identical, as `cmp` reported, and each is 36 lines long (`wc -l`). Each defines `retryAvailabilitySchema` (lines 4-20, a `z.discriminatedUnion("kind", …)` with four members), `type RetryAvailability` (line 22), `retryAvailabilityMethod = "provider-retry.v1.availability"` (line 24) and `retryAvailabilityContract` (lines 26-36, built with `defineRpcContract` and carrying an `experimental_description` string).
- The producer is Account Pooler.
  - `plugins/account-pool/src/server.ts:7-11` imports `retryAvailabilityContract`, `retryAvailabilityMethod` and `type RetryAvailability`.
  - `server.ts:294-322` defines the `retryAvailability` handler. `server.ts:324-332` registers it with `experimental_discoverable: true` and its own registration description.
  - `server.ts:697-704` serves the same `hub.retryAvailability` result on the parent-pool HTTP route `/retry-availability`.
  - `plugins/account-pool/src/hub.ts:13-16` imports `retryAvailabilitySchema` and `type RetryAvailability`. `hub.ts:2945-2992` `retryAvailability(...)` parses a parent pool's JSON with `retryAvailabilitySchema.parse` at line 2974. `hub.ts:3198` uses the type as the return type of `accountAvailability`.
- The consumer is Provider Retry.
  - `plugins/provider-retry/server.ts:6-9` imports `retryAvailabilityMethod` and `retryAvailabilitySchema`.
  - `server.ts:84-113` calls `api.sdk.plugins.experimental_discoverRpc({ method })` and then `api.sdk.plugins.callRpc({ …, outputSchema: retryAvailabilitySchema })`. A failure is logged at lines 106-110 and stored as `{ kind: "lookup-failed" }`.
  - `plugins/provider-retry/src/diagnostics.ts:3-8` builds `retryAvailabilityLookupSchema = z.union([retryAvailabilitySchema, lookup-failed])`, which is persisted in the decision diagnostic at line 17.
- The consumer never uses its own copy of `retryAvailabilityContract` in production. The only reader of that copy is the core equivalence test. Evidence: `git grep -n retry-contract e9e1b74c3 -- plugins apps packages` lists every importer, and no production importer of the provider-retry copy takes `retryAvailabilityContract`.
- The core equivalence test is `apps/server/test/services/plugins/provider-retry-availability-contract.test.ts`, 57 lines. It dynamically imports both copies by relative path (lines 51-54) and compares `z.toJSONSchema` of the input and output plus the description (lines 35-48, 56). It is the only guard against drift, and it runs only inside this monorepo. A fork of either plugin does not run it.
- The test importers that also change are `plugins/account-pool/src/server.test.ts:1-4` and `plugins/provider-retry/server.test.ts:1-4`, which import `retryAvailabilityMethod` and `type RetryAvailability`.
- Other references stay as they are. `apps/server/test/threads/turn-failed-retry.test.ts:1330-1336` declares its own narrow `blocked`-only stub schema and the method-name literal for an integration fake. It is a test stub, not a contract copy. `plugins/account-pool/skills/account-pool/references/accounts-and-routing.md:315` documents the method and its answers in prose.
- No other consumers were found. `rg -n -l "provider-retry\.v1\.availability|retryAvailabilitySchema" $OMNYO_PLUGIN_CHECKOUT` found nothing (node_modules and dist excluded). The only hits outside the snapshot were in the retired checkout `$ARCHIVED_OMNYO_CHECKOUT`, which is not a consumer. `git grep "provider-retry\.v1\."` over the snapshot also finds only `provider-retry.v1.consent` in `plugins/workflows/src/server-harness.test.ts:54`, which is a different method. A search with no hits does not prove that no external source exists. The method name and wire shape must therefore stay unchanged in any case.

SDK and build facts (Proven by inspection):

- Precedent. `packages/plugin-sdk/src/provider-usage.ts:124-151` exports `experimental_providerUsageSourceV1` (method names, a `defineRpcContract` contract and schemas) through the `./provider-usage` subpath (`packages/plugin-sdk/package.json:22-27`). Account Pooler already imports it (`plugins/account-pool/src/usage-source.ts:4-13`).
- Subpaths are bundled into each plugin. Omnyo serves only the bare `@omnyo/plugin-sdk` at load time, and server-entry subpath imports are bundled from the plugin's own SDK install (`packages/plugin-build/src/build-plugin-server.ts:37-39`, message at `:277`). A rebuilt plugin therefore needs no newer host SDK at runtime. The floor bump only matters for forks that install the packed SDK.
- The Account Pooler host entry does not reach `retry-contract.ts`. `plugins/account-pool/src/host.ts` imports `native-workflow-eligibility`, `workflow-cli` and `workflow-contract`, which import only `workflow-transport` and `prediction-native`. The host-entry root-SDK stub noted in RF-030 therefore does not affect this change.
- SDK runtime entries keep `zod` external (`packages/plugin-sdk/scripts/runtime-entries.mjs:12`), and `pnpm-lock.yaml` resolves exactly one zod version, `4.6.7`. Plugins already compose SDK schemas inside their own zod schemas: `plugins/provider-acp/src/usage-source.ts:20,24` wraps `usagePlanSchema` and `usageWindowKindSchema`. `diagnostics.ts`'s `z.union([sdkSchema, …])` therefore has a precedent.
- Both plugins are listed in `scripts/forkable-plugins.json` (lines 4 and 30). Both have the SDK floor `"omnyoPluginSdk": ">=0.4.102 >=0.6.44"` at `package.json:18`. `docs/forkable-plugins.md:97-98` says the floor names the SDK version that introduced the newest hook the plugin calls. The SDK version at the snapshot is `0.6.57` (`packages/plugin-sdk/package.json:4`).
- The one hand-maintained list of subpaths is in `packages/plugin-sdk/src/__tests__/package-exports.test.ts:35-56`. The runtime build and the bundled declarations both derive their entries from `package.json` `exports`, as RF-030 confirmed for `runtime-entries.mjs` and `build-bundled-dts.mjs`.

Maintenance cost today. Adding an unavailable reason (for example, a new pool state) means synchronized edits in two plugins, and the core equivalence test keeps the two in step. If only Account Pooler changes, the core test fails in the monorepo. In a fork, or if the test is skipped, Provider Retry's `outputSchema` rejects the new answer, records `lookup-failed`, and the only signal is a log warning. A third-party availability source would have to write a third copy.

**Proposed end state and preservation argument**

What disappears:

- `plugins/account-pool/src/retry-contract.ts` (36 lines).
- `plugins/provider-retry/src/retry-contract.ts` (36 lines).
- `apps/server/test/services/plugins/provider-retry-availability-contract.test.ts` (57 lines). With one definition there is nothing left to compare.

What remains:

- A new file, `packages/plugin-sdk/src/provider-retry.ts`, exposed as the subpath `@omnyo/plugin-sdk/provider-retry`. It holds the current schema, method name and contract character for character. It imports `defineRpcContract` from `./rpc-contract.js`, as `provider-usage.ts` does, and exports one bundle that follows the provider-usage naming:

  ```ts
  export const experimental_providerRetryAvailabilityV1 = {
    retryAvailabilityMethod,
    retryAvailabilityContract,
    retryAvailabilitySchema,
  } as const;
  ```

  Consumers derive the type locally with `z.infer<typeof retryAvailabilitySchema>`, as the provider-usage consumers do (`plugins/account-pool/src/usage-source.ts:15`).
- Account Pooler and Provider Retry import from the subpath. Account Pooler still registers the contract with its own registration description. Provider Retry still discovers and validates against it.

Why a dedicated subpath instead of `./provider-usage`. Zod constructors are top-level call expressions, which esbuild cannot tree-shake. Importing from `./provider-usage` would therefore bundle the whole usage vocabulary (151 lines of schemas) into Provider Retry's server bundle, which does not use it today. The dedicated subpath costs one `exports` entry and one line in the package-exports test, and it matches RF-030's `./workflow-model` choice. If the index prefers fewer subpaths, appending the bundle to `provider-usage.ts` is an acceptable alternative with the same semantics. It is one decision for the executor, and it does not change correctness.

Preservation argument. These stay byte-identical: the method name `provider-retry.v1.availability`, the input `{ threadId: string.min(1), requestId: string.min(1) }`, the four-member discriminated output (with `retryAt` an int that is not negative, and the reason enum `no-enabled-account | authentication | reset-unknown | source-unavailable`), and the `experimental_description` text. These also stay the same:

- the discovery registration options (`experimental_discoverable: true` and Account Pooler's description at `server.ts:329-330`);
- the parent-pool `/retry-availability` HTTP response;
- the persisted diagnostic shape (`retryDiagnosticSchema.availability`).

Older and newer Account Pooler instances on different machines exchange the same JSON. No persisted data or migration is involved. Runtime behavior does not change, because each plugin bundle still contains its own copy of the schema at build time, now taken from the SDK.

Non-goals:

- Changing the contract, stabilizing it (removing `experimental_`), or adding unavailable reasons.
- Touching the `turn-failed-retry.test.ts` stub.
- Changing Account Pooler's routing logic or Provider Retry's policy.

**Expected gain and cost**

These are projections, counted against the snapshot with `wc -l`.

| Item | Before | After |
|---|---|---|
| Handwritten production lines in the contract copies | 72 (2 × 36) | about 40 in `packages/plugin-sdk/src/provider-retry.ts` |
| Consumer import boilerplate (4 production files) | 4 relative imports | 4 subpath imports plus destructuring and local `z.infer` types, about +10-14 lines |
| SDK `package.json` `exports` entry | none | +6 lines (configuration) |
| Net handwritten production change | | about −15 to −25 lines |
| Test lines | 57-line equivalence test plus 2 test imports | equivalence test deleted; 2 test imports rewritten (about +2 to +4 lines); package-exports list +1 line |
| Mechanisms | 2 contract copies plus 1 core test that keeps them equal by importing plugin source across packages | 1 SDK-owned contract |

Causal link to easier maintenance. A contract change becomes one SDK edit that both plugins and any external source pick up, instead of two plugin edits held together by a test that runs only in this monorepo. Forks of either plugin get the canonical contract through the packed SDK.

Cost and tradeoff. A contract change now needs an SDK version, and forks need the new SDK floor. Today a change needs two plugin edits, so the burden is not new. Performance is expected to be neutral, because the bundled schema is identical. Not measured.

**Execution steps**

1. Reconfirm the baseline.
   - Run `cmp plugins/account-pool/src/retry-contract.ts plugins/provider-retry/src/retry-contract.ts`. It should report no difference.
   - Run `git grep -n "retry-contract" -- plugins apps packages`. Expect exactly the seven references listed in Context: `hub.ts`, `server.ts`, `server.test.ts` in account-pool; `server.ts`, `server.test.ts`, `src/diagnostics.ts` in provider-retry; and the core equivalence test.
   - Run `git grep -n "provider-retry.v1.availability"` and `rg -n "provider-retry\.v1\.availability" $OMNYO_PLUGIN_CHECKOUT`.
   - Re-plan if any of these hold: the copies differ (reconcile them first, as a separate behavior decision); a new producer or consumer exists; or RF-030 has landed with a different SDK subpath convention (follow it).
2. Add the SDK export. This checkpoint is mechanical.
   - Create `packages/plugin-sdk/src/provider-retry.ts`. Copy lines 4-36 of the current `retry-contract.ts` verbatim. Change the import to `import { defineRpcContract } from "./rpc-contract.js";` and keep `import { z } from "zod";`. Drop the `RetryAvailability` type export, or keep it unexported. Append the `experimental_providerRetryAvailabilityV1` bundle shown above.
   - Add the `"./provider-retry"` entry to `packages/plugin-sdk/package.json` `exports`, directly after `"./provider-usage"`, with the same four keys: `source ./src/provider-retry.ts`, `types ./bundled-types/omnyo-plugin-sdk-provider-retry.d.ts`, and `import`/`default ./dist/provider-retry.js`. Before committing, check the generated declaration file name against what `scripts/build-bundled-dts.mjs` emits.
   - Add `"./provider-retry"` to the expected list in `packages/plugin-sdk/src/__tests__/package-exports.test.ts:35-56`, in the same position.
   - Bump `packages/plugin-sdk/package.json` `version` once, shared with RF-030 and RF-009. Do not bump separately if they land in the same change.
   - Checkpoint: build the SDK runtime and types (see Verification) and confirm that `dist/provider-retry.js` and the declaration file exist.
3. Switch Account Pooler.
   - `plugins/account-pool/src/server.ts:7-11`: replace the import with `import { experimental_providerRetryAvailabilityV1 } from "@omnyo/plugin-sdk/provider-retry";` and then destructure `const { retryAvailabilityContract, retryAvailabilityMethod, retryAvailabilitySchema } = experimental_providerRetryAvailabilityV1;`, keeping only the names used. Define `type RetryAvailability = z.infer<typeof retryAvailabilitySchema>;`. `server.ts:21` already imports `z` from `zod`.
   - `plugins/account-pool/src/hub.ts:13-16`: do the same for `retryAvailabilitySchema` and `type RetryAvailability`. `hub.ts` does not import `zod` at the snapshot, so add `import type { z } from "zod";` for the type.
   - `plugins/account-pool/src/server.test.ts:1-4`: import `retryAvailabilityMethod` from the SDK bundle and derive `RetryAvailability` locally.
   - Delete `plugins/account-pool/src/retry-contract.ts`.
   - In `plugins/account-pool/package.json:18`, set the second `omnyoPluginSdk` comparator to the new SDK version, for example `">=0.4.102 >=0.6.58"`. Use the actual shared version.
4. Switch Provider Retry.
   - `plugins/provider-retry/server.ts:6-9`: import `experimental_providerRetryAvailabilityV1` from the subpath and destructure `retryAvailabilityMethod` and `retryAvailabilitySchema`.
   - `plugins/provider-retry/src/diagnostics.ts:3`: destructure `retryAvailabilitySchema` from the same bundle. Leave `retryAvailabilityLookupSchema` and the rest unchanged.
   - `plugins/provider-retry/server.test.ts:1-4`: import `retryAvailabilityMethod` from the bundle and derive `RetryAvailability` locally.
   - Delete `plugins/provider-retry/src/retry-contract.ts`.
   - Bump `plugins/provider-retry/package.json:18` to the same floor as Account Pooler.
5. Remove the superseded support machinery.
   - Delete `apps/server/test/services/plugins/provider-retry-availability-contract.test.ts`. Its single obligation, keeping producer and consumer identical, is now structural, because both import the same object.
   - Leave `apps/server/test/threads/turn-failed-retry.test.ts` unchanged.
   - Optional documentation, each one line: add `experimental_providerRetryAvailabilityV1` next to `experimental_providerUsageSourceV1` in `plugins/plugin-api-docs/src/surfaces.ts:1156` (the `apiSymbols` list), and add a short "Provider retry availability v1" note beside "Provider usage source v1" in `docs/api_to_audit.md:1257-1263`. Optionally name the SDK export in `plugins/account-pool/skills/account-pool/references/accounts-and-routing.md:315`.
6. Final review.
   - Inspect the full diff. `git grep -n "retry-contract"` should now return nothing.
   - `git grep -n "retryAvailabilitySchema = z"` should return only `packages/plugin-sdk/src/provider-retry.ts`.
   - Recount the line changes against the snapshot with `git diff --stat`.

**Verification and acceptance criteria**

All commands run from the repository root `$OMNYO_CHECKOUT`, or from the lane that holds the change. They need `node_modules` installed. The script names were read from `package.json` files at the snapshot. The exact `turbo` filter syntax was not executed during the audit.

- Build the SDK. Plugin tests resolve the SDK's built `dist` entries, and `turbo.json:1562-1568` makes `omnyo-plugin-provider-retry#test` depend on `@omnyo/plugin-sdk#build`.
  - Run `pnpm exec turbo run build build:types --filter=@omnyo/plugin-sdk`. This uses the scripts `build` and `build:types` in `packages/plugin-sdk/package.json`. Expect `packages/plugin-sdk/dist/provider-retry.js` and a matching `bundled-types/*provider-retry*.d.ts`.
- SDK tests. Run `pnpm --filter @omnyo/plugin-sdk test` and `pnpm --filter @omnyo/plugin-sdk typecheck`. The package-exports test must pass with the new subpath.
- Plugin checks.
  - Run `pnpm exec turbo run test typecheck lint --filter=omnyo-plugin-account-pool --filter=omnyo-plugin-provider-retry`.
  - Expect all of `plugins/account-pool/src/server.test.ts` (the availability cases around lines 4693-4870 and 7846-7850), `model-compatibility.test.ts`, `model-catalog.test.ts` and `parent-pool.test.ts` to pass unchanged. Expect the same for `plugins/provider-retry/server.test.ts`.
  - The `lint` scripts run the `omnyo/forkable-plugin-imports` rule, which allows `@omnyo/plugin-sdk` subpaths.
- Core integration tests that exercise the real producer and consumer together. Run `pnpm --filter @omnyo/server exec vitest run --config vitest.config.ts test/threads/turn-failed-retry.test.ts test/services/plugins/automation-provider-retry.test.ts test/services/plugins/workflow-provider-retry.test.ts`. They must pass without edits.
- Fork check (CI job "Plugin Fork Check"). Run `pnpm check:plugin-forks plugins/account-pool plugins/provider-retry`. It needs network access for the npm install. It confirms that a copy built against the packed SDK resolves the new subpath.
- Formatting. Run `pnpm exec oxfmt <changed files>` and `pnpm format:check`, both from the root `package.json`.
- Contract preservation. Running the same `z.toJSONSchema` comparison as the deleted test confirms that the wire shape did not change. Run it once, by hand or in a scratch script, comparing the SDK export against the original file taken from git:

  ```sh
  git show e9e1b74c3:plugins/provider-retry/src/retry-contract.ts > "$TMPDIR/old-retry-contract.ts"
  ```

  Compare `z.toJSONSchema` of the input and output, plus the description string, with the SDK export. They must be equal. Do not commit this comparison.
- Structural completion.
  - `git grep -n "retry-contract"` returns nothing.
  - Exactly one definition of the `provider-retry.v1.availability` contract exists, in `packages/plugin-sdk/src/provider-retry.ts`; the `turn-failed-retry.test.ts` stub is the only other occurrence of the method string in TypeScript.
  - Both plugin SDK floors name the new SDK version.
- UI and performance. No UI is affected, so no visual check is needed. Performance is expected to be neutral, because each bundle contains the same schema. No benchmark is required.

**Rollback and stop conditions**

Rollback. The change is one self-contained commit, which can be reverted with `git revert`. It has no persisted-data, migration or wire-format implications. Older hosts keep working with rebuilt plugins, because the subpath is bundled into each plugin.

Stop and re-plan in any of these cases:

- The two copies are no longer identical when you start. Any reconciliation is a behavior change and needs its own decision.
- A third producer or consumer of `provider-retry.v1.availability` appears, for example in `$OMNYO_PLUGIN_CHECKOUT`, and is pinned to an older vendored SDK. It keeps working with its own copy, so this is not a blocker, but note it in the SDK release notes.
- The SDK build does not emit the new subpath's runtime or declaration file.
- The fork check fails to resolve `@omnyo/plugin-sdk/provider-retry` from the packed SDK.
- An integration test shows `lookup-failed` where it previously showed `blocked` or `ready`. That indicates a contract mismatch or a duplicate zod instance.
- RF-030 lands with a different subpath convention. Follow it rather than introducing a second style.

Safer smaller alternative. If the SDK release is deferred, keep both copies and the equivalence test as they are. Do not move the contract into one plugin and import it across plugins, because that breaks forkability (`docs/forkable-plugins.md`).
