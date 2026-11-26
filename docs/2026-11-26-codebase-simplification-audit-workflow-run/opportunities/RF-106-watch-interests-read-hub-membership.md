# RF-106 — Remove the WatchInterestCoordinator's mirrored socket-subscription maps and let the NotificationHub report membership changes

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplicated state is real. The sweep's plan needed three corrections, all recorded below. The coordinator reacts to every per-socket add and remove, not only to "first socket gained" and "last socket lost". A socket close must stay one batched release. And the backpressure-drop path cannot keep its current timing once the hub owns membership.
- **Potential:** low. About 40–60 handwritten production lines go (a projection), and one of two mirrored subscription registries disappears.
- **Confidence:** medium. The equivalence argument is proven by inspection. No test was run, because the snapshot has no `node_modules`.
- **Readiness:** conditional. Two things must happen before implementation. First, a characterization test of the daemon `watch-set.replace` messages must pass on the unchanged code (step 2). Second, the owner of `apps/server` must accept one timing change: a client socket dropped for backpressure releases its daemon watch interest when it is dropped, not when its close callback arrives later (step 1, gate B).
- **Effort:** small, about half a day to one day including tests and the benchmark harness.
- **Risk:** low to medium. The failure modes are wrong daemon watch-set cadence (extra, missing or reordered `watch-set.replace` messages, or skipped generation numbers) and a synchronous SQLite read inside a client fan-out loop on the backpressure path.
- **Prerequisites:** none.
- **Related or overlapping RF ids:** none in this audit touches `apps/server/src/ws/watch-interests.ts` or the hub's client-subscription maps.
- **Why it deserves its place:** today every subscription lifecycle event has to update two stores in lockstep from `apps/server/src/ws/client-protocol.ts`. One server-initiated path, the backpressure drop, already updates only one of them. Folding membership into its existing owner removes that coordination burden and a latent divergence. The line gain is modest, so it ranks below items that delete whole subsystems.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The snapshot worktree named in the task was absent when this card was written, so every file was read with `git -C $OMNYO_CHECKOUT show e9e1b74c3:<path>`. A diff of `apps/server/src/ws` between the snapshot and the later local `main` (`5f2d3f895`) was empty.

The subsystem in plain language: browser and mobile clients open `/ws` and send `subscribe` and `unsubscribe` messages for realtime targets such as `thread-detail` or `environment-list`. The `NotificationHub` fans server change messages out to the sockets subscribed to each key. Separately, the `WatchInterestCoordinator` tells each host daemon which workspaces and thread-storage folders to file-watch. It sends a `watch-set.replace` message that carries a per-host generation number. Only the `environment-detail` and `thread-detail` kinds create watch interests.

Observed facts (Proven by inspection):

