# RF-101 — Give composer selection settling one sequence owner

## Rank and disposition

**Potential: high within the client slice. Confidence: high. Readiness: ready after focused characterization. Effort: medium (roughly 1–3 days). Risk: medium-to-high because ordering and committed React state are observable through the plugin composer API.** Rechecks prior §11. Independent of RF-102/103/104. Attachment submission lifecycle is excluded.

## Context and evidence

Snapshot: `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e`. The new-thread and existing-thread composers both expose `setSelection` through the plugin composer host. Each keeps `pendingSelectionRef`, creates one deadline per executing request, waits for committed state, applies an execution tuple or ordered provider/model/reasoning/tier changes, sets permission mode, waits for final settlement and returns the selection.

- `apps/app/src/components/promptbox/NewThreadComposer.tsx:2301–2442` defines `applySelection` and `setSelection` in 142 lines, including 119 nonblank lines.
- `apps/app/src/views/thread-detail/ThreadDetailPromptArea.tsx:1224–1321` repeats the sequence and queue in 98 lines, including 79 nonblank lines.
- A comparison of those exact trimmed-nonblank ranges found 65 matching lines in order. The matching text supports sharing the sequencing mechanism. The local policies still differ.
- `apps/app/src/components/promptbox/composer-selection-settle.ts`: `useCommittedComposerState`, `createCommittedStateObserver`, `waitForSettledComposerState`, `waitUntilComposerStateSettled`, `readExecutionSelection`, `readExecutionTuple` already own committed-state/timeout semantics.
- Consumers/tests: `components/plugin/PluginNewThreadComposer.test.tsx`. `views/thread-detail/ThreadDetailPromptArea.test.tsx` (“starts a handoff when a plugin sets another provider” and same-provider changes). `composer-selection-settle.test.ts` (latest-state return at deadline and no-published-state rejection).

Counterevidence: new-thread has project/environment changes, project refusal, picker locks and seed conversion. Existing-thread can hand off to another provider and routes model selection through `handoffSelect`. New-thread returns project/environment as well as execution fields. These policies must remain local. The observer's deadline intentionally returns the latest unsettled state if one exists. This plan must preserve that behavior rather than turn it into a new timeout error.

## End state and preservation

Extend the existing settling module with a serial queue and a shared execution-selection sequence. The queue must run the next request after either success **or rejection** of the prior request. A request's deadline begins when that queued request starts, matching current behavior.

The smallest useful interface is a hook/function which receives the committed-state controller and a local adapter with: a prelude for project/environment work. Allowed execution changes resolved from current locks. `changeModel` preserving handoff policy. And a selection reader. The shared owner performs tuple-versus-step selection, committed-state waits and final settling. Compute policy through the adapter once per step/current state, not a large matrix of boolean feature flags. If the adapter grows beyond these actual differences, limit the first change to queue/deadline/settle session ownership and retain the explicit local steps.

Keep plugin API signatures, picker UI, handoff draft changes, selected values, refusal behavior, unsupported service-tier omission, and asynchronous completion points. Do not merge the two composer state machines or change `useThreadCreationOptions`.

## Expected gain and cost

Projection from the 240-line combined blocks: remove 175–220 production lines. Add 100–155 shared sequence/adapter lines. **net 40–100 lines**. The main saving is one definition of queue recovery, deadline lifetime and provider/model/reasoning/tier ordering. Existing components still own two distinct policies. Tests may add 30–100 lines of missing characterization and keep both component integrations. Performance is expected to retain the same number/order of commits and waits. No measured improvement is claimed.

## Execution steps

1. Reconfirm current source anchors and plugin host selection contract. Record execution order for full tuple, partial tuple, unlisted provider, permission-only and unsupported-tier requests through both existing entry points. Stop if selection scheduling changed from a promise chain.
2. Extend the existing settling tests only for missing shared risks: two back-to-back requests, prior-request rejection followed by success, one deadline per request, and deadline reached with an unsettled latest state. Preserve existing expected outputs.
3. Introduce the queue/settling-session owner in `composer-selection-settle.ts`. Use a stable hook instance/ref so component rerenders do not reset the chain. Migrate existing-thread first, keeping `handoffSelect` in its local adapter. Run its integration tests.
4. Migrate new-thread with project/environment prelude and locked-change policy. Preserve refusal stopping environment work and invalid-provider behavior. Run its plugin integration tests.
5. Delete both old promise-chain blocks and duplicated sequencing closures. Keep the existing committed observer and read helpers. Do not replace them with a second state store. Inspect the adapters to ensure they do not encode the whole former algorithms again.
6. Run target checks and typecheck, compare call/commit order and re-count actual removed/added lines. If the helper has more policy parameters than removed shared rules, take the smaller queue-only extraction and revise the gain honestly.

## Verification and acceptance

Not run in this read-only audit. From repository root:

```sh
pnpm --filter @omnyo/app exec vitest run --config vitest.config.ts src/components/promptbox/composer-selection-settle.test.ts src/components/plugin/PluginNewThreadComposer.test.tsx src/views/thread-detail/ThreadDetailPromptArea.test.tsx
pnpm --filter @omnyo/app typecheck
```

Accept only if both component entry points return the same fields after the same commit sequence. Include locked provider/execution/project/environment, refused project change, unsupported tier, handoff model/reasoning, concurrent calls, an earlier rejected call, timeout before first publish and timeout with an existing unsettled state. Verify no extra prompt-draft clearing or handoff. Targeted interaction comparison: programmatically select then open the model picker and submit in each composer, confirming the visible provider/model/reasoning/permission matches returned committed selection. No layout/style changes are authorized.

Compare commit/version increments and observer wait count in the same fixtures. Extra commits, shortened deadline or serial work moved before queue entry are regressions. No new performance allowance is invented.

## Rollback and stop

This changes no stored format. Keep migration of each consumer as a working checkpoint and revert only that checkpoint's exact diff if necessary. Stop on changed plugin promise resolution, dropped lock/refusal behavior, timeout semantic drift, extra commits, or an adapter that merely recreates two full state machines behind a generic facade. The smaller queue-only extraction remains available without forcing a shared execution policy.
