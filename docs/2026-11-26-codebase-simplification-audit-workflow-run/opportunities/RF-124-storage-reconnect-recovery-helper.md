# RF-124 — Replace Storage & Retention's three hand-written reconnect-recovery services with one local helper

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplication is real and exactly as described, but the three blocks in scope are 105 lines, not 112, and the helper must also pass the service's abort signal (the managed-scratch service needs it).
- **Potential:** low. This is one local consolidation in one file. It does not cross package boundaries.
- **Confidence:** high. The comparison was proven by inspection against the snapshot source.
- **Readiness:** ready. No product decision is needed.
- **Effort:** under one hour, including the focused test run.
- **Risk:** low. All three call sites keep their own recovery function and their background-service names. The development-storage service already has tests that drive its reconnect triggers.
- **Prerequisites:** none.
- **Related and overlapping RF ids:** RF-070 ("One per-host background-job runner for Storage & Retention cleanup jobs") works in the same plugin but on the cleanup job runner in `storage.ts`, not on these service registrations. The two changes can land in either order. If both are open at once, rebase whichever lands second. No other RF touches `plugins/storage-retention/src/server.ts`.
- **Why it deserves its place:** the rule for when Storage & Retention reconciles is written three times. That rule is: on start, on `host-connected`, on a realtime reconnect, then wait for abort and unsubscribe. A change to that rule today means three matching edits, and nothing checks that they still agree. The saving is small, so this item should rank below any cross-package or dead-machinery item.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The snapshot worktree had already been removed when this card was written, so every source was read with `git show e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e:<path>`. `git diff --stat e9e1b74c3 HEAD -- plugins/storage-retention/src/server.ts plugins/storage-retention/src/storage.test.ts` showed no change on the local `main` checkout at write time.

What the subsystem does: the Storage & Retention plugin (`plugins/storage-retention`, server entry `./src/server.ts` in its `package.json` `omnyo.server` field) runs scheduled cleanup jobs. It also runs three long-lived background services that redo that work after the server regains contact with a machine. The default export is `plugin(api)` in `plugins/storage-retention/src/server.ts`, and it registers these services:

| Service name | Lines | Recovery call | Differences |
|---|---|---|---|
| `"housekeeping-recovery"` | `plugins/storage-retention/src/server.ts:38-69` | `housekeeping.reconcile()` | None |
| `"managed-scratch-recovery"` | `plugins/storage-retention/src/server.ts:87-118` | `managed.reconcile(signal)` | Passes the service abort signal |
| `"development-storage-recovery"` | `plugins/storage-retention/src/server.ts:144-184` | `storage.reconcileDevelopmentStorage()`, or `storage.reconcileHostDevelopmentStorage(event.id)` when a `host:changed` event names a host | Also calls `api.realtime.publish("changed", null)` on `host-connected` or `host-disconnected` |

Observed facts (**Proven by inspection**):

- All three services follow the same sequence. Each one returns early if the signal is already aborted, subscribes to `api.sdk.subscribe({ event: "host:changed" })` and checks `event.changes.includes("host-connected")`, and subscribes to `api.sdk.subscribe({ event: "realtime:connection" })` and checks `event.state === "connected" && event.reconnected`. Each then awaits one initial recovery inside `try`, waits on an abort promise, and unsubscribes host-then-connection in `finally`. The first two blocks are identical apart from the recovery expression on lines 41 and 90.
- The callbacks of the first two services are `async` functions that `await recover()`. The development service calls `void ...` instead. The SDK listener type is `OmnyoRealtimeCallback = (event) => void` (`packages/sdk/src/realtime-types.ts:51`), and `OmnyoRealtimeClient.callListener` (`packages/sdk/src/realtime-client.ts:718-727`) catches only synchronous throws. A returned promise is ignored. So `async (e) => { await recover(); }` and `(e) => { void recover(); }` both leave the same detached promise, and a rejection behaves the same way in both forms. `PluginBackground.service` (`packages/plugin-sdk/src/backend-contract.ts:1073-1091`) documents that a detached rejection counts as a service crash and restarts the service with backoff. Choosing `void recover()` for every caller therefore keeps today's failure behavior.
- `storage.reconcileDevelopmentStorage` and `reconcileHostDevelopmentStorage` (`plugins/storage-retention/src/storage.ts:1697-1735`) catch and log their own errors, so they never reject. `housekeeping.reconcile` (`plugins/storage-retention/src/housekeeping-service.ts:546`) and `managed.reconcile` (`plugins/storage-retention/src/managed-service.ts:1487`) can reject, and the crash-and-restart path above covers them. This card does not change error handling.
- Line counts: `git show e9e1b74c3:plugins/storage-retention/src/server.ts | awk 'NR>=38&&NR<=69' | wc -l` gives 32. The 87-118 block is also 32, and 144-184 gives 41. In total, 105 handwritten production lines are in scope.

