# RF-041 — Remove the plugin SDK's scheduled compatibility shelf: provider-bridge aliases, the Claude task-tool copy, retired protocol names and the runtime-only `experimental_useSidebarThreadActions` hook

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The batch is real and the code is dead within the repositories that can be inspected. Three corrections to the sweep report change the plan:
  1. `interactionRequestPayloadSchema` is not unreferenced. Three `plugins/provider-codex` test files import it from `@omnyo/plugin-sdk/provider-bridge`, and forkable plugins may not import `@omnyo/domain` instead. It stays out of the batch.
  2. The host has no "minimum supported plugin SDK" to raise. Plugins declare open-ended floors such as `>=0.6.44`, and `isPluginSdkRangeSatisfied` accepts them on any later SDK, including 1.0.0. No version bump protects old plugin bundles from the one runtime removal. Pairing the batch with a new refusal detector would add machinery, so the card does not propose one.
  3. The SDK test harness's `sidebarActionCalls` recorder has a second writer: the `experimental_useSidebarThreadSplit` fake pushes into it on pointer-down. That writer has to be rewritten, not left dangling.
- **Potential:** medium. The batch removes one dead compatibility mechanism in full: about 380 to 425 production lines, about 320 test lines and about 110 doc lines. Most of the burden is the deprecated hook's real implementation in `apps/app` and its fake in the SDK harness. Every sidebar or thread-action change still has to keep both working.
- **Confidence:** high for the inventory and the absence of consumers in the two inspected repositories. Medium for the runtime-impact claim about unknown third-party plugins, which this audit cannot inspect.
- **Readiness:** decision-needed. Alex has to choose the version that carries the break and accept one runtime effect. See the investigation gate in step 0.
- **Effort:** about 1 day of implementation and verification once the decision is made. The work touches `packages/plugin-sdk`, `packages/provider-bridge-protocol`, `apps/app`, guide references in `plugins/omnyo-guide` and `docs/api_to_audit.md`.
- **Risk:** low to medium. The provider-bridge, ACP, conformance and `disallowedTools` removals are build-time only, because already-built host artifacts carry their own SDK copy. The only runtime-visible removal is `experimental_useSidebarThreadActions` on the app plugin runtime. A plugin bundle built against SDK 0.6.33 or earlier that calls it will fail inside its slot's error boundary.
- **Prerequisites:** the owner decision in step 0. No other RF item has to land first.
- **Related or overlapping items:**
  - RF-001 (retire classic ACP) edits the same files. It re-points `packages/plugin-sdk/src/provider-bridge.ts:416-420`, which this card deletes. It also turns `@omnyo/plugin-sdk/provider-bridge/acp-next` into a deprecated alias that RF-001 says should join this batch. Whichever lands second rebases onto the first. If RF-001 lands first, the `AcpAgentProfile` alias exists in only one file, and the acp-next alias can be added to this batch. Count the 9 lines of `provider-bridge-acp-next.ts:99-107` once.
  - RF-035 (retire host `sidebar.*` preferences) and RF-087 (thread action keyboard table) touch neighbouring sidebar and thread-action code in `apps/app`, but they share no deleted lines with this card.
- **Why this rank:** the batch is a whole retirement with a written schedule, a guard test and no first-party caller. It is cheaper than most items of its size because the successor APIs already exist and every first-party plugin has moved to them. It ranks below the large engine and identity retirements because the production saving is moderate and it needs a release decision.

**Context and evidence**

*Snapshot.* All facts come from commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The read-only snapshot worktree named for this audit no longer existed when this card was written, so every file was read with `git -C $OMNYO_CHECKOUT show e9e1b74c3:<path>` and searched with `git grep <pattern> e9e1b74c3 -- <paths>`. The private plugin repository was searched at `$OMNYO_PLUGIN_CHECKOUT` HEAD `7edbc502e2fc` (2026-11-26). No test suite ran, because the snapshot has no `node_modules`.