- The hub's membership store is `clientKeysBySocket` and `clientSocketsByKey` at `apps/server/src/ws/hub.ts:295-296`. It is maintained by `registerClient` (`hub.ts:403-407`), `unregisterClient` (`hub.ts:409-432`), `subscribe` (`hub.ts:715-723`) and `unsubscribe` (`hub.ts:725-740`). Keys come from `realtimeSubscriptionTargetKey`, which is imported as `subscriptionKey` at `hub.ts:5` and defined at `packages/domain/src/change-kinds.ts:190`. The hub stores keys only, never the target objects.
- The coordinator's mirror is `interestsBySocket` and `socketsByInterest` at `apps/server/src/ws/watch-interests.ts:74-81`, plus `targetsByInterest` (key to target) at `watch-interests.ts:82-85`. These maps are maintained by `subscribe` (`watch-interests.ts:99-128`), `unsubscribe` (`watch-interests.ts:130-167`) and `releaseSocket` (`watch-interests.ts:169-208`), using the same `realtimeSubscriptionTargetKey`. The two socket maps are referenced only inside those three methods: `rg -n "socketsByInterest|interestsBySocket"` on the snapshot file hits lines 74, 78, 110, 114, 117, 120, 139, 148, 151, 157, 164, 170, 177, 180, 189 and 202. The rest of the class (`resolveTargets`, `resolveWatchSetForHost`, `interestKeysForChangedMessage`, `addKnownInterestKey`, `addInterestKeysWithPrefix`) reads only `targetsByInterest`.
- The lockstep calls are in `apps/server/src/ws/client-protocol.ts`. `onClientSocketMessage` calls `deps.hub.subscribe` and then `deps.watchInterests.subscribe` (lines 49-50), and `deps.hub.unsubscribe` and then `deps.watchInterests.unsubscribe` (lines 61-62). `onClientSocketClose` calls `deps.watchInterests.releaseSocket` and then `deps.hub.unregisterClient` (lines 81-82). These handlers are wired at `apps/server/src/server.ts:1711-1714` (`onOpen`, `onMessage`, `onClose` of `upgradeWebSocket`, from `@hono/node-ws`).
- No other production code mutates either store. The search `git grep -n -E "watchInterests\.|hub\.(subscribe|unsubscribe|registerClient|unregisterClient)\(" e9e1b74c3 -- apps packages tests` finds only `client-protocol.ts` and tests. The coordinator's other production consumer is `apps/server/src/internal/session.ts:251` (`reconcileWatchSetForHost`, read-only). It is constructed at `apps/server/src/start-server.ts:262` and typed in `apps/server/src/types.ts:66`.
- The two stores can diverge. `NotificationHub.sendClientPayload` (`hub.ts:434-455`) calls the private `dropClientSocket` (`hub.ts:457-463`) on backpressure or a send failure. That method calls `unregisterClient` and then `socket.close(1013, reason)`. The coordinator keeps the socket's interests until `onClientSocketClose` runs. When `onClientSocketClose` does run, the hub has already forgotten the socket.
- The coordinator does more than track "first socket gained" and "last socket lost":
  - `subscribe` re-resolves targets for every newly added (socket, key) pair. `wasPresent` is per socket (`watch-interests.ts:112`), so a second socket subscribing to an already-watched key still runs `sendSnapshotsForInterestKey`, which means one `resolveTargets()` SQLite pass.
  - `unsubscribe` re-resolves on every per-socket removal, even when other sockets still hold the key (`watch-interests.ts:162`).
  - `releaseSocket` releases all keys of a closing socket with one `resolveTargets()` call and one `sendSnapshotsForHosts` call (`watch-interests.ts:194-207`).
  - `sendSnapshotsForHosts` (`watch-interests.ts:245-274`) bumps a host's generation only when the target fingerprint changes. Redundant resolutions therefore never produce extra daemon messages, but they do cost queries.
- `unsubscribe` and `releaseSocket` already behave the same for a single key. The removed key's target has been deleted from `targetsByInterest`, so `resolveWatchSetForHost` never touches its `lastResolvedHostIdsByInterest` entry. `hostIdsForInterestKey` returns that entry unchanged when the target is absent (`watch-interests.ts:280-285`). Deleting the entry before or after the send therefore gives the same result.
- `sendDaemonMessage` (`hub.ts:1635-1646`) writes only to daemon sessions and never touches client maps. A coordinator listener that runs inside a hub client fan-out cannot re-enter that fan-out.

Consumers that encode the current two-call API:

- `apps/server/test/app/watch-interests.test.ts` (478 lines) makes 19 direct `watchInterests.subscribe`, `unsubscribe` or `releaseSocket` calls with a bare `NotificationHub` (setup at lines 39-40). The case "ref-counts duplicate workspace interests across sockets" (lines 75-129) pins the exact message counts 1, 1 and 2.
- `apps/server/test/app/client-protocol.test.ts` mocks `watchInterests` in `createProtocolDeps` (lines 9-12) and asserts the calls at lines 214-221, 239 and 282.
- `apps/server/scripts/watch-interest-benchmark.mjs` calls `coordinator.subscribe` directly (lines 92-102). It uses one `socket` object as both the daemon socket and the subscriber (line 50 and line 91), and it asserts exactly one daemon message per round (line 161). Its procedure is documented in `apps/server/scripts/watch-interest-benchmark.md`.
- `apps/server/test/helpers/test-app.ts:214` and `tests/integration/helpers/harness.ts:208` construct the coordinator with the hub. The only other tests that call `hub.subscribe` with a detail kind (`apps/server/test/app/hub.test.ts` and `apps/server/test/app/hub-open-file.test.ts:10-11`) build a bare hub with no coordinator, so they are unaffected. That search was `git grep -n -E 'hub\.subscribe\(' e9e1b74c3 -- apps tests packages`.

