# RF-002 — Reuse SDK transport for CLI plugin settings

## Rank and disposition

Conditional on preserving CLI output and mixed-version behavior. High confidence in duplicated ownership. Small to medium effort and medium compatibility risk. Related to [ISS-001](../incidental-findings.md#iss-001--cli-plugin-config-json-drops-descriptor-metadata).

## Context and evidence

Proven by inspection at `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e`. `apps/cli/src/commands/plugin.ts` has nine `callPlugins` call sites. The `config` action uses three for settings GET/PUT, and defines separate `pluginSettingDescriptorSchema` and `pluginSettingsResultSchema`. `packages/sdk/src/areas/plugins.ts` has `getSettings` and `updateSettings` for the same escaped path. They parse `packages/server-contract/src/api/plugins.ts` `pluginSettingsResponseSchema`, whose success requires `schema` and `values` and whose descriptors are strict. `callPlugins` returns parsed bodies on HTTP 400/404/409/422. SDK transport rejects HTTP errors via `OmnyoHttpError` (`packages/sdk/src/response.ts`). `printSettings`, `parseSettingValue`, `outputMutationJson` and Commander option rules remain CLI responsibilities. Token, logs and other `callPlugins` sites are outside this card.

## Proposed end state and preservation argument

Use `createCliOmnyoSdk(getUrl()).plugins` for the settings read and write. Prefer `OmnyoHttpError.body` for legacy structured CLI errors, mapped only for the same statuses and only when it matches the current error contract. Leave argument coercion, negative numeric values, secret `[set]` presentation, JSON field presence, printable errors and exit routing at the CLI. Keep an explicit compatibility projection if needed. The broader server descriptor metadata currently lost in CLI JSON is a separate behavior change. If older supported servers produce success bodies the SDK cannot parse, retain the current CLI behavior until the shared reader can preserve both contracts without a hidden retry.

## Expected gain and cost

Three direct transport uses and one read/write protocol pairing move to the existing owner. The two current schema declarations occupy about 18 handwritten lines. Project roughly 20–35 removals and 15–35 additions for error mapping and old JSON projection. Net savings may be near zero. Proceed if future settings request changes can genuinely be made in one place, and stop if the adapter would need a second full decoder.

## Execution steps

1. Capture non-secret fixtures for no settings, number/project/select settings, secret redaction, GET before `set` and direct PUT for `unset`. Record stdout, stderr and exit code for JSON/text in the four currently structured failure statuses and on malformed response bodies. Include a representative supported older server response.
2. Capture the current descriptor JSON projection independently from the new parser. Decide the feasibility of exact parity before editing. A removal that requires quietly adding descriptor keys to CLI JSON does not pass this gate.
3. Replace the two read sites and one update site in `registerPluginCommands` with `getSettings({pluginId})`/`updateSettings({pluginId, values})`. Use the SDK success result type when possible. Keep minimal presentation/compatibility handling near `printSettings` and leave the remaining `callPlugins` consumers intact.
4. Verify request URL/encoding, method order, JSON and human output, and error results. Remove only the redundant local rules made unnecessary by the verified path.

## Verification and acceptance criteria

From the root, run `pnpm --filter @omnyo/cli test src/__tests__/command-output/plugin-config.test.ts src/__tests__/command-output/plugin-enable.test.ts src/__tests__/command-output/plugin-remove.test.ts`. Run `pnpm --filter @omnyo/cli typecheck` and `pnpm --filter @omnyo/sdk typecheck`. Check the additional status and mixed-version fixtures from the first step. Existing config fixtures cover numeric negatives, unset and non-finite rejection, and need the failure envelope cases to prove parity. There should still be one GET then one PUT for `set`, and just one PUT for `unset`.

## Rollback and stop conditions

Revert the three call-site changes together. No schema or stored data change is required. Stop if success parsing differs for an established server, JSON fields change unexpectedly, the same status yields a different command outcome, or deadlines/additional requests regress the current path.