*What the subsystem is.* `@omnyo/plugin-sdk` (version `0.6.57`, `packages/plugin-sdk/package.json`; `PLUGIN_SDK_VERSION` in `packages/domain/src/plugin-sdk-version.ts:1`) is the only package a forkable plugin may import (`docs/forkable-plugins.md:7`). The private fork does not publish it to npm; plugins install the packed tarball. `docs/api_to_audit.md:574-650`, "## Scheduled removals (next major)", lists names kept only because SDK 0.4.x published them. The guard test `packages/plugin-sdk/src/__tests__/provider-bridge-scheduled-removals.test.ts` (100 lines) parses that doc section and fails if any listed name stops being exported.

*Inventory, observed at the snapshot (Proven by inspection):*

| Name | Where | Lines | Current consumers |
|---|---|---|---|
| 10 unprefixed `@omnyo/domain` re-exports: `acpNativeReasoningSchema`, `acpPermissionCliSchema`, `acpReasoningCliSchema`, `extensionKindSchema`, `isExtensionKind`, `isUserQuestionPendingInteractionPayload`, `isUserQuestionPendingInteractionResolution`, `providerRecoveryKindValues`, `threadEventItemPresentationSchema`, `threadEventSearchModeSchema` | `packages/plugin-sdk/src/provider-bridge.ts:301-303, 314-315, 326, 328, 331-333` (value export list from `@omnyo/domain`) | 10 | None through the SDK. Each definition keeps 2 to 8 other consumers in `apps/` and `packages/`, so only the facade line goes. |
| `interactionRequestPayloadSchema` | `provider-bridge.ts:327` | 1 | **Kept.** `plugins/provider-codex/src/bridge/bridge.calibration.test.ts:10`, `bridge.elicitation.test.ts:10` and `src/interactive-requests.test.ts:11` import it from `@omnyo/plugin-sdk/provider-bridge`. |
| `hostDaemonAcpLaunchSpecSchema`, `normalizeHostDaemonAcpLaunchSpec`, `HostDaemonAcpLaunchSpec` | `provider-bridge.ts:398-420` (section header "5. Scheduled removals (next major)" and the ACP alias block) | ~23 | None. |
| `claudeTaskToolNameSchema`, `claudeTaskToolOutputSchema`, `ClaudeTaskToolOutput` | `provider-bridge.ts:422-432` re-exporting `packages/plugin-sdk/src/claude-task-tools.ts` (whole file) | 11 + 65 | None. `provider-claude-code` owns its own vocabulary. |
| `AcpAgentProfile` (deprecated type alias) | `packages/plugin-sdk/src/provider-bridge-acp.ts:71-78` and `provider-bridge-acp-next.ts:99-106` | 2 × 9 | None. |
| `CONFORMANCE_ASSEMBLED_EVENT_METHOD` | `packages/provider-bridge-protocol/src/conformance/types.ts:7`, re-exported at `conformance/index.ts:29` and `packages/plugin-sdk/src/provider-bridge-testing.ts:33` | 4 | None. The conformance kit reads nothing under that method. |
| `disallowedTools` session-construction param | `packages/provider-bridge-protocol/src/requests.ts:38` in `sessionConstructionFields`, shared by `threadStartParamsSchema`, `threadResumeParamsSchema` and `threadForkParamsSchema` (all `.passthrough()`) | 1 | No producer. `plugins/provider-claude-code/src/bridge/bridge.ts:511-516, 1748-1753` and `sdk-session.ts:38, 285` use an unrelated `sessionOptions.disallowedTools` passed to the Claude Agent SDK. |
| `PluginSidebarThreadActions` interface (`@internal`) | `packages/plugin-sdk/src/app-contract.ts:1713-1768` | 57 | The hook below and the harness fake. |
| `PluginSdkApp.experimental_useSidebarThreadActions` member | `app-contract.ts:4502-4510` | 9 | The app implementation. |
| `experimental_useSidebarThreadActions` facade | `packages/plugin-sdk/src/app.ts:283-286` (`runtimeFunction`) | 5 | None in either repository; see the vendored bundle note below. |
| `useSidebarThreadActions` real implementation | `apps/app/src/lib/plugin-sidebar-hooks.ts:515-649`, plus about 18 import lines used only by it (`useStore`, `useIsCompactViewport`, `useThreadActions`, the `thread-state-mutations` block, `useRouteNavigate`, `getThreadConversationCollapsedAtom`, `getPendingChatSnapshot`, `isPendingChatId`, `useSetRootComposeProjectId`, `openThreadInSplit`, `getRootComposeRoutePath`, `getThreadRoutePath`, the `PluginSidebarThreadActions` type) | ~154 | Wired at `apps/app/src/lib/plugin-sdk-app-impl.tsx:55, 139` and `apps/app/.ladle/plugin-sdk-app.ts:34`. |
| Harness fake and recorder | `packages/plugin-sdk/src/testing/app.tsx:333-334, 493-502 (SidebarActionCall), 1745-1748, 2450-2451, 2693, 2757-2792, 3215-3216, 3325, 3343` | ~62 | Second writer at `testing/app.tsx:1799`: the `experimental_useSidebarThreadSplit` fake's `splitProps.onPointerDown` pushes `{ method: "open", threadId }`. |