There are no persisted formats, public SDK or plugin-SDK exports, CLI commands or wire-protocol changes in scope. `WatchInterestCoordinator` and `NotificationHub` are internal to `@omnyo/server`. The search `git grep -n "WatchInterestCoordinator" e9e1b74c3` found only the files listed above, one benchmark doc and one other audit card.

Counterevidence and limits:

- The coordinator needs target objects and covers only two target kinds, so `targetsByInterest` and all per-host resolution state stay.
- The sweep's claim that keeping the stores separate "isolates the daemon watch policy from client fan-out" carries little weight. The coordinator already depends on the hub through `onChangedMessage` (`watch-interests.ts:94`) and `sendDaemonMessage` (`watch-interests.ts:269`), so a third hub listener adds no new dependency direction.
- How long `@hono/node-ws` and `ws` take to fire `onClose` after a server-initiated `close(1013)` to a stalled peer is a Hypothesis. The `ws` library is believed to force-destroy after its close timeout, but `node_modules` is absent, so this was not checked.

Maintenance cost today: any new subscription lifecycle event (for example a server-initiated drop, or a future "evict socket" path) must update both registries, and the call order in `client-protocol.ts` matters. The coordinator also maintains two removal paths (`unsubscribe` and `releaseSocket`) that implement the same rule.

**Proposed end state and preservation argument**

What disappears:

- `WatchInterestCoordinator.interestsBySocket` and `socketsByInterest`.
- The public methods `subscribe`, `unsubscribe` and `releaseSocket`. Two private handlers replace them, and `unsubscribe` and `releaseSocket` merge into one removal path.
- The `watchInterests` dependency of `onClientSocketMessage` and `onClientSocketClose`.

What remains:

- `targetsByInterest`, `generationByHost`, `lastWatchTargetFingerprintByHost`, `lastResolvedHostIdsByInterest`, `reconcileWatchSetForHost`, `refreshWatchSetsForChangedMessage` and all resolution code, unchanged.
- The `NotificationHub` stays the single owner of socket membership.

Canonical owner and data flow: `client-protocol.ts` calls only the hub. The hub updates its maps and then synchronously notifies membership listeners. The coordinator subscribes in its constructor, next to its existing `onChangedMessage` registration.

New hub surface, internal to `apps/server`:

```ts
export type ClientSubscriptionChange =
  | { type: "added"; key: string; target: RealtimeSubscriptionTarget } // this socket newly holds key
  | { type: "removed"; keys: readonly string[] }; // keys this socket no longer holds (one for unsubscribe, all for unregister or drop)

onClientSubscriptionsChanged(listener: (change: ClientSubscriptionChange) => void): () => void;
hasClientSubscribers(key: string): boolean; // this.clientSocketsByKey.has(key)
```

Emission rules, all fired after the hub's own maps are updated:

- `subscribe` emits `added` only when the socket did not already hold the key. This matches today's per-socket `wasPresent`.
- `unsubscribe` emits `removed: [key]` only when `clientKeysBySocket.get(socket)?.delete(key)` returned `true`. This matches today's early return at `watch-interests.ts:141-143`.
- `unregisterClient` emits one `removed` holding every key the socket held, and nothing when the socket held none. This covers both `onClientSocketClose` and `dropClientSocket`.

Coordinator handlers (pseudocode):

```ts
private addInterest(key, target) {
  if (!isWatchableSubscriptionTarget(target)) return;
  this.targetsByInterest.set(key, target);
  this.sendSnapshotsForInterestKey(key);
}

private releaseInterests(keys) {
  // A key this socket held is watchable exactly when targetsByInterest has it.
  const affected = keys.filter((key) => this.targetsByInterest.has(key));
  if (affected.length === 0) return;
  for (const key of affected)
    if (!this.deps.hub.hasClientSubscribers(key)) this.targetsByInterest.delete(key);
  const resolvedTargets = this.resolveTargets();
  const affectedHostIds = new Set<string>();
  for (const key of affected) {
    for (const hostId of this.hostIdsForInterestKey(key, resolvedTargets)) affectedHostIds.add(hostId);
    if (!this.targetsByInterest.has(key)) this.lastResolvedHostIdsByInterest.delete(key);
  }
  this.sendSnapshotsForHosts(affectedHostIds, resolvedTargets);
}
```

