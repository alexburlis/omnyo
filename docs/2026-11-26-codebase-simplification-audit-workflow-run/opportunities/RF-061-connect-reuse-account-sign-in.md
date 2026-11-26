# RF-061 — Share the Omnyo Account sign-in poll schedule and pairing-code format between the Connect and Omnyo Account settings pages (retiring Connect's inline sign-in stays a separate owner decision)

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The sweep's central observation holds: `plugins/connect/app.tsx` contains a second client for the Omnyo Account `login.start`, `login.poll`, `login.cancel` and `redeemCode` RPCs, with its own copy of the poll schedule and the pairing-code format. The sweep overstated the safe gain, though. Its option (b), deleting Connect's flow and linking to Settings → Omnyo account, collides with a current requirement it missed: first-run onboarding embeds Connect's settings section inline (`apps/app/src/components/onboarding/OnboardingFlow.tsx:1360`, `connectSetup={<PluginSettingsSections pluginId={CONNECT_PLUGIN_ID} />}`). The plugin SDK also has no way for one plugin to open another plugin's settings page (see Context). Most of the remaining "duplication" is deliberately different UI and copy. What is truly the same knowledge in both files is small: the poll timing, the poll loop and the `XXXX-XXXX` pairing-code format.
- **Recommended scope (this card):** option (a), narrowed. Move the poll constants, the poll loop and the pairing-code formatter and validator into `@omnyo/connect-client`, and have both plugins import them. Keep both layouts and all copy exactly as they are.
- **Alternative (b), not planned here:** retire Connect's inline sign-in. That retires a documented capability, so it is decision-needed (see "Owner decision" under Proposed end state).
- **Potential:** low. About 30-40 handwritten production lines disappear net, together with one duplicated policy: the poll backoff and the code format.
- **Confidence:** high for the narrowed scope (Proven by inspection). Low for the sweep's 300-350-line figure, which assumed option (b).
- **Readiness:** ready for the narrowed scope. Option (b) is decision-needed.
- **Effort:** about two hours, including a small unit test in `packages/connect-client`.
- **Risk:** low. The realistic regression is a change in poll timing or cancellation semantics. The existing backoff tests in both plugins pin the timing.
- **Prerequisites:** none.
- **Related and overlapping items:** RF-111 (move the relay base-URL policy into `@omnyo/connect-client`) and RF-135 (build Connect share origins in `connect-client`) also add exports to `packages/connect-client/src/index.ts`. Whichever lands second must rebase onto the index edit. There is no ordering dependency.
- **Why it deserves its place:** today, changing the sign-in poll backoff or the omnyo.link pairing-code shape means editing two plugins identically, and nothing fails if only one is edited. That is a small but real drift risk. The item ranks low because the shared knowledge is only about 25 lines per side.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The dedicated snapshot worktree had been removed by verification time, so files were read with `git -C $OMNYO_CHECKOUT show e9e1b74c:<path>` and searched with `git grep <pattern> e9e1b74c -- <paths>`. `git diff --stat e9e1b74c 5f2d3f895 -- plugins/connect plugins/omnyo-account packages/connect-client apps/app/src/components/onboarding/OnboardingFlow.tsx` printed nothing, so local `main` matched the snapshot for these paths. No tests were run, because the snapshot has no `node_modules`.

*How the two plugins relate (Proven by inspection).* Omnyo Account (`plugins/omnyo-account`) owns this server's omnyo.link credential and the device-code sign-in. Connect (`plugins/connect`) provides remote access and talks to Omnyo Account by plugin id through `sdk.plugins.callRpc` (`plugins/connect/src/account-client.ts:4` `ACCOUNT_PLUGIN_ID = "omnyo-account"`). Neither plugin is in `scripts/forkable-plugins.json`. Both already depend on the private workspace package `@omnyo/connect-client` (`plugins/connect/package.json:41`, `plugins/omnyo-account/package.json:38`), and Connect's app bundle already imports it (`plugins/connect/app.tsx:11-15`, `encodeMobilePairingPayload`). A shared module there therefore needs no new dependency.

*Where each sign-in lives (Proven by inspection).*