The import-only counts in `plugin-sidebar-hooks.ts` were measured by counting each symbol's whole-word occurrences in the file and inside lines 515-649. Every listed symbol occurs only at its import and inside the hook. The helpers themselves stay in use elsewhere: `openThreadInSplit` in 5 `apps/app/src` files, `useSetRootComposeProjectId` in 9, `getPendingChatSnapshot` in 3. `ThreadActionsProvider.archiveEnvironmentThreads` stays because `experimental_useArchiveEnvironmentThreads` uses it.

*Consumer searches (Proven by inspection; a search with no hits is not proof of absence outside these scopes):*

- `git grep -n "useSidebarThreadActions\|PluginSidebarThreadActions\|SidebarActionCall\|sidebarActionCalls" e9e1b74c3 -- .` returns only the implementation, its wiring, the Ladle shim, the SDK contract, facade and harness, the SDK parity test, app tests and docs or guide references. No file under `plugins/` calls it.
- `git grep` for every provider-bridge, ACP, conformance and `disallowedTools` name in the table, over the whole snapshot, returns only the definitions, the guard test, `docs/api_to_audit.md` and `plugins/omnyo-guide/skills/omnyo-plugin-authoring/references/provider-bridge-api-index.md:56-57, 127, 145, 225, 245, 329, 419, 441`.
- `git -C $OMNYO_PLUGIN_CHECKOUT grep` for all names, excluding `node_modules`, matches only two places. The first is `chat-groups/evidence/project-groups-actions-2026-10-09/*`, which is archived evidence text. The second is the vendored bundle `alex-fixes/sidebar/vendor/app.js`, last changed in `df571a71` on 2026-11-06. That bundle destructures `experimental_useSidebarThreadActions:vz` from the runtime. The minified identifier `vz` occurs exactly once (`grep -o "[^a-zA-Z0-9_$]vz[^a-zA-Z0-9_$]"` gives one `:vz,`), so the bundle binds the hook but never calls it. A missing runtime member leaves `vz` undefined and does not throw.
- Private plugin SDK floors (`engines.omnyoPluginSdk`) are all `>=0.6.45` or higher. One plugin, `quiet-notifications/package.json:52`, declares `>=0.6.45 <0.7.0`.

*How plugins get these names at run time (Proven by inspection of build configuration; not run):*

