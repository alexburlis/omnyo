# RF-074 — Retire the mobile Phase 0 WebView spike route, screen and probe harness

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Potential:** medium. One whole developer route disappears: 1,157 handwritten lines across three files, 15 injected probe scripts, and an on-device session log. Nothing else in the product depends on that code. The maintenance burden it carries today is modest, though. Every recorded edit since August 2026 came from a repository-wide sweep such as lint, renames or the relay-address migration, never from feature work.
- **Confidence:** high that the code is reachable only through the gated developer route and that no flow, script or document drives it. Medium that nobody still opens it by hand on a test device, because ad-hoc device use leaves no trace in the repository.
- **Readiness:** decision-needed. Alex must confirm that the on-device WebView diagnostic tool is no longer wanted.
- **Effort:** small, about one hour including verification.
- **Risk:** low. Release bundles already redirect the route home, and no package dependency or shared module loses its last consumer.
- **Prerequisites:** the owner decision in step 0 below.
- **Related or overlapping items:** RF-012 (retire the one-time BB-to-Omnyo rename tooling) owns `scripts/omnyo-renderer-map.mjs`, which lists the probe file by path. RF-075 (retire or slim the iOS timeline-windowing acceptance harness) is a separate mobile developer harness, and its decision is independent of this one. No other overlap.
- **Why it deserves its place:** this is a large, self-contained piece of finished evaluation scaffolding. Removing it is close to free and fully reversible. It ranks below items that remove shared state coordination or duplicated domain rules, because this code couples to the rest of the app only through stable, small APIs.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The snapshot worktree named in the audit brief was no longer on disk, so every read used `git show <commit>:<path>` and `git grep <commit>` in `$OMNYO_CHECKOUT`. Private history came from read-only `git log` in `$ARCHIVED_OMNYO_CHECKOUT`.

*What the code is.* The Expo mobile app (`apps/mobile`) is a native shell around the web app, loaded in a WebView. In August 2026 the native mobile UI was replaced with that shell (private commit `15e87df425`, "Replace the native mobile UI with a WebView shell around the PWA (#2515)"). That commit removed the earlier `app/dev/spike.tsx`, `app/dev/connect-spike.tsx` and `e2e/spike/*.yaml` flows and added the current WebView spike screen. Its commit message points to the plan in Docs `plans/mobile-webview-shell.md`, whose section 11 records the evaluation verdicts. The spike screen is a diagnostic WebView that does the following:

- It loads any URL. The default is `http://localhost:18524/`, and query parameters such as `url`, `grant`, `chrome`, `incognito`, `cache`, `accessory`, `appbound`, `code`, `probes`, `nonce` and `delay` drive it from a deep link (`apps/mobile/src/screens/dev/WebViewSpikeScreen.tsx:71` "WebViewSpikeScreen", lines 74-86).
- It can redeem an Omnyo Connect machine code and inject the session cookie (`WebViewSpikeScreen.tsx:150-195` "enroll", which uses `redeemMachineCredential`, `fetchDesktopSession` and `CookieManager.set`).
- It injects a harness and runs 15 named JavaScript probes covering environment, boot timing, voice, clipboard, WebSocket, terminal, viewport, focus and the file chooser (`apps/mobile/src/screens/dev/webview-spike-probes.ts:1` "SPIKE_HARNESS", `:666` "SPIKE_PROBES", `:684` "SpikeProbeId").
- It logs every event to the console and appends it to `Documents/webview-spike/session.jsonl` on the device (`WebViewSpikeScreen.tsx:46` "appendSessionLine").

*How it is reached (Proven by inspection).*

- `apps/mobile/app/dev/webview-spike.tsx:5` "WebViewSpikeRoute" renders the screen only when `e2eModeEnabled` is true, and otherwise returns `<Redirect href="/" />`. `e2eModeEnabled` comes from `apps/mobile/src/app-shell/e2e.ts:15` (`isE2eModeEnabled(env, __DEV__)`), so it is true only in `__DEV__` builds or when `EXPO_PUBLIC_OMNYO_E2E` is set.
- `apps/mobile/src/screens/shell/RootNavigator.tsx:117` registers `<Stack.Screen name="dev/webview-spike" options={hiddenHeader} />`.
- Incoming `omnyo://dev/...` links pass through `apps/mobile/src/lib/shell/shell-links.ts:71`. There `isDeveloperRoutePath` (`apps/mobile/src/lib/links/incoming-link.ts:43`, with prefixes `DEVELOPER_ROUTE_PREFIXES = ["/dev", "/e2e"]` at line 30) sends the link home unless `developerRoutesEnabled` is set (`apps/mobile/app/+native-intent.tsx:21`).
- `apps/mobile/README.md:37-38` documents the route as "Phase 0 WebView diagnostics (dev / EXPO_PUBLIC_OMNYO_E2E=1 only: release bundles redirect home)". `README.md:86-87` lists "dev/ (WebViewSpikeScreen + probes)" in the source layout.