Consumers and contracts searched:

- `git grep -n -e housekeeping-recovery -e managed-scratch-recovery -e development-storage-recovery e9e1b74c3 -- .` matches only `server.ts` and four `host.harness.behavior.runService("development-storage-recovery")` calls in `plugins/storage-retention/src/storage.test.ts` (lines 845, 2921, 3080, 3136). The service names are string identifiers that the host and the tests use, so they must stay unchanged.
- The tests that encode the development service's contract are the following:
  - `storage.test.ts` around 845-857: a `host:changed` event with `id: "host_b"` must scan only `host_b`.
  - The test "refreshes the storage page only for host changes it shows" (around 2903-2953): `host-connected` and `host-disconnected` must each publish `"changed"` synchronously, and other changes must not.
  - The test around 3183-3190: a `realtime:connection` event with `reconnected: true` triggers a full reconcile.
- No test drives the reconnect triggers of `"housekeeping-recovery"` or `"managed-scratch-recovery"`. The search was `git grep -n -e host-connected -e 'reconnected: true' e9e1b74c3 -- plugins/storage-retention`, and its only test hits are in the development-service tests above.
- Other plugins (`plugins/keep-awake/server.ts:375` "desired-state-reconciler" and `plugins/concurrency-limit/server.ts:925` "capacity-detector") subscribe to the same two events but feed a coalescing retry loop, which is a different shape. A cross-plugin helper would have to live in the packed plugin SDK (`docs/forkable-plugins.md`), and that is out of scope. `plugins/storage-retention/src/worktrees/server.ts:329` "initial-scan" does not subscribe to either event.
- The plugin SDK has no existing wait-for-abort or reconnect helper. The search was `git grep -n -i -e waitForAbort -e untilAborted -e abortPromise e9e1b74c3 -- packages/plugin-sdk/src plugins/storage-retention`, and it returned no hits.

Counterevidence: with only three uses, the explicit code is easy to read, and the saving is modest. The value is one owner for the reconnect policy rather than a large reduction in lines.

**Proposed end state and preservation argument**

One module-local function in `plugins/storage-retention/src/server.ts`, placed below `plugin`, registers a reconnect-recovery service. The three `api.background.service(...)` blocks become three calls to it. Each call keeps its own service name and recovery function.

```ts
type RecoveryTrigger = { hostId?: string; signal: AbortSignal };

function registerReconnectRecovery(
  api: PluginApi,
  name: string,
  recover: (trigger: RecoveryTrigger) => Promise<unknown>,
  onHostChanged?: (changes: readonly string[]) => void,
) {
  api.background.service(name, {
    async start(signal) {
      if (signal.aborted) return;
      const unsubscribeHost = api.sdk.subscribe({
        event: "host:changed",
        callback: (event) => {
          if (event.changes.includes("host-connected"))
            void recover({ hostId: event.id, signal });
          onHostChanged?.(event.changes);
        },
      });
      const unsubscribeConnection = api.sdk.subscribe({
        event: "realtime:connection",
        callback: (event) => {
          if (event.state === "connected" && event.reconnected)
            void recover({ signal });
        },
      });
      try {
        await recover({ signal });
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
      } finally {
        unsubscribeHost();
        unsubscribeConnection();
      }
    },
  });
}
```

