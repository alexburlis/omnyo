# RF-302 — Share ACP permission presentation and Cursor model selection

**Rank and disposition.** Medium/high benefit. High confidence in exact duplication. Conditional on supporting both engines. Estimate 1–2 engineering days, medium risk because approval choices and model/reasoning mapping are user-visible. RF-305 subsumes the classic copy. Execute only after the support choice. Prior audit §6 confirmed.

**Snapshot and authority.** Inspected `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` in `$AUDIT_WORKTREE`. This implementation plan requires separate implementation authority. No product edits, installs, provider calls, publication or performance measurements ran. Existing dependencies are absent in this audit lane. Commands below are repository-supported future checks and remain unrun. Run from the repository root unless stated otherwise. Preserve features, public imports, stored formats, errors, ordering, cancellation, UI/UX and performance. Isolate behavior corrections from structural work.

## Evidence and consumers

`packages/provider-bridge-{acp,acp-next}/src/interactions.ts` are byte-identical, 230 lines each. Corresponding `cursor-model-selection.ts` files are byte-identical, 164 lines each. The two `bridge/bridge.ts` implementations import and use these helpers for approval payloads/decisions and Cursor model catalogs. Both engines already depend on shared ACP tool classification and presentation in `packages/provider-bridge-protocol/src/acp/`.

The interaction module imports local `wire.ts` and `dialect.ts` types. Cursor selection imports `agentModelFamilyId` from its local `bridge/model-catalog.ts`. Those dependencies must not be pulled upward through an engine dependency. Existing `interactions.test.ts` and `cursor-model-selection.test.ts` suites characterize option selection, tool kinds/paths and legacy model/reasoning normalization. Bridge and Cursor approval suites exercise production callers.

Counterevidence: the 185-line `bridge-protocol.ts` files also compare equal, but their identical source binds different local `acpStopReasonSchema`/`acpSessionUpdateSchema` definitions from `wire.ts`. Their semantics cannot be proven identical by byte equality. Retain those schemas, visibility and delta translation under each engine.

## End state and preservation

Put pure common interaction construction and decision mapping in a new `provider-bridge-protocol/acp/interactions` entry. Accept a small structural input contract for the tool-call fields the implementation actually reads and the optional classifier callback. Keep wire validation and engine decoding local. Put Cursor selection/catalog normalization under `provider-bridge-protocol/acp/cursor-model-selection`. Pass the engine's model-family normalization callback where needed instead of importing an engine's model catalog. Both engines delegate to these shared operations.

Preserve available approval decisions, per-option ordering/labels, deny/cancel mapping, tool subjects, write scope, custom dialect callbacks, model catalog ordering, legacy family mapping, direct-family preference, reasoning deduplication, service-tier merging and defaults. Do not unify wire stop reasons, lifecycle behavior, authentication or SDK transport.

## Expected gain and cost

Projection: two copies total 788 lines. One shared 394-line implementation plus 20–70 adapter/export/type lines yields **324–374 net production lines removed**. Shared pure cases may move into one suite. Retain both engines' bridge coverage and count no test deletion as production savings. One fix to an approval mapping or Cursor legacy-family alias now updates two implementations. Afterward it updates one pure owner. Runtime effects are unmeasured. Additional wrappers should be erased or trivial, but compare catalog output and approval latency if logic changes.

## Ordered execution

1. Reconfirm RF-305's two-engine support choice, byte equality and caller imports. Run existing pure-helper tests to retain independent expected results.
2. Trace all local type members read by `interactions.ts`. Define only those structural inputs in the shared ACP entry. Leave both existing wire validators untouched. Move code and tests mechanically first.
3. Extract Cursor helper into the shared ACP entry with a required family-normalizer parameter. Pass the current local `agentModelFamilyId` at both call sites. Do not move entire model catalogs.
4. Migrate both bridge imports and delete copied helper bodies. Retain only thin internal adapters when they preserve a named engine-local type contract. Add package export declarations in the protocol package, not a new package.
5. Run pure and bridge tests for both engines, protocol tests/typecheck and existing recorded conformance. Confirm the complete diff removes a copy without broad generic machinery.

## Verification and acceptance

For each package `provider-bridge-acp` and `provider-bridge-acp-next`, run `pnpm --filter @omnyo/<package> test -- src/interactions.test.ts src/cursor-model-selection.test.ts src/bridge/cursor-mcp-approval.test.ts src/bridge/bridge.test.ts` and `pnpm --filter @omnyo/<package> typecheck`. Run `pnpm --filter @omnyo/provider-bridge-protocol test` plus its `typecheck`. Both package-local `src/bridge/bridge.recorded-conformance.test.ts` suites are additional exact targets. These commands are not executed audit evidence.

Compare exact approval payload/resolution and model catalog outputs for unchanged fixtures, including deny, cancellation, missing tool details, injected tools, custom classifiers, legacy Cursor IDs and duplicate reasoning/service tiers. Keep all distinct engine cases. Formatting/lint must pass. No UI redesign or changed snapshot is authorized.

## Rollback and stop

Revert the coherent helper move only. No database migration or provider state changes are involved. Stop if compatible structural types require weakening validation, if engine callbacks need divergent policy switches, if approval choices change, or if model/reasoning selections stop round-tripping. Prefer sharing only the smaller pure subset over a unified engine abstraction.
