# Provider/plugin incidental findings

No product correction was made. Severity uses the audit skill's default scale. P2 means a bounded correctness/reliability problem with meaningful impact and tolerable workaround. Confidence is stated separately from priority.

## ISS-300 — Fake backend host accepts a fresh hook registration after disposal

- **Priority —** P2. A plugin can pass unit tests using the fake but fail production after retaining a stale API handle. The exposure is limited to plugin lifecycle misuse and test fidelity. No running production incident or user-data loss was established.
- **Status —** Proven by inspection. Runtime reproduction was not executed because the pinned worktree has no installed dependencies.
- **Affected surface —** `packages/plugin-sdk/src/testing/fake-plugin-host.ts:experimental_hooks.on`, `disposeHost` and `assertLive`. Production counterpart is `apps/server/src/services/plugins/plugin-api.ts:experimental_hooks.on`. Plugins testing registration/lifecycle through `createFakePluginHost` are affected.
- **Expected behavior —** Production calls `assertLive()` before duplicate checking and storage. The fake should reject the same post-disposal API use with `PluginContextStaleError`, consistent with its other poisoned API handles and the shared-host-policy contract.
- **Actual behavior —** `disposeHost` sets `invalidated = true`. Fake `experimental_hooks.on` never checks that flag and stores a handler for a previously unused hook. Existing `recheck`, SDK and KV paths do assert liveness. An already registered hook may instead throw the duplicate error, which also differs from production's stale-handle precedence.
- **Confirmation recipe —** With the existing SDK test dependencies available, add a focused case in `packages/plugin-sdk/src/testing/__tests__/fake-plugin-host.test.ts`: create an empty fake host, retain `api.experimental_hooks`, await `harness.dispose()`, then register `message.dispatch` and expect the existing stale API error. Observe it fail before editing. Also cover disposal after an earlier registration so stale-handle precedence is pinned. Run `pnpm --filter @omnyo/plugin-sdk test -- src/testing/__tests__/fake-plugin-host.test.ts` from the repo root. This recipe has not run in the audit.
- **Likely root cause —** The hosts share only `storePluginHook` and duplicate-error wording. Lifecycle validation remains independently handwritten and the fake omitted it.
- **Smallest repair —** Add `assertLive()` to fake registration. [RF-303](opportunities/RF-303-backend-hook-registration.md) gives the separate consolidation that makes both hosts delegate the full policy sequence to one SDK-internal operation.
- **Risk/dependencies —** Preserve assertion ordering, duplicate error wording, generic hook/handler correlation and fake `recheck` counters. Keep production queue draining and invocation effects local. No public API or persisted data change is needed.
- **Verification —** The new fake test fails before the correction and passes afterward. Existing live/duplicate hook cases in `apps/server/test/services/plugins/plugin-service.test.ts` and SDK fake tests continue to pass. Run affected package typechecks and touched-file formatting/lint. No live plugin, provider process or visual test is required for this lifecycle contract.

No additional confirmed bug is inferred from large files, unexecuted tests, legacy compatibility code or intentionally different provider policies.
