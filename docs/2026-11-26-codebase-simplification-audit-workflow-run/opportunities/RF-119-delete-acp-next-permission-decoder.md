# RF-119 — Delete ACP Next's test-only second `session/request_permission` decoder (`decodeAcpPermissionRequest`)

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The opportunity is real and the code is unreachable from production, as the sweep said. Two corrections: the item does not need an option-kind decision first, so readiness is **ready** rather than conditional; and the scope also covers one import the decoder alone uses.
- **Potential:** low. About 57 non-blank production lines disappear. The value lies in removing a second, contradictory description of the permission-request rule rather than in the line count.
- **Confidence:** high. Reachability is proven by inspection (searches below).
- **Readiness:** ready.
- **Effort:** small, about one to two hours including the test rewrite.
- **Risk:** low. No production caller exists, the package is private and the decoder is not re-exported. The only risk is losing the transport contract its tests also encode, which the steps below keep.
- **Prerequisites:** none.
- **Related and overlapping items:**
  - RF-001 (retire the classic ACP engine and make ACP Next the single ACP implementation). The two items do not conflict. The classic package `packages/provider-bridge-acp` has no `client/` directory and no copy of this decoder, so RF-119 is not part of RF-001's byte-identical sharing fallback. If the owner chose to retire ACP Next instead of classic, RF-119 would be moot.
  - RF-072 (test the shared ACP protocol modules once). That item does not touch `client/acp-client.test.ts`.
  - RF-079 (small orphaned helpers kept alive only by their tests). Step 5 below names two unreferenced constants in the same file. If RF-079 already removes them, skip step 5.
- **Why it deserves its place:** it is a verified dead-code deletion with no product effect. It removes the question "which of these two decoders runs?" for anyone who changes permission handling. It ranks low because the gain is small.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The package `packages/provider-bridge-acp-next` is unchanged between that commit and `5f2d3f895` (`git diff --stat e9e1b74c3 5f2d3f895 -- packages/provider-bridge-acp-next` prints nothing).

*What the subsystem does.* ACP Next is Omnyo's Agent Client Protocol bridge. It runs an ACP agent (Cursor, OpenCode and others) as a child process and speaks JSON-RPC with it. When the agent wants approval for a tool call, it sends the request `session/request_permission`, and Omnyo answers with the chosen option.

*The production path (observed).*

1. `packages/provider-bridge-acp-next/src/bridge/agent-connection.ts:247` calls `connectAcpClient` with a `requests` map. Each handler forwards the raw params to `options.onRequest` (around lines 225-243).
2. `packages/provider-bridge-acp-next/src/client/acp-client.ts:193-199` (`connectAcpClient`) registers each request handler with an identity parser, `(params: unknown) => params`. The ACP SDK therefore does no validation, and the handler receives the raw params.
3. `packages/provider-bridge-acp-next/src/bridge/bridge.ts:1966` `handlePermissionRequest` parses the params with `acpRequestPermissionParamsSchema.safeParse` (line 1971). If parsing fails, it answers `-32602 "Invalid session/request_permission params"` (line 1974).
4. `packages/provider-bridge-acp-next/src/wire.ts:296-302` `acpRequestPermissionParamsSchema` requires `sessionId: string`, an optional `toolCall`, and `options: z.array(acpPermissionOptionSchema).min(1)`. Each option (lines 286-292) needs `optionId: string`, `name: string` and a `kind` from the closed enum `allow_once | allow_always | reject_once | reject_always` (lines 275-280).
5. `bridge.ts:1840` `findOptionIdByKinds` and `bridge.ts:1855` `pickPermissionOptionId` pick an option by kind. They use the `AcpPermissionOption` type imported from `../wire.js` (`bridge.ts:130`), not the interface of the same name in `acp-client.ts`.

*The second decoder (observed).* `packages/provider-bridge-acp-next/src/client/acp-client.ts` defines:

- `AcpPermissionOption` (lines 28-32), with `kind: string`;
- `AcpPermissionRequest` (lines 34-40), with `toolCall: AcpJsonObject` and optional `title` and `description`;
- `decodeAcpPermissionRequest(params)` (lines 103-158). It throws `RequestError.invalidParams()` when `sessionId` or the `options` array is missing. It silently skips options that lack an `optionId`, defaults `name` to the `optionId`, and defaults `kind` to `""`. It accepts any kind string, accepts an empty options array, and falls back from `params.toolCall` to `params.subject.toolCall`.
- The import `import type { AcpJsonObject } from "../session/session-types.js";` at line 11 is used only by `AcpPermissionRequest` (line 36). `isJsonObject`, `readString` and `RequestError` stay in use elsewhere in the file (lines 100, 173 and 179).

The two decoders disagree. The production schema rejects an unknown kind, an empty options array, and an option without `name`. The second decoder accepts all three.

*Reachability searches (Proven by inspection).*

- `git grep -n -w -e decodeAcpPermissionRequest -e AcpPermissionRequest -e AcpPermissionOption e9e1b74c3 -- .` over the whole snapshot, including Markdown, scripts and plugins. `decodeAcpPermissionRequest` and `AcpPermissionRequest` appear only in `acp-client.ts` and in `packages/provider-bridge-acp-next/src/client/acp-client.test.ts` (lines 12, 15, 197, 202, 234 and 477). Every other `AcpPermissionOption` hit is the `wire.ts` type: in `bridge.ts` of both ACP packages and in both `wire.ts` files.
- `git grep -n 'client/acp-client' e9e1b74c3 -- . ':!*.md'` finds only `bridge/agent-connection.ts:8`, which imports `connectAcpClient` and `AcpClient`. It does not import the decoder.
- `packages/provider-bridge-acp-next/package.json` is `"private": true` and exports only `.` (`src/index.ts`) and `./launch-spec`. `src/index.ts` re-exports nothing from `client/acp-client`. The plugin SDK entry `packages/plugin-sdk/src/provider-bridge-acp-next.ts` re-exports only `acpProviderBridge`, `registerAcpDialect`, the probe and the launch-spec schema, plus dialect types. No external plugin or older client can reach the decoder.
- No dynamic import, manifest, route, setting key or persisted format names the decoder. It is a plain TypeScript function in a private package, and the searches above cover every string reference.

*Why it exists (Hypothesis, with supporting evidence).* The private-repository history shows that the decoder arrived with the rebuilt ACP adapter in `fe1a02d7b9` ("Add an opt-in rebuilt ACP adapter…", 2026-10-09). The public history is squashed into `060950255` ("Publish Omnyo source"). The decoder's extra fields match the ACP SDK's **v2** `RequestPermissionRequest`: in `@agentclientprotocol/sdk@1.7.0`, `dist/v2/schema/types.gen.d.ts` declares `title`, `description` and `subject`, and an open `PermissionOptionKind = … | string`. The v1 schema in `dist/schema/types.gen.d.ts:631` declares the closed four-value enum that `wire.ts` uses. Omnyo speaks only v1: `client/capabilities.ts:4` sets `ACP_CLIENT_PROTOCOL_VERSION = 1`, `bridge/agent-connection.ts:428` sends it in `initialize`, and `client/capabilities.ts:147-156` `readAcpAgentCapabilities` throws `AcpUnsupportedProtocolVersionError` for an agent that answers in the newer generation's shape. The v2 shape therefore cannot reach the bridge today (Proven by inspection for the negotiation; the SDK files were read from the main checkout's `node_modules`, not from the snapshot, which has none).

*Why no option-kind decision is needed.* The sweep made this item conditional on deciding whether unknown option kinds should be tolerated. That decision does not gate the deletion. Production already follows the v1 rule, which matches the v1 specification, and deleting a decoder that nothing in production calls leaves that behavior unchanged. If Omnyo later adopts ACP v2, the open kind and `subject` field belong in `wire.ts` `acpRequestPermissionParamsSchema`, the decoder that runs. Keeping a dormant second decoder does not help that migration.

*Tests that use the decoder (observed), in `client/acp-client.test.ts`.*

