# Omnyo packaged native lifecycle proof

This harness owns a fresh temporary runtime HOME, separate fresh/seeded Omnyo stores
and Electron profiles, provider configuration directories, and two previously
unused loopback ports. The native desktop preserves the current login account's
canonical HOME for macOS Keychain. It starts the actual packaged macOS app through
LaunchServices in the background, without a fake server or provider login. The
parent owns packaging and serialized native execution.

Failure criteria, authored before the harness:

- The bundle is not `dev.omnyo.private` / `Omnyo`, or lacks its bundled bridge,
  server, daemon, and three required plugin payloads.
- The packaged logical version is not a release version (`X.Y.Z` or
  `X.Y.Z+private.N`), differs from the expected desktop package version, or its
  normalized native base version/build does not match. The live server must
  report the exact logical version.
- Startup attaches to an existing listener, uses a server outside the tested app,
  or fails to produce an app-owned bridge and app-owned server/daemon listeners.
- The desktop loses the login account's canonical HOME, or runtime/provider
  configuration resolves outside owned scratch.
- Either required downstream builtin appears more than once, remains orphaned,
  resolves outside this app, or loses its migrated installation intent/settings.
- Legacy IDs remain enabled. The Composer Predictions setting becomes enabled, an account
  appears, or a routed/provider thread is created during this proof.
- Account Usage and Account Pooler cannot serve their real read-only RPCs.
- The second native launch changes migrated registration/settings rows, duplicates
  plugins, uses different package bytes, or loses persisted disabled intent.
- Exact graceful native termination fails, a tracked owned actor/listener remains,
  or the desktop-owned runtime marker remains after shutdown.
- Cleanup would remove scratch while an owned actor is still live. In that case
  retain the precise scratch path and fail visibly.

The primary contract is native packaging/runtime ownership, persisted migration,
and graceful lifecycle cleanup. Credible regressions include missing packaged
plugins, wrong bridge resolution, startup-order migration errors, and orphaned
server children. The existing `smoke-packaged-app.mjs` attaches a fake HTTP server
and cannot cover these contracts. No production seam is added.

Run from the repository root with the existing Node 24.19.0 toolchain and installed
`tsx`/SQLite dependencies. The runner never installs or compiles anything. Native
execution must be serialized with other desktop/UI jobs.

```sh
node --conditions=source --import tsx tests/qa/private-native/proof.mjs \
  '/absolute/path/to/Omnyo.app' \
  /absolute/path/to/new-evidence \
  /absolute/path/to/new-disposable-scratch \
  --candidate-receipt /absolute/path/to/results/native-build.json
```

The last argument is optional; without it, the runner creates its own temporary
directory. An explicit scratch path must not exist. The app must be the prepared
bundle outside `/Applications`. Evidence must be outside scratch, and each attempt
needs a new result path.

For continuous candidates, use the complete native build receipt from that job.
The runner verifies its version, protocol and Mac runtime/desktop hashes against
the extracted app. Without the optional flag, the expected logical version comes
from the canonical desktop package.

The desktop HOME comes from `node:os.userInfo().homedir`, not the caller's
environment. An invented desktop HOME makes macOS default Keychain lookup fail;
encryption stays enabled. Each owned Omnyo store uses the supported `env.json`
configuration (`{"env":{"HOME":"<scratch>/home","PATH":"/usr/bin:/bin:/usr/sbin:/sbin"}}`) to give server and daemon
children their isolated HOME and system-only PATH before startup. `CODEX_HOME`, `CLAUDE_CONFIG_DIR`,
`PI_CODING_AGENT_DIR`, XDG paths, `ZDOTDIR`, and temporary files also resolve into
owned scratch. Only explicit environment values reach the native app; caller
Omnyo/provider credentials are cleared. The harness does not read or change Keychain
items, vault credentials, or the login account's Omnyo/provider stores.