*Line counts (Reproduced with `git show e9e1b74c…:<file> | wc -l`):*

| File | Lines | Non-blank | Bytes |
|---|---|---|---|
| `apps/mobile/src/screens/dev/WebViewSpikeScreen.tsx` | 464 | 418 | 13,548 |
| `apps/mobile/src/screens/dev/webview-spike-probes.ts` | 684 | 657 | 25,211 |
| `apps/mobile/app/dev/webview-spike.tsx` | 9 | 7 | 293 |
| **Total handwritten production code** | **1,157** | 1,082 | 39,052 |

The sweep report said 1,148 lines because it left out the 9-line route file. Smaller edits outside those files: 1 line in `RootNavigator.tsx`, 3 README lines, and 1 path entry in `scripts/omnyo-renderer-map.mjs:403`.

*Consumer search (Reproduced).* I ran `git grep -n -i -E 'webview-spike|WebViewSpike|__omnyoSpike|SPIKE_PROBES|spike-url|session\.jsonl' e9e1b74c… -- .` over the whole snapshot. Outside the two screen files it found only these:

- the route file, `RootNavigator.tsx:117` and `README.md:37,87`;
- the two tests that use the path as an example: `apps/mobile/src/lib/links/incoming-link.test.ts:159` and `apps/mobile/src/lib/shell/shell-links.test.ts:39,42,48`;
- `scripts/omnyo-renderer-map.mjs:403`, an entry in the `embeddedRendererFiles` set of the one-time rename tool (RF-012).

No Maestro flow under `apps/mobile/e2e/` (`flows/*`, `android/*`, `subflows/*`, `scripts/*`) and no file under `apps/mobile/script/`, `scripts/`, `tests/`, `docs/` or `.github/` opens `omnyo://dev/...` (I searched for `omnyo://dev|/dev/|openurl` in those paths). A search of `$HOME/.agents`, `$HOME/.claude/skills` and `$OMNYO_PLUGIN_CHECKOUT` for `webview-spike|webview spike|phase 0 webview` found nothing. The 2026-11-25 Codex audit does not mention the spike.

*Counterevidence (Proven by inspection).* In the retired private checkout, the verification recipe `.omnyo/skills/verify-omnyo/features/mobile.md:44` still lists the check "Open developer WebView spike and E2E reset only in their gated test build; navigate an unknown native route." The public snapshot has no `verify-omnyo` skill (`git ls-tree -r --name-only e9e1b74c… | grep -i verify` matches only `scripts/verify-command-metadata-watchers.mjs`), so this recipe is not part of the active repository. It does show that the route once served as the example for gating developer routes. That gating check survives with `e2e/reset`.

*Dependencies the screen pulls in all keep other consumers (Proven by inspection).*

| Dependency | Other consumers |
|---|---|
| `@react-native-cookies/cookies` | `apps/mobile/src/lib/native/cookie-store.ts:1` and `apps/mobile/src/screens/webview/ProfileWebViewScreen.tsx:8` |
| `WebViewKeyboardFrame` | `ProfileWebViewScreen.tsx:25`. On iOS the component is a plain re-export of `View` (`WebViewKeyboardFrame.tsx:1`). |
| `redeemMachineCredential` | `apps/mobile/src/data/connect/enrollment.ts:4` and the desktop app |
| `fetchDesktopSession` | `apps/mobile/src/lib/session/session-scheduler.ts:2` and the desktop app |
| `firstParam` | the shell's `hrefs.ts` |

No package, native module or patch can be dropped. This corrects the sweep's suggestion that the screen "pulls in" these dependencies: removing it removes coupling, not dependencies.

*Maintenance cost observed (Reproduced through private `git log` of the three files).* There were 11 commits from 26 August to 24 November 2026. All of them were sweep-driven rather than feature work:

- the comment ban (`8b22136257`);
- the swipe-navigation flag (`a7e2db0975`);
- dead-code dedupe (`3b37d2790d`);
- Android preparation (`5959fb6209`);
- a probe tweak during voice-send work (`4b8574b5e3`);
- lint formatting (`86c0d9e3fe`);
- the getbb.app cleanup (`9ed9c75c28`);
- the promise lint (`0509f46aae`);
- the two BB-to-Omnyo renames (`2ac32c8a52`, `3971049fa4`);
- the omnyo.link relay migration (`67a574a192`).

The probe file was also listed in the rename tooling's renderer map and in the migration coverage table (`docs/omnyo-migration/coverage.tsv:26` in the private repository). Each repository-wide sweep therefore has to touch, type-check and lint about 1,150 lines that no product path runs.