1. Lines 196-230, "passes permission options with kinds outside the v1 enum to the handler". Its real contract is the transport: `connectAcpClient` hands the raw params, including an unknown kind (`allow_forever`), to the request handler unchanged, and writes the handler's result back. The decoder only reshapes the params before the assertion.
2. Lines 232-245, "rejects a permission request without options as invalid params". It shows that a `RequestError.invalidParams()` thrown by a handler reaches the wire as error code `-32602`. The "options are required" rule it also implies is the production schema's rule (`wire.ts:300`). No `wire.test.ts` case covers that rule today: `wire.test.ts:46` "opens the enums on a permission request's tool call too" is the only `acpRequestPermissionParamsSchema` test.
3. Line 477, inside `startFakeAgent` (lines 456-495). It decodes the fake agent's permission request to find the `allow_once` option. The fake agent (`bridge/fake-acp-agent.mjs:529-548` and `:571-584`) always sends valid v1 options, so the production schema can parse them.

*Maintenance cost today.* Anyone who audits or changes permission handling finds two decoders with different rules and has to work out that only one of them runs. The test named "kinds outside the v1 enum" suggests the product tolerates unknown kinds, but the product rejects them.

**Proposed end state and preservation argument**

- **What disappears:** `decodeAcpPermissionRequest`, the interfaces `AcpPermissionOption` and `AcpPermissionRequest` in `client/acp-client.ts`, and that file's `AcpJsonObject` type import.
- **What remains:** `wire.ts` `acpRequestPermissionParamsSchema` is the single decoder for `session/request_permission`. `connectAcpClient` keeps its identity-parser transport behavior.
- **Canonical owner:** `packages/provider-bridge-acp-next/src/wire.ts`.
- **Contracts and UI:** no production code, wire format, persisted data or UI state changes, because the deleted code has no production caller (reachability proof above). The permission prompt, the option choice in `pickPermissionOptionId` and the `-32602` reply for invalid params all stay as they are.
- **Test obligations kept:**
  - The transport pass-through of unknown kinds stays in `acp-client.test.ts`, asserted on the raw params. This is stricter than before, because nothing reshapes the params before the assertion.
  - The handler-error-to-wire-code behavior stays in `acp-client.test.ts`.
  - The production rule (options required and non-empty; unknown kinds rejected under v1) moves into `wire.test.ts`, where it tests the decoder that actually runs.
- **Non-goals:**
  - The item does not change the option-kind rule or add ACP v2 support.
  - It does not touch the classic `packages/provider-bridge-acp` package.
  - It does not merge `acp-client.ts` with anything.
- **Remaining uncertainty:** none for reachability. A search with no hits is not proof by itself, but the package is private, its `exports` map and `index.ts` exclude the file, and the whole-repository `git grep` covers every string reference.

**Expected gain and cost**

| Measure | Before | After | Basis |
|---|---|---|---|
| Permission-request decoders | 2 | 1 | Observed |
| Production lines removed in `client/acp-client.ts` | — | 72 physical, 57 non-blank (lines 28-41 and 103-159, plus line 11) | `awk` count over `git show e9e1b74c3:…/acp-client.ts`. The ranges give 71 physical and 56 non-blank lines, and the import adds one more |
| Production lines added | — | 0 | Projection |
| Test lines | — | About 20-30 changed in `acp-client.test.ts`, about 25-35 added in `wire.test.ts` | Projection |
| Optional step 5 | — | 4 more production lines (two unreferenced constants and their blank lines) | Observed |

Performance: none. The deleted code never runs in production.

The maintenance gain comes from one source of truth. A future ACP v2 migration, or any change to the kind rule, has one schema to edit, and its tests sit next to it.

**Execution steps**