The call sites become:

```ts
registerReconnectRecovery(api, "housekeeping-recovery", () => housekeeping.reconcile());
registerReconnectRecovery(api, "managed-scratch-recovery", ({ signal }) => managed.reconcile(signal));
registerReconnectRecovery(
  api,
  "development-storage-recovery",
  ({ hostId }) =>
    hostId === undefined
      ? storage.reconcileDevelopmentStorage()
      : storage.reconcileHostDevelopmentStorage(hostId),
  (changes) => {
    if (changes.includes("host-connected") || changes.includes("host-disconnected"))
      api.realtime.publish("changed", null);
  },
);
```

The executor may pick a different name and parameter style, for example an options object. The semantics below are what must hold.

How current behavior survives:

- **Service names:** the three string names stay the same, so the host registry, the `runService` tests and any status display keep working.
- **Registration order:** each call stays at its current position in `plugin` (after the `housekeeping` schedule, after the `managed-scratch-cleanup` schedule, after the `development-storage-cleanup` schedule). The `storage` constant must exist before the development call, as it does today.
- **Triggers:** these are unchanged. Recovery runs on start, on `host-connected`, and on `realtime:connection` with `state === "connected" && reconnected`. Housekeeping and managed scratch ignore `hostId`, so they keep doing a full reconcile on every `host-connected`, as today. The development service keeps its per-host branch when `event.id` is defined and its full reconcile otherwise.
- **Managed abort signal:** `managed.reconcile` keeps receiving the service's own abort signal.
- **Publish timing:** `api.realtime.publish("changed", null)` stays synchronous inside the `host:changed` callback. It runs after the development reconcile has been started, as today. The test that counts refreshes right after `emit` depends on this.
- **Failure behavior:** a recovery started by a trigger stays detached, which is equivalent to today's `async`/`await` callbacks for the reason given above. A failure in the initial recovery still rejects `start`, so the host restarts the service.
- **Teardown:** unsubscribing host-then-connection in `finally`, the early return when the signal is already aborted, and the abort-wait promise are all kept.

Non-goals:

- Do not change reconcile coalescing or error handling.
- Do not merge the housekeeping and managed recoveries into one service. They have separate names and separate crash/restart lifecycles.
- Do not move this into the plugin SDK, and do not touch other plugins.

**Expected gain and cost**

- **Before (observed):** 105 handwritten production lines in three service blocks.
- **After (projection):** about 37 lines for the helper and about 17-20 lines for the three calls once the formatter runs. That projects to a net reduction of roughly 45-55 production lines. Recount after formatting.
- **Mechanisms:** three copies of the subscription lifecycle become one helper. The reconnect policy (which events count as "back online") has one owner.
- **Tests, generated code and docs:** no change is required.
- **Maintenance effect:** adding a trigger, changing the reconnect condition or changing teardown becomes one edit. Today it is three edits that can drift apart.
- **Cost:** the helper adds one small indirection, and readers must look at `registerReconnectRecovery` to see the triggers.
- **Performance:** no change in work or subscription count is expected. Each service still opens two subscriptions. This is not measured, and it does not need measuring.

**Execution steps**

1. **Reconfirm the baseline.** Run `git -C <checkout> log --oneline e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e..HEAD -- plugins/storage-retention/src/server.ts`. If the file changed, re-read lines 35-184 and confirm the three blocks still match the table above. Re-plan if any of the following holds:
   - A fourth recovery service with the same shape appeared. Include it.
   - One of the three gained a different trigger or a coalescing loop. Keep that one explicit or re-plan the helper.
   - RF-070 already restructured the reconcile functions. Adapt the recovery callbacks.