*Release bundle (Hypothesis).* Expo Router builds its route tree from every file under `app/`. `apps/mobile/metro.config.js` and `apps/mobile/app.config.js` contain no exclusion for `app/dev`. The roughly 39 KB of source, mostly probe-script string literals, is therefore probably compiled into release JavaScript bundles too, even though the route redirects there. I did not build a bundle to confirm this.

**Proposed end state and preservation argument**

*What disappears:*

- `apps/mobile/app/dev/webview-spike.tsx`, together with its `app/dev/` directory, which becomes empty;
- `apps/mobile/src/screens/dev/WebViewSpikeScreen.tsx` and `apps/mobile/src/screens/dev/webview-spike-probes.ts`, together with `src/screens/dev/`, which also becomes empty;
- the `dev/webview-spike` `Stack.Screen` registration;
- the README route row and source-layout mention;
- the stale path entry in the rename tool's `embeddedRendererFiles` set, unless RF-012 has already deleted that tool.

*What remains unchanged:*

- the developer-route gate: `isDeveloperRoutePath`, `DEVELOPER_ROUTE_PREFIXES` (keep `"/dev"` as the reserved developer namespace so any future `omnyo://dev/...` link stays hidden in release bundles), `developerRoutesEnabled` in `+native-intent.tsx` and `shell-links.ts`;
- the `e2e/reset` route and its registration;
- `e2eModeEnabled`;
- every dependency in the table above.

*Preservation argument.* No user-facing state, persisted format, API or UI changes, because release bundles already redirect the route to `/`. With the route file gone, `omnyo://dev/webview-spike` in a release build still resolves to `/` through `resolveShellIncomingLink`. In a dev or E2E build it now reaches Expo Router's `+not-found.tsx` fallback instead of the diagnostic screen. That is the intended loss.

The only capability retired is the developer's ability to run the 15 WebView probes and the machine-code cookie injection on a device. Those probes evaluated the move to the WebView shell, which shipped in August 2026, and the production shell (`ProfileWebViewScreen`) now owns enrollment, cookies, keyboard framing and media grants. If a future WebView capability question comes up, the probes can be restored from Git history, or run against the web app in Safari Web Inspector attached to the shell WebView.

*Non-goals:*

- Do not change the developer-route prefixes or the link-resolution semantics.
- Do not remove `e2e/reset`.
- Do not touch RF-075's acceptance harness.
- Do not delete existing `Documents/webview-spike/session.jsonl` files on developer devices. They hold dev-only logs and are removed when the app is uninstalled.

*Remaining uncertainty.* An on-device ad-hoc use by Alex or an agent that typed the deep link by hand leaves no repository trace. The owner decision in step 0 covers it.

**Expected gain and cost**

- **Projection:** about 1,157 handwritten production lines removed (1,157 in deleted files, plus 1 in `RootNavigator.tsx`, 1 in `scripts/omnyo-renderer-map.mjs` and 3 in the README). Test changes are about 4 lines, all edits of example strings, with no assertion removed.
- **Mechanisms removed:** one developer route, one probe-injection harness with 15 probes, and one on-device JSONL session logger.
- **Maintenance link:** repository-wide sweeps (renames, lint rule changes, connect-client API changes, react-native-webview prop changes) no longer have to update or type-check a screen that no product path or test exercises. The observed rate was 11 such touches in 3 months.
- **Performance:** no runtime effect on any product screen. Release JavaScript bundles are probably about 39 KB of source smaller (Hypothesis, unmeasured). Dev bundles are smaller by the same amount.
- **Cost:** about one hour, plus the loss of the on-device diagnostic tool described above.

**Execution steps**

0. **Investigation gate (owner decision).** Ask the owner: "The mobile app still has the Phase 0 WebView spike screen (`omnyo://dev/webview-spike`, dev and E2E builds only), with 15 probes and a Connect-code cookie injector. No flow, script or document uses it. May it be deleted, with Git history as the way back?" Proceed only on a yes. If Alex wants a probe kept, stop and re-plan around a smaller screen that keeps only that probe.
1. **Reconfirm the baseline.** In the working checkout, run `git grep -n -i -E 'webview-spike|WebViewSpike|__omnyoSpike|SPIKE_PROBES' -- .` and compare the hits with the consumer list in Context. Any new hit, such as a Maestro flow, a script, a doc or a verification recipe that opens the route, invalidates this plan: stop and re-plan. Also check whether `scripts/omnyo-renderer-map.mjs` still exists, because RF-012 may have removed it.
2. **Delete the screen and route.** Delete `apps/mobile/app/dev/webview-spike.tsx`, `apps/mobile/src/screens/dev/WebViewSpikeScreen.tsx` and `apps/mobile/src/screens/dev/webview-spike-probes.ts`. Then confirm that `apps/mobile/app/dev/` and `apps/mobile/src/screens/dev/` are empty and remove those directories.
3. **Remove the registration.** In `apps/mobile/src/screens/shell/RootNavigator.tsx`, delete the line `<Stack.Screen name="dev/webview-spike" options={hiddenHeader} />` (line 117 at the snapshot) and keep the `e2e/reset` line. If `hiddenHeader` then has a single consumer, leave it as is. That is not part of this change.
4. **Update the link tests without weakening them.** The functions under test are pure path classifiers, so the example path does not have to be a real route. Change the examples so that no test names a deleted screen:
   - `apps/mobile/src/lib/links/incoming-link.test.ts:159`: change `"/dev/webview-spike"` to `"/dev/diagnostics"`, a neutral example, so the `/dev` prefix assertion is kept.
   - `apps/mobile/src/lib/shell/shell-links.test.ts:39,42,48` ("hides developer routes in a release bundle"): change `omnyo://dev/webview-spike` to `omnyo://e2e/reset` and the expected path to `/e2e/reset`. The test still asserts both the release redirect to `/` and the pass-through when `developerRoutesEnabled` is true. Keep every assertion.
