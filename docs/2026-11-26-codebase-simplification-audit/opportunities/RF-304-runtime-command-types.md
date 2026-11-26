# RF-304 — Derive simple runtime command fields from protocol-owned types

**Rank and disposition.** Small, ready cleanup. High confidence in duplicated field knowledge, lower total benefit than the provider copies. Estimate half a day to one day. Low runtime risk when kept type-only. Medium type-surface risk if passthrough schemas or option mutability are mishandled. Independent of ACP support. Prior §16 confirmed, with a narrower design.

**Snapshot and authority.** Inspected `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` in `$AUDIT_WORKTREE`. This implementation plan requires separate implementation authority. No product edits, installs, provider calls, publication or performance measurements ran. Existing dependencies are absent in this audit lane. Commands below are repository-supported future checks and remain unrun. Run from the repository root unless stated otherwise. Preserve features, public imports, stored formats, errors, ordering, cancellation, UI/UX and performance. Isolate behavior corrections from structural work.

## Evidence and consumers

`packages/agent-runtime/src/provider-adapter.ts:AdapterCommand` is an 18-arm internal union. It repeats fields already described by `packages/provider-bridge-protocol/src/requests.ts` and `provider-maintenance.ts`. `bridge-protocol-adapter.ts:buildCommandPlan` translates these commands, while `runtime.ts` creates them. `ProviderExecutionContext` overlaps the bridge execution options but requires `providerOptions: JsonObject`. The wire schema permits optional arbitrary unknown values.

Counterevidence matters: `skills/configure` renames `skillRoots` to `roots`. `thread/stop` derives intent. Start/resume/fork merge options and check capabilities. Provider maintenance injects provider identity/static options. These are real transformations. Many request schemas use `.passthrough()`, so a naive `z.infer` union imports an open string index signature into internal commands. A generic command-to-wire dispatcher would increase machinery and weaken clarity.

## End state and preservation

Keep all 18 discriminants and the explicit command switch. Derive only named matching fields with `Pick<z.infer<typeof schema>, Keys>` or existing exported parameter types plus `Pick`. For example the model-list arm becomes `{ type: "model/list" } & Pick<z.infer<typeof modelListParamsSchema>, "cwd" | "envVars">`; maintenance status picks `cwd`, `requirement`, `checkUpdates` from `ProviderInstallationStatusParams` so the parsed default remains a required boolean. Thread reference commands pick exactly `threadId` and `providerThreadId`; title/service-tier commands extend that named subset.

Do not derive whole passthrough objects. Leave `ProviderExecutionContext`, option merging, readonly skill inputs, capability checks and translated commands explicit. Where a named Pick is longer or less clear than the current two fields, retain the local declaration. The goal is deleting duplicated changing vocabulary, not making every arm generic.

## Expected gain and cost

Projection: delete 20–45 local field-list lines and add 15–30 imports/type aliases: **approximately 0–30 net lines removed**. Several definitions of the same maintenance/thread-reference fields become protocol-owned names. There is no runtime work to remove and no speedup claim. The benefit is compiler propagation for real protocol vocabulary changes. Avoid counting fields merely moved to a new local alias as canonicalization.

## Ordered execution

1. Reconfirm schemas, requiredness, passthrough behavior and current runtime callers. Build a small table of exact-match fields versus translated fields. Stop if few exact matches remain.
2. Start with model list and maintenance commands using explicit named Picks. Run typecheck after this type-only checkpoint. Inspect emitted/constructed command plans for unchanged data.
3. Derive thread-reference fields for discard/archive/unarchive/goal clear and explicit title/service-tier variants only when this removes repeated knowledge. Leave all switch logic and capabilities unchanged.
4. Remove newly unused domain imports. Do not add runtime validation to already typed internal commands or a generic mapping registry.
5. Run the existing adapter and runtime command-contract tests. Review the diff to ensure no runtime statement changed and actual deleted knowledge exceeds added aliases.

## Verification and acceptance

Run `pnpm --filter @omnyo/agent-runtime typecheck` and `pnpm --filter @omnyo/agent-runtime test -- src/bridge-protocol-adapter.test.ts src/runtime.command-contract.test.ts`. The latter uses existing bridge fixtures. If their built assets are missing, use the declared `pnpm --filter @omnyo/agent-runtime generate:test-bridges` in an authorized build environment before testing. This build was not run during the audit.

Require unchanged emitted requests for sessionless maintenance with static options/environment, active versus idle stop, unsupported checkpoint fork, capability-gated archive/rename/goal operations and option-merging precedence. Typecheck must still reject missing required command fields. Passthrough schema index signatures must not erase internal discrimination. Format/lint touched code. No UI or performance benchmark is needed if the diff is strictly type-only.

## Rollback and stop

Revert the type-only commit if inference changes optionality, readonly contracts or assignability. No data migration exists. Stop if this needs a new generic request registry, casts to coerce legitimate differences, or runtime edits. Retaining explicit local fields is the smaller acceptable outcome when schema inference is noisier.