1. **Reconfirm the baseline.** In the working checkout:
   - Run `git grep -n -w -e decodeAcpPermissionRequest -e AcpPermissionRequest -- .` and confirm that the only hits are `packages/provider-bridge-acp-next/src/client/acp-client.ts` and `acp-client.test.ts`.
   - Run `git grep -n 'client/acp-client' -- . ':!*.md'` and confirm that the only production importer is `bridge/agent-connection.ts`, importing `connectAcpClient` and `AcpClient`.
   - Confirm that `packages/provider-bridge-acp-next/package.json` is still private, with the same `exports`, and that neither `src/index.ts` nor `packages/plugin-sdk/src/provider-bridge-acp-next.ts` re-exports anything from `client/acp-client`.
   - **Re-plan** if any new production or SDK consumer appears, or if `handlePermissionRequest` no longer uses `acpRequestPermissionParamsSchema`.
2. **Move the production rule's coverage first.** In `packages/provider-bridge-acp-next/src/wire.test.ts`, inside the `describe` block that holds the test at line 46, add cases for `acpRequestPermissionParamsSchema.safeParse(...)`:
   - `{ sessionId: "s1", toolCall: { toolCallId: "t1" } }` (no `options`) gives `success === false`.
   - `{ sessionId: "s1", options: [] }` gives `success === false`. This is the `.min(1)` rule.
   - `{ sessionId: "s1", options: [{ optionId: "o1", name: "Yes", kind: "allow_forever" }] }` gives `success === false`. This documents the v1 closed enum; name the case so that it says the rule is v1's.
   - `{ sessionId: "s1", options: [{ optionId: "o1", name: "Yes", kind: "allow_once" }] }` gives `success === true`, with no `toolCall`, which is optional.
   - **Checkpoint:** these pass against the unchanged production schema. If any fails, stop: production behaves differently from this card's description.
3. **Rewrite the three decoder uses in `packages/provider-bridge-acp-next/src/client/acp-client.test.ts`.**
   - Imports (lines 7-17): remove `decodeAcpPermissionRequest` and `type AcpPermissionRequest`. Add `import { RequestError } from "@agentclientprotocol/sdk";`, which is already a dependency of the package. Add `import { acpRequestPermissionParamsSchema } from "../wire.js";`.
   - Test at lines 196-230: rename it to "passes request params to the handler unchanged, including option kinds outside the v1 enum". Replace `const requests: AcpPermissionRequest[] = []` with `const received: unknown[] = []`, and make the handler `(params) => { received.push(params); return { outcome: { outcome: "selected", optionId: "o1" } }; }`. Assert `expect(received).toEqual([{ sessionId: "s1", toolCall: { toolCallId: "t1", kind: "browse" }, options: [{ optionId: "o1", name: "Yes", kind: "allow_forever" }] }])`, which is the exact params fed at lines 213-217. Keep the `peer.written` assertion.
   - Test at lines 232-245: rename it to "answers a request handler's RequestError with its JSON-RPC error code". Make the handler `() => { throw RequestError.invalidParams(); }` and keep the fed message and the `{ id: 6, error: { code: -32602 } }` assertion.
   - Line 477 in `startFakeAgent`: replace `decodeAcpPermissionRequest(params)` with `acpRequestPermissionParamsSchema.parse(params)`. The `request.options.find((candidate) => candidate.kind === "allow_once")` logic stays as it is.
   - **Checkpoint:** run the package tests (see Verification). They must pass before you delete anything.
4. **Delete the decoder** in `packages/provider-bridge-acp-next/src/client/acp-client.ts`:
   - Delete the interfaces `AcpPermissionOption` and `AcpPermissionRequest` (lines 28-40) and the blank line that follows them.
   - Delete the function `decodeAcpPermissionRequest` (lines 103-158) and the blank line that follows it.
   - Delete the line `import type { AcpJsonObject } from "../session/session-types.js";` (line 11).
   - Keep the `isJsonObject, readString` import (still used at lines 173 and 179) and `RequestError` (still used by `acpErrorCode` at line 100).
