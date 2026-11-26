# RF-100 — Share realtime target retention without sharing socket policy

## Rank and disposition

**Potential: medium. Confidence: high. Readiness: ready for a bounded refactor. Effort: small-to-medium (roughly 1–2 engineering days including three adapters). Risk: medium.** This removes three maintained copies of one reference-counting rule. It ranks below the larger panel/composer changes on absolute reduction, and above declaration cleanup on behavioral maintenance value. Rechecks prior audit §10. Coordinate the SDK consumer with the SDK audit owner. Count this saving once.

## Context and evidence

Snapshot: `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e`, inspected read-only on 26 November 2026. Supported consumers in this plan are the browser app, native mobile shell's realtime client and public SDK. This extraction preserves all supported transports.

| Owner           | Exact implementation and callers                                                                                                                                                                                                                     | Existing verification                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Browser         | `apps/app/src/lib/ws.ts`: `WebSocketManager.subscribe` / `unsubscribe` at 495. `connect` replays `subscriptions.values()` when the socket opens. `apps/app/src/hooks/realtime-cache-effects.ts` receives the resulting change/connect/resume events. | `apps/app/src/lib/ws.test.ts`, especially “ref-counts duplicate subscriptions” and reconnect replay.                     |
| Mobile          | `apps/mobile/src/lib/realtime/mobile-realtime.ts`: `createMobileRealtime`, returned `subscribe` / `unsubscribe` at 480. Socket `onopen` replays retained targets.                                                                                    | `apps/mobile/src/lib/realtime/mobile-realtime.test.ts`: first/last holder, duplicate release, reconnect, suspend/resume. |
| SDK             | `packages/sdk/src/realtime-client.ts`: `activateListener` / `removeListener`, `addTarget` / `removeTarget` at 320, and `connectSocket` replay.                                                                                                       | `packages/sdk/test/realtime-client.test.ts`.                                                                             |
| Shared identity | All three use `realtimeSubscriptionTargetKey` from `packages/domain/src/change-kinds.ts:190`.                                                                                                                                                        | Existing domain change-kind/target fixtures. Preserve the exact key function.                                            |

The three retain/release blocks inspected span 44, 29 and 45 lines (118 total, including blank lines). Each map stores `{ count, target }`, sends subscribe only on the first holder, and sends unsubscribe only when the final holder leaves. The previous audit's 1,933-line total measures the surrounding files (668 + 531 + 734). The removable scope is the three counting blocks.

Counterevidence limits the extraction. Browser tracks visibility, pending open-file signals and resume coalescing. Mobile owns session authentication, failure notification, suspension and disposal. SDK owns listener activation/idempotent unsubscribe and closes its socket when no targets remain. Mobile deliberately ignores pane-action/plugin-signal frames that browser delivers. Decoder unification is excluded. The terminal transport in `packages/client-core/src/terminal/terminal-websocket-transport.ts` has output sequence acknowledgement, backpressure and terminal-end rules that require its own owner.

## End state and preservation

Add a small internal target-retention implementation beside the existing domain target key. A sufficient API is `retain(target): boolean` (true only for a new target), `release(target): boolean` (true only for the final holder), `values(): Iterable<RealtimeSubscriptionTarget>`, `size`, and `clear()`. Retain the first target object for a key and insertion iteration order. Unknown release remains a no-op. The map and transitions have one owner. Each adapter still sends its own frames and owns connection/disposal policy.

Keep all public SDK exports, listener signatures, authentication, reconnect timing, browser resume behavior and mobile lifecycle unchanged. Do not add connection callbacks or transport options to the shared helper. A pure helper adds one existing-package import and no new dependency/package.

## Expected gain and cost

Projection from the 118-line blocks: remove 100–118 handwritten production lines. Add 40–65 shared/helper and adapter lines. **net 35–75 lines**. Tests are separate: consolidate rule assertions in domain tests but retain the three adapter frame/lifecycle cases. No test-line deletion is promised. Mechanisms go from three transition implementations to one, while there remain three distinct transport lifecycles. A new subscription-target rule then changes one map implementation and each runtime's integration tests, instead of three copies of transition logic. Allocation/throughput should be similar by design, but no performance improvement was measured.

## Execution steps

1. Reconfirm the three blocks, target-key contract, package dependency graph and public SDK packaging. Stop if one runtime now intentionally counts a different kind of holder. Record the three existing frame sequences before editing.
2. Add the pure retention helper to `packages/domain/src` and its normal barrel. Cover first retain, equal-key different object, duplicate retain, partial/final/unknown release, insertion order, replay after changes and clear. Do not expose it as a new SDK user API.
3. Replace browser map transitions with the helper. Keep the existing `WebSocket.OPEN` guard and replay site unchanged. Run the browser target tests before proceeding.
4. Replace mobile transitions and replay iteration, retaining `send`'s current socket guard and `dispose` clearing semantics. Run mobile target/lifecycle cases.
5. Replace SDK `targetSubscriptions` transitions, size checks and replay iteration. Keep `listener.active`, connection promise handling and `closeSocketIfIdle` with the SDK. Run SDK listener and reconnect cases.
6. Remove the three obsolete `{count,target}` definitions/transition branches. Inspect the SDK packed dependency path through existing packaging checks. No dependency installation or publication is part of this plan. Recount the diff against the 118-line scope.

## Verification and acceptance

Commands below are repository-supported target invocations, **not run in this audit**. Run from repository root after the existing dependency setup is available:

```sh
pnpm --filter @omnyo/app exec vitest run --config vitest.config.ts src/lib/ws.test.ts
pnpm --filter @omnyo/mobile exec vitest run --config vitest.config.ts src/lib/realtime/mobile-realtime.test.ts
pnpm --filter @omnyo/sdk exec vitest run --config vitest.config.ts test/realtime-client.test.ts
pnpm --filter @omnyo/domain typecheck
pnpm --filter @omnyo/app typecheck
pnpm --filter @omnyo/mobile typecheck
pnpm --filter @omnyo/sdk typecheck
```

Use the actual domain test configuration for the new helper test (`packages/domain/package.json` / `vitest.config.ts`). Its future filename is not an existing audit command. Adapter acceptance is the same sent-frame order for two listeners, partial release, offline release/reconnect, final release, duplicate cleanup and dispose. SDK idle close, mobile suspension/auth failure, browser resume signals must stay unchanged. There is no UI rendering change. No screenshot comparison is required for this internal rule.

The hot loop must remain one key lookup and bounded map changes, without copying active targets on every retain/release. Compare existing reconnect fixture target counts and message order. If implementation introduces extra iteration/allocation, use an equivalent representative target workload before accepting it. This audit supplies no latency budget or speed claim.

## Rollback and stop

Keep the extraction and all three caller migrations in one reversible local change (or three working checkpoints on one branch). Roll back only its exact diff. No persistent data changes occur. Stop on a required runtime-specific counting rule, a packed SDK missing the shared helper, changed listener cleanup behavior or additional frames. Retain separate decoder and lifecycle policies even if they appear textually similar.
