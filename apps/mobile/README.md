# @omnyo/mobile

Native iOS/Android client for Omnyo (Expo SDK 57, React Native 0.86, Expo
Router, NativeWind v5).

Status: a native shell around the web interface (#2515). `app/webview.tsx`
loads the active server's web app in `react-native-webview` and talks to it
over `@omnyo/mobile-bridge` (handshake, haptics, app-icon badge, share, open
external links, open native screens). Threads, projects, plugins and server
settings run in the page. The native screens cover what the page cannot
own: first-run pairing (Direct URL and Omnyo connect QR / code enrollment),
the Servers hub (current server with reload the page and clear website data,
other saved servers, add server, and this phone's haptics, appearance and
notifications), push registration and notification taps, deep links, quick
actions, share intents and the connection banner.
External links use the web app's `shellOpenExternal` helper and the native
bridge to open through the OS URL handler. The `Mobile E2E` GitHub workflow
drives the shell flows.

## Structure

```
app/                     Expo Router routes (thin: each file re-exports a screen)
  _layout.tsx            providers: GestureHandlerRootView › SafeAreaProvider ›
                         KeyboardProvider › PaletteProvider › ThemeProvider ›
                         ProfilesProvider (QueryClientProvider per profile) ›
                         SheetProvider › RootNavigator + ThreadOpenSignalHandler,
                         ShareIntentHandler, QuickActionsHandler,
                         PushNotificationsHost, Toaster
  index.tsx              redirects to Add server (no profiles) or the shell
  webview.tsx            the WebView shell (`?profileId=&path=`)
  connect/index.tsx      Omnyo connect enrollment (QR / code) — also the re-pair
                         target (`?profileId=`) and the `omnyo://connect?code=…` link
  settings/              device (the Servers hub), appearance, notifications,
                         servers/index (redirects to the hub), servers/add
                         (Omnyo connect entry + Direct URL form)
  dev/webview-spike.tsx  Phase 0 WebView diagnostics (dev / EXPO_PUBLIC_OMNYO_E2E=1
                         only: release bundles redirect home)
  e2e/reset.tsx          omnyo://e2e/reset — wipes local state (dev / EXPO_PUBLIC_OMNYO_E2E=1)
  +native-intent.tsx     redirectSystemPath: every incoming URL (omnyo:// scheme,
                         universal links, dev-client URLs) → src/lib/shell link
                         resolution → profile switch + shell route / add-server prompt
  +not-found.tsx         unknown native route fallback
src/
  app-shell/             RN glue: ProfilesProvider + hooks (useProfiles,
                         useProfileClient, useRealtimeConnectionState,
                         useConnectionBanner), useAppBoot, PaletteProvider +
                         ServerPaletteSync, client-registry (per-profile
                         clients), connector (waitForActiveConnection), e2e
                         reset wiring, ThreadOpenSignalHandler (realtime
                         `thread-open` → shell route), ShareIntentHandler,
                         QuickActionsHandler
  data/                  connect (pairing payload, enrollment, account servers),
                         notifications (push registration policy, push store,
                         plugin RPC wrapper, notification payload → profile),
                         shared (system realtime subscription), system (system
                         config query); see src/data/README.md
  lib/                   pure TypeScript, vitest-tested
    connection/          active-profile connector (socket + session lifecycle),
                         connection banner derivation
    e2e/                 launch/deep-link reset logic, flow boundary tests
    haptics/             haptic(kind) over expo-haptics + the preference store
    links/               incoming-link parsing, profile match, add-server path
    native/              RN adapters for the lib contracts (SecureStore,
                         cookies, AppState, the shared MMKV preferences) —
                         never imported by tested modules
    profiles/            ServerProfile model, SecureStore-backed store, URL
                         validation, /health + /system/config probe
    query/               per-profile QueryClient, AppState focus, realtime →
                         system config invalidation, session refetch
    realtime/            WebSocketManager-shaped realtime on RN WebSocket
    sdk/                 createMobileSdk (@omnyo/sdk/browser + app-surface header),
                         per-profile client registry
    session/             Omnyo connect desktop-session cookie scheduler
    share/               inbound share intent → shell composer seed
    shell/               shell URL and navigation rules, screen state, last-path
                         preferences, share payloads, link resolution, shell
                         commands
  notifications/         push (RN glue): expo-notifications behind the data
                         layer's PushNotificationsModule, MMKV push store,
                         app-wide registration controller, PushNotificationsHost
                         (registration sync, taps → thread, foreground toast
                         with Open, app-icon badge, first-run prompt),
                         and usePushRegistration (Settings)
  screens/               connect/ (ConnectEnrollScreen, ConnectScanner —
                         expo-camera QR, AccountServersList), dev/
                         (WebViewSpikeScreen + probes), settings/ (the Servers
                         hub in DeviceSettingsScreen with useServerActions,
                         Appearance, Notifications, Add server, the
                         grouped-list rows), shell/ (RootNavigator, connection
                         banner, header glass, route error boundary, hrefs.ts —
                         typed-route boundary), webview/ (ProfileWebViewScreen,
                         useShellBridge)
  theme/                 generated tokens, ThemeProvider, fonts (see src/ui/README.md)
  types/                 asset declarations
  ui/                    NativeWind primitives (Text, Button, GroupedSection,
                         ActionSheet, …; see src/ui/README.md)
e2e/flows/               Maestro shell flows: shell-launch, shell-deep-link,
                         shell-send, shell-unreachable-server, shell-connect
e2e/subflows/            shared steps (launch-app.yaml: cold start through the
                         dev client + Metro, or `launchApp` of the embedded
                         Release bundle with `-e OMNYO_E2E_EMBEDDED_BUNDLE=1`;
                         pair-direct-server.yaml: add the harness server and
                         wait for the shell; open-omnyo-link.yaml /
                         clear-open-confirmation.yaml: accept or cancel the
                         native `omnyo://` confirmation), called with
                         `runFlow: ../subflows/<name>.yaml`
e2e/scripts/             ci-run-flows.sh (the CI flow set against a Release
                         build; see "CI"), connect-stub-control.js (drives the
                         Omnyo connect stub), pick-simulator.mjs (newest iPhone
                         17 Pro/17/16 Pro runtime)
eas.json                 EAS Build profiles (development / development-device /
                         preview / production); see "Release"
scripts/                 generate-native-theme.ts (theme tokens),
                         testflight-distribute.mjs (TestFlight distribution)
```

Rules: import `@omnyo/sdk/browser` (never `@omnyo/sdk`); no `@omnyo/shared-ui`; no DOM
APIs; keep RN-dependent code out of `src/lib/**` except `src/lib/native`.

## Prerequisites (macOS)

For Android development, install Android Studio's SDK, a current Android SDK
platform and build tools, and Java 17. Set `ANDROID_HOME` to the SDK directory
(`$HOME/Library/Android/sdk` on macOS) and add its `platform-tools` and `emulator`
directories to PATH. Start an emulator or attach an Android phone with USB
debugging enabled.

### Android local APK and verification

For development threads, build the standalone **Omnyo dev** app from the repo root:

```bash
pnpm mobile:apk:dev
adb install -r apps/mobile/build-output/omnyo-dev.apk
```

The APK is `apps/mobile/build-output/omnyo-dev.apk`. It has an orange Omnyo launcher
icon, favicon, and splash logo, the name **Omnyo dev**, and package `app.getbb.mobile.dev`, so it
installs alongside the regular app with separate saved servers and data. It
embeds the Release JS bundle and runs without Metro, EAS, Firebase, or production
signing credentials. Pair it with the development server through Add server or
a pairing code. It does not claim production HTTPS app links or use the
production Firebase configuration; Android themed icons use the system tint.
Dev launcher assets tint the existing shaded mobile artwork using the orange
palette and tinting method from `apps/app/scripts/generate-pwa-icons.mjs`,
preserving the original dimensions, alpha, and launcher padding. The transparent
splash asset stores the original light logo's shading in orange RGB and uses
the dark logo's silhouette alpha. This keeps transparency at the edges rather
than throughout the shaded mark, avoiding darkening during native image
generation. Both light and dark splash screens use the orange logo.

Use `pnpm mobile:apk:dev -- x86_64` for an Intel emulator. The default is
`arm64-v8a` for a physical phone. Install Android SDK/build tools and JDK 17
first; the script detects the standard macOS SDK and Homebrew JDK 17 paths when
`ANDROID_HOME` and `JAVA_HOME` are unset. Both local commands regenerate the
gitignored Android project, so do not run them concurrently in the same checkout
or keep manual edits in `apps/mobile/android`.
Concurrent builds are rejected. If a force-killed build leaves a stale lock,
remove `apps/mobile/build-output/.android-build-lock` after confirming no build
is running, then retry.

When a thread is asked to build a dev APK, use this command, wait for successful
completion, and provide a clickable link to the resulting APK. Record the
source commit and any uncommitted changes. For a durable per-thread copy, copy
the APK into `$OMNYO_THREAD_STORAGE` and link that absolute path. Builds use the generated debug signing
key; Android updates require the same key as the installed dev app.

The existing local build retains the regular app identity for smoke tests:

```bash
pnpm exec turbo run build:android:local --filter=@omnyo/mobile
adb install -r apps/mobile/build-output/omnyo-android-local.apk
```

This builds an ARM64 APK with an embedded Release JS bundle and the generated
Android debug signing key. It runs without Metro, Firebase, EAS, or production
signing credentials. It is for local testing, not Play distribution. Uninstall
it before installing an app signed with another key (which removes local app
data). For an Intel emulator, append `-- x86_64` to the Turbo command.

Run the mobile backend described below, then `adb reverse tcp:41999 tcp:41999`
so the Android app can reach it at `http://127.0.0.1:41999`. Keep the reverse
mapping active during tests. Android does not share the Mac loopback directly.

Run `pnpm exec turbo run e2e:android --filter=@omnyo/mobile` with only the intended
Android emulator/device connected. The smoke flow clears this app's local data,
pairs the fixture, sends a message, checks Android back navigation, relaunches,
and opens the native Servers screen. Use a normal embedded build, not
`EXPO_PUBLIC_OMNYO_E2E=1`, so the relaunch step can verify saved profiles.

`e2e/android/keyboard.yaml` uses the same backend and checks repeated keyboard
opening, Back dismissal, draft retention, and sending after dismissal. Run it
with `maestro test apps/mobile/e2e/android/keyboard.yaml` from the repo root.
It clears this app's local data, like the main smoke flow.

`plugins/with-selection-accent.js` sets the Android theme accent used by
WebView selection handles: blue in light mode and pale blue in dark mode.
The single insertion handle is transparent; the caret and two range-selection
handles remain visible. This applies to Android native text fields too and is
separate from the web app's CSS selection highlight.
The Expo prebuild applies it to both framework and AppCompat theme attributes.

The `react-native-webview` patch zeroes the Android IME inset before WebView
receives it. `WebViewKeyboardFrame` already resizes the native container for
the keyboard; forwarding that inset lets newer WebViews shrink the visual
viewport a second time during opening. Keep the native keyboard frame around
WebViews when using this patch. System bar and display-cutout insets remain
unchanged. Recheck this patch when upgrading WebView or changing keyboard
ownership; see [Android's inset handling guidance](https://developer.android.com/develop/ui/views/layout/webapps/understand-window-insets).

`e2e/android/connect.yaml` additionally needs the local TLS connect stub started
with `OMNYO_MOBILE_E2E_COOKIE_DOMAIN=stub.localhost`, a
trusted fixture CA and DNS for `stub.localhost`/`other.localhost` on the test
emulator, and `adb reverse tcp:42998 tcp:42998`. It resets the stub and checks
invalid codes, pairing, WebView cookie authentication, relaunch and session
expiry recovery. Chromium rejects the fixture's default `.localhost` cookie
domain; the host-specific override tests one server, not account-wide cookie
sharing across servers. Do not change release TLS validation to run this fixture.

The Hugeicons React Native patch restores missing SVG ellipse/polygon support
(the globe otherwise renders as a circle with a minus sign).

The cookie-library pnpm patch replaces its obsolete JCenter repository and
declares its Android namespace for current Gradle. If adding/changing a native
dependency leaves stale pnpm paths in Android autolinking, regenerate the
ignored native project before rebuilding.

The `react-native-screens` patch skips header updates for detached Android
screens, matching the fix proposed in upstream
[PR #4498](https://github.com/software-mansion/react-native-screens/pull/4498).
It addresses a release-build crash reproduced immediately after pairing on
Android 16. Recheck and remove it when upgrading to a version with the fix.

### Android production setup

The manual `Mobile Android (EAS)` workflow builds preview APKs or production
AABs. It needs the existing `EXPO_TOKEN` and an Android signing key configured
through `pnpm exec eas credentials -p android` in `apps/mobile`. Submission is
opt-in and uploads a draft to the internal Play track; it does not release to
the public. The first Play upload must be completed manually.

Firebase is optional for builds. Place the Android Firebase config in the
gitignored `apps/mobile/google-services.json`, or set `GOOGLE_SERVICES_JSON`
to its absolute path. For EAS, create a file environment variable with that
name in each build environment used (preview/production). `app.config.js`
loads the file when present. Upload the FCM V1 service-account credential to
EAS separately, then rebuild to test push on a device.

For Play uploads, add the GitHub secret `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`.
Local EAS Submit reads the gitignored `google-play-service-account.json` in
`apps/mobile`. Register the **Play app-signing certificate**, not only the
upload certificate, in `ASSETLINKS_SHA256_FINGERPRINTS` on the apex and connect
gate. Verify real HTTPS app links after installing the Play-signed build.
The native `omnyo://` scheme works without those certificates.

Pending credentials do not establish push delivery or verified HTTPS app-link
coverage. Test those separately once Firebase/signing are configured.

### iOS prerequisites

- Xcode 26.2 with an iOS 26 simulator runtime (`xcodebuild -downloadPlatform iOS`).
- CocoaPods (`brew install cocoapods`), `export LANG=en_US.UTF-8`.
- For Maestro e2e: `brew install --cask temurin@17` or `brew install openjdk@17`
  plus `brew install mobile-dev-inc/tap/maestro`; the `e2e:ios` script sets
  `JAVA_HOME=/opt/homebrew/opt/openjdk@17` unless already set.

## Develop

```bash
pnpm install                                   # applies patches/expo-modules-jsi@57.0.4.patch
cd apps/mobile
pnpm ios                                       # prebuild + build the dev-client, opens the simulator
pnpm dev                                       # Metro (dev-client)
```

The iOS Simulator shares the Mac loopback, so `pnpm dev` (repo root) or
`pnpm dev` gives a server URL that works as-is. Physical
phones need a Tailscale Serve URL, Omnyo connect, or a temporary
`OMNYO_SERVER_BIND_HOST=0.0.0.0`.

## E2E (Maestro)

The shared `e2e/subflows` helpers target the upstream `app.getbb.mobile` variant. Their dev-client link and `Open in Omnyo` confirmation are upstream selectors; they do not select the private Omnyo app. The private publisher owns `e2e/flows/private-release-launch.yaml` and supplies `com.omnyohq.app`. It resets the simulator Keychain once, only to establish a new device, then reinstalls twice without a reset (`first-install`, `reinstall-empty`, `reinstall-saved-server`). Each stage needs two cold launches to reach Add server or the WebView with no fresh-start gate. Never reset existing work to make a launch smoke pass.

```bash
# terminal 1: deterministic backend (fake provider, fixed port 41999) serving the built web app
pnpm exec turbo run build --filter=@omnyo/app
OMNYO_MOBILE_E2E_SERVE_APP=1 pnpm --filter @omnyo/integration-tests e2e:mobile-backend
# terminal 2: Metro (EXPO_PUBLIC_OMNYO_E2E=1 wipes profiles/preferences on every launch)
cd apps/mobile && EXPO_PUBLIC_OMNYO_E2E=1 pnpm dev --port 8082
# terminal 3: flows
cd apps/mobile && pnpm e2e:ios
```

The flows drive the WebView shell. Maestro reads the page through the
WKWebView accessibility tree, so assertions on page content target its text,
not native test ids.
`shell-launch.yaml` pairs a Direct server from first run and lands in the
shell with the page rendered; the other shell flows assume it works.
`shell-deep-link.yaml` opens an `omnyo://` scheme link and a web link for the
saved server: both resolve to the shell route carrying a page path, and
`omnyo://settings/notifications` still opens the native screen.
`shell-send.yaml` sends a message through the page and reaches the native
Servers screen from its "Servers and phone settings" row.
`shell-unreachable-server.yaml` checks that the add-server probe refuses a
server the phone cannot reach, so the shell never loads a dead origin; it
does not use the harness backend.
`shell-connect.yaml` drives Omnyo connect end to end against the stub apex +
gate (`pnpm --filter @omnyo/integration-tests e2e:mobile-connect-stub`, see
"Omnyo connect" below): manual code entry with the handle and the self-hosted
apex → enrolled screen (session signed in, account servers listed) → Done →
the shell through the gate (cookie on fetch and on `/ws`) → the stub expires
the session (the app re-mints and reconnects by itself) → the stub revokes
the machine ("needs to be paired again" banner) → "Sign in again" re-pairs
the same profile with a new code. The flow needs the stub started with
`OMNYO_MOBILE_E2E_SIMULATOR=<udid>` once (it installs its root certificate in
that simulator) and drives the stub through `e2e/scripts/connect-stub-control.js`
(plain-HTTP control port 42997).
Flows open `omnyo://` links through `subflows/open-omnyo-link.yaml` and pair through
`subflows/pair-direct-server.yaml`; `src/lib/e2e/mobile-e2e-flows.test.ts`
enforces both.
Flows dismiss the keyboard by tapping a static label ("Server URL",
"Pairing code"): Maestro's `hideKeyboard` looks for a Return/Done key and the
Add server and connect fields use "next".
Flows cold-start the dev client (`stopApp`) because a warm reload keeps the
last deep link as the initial URL. Without `EXPO_PUBLIC_OMNYO_E2E=1`, open `omnyo://e2e/reset`
(dev builds) to return the simulator to first run.

### Flows against a Release build (no Metro)

A Release build (`npx expo run:ios --configuration Release --no-bundler
--device <udid>`) embeds the JS bundle and never starts the dev launcher, so
the same flows run without Metro: build it with `EXPO_PUBLIC_OMNYO_E2E=1` in the environment — the
Xcode "Bundle React Native code and images" phase inlines `EXPO_PUBLIC_*` at
bundle time — and pass `-e OMNYO_E2E_EMBEDDED_BUNDLE=1` to Maestro.
`e2e/subflows/launch-app.yaml` switches on that variable between the
dev-client deep link and a plain `launchApp`; it is a `-e` variable on
purpose because values in a flow's `env:` block beat `-e`, and `METRO_URL`
lives in every flow's header.
`e2e/scripts/ci-run-flows.sh <udid> <artifacts dir> [flow…]` is what CI runs:
`shell-launch`, `shell-deep-link`, `shell-send`, `shell-unreachable-server`,
one `maestro test` at a time with `--test-output-dir` per flow (screenshots,
logs, JUnit); after a failure it clears the native `omnyo://` confirmation
before the next flow, and it exits non-zero if any flow failed.
`shell-connect` needs the connect stub, so it runs on its own. `--dev-client`
as the first argument drives a dev client through Metro instead.

## CI

- **Android emulator smoke** (`mobile-android-e2e.yml`) runs on PRs labeled
  `mobile-e2e`, on manual dispatch, and nightly. It builds a debug-key-signed
  Release APK for an Android 16 x86_64 emulator and runs the existing smoke
  flow: direct pairing, send/provider reply, Android Back, saved connection
  after relaunch, and native settings. It uses the isolated backend and needs
  no Firebase, EAS, or Play credentials. The `mobile-e2e-android` artifact
  contains screenshots, JUnit results, Maestro output, logcat, and backend logs.
  Keyboard animation, push delivery, and Omnyo connect are outside this basic job.

- Typecheck, lint, and unit tests run on Linux in the regular `CI` workflow
  (`pnpm exec turbo run build typecheck lint` in `Checks`, the `packages`
  test shard for `vitest`), like every workspace package.
- `.github/workflows/mobile-e2e.yml` (`Mobile E2E`) runs the flows above on
  the `blacksmith-6vcpu-macos-15` runner: label a pull request `mobile-e2e`,
  dispatch it by hand (optional `flows` input), or wait for the nightly run.
  It selects Xcode 26.2 (`DEVELOPER_DIR`, falling back to the newest 26.x),
  boots the simulator `pick-simulator.mjs` chooses, installs Maestro 2.8.0
  (Java 17 from `actions/setup-java` only when the image has no JDK 17+),
  restores `ios/Pods` + `Podfile.lock` and (behind the workflow's
  `CACHE_DERIVED_DATA` knob — DerivedData is ~7 GB raw and the Actions cache
  quota is shared with the Turbo caches) the Xcode DerivedData `Build/`
  directory from `actions/cache` keyed on `pnpm-lock.yaml` + `app.json` +
  `package.json` + `patches/**`, prebuilds, builds the Release app onto the
  simulator, starts the harness backend (`turbo run e2e:mobile-backend`,
  waits for `/health`), runs `ci-run-flows.sh`, and uploads
  `e2e-artifacts/` (per-flow Maestro output, backend log, simulator log).

## Omnyo connect

- Pair through Settings → Mobile → Add mobile device or `omnyo connect machine-code`. No experiment is required.
- Enrollment (`src/screens/connect`, `src/data/connect`, route `/connect`):
  "Add server" offers "Connect with Omnyo connect" above the Direct URL form.
  The screen scans the pairing QR (`expo-camera`; payload = the connect
  plugin's `MobilePairingPayload` JSON `{code, serverUrl, apex, expiresAt}`, a
  `omnyo://connect?code=…&serverUrl=…` link, or a bare code —
  `parseConnectPairingPayload`) or takes the code by hand with an optional
  server (handle like `bee` or `https://bee.example.com`) and an optional
  self-hosted apex; the apex defaults to `deriveConnectBaseUrl(serverUrl)`
  or `https://omnyo.link` (`resolveEnrollmentTarget`). `redeemEnrollment`
  calls `redeemMachineCredential` (`POST <apex>/api/connect/redeem-machine`)
  with the phone’s device name (for example, `Pixel 9 Pro`). The account
  service stores it on the machine so the dashboard shows a recognizable name.
  The request accepts an optional `deviceName` string, trimmed and limited to
  128 characters; older clients may omit it. Existing unnamed devices are not
  renamed automatically. Both the account service update and a new mobile build
  are needed for names to appear on new pairings.
  Enrollment saves `{mode:"connect", serverUrl, handle, credential(omnyocm_…, or bbcm_… when paired before the rename), label}`
  in SecureStore, then activates it: the connector mints the desktop-session
  cookie and opens realtime (the enrolled screen shows that status live).
  Errors map to copy per wire code (`describeEnrollmentError`: invalid /
  expired / already used, the 409 `machine_limit` with the "revoke a device
  in the dashboard" way out, network, unauthorized).
- Account servers: the apex stores the machine credential against the user
  and records the server whose code paired it (`apps/relay/src/account/api.ts`
  `redeemMachineCode`, table `relay_machine_server`). The gate accepts the
  credential, and the desktop-session cookie minted from it, only at that
  server's address and at the device's own address. A device paired before
  the relay recorded this keeps working at every server the account owns.
  "Servers on this account" (`GET <serverUrl>/api/connect/servers` with the
  credential, `listAccountServers`) still lists every server of the account.
  At a server that did not pair the device, the gate answers that profile's
  credential with 401 and its pages with the GitHub sign-in.
- Session: `src/lib/session` mints `POST <serverUrl>/api/connect/desktop-session`
  with the credential, installs the cookie in both native jars (`Secure`
  follows the server URL's scheme so a plain-http stub gate works), renews
  five minutes before expiry and on AppState active. Each minted session
  (server URL, pairing credential and the full cookie, value included) is kept
  per profile in SecureStore (`omnyo.connectSession.<profileId>`); a cold start
  whose record matches the profile's server URL and credential and is more
  than five minutes from expiry reinstalls that cookie into both jars instead
  of minting, so the page loads
  without a round trip to the gate. Re-pairing with a new credential mints a
  fresh session. Older cache records without a credential are ignored.
  A refused mint, Clear website data and removing the server clear the
  record. The cookie lasts seven
  days; the gate re-issues it once a day on ordinary responses and rejects it
  within about 20 seconds of the machine being revoked. The connector
  (`src/lib/connection`) re-checks the session on any 401/403 (an API call
  or the `/ws` upgrade — React Native reports the refused upgrade as the
  close reason "Received bad response code from server: 401.") and on
  repeated connection failures (throttled): a fresh cookie reconnects the
  socket at once; a refused re-mint flips the profile to `auth-required`.
  Installing a fresh session reloads a WebView showing a 401/403 page, even
  before the previous cookie expires; routine renewal leaves a healthy page
  alone.
  Queries that raced the first mint (or a re-mint) and hit the gate's 401
  page are fetched again once the cookie lands
  (`refetchQueriesRejectedBeforeSession`); a 401 within two seconds of a
  mint is attributed to a request that started with the old cookie and
  only triggers that refetch, not another mint.
- Re-auth UX: the `auth-required` banner ("<label> needs to be paired again.")
  is a button that opens `/connect?profileId=<id>`, which re-pairs the same
  profile (new credential, same label and place in the list). Re-pairing a
  profile saved on a retired relay leaves the server field empty and
  editable, so a typed code resolves through omnyo.link. The Servers hub
  (`/settings/device`) lists the current server with its mode, host and
  connection state, then the other servers; tapping another server switches
  to it and returns to the page. Each row's (i) button and touch and hold
  open Use this server, Rename (iOS), Sign in again (connect profiles) and
  Remove; VoiceOver offers the same Rename, Sign in again and Remove as row
  actions. "Remove" only forgets the profile and its
  cached session locally: other servers on the same account stay signed in,
  and the phone stays listed under Machines in the Omnyo connect dashboard
  until revoked there (the copy says so and offers Open dashboard).
- Stub for e2e (`tests/integration/mobile-e2e/connect-stub.ts`,
  `pnpm --filter @omnyo/integration-tests e2e:mobile-connect-stub`): plays the
  apex and the gate on one TLS port (`https://localhost:42998` /
  `https://stub.localhost:42998`, so `@omnyo/connect-client`'s "server lives
  under the apex" rule and the `Secure` cookie hold; iOS ATS refuses plain
  http to a qualified name). It redeems `STUB-PAIR` (sentinels
  `EXPIRED-CODE` / `USED-CODE` / `LIMIT-CODE` reproduce the apex errors),
  mints sessions for its machines, lists two account servers, and reverse
  proxies everything else (HTTP + WebSocket upgrade) to the harness backend
  — only with a valid session cookie, otherwise the gate's HTML 401 —
  rewriting `Origin: https://<gate host>` to the loopback origin like the
  tunnel client does so the Omnyo server's origin guard accepts RN's
  WebSocket. Control: `POST /__stub/{expire-session,revoke-machine,reset}`,
  `GET /__stub/state`, also on plain `http://127.0.0.1:42997`. It generates a
  local CA under `~/.omnyo-mobile-e2e/connect-stub-certs` and installs it in
  the simulator named by `OMNYO_MOBILE_E2E_SIMULATOR` (`xcrun simctl keychain …
add-root-cert`). Env: `OMNYO_MOBILE_E2E_GATE_PORT` (42998),
  `OMNYO_MOBILE_E2E_STUB_CONTROL_PORT` (42997), `OMNYO_MOBILE_E2E_UPSTREAM_URL`
  (`http://127.0.0.1:${OMNYO_MOBILE_E2E_PORT ?? 41999}`),
  `OMNYO_MOBILE_E2E_CONNECT_CODE`, `OMNYO_MOBILE_E2E_STUB_HANDLE`,
  `OMNYO_MOBILE_E2E_SESSION_TTL_MS`, `OMNYO_MOBILE_E2E_STUB_LOG=1` (one line per
  gate request).

## Server moves

- After `omnyo server move`, the old computer answers its old address with
  `410 {code:"server_moved", details:{serverUrl, toHostName}}`.
  `createMobileFetch` reads that body from `response.clone()` and validates
  `details.serverUrl` with the Direct URL rules. The registry passes the
  address with the profile ID to `createServerMovedProfileHandler`
  (`src/lib/profiles/server-moved.ts`). A direct profile gets the new
  `serverUrl`: the connector rebuilds the client, the WebView reloads, and
  a toast says "Server moved to <toHostName>". Connect profiles ignore the
  response because their URL stays the same. Concurrent 410 responses update
  the profile once.

## Push notifications and deep links

Android disables Firebase Messaging auto-initialization and Analytics collection
in the generated manifest. The app requests a push token only for a server with
notifications enabled and OS permission granted. It refreshes registration on
foreground/sync and token-change events. Turning notifications off for every
server, removing the last enabled server, or revoking OS permission deletes the
Android FCM token. Disabling one server preserves the shared token for other
enabled servers. Failed server-subscription removal is retained for retry;
local token deletion does not require that server to be reachable. This does not
delete the Firebase installation ID or previously processed provider data.
iOS keeps its existing APNs registration behavior.

- Registration: `PushNotificationsHost` (mounted once in `app/_layout.tsx`)
  registers the phone's Expo push token with each enabled server through
  Servers → This phone → Notifications. It calls the `push-notifications`
  plugin RPC methods `pushSubscriptions.add`, `pushSubscriptions.list`, and
  `pushSubscriptions.remove` through `sdk.plugins.callRpc`. It syncs on
  connect, on
  AppState active, when the OS rolls the token (re-register), and when the
  toggle flips. Each sync of an up-to-date registration lists the server's
  rows and registers again when its row is gone. Profiles removed from the app
  get their server row deleted by the stored server URL. A direct profile must use HTTPS, unless it uses
  `127.0.0.1`, `localhost`, or `::1`. Tailscale Serve and Omnyo connect profiles
  work normally. Other HTTP profiles show "Push needs HTTPS or Omnyo connect"
  and do not register. The server also needs outbound access to `exp.host`.
  The server must enable the `push-notifications` plugin.
  The one-time "Get notified…" sheet appears on first launch when no server
  is saved yet; otherwise it waits for the active server's first successful
  connection. The OS prompt starts only after the user selects "Turn on
  notifications". Turning it on before any server exists turns notifications
  on for the first HTTPS or connect server that syncs.
- Privacy: the registration request contains the full Expo token. The list
  RPC method and `omnyo push-notifications list` return only the last six token
  characters in `tokenSuffix`. A token can receive pushes but cannot read
  server data.
- Private Omnyo iOS: the private build binds the Expo project
  `@burlismanagement/omnyo-private` (`easProjectId` in
  `plugins/ios-identity-handoff/identity-binding-v1.js`). Its iOS credentials
  hold the team APNs key for `com.omnyohq.app`. `with-private-ios` signs
  `aps-environment` `production` with the `Omnyo AppStore Push` profile.
- Handling: a foreground arrival becomes a toast with "Open" (no system
  banner); a tap on a background / cold-start notification opens the thread
  in the shell on the profile that owns it. The phone first matches
  the optional `serverUrl` hint. It probes saved profiles for the thread only
  when no hint matches. The shell accepts a bridge `badge` message
  (`useShellBridge` → `updateAppBadgeCount`), and `AppBadgeSync` writes that
  count on background; the web app does not send it yet.
- Simulator check without APNs: `xcrun simctl push <udid> app.getbb.mobile
payload.apns` with `{"aps":{"alert":{…}},"body":{"kind":"turn-finished",
"threadId":"…","projectId":"…","serverUrl":"https://…"}}`
  (expo-notifications reads remote `data` from the `body` key) after the user
  grants permission.
- Deep links: `omnyo://<path>` (`omnyo://threads/<id>`, `omnyo://settings/servers`,
  `omnyo://projects/<p>/threads/<t>`, …; `OMNYO_URL_SCHEMES` accepts only
  `omnyo`)
  and universal / app links
  `https://<handle>.omnyo.link/{threads,projects,settings}/*` (iOS
  `associatedDomains: applinks:omnyo.link, applinks:*.omnyo.link`; Android
  `intentFilters` with `autoVerify`). `app/+native-intent.tsx` resolves every
  URL with `src/lib/shell` (`resolveShellIncomingLink` over `src/lib/links`):
  a web link whose origin matches a saved profile switches to that profile
  (waiting for its connection) and opens the shell route carrying the page
  path; native-only paths (connect, servers, device and notification
  settings; `omnyo://settings/servers` opens the Servers hub) stay native;
  an unknown server opens Add server prefilled with
  the origin and the follow-up path. Universal links only resolve once
  `https://<handle>.omnyo.link/.well-known/apple-app-site-association` /
  `assetlinks.json` are served (`packages/connect-db/src/app-links.ts` builds
  them; the self-hosted relay does not serve them yet) and the app is
  signed with the team id in that file; until then only the `omnyo://` scheme
  works, and wildcard associated-domain behavior still needs a physical
  device check. The realtime `thread-open` signal (`POST /threads/:id/open`,
  `omnyo thread open`) navigates to the thread while the app is foregrounded.

## Share sheet and haptics

- Inbound "Send to Omnyo" is wired for `expo-share-intent` but the native module
  is **not** in the current dev client: `src/lib/share/share-intent.ts` loads
  it optionally and `src/app-shell/ShareIntentHandler.tsx` renders nothing
  when it is absent. To enable it: `npx expo install expo-share-intent`, add
  `["expo-share-intent", { "iosActivationRules": { "NSExtensionActivationSupportsText": true, "NSExtensionActivationSupportsWebURLWithMaxCount": 1 } }]`
  to `app.json` plugins, rebuild the dev client (`pnpm ios`, ~10 min, also
  reinstall it on every simulator the flows use). Shared text / URLs open
  the shell at `/?initialPrompt=`, where the app shows the text in a "Use this
  prompt?" card; the owner taps Use to add it to the composer or Dismiss to
  drop it. Media / file shares are declined with a toast.
- Outbound: the shell handles the bridge `share` request (`useShellBridge` →
  RN `Share.share`); the web app does not send it yet.
- Haptics: `src/lib/haptics/` — `haptic(kind)` maps semantic kinds
  (`selection`, `impact-light|medium|heavy`, `success`, `warning`, `error`)
  onto expo-haptics and honors the Servers → This phone → Haptics toggle
  (MMKV `omnyo.haptics.enabled`, default on). Call sites: bridge `haptic`
  messages handled in `useShellBridge` (the web terminal's mobile key bar
  sends `selection`), the segmented appearance picker (selection),
  destructive ActionSheet rows and confirmations (warning), touch and hold
  on a server row (heavy), and the
  auth-required banner (warning). Screens never import expo-haptics directly.

## Release (EAS)

The app lives in the EAS project `@bb-team/bb-app` (id in
`app.json` → `extra.eas.projectId`; the Expo slug `bb-app` also names the
dev-client scheme `exp+bb-app://`). Apple team `9QCU24SXK5`, bundle id
`app.getbb.mobile`, App Store Connect app `6803559210`. EAS holds the iOS
credentials (distribution certificate, App Store provisioning profile, APNs
push key); nobody needs a local Xcode signing setup to ship.

- **Log in once**: `pnpm exec eas login` (or `EXPO_TOKEN`). `eas-cli` is a
  pinned devDependency, so use `pnpm exec eas …` from `apps/mobile`.
- **Build profiles** (`eas.json`): `development` (simulator dev client),
  `development-device` (dev client for a physical iPhone; needed for push
  acceptance), `preview` (internal ad-hoc), `production` (App Store /
  TestFlight; `autoIncrement` + `appVersionSource: remote` keep the build
  number on EAS, `version` in `app.json` is the marketing version).
- **Push release check**: confirm the APNs key with `pnpm exec eas credentials
-p ios`. Use `development-device` for a physical iPhone. Keep the server
  `push-notifications` plugin enabled, and use an HTTPS or Omnyo connect profile.
  Run `omnyo push-notifications list`. Confirm that it shows a token suffix, not
  a full token.
- **TestFlight by hand**: `pnpm exec eas build -p ios --profile production`,
  then `pnpm exec eas submit -p ios --latest`. The submit profile reads the
  App Store Connect API key from the gitignored `apps/mobile/asc-api-key.p8`
  (key id and issuer id are in `eas.json`); get the `.p8` from a teammate or
  App Store Connect → Users and Access → Integrations → App Store Connect API
  (role App Manager, one-time download). Both commands also work with
  `--non-interactive`.
- **CI**: `.github/workflows/mobile-ios-eas.yml` writes the `.p8` from the
  `ASC_API_KEY_P8` secret, optionally sets `app.json` `version`, and runs
  `eas build -p ios --profile <profile> [--auto-submit]` with
  `EXPO_TOKEN`. EAS builds, then uploads to TestFlight; the job waits for
  both and fails when either fails. Logs are on expo.dev under the project's
  Builds and Submissions (the run summary links them). After a submit, the
  job runs `scripts/testflight-distribute.mjs`, which waits for App Store
  Connect to process the build, submits it for Beta App Review when it has
  none, and adds it to the external group named by the `external_group`
  input (default `External testers`; empty skips the step). Run the script
  by hand with `node scripts/testflight-distribute.mjs --version X.Y.Z
--build N` from `apps/mobile` with the `.p8` in place.
  Run it alone from the Actions tab ("Mobile iOS (EAS)") or
  `gh workflow run mobile-ios-eas.yml -f profile=production -f submit=true`.
  The nightly `publish-bb-app.yml` calls the same workflow after the npm
  nightly publish with an empty `version`, so every nightly keeps the
  marketing version committed in `app.json` and only the EAS build number
  moves. This is deliberate: TestFlight needs a Beta App Review for the
  first build of each new marketing version, and later builds of the same
  version skip it. Bump `app.json` `version` only when you want a new
  review, for example for a store release. Repo
  secrets: `EXPO_TOKEN` (a robot token from the `bb-team` Expo org) and
  `ASC_API_KEY_P8` (the `.p8` contents).
- The `expo-modules-jsi` pnpm patch and the `lightningcss` override ship
  with the repo and apply on EAS; the default build image provides
  Xcode 26.x.
- Universal links need the relay to serve the AASA built by
  `packages/connect-db/src/app-links.ts`, the signed app's team id in that
  file, and a physical-device check against `https://<handle>.omnyo.link/threads/…`. Android signing
  (`eas credentials -p android`, FCM V1, `ASSETLINKS_SHA256_FINGERPRINTS`)
  is still open.
- `eas update` (JS-only fixes over the air) is deferred: `expo-updates` is
  not installed, so the profiles define no update channels.

## TestFlight testers

**Internal testers** need no Apple review. A build reaches the group as soon as
App Store Connect finishes processing it, usually within 30 minutes. The group
`bb team` exists and the nightly feeds it.

**External testers** need a Beta App Review on the first build of each
marketing version, and Apple usually auto-approves later builds of that
version. The nightly keeps one marketing version for this reason (see "CI"
above). Apple offers "Automatically distribute builds" only for internal
groups, so the CI distribute step adds each submitted build to the external
group through the App Store Connect API. Before a build can go to an external
group, App Store Connect needs all of this:

- **Test Information** (`betaAppLocalizations`): a feedback email, a beta
  description, and the privacy policy URL <https://getbb.app/privacy>. Per
  build, a "What to test" note.
- **Beta App Review Details** (`betaAppReviewDetail`): contact first name, last
  name, phone, and email. Apple uses these, testers never see them.
- **A way for the reviewer to use the app.** This is the part that fails. Omnyo
  opens on "Add server", and a reviewer has no Omnyo server, so without help they
  cannot get past the first screen and will reject the build. Neither real
  path works for a reviewer: an Omnyo server's API is unauthenticated and runs
  commands, so it cannot be on the internet, and connect pairing codes are
  single-use and expire in ten minutes. Omnyo has no reviewer demo server:
  upstream's Cloudflare demo worker (`apps/demo-server`) was removed. Owner-only
  internal TestFlight testing needs no Beta App Review. An external group or a
  store submission needs a reviewer path before it is submitted.

The nightly keeps the marketing version in `app.json` and lets the EAS build
number tell nightlies apart, because a new version string triggers a fresh
Beta App Review and another build of the same version usually does not.

## Local state

- Server profiles: `expo-secure-store`, one key per profile
  (`omnyo.profile.<id>`) plus `omnyo.profiles.index`. A fresh install has no
  profile and opens on "Connect to an Omnyo server". No variant seeds a default
  server, including the private iOS build. Saved profiles stay as they are,
  including an "Omnyo" profile that an earlier private build seeded.
- Connect sessions: `expo-secure-store`, one key per profile
  (`omnyo.connectSession.<profileId>`) holding the last minted desktop-session
  cookie and its server URL.
- Preferences (theme mode `omnyo.theme`, haptics `omnyo.haptics.enabled`): MMKV
  store `omnyo.preferences`, one shared instance from
  `src/lib/native/preferences-storage.ts`. Push state shares it:
  `omnyo.push.enabled.<profileId>` (+ `omnyo.push.enabledProfiles` index),
  `omnyo.push.registration.<profileId>` (+ `omnyo.push.registrations` index: the
  token / server row the phone registered, so a removed profile can still be
  unregistered), `omnyo.push.prompted`.
- Reinstall (private iOS): iOS keeps Keychain items when the app is deleted,
  so a reinstall opens the saved servers, relay pairing and sessions directly,
  with no start or import screen.
- Each profile owns one SDK client, one realtime socket, and one TanStack
  QueryClient (`src/lib/sdk/client-registry.ts`, instantiated once by
  `src/app-shell/client-registry.ts`); the active profile's socket/session
  lifecycle lives in `src/lib/connection`.

## Theme tokens

`src/theme/theme.native.ts` is generated from the web app's
`apps/app/src/components/ui/theme.css` plus the built-in palettes in
`apps/app/src/lib/themes/*.ts`: every color token per palette × light/dark as a
plain RN color string, with `nativeRadii` and the touch (`pointer: coarse`)
`nativeTypography` scale. Do not edit it by hand. After changing theme.css or a
palette, run `pnpm --filter @omnyo/mobile theme:generate` and commit the result;
`src/theme/generate-native-theme.test.ts` fails when the file is stale.

## Notes

- Workspace packages resolve from TypeScript source through `metro.config.js`
  (`source` export condition for `@omnyo/*` only, `./x.js` → `./x.ts`).
- Import `@omnyo/sdk/browser`, never `@omnyo/sdk` (lint-enforced).
- Never spread a `Headers` instance into a fetch init on React Native.
- `lightningcss` is pinned to 1.30.1 for `@expo/metro-config` (NativeWind v5).
- Type-scale line heights in `global.css` are unitless ratios
  (`calc(22 / 15)`), not px: react-native-css drops the unit inside Tailwind's
  `var(--tw-leading, …)` fallback and treats the number as an em multiplier.
- On a `ScrollView`, do not combine `contentContainerClassName` with an inline
  `contentContainerStyle`; the class styles are dropped. Use one or the other.
- `Sheet` sets `accessible={false}` on the bottom-sheet container so rows are
  reachable by VoiceOver/Maestro.
- Maestro on iOS: `back` is not a thing; tap `id: BackButton`. The dev
  client's floating gear can sit over the header's right icons on larger
  simulators.

Pair a phone through Settings → Mobile (`/settings/mobile`) → **Add mobile device**.

## Android keyboard image paste

The `react-native-webview` patch receives keyboard image content through
AndroidX `InputConnectionCompat`. It is enabled only for WebViews with Omnyo's
injected mobile bridge. The bridge captures the focused prompt editor, then
replays the image as a clipboard file through the existing web paste handler.
The WebView serves a temporary, single-use URL from the keyboard's content
stream. Image bytes stay binary instead of passing through base64 or a
JavaScript string. Reads run off the UI thread, stop at the composer's 35 MB
attachment limit, and must complete within 30 seconds. At most four transfers
can be pending per WebView. Completion, timeout, navigation, and WebView
destruction close the stream and release URI permissions. The bridge delivers
the file only after the complete body and native success confirmation arrive;
failed reads and removed or navigated editors discard the result. This requires
an updated Android APK but works with the existing web composer without a
server update.

For a device smoke test:

1. Copy a screenshot to the Android clipboard and focus a thread composer.
2. Open Gboard's clipboard panel and tap the image. Check that its attachment
   preview appears and finishes uploading.
3. Paste ordinary clipboard text and check that it still appears in the editor.
4. Paste a large image up to 35 MB and check that it completes without closing
   the app. An image above the limit must not create an attachment.
5. With a test content provider, delay one image read beyond 30 seconds, then
   paste another image. The second image must arrive while the first expires.
6. Navigate away during a delayed read and check that its result does not attach
   to another composer.
7. Remove the test attachments and text without sending a message.

Bridge regression tests run with
`pnpm exec turbo run test typecheck --filter=@omnyo/mobile-bridge`.

## Android message copy

For messages containing text and an image, Android Copy uses the shell's
`copyRichText` method to publish `text/plain` plus `text/html`. The HTML carries
hidden, versioned Omnyo metadata with the exact message text and an image URL.
Omnyo's regular Paste handler validates that metadata, inserts the text and
fetches the image from the same server with the current session. Downloads
reject redirects and non-image responses, enforce the 35 MB attachment limit,
and time out after 30 seconds. A failed download preserves the pasted text and
reports that the image could not be attached. Results from removed editors or
pages that navigated away are discarded.

Android WebView's long-press Paste delivers the HTML. Gboard's text suggestion
and clipboard-history text entries insert plain text without a rich paste
event, so those paths paste text only. Omnyo does not compare inserted text with
previous messages or retain a copied-message cache. HTML-aware destinations
can also render the text and image reference; plain text destinations receive
only the text. The image reference requires access to the original server and
image. Copying image bytes for external image targets uses the image-only path.

Image-only messages use `copyTextAndImage` to download the image into the app
cache and expose its URI through the WebView FileProvider. Downloads are
limited to 35 MB, reject redirects, and expire after 25 seconds with 10-second
network timeouts. Old cache files are removed on the next copy after 24 hours.

Both the APK and served Omnyo web app need this change. Older APKs retain the
previous combined image/text item behavior. Verify mixed-message Copy followed
by long-press Paste, Gboard text insertion, image-only Copy/Paste, ordinary text,
and a missing image. Remove test drafts without sending them.