5. **Optional adjacent cleanup, unrequested by the sweep; name it in the report.** `ACP_RESOURCE_NOT_FOUND_CODE` (line 19) and `ACP_REQUEST_CANCELLED_CODE` (line 21) have zero references anywhere at the snapshot (`git grep -n -w -e ACP_RESOURCE_NOT_FOUND_CODE -e ACP_REQUEST_CANCELLED_CODE e9e1b74c3 -- .` finds only their definitions). Delete them unless RF-079 already covers them. Leave `ACP_AUTH_REQUIRED_CODE`, `acpErrorCode` and `AcpRequestTimeoutError` in place: the tests use them, and `AcpRequestTimeoutError` runs in production at line 233.
6. **Format, check and review the diff.**
   - Format the three touched files with the repository formatter.
   - Run the checks below.
   - Inspect `git diff` and confirm that it touches only `client/acp-client.ts`, `client/acp-client.test.ts` and `wire.test.ts`.
   - Recount: `git diff --numstat -- packages/provider-bridge-acp-next/src/client/acp-client.ts` should show about 72 deletions (76 with step 5) and 0 additions.

**Verification and acceptance criteria**

The snapshot has no `node_modules`, so none of these commands were run for this card. The script names come from the snapshot's `packages/provider-bridge-acp-next/package.json` (`test`, `typecheck`, `lint`) and the root `package.json` (`format`, `format:check` via `oxfmt`). Run them from the repository root, `$OMNYO_CHECKOUT` or the executing worktree:

- `pnpm --filter @omnyo/provider-bridge-acp-next test` runs `vitest run --config vitest.config.ts` over `src/**/*.test.ts`. Expected result: all tests pass, including the rewritten `acp-client.test.ts` cases, the new `wire.test.ts` cases and the existing `bridge.test.ts` permission flows.
- `pnpm --filter @omnyo/provider-bridge-acp-next typecheck` runs `tsc --noEmit`. Expected result: no errors, and in particular no dangling reference to `AcpJsonObject` or the deleted interfaces.
- `pnpm --filter @omnyo/provider-bridge-acp-next lint` runs oxlint over `src`. Expected result: clean.
- `pnpm exec oxfmt <the three touched files>`, then `pnpm exec oxfmt --check <the same files>`. The root script `format:check` is `oxfmt . --check`; the per-file form is the usual oxfmt CLI usage but is unconfirmed here.
- Plugin-SDK typecheck: the SDK entry does not import the deleted symbols, so no SDK build is required. If you want the extra assurance, `pnpm --filter @omnyo/plugin-sdk typecheck` is the obvious command, but this card did not confirm that the plugin-sdk package defines a `typecheck` script.

Acceptance criteria:

- **Structural:** `git grep -n -w -e decodeAcpPermissionRequest -e AcpPermissionRequest -- .` returns nothing. `git grep -n 'interface AcpPermissionOption' -- packages/provider-bridge-acp-next` returns nothing, so the only `AcpPermissionOption` left in the package is the `wire.ts` type.
- **Behavioral:** the pass-through test still feeds an `allow_forever` option and asserts the raw params unchanged. The handler-error test still asserts `-32602` on the wire. `wire.test.ts` asserts that missing, empty and unknown-kind options are rejected and that a valid v1 request is accepted.
- **No assertion is weakened:** the three tests keep the fed messages and the `peer.written` assertions, and the fake-agent test keeps the `requires_action` work-state sequence at lines 584-589.
- **No UI or performance checks apply:** the deleted code never runs in production.

**Rollback and stop conditions**

- **Rollback:** the change is three files in one package with no data, wire or SDK effect. Reverting the single commit restores the old state.
- **Stop if:**
  - any production, SDK or plugin consumer of `decodeAcpPermissionRequest` or of the `acp-client.ts` permission interfaces appears in step 1;
  - the owner decides, before this lands, that Omnyo should adopt ACP v2 or tolerate unknown option kinds now. Then make that change in `wire.ts` `acpRequestPermissionParamsSchema`, adjust the new `wire.test.ts` unknown-kind case to the new rule, and still delete the duplicate decoder;
  - a new `wire.test.ts` case fails against the unchanged schema in step 2, which means production behaves differently from this card. Re-investigate `handlePermissionRequest` before you continue;
  - RF-001 is decided the other way, retiring ACP Next. Drop this card.
- **Smaller alternative:** if the test rewrite meets resistance, delete only the function and interfaces and keep the three tests by inlining a local test helper. This is not recommended, because it keeps a second rule alive in the tests.