Three native launches run: a fresh store, then a legacy-seeded store twice.
Both isolated Electron profiles explicitly select `builtin` through the normal
`server-target.json` schema. Fresh private profiles otherwise select the private
remote coordinator and do not start a bundled local runtime. This fixture choice
never changes a production profile or the private app's normal remote default. The
fresh store contains only the real migrated schema and the downstream Composer
Predictions safety settings (`enabled=false`, an unusable Codex path); it contains
no preinstalled plugins, accounts or threads. Its builtins use normal installation
defaults: Composer Predictions and Account Usage are installed once, and
Account Pooler is discovered disabled. The seeded store preserves a disabled
legacy Composer Predictions installation, an enabled legacy Account Usage
installation, and their exact settings. Account Pooler is enabled with no accounts
so its real read-only RPCs and the Account Usage snapshot can run.

`result.json` records the app identity, exact logical package version, separate
native bundle version/build, complete bundle digest, three
native ownership trees, listener PIDs, actual server origin/version, builtin
discovery, DB rows/settings/timestamps, seeded-startup idempotence, graceful
shutdown, and storage closeout. `bundle-manifest.json` binds every packaged file
byte or symlink target. Runtime log contents and generated private capabilities
stay in disposable scratch. Each launch attempt records its exact LaunchServices
executable, PID and birth time before bridge readiness. Failure metadata retains
log sizes, hashes, allowlisted error codes and diagnostic categories with line
numbers; it never retains raw log lines. `launch-metadata.json` is written before
scratch removal, including when launch fails before an ownership marker exists.

The native plist version is the logical base version. For protocol 236 and later,
the native build is the private revision for a tagged version (`1` for
`1.0.0+private.1`) and the base version for an untagged one (`1.0.1` for `1.0.1`);
older bundles use the base version for both fields. The live server must report
the full logical version.

Graceful quit uses `NSRunningApplication` for the verified exact native PID,
without activation or a bundle-wide quit. Failure cleanup can terminate only
tracked PID/birth-time identities established from that exact executable and its
descendants. Native discovery uses LaunchServices independently of runtime
scratch and refuses an executable already running before the attempt. Cleanup
checks LaunchServices again before removing scratch.
Forced cleanup never counts as graceful acceptance. Scratch is removed in
`finally` only after tracked actors, both listeners, and open scratch owners are
absent; otherwise the failure result records the exact retained path. Failed startup also
retains owned scratch after actor cleanup until its diagnostics are privately
classified; raw logs are never copied into retained evidence.

Authoring validation: `node --check`, scoped `oxlint`, scoped `oxfmt --check`, and
`git diff --check`. Native execution remains the parent's separate acceptance
gate; authoring checks do not establish startup or shutdown success.

## Opt-in real notification proof

Start the parent's supported native UI driver watching a new evidence directory,
then run the exact final candidate with native/UI execution serialized:

```sh
node --conditions=source --import tsx tests/qa/private-native/proof.mjs \
  '/absolute/path/to/Omnyo.app' \
  /absolute/path/to/new-evidence \
  /absolute/path/to/new-disposable-scratch \
  --candidate-receipt /absolute/path/to/results/native-build.json \
  --notifications
```

The default lifecycle stays unchanged. This option pauses the third launch before
its existing graceful quit. It requires a candidate receipt and binds every
checkpoint to its source/version/protocol/hashes, bundle digest, exact native
PID/birth, app path, store, profile and loopback server. The harness configures
mobile/web off and desktop on through candidate-local settings. It calls only
`notifications.send` and `notifications.pending`, never `notifications.ack`.
Actual persisted acceptance must have exactly one desktop target, with the notice
absent from desktop pending results. No provider or thread is created.

If the exact candidate already passed the complete three-launch lifecycle, add
`--reuse-lifecycle /absolute/path/to/prior-evidence/result.json` to run only one
new isolated legacy-seeded launch and the notification phase. This option requires
both `--notifications` and `--candidate-receipt`. Before creating runtime scratch
or launching an app, the runner verifies the prior passing result, all three
graceful shutdowns, completed cleanup, seeded idempotence, identical candidate
receipt/source/version/protocol/runtime/desktop identities, and the complete
adjacent `bundle-manifest.json` against the current extracted app. Moving the
extracted app to a new path is allowed; changing any packaged byte is not.
Chained reuse is refused. Keep the original result and manifest as required proof.

