# RF-306 — Define the workflow model RPC vocabulary once

**Rank and disposition.** Medium benefit. High duplication confidence. Ready for schema-only implementation planning. Estimate 1–2 engineering days including packed SDK/fork checks. Medium risk because size limits and failure states are spending/security boundaries. Independent of ACP choices and RF-300. New finding beyond the prior six.

**Snapshot and authority.** Inspected `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` in `$AUDIT_WORKTREE`. This implementation plan requires separate implementation authority. No product edits, installs, provider calls, publication or performance measurements ran. Existing dependencies are absent in this audit lane. Commands below are repository-supported future checks and remain unrun. Run from the repository root unless stated otherwise. Preserve features, public imports, stored formats, errors, ordering, cancellation, UI/UX and performance. Isolate behavior corrections from structural work.

## Evidence and consumers

`plugins/provider-codex/src/ai/workflow-contract.ts` and `plugins/provider-claude-code/src/workflow-contract.ts` are byte-identical **94-line** files. The first **84 lines** of `plugins/account-pool/src/workflow-contract.ts` are also identical. The pool then adds `providerId`, routing and host-specific contracts. The shared vocabulary defines attempt/host/model identity, UTF-8 text byte limits, a 60-second maximum deadline, a 64-KiB output cap, strict object schemas and failure/capability variants.

Codex `src/workflow-model-service.ts` authorizes the `state-machines` caller and proxies to Account Pooler with `providerId: "codex"`. Claude's same-named service authorizes that caller but deliberately refuses included-only usage. Account Pooler's `src/workflow-service.ts` authorizes selected-provider calls, validates connected host/model, selects pool/native routes and revokes a lease in `finally`. Its host/CLI consume extended schemas. These separate policies are meaningful and must remain separate. Existing provider `workflow-model-service.test.ts` and pool `workflow-service.test.ts` cover these boundaries.

The absence of a local State Machines source does not prove these RPCs unused: their explicit plugin caller and declared RPCs are external extension boundaries. SDK ownership is appropriate for common transport vocabulary, not a reason to move the providers' execution policy into core.

## End state and preservation

Expose one versioned experimental schema bundle from an existing SDK entry, preferably `@omnyo/plugin-sdk/provider-bridge` alongside provider contracts: `experimental_workflowModelContractV1` containing the current base input/result/capabilities/failure-code schemas and RPC contract. Derive public types from the exported schemas. Keep the base RPC method names exactly unchanged.

Codex and Claude import this bundle. Account Pooler imports the base schemas and retains its local `.extend({ providerId })`, route union, host contract and refusal message. Preserve validation at both public RPC and host trust boundaries. Share schema definitions rather than deleting checks. Do not share authorization callbacks, pool selection, transport allowlists, retry behavior or included-only decisions. No new provider functionality is enabled.

## Expected gain and cost

Measured duplicate scope: 94+94+84 = **272 lines**, with some exports/imports included. Projection: remove 245–272 duplicated/base declaration lines, add 100–130 SDK/export/import lines: **115–172 net production lines removed**. Keep service tests separate because the providers intentionally behave differently. There are three independently maintained base input/result vocabularies today and one afterward. Adding a failure variant or changing a byte cap then updates one definition, while all three boundaries continue parsing it. No runtime improvement is claimed. Bundle dependency growth must be checked.

## Ordered execution

1. Reconfirm equality, all `workflowModel*` consumers, packed SDK boundary and current validation cases. Capture strict-schema outcomes for extra keys, malformed model IDs, deadline/output limits and multibyte text.
2. Move the common base schemas/contract unchanged into an SDK module reachable only through the selected existing entry. Do not add a root/frontend export that loads provider-only code into UI bundles.
3. Migrate both provider services/contracts and pool base imports. Keep pool's provider/route extension and service authorization local. Delete the two copied contract files if no plugin-local type export needs a tiny compatibility re-export.
4. Keep each plugin's meaningful service tests. Add one common schema boundary suite in the SDK. Retain per-plugin caller refusal, cancellation, allowance and lease-cleanup assertions.
5. Update required SDK compatibility versions, build/typecheck packed SDK consumers, run isolated forks and inspect the final diff. Report actual net production reduction apart from tests.

## Verification and acceptance

Run `pnpm -C plugins/provider-codex test -- src/workflow-model-service.test.ts`, `pnpm -C plugins/provider-claude-code test -- src/workflow-model-service.test.ts`, and `pnpm -C plugins/account-pool test -- src/workflow-service.test.ts`. Run each plugin `typecheck`, plus `pnpm --filter @omnyo/plugin-sdk test` and `typecheck`. Check pool host-specific tests discovered by `rg --files plugins/account-pool/src | rg 'workflow.*test'` for UTF-8/output/lease cases and run affected targets. Run `pnpm check:plugin-forks plugins/provider-codex plugins/provider-claude-code plugins/account-pool` only in authorized install-enabled verification.

Acceptance: exact same accepted/rejected inputs, strict extra-key policy, maximum bytes/deadlines and response variants. Unauthorized callers still cannot execute. Claude still refuses unverifiable included-only usage. Pool routing and finally cleanup remain intact. Shared declaration must not remove independent host validation. No provider/network call, new spend, UI change or fixture re-pin is needed for schema characterization. Format/lint touched code.

## Rollback and stop

Revert the coherent schema move if packed consumers fail or a boundary accepts previously rejected inputs. There is no persistence migration. Stop if the three base schemas have acquired intentionally different limits/semantics, a live consumer depends on a divergent variant, or the SDK entry adds unwanted runtime dependencies to unrelated clients. Keep local extensions rather than adding policy switches to the shared vocabulary.