5. **Remove the stale tool entry.** If `scripts/omnyo-renderer-map.mjs` still exists, delete the `"apps/mobile/src/screens/dev/webview-spike-probes.ts",` entry from the `embeddedRendererFiles` set (line 403 at the snapshot). `packages/scripts/test/omnyo-renderer-map.test.mjs` does not reference this path; confirm that again with `rg -n spike packages/scripts/test`.
6. **Update the documentation.** In `apps/mobile/README.md`, delete the `dev/webview-spike.tsx` row (lines 37-38). In the `screens/` paragraph (lines 86-87), remove "dev/ (WebViewSpikeScreen + probes), ". Keep the `e2e/reset.tsx` row.
7. **Format, verify and recount.** Format the changed files, run the verification below, then inspect `git diff --stat` against the baseline. Expect about 1,163 deleted lines and about 4 changed test lines, with no unrelated files in the diff.

**Verification and acceptance criteria**

All commands below come from the snapshot's `apps/mobile/package.json` and root `package.json`. I could not run them, because the snapshot has no `node_modules`.

- From `apps/mobile`, run `pnpm typecheck` (`tsc --noEmit`). It must pass, showing that no import of the deleted modules remains. If Expo typed routes generate a route union, a stale generated type for `dev/webview-spike` could surface here. Regenerate it through Expo by starting `pnpm dev` once, which rewrites `.expo/types`. Do not hand-edit it. This regeneration behavior is unconfirmed at this snapshot.
- From `apps/mobile`, run `pnpm lint` (`oxlint app src scripts plugins metro.config.js app.config.js`). It must pass.
- From `apps/mobile`, run `pnpm exec vitest run --config vitest.config.ts src/lib/links/incoming-link.test.ts src/lib/shell/shell-links.test.ts`. Both files must pass with the same number of assertions as before.
- If step 5 edited the script, run the renderer-map test from the repository root: `pnpm exec vitest run packages/scripts/test/omnyo-renderer-map.test.mjs`. This exact invocation is unconfirmed; use the `test` script in `packages/scripts/package.json` if it differs.
- From the repository root, run `pnpm exec oxfmt --check apps/mobile/src/screens/shell/RootNavigator.tsx apps/mobile/src/lib/links/incoming-link.test.ts apps/mobile/src/lib/shell/shell-links.test.ts apps/mobile/README.md`. The root script `format:check` runs `oxfmt . --check` over the whole repository.
- **Structural completion:** `git grep -n -i -E 'webview-spike|WebViewSpike|SPIKE_PROBES|__omnyoSpike' -- .` returns no hits.
- **Optional runtime check** (Alex tests UI himself; this is not a gate): in a dev build, `xcrun simctl openurl booted 'omnyo://dev/webview-spike'` should land on the not-found fallback, and `omnyo://e2e/reset` should still work. No product screen changes, so no visual comparison is needed.

**Rollback and stop conditions**

- **Rollback:** the change is three file deletions plus small edits, with no data, persisted format or API involved. To roll back, revert the commit, or restore the files from commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` with `git show <commit>:<path>`.
- **Stop conditions:**
  - Alex wants the diagnostic kept.
  - Step 1 finds a new consumer, such as a Maestro flow, a script, an agent skill or a verification recipe that opens `omnyo://dev/webview-spike`.
  - `pnpm typecheck` shows a generated typed-route dependency that cannot be regenerated through Expo.
  - A reviewer shows that a probe is the only way to check a capability that production still needs, such as media capture grants or the file chooser.
- **Safer alternative when a stop condition applies:** keep only the needed probes in a much smaller screen, or move the probe scripts into a document so they can be pasted into Safari Web Inspector against the production shell WebView.