| Concern | Connect `plugins/connect/app.tsx` | Omnyo Account `plugins/omnyo-account/app.tsx` | Same knowledge? |
|---|---|---|---|
| Poll timing | `:65-73` `LOGIN_POLL_MS`, `LOGIN_POLL_MAX_MS`, `loginPollDelay` | `:36-44`, the same three symbols | Yes, byte-identical |
| Poll loop | `:1179-1218` inside `useAccountLogin` | `:568-598` inside `SignInDialog` | Yes: first poll after 2 s, failure count, delay from `loginPollDelay`, cancel flag. Only the result handler differs. |
| Code format | `:259-272` `formatConnectCode`, `isCompleteCode` | `:82-95` `formatPairingCode`, `isCompletePairingCode` | Yes, identical bodies |
| `hostOf` | `:251-257`, which strips `https?://` on a parse failure | `:74-80`, which returns the raw string on a parse failure | No: different fallback, and Connect uses it for shares and status too |
| Pairing error copy | `:75-116` `PAIR_ERROR_COPY` (lead + dashboard link + tail; includes `account_unavailable`), `:118-144` `isUnavailableError`, `toPairErrorCode` | `:49-72` `ERROR_COPY` (plain sentences, also used for sign-out errors; includes `rate_limited` and `unavailable`) | No: different structure and wording, by design |
| Start-error copy | `:554-567` `signInStartErrorText` | `ERROR_COPY` through `errorText` | Partly: the `rate_limited` sentence is identical, `unavailable` differs |
| Pairing form | `:445-552` `PairForm`: auto-submits a complete code, primary `Pair` button, linked error card | `:372-438` `PairCodeForm`: submit only, outline `Pair` button, plain error line | No: different behavior and visuals |
| Sign-in UI | `:1243-1326` `AccountSignInCard`: inline card with Cancel, "Signed in. Remote access is starting…" | `:440-649` `SignInDialogBody` and `SignInDialog`: a dialog that closes on approval and cancels on close | No: different surface |

The sweep's line ranges for Connect are accurate. Counted with `sed -n 'a,bp' | grep -c .` over the files extracted from the snapshot, the Connect sign-in machinery covers about 389 lines (`65-73`, `75-144`, `259-272`, `445-567`, `1151-1326`), plus `loginViewSchema` and `loginPollOutputSchema` in `plugins/connect/src/account-client.ts:35-56`. Only about 46 of those lines restate knowledge that Omnyo Account also holds.

*Why the copies differ in transport (Proven by inspection).* Omnyo Account's app uses `useRpc`, which is bound to the calling plugin's own id (`apps/app/src/lib/plugin-sdk-hooks.ts:318` `useRpc`, calling `callPluginRpc` with `usePluginId()`). That path throws the bare server message, for example `expired_code` (`plugin-sdk-hooks.ts:251-262`). Connect must call another plugin, so it uses `sdk.plugins.callRpc` with explicit output schemas. That path's errors carry an `HTTP <status>: ` prefix, which `accountErrorCode` strips (`plugins/connect/src/account-client.ts:106-110`). The tests encode both shapes: `plugins/connect/app.test.tsx:316` throws `"HTTP 500: expired_code"`, and `plugins/omnyo-account/app.test.tsx:312` throws `"expired_code"`. Connect's lenient schema copies (`account-client.ts:20-56`, non-strict, `state` as any non-`signed-in` string) are a consumer-side boundary check and are not a target here.

*Current requirement the sweep missed (Proven by inspection).* `apps/app/src/components/onboarding/OnboardingFlow.tsx:1360` passes `<PluginSettingsSections pluginId={CONNECT_PLUGIN_ID} />` as `connectSetup` to `DevicesStep` (`apps/app/src/components/onboarding/OnboardingViews.tsx:1306-1360`), so the first-run "Use Omnyo from anywhere" step renders Connect's settings section, including `NotPairedContent` and its inline sign-in, without leaving onboarding. `plugins/connect/PLUGIN_OVERVIEW.md` documents "Sign in from Settings → Omnyo connect, Settings → Omnyo account, or `omnyo account login`".

