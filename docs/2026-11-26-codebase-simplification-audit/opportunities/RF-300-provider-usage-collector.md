# RF-300 — Give host-local provider usage one implementation

**Rank and disposition.** High durable benefit. High evidence confidence. Ready for implementation planning. Roughly 1–2 engineering days including SDK packing/fork checks. Medium risk because cache and forced-refresh ordering are observable. Independent of ACP retirement. Use three registrations instead of four if RF-305 removes classic first. Prior audit §4 confirmed.

**Snapshot and authority.** Inspected `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` in `$AUDIT_WORKTREE`. This implementation plan requires separate implementation authority. No product edits, installs, provider calls, publication or performance measurements ran. Existing dependencies are absent in this audit lane. Commands below are repository-supported future checks and remain unrun. Run from the repository root unless stated otherwise. Preserve features, public imports, stored formats, errors, ordering, cancellation, UI/UX and performance. Isolate behavior corrections from structural work.

## Evidence and consumers

`plugins/provider-{codex,claude-code,acp,acp-next}/src/usage-source.ts:registerUsageSource` have 210, 210, 204 and 204 physical lines. Codex/Claude differ only in two ownership predicates and description. ACP Next deliberately uses `api.pluginId`. Classic uses `"provider-acp"`. Each server entry calls its local registration. All four implement the same locator parsing, metadata normalization, successful-observation cache, 60-second expiry, resource pruning, refresh coalescing and unavailable-result mapping.

The SDK already owns the wire contract at `packages/plugin-sdk/src/provider-usage.ts:experimental_providerUsageSourceV1`. The display consumer `plugins/provider-usage/server.ts` discovers source RPCs, then selects and normalizes resources. Its display policy is separate. `plugins/account-pool/src/usage-source.ts` serves pooled accounts rather than host/provider locators and is not a fifth interchangeable implementation. `docs/forkable-plugins.md` requires isolated plugins to work against a packed SDK. Sibling-plugin imports would violate that boundary.

Proof: file/diff inspection and source caller trace. Four `usage-source.test.ts` suites cover ownership, metadata, coalescing and forced-refresh sequencing. ACP Next includes renamed-plugin ownership. No runtime suite ran.

## End state and preservation

Add one exported helper to the existing SDK `provider-usage` entry, tentatively `experimental_registerHostProviderUsageSourceV1(api, { ownsProvider, description })`. `ownsProvider` receives a provider inventory item and performs the existing equality checks. Each call creates fresh `cache` and `pending` maps. Leave method names, RPC discovery metadata, JSON locator representation, resource ordering, removed-resource throws, disconnected/error states and observation timestamps unchanged. Keep `Date.now()` at the same semantic points. Do not merge caches across plugin registrations or introduce background polling.

Keep each plugin wrapper small and explicit. Codex and Claude pass fixed plugin/provider identities. Classic passes its current fixed plugin identity. Next closes over `api.pluginId`. Preserve the existing catch behavior even if a separate issue later changes it. The display's normalization and pooled-account source remain local.

## Expected gain and cost

Projection: replace 828 production lines with a 195–225-line helper plus 35–65 wrapper/import lines: approximately **538–598 net lines removed**. Tests are separate: centralize shared cases, retain four registration/identity checks. Test savings unknown. The durable gain is one cache/coalescing implementation instead of four, with four small ownership declarations. Runtime speed is unmeasured and expected to be similar because I/O, expiry and parallel host enumeration remain unchanged. SDK surface and compatibility-version maintenance are the cost.

## Ordered execution

1. Reconfirm four implementations and callers. Capture the existing RPC outputs for the test fixtures. Stop if any provider has acquired a distinct collection policy.
2. Move the implementation unchanged into `packages/plugin-sdk/src/provider-usage.ts` or a private module imported by that entry. Parameterize only ownership and description. Keep cache construction inside registration.
3. Move shared characterization cases into an SDK usage-helper suite. Retain plugin tests proving registration and ownership, including renamed Next identity.
4. Migrate all four `server.ts` consumers in one coherent change and remove their copied implementations. Update the minimum compatible SDK requirement using the repository's SDK version workflow. Never claim compatibility with a packed SDK lacking the helper.
5. Run focused tests, SDK exports/type generation, each plugin typecheck and isolated fork check. Inspect actual added/deleted production lines separately from moved tests.

## Verification and acceptance

After dependencies are available, run `pnpm --filter @omnyo/plugin-sdk test` and `pnpm --filter @omnyo/plugin-sdk typecheck`. For each directory in `provider-codex provider-claude-code provider-acp provider-acp-next`, run `pnpm -C plugins/<directory> test -- src/usage-source.test.ts` and `pnpm -C plugins/<directory> typecheck`. The `test` script is Vitest with its local config. Run `pnpm check:plugin-forks plugins/provider-codex plugins/provider-claude-code plugins/provider-acp plugins/provider-acp-next` only in an authorized dependency-enabled verification environment. It installs isolated copies and was not run in this no-install audit.

Require unchanged outputs for fresh/cache-hit/expired/non-ok/empty-window/disconnected/removed-resource inputs. Two ordinary reads share one load. Refresh arriving during an ordinary load waits and causes a fresh load. Concurrent forced refreshes share that fresh load. Two registrations must not share state. Inventory listing must never collect usage. Run touched-file formatting/lint under the root instructions. No UI changes are intended. If display output differs, stop rather than update screenshots.

## Rollback and stop

Revert only this coherent implementation commit if contract output, fork build or refresh ordering differs. There is no data migration. Stop if the helper requires provider-specific control switches beyond ownership/description, a public SDK consumer needs incompatible behavior, or comparable cache-hit/refresh measurements reveal a regression. Keep explicit implementations if meaningful policies have diverged.
