# RF-301 — Maintain one copy of ACP native-root resolution

**Rank and disposition.** High reduction potential. High confidence in duplication. Conditional on retaining both ACP engines. Estimate 2–3 engineering days with packed SDK and filesystem fixtures. Medium risk: native instruction/skill root selection affects agent context and filesystem access. Alternative to the overlapping portion of RF-305. Do not execute this move if classic retirement is approved and imminent. Prior audit §5 confirmed.

**Snapshot and authority.** Inspected `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` in `$AUDIT_WORKTREE`. This implementation plan requires separate implementation authority. No product edits, installs, provider calls, publication or performance measurements ran. Existing dependencies are absent in this audit lane. Commands below are repository-supported future checks and remain unrun. Run from the repository root unless stated otherwise. Preserve features, public imports, stored formats, errors, ordering, cancellation, UI/UX and performance. Isolate behavior corrections from structural work.

## Evidence and consumers

The seven corresponding `plugins/provider-{acp,acp-next}/src/native-roots/{cursor,grok,hermes,omp,opencode,resolver,shared}.ts` files compare byte-for-byte equal. One copy is **1,101 physical lines**, measured as 195+365+77+180+59+19+206. `native-roots/index.ts:resolveAcpNativeRoots` is also identical (31 lines), but it dispatches through each plugin's own `KNOWN_ACP_AGENTS` and should remain local. Both `src/host.ts` entries invoke that dispatcher with the provider ID, cwd, home and process environment. `known-agents.ts` selects the resolver. Existing `src/native-roots/native-roots.test.ts` suites use synthetic home/workspace trees and cover environment overrides and agent-specific roots.

Counterevidence: known-agent declarations and Next registry integration differ. Sharing them blindly would merge plugin identity, registry icons and agent capability policy. `agents.ts` differs as well. The same 71-line `configured-agents.ts` and 104-line `declaration.ts` files are additional textual duplicates, but they import these independently varying local definitions. No claim that the entire ACP plugin pair is interchangeable follows.

## End state and preservation

Move the seven resolver modules unchanged into SDK-owned host-only implementation, for example `packages/plugin-sdk/src/acp-native-roots/`, and export the five concrete resolver functions and their necessary types from the existing `@omnyo/plugin-sdk/host` entry. Both plugin `known-agents.ts` files import only these public functions. Retain local `index.ts`, agent selection, output filtering and warnings. No sibling-plugin or private workspace import may escape the bundle.

The shared owner preserves path expansion, XDG/provider overrides, ancestor scanning, marker/manifest detection, symlink/missing-path handling, root order and shape, instruction-file rules and warning behavior. Keep the existing resolver argument structure `{ cwd, homeDir, env }`. Do not read additional environment variables, scan broader directories, or cache answers. This is a host SDK implementation move, not a change in native-context capability.

## Expected gain and cost

Projection: remove 2,202 copied implementation lines, add the 1,101-line shared implementation plus 15–45 export/import/type lines: **1,056–1,086 net lines removed**. Unique tests remain. Duplicate helper fixtures may consolidate but are not counted. There are two maintained copies of five agent resolvers today and one afterward. Updating an agent's path rules would change one implementation rather than two. Plugin registration stays independent. No speedup is claimed. Import/bundle size and filesystem call count must remain comparable.

## Ordered execution

1. Obtain the RF-305 support disposition. If classic remains supported, reconfirm all seven equality comparisons and both host callers. Preserve independently authored plugin changes.
2. Run both resolver suites against the same fixture trees and retain full outputs. Add only missing meaningful cases for supported Windows-style paths, provider environment overrides and absent roots.
3. Move the seven files into the SDK host implementation, fixing internal relative imports without changing operations. Export concrete functions/types from `src/host.ts`. Update the package API/type fixture for that existing entry.
4. Change both `known-agents.ts` import sets and local resolver type imports. Leave dispatch and filters local. Delete the two old copies once all references are migrated. Update SDK minimum requirements.
5. Run SDK host/public-package tests, both resolver suites and typechecks, then isolated fork builds. Recount production lines including new SDK exports.

## Verification and acceptance

Run `pnpm -C plugins/provider-acp test -- src/native-roots/native-roots.test.ts`, the same command with `provider-acp-next`, and each plugin's `typecheck`. Run `pnpm --filter @omnyo/plugin-sdk test` and `pnpm --filter @omnyo/plugin-sdk typecheck`. `packages/plugin-sdk/src/__tests__/native-roots-contract.test.ts`, host testing and package-export tests are relevant anchors. Run `pnpm check:plugin-forks plugins/provider-acp plugins/provider-acp-next` in an authorized install-capable environment after the packed SDK is built.

Acceptance requires identical structured root answers and warning sequences for each agent through both public plugin dispatchers, not merely unit tests of the new helper. Compare number/order of filesystem operations for representative large and absent trees if the implementation changes beyond a mechanical move. No provider process or credential is needed for synthetic-root tests. Apply repository formatting/lint to touched code.

## Rollback and stop

One implementation commit is reversible without a stored-data migration. Stop on a divergent resolver policy, SDK fork incompatibility, increased root reach, changed output order or a material filesystem-work regression. If the shared SDK contract needs many engine switches, retain separate dispatch and move only the truly common resolver modules. RF-305 retirement removes the reason for this cross-plugin move.
