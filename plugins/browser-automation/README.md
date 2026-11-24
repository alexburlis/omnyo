# Browser Automation for Omnyo

Thread-owned browser scripts, desktop attachment, and local headless Chrome
on enrolled hosts. Requires the public
`api.sdk.experimental_desktopBrowsers` API (SDK 0.4.48 or newer).

Browser Automation is optional and disabled by default. Enable it in plugin
settings when you want to use it.

The plugin was scaffolded with `omnyo plugin new browser-automation`. It has server, host,
app, CLI, RPC, and a bundled skill. Agents use the CLI through the skill. Screenshot
commands return temporary JPEG file paths and the browser host ID. Local headless
sessions show a live preview inline in the chat that expands into a lightbox; see
[Live preview](#live-preview). Screenshot cards and a screenshot sidebar viewer are not included. Cloud provisioning and arbitrary CDP endpoints are excluded.

## Runtime installation and provenance

The DevBrowser runtime is installed automatically on the **selected browser
host** the first time a session is opened there. Nothing is installed on the
server or on the invoking agent's machine, and the user's global npm
installation is never touched. `runtime-pin.ts` pins one exact npm release:

| Field        | Value                                                               |
| ------------ | ------------------------------------------------------------------- |
| package      | `dev-browser@1.0.0-rc.4` from `registry.npmjs.org`                  |
| repository   | [SawyerHood/dev-browser](https://github.com/SawyerHood/dev-browser) |
| tag / commit | `v1.0.0-rc.4` at `e5d746f1fc17a3301d6e7f865f89c034f15f69fb`         |
| linux-x64    | `fa6cec3f84463e171bd7b307e2e1f0243df59c70c38f96d790dc41b160db921a`  |
| linux-arm64  | `578db7f1e502cf6b9e43ac09e6adc5720f5397fa3e6d6b7b9ba8377708fe040e`  |
| darwin-x64   | `7cfad83f7f9e16dc5acbc94553430bcd1be24adc4304c0f534805969bfa6d2ba`  |
| darwin-arm64 | `f0a7e7d10ab8be0fee1ee8ac2ca33d3efc46b493e5e998b29ea75c79479a2e8d`  |

The digests are the SHA-256 values published in that release's `SHA256SUMS`.
The pin never follows the `next` or `latest` dist-tags and never falls back to
another version. Windows has no upstream artifact and is refused.

On the browser host the installer (`installer.ts`, run inside the plugin host
worker) performs these steps under
`<plugin host dataDir>/runtime/npm/`, a directory owned by the plugin:

1. Locate `npm` on the host worker's `PATH`; a missing npm is a clear error
   naming the host requirement. npm 9.5 or newer is required for attestation
   checks.
2. `npm install --ignore-scripts` of the exact version from the pinned
   registry (passed explicitly, so a host `.npmrc` mirror cannot substitute
   it) into a private staging directory with a plugin-owned npm cache. The
   package's own postinstall is never run, and the resolved tarball URL must
   come from the pinned registry.
3. `npm audit signatures --json` must exit zero with no invalid or missing
   signatures. The SLSA provenance attestation is then fetched from the
   registry: its subject digest must equal the installed tarball integrity and
   its workflow must name the pinned repository at tag `v<version>`.
4. Download `dev-browser-<platform>` and `SHA256SUMS` from the GitHub release
   for that tag into the package's `bin/dev-browser-bin`, the location the
   package's own shim expects. The stream digest must equal the pinned
   digest, and `SHA256SUMS` must agree, before the file is used.
5. Run `dev-browser-bin --version` and require the pinned version, write
   `verified.json`, and atomically rename the staging directory to
   `runtime/npm/dev-browser@<version>/`.

Warm starts read `verified.json`, re-hash the binary, and use it without npm or
network access; a tampered or missing binary triggers a fresh install. A lock
file, created atomically with the installer's PID, serializes concurrent
installs across worker processes; in-process callers share one job. Locks
whose owner process is gone are reclaimed only after re-checking their
identity, and staging directories are scoped per package version. An interrupted or failed install removes its staging directory
and leaves no partial runtime; the next open retries. When no session is
waiting on an install for 15 seconds, the install is cancelled.

Because a first install can exceed the 30-second host RPC deadline, the server
polls the host's `prepare` RPC, which long-polls the shared install job and
reports progress, before calling `open`.

### No fallback

A platform without a recorded digest fails with an explicit error; the plugin
never falls back to another version, a `PATH` binary, or the older pre-release
integration build. The `smoke` task takes an explicitly provided binary and
labels it `developer-artifact`; that source exists only for fixtures and is
never chosen automatically. The upstream MIT license is preserved in
`DEVBROWSER-LICENSE`.

### Bumping the pin

1. Wait for the upstream tag workflow to publish both the npm version and the
   GitHub release; merging alone publishes nothing.
2. Fetch `https://github.com/SawyerHood/dev-browser/releases/download/v<version>/SHA256SUMS`
   and copy the four digests into `runtimeRelease.artifacts`.
3. Confirm `npm view dev-browser@<version> gitHead` matches the tag commit.
4. Run `pnpm exec turbo run smoke:install --filter=omnyo-plugin-browser-automation` on a
   Linux and a macOS host.

Headless sessions need Chrome/Chromium on that host. The plugin checks
`<plugin host dataDir>/runtime/chrome`, the standard macOS Chrome path, then
`google-chrome`, `google-chrome-stable`, `chromium`, and `chromium-browser` on
PATH. The `runtime/chrome` entry can be a symlink to an installed executable.
Plugin-owned local/headless Chrome uses Chrome's sandbox. Hosts that restrict
unprivileged user namespaces must enable a supported Chrome sandbox before opening
a local session. Desktop sessions attach to an existing browser and do not change
its launch flags.

## CLI and agent workflow

Choose both the backend and its host explicitly. There is no silent fallback or
profile migration. Find desktop instances through Omnyo's core desktop-browser
CLI/SDK discovery. The selected instance's generation is resolved on opening.

```sh
omnyo browser-automation open --backend local --headless --machine <host-id> --json
omnyo browser-automation open --backend desktop --machine <desktop-host-id> --desktop <instance-id> --json
omnyo browser-automation list --json
omnyo browser-automation run <session-id> --script 'const p = await browser.getPage("main"); await p.goto("https://example.com"); const state = await p.snapshot({interactive:true,track:"main-interactive"}); state.full' --json
omnyo browser-automation run <session-id> --script-file ./check.js --script-host <invoking-host-id> --timeout-ms 30000 --json
omnyo browser-automation pages <session-id> --json
omnyo browser-automation screenshot <session-id> --page main --json
omnyo browser-automation preview <session-id> [--after <sequence>] --json
omnyo browser-automation stop <session-id> --json
omnyo browser-automation close <session-id> --json
```

Outside a thread, supply `--thread <thread-id>`. Calls from an existing thread
cannot override its ownership. `--script-file` requires `--script-host <host-id>` naming the source host
explicitly and is read through `api.sdk.files`, then transferred as script text to the
browser host. Relative paths use the invoking CLI working directory. Browser
file reads/writes still occur on the browser's host; scripts are not run in the
workspace directory.

### Compact observations

The pinned runtime supports `p.snapshot({interactive:true,track:"main-interactive"})`,
which returns `{full, incremental}`. Return `.full` for the initial observation.
Within the same observed document, batch an action and its observation in one
script and return `.incremental`:

```js
const p = await browser.getPage("main");
await p.click("ref/<observed-ref>");
const state = await p.snapshot({
  interactive: true,
  track: "main-interactive",
});
state.incremental;
```

Replace `<observed-ref>` with a ref from the current page's latest observation.
Returning the whole `state` repeats both versions. Incremental output contains
added/removed semantic-tree lines with context, `(no changes)`, or an explicitly
labeled full tree when changes are substantial. The first tracked observation
is full. This reduces returned text; it does not skip tree extraction or prove
a model latency or billing improvement.

The tracker retains its baseline across navigation. Return `.full` after a
navigation or reload, changing snapshot scope/options, or losing the previous
observation from context; that call also updates the baseline. An action that
may navigate needs the same full observation afterward. Keep options stable
within a track and use distinct tracks for distinct scopes. Main-document refs
reset on document replacement, so obtain fresh refs before acting. Never reuse
refs from another page or session. Request a screenshot for visual checks;
unchanged semantic output does not establish unchanged pixels.

Desktop sessions create a tab in the Omnyo browser's profile, so pages load with
the user's signed-in cookies, including cookies imported from another browser.
Acquiring control opens the side panel and selects its browser tab only when
the owning thread is already focused. New or activated controller pages follow
the same rule. Automation does not switch threads or bring the desktop window
forward. While controlled, a desktop tab never takes keyboard focus from the
composer or other apps; press Take over to type into it. Pass
`--tab <tab-id>` only to take over an existing tab; `close` preserves that tab.
The plugin records every tab opened under the session's control lease, and
`close` disposes the plugin-created tab and those pages. `stop` releases
control and preserves desktop tabs, including plugin-created ones, until close
or cleanup.

Local sessions own a Chrome process and a separate, empty profile. Each session owns a
fresh `DEV_BROWSER_HOME` and socket under the worker's temporary directory.
Pages and cookies persist between runs in that session. `stop`, timeout, or
cancellation terminates that local session; open another session to resume.
`close` disposes its processes and session directory. Tabs taken over with
`--tab` remain open. Sessions close after 30 minutes without `run`, `pages`, or `screenshot` activity.
Each operation renews expiry at its start and completion, up to eight hours from
creation; active scripts do not count as idle. The hard deadline also stops running
work. Desktop control leases and connections cannot be renewed through the current
API, so desktop sessions retain their earlier deadline (at most 30 minutes from
creation). `list` and live preview do not renew expiry. Archiving, deleting, or failing a thread
closes its sessions; normal idle turns preserve them. Externally invoked CLI
runs remain subject to the same per-run timeout and absolute session expiry. Run timeouts default to 30 seconds and are
bounded to 1–120 seconds. Runs are serialized per session.

DevBrowser scripts are trusted code, not a security sandbox. Script output is
bounded to 512 KB before parsing and 160,000 text characters after parsing.
A run whose output passes 512 KB is stopped and fails with exit code 1; the
session stays open.
Up to four JPEGs fit within a combined 500 KB budget. Image file paths
must resolve inside that session's capture directory; oversized files and
escaping symlinks fail. CLI `run` and `screenshot` JSON returns `hostId` plus
`images: [{path, mimeType, width, height}]`, without inline image bytes. The
plugin copies each capture into the calling chat's thread storage under
`Screenshots/`, so the paths survive closing the session; `hostId` names the
machine holding that storage. Agents read them directly on that machine, or use
`omnyo file read <path> --host <host-id> --json` to fetch a remote image and
decode its base64 content to a local temporary JPEG. The bundled skill includes a
copy-pasteable command. Storage & retention removes them with the rest of the
thread's files when its archive cleanup runs. Endpoints and connection
credentials are removed from structured script text and never included in
session records or CLI session results.

The CLI uses the same validated operation handlers as RPC. The
RPC contract in `contracts.ts` exposes `open`, `list`, `run`, `pages`,
`screenshot`, `preview`, `stop`, and `close`.
RPC inputs include `threadId`; session operations also include `sessionId`.
`open.selection` is `{backend:"local",hostId}` or
`{backend:"desktop",hostId,instanceId,tabId?}`. A tab ID takes over that existing tab.
Agents discover the commands through the skill and CLI help.

The host supervises Chrome and the DevBrowser daemon as separate children. Each
child owns a process group. Closing the worker pipe also stops those groups, so
a worker crash does not leave browsers running. Stop sends TERM then KILL after
1.5 seconds. The plugin does not discover or kill processes from PID files.
`stop` and `close` retire the session before cleanup starts, so it accepts no
more commands and an `open` still starting is aborted. They succeed only once
the host has released the browser processes and session directory and the
desktop lease and tabs are released. Otherwise they fail with the reason,
including a host that does not answer within 10 seconds. Concurrent closes
share one outcome, and closing again retries cleanup. A host worker repeats a
session's close outcome until that worker exits, and refuses to reopen a
session it already closed.
Server metadata persists ownership and cleanup needs; restart reconciles active
sessions, retries unfinished cleanup, and revokes their desktop leases. Unreachable desktop cleanup remains
recorded for reconciliation on a later plugin load. Desktop lease loss is
observed using the public SDK subscription; core revokes the CDP endpoint
immediately, and the plugin stops its worker session when notified.

## Live preview

Opening a local headless session returns a `previewDirective` in the CLI
result, `::browser-preview{session="<session-id>"}`. The plugin's agent
instructions tell the agent to paste it once, as a standalone line, in its next
message. Omnyo renders that line inline in the chat as a live thumbnail of the
browser with the page title, location, and a Live, Ended, or Unavailable state.
The card collapses, and its expand button opens the same live view in a
lightbox sized to the window; on compact screens the lightbox is the shared
responsive drawer. The lightbox is mounted once per window as an app overlay,
not inside the card, so it stays open and live when the timeline paginates the
card away. Desktop sessions return no directive and never preview: that
browser is already visible in the app's side panel, and its brokered connection
is not reused for previews.

Frames come from a second, read-only CDP connection that the host worker opens
to the session's own Chrome (`preview.ts`). It runs `Page.startScreencast` as
JPEG at about four frames per second, at most 800 pixels on the long edge for
thumbnails. While a lightbox requests `size: "full"` it recasts the same page at
up to 1280 pixels, the headless window's width, and returns to thumbnails ten
seconds after the last full-size request. It casts only while something is
watching: the connection closes after 15 seconds
without a request and reopens on demand. It previews the page that navigated
most recently, preferring any page over `about:blank`, so it follows the named
page a script is driving. Previews never enter the per-session run queue, so
they keep updating while a script runs and never delay one.

The app long-polls the `preview` RPC with the last sequence it rendered and the
`size` it needs, `thumbnail` by default; the
server forwards to the host's `preview` RPC, which answers as soon as a newer
frame exists or after five seconds with `frame: null`. An inline card polls
only while the window is visible and it is expanded and scrolled into view, so
cards left behind in the chat history cost nothing. The lightbox opens from the
card's current frame and then runs its own poller; the card pauses its poller
while its session's lightbox is open. Preview requests are not
session activity: watching a preview does not postpone the 30-minute idle
cleanup. When the session stops, closes, or expires, the card keeps its last
frame dimmed for as long as it stays mounted; a card first viewed after that
shows only its Ended header. A card whose session it can never read, such as a
directive copied into a forked thread, gives up after five failed requests.

`omnyo browser-automation preview <session-id> --json` reports the same live frame
as `{session, frame}` where `frame` has `sequence`, `mimeType`, `width`,
`height`, `url`, `title`, and `bytes`, or is `null` when nothing newer than
`--after` arrived. It omits the image bytes; use `screenshot` for a file.

## Validation

From the Omnyo checkout, use Turbo:

```sh
pnpm test:dev --package omnyo-plugin-browser-automation -- runtime.test.ts
pnpm exec turbo run typecheck --filter=omnyo-plugin-browser-automation
DEV_BROWSER_SMOKE_BINARY=/absolute/path/to/verified/dev-browser \
DEV_BROWSER_SMOKE_CHROME=/absolute/path/to/chrome \
pnpm exec turbo run smoke --filter=omnyo-plugin-browser-automation
DEV_BROWSER_SMOKE_BINARY=/absolute/path/to/verified/dev-browser \
DEV_BROWSER_SMOKE_CHROME=/absolute/path/to/chrome \
pnpm exec turbo run smoke:deltas --filter=omnyo-plugin-browser-automation -- /absolute/path/to/owned-scratch-parent
DEV_BROWSER_SMOKE_CHROME=/absolute/path/to/chrome \
pnpm exec turbo run smoke:install --filter=omnyo-plugin-browser-automation
```

`installer.test.ts` drives the installer against a fake `npm` and a local
release server: exact-version install, provenance rejection, digest and
`SHA256SUMS` mismatches, warm reuse without npm or network, tampered-binary
reinstall, concurrent callers, stale locks, and cancellation cleanup.

`smoke:deltas` verifies the existing binary's pinned version and digest without
installing anything. It creates one disposable child under the supplied owned
scratch parent and removes it after closing the headless session. Real browser
actions exercise initial/full and unchanged observations, a changed control and
status, removed-element ref rejection, navigation/full baseline replacement,
and observation-scope replacement. The JSON report compares full/incremental
UTF-8 byte counts from the same observed state; it makes no timing claim.
The run has a 40-second work bound, within the 60-second command limit.

`smoke:install` performs a real cold install of the pinned release from
npm and GitHub into a disposable data directory, then a warm resolve with no
npm on `PATH`, then drives real headless Chrome through the installed binary,
including a cross-origin iframe snapshot and a JPEG screenshot. It prints the
binary path, its SHA-256, and timings.

`smoke` takes an explicit binary and creates disposable directories and runs
real Chrome, without starting an Omnyo core or using an existing browser profile.
It verifies named pages, navigation, clicking, JPEG bytes, a live preview that
follows a second named page while its script runs and switches to full-size
frames on request, serialization,
independent session cancellation, a synchronous infinite-loop timeout,
reopening, closing a runtime session (further runs are rejected), and
preservation of an attached browser and its page state after that session
closes.
Both smokes link directly to Chrome and exercise the production launch flags
without a wrapper. The attachment smoke also launches its separate browser fixture with Chrome's sandbox enabled.

Build with a current Omnyo CLI: an older installed CLI can successfully bundle the
sources while stamping old SDK metadata. Inspect `dist/*.meta.json` before any
future installation or distribution. Generated bundles and declarations are
ignored. No plugin installation or live core is needed for these checks.

## Responsive previews and annotations

The expanded local/headless preview includes real Phone (390×844, DPR2, touch),
Tablet (820×1180, DPR2, touch) and Desktop (1280×800, DPR1, mouse) presets.
Restore viewport preserves an adopted tab's exact prior metrics and refuses to
overwrite a later external emulation change. These calls share the runtime's
existing serialized script queue. No second browser controller is added.

Annotate freezes a fresh bounded screenshot and visible element map for the exact
preview target. Users select an element, write a note and append its cropped image
and context to the originating chat draft. Images upload through project-owned
attachments, rather than a host-local path. They remain readable after browser
closure and when the agent runs on another machine. Notes are batched without
sending; stale capture or failed upload preserves the unsent text.

Selection maps actual bitmap dimensions through scale/letterboxing to CSS
coordinates. Navigation, reload, scroll, resize, preset changes, DOM replacement,
layout movement and new visible occluders invalidate the observation. A fresh
selection is required before another crop. Observations are bounded to 512 visible
elements and 100,000 serialized characters; each action returns one JPEG within
the existing runtime screenshot budget. The live stream pauses during selection.

SDK RPC methods `observe`, `inspect` and `viewport` match CLI commands of the same
name. Each requires the exact target ID returned by preview/pages; inspect also
requires the returned observation and element IDs. See the bundled skill for
commands. CLI JSON contains image host/path and dimensions without image bytes.

`pnpm exec turbo run smoke:visuals --filter=omnyo-plugin-browser-automation -- EVIDENCE_DIR`
uses the pinned installed runtime and a synthetic owned headless Chrome page to
verify real metrics/touch, scrolled DPR2 crop pixels, stale selection fences,
viewport restoration and exact multi-target routing. It requires the existing
`DEV_BROWSER_SMOKE_BINARY` and `DEV_BROWSER_SMOKE_CHROME` test inputs. It creates
and removes its own browser profile and session files, keeping only compact proof
and the selected JPEG under the supplied evidence directory.
