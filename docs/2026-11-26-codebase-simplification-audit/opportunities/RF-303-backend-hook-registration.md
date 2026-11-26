# RF-303 — Share the real and fake backend hook registration rule

**Rank and disposition.** Modest code reduction, high correctness/maintenance value. High confidence. Ready after a focused characterization. Estimate half a day to one day, low/medium risk confined to plugin registration. This card owns prior §7. The server lane should reference it. The stale-handle defect is separately tracked as ISS-300 in `../provider-issues.md`.

**Snapshot and authority.** Inspected `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` in `$AUDIT_WORKTREE`. This implementation plan requires separate implementation authority. No product edits, installs, provider calls, publication or performance measurements ran. Existing dependencies are absent in this audit lane. Commands below are repository-supported future checks and remain unrun. Run from the repository root unless stated otherwise. Preserve features, public imports, stored formats, errors, ordering, cancellation, UI/UX and performance. Isolate behavior corrections from structural work.

## Evidence and consumers

`apps/server/src/services/plugins/plugin-api.ts:experimental_hooks.on` calls `assertLive()`, checks for an existing handler and calls `storePluginHook`. `packages/plugin-sdk/src/testing/fake-plugin-host.ts:experimental_hooks.on` duplicates the latter two steps but omits `assertLive()`. `disposeHost` marks `invalidated = true`. Fake `assertLive` would throw `PluginContextStaleError`, but `on()` never calls it. A previously unused hook can therefore be registered after disposal in the fake while production rejects it. This is proven by exact control-flow inspection, not an executed reproduction.

`packages/plugin-sdk/src/internal/host-policy.ts` already owns `storePluginHook` and `pluginHookAlreadyRegisteredMessage`. The shared function currently stores only. It does not own the complete rule. Fake disposal tests in `src/testing/__tests__/fake-plugin-host.test.ts` check poisoned SDK/KV handles but not this path. Live consumers include `plugins/drafts/server.ts` and `plugins/concurrency-limit/server.ts` registering `message.dispatch` hooks.

Counterevidence: provider contributions and event filters already call shared validators and both implementations invoke `assertLive` in the inspected paths. `recheck` also asserts live in both, while production schedules draining and the fake records requests. These are legitimate host-specific effects. The frontend collector is useful precedent, not a reason to rewrite the entire backend host.

## End state and preservation

Replace the low-level store-only helper with a single SDK-internal registration operation, e.g. `registerPluginHook({ records, assertLive, hook, handler })`, preserving the generic `K extends PluginHookName` correlation. That operation calls `assertLive` first, then the existing duplicate check/message, then stores the handler. Both hosts delegate their `on` methods to it. Leave `recheck`, actual invocation, timeouts and cleanup in their owners.

The structural change preserves production behavior. The fake's rejection after disposal is an intentional test-harness defect correction and must be named as such. Do not mislabel the complete change as strict equivalence. Error priority after disposal remains stale-handle first even if a hook was already registered. No public SDK contract change is needed: the existing internal host-policy subpath carries the helper.

## Expected gain and cost

Projection: approximately 12–20 repeated production/test-harness implementation lines removed, 12–20 common helper/call lines added. **Net change approximately −8 to +8 lines**, not a large LOC saving. The meaningful result is two maintained lifecycle/duplicate/store sequences becoming one operation. Shared policy stops another fake/production drift at this exact boundary. No performance improvement is claimed. One synchronous function call is the expected cost. Test additions are likely 20–50 lines, reported separately.

## Ordered execution

1. Confirm both blocks, invalidation order and current error strings. Add a fake-host test that disposes an otherwise empty host and then registers `message.dispatch`. Watch that specific test fail before editing.
2. Add live-register and duplicate-register expectations, including stale-with-duplicate precedence. Use existing fake harness and production plugin API fixtures. Do not build a second test host.
3. Put the full operation beside the existing hook helpers in `internal/host-policy.ts`. Migrate both `on` implementations. Remove the superseded store-only export if no remaining caller needs it. Keep necessary internal compatibility only if a real support contract requires it.
4. Run fake-host, shared-policy and server plugin-hook tests. Inspect event/provider contribution registrations for analogous concrete omissions, but do not expand extraction without demonstrated drift.
5. Report the fake correction separately from the consolidation. Inspect the diff for lifecycle changes beyond registration.

## Verification and acceptance

Run `pnpm --filter @omnyo/plugin-sdk test -- src/testing/__tests__/fake-plugin-host.test.ts` and `pnpm --filter @omnyo/plugin-sdk typecheck`. Server hook registration cases live in `apps/server/test/services/plugins/plugin-service.test.ts`. Run `pnpm --filter @omnyo/server test -- test/services/plugins/plugin-service.test.ts` using the existing test script. Run `pnpm --filter @omnyo/server typecheck`. The final audit coverage ledger supplies current path confirmation where available.

Acceptance: real and fake hosts reject registration after disposal with the existing stale-context error, reject duplicate live registrations with the exact duplicate message, and invoke the same live handler. Fake recheck request counts and real queue draining remain unchanged. No new collector framework, UI change or background task is introduced. Format/lint touched files.

## Rollback and stop

One small commit is reversible. No persistent-format change exists. Stop if a supported fake lifecycle intentionally permits post-disposal registration or production's assertion order changes. In that case resolve the contract before consolidating. Do not preserve the observed defect just to retain test compatibility. Isolate any broader behavior change into its own authorized fix.
