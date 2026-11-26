# RF-305 — Retire the classic ACP engine only after proving replacement support

**Rank and disposition.** Largest potential provider reduction. High confidence in current footprint, **not ready to delete**. Conditional product/support decision plus migration proof. Coarse estimate: several engineering days for matrix and compatibility work, potentially more if gaps appear. High risk. This is an alternative to RF-301/RF-302 and overlaps the classic quarter of RF-300. Prior §18 remains conditional.

**Snapshot and authority.** Inspected `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` in `$AUDIT_WORKTREE`. This implementation plan requires separate implementation authority. No product edits, installs, provider calls, publication or performance measurements ran. Existing dependencies are absent in this audit lane. Commands below are repository-supported future checks and remain unrun. Run from the repository root unless stated otherwise. Preserve features, public imports, stored formats, errors, ordering, cancellation, UI/UX and performance. Isolate behavior corrections from structural work.

## Evidence, reachability and counterevidence

`packages/provider-bridge-acp/src` contains **7,854 handwritten runtime TS lines in 14 files** (exclude tests, model fixtures and fake-agent runner). `plugins/provider-acp` contains **2,215 runtime TS lines in 17 files** (exclude Vitest/config/test files). The combined **10,069-line removal scope is measured existing code, not a net deletion forecast**. Public surface `packages/plugin-sdk/src/provider-bridge-acp.ts` and `package.json` exports `./provider-bridge/acp`. Both are live compatibility obligations.

`apps/server/src/services/plugins/builtin-registry.ts:BUNDLED_PLUGIN_REPLACEMENTS` identifies `omnyo--provider-acp-next` replacing `provider-acp`, carrying `customAgents`. Next's SDK entry explicitly describes a preview beside classic until replacement. Classic `src/host.ts` re-exports the old engine. First-party replay in `packages/provider-bridge-protocol/src/testing/first-party-replay.ts:FIRST_PARTY_BRIDGE_MODULES.acp` still targets this host. Thus classic is reachable, not dead.

Next differs materially: ACP SDK client/message stream, session model, elicitation and custom dialect registration. Classic uses its own connection parser and lifecycle. Existing persistent provider IDs/native sessions, custom launch specs, `customAgents`, external packed-SDK plugin forks and downgrade behavior cannot be resolved by source-line equality. No live migration or external consumer inspection ran, and no owner support-retirement decision is assumed.

## Preferred end state and preservation gate

If Alex selects Next as the supported engine and the matrix proves replacement, retain one engine under Next's implementation. Preserve the classic SDK import as a compatibility facade to the surviving engine **only if its promised types/runtime behavior remain supported**. Preserve public names and existing provider IDs needed by old threads. The replacement registry continues carrying settings. Introduce no silent session conversion or ID remapping. Remove the old plugin/engine only after all required callers, replay fixtures, build inputs and migration paths have a proven supported destination.

If classic remains a supported comparison or fallback surface, retain it and execute the smaller common-code cards instead. That outcome is a valid support choice, not audit failure. Deprecation notices and new capability policy require product authority.

## Expected gain and cost

Conditional projection: remove most of the 10,069-line classic implementation. Compatibility adapters and any missing behavior may add hundreds or thousands of lines, so **net savings are not presently defensible**. Do not sum 10,069 with RF-301/RF-302 or classic usage-source savings. The durable opportunity is one maintained transport/session engine and one test matrix instead of two. Faster startup/lower memory is a hypothesis until representative measurements. Replacement may cost more at runtime.

## Ordered execution and gates

1. Obtain the owner's exact support decision: Next replaces classic versus both remain. Inventory supported SDK consumers and upgrade/downgrade versions from release/support policy. Repository searches alone cannot establish external absence.
2. Build a two-engine synthetic/recorded matrix before deleting anything: thread start, existing-session resume/fork, checkpoint restrictions, pending approvals with deny/cancel, models/reasoning/service tiers, compaction, usage/health/install maintenance, native roots and custom agents/dialects. Include malformed/unsupported responses, interruption/child exit and environment/permission policies. Keep expected differences explicit.
3. Verify settings carry and existing thread/provider identities in a disposable database/environment using production replacement services. Prove what happens if Next is disabled or an older supported app opens the state. Stop on an unsupported old session or required downgrade path.
4. Identify the SDK compatibility facade's exact retained exports/types. Route existing callers and packed forks through it. Run real packed artifact checks. Do not remove a public import merely because in-tree imports moved.
5. Migrate replay/recording entry selection, bundled registry/build dependencies and docs to the surviving owner. Then remove classic implementation and redundant tests, retaining unique behavior tests against the survivor. Do not remove applied migrations or stored sessions.
6. Run affected engine, SDK, server replacement and provider-parity suites, structural searches and comparable performance checks before approving the deletion. Publication/deployment remains a separate authorization.

## Verification and acceptance

Existing commands: `pnpm --filter @omnyo/provider-bridge-acp test`, `pnpm --filter @omnyo/provider-bridge-acp-next test`, `pnpm --filter @omnyo/provider-parity test`, `pnpm --filter @omnyo/plugin-sdk test`, affected package `typecheck`, and `pnpm check:plugin-forks plugins/provider-acp-next` in an authorized install-capable environment. Locate replacement tests with `rg -n 'carriedSettings|provider-acp-next' apps/server/test/services/plugins` and run those exact server tests. Do not treat the generic parity matrix as proof of Next: its current ACP replay owner is classic and must be explicitly redirected/composed for the candidate.

No paid provider call is required for recorded fixtures. Any indispensable live capability proof needs existing approved included routes and separate spending authority for new cost. Accept only when the explicit support matrix passes, old imports build from a packed SDK, existing sessions/settings remain usable, and production code has one ACP engine. Keep baseline event/row fixtures independent. Never bless a changed snapshot to hide a behavior difference.

## Rollback and stop

Keep the entire deletion as a local reversible branch/commit until migration proof and support approval. Roll back only owned changes. Preserve all sessions/configuration. Stop on a live external consumer with no compatible path, missing Next capability, changed permission behavior, unsupported downgrade, or measured material regression. Resolve the specific gap or choose the two-engine simplifications. No destructive data cleanup belongs to this plan.