The new result records their paths and hashes under `reusedLifecycle`; its
`launches` contains only the current notification launch. It records current
bundle integrity separately and does not claim a new three-launch or repeated
startup-idempotence run. The original proof remains the lifecycle acceptance.

The supported send RPC assigns `threadId: null`. Click proof therefore means
reopening this candidate at its loopback server root; it does not prove thread
deep links. Inspect the actual window URL through supported native accessibility
or an existing supported window/browser inspection API. App names and screenshots
alone cannot establish the origin. Do not inject JavaScript, add debug ports,
simulate notifications or write acceptance rows.

The harness writes `notification-PHASE.request.json` and prints its path. Requests
contain the fresh `runId`, complete `binding`, unique neutral notice, required
observations, response path and shared ten-minute deadline. These expected fields
are a contract, never observed evidence to copy. Parent-driver phases:

| Phase                | Actual native action and observation                                                                                                                                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `closed`             | Close only windows of the bound PID without quitting or activating another app. Record zero candidate windows. Begin continuously watching the unique notice before returning this response.                                                                      |
| `displayed`          | Observe the actual OS notice's exact title/body and one displayed instance, with zero candidate windows. Retain a PNG screenshot. The harness sends after publishing this request.                                                                                |
| `duplicate-closed`   | Watch the repeated RPC produce no redisplay while windows stay closed.                                                                                                                                                                                            |
| `clicked`            | Click the real unique OS notice. Verify one reopened window on the same PID, its actual loopback origin and `/` pathname. Retain accessibility or supported window-URL evidence. This explicit click may naturally focus the app; the harness never activates it. |
| `duplicate-reopened` | Observe no redisplay after another identical RPC, one window and no remaining matching OS notice. Dismiss only this synthetic notice if necessary.                                                                                                                |

Write `notification-PHASE.observed.json` atomically via a temporary file and rename,
only after actual observation. Never pre-create a success response. Required fields:

| Field                                 | Driver-supplied value                                                                                                                                                                                                                                                         |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`, `runId`, `phase`, `binding` | Schema `1` and current request identity/binding, independently checked against the controlled native PID/candidate.                                                                                                                                                           |
| `status`                              | `observed` after actual observation, or `failed` when unavailable. Failure stops the run.                                                                                                                                                                                     |
| `observedFrom`, `observedUntil`       | Integer Unix milliseconds bounding continuous observation, starting no earlier than the request and ending before its deadline.                                                                                                                                               |
| `observation`                         | Actual fields required by this phase's `expected` object: native window counts, unique notice identity/text, redisplay count and actual click URL, as applicable.                                                                                                             |
| `artifacts`                           | Nonempty array of `{ kind, path, sha256 }` for actual retained captures inside the evidence directory. Kinds: `screenshot` (PNG), `accessibility`, `window-url`. Hashes must match bytes. Display requires a screenshot; click requires accessibility or window-URL evidence. |

Keep observing from the request. The harness writes
`notification-PHASE.effect.json` after its real RPC/acceptance checks complete.
Every response must finish after this marker; each duplicate observation must
include the effect and continue at least five seconds after the marker. Never
replace driver failure with a success file or product ack.

A missing, stale, malformed, failed or wrongly bound response fails visibly at
the shared ten-minute limit or sooner. Existing exact-owned graceful/forced
cleanup still owns the app and scratch. Forced cleanup cannot pass acceptance.
The driver stops when `result.json` appears or the deadline expires; it must not
reopen the app during cleanup. Requests, effects, observed captures and results
stay outside scratch. The parent preserves compact required evidence and closes
driver-created temporary files. Syntax/lint checks establish authoring only:
actual final-candidate display, click, duplicate and cleanup proof remain the
parent's separate runtime acceptance.
