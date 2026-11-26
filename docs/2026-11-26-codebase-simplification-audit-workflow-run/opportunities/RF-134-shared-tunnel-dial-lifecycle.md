# RF-134 — One tunnel socket dial lifecycle (handshake deadline, refusal, close outcome) in `@omnyo/tunnel-client`

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplication is real, but the sweep's projected 80-150 production-line reduction does not hold. The gain is one owner for duplicated socket-lifecycle knowledge, with a projected net production-line change of roughly zero.
- **Potential:** low. **Confidence:** medium. **Readiness:** ready for the behavior-preserving version described here. Changing the machine tunnel's reaction to a relay "replaced" close is a separate owner decision and is a non-goal of this card.
- **Effort:** about one day, including the consumer test runs.
- **Risk:** medium-low. Reconnect timing, refusal handling and the error text shown in status are user-visible for Omnyo connect (remote access to the server) and for machine port shares. Every message string stays in its caller, so text does not change.
- **Prerequisites:** none.
- **Related and overlapping items:** RF-135 "Build Connect share origins in connect-client" edits the same two files (`resolveStreamOrigin` in `plugins/connect/src/tunnel.ts`, `buildMachineSharePublicOrigin` and `resolveOrigin` in `apps/host-daemon/src/connect-tunnel/index.ts`), but different symbols, so either can land first; rebase the second. RF-111 "Move the relay base-URL policy into @omnyo/connect-client" may touch `connectApexHost` in `plugins/connect/src/tunnel.ts`; that function is not in this card's edit set. RF-138 (web and mobile transport-failure classifier) is unrelated: it does not cover the Node `humanizeTransportError`. Linked behavior issue: ISS-S19-05 (the machine tunnel has no back-off for the relay's replaced close).
- **Why it deserves its place:** history shows the cost of the duplication. The server tunnel got a handshake deadline and HTTP-rejection retry in August 2026 (private-history commit `c1a8980869`, "Retry Connect tunnel after rejected WebSocket upgrades (#1784)"). The machine tunnel only received the same deadline in October 2026 (`83c8a2a1ae`, "#6401"), after machine share links "stay[ed] dead until the daemon restarts" when a Mac slept mid-handshake. A shared dialer stops that kind of fix from landing in only one tunnel. It ranks low because only two consumers exist and the line count does not shrink.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e`. The snapshot worktree named in the task was gone, so I read every file with `git show e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e:<path>` from `$OMNYO_CHECKOUT`. The cited files are unchanged between the snapshot and the local `main` HEAD `5f2d3f895` (checked with `git diff --stat e9e1b74… HEAD -- plugins/connect/src/tunnel.ts apps/host-daemon/src/connect-tunnel packages/tunnel-client apps/relay/src/tunnel/registry.ts`, which printed nothing).

Omnyo connect gives remote access through the relay at `omnyo.link`, using two outbound WebSocket tunnels:

- **The server tunnel** is `ConnectTunnel` in `plugins/connect/src/tunnel.ts`, a first-party plugin. It is not in `scripts/forkable-plugins.json`, so it may import workspace packages, and it already depends on `@omnyo/tunnel-client` in `plugins/connect/package.json`.
- **The machine tunnel** is `ConnectTunnelClient` in `apps/host-daemon/src/connect-tunnel/index.ts`. It serves per-machine port shares and is constructed once in `apps/host-daemon/src/app.ts:765`. Its `onStatusChange` callback only writes a debug log.

Both tunnels wrap `TunnelSession` from `packages/tunnel-client/src/session.ts`. That package exports `TunnelSession`, `ReconnectBackoff`, `humanizeTransportError`, `headersForLoopbackRequest` and `isBareOmnyoRealtimeWs` (`packages/tunnel-client/src/index.ts:1-12`). It has no dial helper.

Duplicated socket-lifecycle knowledge (Proven by inspection):

| Concern | Server tunnel `ConnectTunnel.dial` (`plugins/connect/src/tunnel.ts`) | Machine tunnel `ConnectTunnelClient.openTunnel` (`apps/host-daemon/src/connect-tunnel/index.ts`) |
|---|---|---|
| Create the socket in try/catch, message `cannot dial ${url}: …` | 506-523 | 370-385 |
| Guard against a stale socket | `isCurrent` closure: `retryScheduled`, `dialEpoch`, `this.tunnel === tunnel` (533-537) | `this.socket !== socket` checks in each handler |
| Handshake deadline: `setTimeout`, `unref`, clear on open, terminate | 556-562 (`TUNNEL_HANDSHAKE_TIMEOUT_MS`, line 33) | 393-407 (`MACHINE_TUNNEL_HANDSHAKE_TIMEOUT_MS`, line 21) |
| Open: record `connectedAt`, create and start a `TunnelSession` | 573-595 | 408-435 |
| `unexpected-response`: `res.resume()`, 401/403 means refused, terminate | 596-608 | 436-455 |
| `error`: humanize with `humanizeTransportError` | 609-618 | 456-470 (also ignored after a rejection or timeout) |
| `close`: compute connected duration, schedule a retry with `ReconnectBackoff.nextDelayAfterClose` | 619-652, then `scheduleRetry` 394-418 | 471-502, then `scheduleReconnect` 506-517 |
| Relay "replaced" close, `code 1000` and `TUNNEL_REPLACED_CLOSE_REASON` | 640-647: five-minute back-off, `TUNNEL_REPLACED_RETRY_MS` (line 39) | not handled |

The relay sends the replaced close for any routing key in `apps/relay/src/tunnel/registry.ts:1612`, inside the attach path that retires an existing entry. The reason string is defined once in `packages/tunnel-contract/src/index.ts:9`.

Line counts. Command: `git show <snapshot>:<file> | sed -n <range>p | grep -cv '^\s*$'`.

- The server dial body, lines 506-653: 131 non-blank lines.
- The machine dial body, lines 370-503: 114 non-blank lines.
- The whole files: `plugins/connect/src/tunnel.ts` has 716 lines and `apps/host-daemon/src/connect-tunnel/index.ts` has 582 (`wc -l`).

Differences that are real policy, not duplication (Proven by inspection). They must stay in each caller:

- **Server only:**
  - It passes `handshakeTimeout` and a timed TLS `createConnection` (`timedTlsConnection`, 665-697) to `ws`.
  - It records Cloudflare `cf-ray` and colo from the `upgrade` event (564-572).
  - It retries **at** the rejection or timeout event, without waiting for `close`. The test `plugins/connect/src/tunnel-lifecycle.test.ts:454` "retries an HTTP rejection without waiting for close" encodes this.
  - It keeps retrying after a 401/403, with back-off, and asks the account plugin to re-check the credential (`confirmRefused`, 469-477; test at 483).
  - It logs close diagnostics, including heartbeat age and `session.snapshot()`, which must be read **before** the session disposes (619-638). Its teardown closes an open socket gracefully with code 1000 and terminates it after a grace period (294-299).
- **Machine only:**
  - A 401/403 sets `credentialRejected`, which ends connect intent permanently. The test `apps/host-daemon/src/connect-tunnel/connect-tunnel.test.ts:445` expects exactly one attempt and `state: "offline"`.
  - It terminates a socket that opens after the dial was abandoned (411-415).
  - It uses a structured logger with `label`, and a `createWebSocket` factory that tests inject (`tunnelFactory` in the test file).
- Each tunnel has its own message text, for example "machine tunnel handshake timed out after Nms" against "can't reach <apex> — handshake timed out".

Ordering fact the dialer must keep (Proven by inspection): `TunnelSession.start` registers its own `close` listener, which calls `dispose()` (`packages/tunnel-client/src/session.ts:256`), and `dispose()` clears the stream maps (259-270). The server's close handler reads `session.snapshot()` and `lastHeartbeatAckAt` because its listener is registered before `session.start()`. A shared dialer must register its `close` listener before it starts the session, and it must report the close before it disposes the session.

Consumer search. Command: `git grep -n "@omnyo/tunnel-client\|TunnelSession(\|TUNNEL_REPLACED_CLOSE_REASON" e9e1b74… -- .`. Production dialers exist only in the two classes above. The other `TunnelSession` constructions are tests or harnesses: `apps/relay/src/*.test.ts`, `apps/relay/scripts/load-smoke.mjs:280-300` "dialTunnel", `apps/server/test/security/connect-request-guard.test.ts`, `plugins/connect/src/connect.test.ts` and `packages/tunnel-client/test/*`. They construct sessions directly and do not need to change. `@omnyo/tunnel-client` is private (`"private": true`) and consumed as source through a `workspace:*` dependency, so it has no external API or persisted-format obligations.

Correction to the sweep: none of the shared mechanics compresses much, because each caller still needs its own messages, logging, state and retry policy. The sweep's 80-150-line estimate counted the whole of both dial bodies, not only the shared part.

**Proposed end state and preservation argument**

Add `packages/tunnel-client/src/dial.ts`, exporting `dialTunnel` through `packages/tunnel-client/src/index.ts`. It owns only the shared socket mechanics. Each caller keeps its identity, URL, socket creation and options, messages, logging, status, retry and back-off policy, refusal policy and diagnostics.

```ts
export type TunnelDialEnd =
  | { kind: "handshake-timeout" }
  | { kind: "rejected"; statusCode: number; credentialRefused: boolean } // 401 or 403
  | {
      kind: "closed";
      code: number;
      reason: string;
      replaced: boolean; // code === 1000 && reason === TUNNEL_REPLACED_CLOSE_REASON
      connectedForMs: number | null; // null when the socket never opened
      transportError: Error | null; // last "error" event before close
    };

export interface TunnelDialOptions {
  socket: NodeWebSocket; // created by the caller, with its own ws options
  handshakeTimeoutMs: number;
  session: Omit<TunnelSessionOptions, "tunnel">; // export TunnelSessionOptions from session.ts
  onOpen(session: TunnelSession): void;
  onEnd(end: TunnelDialEnd): void; // called at most once per dial
}

export interface TunnelDial {
  abandon(): void; // ignore later events; does not close the socket
}

export function dialTunnel(options: TunnelDialOptions): TunnelDial;
```

The dialer behaves like this:

- On dial, it arms an unref'd deadline and registers the `open`, `unexpected-response`, `error` and `close` listeners.
- **Deadline.** If the dial has not ended or been abandoned, it calls `onEnd({kind:"handshake-timeout"})` and then `socket.terminate()`. This is the server's current order: retry, then terminate.
- **`open`.** It clears the deadline. If the dial was abandoned or has ended, it terminates the socket and returns; this is the machine's current behavior, and harmless for the server because the server's teardown already closes or terminates that socket. Otherwise it records `connectedAt`, constructs `new TunnelSession({ ...session, tunnel: socket })`, calls `start()`, and then calls `onOpen(session)`.
- **`unexpected-response`.** If the dial is still current, it calls `res.resume()`, then `onEnd({kind:"rejected", statusCode, credentialRefused})`, then `socket.terminate()`.
- **`error`.** If the dial is still current, it stores the error.
- **`close`.** It clears the deadline. If the dial is still current, it calls `onEnd({kind:"closed", …})` **before** disposing the session. In every case it then calls `session?.dispose()`, which is idempotent: `setRemoteClients` only notifies when the count crosses zero (`session.ts:277-283`).

How each consumer maps onto the dialer:

- **`ConnectTunnel.dial`** keeps its URL and log line, `DialDiagnostics`, the `upgrade` listener (attached to the socket before calling `dialTunnel`), the socket creation try/catch and the `retry` helper. The `isCurrent` closure shrinks to `this.isCurrentDial(epoch) && this.tunnel === tunnel`. `retryScheduled` is gone, because the dialer guarantees at most one `onEnd`. Teardown (`teardown`, 274-305) calls `this.dial?.abandon()` before its existing graceful close. The `onEnd` cases are:
  - `handshake-timeout` keeps today's text and `JSON.stringify(diagnostics)`.
  - `rejected` keeps the `refused` text, `confirmRefused` and the immediate retry.
  - `closed` builds the same detail JSON from `end.transportError`, `end.connectedForMs`, `this.session.lastHeartbeatAckAt` and `this.session.snapshot(now)`, all still readable because disposal happens after `onEnd`. A `replaced` close keeps `TUNNEL_REPLACED_RETRY_MS`. Any other close calls `retry(detail)`.
  - `lastError` for a transport error comes from `humanizeTransportError(end.transportError, connectApexHost(identity))` at close. Today it is assigned in the `error` handler, but the server does not publish between `error` and `close`, so the published state is identical.
- **`ConnectTunnelClient.openTunnel`** keeps its URL, log lines and socket creation try/catch, and stores the returned `TunnelDial` next to `this.socket`. `stopCurrentConnection` calls `abandon()` before `terminate()`. `rejectedStatus` and `handshakeTimedOut` disappear. `onOpen` sets `state`, `lastError` and `this.session`, then logs and publishes. The `onEnd` cases are:
  - `handshake-timeout`: same text and warning, then the shared "ended, intent still present" path: `this.socket = undefined`, `state = "reconnecting"`, `scheduleReconnect(0)`, publish.
  - `rejected`: same text and warning. If `credentialRefused`, it sets `credentialRejected = true` and runs the existing "no intent" branch (`state = "offline"`, `backoff.reset()`, publish). Otherwise it runs the reconnect path.
  - `closed`: today's close-handler logic. If there is no intent, go offline. Otherwise default `lastError` to `machine tunnel closed (code …)`, prefer `humanizeTransportError(end.transportError, `${label}.${baseDomain}`)` when an error was seen, and call `scheduleReconnect(end.connectedForMs ?? 0)`. `end.replaced` is ignored, which is today's behavior.

Preservation argument:

- Every message string, log line, retry delay and status field stays in the same caller with the same value.
- Event ordering is unchanged where tests or users can observe it:
  - The server still retries at rejection or timeout, without waiting for close.
  - The machine tunnel now acts at rejection or timeout instead of at the following `close`. `ws` emits that `close` right after `terminate()`, so the only difference is one fewer intermediate `onStatusChange` call, which in production is a debug log only (`apps/host-daemon/src/app.ts:776-781`).
  - The server's close diagnostics still see the live session snapshot.
- No public API, persisted data or wire format changes. `@omnyo/tunnel-client` is private and source-consumed.

What disappears: two handshake-deadline implementations, two 401/403 classifiers, two stale-socket and single-outcome guards (`retryScheduled`, `rejectedStatus`, `handshakeTimedOut`), and two copies of the session start/dispose wiring and connected-duration bookkeeping. After the change there is one place to add a new close reason, refusal status or handshake rule, and `replaced` is computed once.

Non-goals:

- Making the machine tunnel back off after a replaced close (ISS-S19-05; owner decision for the host-daemon and Connect owners).
- Aligning refusal policy, where the server keeps retrying and the machine stops.
- Passing `ws`'s own `handshakeTimeout` option from the machine tunnel.
- Moving `timedTlsConnection` or the Cloudflare diagnostics.
- Changing `load-smoke.mjs` or the test harnesses that construct `TunnelSession` directly.

**Expected gain and cost**

- **Mechanisms (observed today):** 2 handshake deadlines, 2 refusal classifiers, 2 stale-event guards, 2 copies of session wiring and 1 replaced detector. After the change: 1 of each, in `dialTunnel`.
- **Production lines (projection, not measured):**
  - The two dial bodies lose roughly 80-110 of their 245 non-blank lines: about 25-40 in the server tunnel, whose diagnostics and messages stay, and about 40-60 in the machine tunnel.
  - `dial.ts` adds about 70-90 lines, and `session.ts` and `index.ts` add 2-3 export lines.
  - Net change: about +10 to -35 non-blank production lines. Treat it as no material line reduction.
- **Tests:** add one focused `packages/tunnel-client/test/dial.test.ts`, roughly 80-120 lines, using a fake `EventEmitter` socket. It covers at most one `onEnd`, close-before-dispose ordering (the snapshot is readable inside `onEnd`), `replaced` detection, terminate-on-open after `abandon()`, and the deadline. The existing consumer tests stay unchanged and remain the behavioral baseline.
- **Maintenance gain:** a protocol-level change happens once, for example a new relay close reason, a new refusal status or a handshake fix such as the one #6401 had to port to the machine tunnel two months after #1784. The two classes become policy-only: what to say, whether to retry, and how long to wait.
- **Cost and tradeoff:** one more small public symbol in a private package, a callback interface the two classes depend on, and a one-day change to code where reconnect timing is user-visible.
- **Performance:** neutral by construction: the same listeners and timers, with no extra allocation per frame. No benchmark is needed.

**Execution steps**

1. **Reconfirm the anchors.** From the repository root, run `git diff --stat e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e HEAD -- plugins/connect/src/tunnel.ts apps/host-daemon/src/connect-tunnel packages/tunnel-client`. Re-read `ConnectTunnel.dial`, `ConnectTunnelClient.openTunnel` and `TunnelSession.start` and `dispose`. Re-plan if any of the following holds:
   - A third production dialer now exists (rerun the `git grep` from the Context section).
   - ISS-S19-05 was decided in favor of machine back-off. Then route `end.replaced` in the machine tunnel as decided, as a separate commit after step 5.
   - `TunnelSession` no longer registers its own `close` listener in `start()`.
   - `plugins/connect` has been added to `scripts/forkable-plugins.json`. Workspace imports would then be banned, and the server tunnel would have to keep its own copy.
2. **Establish the baseline.** Run the three consumer test files listed under verification and record that they pass. They already cover timeout, rejection (404 and 401/403), replaced close, a late close from a replaced socket, stop, and the transport-error and heartbeat diagnostics. No new characterization is needed in the consumers.
3. **Checkpoint A: add the dialer, with no consumer changes.**
   - In `packages/tunnel-client/src/session.ts`, add `export` to `interface TunnelSessionOptions` (line 157).
   - Create `packages/tunnel-client/src/dial.ts` with `dialTunnel`, `TunnelDialOptions`, `TunnelDialEnd` and `TunnelDial` as specified above. Import `TUNNEL_REPLACED_CLOSE_REASON` from `@omnyo/tunnel-contract`, which is already a dependency.
   - Export them from `packages/tunnel-client/src/index.ts`.
   - Add `packages/tunnel-client/test/dial.test.ts`.
   - Run the tunnel-client typecheck and tests.
4. **Checkpoint B: the machine tunnel.** In `apps/host-daemon/src/connect-tunnel/index.ts`:
   - Add `private dial: TunnelDial | undefined`.
   - Replace lines 387-502 of `openTunnel` with a `dialTunnel({ socket, handshakeTimeoutMs: this.handshakeTimeoutMs, session: { log: …, resolveOrigin: (t) => this.resolveOrigin(t) }, onOpen, onEnd })` call, mapping each `onEnd` case as described.
   - Factor the shared "socket ended" tail (`this.socket = undefined`, the intent check, offline or reconnect, publish) into one private method that both `onEnd` and nothing else calls.
   - In `stopCurrentConnection` (564-577), call `this.dial?.abandon()` and clear `this.dial`.
   - Run the host-daemon connect-tunnel test file. Every case must pass without editing the tests.
5. **Checkpoint C: the server tunnel.** In `plugins/connect/src/tunnel.ts`:
   - Add `private dial: TunnelDial | undefined`.
   - In `dial()`, keep lines 491-525 (URL, log, diagnostics, create, `this.tunnel = tunnel`) and the `upgrade` listener. Replace lines 526-652 with `dialTunnel(...)`.
   - Remove `retryScheduled`, `connectedAt` and `transportError`, and reduce `isCurrent` to `this.isCurrentDial(epoch) && this.tunnel === tunnel`.
   - Keep the `retry` helper, passing `end.connectedForMs ?? 0` for the stable time.
   - In `teardown()`, call `this.dial?.abandon()` before the session dispose and socket close.
   - Leave `scheduleRetry`'s `this.session?.dispose()` (idempotent) in place, because the credential-read failure paths also use it.
   - Run both Connect test files without editing them.
6. **Clean up and review.** Confirm that no `handshakeDeadline`, `rejectedStatus`, `handshakeTimedOut`, `retryScheduled` or `TUNNEL_REPLACED_CLOSE_REASON` reference remains in either consumer (`rg -n "handshakeDeadline|rejectedStatus|handshakeTimedOut|retryScheduled|TUNNEL_REPLACED_CLOSE_REASON" plugins/connect/src/tunnel.ts apps/host-daemon/src/connect-tunnel/index.ts` should match nothing). Check that the `@omnyo/tunnel-contract` import in `plugins/connect/src/tunnel.ts` still lists only the constants it uses. Format and lint the changed files. Recount the non-blank lines of both dial bodies and `dial.ts` against the baseline above, and report the measured net in the commit message.

**Verification and acceptance criteria**

All commands run from the repository root (`$OMNYO_CHECKOUT` or a worktree of it) after `pnpm install`. The package scripts were confirmed in the snapshot's `package.json` files. The `pnpm --filter … exec vitest run <file>` forms are standard pnpm and vitest usage and were not executed, because the snapshot had no `node_modules`.

- `pnpm --filter @omnyo/tunnel-client typecheck` and `pnpm --filter @omnyo/tunnel-client test` (scripts `typecheck` and `test` in `packages/tunnel-client/package.json`).
- `pnpm --filter @omnyo/host-daemon typecheck`, then `pnpm --filter @omnyo/host-daemon exec vitest run --config vitest.config.ts src/connect-tunnel/connect-tunnel.test.ts`. All nine cases must pass, including "abandons a handshake the gate never answers and dials again", "stops reconnecting when the gate rejects the machine credential" (exactly one attempt) and "retries rejected 404 handshakes with backoff until the gate upgrades".
- `pnpm --filter omnyo-plugin-connect typecheck`, then `pnpm --filter omnyo-plugin-connect exec vitest run --config vitest.config.ts src/tunnel-lifecycle.test.ts src/connect.test.ts`. All 17 lifecycle cases must pass unchanged, in particular:
  - "retries an HTTP rejection without waiting for close"
  - "schedules one retry when rejection is followed by close"
  - "backs off for minutes when another Omnyo takes over the tunnel"
  - "keeps a healthy tunnel's status when a replaced socket from a reconnect closes late"
  - "logs the transport error and heartbeat age for each connection without carrying them across retries", which proves the session snapshot is still read before disposal
  - "sets a bounded opening handshake timeout"
  - "closes an open tunnel cleanly on stop so the gate treats it as offline at once"
- The relay round-trip tests that construct `TunnelSession` directly should be unaffected. Optionally run `pnpm --filter @omnyo/relay test`.
- Formatting and lint for the changed files: `pnpm exec oxfmt <files>` and `pnpm exec oxlint --deny-warnings <files>`. The root has `.oxfmtrc.json` and `.oxlintrc.json`, and its `format:check` script is `oxfmt . --check`.
- Behavior acceptance:
  - No consumer test is edited.
  - Error text and the order of `lastError` assignment per scenario are unchanged.
  - `onEnd` fires at most once per dial, which the new dial test asserts.
  - An abandoned dial never changes caller state.
- Structural acceptance:
  - Both classes call `dialTunnel`.
  - The step 6 `rg` matches nothing.
  - `replaced` is computed only in `packages/tunnel-client/src/dial.ts`.
- UI: there is no UI change. The Connect settings status reads `lastError`, `state` and `nextRetryAt`, which are covered by the plugin tests above. Alex tests UI himself if desired.

**Rollback and stop conditions**

- **Rollback.** Each checkpoint is a separate commit that touches one package. Reverting checkpoint C or B restores that consumer's inline lifecycle while the unused `dialTunnel` stays harmless. Reverting A removes it. There are no data, persisted-format or wire-protocol implications.
- **Stop conditions:**
  - A consumer test fails and can only pass if its expectation changes. That means the behavior changed, so stop and re-plan; do not edit the test.
  - The callback surface needs more than the four members above (`socket`, `session`, `onOpen`, `onEnd`, plus the timeout value) to preserve either caller, for example per-caller error-suppression flags or ordering switches. Then the shared part is too thin. Fall back to a smaller alternative: export only `isTunnelReplacedClose(code, reason)` and `isRefusedTunnelStatus(status)` from `@omnyo/tunnel-client`, and leave both lifecycles in place.
  - `plugins/connect` becomes forkable, which bans workspace imports.
  - A third production dialer appears with different needs.
  - The ISS-S19-05 decision changes the machine tunnel's replaced-close behavior. Land that decision separately, before or after, never folded into this refactor.