How current semantics survive (Proven by inspection, to be confirmed by the step 2 test):

- Subscribe cadence: one resolution per newly added (socket, key) pair, unchanged.
- Unsubscribe cadence: one resolution per real per-socket removal, even when other sockets remain, unchanged.
- Close cadence: one resolution and one `sendSnapshotsForHosts` for all of the socket's keys, unchanged.
- Generation numbers and fingerprint deduplication are untouched, because `sendSnapshotsForHosts` is not edited.
- Order on close: today the coordinator releases before `hub.unregisterClient`. Afterwards it releases inside `unregisterClient`, after the hub's maps and `unregisterTerminalClientSocket` are updated. The coordinator reads no client map except the new `hasClientSubscribers`, which must see the post-removal state, so this order is the required one.

The one intentional behavior change, which is gate B: on the backpressure and send-failure path, `dropClientSocket` now releases the socket's watch interests at drop time. Today they are released when `onClose` arrives. This cannot be avoided. Once the hub owns membership, it has already forgotten the socket by `onClose`. Delaying the coordinator's release would mean keeping a second registry, which is exactly what this change removes. The effects:

- Daemons stop watching the dropped client's folders sooner.
- The release now runs synchronously inside a hub client fan-out loop. For example, `notifyThread...` sends to `detailSockets` at `hub.ts:1476-1482` before `notifyChangedMessageListeners` at `hub.ts:1484`. In that case the release's `resolveTargets()` SQLite read and any `watch-set.replace` run before the coordinator's change-driven refresh for the same message. The final daemon state is the same as after a later close.

Non-goals:

- Do not reduce the redundant per-socket resolutions to key transitions. That would change query cadence, and it would change daemon messages whenever the database drifted without a changed message.
- Do not change the hub's fan-out, the `watch-set.replace` contract in `packages/host-daemon-contract`, or how `dropClientSocket` handles a later `subscribe` from an already dropped socket.

Smaller alternative, if gate B is declined: inside the coordinator only, merge `unsubscribe` into a shared `releaseInterestKeys(socket, keys)` path that `releaseSocket` also uses. This keeps both registries and today's timing and saves about 20–25 lines (a projection). It does not remove the duplicated state.

**Expected gain and cost**

Observed baseline:

- Coordinator membership code: 118 lines (90 non-blank) at `watch-interests.ts:74-81` and `99-208`. The command was `git show e9e1b74c3:apps/server/src/ws/watch-interests.ts | sed -n '74,81p;99,208p' | wc -l`, plus `rg -c -v '^\s*$'` on the same range for the non-blank count.
- Lockstep wiring in `client-protocol.ts`: about 9 lines (33-36, 50, 62, 76-78, 81).

Projections, not measurements:

| Component | Lines |
| --- | --- |
| Coordinator replacement handlers and constructor registration | about +35 to +45 |
| Hub listener type, set, `onClientSubscriptionsChanged`, `hasClientSubscribers` and three emission points | about +15 to +25 |
| Net handwritten production lines | about −40 to −60 |

Tests are roughly line-neutral. The 19 direct coordinator calls in `watch-interests.test.ts` become `hub.subscribe`, `hub.unsubscribe` and `hub.unregisterClient` calls, and the `client-protocol.test.ts` mock shrinks. The step 2 characterization test adds about 40–80 test lines.

Maintenance gain: one membership store, one removal rule in the coordinator, and no call-order coupling in `client-protocol.ts`. A new lifecycle event updates one store and reaches the coordinator automatically.

Performance: neutral by construction, because resolution cadence is preserved. The two socket-map updates per operation go away, and one listener call per operation is added. The backpressure path moves one SQLite read earlier. Not measured. `watch-interest-benchmark.mjs` is the existing check for the change-driven refresh.

Unknowns: the exact `onClose` delay after a server-initiated close today (a Hypothesis).

