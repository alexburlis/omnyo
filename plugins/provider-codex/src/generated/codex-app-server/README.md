# Codex App-Server Type Generation

`plugins/provider-codex/src/generated/codex-app-server/schema/` is generated directly from the local `codex` binary.

## Regenerate (stable API surface)

```bash
codex app-server generate-ts --out <tmp-dir>
```

## Regenerate (stable + experimental API surface)

```bash
codex app-server generate-ts --experimental --out <tmp-dir>
```

## What the generator does

1. Runs `codex app-server generate-ts --out <tmp-dir>`.
2. Copies the generated schema files into `schema/`.
3. Rewrites relative imports to include `.js` extensions for NodeNext.
4. Writes `export *` barrels (`index.ts`, `schema/index.ts`, `schema/v2/index.ts`).

## Committed state: pruned to the reachable subset

We do **not** commit the generator's full output. The hand-written Codex
adapter imports concrete schema files directly (e.g.
`schema/v2/SandboxPolicy.js`) and never imports the barrels, so most emitted
types are unreachable. The committed tree is therefore pruned to the
transitive type-import closure of the hand-written importers:

- `translator.ts`, `visibility.ts`, `interactive-requests.ts`,
  `mcp-elicitation.ts`, `session-params.ts`, `schemas.ts`,
  `bridge/bridge.ts`, and the test files `translator.test.ts`,
  `delta-translation.test.ts`, `presentation.test.ts` and
  `bridge/bridge.calibration.test.ts`.

`schema/v2/McpServerElicitationAction.ts` and
`schema/v2/McpServerElicitationRequestResponse.ts` were added from Codex
0.162.1 for `mcpServer/elicitation/request` responses.

`schema/v2/CodexErrorInfo.ts`, `schema/v2/TurnError.ts`,
`schema/v2/MisalignmentErrorDetails.ts` and `schema/v2/MisalignmentSteer.ts`
come from Codex 0.167.0. Other reachable files that 0.167.0 changes, such as
`schema/v2/Turn.ts`, still match the earlier generation. Since 0.167.0,
`CodexErrorInfo` ends in `| string | { [key: string]: unknown }`, and
TypeScript then reduces its string variants to `string`. `schemas.ts`
therefore keeps the known variants in their own schema. The type guards
there compare the wire input and the object variants. The
`categorizes every CodexErrorInfo variant` test in
`delta-translation.test.ts` reads the string variants from this file.

At the last regenerate (Codex 0.149.1) that was 235 of the 663 emitted
files; the unreachable files and all three `export *` barrels (`index.ts`,
`schema/index.ts`, `schema/v2/index.ts`) were removed. Nothing imports the
barrels, so their removal is type-safe.

### Re-prune after regenerating

A regenerate (the commands above) re-emits the full set plus the barrels.
The committed tree matches the **stable** surface; the hand-written code
uses no experimental fields. After copying the schema in, delete the
generated comment lines, rewrite relative
imports to `.js` specifiers, delete everything not reachable from the
importers listed above (and the barrels), then verify:

```bash
pnpm exec turbo run typecheck --filter=omnyo-plugin-provider-codex
```

TypeScript reports any over-deletion as a missing-module error; a green
typecheck plus `pnpm exec turbo run test --filter=omnyo-plugin-provider-codex` confirms
the kept subset is complete. Keep it pruned to avoid re-vendoring dead types.

## Source of truth

- Upstream reference: [openai/codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md).
- `schema/*.ts`: generated from Codex app-server, pruned to the reachable subset (see above).
- `index.ts` / barrels: intentionally **not** committed; the adapter imports concrete `schema/**` files directly.
- `plugins/provider-codex/src/delta-translation.ts`: translates Codex app-server events into Omnyo thread deltas.