*No cross-plugin settings navigation in the SDK (Proven by inspection).* `experimental_AppNavigate` (`packages/plugin-sdk/src/app-contract.ts:4223`) offers `toThread`, `toProject`, `toPluginPanel` (this plugin's own panels only), `toCompose` and panel openers. `openSettings()` (`app-contract.ts:1040`) opens only the registering plugin's own detail page. The search `git grep -n -i "navigat\|openSettings\|settings/plugins\|useNavigate\|SettingsLink\|PluginLink" e9e1b74c -- packages/plugin-sdk/src` found no API that opens another plugin's settings or dialog.

*Co-change (Proven by inspection, history in the private store).* The public repository has one squashed commit for these files. In `$ARCHIVED_OMNYO_CHECKOUT`, 4 of 13 commits to `plugins/connect/app.tsx` since 2026-09-29 also touched `plugins/omnyo-account/app.tsx` (`f9e0b51a66`, `86c0d9e3fe`, `53ed71ff8e`, `c92f4c2e5e`). Two of those are a lint-wide and a migration-wide change, so the history shows limited sign-in-specific co-change. The drift risk is structural (Hypothesis, low cost), not observed as a past bug.

*Consumers checked.* `git grep -n "LOGIN_POLL\|loginPollDelay\|A-Z0-9\]{4}" e9e1b74c` found the poll and code-format symbols only in the two `app.tsx` files. The Omnyo Account CLI and server use their own device-flow timing (`plugins/omnyo-account/src/login.ts:20-28`, `minIntervalMs`/`maxIntervalMs`), which is a different, server-side poll of omnyo.link and is not part of this change. Neither app file exports these helpers, and no SDK or plugin-SDK export is involved.

**Proposed end state and preservation argument**

*What remains and who owns it.* `@omnyo/connect-client` becomes the owner of the client-side Omnyo Account sign-in poll schedule and the omnyo.link pairing-code format, in a new module `packages/connect-client/src/account-login.ts`:

```ts
export const LOGIN_POLL_MS = 2_000;
export const LOGIN_POLL_MAX_MS = 30_000;
export function loginPollDelay(failures: number): number; // body unchanged
export function formatPairingCode(raw: string): string;    // body of formatConnectCode
export function isCompletePairingCode(formatted: string): boolean;
/** Polls until stopped: first call after LOGIN_POLL_MS, then loginPollDelay(failures). */
export function startLoginPolling<T>(
  poll: () => Promise<T>,
  onResult: (result: T) => void,
): () => void; // returns stop()
```

`startLoginPolling` must keep today's exact structure: `failures` starts at 0; the first `setTimeout(poll, LOGIN_POLL_MS)`; `poll().then(result => { failures = 0; if (!cancelled) onResult(result); }, () => { failures += 1; }).finally(() => { if (!cancelled) timer = setTimeout(tick, loginPollDelay(failures)); })`; and `stop()` sets `cancelled = true` and calls `clearTimeout(timer)`. Keeping `.then(onSuccess, onFailure).finally(...)` keeps the current behavior when the success handler throws: the loop still reschedules.

*What each plugin keeps.* Connect keeps `useAccountLogin`, `AccountSignInCard`, `PairForm` (with auto-submit), `PAIR_ERROR_COPY`, `toPairErrorCode`, `signInStartErrorText`, its own `hostOf` and its lenient schemas. Omnyo Account keeps `SignInDialog`, `SignInDialogBody`, `PairCodeForm`, `ERROR_COPY` and its own `hostOf`. Every visible string, layout, button variant, focus behavior and cancellation rule stays the same.

*Why semantics survive.* The moved constants and formatter bodies are byte-identical today. The poll loop differs between the two copies only in the result handler, which stays in each plugin as `onResult`. The effect dependencies (`[onSignedIn, pendingId, sdk]` in Connect, `[onLogin, pendingId, rpc]` in Omnyo Account) and the effect cleanup stay in place; the cleanup returns the `stop` function. Performance is unchanged: there is the same number of timers and RPC calls, and `@omnyo/connect-client` is already in Connect's bundle. For Omnyo Account's app bundle, the import adds only this module, because the package declares `"sideEffects": false`.

*Non-goals.* Do not unify `hostOf` (the fallbacks differ). Do not unify error copy or the pairing forms (a copy or UX decision). Do not replace Connect's schema copies with Omnyo Account's strict schemas (that would couple Connect to exact contract versions). Do not change `useRpc` versus `callRpc` error shapes.

*Owner decision, outside this plan.* Option (b) would retire Connect's inline sign-in and pairing form (about 390 lines in `plugins/connect/app.tsx` plus `account-client.ts:35-56`). It is only coherent if the owner also decides how onboarding signs the user in, for example by rendering `<PluginSettingsSections pluginId="omnyo-account" />` before Connect's section in `DevicesStep`. The owner must also decide how Settings → Omnyo connect reaches the account page, which needs either a new plugin-SDK navigation method (new public surface) or plain copy that points the user to Settings → Omnyo account. That retires a documented capability and changes first-run UX, so it needs the owner's decision. Do not fold it into this card.

**Expected gain and cost**

- *Removed (projection from line counts at the snapshot):* Connect `:65-73` (9 lines), `:259-272` (14 lines) and about 23 lines of loop body at `:1179-1218`. Omnyo Account `:36-44` (9 lines), `:82-95` (14 lines) and about 21 lines at `:568-598`. That is about 90 handwritten production lines.
- *Added:* about 45 lines in `packages/connect-client/src/account-login.ts` and about 8 export lines in `packages/connect-client/src/index.ts`. Net production change: about −30 to −40 lines.
- *Tests:* add about 40-60 lines in `packages/connect-client/test/account-login.test.ts` (fake timers: the first poll at 2,000 ms, backoff to 4,000 ms after one failure, a 30,000 ms cap, reset after success, no reschedule after `stop()`; formatter cases such as `" k7qp2m4x "` → `K7QP-2M4X`). These tests are counted separately from production lines.
- *Mechanisms:* two poll loops and two code formatters become one each. Changing the backoff or the code shape becomes one edit, which both plugins' existing UI tests then check.
- *Unknown:* whether more sign-in surfaces (for example mobile) will join later; nothing in the snapshot suggests so.

**Execution steps**

1. Reconfirm the baseline. Run `git -C $OMNYO_CHECKOUT diff --stat e9e1b74c HEAD -- plugins/connect/app.tsx plugins/omnyo-account/app.tsx packages/connect-client`. If either app no longer has `loginPollDelay`, `formatConnectCode`/`formatPairingCode` or the poll effect described above, re-plan. If Alex has decided option (b) in the meantime, stop and plan that instead.
2. Add `packages/connect-client/src/account-login.ts` with the five exports in the signature block above. Copy `loginPollDelay` and the formatter and validator bodies verbatim from `plugins/omnyo-account/app.tsx:36-44` and `:82-95`. Write `startLoginPolling` from `plugins/omnyo-account/app.tsx:570-597`, with the result handler replaced by `onResult` and the cleanup returned as `stop`.
3. Export the five symbols from `packages/connect-client/src/index.ts`, in a new block next to the `mobile-pairing.js` exports.
4. Add `packages/connect-client/test/account-login.test.ts` with the cases listed under Expected gain. Checkpoint: `pnpm --filter @omnyo/connect-client test` and `pnpm --filter @omnyo/connect-client typecheck` pass.
5. Connect, `plugins/connect/app.tsx`: delete `LOGIN_POLL_MS`, `LOGIN_POLL_MAX_MS` and `loginPollDelay` (`:65-73`) and `formatConnectCode` and `isCompleteCode` (`:259-272`). Import `formatPairingCode`, `isCompletePairingCode` and `startLoginPolling` from `@omnyo/connect-client` in the existing import at `:11-15`. In `PairForm` (`:445-552`), rename the three call sites. In `useAccountLogin` (`:1151-1241`), replace the effect body at `:1179-1218` with:
   ```ts
   useEffect(() => {
     if (pendingId === null) return;
     return startLoginPolling(
       () => sdk.plugins.callRpc({ pluginId: ACCOUNT_PLUGIN_ID, method: "login.poll",
         input: { loginId: pendingId }, outputSchema: loginPollOutputSchema }),
       (result) => {
         if (result.login !== null) setLogin(result.login);
         if (result.login?.state === "signed-in") onSignedIn();
       },
     );
   }, [onSignedIn, pendingId, sdk]);
   ```
   Checkpoint: `pnpm --filter omnyo-plugin-connect test` passes unchanged, especially `app.test.tsx:135` ("signs in through Omnyo account, shows the code, and waits for approval"), `:194` ("backs off the sign-in poll…"), `:257` (auto-submit of a normalized code) and `:294` (no auto-submit of an incomplete code).
6. Omnyo Account, `plugins/omnyo-account/app.tsx`: delete `:36-44` and `:82-95`, and add `import { formatPairingCode, isCompletePairingCode, startLoginPolling } from "@omnyo/connect-client";`. In `SignInDialog`, replace the effect at `:568-598` with `if (pendingId === null) return; return startLoginPolling(() => rpc.call("login.poll", { loginId: pendingId }), onLogin);` and keep the dependencies `[onLogin, pendingId, rpc]`. The `LOGIN_POLL_MS` reference disappears with the loop. Checkpoint: `pnpm --filter omnyo-plugin-omnyo-account test` passes unchanged, especially `app.test.tsx:160`, `:207` (backoff), `:283` (cancel on close) and `:312` (pasted code normalization).
7. Format and lint the changed files from `$OMNYO_CHECKOUT` with `pnpm exec oxfmt <files>`, then `pnpm exec oxlint --deny-warnings --format=agent <files>`.
8. Inspect the full diff. Confirm that no copy string, class name or button variant changed in either `app.tsx`, and that no second copy of the moved symbols remains: `rg -n "LOGIN_POLL|loginPollDelay|formatConnectCode|isCompleteCode\b|A-Z0-9\]\{4\}" plugins/connect plugins/omnyo-account` should print only import lines. Recount the net production lines against the baseline with `git diff --numstat`.

**Verification and acceptance criteria**

All commands run from `$OMNYO_CHECKOUT` after `pnpm install`. The package names come from each `package.json` at the snapshot (`@omnyo/connect-client`, `omnyo-plugin-connect`, `omnyo-plugin-omnyo-account`). Each package defines `test` (`vitest run --config vitest.config.ts`) and `typecheck` (`tsc --noEmit`). The commands themselves were not run during this audit.

- `pnpm --filter @omnyo/connect-client test` and `pnpm --filter @omnyo/connect-client typecheck`: the new unit tests pass.
- `pnpm --filter omnyo-plugin-connect test` and `pnpm --filter omnyo-plugin-connect typecheck`: all existing Connect app tests pass with no edits to `plugins/connect/app.test.tsx`.
- `pnpm --filter omnyo-plugin-omnyo-account test` and `pnpm --filter omnyo-plugin-omnyo-account typecheck`: all existing Omnyo Account app tests pass with no edits to `plugins/omnyo-account/app.test.tsx`.
- Format and lint: `pnpm exec oxfmt --check <changed files>` and `pnpm exec oxlint --deny-warnings --format=agent <changed files>`. `oxfmt` and `oxlint` are root devDependencies; the per-file form follows the global agent instructions, not a repository script.
- Bundle: each plugin has `prepare:bundled` (`omnyo-plugin-build prepare-bundled`). Running `pnpm --filter omnyo-plugin-omnyo-account run prepare:bundled` should succeed with the new `@omnyo/connect-client` import in the app entry. What this script writes was not confirmed during the audit, so run it in a disposable worktree.
- Behavior contract: timing is pinned by the two existing "backs off the sign-in poll" tests (the first poll at 2,000 ms and the second at +4,000 ms after a failure). Cancellation is pinned by `omnyo-account/app.test.tsx:283`. Code normalization is pinned by `connect/app.test.tsx:257` and `omnyo-account/app.test.tsx:312`. The backoff cap and the reset after success are covered by the new connect-client test.
- UI: no visual change is expected. A manual check of Settings → Omnyo connect (signed out) and Settings → Omnyo account → Sign in should show identical copy and layout before and after. Alex tests UI himself; no screenshot round is required for this dev change.
- Structural completion: each app has exactly one import of the shared helpers and no local poll constants, formatter or poll loop.

**Rollback and stop conditions**

- *Rollback:* the change touches three packages and one new file, with no persisted data, RPC contract or public SDK surface involved. Reverting the single commit restores the previous state.
- *Stop if:* either plugin's existing tests need an expectation change to pass (that means the semantics moved); an `app.tsx` needs a copy or class change; `@omnyo/connect-client` turns out to be unusable in the Omnyo Account app bundle (for example a Node-only import pulled in through `index.ts`), in which case import from a dedicated subpath export instead of the root, or stop; or Connect or Omnyo Account is added to `scripts/forkable-plugins.json` before this lands, in which case workspace imports are forbidden and the shared module would have to live in the packed plugin SDK, which needs re-planning.
- *Safer smaller alternative:* share only the constants and the code formatter (about 23 lines per side) and leave both poll loops in place.