**Execution steps**

1. **Reconfirm and gate.**
   - Check that `apps/server/src/ws/watch-interests.ts`, `hub.ts` and `client-protocol.ts` still match the anchors above, using `git diff e9e1b74c3 -- apps/server/src/ws`. Rerun `git grep -n -E "watchInterests\.(subscribe|unsubscribe|releaseSocket)|hub\.(subscribe|unsubscribe|unregisterClient)\(" -- apps packages tests scripts`. Re-plan if any new production caller mutates membership outside `client-protocol.ts`, or if the coordinator gains a reader of `interestsBySocket` or `socketsByInterest` beyond the three methods.
   - **Gate B:** get the `apps/server` owner's acceptance of the drop-time release described under "Proposed end state". If it is declined, implement only the smaller alternative and stop.
2. **Characterization test, on unchanged code.**
   - Add a test to `apps/server/test/app/watch-interests.test.ts` that drives the public socket path: `onClientSocketOpen`, `onClientSocketMessage` and `onClientSocketClose` from `apps/server/src/ws/client-protocol.ts`, with a real `NotificationHub` and coordinator from `setup()` and a registered daemon mock socket. Use separate client and daemon mock sockets.
   - Record the full ordered list of daemon messages, with their generation numbers, for this sequence: socket A subscribes `environment-detail` E; socket B subscribes E (no new message); A subscribes E again (duplicate, no message); A subscribes `thread-detail` T plus `thread-list` (only T is watchable); A unsubscribes a key it never held (no message); A unsubscribes E while B still holds it (no message); B closes (E removed); A closes (T removed, one message).
   - Record the database query count per step, using the existing `queries` logger option in `setup()`, to pin the resolution cadence.
   - The backpressure case is recorded separately, because its timing changes under gate B. A subscribes E. Then a client fan-out runs with `raw.bufferedAmount` above `CLIENT_SOCKET_MAX_BUFFER_BYTES` (see the "disconnects a backed-up ping client" case in `client-protocol.test.ts`). Then `onClientSocketClose` is called. Today, release happens at close. Write this case's assertion so it can be updated in step 4 with a named comment.
   - The test must pass before any production edit.
3. **Hub edit, checkpoint 1.** In `apps/server/src/ws/hub.ts`:
   - Add `ClientSubscriptionChange`, a private `clientSubscriptionListeners` set beside `changedMessageListeners` (`hub.ts:376`), `onClientSubscriptionsChanged` (same shape as `onChangedMessage` at `hub.ts:465-471`) and `hasClientSubscribers`.
   - Emit as specified from `subscribe`, `unsubscribe` and `unregisterClient`. In `unregisterClient`, copy the key set before `clientKeysBySocket.delete(socket)`, and emit after both maps are updated.
   - Leave `dropClientSocket` unchanged, because it already calls `unregisterClient`.
   - Run the hub tests. They must pass unchanged, because nothing subscribes to the new listener yet.
4. **Coordinator and protocol edit, checkpoint 2.**
   - In `watch-interests.ts`: delete `interestsBySocket` and `socketsByInterest`. Replace `subscribe`, `unsubscribe` and `releaseSocket` with the private `addInterest` and `releaseInterests` from the pseudocode, and register them in the constructor through `this.deps.hub.onClientSubscriptionsChanged`.
   - In `client-protocol.ts`: remove the `watchInterests` calls at lines 50, 62 and 81, the `watchInterests` members of both `deps` types, and the `WatchInterestCoordinator` type import. `onClientSocketClose` keeps only `deps.hub.unregisterClient(socket)`. The `deps` object passed from `server.ts:1713-1714` still structurally satisfies the narrower types, so `server.ts` needs no edit. Confirm this with typecheck.
   - Update the backpressure assertion from step 2 to the accepted drop-time release, and add a comment that names gate B. Every other assertion from step 2 must pass unchanged.