2. **Optional characterization test.** The housekeeping and managed-scratch services have no reconnect test. Shared helper code covered by the development tests lowers this risk, so the test is optional. If the executor wants one, add a test in `plugins/storage-retention/src/storage.test.ts` or `managed-recovery.test.ts` that does the following:
   - Builds `createFakePluginHost` with a recording `sdk.subscribe`.
   - Runs `host.harness.behavior.runService("managed-scratch-recovery")`.
   - Fires a `realtime:connection` event with `{ state: "connected", reconnected: true, reconnectDelayMs: null }`.
   - Polls `host.harness.inspection.realtimeSignals` for a second `"managed-changed"` signal. `managed.reconcile` publishes `"managed-changed"` (`managed-service.ts:1490`).

   Write the test against the current code first and confirm it passes before the refactor.
3. **Add the helper** in `plugins/storage-retention/src/server.ts`. Use the signature in the end state, and import no new modules (`PluginApi` is already imported on line 2).
4. **Replace the blocks.** Replace `server.ts:38-69` with the `"housekeeping-recovery"` call, `server.ts:87-118` with the `"managed-scratch-recovery"` call, and `server.ts:144-184` with the `"development-storage-recovery"` call. Do it in that order and keep each call at its original position. Delete the local `recover` constants.
5. **Format and lint.** Run the repository formatter on the one file. Check that no leftover `api.background.service(` call for these three names remains: `rg -n 'background.service\("(housekeeping|managed-scratch|development-storage)-recovery' plugins/storage-retention/src/server.ts` should print nothing.
6. **Verify and review.** Run the verification below. Then read the complete diff and confirm it touches only `server.ts` (and the optional test). Recount the lines with `git diff --numstat`.

**Verification and acceptance criteria**

The audit snapshot had no `node_modules`, so these commands were not run for this card. The script names come from `plugins/storage-retention/package.json` and the root `package.json` at the snapshot.

- **Tests:** in `plugins/storage-retention`, run `pnpm test -- src/storage.test.ts` (script `"test": "vitest run --config vitest.config.ts"`). The expected result is that all tests pass. These three are required:
  - The per-host scan test around line 845.
  - "refreshes the storage page only for host changes it shows" around line 2903.
  - The reconnect cleanup test around line 3183.

  If step 2 added a test, run it too: `pnpm test -- src/managed-recovery.test.ts` or the file you used.
- **Typecheck:** in `plugins/storage-retention`, run `pnpm typecheck` (`tsc --noEmit`). It must pass. In particular, `event.id` must type-check as `string | undefined` against `RecoveryTrigger.hostId`.
- **Lint:** in `plugins/storage-retention`, run `pnpm lint`. It must pass with no new warnings.
- **Format:** at the repository root, run `pnpm exec oxfmt plugins/storage-retention/src/server.ts`, then `pnpm exec oxfmt --check plugins/storage-retention/src/server.ts`. The root scripts `format` and `format:check` run `oxfmt .` and `oxfmt . --check`.
- **Behavior checks to confirm by reading the diff:**
  - The three service names are unchanged.
  - `managed.reconcile` still receives the service signal.
  - The publish of `"changed"` is still synchronous and still covers both `host-connected` and `host-disconnected`.
  - Housekeeping and managed scratch still do a full reconcile on a host-connected event that names a host.
  - The initial recovery is still awaited before the abort wait.
- **Structural completion:** `rg -c '"realtime:connection"' plugins/storage-retention/src/server.ts` prints `1`, and `rg -c '"host:changed"' plugins/storage-retention/src/server.ts` prints `1`.
- **UI and performance:** neither is affected, so no visual or benchmark comparison is needed.

**Rollback and stop conditions**

- **Rollback:** the change is one revertible commit touching `plugins/storage-retention/src/server.ts`, plus the optional test. It changes no persisted data, contract or public export.
- **Stop if** any of the following happens:
  - A development-storage test fails on publish counts or per-host scanning and the cause is not a simple wiring mistake. That means the helper changed ordering or synchronicity.
  - One of the services needs a trigger or a failure policy the others must not get.
  - A newer commit gave one service a coalescing or retry loop like `keep-awake`'s.

  In those cases, keep the divergent service explicit and apply the helper only to the services that still match. Housekeeping and managed scratch alone are a valid smaller version.