- Host and server artifacts bundle SDK subpaths. In `packages/plugin-build/src/build-plugin-host.ts`, `reject-private-omnyo-host-imports` returns `undefined` for public SDK specifiers, so esbuild resolves and inlines them. In `build-plugin-server.ts:243-320`, only the bare `@omnyo/plugin-sdk` root is external; subpaths resolve to the installed SDK. An already-built bridge therefore keeps every provider-bridge name it was built with. Removing these names breaks only a rebuild against the new SDK, at type-check or bundle time.
- The app subpath is provided at run time. `@omnyo/plugin-sdk/app` is shimmed to `globalThis.__omnyoPluginRuntime.pluginSdkApp` (`packages/plugin-build/src/runtime-shims.mjs:1`; the shim's generated preamble is visible at the top of the vendored bundle), which `apps/app/src/lib/plugin-sdk-app-impl.tsx` fills. Removing `experimental_useSidebarThreadActions` from that object is the batch's only change that can reach an installed bundle.
- The hook's types were stripped from the published declarations in SDK 0.6.34. In the retired private history, commit `f549a09d4e` (2026-10-09, "Thread action registry…") added it to `RUNTIME_ONLY_COMPAT_EXPORTS` in `packages/plugin-sdk/src/__tests__/frontend-exports.test.ts:5-8` and moved the SDK from 0.6.33 to 0.6.34. Only a bundle built against SDK 0.6.33 or earlier, or untyped JavaScript, can still call it.
- A plugin slot render error is contained by `PluginSlotBoundary` in `apps/app/src/components/plugin/PluginSlotMount.tsx:113-156` (`getDerivedStateFromError`, `componentDidCatch`). That an old caller fails inside this boundary in every slot kind is a **Hypothesis**; this audit did not confirm the boundary wraps every surface that could call the hook.

*Host compatibility rule (Proven by inspection).* `apps/server/src/services/plugins/sdk-compat.ts:4-15`, `isPluginSdkRangeSatisfied`, accepts a range when the running SDK satisfies it. If it does not, the rule still accepts the range when the range's minimum has the same major as the running SDK and is not newer. `update-resolver.ts:258-276` applies it to `engines.omnyoPluginSdk`. Consequences, computed from that rule:

| Release carrying the batch | `>=0.4.102 >=0.6.44` (most first-party plugins) | `>=0.6.45 <0.7.0` (`quiet-notifications`, private repo) |
|---|---|---|
| 0.7.0 | accepted (satisfied) | accepted (same-major floor rule) |
| 1.0.0 | accepted (satisfied) | **refused** (major 0 differs from 1) |

There is no host-side minimum SDK below which a plugin is refused. A major bump would not refuse an old bundle that calls the hook either, because its open-ended range stays satisfied.

*Precedent.* `docs/api_to_audit.md:516-545`, "## Compatibility windows", records earlier removals of published names inside 0.x releases ("Removed outright from a published subpath, with no alias and no throwing stub"). The "next major" wording in the schedule is therefore the doc's chosen policy, not a constraint any tool enforces.

*Maintenance cost today.* Any change to thread opening, splitting, pinning, read state, archive or delete flows has to keep `useSidebarThreadActions` in `apps/app` behaving like its successors. Each `PluginSidebarThreadActions` method also has to stay mirrored in the harness fake. `plugin-sidebar-hooks.test.tsx` keeps about 210 lines of tests for a hook nothing calls. Each SDK release carries a doc-parsing guard test, two deprecated ACP aliases and a 65-line zod copy of a vocabulary the claude-code plugin now owns.

**Proposed end state and preservation argument**

*What disappears:*

- `claude-task-tools.ts`, the provider-bridge section 5 aliases, 10 domain re-export lines, both `AcpAgentProfile` aliases, `CONFORMANCE_ASSEMBLED_EVENT_METHOD` and its two re-exports, and the `disallowedTools` field.
- `PluginSidebarThreadActions`, `PluginSdkApp.experimental_useSidebarThreadActions`, the `app.ts` facade, the `apps/app` implementation and its wiring, the Ladle shim entry, and the harness fake, `SidebarActionCall` type and `sidebarActionCalls` recorder.
- The guard test `provider-bridge-scheduled-removals.test.ts`, the hook's entry in `RUNTIME_ONLY_COMPAT_EXPORTS`, the doc section, and the matching guide index entries.

*What remains:*

- `interactionRequestPayloadSchema` stays on `@omnyo/plugin-sdk/provider-bridge`. If Alex wants the schedule mechanism to survive for future names, keep the doc section with only the remaining entries and keep the guard test. Otherwise move this one name out of the schedule, because it has a first-party consumer, and delete the section and guard test.
- `useComposerView` stays in `RUNTIME_ONLY_COMPAT_EXPORTS`. It is a runtime-only compatibility export but is not on the schedule.
- The 0.4.16 rename diagnostics stay. They give useful refusal messages for old declaration keys: `packages/plugin-sdk/src/internal/host-policy.ts:1522-1561, 2356-2367` and `packages/plugin-sdk/src/internal/plugin-app-collector.ts:279-298`.
- All successor APIs are unchanged: `experimental_acpLaunchSpecSchema` / `AcpLaunchSpec` on `provider-bridge/acp`, `app.slots.experimental_threadAction`, `experimental_useThreadActions`, the thread action components, `experimental_useArchiveEnvironmentThreads`, `useSdk().threads` and `experimental_useAppNavigate().toThread` / `toCompose`.
- `experimental_useSidebarThreadSplit` keeps its contract (`app-contract.ts:2102-2127`). Only its test fake's pointer-down handler stops recording into the removed array.

*Preservation argument.*

- No supported first-party feature uses a removed name. Every first-party plugin already uses the successors, and the doc has scheduled the removal since the names were deprecated.
- Persisted data is unaffected: none of these names is stored.
- The host-daemon and bridge wire is unaffected. The protocol schemas are `.passthrough()`, so a stray `disallowedTools` key from an older sender would still parse and be ignored, and no sender exists.
- UI is unaffected. The host's own sidebar and thread menus use `ThreadActionsProvider`, not the removed hook.
- Performance is neutral. Slightly less code ships in the SDK runtime and the app bundle; this is not measured.
- Non-goals: no new SDK-floor refusal detector, no change to `isPluginSdkRangeSatisfied`, no change to the successors, no removal of `useComposerView`.

*Remaining uncertainty.* Unknown third-party plugins cannot be inspected. A bundle built against SDK 0.6.33 or earlier that calls the hook will throw "is not a function" at render after this change. Rebuilding against the current SDK already surfaces the problem as a type error, because the declarations were stripped in 0.6.34.

**Expected gain and cost**

Counts below are line ranges measured at the snapshot. The net figures are projections.

| Scope | Removed | Added | Basis |
|---|---|---|---|
| Handwritten production | ~380 to 425 | ~1 to 3 | `claude-task-tools.ts` 65; `provider-bridge.ts` 35 (lines 398-432) + 10; ACP aliases 18; conformance 4; `requests.ts` 1; `app-contract.ts` 57 + 9; `app.ts` 5; `testing/app.tsx` ~62; `plugin-sidebar-hooks.ts` 136 + ~18 imports; wiring 3. About a quarter of these lines are doc comments. The addition is the rewritten split-fake handler. |
| Tests | ~320 | ~6 to 10 | Guard test 100; `apps/app/src/lib/plugin-sidebar-hooks.test.tsx:1138-1309` (172) and `:745-783` (39) plus mocks only those tests use; one parity-test entry; the probes in `PluginAppOverlays.test.tsx:89-112, 293-306` and `PluginSidebarFooterCards.test.tsx:92-115, 405-418` are rewritten, not deleted. |
| Docs and guide | ~110 | ~10 | `docs/api_to_audit.md:574-650` (77), "Thread creation placement" at 5371, the `experimental_archiveEnvironmentThreads` section at 5412-5417, the action paragraphs inside 3825-3981, line 2644; guide index entries. Added: one "Removed outright" bullet in "Compatibility windows". |

*Mechanisms, before and after:* before, there is one compatibility shelf, three files of aliases, one real deprecated hook with a fake and a recorder, and one doc-parsing guard test. After the change, none of these remain, apart from the single kept schema export.

*Maintenance example:* changing how opening a thread in a split behaves currently means editing `ThreadActionsProvider`, re-checking `useSidebarThreadActions.open`, its fake and its seven tests. Afterwards, only the thread action registry path exists.

*Cost:* one breaking SDK release decision, about one day of work, and an accepted runtime break for any unseen bundle built against SDK 0.6.33 or earlier that calls the hook.

**Execution steps**

0. **Investigation and decision gate (do not edit before this is answered).** Ask the owner, with the evidence above:
   - (a) Which release carries the batch? The options are **0.7.0**, a 0.x minor following the "Compatibility windows" precedent that keeps every installed private plugin loadable, or **1.0.0**. With 1.0.0, `quiet-notifications` (`>=0.6.45 <0.7.0`) is refused until its range is widened, and the doc wording is honoured literally.
   - (b) Does Alex accept that an unseen plugin bundle built against SDK 0.6.33 or earlier that calls `experimental_useSidebarThreadActions` will fail inside its slot boundary, with no new refusal detector?
   - (c) Should `interactionRequestPayloadSchema` stay, with the schedule section kept for future names, or move out of the schedule so the section and guard test go?

   Stop if (b) is declined. The alternative is to keep the hook and execute only the build-time removals, which cuts the production gain to about 165 lines.
1. **Reconfirm the snapshot.** On the branch you will edit, rerun:
   - `git grep -n -E "useSidebarThreadActions|PluginSidebarThreadActions|SidebarActionCall|sidebarActionCalls|hostDaemonAcpLaunchSpec|HostDaemonAcpLaunchSpec|normalizeHostDaemonAcpLaunchSpec|claudeTaskTool|ClaudeTaskToolOutput|AcpAgentProfile|CONFORMANCE_ASSEMBLED_EVENT_METHOD" -- .`
   - `git grep -n "disallowedTools" -- apps packages`
   - Each of the 10 domain value names with `git grep -n -w <name> -- plugins`.
   - The same searches with `git -C $OMNYO_PLUGIN_CHECKOUT grep … -- . ':!**/node_modules/**'`.

   Re-plan if any production file in either repository now calls a listed name. Also re-plan if a test outside the files named here uses one, if RF-001 has landed (then rebase onto its `provider-bridge.ts` and ACP subpath layout), or if the vendored `alex-fixes/sidebar/vendor/app.js` now calls the hook (more than one occurrence of its local binding).
2. **Checkpoint A: build-time names only (no runtime effect on installed plugins).**
   1. Delete `packages/plugin-sdk/src/claude-task-tools.ts`.
   2. In `packages/plugin-sdk/src/provider-bridge.ts`, delete section 5 (lines 398-432: the header comment, the `@omnyo/provider-bridge-acp/launch-spec` alias exports and the `claude-task-tools.js` re-exports). From the `@omnyo/domain` value export list (lines ~290-340) remove the 10 names in the inventory table and keep `interactionRequestPayloadSchema`. The section 5 comment at lines 406-407, which says the domain re-exports "sit in section 4 with their neighbours", is deleted along with section 5.
   3. Delete the `@deprecated` `AcpAgentProfile` alias and its comment in `packages/plugin-sdk/src/provider-bridge-acp.ts:71-78` and `provider-bridge-acp-next.ts:99-106`.
   4. Delete `CONFORMANCE_ASSEMBLED_EVENT_METHOD` from `packages/provider-bridge-protocol/src/conformance/types.ts:7`, `conformance/index.ts:29` and `packages/plugin-sdk/src/provider-bridge-testing.ts:33`.
   5. Delete `disallowedTools` from `sessionConstructionFields` in `packages/provider-bridge-protocol/src/requests.ts:38`. Do not touch `provider-claude-code`'s `sessionOptions.disallowedTools`; it is an unrelated Claude Agent SDK option.
   6. Verify with the Checkpoint A commands below before continuing.
3. **Checkpoint B: the runtime-only sidebar actions hook.**
   1. `apps/app/src/lib/plugin-sidebar-hooks.ts`: delete `useSidebarThreadActions` (lines 515-649) and the imports that only it used (listed in the inventory table; recheck each with a whole-word search after deleting). Keep `useCallback` and `useMemo`; other code in the file uses them.
   2. `apps/app/src/lib/plugin-sdk-app-impl.tsx`: remove the `useSidebarThreadActions` import (line 55) and the `experimental_useSidebarThreadActions` entry (line 139). The object's `satisfies PluginSdkApp` check then enforces the contract change.
   3. `apps/app/.ladle/plugin-sdk-app.ts:34`: remove `experimental_useSidebarThreadActions` from the destructured runtime.
   4. `packages/plugin-sdk/src/app-contract.ts`: delete `PluginSidebarThreadActions` and its doc comment (1713-1768) and the `experimental_useSidebarThreadActions` member and its comment (4502-4510). Fix any `{@link PluginSidebarThreadActions}` left elsewhere (search for it).
   5. `packages/plugin-sdk/src/app.ts:283-286`: delete the `runtimeFunction("experimental_useSidebarThreadActions")` export.
   6. `packages/plugin-sdk/src/testing/app.tsx`: delete the `sidebarActions` and `sidebarActionCalls` slot-env fields (333-334), `SidebarActionCall` (493-502), the fake hook (1745-1748), the inspection field and its doc (2450-2451), the array (2693), the `sidebarActions` object (2757-2792) and the three places that pass them along (3215-3216, 3325, 3343). Change the `experimental_useSidebarThreadSplit` fake's `onPointerDown` at line 1799 to a no-op, `onPointerDown: () => {}`. No test reads that record. The field was `@internal` and stripped from the published declarations, so no published plugin test can read it either. Keep a defined handler so `splitProps` keeps the same shape.
   7. `packages/plugin-sdk/src/__tests__/frontend-exports.test.ts:7`: remove `"experimental_useSidebarThreadActions"` from `RUNTIME_ONLY_COMPAT_EXPORTS`, keeping `"useComposerView"`.
   8. Tests in `apps/app`:
      - Delete `describe("useSidebarThreadActions", …)` at `plugin-sidebar-hooks.test.tsx:1138-1309` and the test "opens a starting chat through its pending route" at `:745-783`. Delete mocks that become unused (`mutations.pinThreadAsync` / `unpinThreadAsync` / `updateThreadAsync`, and the `requestArchive`, `toggleRead` and `requestDelete` mock entries), after checking with a whole-word search that nothing else uses them.
      - In `PluginAppOverlays.test.tsx:89-112, 293-306` and `PluginSidebarFooterCards.test.tsx:92-115, 405-418`, keep the obligation: a portaled overlay or footer card can reach host thread-action context. Replace the probe with the successor that reads the same `ThreadActionsProvider` context, `pluginSdkAppImplementation.experimental_useArchiveEnvironmentThreads()`, and assert `typeof … === "function"`. Keep the test ids, renamed to `overlay-archive-environment-threads` and `footer card-archive-environment-threads`.
   9. Verify with the Checkpoint B commands below.
4. **Checkpoint C: docs, guide and guard.**
   1. `docs/api_to_audit.md`:
      - Remove the executed entries from "## Scheduled removals (next major)" (lines 574-650). Under decision (c), either keep the section with `interactionRequestPayloadSchema` and correct the "All fifteen values … unreferenced by any first-party plugin" sentence, or delete the section.
      - Add a "Removed outright" bullet under "## Compatibility windows" (516 onward) naming every removed name, its subpath, its successor and the release from step 0.
      - Remove "## Thread creation placement" (5371) and "## `PluginSidebarThreadActions.experimental_archiveEnvironmentThreads`" (5412-5417).
      - Trim the action-only paragraphs from "## `experimental_useSidebarThreads` / `experimental_useSidebarThreadActions`" (3825 onward). Keep `experimental_useSidebarThreads`, and rename the heading to drop the removed hook.
      - Remove the remark on the deprecated hook at ~4289 and the parenthesis at 2644.
   2. If the section is deleted, delete `packages/plugin-sdk/src/__tests__/provider-bridge-scheduled-removals.test.ts`. If the section is kept, keep the test and drop its second `it` ("still resolves the 0.4.15 names whose definitions moved"), whose four names no longer exist.
   3. `plugins/omnyo-guide/skills/omnyo-plugin-authoring/references/provider-bridge-api-index.md`: remove lines 56-57, 127, 145, 225, 245, 329, 419 and 441, and any of the 10 domain names it lists. In `frontend-api-index.md:91-92, 405` and `frontend-testing-api-index.md:20-21`, remove the hook and `SidebarActionCall` entries. `apps/server/test/services/plugins/plugin-authoring-docs.test.ts` compares these indexes with `packages/plugin-sdk/bundled-types/*.d.ts` (lines 152-166), so it fails on any stale or missing entry.
5. **Version.** Run `node scripts/bump-plugin-sdk.mjs --minor` (for 0.7.0) or `--major` (for 1.0.0), as decided in step 0, from the repository root. The script updates `packages/plugin-sdk/package.json` and `packages/domain/src/plugin-sdk-version.ts` together. Do not edit plugin `engines.omnyoPluginSdk` floors: no plugin newly needs the bumped SDK. If 1.0.0 was chosen, tell Alex that `quiet-notifications` in the private plugins repository needs its range widened before it can load.
6. **Final pass.** Review the complete diff for leftovers: run `git grep` again with the step 1 pattern, which should leave only the "Compatibility windows" bullet and, if kept, the schedule entry for `interactionRequestPayloadSchema`. Recount removed lines against the table above and report the actual figures.

**Verification and acceptance criteria**

All commands run from the repository root `$OMNYO_CHECKOUT` or its working lane. The script names were read from the package manifests at the snapshot. None was run for this card.

- Checkpoint A:
  - `pnpm exec turbo run test --filter=@omnyo/plugin-sdk`. `turbo.json:1025-1031` makes `@omnyo/plugin-sdk#test` depend on `@omnyo/plugin-sdk#build:types`, so the bundled declarations the parity and guard tests read are rebuilt first.
  - `pnpm --filter @omnyo/plugin-sdk typecheck`
  - `pnpm --filter @omnyo/provider-bridge-protocol typecheck`
  - `pnpm --filter @omnyo/provider-bridge-protocol test`
  - `pnpm --filter omnyo-plugin-provider-codex test`, to prove the kept `interactionRequestPayloadSchema` import still resolves.
  - `pnpm --filter omnyo-plugin-provider-claude-code typecheck`
- Checkpoint B:
  - `pnpm --filter @omnyo/app typecheck`
  - `pnpm --filter @omnyo/app test -- src/lib/plugin-sidebar-hooks.test.tsx src/components/plugin/PluginAppOverlays.test.tsx src/components/plugin/PluginSidebarFooterCards.test.tsx`
  - The SDK test command again. `frontend-exports.test.ts` must show the runtime and declared exports equal apart from `useComposerView`.
- Checkpoint C:
  - `pnpm --filter @omnyo/server test -- test/services/plugins/plugin-authoring-docs.test.ts`
- Before merge:
  - `pnpm typecheck` (turbo across the workspace)
  - `pnpm lint`
  - `pnpm format:check`
  - `pnpm check:plugin-forks` (`scripts/check-plugin-forks.mjs`; it builds the listed plugins against the packed SDK)
- Acceptance:
  - All the commands above pass.
  - `git grep` finds no removed name outside the "Compatibility windows" record.
  - `PluginSdkApp` no longer contains the hook, and `pluginSdkAppImplementation` still satisfies it.
  - The thread list, thread menus and Ladle stories behave unchanged; Alex checks the UI himself.
  - In the private plugins repository, `git -C $OMNYO_PLUGIN_CHECKOUT grep` still shows no caller. Optionally, load the `alex-fixes` plugin once against the new runtime to confirm that the bound-but-unused `vz` does no harm. This is a manual check; whether the dev loop for it is reachable is unconfirmed.

**Rollback and stop conditions**

- *Rollback:* revert the batch commit or commits. No data, migration or wire format changes, so a revert fully restores behaviour. If the SDK version was already published to plugin authors, publish a follow-up minor that restores the removed names. Do not reuse the version number.
- *Stop and re-plan if:*
  - Step 1 finds a production caller of any removed name in either repository.
  - RF-001 has changed `provider-bridge.ts` or the ACP subpaths since this snapshot.
  - `plugin-authoring-docs.test.ts` or `check:plugin-forks` shows a first-party plugin or fork needing a removed name.
  - Removing the hook makes a non-test `apps/app` module unused. That would mean the hook was the last consumer of a helper this card assumed was shared; re-measure and fold that helper into the plan only with evidence.
- *Stop entirely if* Alex declines decision (b). Then execute only Checkpoint A and the matching doc edits.