5. **Migrate callers and remove leftovers.**
   - `apps/server/test/app/watch-interests.test.ts`: replace the 19 direct coordinator calls with `hub.subscribe`, `hub.unsubscribe` and `hub.unregisterClient` on the same sockets. Keep every expected message count and payload.
   - `apps/server/test/app/client-protocol.test.ts`: drop the `watchInterests` mock from `createProtocolDeps`. Replace the assertions at lines 214-221 with observable hub membership, using `hub.hasClientSubscribers("environment-detail:env-1")` after subscribe and after unsubscribe. Keep the "not subscribed" intent at lines 239 and 282 by asserting that no membership was added.
   - `apps/server/scripts/watch-interest-benchmark.mjs`: subscribe through `hub.subscribe` with a separate client socket object. Reusing the daemon `socket` would register it as a client and break the "one message per round" assertion at line 161, because `notifyEnvironment` fans the changed message out to subscribed clients.
   - Search again: `rg -n "releaseSocket|interestsBySocket|socketsByInterest|watchInterests\.(subscribe|unsubscribe)" apps tests packages` must find nothing.
6. **Final review.** Format the changed files, run the verification below, inspect the full diff for unrelated edits, and recount lines over the same ranges against the baseline.

**Verification and acceptance criteria**

Commands. The script names were read from `apps/server/package.json` and the root `package.json` at the snapshot. Nothing was executed during the audit, because the snapshot has no `node_modules`.

- From `apps/server`: `pnpm exec vitest run --config vitest.config.ts test/app/watch-interests.test.ts test/app/client-protocol.test.ts test/app/hub.test.ts test/app/hub-open-file.test.ts`. The `test` script is `vitest run --config vitest.config.ts`. Passing file filters this way is standard Vitest usage, not a repository script.
- From `apps/server`: `pnpm typecheck` (script `tsc --noEmit`).
- From the repository root: `pnpm exec oxfmt <changed files>`, then `pnpm exec oxlint --deny-warnings --format=agent <changed files>`. `oxlint` and `oxfmt` are root devDependencies, and `.oxlintrc.json` is at the root. The `--format=agent` flag comes from the global agent instructions and was not confirmed against this oxlint version.
- From the repository root, following `apps/server/scripts/watch-interest-benchmark.md`: `node --conditions=source --import tsx apps/server/scripts/watch-interest-benchmark.mjs 20 2 100` and `... 1000 10 20` on the baseline and on the change, in the matched order that document prescribes. Acceptance: the harness's own output assertions pass, and refresh timing and query counts stay within the baseline's per-run ranges. The refresh path itself is not edited, so this mainly proves the harness migration.

Acceptance criteria:

- **Contract:** the step 2 characterization test passes unchanged across checkpoint 2, except for the one gate-B assertion. That means the same ordered `watch-set.replace` messages, the same generation numbers and the same per-step query counts, for duplicate subscribes, non-watchable kinds, partial unsubscribes, an unsubscribe of an unheld key and a multi-key close.
- **Lifecycle:** after a backpressure drop followed by `onClientSocketClose`, the coordinator holds no interest for the socket, and exactly one release resolution happens (at drop time).
- **Structural:** `WatchInterestCoordinator` has no socket-keyed state. `client-protocol.ts` does not import `watch-interests.js`. The hub is the only writer of client subscription membership.
- **No UI** is affected, and no persisted format or wire protocol changes.

**Rollback and stop conditions**

Rollback boundary: the change touches only `apps/server/src/ws/hub.ts`, `watch-interests.ts` and `client-protocol.ts`, three test files and the benchmark script. It has no data or compatibility implications, so reverting the commit restores the old behavior completely. Keep checkpoints 1 and 2 as separate commits, so that the hub listener (harmless on its own) can stay if checkpoint 2 is reverted.

Stop conditions:

- Gate B is declined. Implement only the smaller alternative.
- The step 2 characterization test cannot be made to pass on the unchanged code. The baseline is not what this card assumes, so re-plan.
- After checkpoint 2, any change in message order, generation numbers or query counts outside the backpressure case.
- A new production caller of `hub.subscribe`, `hub.unsubscribe` or `hub.unregisterClient` appears that must not affect daemon watch sets. Today only `client-protocol.ts` exists.
- A measured regression in the benchmark's refresh latency or query count beyond the baseline's run-to-run range.

In every stop case, revert checkpoint 2 and report the finding to the `apps/server` owner instead of adjusting expectations.
