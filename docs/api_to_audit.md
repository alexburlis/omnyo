# APIs To Audit

## Native Claude profile owner pilot

The existing `experimental_NewThreadComposer` includes `claudeProfile` in its
`NewThreadRequest`. Plugins forward this selection unchanged to
`api.sdk.threads.spawn`; core and plugin composers use the same server binding
path. `api.sdk.providers.claudeProfiles` exposes profile management and defaults
through the same coordinator endpoint used by Account Pooler. The feature is
an explicit opt-in pilot on a supported coordinator host. It sends opaque profile IDs and safe
status metadata; the host owns native credentials and directory resolution.
Stabilization requires mixed-daemon rejection, immutable resume bindings,
duplicate handoff reconciliation, native expiry isolation, and supported
authentication-policy evidence before a broader rollout.

## Plugin manifest V1 import

`experimental_pluginPackageJsonSchemaV1` is the exact shared
`pluginPackageJsonSchema` from the core manifest boundary. Parse unknown
package metadata before reading its canonical `omnyo` declarations. The
schema accepts canonical metadata and the explicit original V1 fields,
collapses equal dual declarations, and rejects conflicting or malformed
metadata and engine requirements. Parsing preserves the caller's raw input.
Theme Preview uses it for both plugin CSS lookup and active-file change
tracking; the core manifest loader and plugin build validation use the same
schema. No separate parser or filesystem policy is added.
Stabilization requires auditing finite V1 imports, package identity,
conflicting namespaces, declaration strictness, and portable runtime and type
behavior in an external SDK consumer.

## App context, navigation and browser SDK names

`experimental_useAppContext`, `experimental_AppContext`,
`experimental_useAppNavigate`, `experimental_AppNavigate`, and
`experimental_PluginBrowserSdk` expose the current app selection, navigation,
and browser SDK contract. Core and plugin controls share the implementations in
`apps/app/src/lib/plugin-sdk-hooks.ts`; `plugin-sdk-app-impl.tsx` injects those
same functions into the plugin runtime. No separate navigation policy is added.
Stabilization requires auditing route changes, host routing, embedded thread
contexts, prefetch cancellation, and the browser SDK thread capabilities across
core controls and plugin panels.

## Own chat state for project indicators

`ThreadWorkSummary.experimental_ownState` gives the chat's primary work state
and activity flag before the server adds implicit dependent-chat work. The
field is absent when there is no implicit dependent work. Project Rail and
Chat Topics use it for project indicators. The full work summary still
drives chat details and archive eligibility. Stabilization requires checking
snapshot consistency across child status transitions, lifecycle owners, and
older clients.

## Visible app context

`experimental_useVisibleAppContext` returns `ExperimentalVisibleAppContext` from
Omnyo's current route, compose selection and focused panel owner. The owner
publishes only its open panel. Closing the panel, changing focus, navigating or
unmounting removes it from the snapshot. File labels contain only a basename;
browser labels contain only an HTTP(S) origin. No panel content, file paths,
query strings or credentials are included. Opaque terminal and plugin IDs are
available where the owner has them; other resource IDs are null.
Core panel owners and plugins share `apps/app/src/lib/visible-app-context.ts`.
Stabilization requires focused split, compact drawer, compose, route transition,
closed-panel and sensitive browser-address coverage.

## Compact command execution proofs

`api.sdk.threads.experimental_lookupCommandProofs({ threadId, selectors, signal? })`
validates a public thread once and returns redacted execution facts in selector order.
Command selectors require a unique exact match after trimming and CRLF normalization
within the latest 500 completed events. Explicit event selectors select one same-thread
completed command, including older events. Missing and ambiguous results remain distinct.
An empty selector list performs only existence validation. Selected output excerpts are
limited to 3,000 characters; other event outputs are never hydrated. Core `omnyo thread
proof` and Glance card saves share this endpoint. Stabilization requires auditing
window boundaries, command normalization after redaction, deletion and cancellation,
large retained outputs, and the selector and result limits.

## Environment removal notification

`experimental_environment.removed` announces successful provider removal after
its lifecycle transition is committed. The payload is `{ removal }`, containing
the environment ID, previous host/path, provider ownership, and removal time.
Delivery is ephemeral; plugins must reconcile external state after reload or
missed events. Provider success does not guarantee filesystem deletion.
Stabilization requires review of payload fields, repeat-removal semantics,
notification timing, and recovery without guaranteed event delivery.

## Agent configuration thread visibility

`PluginAgentConfigurationContext.thread.experimental_visibility` is the
thread's stored visibility, `"visible"` or `"hidden"`, resolved on the server
for each `api.agents.configure` call. Hidden threads are plugin background
threads such as side chats and workflow workers; native questions and
callbacks reject them, except that a hidden child chat's question goes to its
parent chat. The ask-user-question plugin withholds its durable tool from other
hidden threads so Claude Code keeps its blocking question there.
Stabilization requires deciding whether archived state belongs beside it and
whether one attention-availability flag would serve plugins better.

## Composer banner placement

`ComposerCustomization.banners[].experimental_placement` accepts only
`"adjacent-to-composer"`. Such banners render after the host's own banners and
every default-placement plugin banner, so they sit directly above the editor;
among themselves they keep the existing plugin registration order. The message
queue is the one exception: its tray is fused to the editor, so adjacent banners
sit above it while messages are queued. They share
one wrapping flex row, so each banner's root element sizes itself: a compact
chip keeps its content width, a status line grows, and a banner that needs the
whole width sets a full flex basis. The row is hidden while every adjacent
banner renders nothing or an empty root, so a banner must render an element
rather than bare text. Omitting the field keeps the existing
position and order. Any other value rejects that banner entry during
registration. Core's `ComposerBannersSlot` applies the rule for every composer
through the shared `resolveComposerBanners` result, regardless of the owner's
`ownerPlacement`. Glance is the visible caller; Composer Predictions mounts an
empty adjacent banner only to publish its composer suggestion.
Stabilization requires deciding whether more placements are needed, whether
the host should own chip sizing instead of each banner root, and whether
pending-interaction rows should sit above or below adjacent banners.

## Composer suggestions

`PluginComposerApi.experimental_setSuggestion(suggestion | null)` shows one
`ExperimentalComposerSuggestion` inside that composer while its draft has no
text, attachments or pending uploads, input is unlocked and voice input is
idle. On viewports at least 768px wide, every variant draws in the editor's
own text area, at its full width, with its controls on a bottom row aligned
with the send button. `ready` draws
`text` in muted type above a "Suggested reply" caption whose controls are
Insert (with a desktop Tab hint), dismiss and, when the plugin supplies
`onRegenerate`, "Suggest another reply". Until the user presses in the editor,
programmatic focus, including desktop auto-focus, keeps it. While it shows, the
send button reads "Send" at full strength and submits `text` through the host's
`submitDraft` without focusing the editor; Enter in the empty editor does not
send it. Insert and Tab in the empty editor insert it as editable text through
the core draft actions, as one editor undo step, and Escape or dismiss calls
`onDismiss`. After the user presses in, the text stays as a lighter shadow with
the same controls until the draft gains text; undoing an insert brings the
shadow back, and blurring an empty editor restores the suggestion. `loading`
shows "Suggesting a reply…" with the host's working shimmer over full-width
placeholder lines and a Stop control that calls `onDismiss`. `failed` shows
`message` with Retry. `none` shows "No suggested reply" with `reason` and a
"Suggest anyway" control that calls `onRequest`. `loading`, `failed` and `none`
hide on press. On compact viewports (narrower than 768px) and in the compact
composer layout, the suggestion is a card inside the composer above the editor,
separated by a hairline; the editor keeps its own placeholder and the
composer's own buttons never act on the suggestion, so the row shows the mic
while the draft is empty and Send once it has text. Each card has a caption
line, a body and an action row, and every variant keeps its dismiss control.
`ready` shows "Suggested reply" with "Suggest another reply" (when supplied)
and dismiss icons, the full `text` at the composer's text size clamped to
three lines (tapping it expands to the full text in a capped, scrolling area),
and an action row with Edit, which inserts it through the core draft actions
and focuses the editor, and a filled Send, which submits `text` through
`submitDraft` in one tap whether or not the editor was pressed. While the
composer cannot submit, Send stays visible but disabled beside the reason.
`loading` shows the shimmering caption, placeholder lines and Stop; `failed`
shows `message` with Retry; `none` shows `reason` with "Suggest anyway". Card
controls are at least 40px tall on touch devices, and a card or new state
fades in over the base duration, never on first paint.
Like text effects and input locks, suggestions are scoped to the calling plugin
and clear on unmount or scope change; with several publishers, the first plugin
id wins. Malformed values throw a `TypeError` at the boundary. Composer
Predictions is the only caller. Core never publishes suggestions; its own Send
button, the card's Send and Edit, and Tab and Escape handling are the only
paths that act on one, and they share core's send and insert implementations.
Stabilization requires deciding whether type-through partial acceptance,
several simultaneous suggestions or new-thread composers are needed, and
whether the loading, failure and no-suggestion states belong to this API.

## Composer popups

`ComposerCustomization.experimental_popups` registers an array of
`{ id, label, component }` popups, honoring the customization's composer scopes.
`PluginComposerApi.experimental_openPopup(id)` opens that plugin's popup in
that mounted composer. It returns false for missing, suppressed or out-of-scope
registrations. Popup ids are unique across all composer customizations within a plugin,
independently of customization ids. Duplicate and malformed entries are rejected
without dropping valid popups or other contributions.

Core mentions, commands and plugin popups share one composer-menu state,
Escape/dismissal lifecycle, `ComposerPopupHost`, and above/below placement.
Opening a plugin popup dismisses the built-in suggestions. Inside its component,
`useComposer()` targets the opening composer. Its `experimental_closePopup()`
closes the calling plugin's popup and restores the retained editor selection,
returning false if that plugin has no open popup. Desktop dismissal handles
Escape and outside clicks; returning to the editor also closes the popup.
Compact interactive popups use the shared persistent responsive drawer;
editor-driven suggestions remain inline so typing continues in the editor. The
component owns search, results and keyboard navigation. No automatic menu row
is added; actions, plus-menu rows and composer commands call
`experimental_openPopup`.

Before stabilization, verify multiple composers, selection retention, plugin
reload and crash recovery, scope suppression, and compact Safari
keyboard/drawer behavior. Verify multiple popups in one customization and popup-id uniqueness across
customizations.

## Chat-tap feedback (`experimental_AppNavigate.toThread`)

Pass `experimental_userInitiated: true` when a chat control opens an existing
chat. The host uses the same visible-pane check as core route links and search.
The default stays quiet for redirects and post-creation navigation. Stabilize
after verifying direct taps on iPhone and iPad, including visible and retained
hidden panes.

## Thread-open prefetch (`experimental_AppNavigate.experimental_prefetchThreadOpen`)

Signals that a person intends to open one thread. The host warms that thread's
bootstrap query, initial timeline query, and lazy route chunk through the same
query keys and cache used by normal navigation. The built-in thread-list row
calls it after a cancellable 100 ms mouse or keyboard dwell. The host runs at
most one bootstrap/timeline pair at a time and does not change unread state.

Before stabilization, measure cold and warm route readability, verify that
abandoned intent and rapid row changes do not queue work, and confirm that
prefetch leaves unread state unchanged until the opened timeline is visible.

## Composer commands

`PluginAppComposer.experimental_registerCommand({ id, title, defaultShortcut?,
run })` registers a command that is listed in the palette and Settings →
Keyboard, rebindable under `plugin:<plugin-id>/<command-id>`, and shares the
`app.commands` ID namespace. Each prompt box provides command ownership and
mounts its composer commands through `useComposerCommand`, the same hook Omnyo's
`composer.focus` uses; `run` receives that composer's plugin-bound
`PluginComposerApi`. Ownership (`composerOwnsCommand`, per
`[data-app-composer]` shell): the composer holding the caret, otherwise the
focused pane's primary composer. Plugin composer commands use Omnyo's composer
keybinding context (prompt available; no terminal, browser or modal focus).
The palette evaluates ownership against the element focused when it opened.

Before stabilization, verify split panes, side chat, inline queued-message
editing, palette invocation from each, plugin reload, and rebinding. Audit
whether composer scopes should filter commands the way they filter other
composer contributions, and whether commands need an availability callback.

## `settingsSection.experimental_page`

`experimental_page: "mobile"` mounts a plugin settings section exclusively on Settings → Mobile when that plugin owns the selected access provider, retaining plugin context, lifecycle, and error boundaries. Omission keeps the section on its plugin configuration page. Stabilization requires verifying placement isolation, plugin disable/uninstall, loading and failure states, and pairing lifecycle on Mobile.

## `app.commands.register`

`app.commands.register` requires SDK 0.4.91; `defaultShortcut` and keyboard
bindings require SDK 0.4.92.

Registers frontend commands with `{ id, title, defaultShortcut?, isAvailable?, run }`. The command
palette consumes the same registrations as the deprecated
`app.slots.commandPaletteAction` alias. Both paths share validation and a
per-plugin ID namespace. The public name follows the explicitly requested API
spelling without an experimental prefix. Types use `PluginCommandContext`
and `PluginCommandRegistration`; the old runtime registration path remains
compatible with compiled plugins.

Audit command identity, availability outside the palette, shortcut conflicts,
and saved binding lifecycle before stabilizing the keyboard shortcut contract.
`defaultShortcut` uses a key and optional boolean modifiers, normalized when
registered. The palette and keyboard path share availability and invocation.
Every command is rebindable under `plugin:<plugin-id>/<command-id>` through
Keyboard Settings or the existing keyboard settings SDK/CLI. Overrides persist
while plugins are inactive; inactive commands never handle keyboard events.
Conflicting plugin defaults are suppressed without load-order arbitration;
manual reassignment asks to replace the current binding or cancel. Audit
cross-platform conflicts and plugin lifecycle before extending the context
model or default binding policy.

## Discoverable RPC

`api.rpc.register` accepts optional `experimental_discoverable` and `experimental_description` options. Method definitions accept `experimental_description`. Discoverable registration exports wire schemas through Standard JSON Schema; validation-only schemas remain usable without publication. Descriptions are published separately and absent descriptions become null. Discovery advertises methods without changing RPC authorization or dispatch.

`api.sdk.plugins.experimental_discoverRpc({ pluginId?, method?, signal? })` lists published methods from loaded plugins. Methods disappear on unload; callers handle the race between discovery and invocation. Discovery and the SDK RPC caller accept an optional abort signal. The fake host exposes `experimental_publishedRpcMethods` on its registration inspection surface.

Before stabilization, audit schema export fidelity (especially refinements and transforms), descriptor size and reference limits, lifecycle races, and cross-plugin copied-schema compatibility. Verify `omnyo plugin rpc list|inspect` is sufficient to implement a consumer without a shared contract package. Method names carry optional versions; there is no negotiation.

## Plugin safe mode

`api.sdk.plugins.experimental_getSafeMode()` returns `{ enabled }`, and `api.sdk.plugins.experimental_setSafeMode({ enabled })` turns safe mode on or off and returns `{ enabled, problems }`, where `problems` names each plugin that did not start when safe mode ended. The server persists the flag. Plugins included with Omnyo keep running: rows with `builtin` provenance, plus rows from an auto-installed bundled source that kept catalog provenance. Every other installed plugin, including official store plugins, stays unloaded with status `disabled` and detail `safe mode is on`. Each plugin's own `enabled` flag is untouched, so turning safe mode off reloads exactly the plugins that were enabled. While safe mode is on, enabling a stopped plugin keeps it unloaded, reloading it reports a failure, and installing or updating it is refused so install handlers and update validation never run against an unloaded plugin. The same toggle backs `omnyo plugin safe-mode [on|off]` and the command palette.

Before stabilization, audit whether official store plugins should count as included, whether a plugin calling `experimental_setSafeMode` should be allowed to stop itself and others, whether the toggle should run asynchronously for installs with many slow plugins, and whether startup needs an out-of-band override (env var or flag) for a plugin that breaks the server before the toggle is reachable.

## Queued message edit holds

`api.sdk.threads.queuedMessages.experimental_holdForEdit({ threadId, queuedMessageId })` (`POST /threads/:id/queued-messages/:queuedMessageId/edit-hold`) holds a queued message while someone edits it and returns `{ leaseMs }`. While the hold is live, no automatic dispatch (idle drain, schedule, plugin recheck, host reconnect, failed-retry) claims the row, and the idle drain also leaves the drainable rows behind it queued, so the edited message still goes first. Rows behind a held row that wait on something else (a schedule, a plugin) are not held back. Explicit send-now still claims a held row. Calling it again renews the lease; a hold that is not renewed within `leaseMs` lapses and the periodic sweep dispatches the row. It responds 409 once a dispatch has claimed the row and 404 for a missing row. Holding never changes `updatedAt`, so `expectedUpdatedAt` from before the hold stays valid for the save. A successful `queuedMessages.update` clears the hold in the same write. `experimental_releaseEditHold` (`DELETE` on the same path) cancels without saving and is a no-op for an unheld row; releasing or saving a held row immediately re-attempts its dispatch. The app's inline queued-message editor takes the hold when it opens, renews it every quarter lease, and releases it on close. Holds are not owned: any client may renew or release one.

Before stabilization, audit whether holds need an owner token so two clients editing the same row cannot release each other's hold, whether queue DTOs and `omnyo thread queue list` should show that a row is being edited, and whether the lease length suits throttled background tabs.

## Queued message restore

`api.sdk.threads.queuedMessages.experimental_restore({ threadId, queuedMessageId })` (`POST /threads/:id/queued-messages/:queuedMessageId/restore`) puts back a queued message that `queuedMessages.delete` removed and returns the restored row. It keeps the original id, content, execution options, schedule (`sendAt`), wait, position and `createdAt`, and rejoins its queued group when the same neighbor is still adjacent. The server remembers each deleted row in memory for one hour (at most 200 rows per server); after that window, a server restart or a second restore it responds 404, and 409 when a row with that id exists again. The restored row is unclaimed and re-attempts dispatch immediately, so an overdue schedule sends at once. Plugins receive `messageQueued` for it, mirroring the `messageCancelled` they received on delete. The app's queued-message Undo (toast and Cmd+Z) and `omnyo thread queue restore` use this path.

Before stabilization, audit whether deleted rows should persist across server restarts, whether the one-hour window suits scheduled messages set far ahead, and whether restore should require the deleting client.

## Plugin cache pruning

`api.sdk.plugins.experimental_pruneCache({ dryRun?, maxItems?, maxBytes? })` (`POST /plugins/cache/prune`) deletes cached git and npm plugin versions under `<data>/plugins/cache` that no installed plugin uses, and returns `{ dryRun, removed, bytes }`. Each `removed` entry has `pluginId` (`null` for a cache directory with no artifact record), `version` (git commit or npm version), `path`, and the `bytes` it freed; a shared monorepo checkout is counted once. It removes every non-active version regardless of age (for example versions left by earlier Omnyo releases, the candidate of a rolled-back update, or an interrupted operation) and unrecorded commit or version directories. It keeps every installed plugin's active version, versions a pending or restoring rollback still needs, any directory containing or inside an installed plugin's root (legacy and path installs), and in-flight staging directories. It runs under the plugin registration lock, so it never overlaps an install, update, or removal. `dryRun: true` reports the same entries without deleting. Removing a plugin deletes its cached versions immediately, and a successful update deletes the plugin's replaced versions once activation has stabilized; only the update's state snapshot stays for the 7-day retention window. The same operation backs `omnyo plugin prune [--dry-run]` and the command palette's Clean up plugin cache.

Bounded requests select complete overlapping removal-root groups within `maxItems` and `maxBytes`, preferring larger eligible groups. Selection and mutation share the registration lock. A group that does not fit remains intact. Their response also includes `budget: { maxItems, maxBytes }`, with `null` for an unbounded dimension. This is an explicit capability acknowledgement. Clients that require bounded cleanup must not apply when the preflight acknowledgement is absent or different. Existing unbounded calls retain their response shape. Storage & retention uses this path for automatic plugin-cache maintenance.

Before stabilization, audit whether the response should report retained-but-unused sizes so a UI can show reclaimable space without a dry run, and whether stale `.staging`, `.promoting`, and `.corrupt` directories left by crashes should be collected too.

## Preview removal

`api.sdk.previews.experimental_remove({ previewId })` (`DELETE /previews/:previewId`) deletes a managed preview's saved launch recipe and returns `{ ok: true }`. The Dev servers shelf lists every preview a chat owns, so this is the only way to drop a recipe whose server will never run again, for example after its checkout is removed. The owning machine must be connected. The server asks it for the preview's status first and responds 409 `preview_running` while the machine reports a run in any state other than `stopped`, and 409 `preview_restarting` while a restart through this server is in flight. Removal never stops a server. A missing preview responds 404. `omnyo preview remove` uses this path.

Before stabilization, audit whether removal should also stop an owned run through a daemon command, whether recipes on a permanently offline machine need a removal route, and whether the shelf should offer Remove for a stopped server.

## RPC caller identity (`ExperimentalPluginRpcHandlerContext.experimental_caller`)

Every `api.rpc.register` handler receives a second argument, an
`ExperimentalPluginRpcHandlerContext`; `register` takes an
`ExperimentalPluginRpcHandlersWithContext` map, and a one-argument
`PluginRpcHandlers` map still assigns to it, so plugins that call their own
handlers directly keep compiling. `experimental_caller` is an
`ExperimentalPluginRpcCaller`: `{ kind: "plugin", pluginId }` when a loaded
plugin called through its own `api.sdk.plugins.callRpc`, and `{ kind: "client" }`
for every other caller (the app, the `omnyo` CLI, agents, and Omnyo itself). The
server gives each plugin load an unguessable caller token kept only in server
memory, attaches it to that load's `api.sdk.plugins.callRpc` requests in the
`x-omnyo-plugin-caller` header, and revokes it when the load is disposed or
replaced. The rpc route answers 403 for any token that is not a live load's,
so a client can't claim to be a plugin. The fake plugin host's
`harness.callRpc(method, input, { experimental_caller })` sets the caller for
tests and defaults to the client. Requires SDK 0.6.3.

Before stabilizing, audit whether other surfaces (HTTP routes, agent tools,
CLI commands) need the same identity, whether a plugin needs to know the
calling app window or thread, and whether in-process plugins that read other
plugins' memory make the token a meaningful boundary for third-party plugins.
Omnyo account relies on it to keep `/api/connect/` requests, credential reads,
refused-credential reports, and credential adoption to the connect plugin.

## RPC cancellation (`ExperimentalPluginRpcHandlerContext.experimental_signal`)

Every `api.rpc.register` handler receives an `experimental_signal` that aborts
when the HTTP request disconnects (including a `api.sdk.plugins.callRpc` caller
giving up after its five-minute timeout) or when the plugin instance that registered
the handler is reloaded, disabled or removed. Callers of a disposing instance
still waiting when the dispose drain ends are released with an error; the
handler keeps running until it observes the signal, and later use of its API
handle throws a contained stale-handle error.

Core path: the same per-instance lifetime drives CLI `ctx.signal` and the
release of disposed instances' route, RPC, CLI and event-handler callers.
Omnyo's own RPC callers (connect revoke and status, conversation bootstrap) pass
no request signal and get only the lifetime part.

Docs: `backend-sdk.md`, `backend-ui-lifecycle.md`.

Before stabilizing, audit whether HTTP route and thread event handlers need
the same signal in a typed context, and whether a deadline (not only
cancellation) belongs in the context.

## `api.http.experimental_websocket`

**What it does.** Registers an exact-path WebSocket upgrade in the plugin's
existing `/api/v1/plugins/<id>/http/` namespace. It shares HTTP route auth
modes, gives the plugin the upgrade request metadata, normalizes incoming text
and binary frames, and closes sockets from a replaced or disabled plugin
generation with code 1012. The supporting public types are
`ExperimentalPluginWebSocket`, `ExperimentalPluginWebSocketContext`,
`ExperimentalPluginWebSocketHandler`, and
`ExperimentalPluginWebSocketHandlers`; the testing harness exposes
`experimental_openWebSocket`, `ExperimentalFakeWebSocketRouteRecord`, and
`ExperimentalFakeWebSocketSession`.

**Audit before stabilizing.**

1. Confirm the HTTP namespace and exact-path rule cover plugin proxy use cases
   without a separate WebSocket namespace or parameterized routing.
2. Decide whether subprotocol negotiation belongs in the context or returned
   handler contract.
3. Confirm string and `Uint8Array` are sufficient for frame data and sends.
4. Confirm code 1012 is the right reload/disable signal and whether plugins
   need a distinct disposal reason.
5. Confirm the callback error policy should keep the socket open after an
   isolated message-handler failure.

## `api.experimental_reportError`

**What it does.** Sends an unexpected terminal plugin failure through the core
`captureProcessError` path. The shared validator requires fixed `operation` and
`code` identifiers matching `/^[A-Za-z0-9_.:-]{1,64}$/`. These identifiers are
available to local callers and test inspection; the final outbound privacy
filter does not forward arbitrary tags or fingerprints.

The optional `experimental_diagnostic` field carries only a fixed stage and
failure class, terminal outcome, retryability, bounded attempt/item counts,
an observed HTTP status and an allowlisted transport code. The server validates it before capture and passes the
same typed context used by core reporting. Unknown keys, content, invalid enums
and out-of-range numbers are rejected. The owner's reporting choice and final
scrubber apply. Explicit recovered, cancelled and deferred diagnostic outcomes
are excluded from ordinary error capture; fatal failures remain reportable.

The fake host uses the same validator and retains the optional context in
`FakeErrorReport`. Push notifications uses this path after bounded receipt-read
retries are exhausted or a permanent rejection is observed. Plugin log lines do
not automatically reach Sentry.

**Audit before stabilizing.**

1. Confirm stage and failure-class coverage across actual core and plugin callers.
2. Confirm that typed context and original safe code locations are sufficient;
   do not add unrestricted text or payload fields.
3. Decide whether the existing owner-level repeat suppression needs a shared API.

## `api.providers.experimental_contributeEnvHealth`

**What it does.** Registers one host-scoped readiness resolver beside a
provider environment contribution. When the provider bridge reports
`unauthenticated` or `expired`, the server may present the provider as ready
with the returned label and status message. Returning `null` preserves the
bridge result. The resolver is ignored unless the same plugin also contributes
environment variables to that provider. The resolver receives an
`ExperimentalPluginProviderEnvHealthContext` and returns an
`ExperimentalPluginProviderEnvHealth` or `null`.

**Audit before stabilizing.**

1. Confirm readiness should override only `unauthenticated` and `expired`, not
   installation or unknown failures.
2. Decide whether the contribution should report account identity or usage in
   addition to a label and status message.
3. Confirm the first available resolver in plugin load order is the right
   arbitration when several credential proxies target one provider.
4. Confirm a five-second timeout is appropriate for host-scoped credential
   availability checks.

## `api.providers.experimental_contributeModelNotice`

**What it does.** Registers one host-scoped resolver that returns a short
notice for a provider's model list, or `null`. The server calls it while
answering `/system/execution-options` for that provider and host, beside the
model catalog, and returns the first non-null notice in plugin load order as
`modelNotice` (`providerId`, `message`, `detail`, `until`). The model picker
shows it under the provider in All models and once in Favorites when a
favorite or the current pick uses that provider; `provider models` prints it
on stderr. Clients drop a notice once `until` has passed. The Account Pooler
uses it to say when the first OpenAI account is used up and which account
serves instead. The resolver receives an
`ExperimentalPluginProviderModelNoticeContext` and returns an
`ExperimentalPluginProviderModelNotice` or `null`.

**Core callers.** `apps/server/src/services/system/execution-options.ts`
resolves it through `resolvePluginProviderModelNotice`; the app picker and CLI
read the returned `modelNotice`.

**Audit before stabilizing.**

1. Decide whether a provider needs more than one notice line, or a severity.
2. Confirm first-non-null arbitration in plugin load order when several
   plugins describe one provider.
3. Confirm the five-second resolver timeout shared with environment
   contributions suits status reads that run on every execution-options call.
4. Decide whether notices should be cached with the model catalog instead of
   resolved per request.

## `api.providers.experimental_contributeEnv`

**What it does.** Registers one resolver per provider per plugin. The server
calls it for each matching session and turn with the thread, project, and host
ids, validates at most 32 environment entries, resolves registration conflicts
in plugin load order, and sends the winning values to the host. A value may be
a literal string or a server-relative path that the host expands against its
authenticated `OMNYO_SERVER_URL`. Contributions override the shell environment and
their values are reported as-is in provider environment events. The resolver
receives `ExperimentalPluginProviderEnvContext` and returns
`ExperimentalPluginProviderEnvEntry` values. The server also calls it with
`{ purpose: "model-list", hostId }` before it asks a host for the provider's
model list, so a routing plugin such as the Account Pooler can make the list
match the account the host's threads use; thread contexts carry
`purpose: "thread"` (absent in older callers) with the thread and project ids.

An exception, invalid result, timeout, or maintenance hold aborts command
preparation before the provider starts or resumes. No partial environment is
sent. Retry when the plugin is ready. An intentional empty array remains a
successful contribution with no entries.

**Audit before stabilizing.**

1. Confirm one resolver per provider is sufficient when plugins need multiple
   independently disposable features.
2. Confirm plugin load order is the right deterministic conflict policy.
3. Confirm the 32-entry cap and five-second timeout fit providers that resolve
   short-lived credentials.
4. Decide whether `serverPath` needs structured query parameters or non-HTTP
   server endpoints before accepting more shapes.
5. Confirm `reason` should remain required and whether event consumers need a
   stable machine-readable purpose beside it.
6. Decide whether the context and entry types should stabilize with the method
   or remain experimental for a longer compatibility window.
7. Decide whether thread contexts should require `purpose` once plugins have
   moved off the optional form.

Every public plugin API member ships with an `experimental_` prefix and an
entry here (see [AGENTS.md](../AGENTS.md), "Plugin API"). Dropping the prefix
is the deliberate stabilization step: audit the entry, rename project-wide,
and delete the entry in the same change. Entries that stay experimental after
an audit say so with the date and the open question. The first audit
(2026-08-22, the provider-plugin migration's stabilization) stabilized the
provider declaration's target-state fields and `maintenance`, tool
`presentation`, `UrlLink` / `openUrl`, `fixedTabs`, and the shared `Original`
delegation prop, and deleted the alias and status-label members; the next
omnyo-app release's CHANGELOG entry records the renames for plugin authors.
For a bridge built against 0.4.15 the renames are mechanical: on
`@omnyo/plugin-sdk/provider-bridge` the sixteen `experimental_provider*Schema`
values and their sixteen `ExperimentalProvider*` types dropped the prefix
(`experimental_providerHealthSchema` → `providerHealthSchema`,
`ExperimentalProviderHealth` → `ProviderHealth`, …), as did the
`BRIDGE_REQUEST_METHODS.experimentalProvider*` keys (the method strings on
the wire are unchanged); on `@omnyo/plugin-sdk` the tool type
`PluginAgentToolExperimentalStatusLabels` became `PluginAgentToolLabels`,
then `PluginRowLabels` in SDK 0.4.102, the type of `presentation.label`.

## Compatibility windows

- The one-release aliases and throwing stubs for names renamed or deleted in
  SDK 0.4.16 are gone: the app runtime's `experimental_UrlLink`,
  `experimental_AppNavigate.experimental_openUrl` and the `experimental_Original`
  delegation prop on the file-opener, source-code renderer and diff renderer
  props (use `UrlLink`, `openUrl` and `Original`), the throwing
  `api.agents.experimental_registerProvider` getter (use
  `api.providers.register`), and the throwing
  `experimental_toConformanceMessages` export of
  `@omnyo/plugin-sdk/provider-bridge/testing`
  (`experimental_runBridgeConformance` assembles `thread/delta` itself from
  the raw messages a transport's `takeMessages` returns and takes the
  bridge's `providerId`).
- Removed outright from a published subpath, with no alias and no throwing
  stub (an import fails to resolve): `ProviderInfo.experimental_providerHealth`
  / `experimental_providerUsage` / `experimental_providerInstallation`
  (`@omnyo/plugin-sdk/app`, properties of the `ProviderInfo` rows
  `experimental_useProviders` serves: a typed read no longer compiles and
  the served row has no such key; read `maintenance.health` /
  `maintenance.usage` / `maintenance.installation` — the server no longer
  serves the three booleans beside `maintenance`, and every client ships
  with the server, so no reader is left behind),
  `experimental_aiServiceKindSchema` and
  `ExperimentalAiServiceKind` (`@omnyo/plugin-sdk/ai-services`; the pair
  referenced only each other — the kind a service declares is
  `PluginAiServiceKind` on `PluginAiServiceDeclaration.kinds`, exported from
  `@omnyo/plugin-sdk`, and there is no schema for it), `ExperimentalAiJsonValue`
  (`@omnyo/plugin-sdk/ai-services`; none — import the domain type,
  `JsonValue` from `@omnyo/plugin-sdk/provider-bridge`), and
  `ExperimentalResolvedNativeRoot` (`@omnyo/plugin-sdk/host`; none — import
  the domain type, reachable as
  `ExperimentalNativeRootsResolveOutput["skills"][number]`), and from
  `@omnyo/plugin-sdk/provider-bridge/testing` the three kit internals no
  suite used: `experimental_ConformanceClient` and
  `experimental_checkItemOpensBeforeDelta` (none —
  `experimental_runBridgeConformance` drives the client and applies the
  opens-before-delta rule itself) and `experimental_diffCumulativeText`
  (none — the cumulative-text differ is the assembler's own). Every other
  0.4.15 name of every subpath is still exported, renamed as above or
  listed under the scheduled removals below.
- Renamed declaration, tool and navPanel fields (`experimental_strings`,
  `experimental_presentation`, `experimental_fixedTabs`, …) are rejected at
  registration with a message naming the new field, from SDK 0.4.16 on.
- Presentation-less `toolCall` rows pass through the legacy-data adapter
  (`upgradeLegacyToolItem` in `@omnyo/domain`, applied when a stored row is
  parsed): keyed on the absence of `presentation`, it reshapes
  Read/Grep/Glob and read/grep/find/ls by name into `fileRead`/`search`
  items and suppresses the Task*/Todo*/ToolSearch bookkeeping calls,
  exactly as the deleted tool-name tables rendered them. Persisted pre-v3
  history is its purpose, but the pi bridge's generic `tool` rows carry no
  presentation yet, so its live read/grep/find/ls calls take the same path
  and render as exploration rows (path or query, no output) like Claude's.
  Closing the window: pi stamps `fileRead`/`search` presentation so no live
  row reaches the adapter, then the `legacy-tool-item-backfill` migration
  stamps the old rows, `presentation` becomes required on
  `item.open`/`item.close`, and the adapter and its tests go together.

## Scheduled removals (next major)

Unprefixed exports of `@omnyo/plugin-sdk/provider-bridge` that no longer
have a consumer in this repository. They are kept on the facade because a
third-party bridge compiled against an SDK before 0.4.16 may import them;
dropping a published name is a breaking change. The first eleven are
re-exported from `@omnyo/domain`, where each still has core consumers:

- `acpNativeReasoningSchema`
- `acpPermissionCliSchema`
- `acpReasoningCliSchema`
- `extensionKindSchema`
- `interactionRequestPayloadSchema`
- `isExtensionKind`
- `isUserQuestionPendingInteractionPayload`
- `isUserQuestionPendingInteractionResolution`
- `providerRecoveryKindValues`
- `threadEventItemPresentationSchema`
- `threadEventSearchModeSchema`

The next four are aliases of definitions that moved when the host-daemon
wire lost the typed ACP launch spec (protocol 155) and the claude-code
runtime became a plugin: the ACP pair aliases the ACP kit's
`experimental_acpLaunchSpecSchema` / `AcpLaunchSpec`
(`@omnyo/plugin-sdk/provider-bridge/acp`, where a plugin that declares an
ACP agent should read it) and the kit's normalizer; the task-tool pair is a
copy kept in the SDK of what core used to share with the claude-code
runtime, with no replacement. The type aliases `HostDaemonAcpLaunchSpec`
and `ClaudeTaskToolOutput` go with them.

- `hostDaemonAcpLaunchSpecSchema`
- `normalizeHostDaemonAcpLaunchSpec`
- `claudeTaskToolNameSchema`
- `claudeTaskToolOutputSchema`
- `HostDaemonAcpLaunchSpec`
- `ClaudeTaskToolOutput`

All fifteen values and both types: unreferenced by any first-party plugin;
kept because 0.4.x published them; remove at the next major version. The
`provider-bridge-scheduled-removals` SDK test holds the facade to this list.

`AcpAgentProfile` on `@omnyo/plugin-sdk/provider-bridge/acp` is a deprecated
alias of `AcpLaunchSpec` for the same reason. The bridge used to derive a
profile from the parsed launch spec (`providerId`, `agentCommand: { command,
args }`, an `env` dropped when empty) and read only the spec's own fields
from it, so the profile type went with the derivation; the published name
stays until the next major version.

`CONFORMANCE_ASSEMBLED_EVENT_METHOD` (`@omnyo/plugin-sdk/provider-bridge/testing`)
is retired the same way: the conformance kit assembles `thread/delta` itself
and reads nothing under that method, so the constant names a lane that no
longer exists. Kept because 0.4.x published it; remove at the next major
version.

The `disallowedTools` field of the session-construction params
(`threadStartParamsSchema`, `threadResumeParamsSchema` and
`threadForkParamsSchema` on `@omnyo/plugin-sdk/provider-bridge`) is retired
the same way: the runtime never populates it, because the server stopped
producing tool removals when the subagent and workflow toggles moved to
`providerOptions`. Kept because 0.4.x published it; remove at the next major
version.

`experimental_useSidebarThreadActions` and `PluginSidebarThreadActions`
(`@omnyo/plugin-sdk/app`) are superseded by the thread action registry
(`app.slots.experimental_threadAction`, `experimental_useThreadActions`, the
thread action components), `useSdk().threads`, and
`experimental_useAppNavigate().toThread` / `toCompose`. Like `useComposerView`, they and the
testing harness's `SidebarActionCall` / `inspection.sidebarActionCalls` are
tagged `@internal`: `stripInternal` removes them from the published
declarations, so a plugin that upgrades its SDK gets type errors, while the
runtime keeps exporting and implementing the hook, so installed plugins and
host builds of plugins that still import it keep working. The frontend export
parity test lists it as a runtime-only export; nothing in this repository
calls it (the runtime test in `PluginAppOverlays.test.tsx` only checks it
still resolves). Its `experimental_archiveEnvironmentThreads` moved to
`experimental_useArchiveEnvironmentThreads`. Remove at the next major version.

## Settings schemas and server writes

**What it does.** A `PluginSettingDescriptor` can declare an
`experimental_schema` Standard Schema validator that runs on the server for
every proposed value; Zod schemas qualify. Settings schemas must validate
synchronously without transforming their primitive value. The generated form
autosaves one field at a time and displays the first validation issue beneath
that field. A `PluginSettingsHandle` can call `experimental_set` to validate
and persist its own fields, receive the effective values, fire `onChange`, and
notify settings consumers just like a settings route or `omnyo plugin config`
write.

**Audit before stabilizing.**

- Confirm synchronous, non-transforming validation remains sufficient.
- Decide whether settings errors need structured issue paths in addition to
  the first user-facing message.
- Confirm schemas should continue running for defaults at registration.
- Exercise concurrent route, CLI, and plugin-owned writes, including secret
  values and unsets, before stabilizing `experimental_set`.
- Decide whether schemas and server-side writes stabilize independently.

## `PluginSettingDescriptor` type `"number"`

**What it does.** A numeric setting descriptor gives server code, provider
configuration, and plugin UI a finite `number` instead of making each consumer
parse a string. The host renders a number input and converts CLI values before
validation. `experimental_schema` can enforce integer and range constraints.
Stored numeric strings from settings created before this descriptor existed
are read as numbers so migrated plugins preserve their configuration.

**Audit before stabilizing.**

- Decide whether common minimum, maximum, and step metadata belongs directly
  on the descriptor instead of only in `experimental_schema`.
- Confirm clearing a number input should continue to unset the stored value.
- Decide how long legacy stored numeric strings should be coerced on read.
- Exercise decimal and exponent input across browser engines and the CLI.

## `api.experimental_hooks` (`on`, `recheck`)

**What it does.** The one plugin surface that _decides_ rather than observes.
`api.experimental_hooks.on(hook, handler)` registers this plugin's answer to a
hook — a question core stops to ask and then acts on the answer to. Its
counterpart is `api.events.on`, whose handlers are told what already happened
and whose return value is ignored; the split is the one git draws between
pre-commit and post-commit hooks, and it is why the two are separate
namespaces rather than one `on`.

One hook today. `"message.dispatch"` is THE admission checkpoint: it runs
before every message reaches a provider — a thread's first message, a
follow-up, a steer, a drained queue row, a retry of a failed turn — and it runs
identically for all of them. The handler receives a typed context (project,
environment/host, `environmentIntent` as a
`PluginDispatchEnvironmentIntent | null`, prompt blocks plus a plain-text view,
the resolved execution tuple with per-field provenance, origin/parent
provenance, the author summary as `initiator` plus `senderThreadId`, the
target thread, whether the attempt would `start-turn` or `join-turn`, and all
queued rows in `queuedMessages` when the attempt is a re-attempt) and answers
`proceed`, `wait` (queue the message as a row with a reason and an optional
`sendAt`), or `reject` (a synchronous 409 carrying the plugin's message). A
handler cannot rewrite the dispatch it is deciding about: there is no amendment
arm.

Handlers run as a deterministic chain in plugin install order, `reject`
short-circuits, `wait` decisions collect across a full pass, and the FIRST
waiter owns the row while the rest have their reasons appended to it. The whole
pass runs under a single server-wide async lock. A handler that throws or
exceeds a 10s decision box fails the attempt with the plugin named
(fail-closed, the `deriveProviderOptions` precedent).

`api.experimental_hooks.recheck("message.dispatch")` is the second member and the pair to
`on`: `on` answers the question core asks, `recheck` asks core to ask it
again. It schedules a walk that re-attempts every plugin-queued row in queue
order — claim-CAS exactly-once, full hook pass per row, still-blocked rows
re-queue, the per-thread re-queue pacing bounding the churn — and bursts
coalesce into one walk. It resolves when the walk is SCHEDULED, not when it
finishes: the walk has no caller to report to (a failed re-attempt lands on its
row, like the due sweep's), and resolving on completion would mean awaiting a
full hook pass from inside whatever asked, which for a handler holding the
evaluation lock could never complete.

The split it draws: **core owns the re-draining and the clock; plugins own
every other wait condition and tell core when to re-ask.** Core's own wakes are
the `sendAt` due sweep, thread-idle, workspace-ready, interaction-settled,
send-now and the orphan sweep — all of them queue mechanics or core waits.
Capacity is not one of them: `concurrency-limit` subscribes to
`thread.idle`/`thread.failed`/`thread.archived`/`thread.deleted` and calls
`recheck("message.dispatch")` itself. That retires the future `clearWait` need for
external-event waits: a plugin does not release a row, it wakes core and core
re-asks, so a wake that was not warranted is safe by construction.

A plugin's wait therefore clears when the row's `sendAt` comes due, when some
plugin requests a drain and this handler now proceeds, when the user sends it
now, or when the orphan sweep clears a wait whose plugin is no longer running.

**Audit before stabilizing.**

- **Grouped dispatch authors.** `queuedMessages` includes all claimed rows in
  dispatch order, with each row's content, author, origin, and originPluginId; inline attempts use an
  empty array. `initiator` summarizes their category, with hook-local `mixed`
  when categories differ. `senderThreadId` is the shared sender ID, null when no message has a sender,
  or `mixed` when they disagree.
  Queue serialization resolves thread-start requesters and retries with the
  same author rule as inline dispatches. Grouping and recorded turn initiators
  are unchanged. `origin` and `originPluginId` each summarize their shared
  value or `mixed` when rows disagree, including a value versus null. Before
  stabilization, verify plugins handle mixed origins independently of authors.
- **`queuedMessage` is emitted but untyped.** The public context uses
  `queuedMessages`; core still emits its first row or null under the old name
  for previously built handlers. Remove that compatibility field and the
  corresponding shim before stabilizing.
- **`startedOnBehalfOf` is emitted but untyped.** It left
  `MessageDispatchHookContext` when `initiator`/`senderThreadId` arrived: it
  described why a THREAD was started, never who sent the message being decided
  about. Core still sets it on the context object so a handler built against an
  older SDK keeps working. Drop the context field before stabilizing, and with
  it the shim in `dispatch-hooks.ts`. The queued row's `requested_by_initiator`
  and `requested_by_thread_id` are unaffected: they record the requester a
  thread-start's author is resolved from, which is internal state rather than a
  plugin-facing field.
- **One hook is not a shape.** The registry, the map and the `on(hook, handler)`
  signature are all built for several hooks, and there is one. Confirm the
  second hook fits the shape before stabilizing it — or collapse the argument.
- **`wait` returns no row id.** A handler returns a reason; the id arrives later
  on `message.queued`. Every plugin that must act on its own wait therefore
  correlates by ordering or re-queries `threads.queue.list({ waitHolder })`.
  Decide whether the decision should be able to name a correlation key.
- **A wait has no plugin-driven release, only a plugin-driven re-ask.**
  `recheck("message.dispatch")` names no row, so a plugin whose one condition resolved wakes
  every plugin-queued row in the server and every handler re-decides. That is
  what makes an unwarranted wake safe, and it is also its cost. Confirm the
  whole-queue walk is still right when there are many plugin waits and many
  waiters, and decide then whether a scoped variant is worth the correlation
  problem it reintroduces (see the row-id bullet above).
- **`recheck("message.dispatch")` is unauthenticated in both directions.** Any plugin can
  wake rows held by any other, and core does not tell a handler why it is being
  re-asked. Both are deliberate — a wait is a decision, not a lease — but
  confirm before stabilizing that no plugin needs to distinguish "core's clock"
  from "somebody asked".
- **Resolving on schedule is a contract, not an implementation detail.** A
  caller cannot await the walk, so it cannot observe whether its own row went.
  Confirm the alternative (resolve on completion, with the lock-reentrancy
  hazard) is genuinely unwanted rather than merely unbuilt.
- **A handler's `sendAt` and a user's `--send-at` are the same column.** A
  plugin wait with a `sendAt` sets the row's `sendAt`, which is also what
  `--send-at` sets. Confirm nothing renders a plugin's instant as a user's
  schedule.
- **Send-now bypasses EVERY plugin check.** A user's "Send now" skips the pass
  entirely, so a content-policy `reject` is skipped with it. That is a
  deliberate loosening of the old skip-owner-only rule; confirm it before
  stabilizing, or split `wait` bypass from `reject` bypass.
- **"Never started" is now a thread status, not an event-log fact.** That
  replaced a `getLastProviderThreadId(...) === null` probe on a hot-ish path.
  Confirm `pending` is maintained everywhere that probe used to be consulted.
- **The context DTOs.** `thread`, `project`, `environment`, `host` and
  `queuedMessage` are public DTOs; confirm they are what a plugin should couple
  to.
- **The single server-wide lock.** One slow handler delays every dispatch in the
  server, up to its box.

## `interaction.pending` (`api.events.on`)

**What it does.** This announcement fires after core commits a pending
interaction row. It carries the public thread and pending interaction DTOs.
Plugins can react without delaying or changing the interaction.

**Audit before stabilizing.** Confirm that all plugins should receive provider
and plugin interaction details. Confirm that the full interaction DTO remains
the correct payload instead of an id that requires a fresh SDK read. Decide
whether this event needs matching resolved, cancelled, or interrupted events.

## `message.queued` / `message.dispatched` / `message.cancelled` / `turn.failed` (`api.events.on`)

**What it does.** Four announcements on the observe-only `api.events.on`
registry.

`message.queued` and `message.dispatched` each carry the `ThreadQueuedMessage`
DTO that `GET /threads/:id/queued-messages` serves. `message.queued` fires when
a row's wait is rewritten as well as when the row is first queued, because a row
that moved from one wait to another is news to whoever was waiting on the old
one.

`turn.failed` fires after a turn failed and the thread has landed in `error`. It
carries ids and failure facts only — `threadId`, the failed turn's `requestId`,
the provider `turnId`, the provider's `ProviderErrorInfo`, the latest
`ProviderRateLimitState` and `attemptNumber` — and no thread DTO or copy of the
message, because a retry is asked for by reference with
`api.sdk.threads.retry({ threadId, turnRequestId, sendAt })` and anything else is
one `threads.get` away and fresher for being read when it is used. It is an
announcement, not a question: the failure stands as core applied it, a handler's
return value is ignored, and a handler that throws is isolated like any other
event handler. A broken retry plugin can therefore cost a retry; it can never
make failures unrecoverable.

**Audit before stabilizing.** These are still the only non-thread events on
`api.events.on`, so the interface is called `PluginThreadEventPayloads` and its
handler type `PluginThreadEventHandler`; renaming both project-wide is part of
stabilizing. Decide whether every plugin should see every queued row (it does
today, and filtering on `entry.waitingOn` is the documented pattern) or whether
a plugin should only see the rows whose wait it owns. Decide too whether
`message.queued` firing on every rewritten wait is what a listener wants, or
whether a separate `message.updated` belongs alongside it — the timeline event
already distinguishes the two. `message.cancelled` fires when a queued row is
deleted before it dispatched (the queued card's Delete, `omnyo thread queue`);
rows that vanish with their thread fire the thread event instead. Confirm
that split is the teardown signal a plugin holding resources for a waiting
message needs before this is stable. For `turn.failed`, confirm the payload answers every
question a retry policy asks without replaying the event log, and note that
attempt caps are entirely the plugin's: core enforces no ceiling on retry chains
beyond one live retry row per original request.

## `api.experimental_environments` (`register`, `recheck`)

**What it does.** Lets a plugin register a named place where threads can run.
Provider ids are flat across plugins, and the first live registration wins.
Launches and environments persist the creating plugin ID; a different plugin
registering the same provider ID cannot recover or remove its resources.
Migration assigns the three bundled owners explicitly and leaves unknown
historical owners unassigned, preventing automatic adoption.

Concrete providers and compositions require a nonblank description (up to 200 characters) and icon, alongside their display name. The provider listing exposes both; creation choices show the description unless setup or availability guidance takes precedence. Icons remain required when a frontend slot supplies an override.

A declaration has four eligibility facts in `requires` (`projectCheckout`,
`gitCheckout`, `gitRemote`, `projectless`), all defaulted to
false at registration. Optional `inputs` uses Standard Schema v1; core parses it
at thread creation and persists the parsed JSON value. Optional `validate`
runs once after core eligibility checks and can accept or refuse before a thread
is created. An unresolved intent recovered after provider registration validates
once when resolved. Host-dependent preflight requires connectivity; creation
must still check mutable conditions and report resource-operation failures.

Core invokes `create` and `remove` and records results directly. Policy drives
cancellation and retirement; core fixes removal retries at 60 seconds and
terminal creation failures; explicit retries start a new attempt on the same row. Policy exposes
only retirement grace and path-key strategy; creation has no overall core
timeout. Providers return resource-operation
results. Created directories include explicit ownsPath. The core lifecycle
table owns attempt identity and private resources. Core admits and claims the
returned path before lifecycle hooks and uses that path for execution.
Rejected foreign paths are never passed to lifecycle hooks or provider removal.
Hook execution is deduplicated in daemon memory using launch/environment IDs;
there is no separate persisted hook ledger or process reconciliation. Recovery
with unknown daemon hook state blocks automatic cleanup and requires inspection.
Cleanup permits four operations globally and one per host. Progress remains
durable before reporting returns, but wakes only its launch without invalidating
configuration. recheck schedules another pending launch attempt.

Provider selections are accepted by the SDK, CLI, app, and automations. The
built-in checkout, worktree, and personal workspace behaviors are first-party
plugins; legacy workspace request shapes are compatibility sugar resolved to
those providers at the server boundary.

**Audit before stabilizing.**

1. **Requirement vocabulary.** `requires` has four booleans, each a fact core
   evaluates before the thread exists (an availability rule plus a context
   field); everything else a provider wants from the request goes through
   `inputs`. Decide whether the next fact fits that shape — and whether
   `gitCheckout` should carry more than "a git repository with commits" —
   before it is frozen.
   1a. **Inputs at the boundary.** The schema is plugin code core runs inside the
   request: a slow or throwing schema costs the request, not the thread, and
   the JSON Schema conversion happens once at registration and may fail load.
   Decide whether core should bound the parse, and whether the row should
   store the raw request value alongside the parsed one so a schema change
   can re-parse it.
2. **Single-provider invocation.** Confirm asking the one named provider (vs.
   the `message.dispatch` chain) stays the right model once several
   provider plugins ship, and that the "not registered" wait + backoff is
   the right degradation for an uninstalled plugin.
3. **Undeclared facts: `suggestedBranchName` and `projectCheckout`.** Core
   hands every create a branch name built from the thread's title and the
   `managedBranchPrefix` setting, whether or not the provider makes a branch,
   and hands every provider the project's checkout on its machine,
   whether or not it reads it. Decide whether both belong on the context for
   everyone or behind a declaration flag — and, for `projectCheckout`,
   whether a path is the whole of what a provider needs to know about a
   checkout it did not make.
4. **Durable operations.** Core replaces the former decision contract with
   `create`/`remove` operations. Audit cancellation races, provider
   reload during work, and restart checkpoints against the environment-provider
   contract below. Core generates the instance key from the launch path key;
   it transfers resources directly, without adoption queries.
5. **Compatibility fields.** Retain deprecated managed, isWorktree,
   workspaceProvisionType and display-kind fields for the agreed cycle.
   Ownership is provider-neutral; managed derives from ownsPath, while
   isWorktree comes from git inspection. EnvironmentStatus does not restore
   retiring/destroying; lifecycle is a separate read-only view.

## `@omnyo/plugin-sdk/environment-provider`

**What it does.** Exports the resource-operation contract for
`api.experimental_environments.register`. The SDK controller is removed.
Core persists launch attempts, progress, cancellation, direct resource
attachment, retirement deadlines and teardown state in SQLite. Providers supply
idempotent long-running create and remove calls plus policy. Values retain their
experimental\_ prefix; public types follow the existing declaration convention.
The optional `availability(context)` method answers whether the provider is
available, needs setup, or is unavailable for a project and machine. Core
invokes it in the background for each connected persistent machine when a
project's providers are listed, caches the answer per project and machine for
ten minutes or until the plugin rechecks, and reports it through
`machineAvailability` so pickers can hide unsupported machines without waiting;
listing never blocks on the answer. Core invokes it again for the selected
provider and machine during thread creation. Its context contains project,
host, projectCheckout, and gitRemote; its named types intentionally have no
experimental prefix.
The optional `restore(context)` method, unprefixed like `availability` because
the whole registration is experimental, is the only way core
rebuilds a destroyed environment, and runs only when a user restores an
unarchived, settled thread (`POST /threads/:id/restore-environment`,
`omnyo thread restore-environment`). Its context carries the creation inputs and
`previous: { environment, resource }` for the removed environment; the provider
decides what restoring means. Git worktree re-creates the worktree on the
recorded branch, project checkout switches back to the recorded branch, and
personal workspace does not restore. Without the method, the thread reports
`canRestoreEnvironment: false` and sends fail with
`thread_environment_unavailable`. `create` no longer receives `rebuild` or
`previous` in its type; core still passes `rebuild: false` and
`previous: null` at runtime for plugins built against the older contract.

**Audit before stabilizing.** Verify monotonic attempts and path-key recovery
across cancellation/restart; per-environment
removal serialization; retry caps and timing defaults; resource privacy and the
16 KiB boundary; create-timeout aborts; and the read-only lifecycle projection.
The pathKey gives create and remove stable resource identity. Confirm these
extensions before stabilizing. Restores receive previous.environment and
previous.resource, null after completed removal; decide whether restore should
stay a separate method or become a create mode, whether a provider needs a way
to decline before the button is offered (git worktree currently fails after
the click when no branch was recorded), and when to stop passing the retired
`rebuild`/`previous` create fields. The six policy defaults are 5 minutes/60 seconds/30 seconds/3/
per-thread/null; nullable retirement and create timeout disable those policies.
EnvironmentStatus remains provisioning/ready/error/destroyed;
retiring and teardown are lifecycle phases, not restored statuses.
Audit availability message ownership, create-time error presentation, the
interaction between the `requires` floor and provider decisions, and whether
the current decision timeout is appropriate before stabilizing it.

## `app.slots.experimental_environmentProviderInputs`, `experimental_BranchPicker`, `experimental_useBranches` and `experimental_useCheckoutState` (`@omnyo/plugin-sdk/app`)

**What it does.** The picker-side half of environment providers. The slot
registers the control rendered for this plugin's selected provider: at the end
of the environment row on the new chat screen and in plugin composer footers
(`{ environmentProviderId, component }`; props
`{ projectId, target, value, onChange }` over the selection's `inputs` JSON
value. `target` is `{ kind: "existing-host", hostId: string }` for a selected host
or `{ kind: "new-host" }` before machine provisioning. This replaces the nullable
`hostId` prop; backend create still receives the provisioned host.
`onChange({ status: "ready", value })` supplies valid inputs and
`onChange({ status: "blocked", reason })` blocks submit with the plugin's reason).
It is mounted only for a provider that declared `inputs`. A provider whose
schema accepts empty input can be submitted without a registered slot; any
other provider with `inputs` remains disabled until its plugin registers the
control and the control produces a value. Core renders no control for provider
inputs of its own; the server parses whatever the control produced with the
provider's schema at create time, so the control only has to emit a value the
schema accepts. Inputs are persisted and readable by every plugin, so they
must contain no secrets; credentials belong in plugin settings and inputs
carry non-secret references. `experimental_BranchPicker` is the host's branch
picker with its branch-options loading (`{ hostId, projectId, value, onChange,
label?, placeholder?, disabled }` — `label` prefixes the branch on the trigger
and supplies the menu heading; omitted means the branch alone on the trigger
and a neutral "Branches" menu heading; `placeholder` supplies the complete
empty-selection text, defaulting to "Select branch"). A null selection does
not resolve or imply a worktree base. The caller owns what picking a branch
means. The component retains the same additive-versioning exception as
`experimental_ProviderModelPicker`. `experimental_useBranches({ hostId,
projectId, query? })` returns the matching local and remote branch lists,
loading state, and a `refresh()` operation
that performs a blocking remote refresh. `query` is debounced before the host
request, so a control can pass every keystroke; the previous results remain
available while the next request settles, and filtering them stays the
caller's job. `experimental_BranchPicker` is built
on this hook.
`experimental_useCheckoutState({ hostId, projectId })` exposes the checkout's
git, unborn, detached, dirty, current-branch, and operation facts. The checkout
plugin combines the two hooks into its own chip, menu, search, and branch list,
and owns the existing/new selection, labels, blocker copy, and emitted inputs.

**Audit before stabilizing.**

1. **Slot placement.** The control renders where the branch picker sits
   today. Confirm that stays the right place for providers with larger
   configuration (a dialog escape hatch?) before freezing.
2. **Validity channel.** Confirm ready/blocked remains sufficient and decide
   whether the picker should run the published JSON Schema client-side before
   submit.
3. **Branch API breadth.** Confirm the picker props and branch-hook result stay
   sufficient for providers. The host owns branch loading, search, and remote
   refresh, while checkout selection models and mutation behavior stay with
   the plugin.
4. **Missing slot.** A provider whose schema requires non-empty input and whose
   app entry registers no slot cannot be picked from the app (the CLI can still
   send `--environment-inputs`). Decide whether load should refuse that pairing.
5. **Mount-time default.** A control that wants the row submittable at once
   has to report ready from an effect on mount, as the worktree does.
   Decide whether the registration should instead declare a default value.

## `experimental_useThreadGit` and `experimental_ThreadMergeBasePicker` (`@omnyo/plugin-sdk/app`)

Supporting app types are `ExperimentalThreadGit`,
`ExperimentalThreadGitChanges`, `ExperimentalThreadGitFile`,
`ExperimentalThreadGitComparison`, `ExperimentalThreadGitCommit`,
`ExperimentalThreadGitPullRequestActions`, `ExperimentalThreadGitMergeMethod`,
`ExperimentalThreadGitFileSource` and `ExperimentalThreadMergeBasePickerProps`.

**What it does.** `experimental_useThreadGit()` returns the git state of the
thread that hosts the calling component, such as a thread header action. It
returns null outside a thread, when the thread has no git workspace, when the
thread or its environment is archived or unavailable, when the workspace
status lookup fails, or when the owner turned off Settings → General → Show
Git status. While the first status lookup runs it returns
`{ status: "loading" }`. When ready it carries the branch, default branch,
working tree changes (untracked `??` files included), the comparison with the
merge base branch (ahead and behind counts, ahead commits newest first, and
committed changes), the branch's pull request, and the host's actions.
`pullRequestActions` offers `markReady` for a draft, `merge` for an open
mergeable pull request, and `convertToDraft` for an open pull request; it is
null when none applies. `commit` is null when nothing can be committed.
`openFile({ path, source })` opens a changed file the way core's change lists
do: a preview for an added or untracked file, a deleted-file preview, or the
diff tab for a tracked change. An unknown path still opens the diff tab.
`openDiffPanel()` opens the right panel's diff tab.
`experimental_ThreadMergeBasePicker` renders core's merge base `BranchPicker`
with the thread's branch loading and search, or nothing when no merge base
applies; `align` defaults to `"end"`.

**Core callers.** Omnyo's thread header shows git status only through the bundled
Git plugin (`omnyo--git`), which reads this hook. Commit, pull request, file-open
and diff-panel actions run core's own handlers in `ThreadDetailView`: the same
`ThreadGitActionDialog` and commit queue, the same pull request environment
actions and toasts, the same changed-file open path as the Info tab, and the
same diff tab destination as the `diff.toggle` command. The merge base picker
is core's `BranchPicker` with `getMergeBaseBranchCandidateGroups`, the control
the Info tab uses.

**Audit before stabilizing.**

1. **Scope.** The hook reads only the hosting thread. Decide whether plugins
   outside a thread, such as a sidebar row, need an argument-based variant.
2. **Action breadth.** Push, pull, branch switch and pull request creation are
   absent. Decide which belong here before freezing the shape.
3. **Large changes.** `files` can be shorter than `fileCount`. Confirm callers
   handle a capped list and whether paging is needed.
4. **Refresh.** The status follows core's query invalidation. Decide whether
   plugins need an explicit refresh.

## `app.slots.experimental_machineProviderInputs` (`@omnyo/plugin-sdk/app`)

Supporting app exports are `PluginMachineProviderInputsRegistration`,
`PluginMachineProviderInputsProps`, and `PluginMachineProviderInputsChange`.

**What it does.** Registers the compact app control for one machine provider's
inputs with `{ machineProviderId, component }`. The component receives
`{ value, onChange }` and reports ready JSON or a blocked reason. It renders in
the New Thread toolbar when a selected environment composition declares machine
inputs. A control reports its
default ready value on mount and loads richer choices only after its shared
responsive drawer opens. The resulting value is persisted and readable by
every plugin, so it must contain no secrets; credentials belong in plugin
settings and the value carries only non-secret configuration or references.

**Audit before stabilizing.** Confirm the compact-chip and responsive-drawer
shape works across machine providers, that ready/blocked is sufficient, and
that provider changes and crashed controls cannot retain stale launch inputs.

## `api.experimental_machines` (`register`)

Registers project-independent machine providers with required id, displayName,
description and icon; optional ephemeral policy, Standard Schema inputs,
availability and validate; required create, reconcileCleanup and remove; and optional paired
suspend/resume callbacks. Core validates descriptions/icons and parses inputs
at registration/creation boundaries. Inputs and resource JSON must not contain
credentials. Resource records are bounded to 16 KiB. `PluginMachineProviderResource` excludes
top-level null; null in storage means no checkpoint exists.

Core owns enrollment, durable launches, cleanup retries and coordinated lifecycle
transitions. Plugins own allocation, filesystem preservation and idle policy.
Each `bootstrap` call revokes any pending credential and issues a fresh one for
the same durable host identity.
Create returns a readable machine name and opaque resource. Create failures are
terminal; providers retry vendor API hiccups inside create.
Create awaits checkpoint before bootstrap. Suspend and
resume also await checkpoint before destructive cleanup/bootstrap. All three
checkpoint signatures return Promise<void>; a rejected checkpoint stops the
provider's subsequent work.

`getResource(hostId)` reads persisted resource metadata across plugins; it does
not perform vendor observation. The containing namespace is experimental, so
getResource does not repeat that prefix.

Core clones a project's remote only when the concrete environment provider
requires a checkout and that host has none. Machine-only registration does not
create an environment picker row; explicit composition supplies that behavior.

Before stabilization, verify registration validation, creation-key ownership,
interrupted allocation cleanup, checkpoint rejection, resource privacy, removal
serialization and same-identity restoration. Machine lifecycle uses removing;
removal retry timing is internal, not a public retirement policy.

## `@omnyo/plugin-sdk/machine-provider`

Exports provider definitions, input schemas, availability/validation results,
create and lifecycle contexts, progress and resource/removal results.
Create receives inputs/key/attempt/checkpoint/report/signal and no project.
ReconcileCleanup receives the durable key and discovers/removes allocations
when no checkpoint exists; remove receives known resources. Suspend and resume share the lifecycle
context and must be registered together. Description and icon are required.

Supporting declarations belong to the experimental machine namespace.
Stabilization follows the registration audit above.

## `omnyo.branding.experimental_icons` (manifest) and namespaced presentation glyphs

**What it does.** A plugin ships SVG files and declares a name → file map in
its `package.json` manifest: `"omnyo": { "branding": { "experimental_icons": {
"receipt": "./icons/receipt.svg" } } }`. Timeline row presentation
(`presentation.icon.glyph`, including `api.agents.registerTool` presentation)
and provider branding (`api.providers.register({ icon })`) may then reference
an entry by the namespaced glyph `"<pluginId>/<name>"`. The server validates
the map at build and at load (name grammar, `./` path ending in `.svg` inside
the plugin root, 32 KiB per file, 64 entries, a reject-only SVG validator that
refuses a doctype or processing instruction, `script`, `handler`, `listener`,
`iframe`, `foreignObject`, `image`, `video`, `audio`, `a` and `style`
elements, any element outside the SVG namespace, `on*` attributes, any
`href`/`xlink:href` that is not a same-document `#` reference, any attribute
value carrying a CSS escape or an external `url()`/`src()`/`image()`/
`image-set()`, a SMIL `attributeName` naming an `on*` handler or an `href`,
and `xml:base`), serves the bytes from the installed plugin directory at
`/api/v1/plugins/<id>/assets/icons/<name>.svg?h=<hash>` with immutable
caching, and rejects at ingest (`provider/unhandled`, reason naming the glyph)
a namespaced glyph that is not the emitting plugin's own declared icon. The
emitting plugin is the thread's provider plugin, except for a `server: "omnyo"`
tool row: the bridge stamps the presentation the server resolved from the
plugin that registered the tool, so that row's glyph is checked against the
tool's plugin (it passes when the tool is still registered by the plugin the
glyph names with exactly that icon). Web
and mobile resolve the glyph against the plugin inventory (`icons` on the
installed-plugin shape) and draw the SVG tinted with `currentColor`; if the
plugin is gone or the name unknown at render time the per-kind fallback glyph
renders. The conformance kit's `presentation/icon-namespaced-declared` rule
(fixture `icons: { pluginId, names }`) catches a bad glyph before a bridge
ships.

`omnyo.branding.icon` refuses the namespaced form outright (the manifest
schema fails the build and the load, naming the value): it is the plugin's
own mark, read by every client as a host glyph name or a hashed compact-SVG
URL, so a self-reference would only restate a path already in the map while
every tool without a `presentation.icon` inherited a glyph ingest rejects.

**Audit before stabilizing.** Decide whether the key is `icons` outright
(the strict manifest schema makes the rename breaking, so the stabilization
release must accept both for one release). Decide whether `omnyo.branding.icon`
should instead resolve a self-referencing namespaced glyph through the map
(the refusal is the smaller, reversible choice). The SVG rules are three.
A declared icon passes the strict set above at build and at load.
`omnyo.branding.icon` (and a marketplace catalog icon) passes the
document-shape check it always had — UTF-8, no doctype or processing
instruction, well-formed XML, an `<svg>` root — at build and at load. An SVG
`omnyo.branding.logo.light`/`.dark` is checked at `omnyo plugin build` only, and
only for script vectors: a `script`, `handler` or `listener` element in any
namespace, an `on*` attribute, or an `href`/`xlink:href` whose scheme is
`javascript:`. Nothing else, so an Illustrator `<!DOCTYPE svg PUBLIC …>`,
`<switch><foreignObject requiredExtensions=…>` and `<metadata><sfw …>`,
Inkscape `<sodipodi:namedview>` and `<rdf:RDF>`, an `<image
href="data:…">`, an `<a>`-wrapped logo and Latin-1 bytes all build. Install
and load never refuse a logo or a path-shaped provider icon: the manifest
reader, the served snapshot and the `api.providers.register` call take the
bytes as declared, so no installed plugin's tool-export artwork fails its
load (a provider icon is named only in code, so `omnyo plugin build` cannot
reach it either). What keeps every such document inert is the response: the
branding route (`/plugins/:id/assets/{icon,logo,logo-dark}`), the
declared-icon route and the provider logo route
(`/system/providers/:id/logo`) all carry `x-content-type-options: nosniff`
and `content-security-policy: default-src 'none'; style-src
'unsafe-inline'`, under which no script, handler, `javascript:` URL or
external load runs when the file is opened directly. **Open question for a
major release:** whether to tighten logos and provider icons at install and
load (to the build rules, or to the full declared-icon rules). Either fails
installed plugins whose artwork is an ordinary tool export, so it needs an
audit of installed marketplace and third-party logos and a migration window
first.
Decide whether a full-colour mode (`{ path, mode }`
values) is wanted; today every value is a string and every icon is a
monochrome mask. Decide whether `toolUse` approval presentations are checked
at ingest too (today only timeline rows are; approvals are ephemeral and both
clients fall back). Settle whether a row persisted with a namespaced glyph
should ever be rewritten when the plugin renames or removes the icon; today
rows are never rewritten and simply fall back.

## `experimental_buildBridgeToolCallContent`

**Kept experimental (2026-08-22).** it still accepts two input shapes (ordered `contentBlocks` and the legacy aggregate `{ content, images }`) though every first-party caller now passes the ordered form, and no image MIME/size policy exists at the server boundary; drop the legacy input and settle the policy, then stabilize.

**What it does.** Converts a decoded Omnyo tool-call response into the ordered
text and inline-image content blocks accepted by MCP and Pi tool result
contracts. It preserves a legacy aggregate text/images input while first-party
bridges migrate to ordered `contentBlocks`.

**Audit before stabilizing.** Confirm that MCP and Pi continue sharing this
content-block vocabulary; decide whether legacy aggregate fields still need to
be accepted; and define any image MIME validation, decoding, or payload-size
policy at the server boundary before making the helper stable.

## Workflow model contract v1

`experimental_workflowModelV1` from `@omnyo/plugin-sdk/workflow-model` provides
strict input, result, capability and failure schemas plus the
`workflowModelCapabilities` and `workflowModelComplete` RPC contract. The schema
limits remain 128 KiB of UTF-8 prompt text, 64 KiB of output and a 60-second
deadline. Inferred `ExperimentalWorkflowModelV1*` types describe these schemas.

Provider caller authorization, included-subscription eligibility, pool routing
and host execution remain local to each plugin. Account Pooler extends the base
input schema with its provider and route fields and validates both RPC boundaries.
This subpath is for Node server and host entries; it is not a frontend export.

## Provider usage source v1

`experimental_providerUsageSourceV1` from
`@omnyo/plugin-sdk/provider-usage` defines the RPC contract for listing usage
resources and collecting one resource at a time. A list call reads local
metadata. A fetch allows cached data with `refresh: false` and requests a new
collection attempt with `refresh: true`. Provider Usage consumes the same
contract that Account Pooler, ACP Providers, Claude Code Provider, and Codex
Provider register.

The three host-local providers use
`experimental_registerHostProviderUsageSourceV1(api, { ownsProvider, description })`
from the same entry. The helper registers both methods with a separate cache
for each registration. The caller supplies the ownership predicate and
discovery description. Account Pooler manages its shared account measurements
through its own registration.

Before stabilizing the export, verify that an independently packaged provider
and a consumer from a different SDK build can discover both v1 methods and
exchange results for each usage state. Preserve the method names and wire
schemas while v1 is supported.

## The ACP bridge kit (`@omnyo/plugin-sdk/provider-bridge/acp`)

**Experimental legacy import.** This subpath keeps the existing export names,
including the bridge and dialect helpers, and runs the same implementation as
`provider-bridge/acp-next`.

**What it does.** Publishes Omnyo's generic Agent Client Protocol bridge so any
plugin can add an ACP agent without Omnyo-side code. `experimental_acpProviderBridge`
is the bridge a plugin re-exports from its `omnyo.host` artifact; the agent to
launch arrives per command in `providerOptions.acpLaunchSpec`, so one
implementation serves every agent. The bridge ships three dialects
(`generic`, `cursor`, `grok`) — version 1 of the protocol has no sub-agent
concept and standardizes nothing about `rawInput`, so each agent's vendor
side channels are read by a small module named by id in the registration's
bridge options (`acpDialect`). `experimental_probeAcpAgent` asks one
installed agent what it supports (`initialize` → `agentCapabilities`) so a
plugin can replace a declared guess with the agent's own answer, and
`experimental_acpAgentProbeSchema` validates that answer across a host RPC
boundary. `experimental_acpLaunchSpecSchema` (and its `AcpLaunchSpec` type)
is the launch spec the bridge parses, published so a plugin validates what
it declares against exactly what the bridge will accept. The shared
provider bridge protocol package owns the definition.

**Audit before stabilizing.** Decide what `probeAcpAgent` owes a caller:
today it spawns the agent with a 10s timeout, advertises the bridge's own
client capabilities, and answers `-32601` to anything the agent asks — settle
whether the timeout, the client capabilities and the refusal are the caller's
to choose. Decide whether `AcpDialect` is the right shape for a third-party
agent before a dialect registry becomes public again — today it has four
optional hooks (`toolIdentity`, `classifyToolCall`, `handleClientRequest`,
`maintenance`) and no versioning, so adding a fifth is a silent capability
change for every dialect; and whether a dialect should be named by value in
the provider registration instead of by id. Settle whether the bridge itself
should be a factory rather than a module singleton before a host artifact
ever needs two configured differently. For `acpLaunchSpecSchema`: the shape
is stored in the ACP plugin's `customAgents` setting and in registrations'
bridge options, so a change is a migration of stored agents — decide what a
plugin is owed when the spec grows a field.

## The rebuilt ACP bridge kit (`@omnyo/plugin-sdk/provider-bridge/acp-next`)

**Experimental.** The built-in ACP Providers plugin
(`plugins/provider-acp-next`) re-exports `experimental_acpProviderBridge`
from this subpath in its `omnyo.host` artifact. The legacy
`provider-bridge/acp` import retains its original export names and uses the
same implementation.

**What it does.** The same members as the original kit
(`experimental_acpProviderBridge`, `experimental_probeAcpAgent`,
`experimental_acpAgentProbeSchema`, `experimental_acpLaunchSpecSchema` and
their types), backed by `packages/provider-bridge-acp-next`: transport on the
official `@agentclientprotocol/sdk`, a session model that opens turns for
agent-started work, live slash commands and session options published as Omnyo
thread state, elicitation forms as question cards, and sign-in guidance from
the agent's advertised auth methods.

**`experimental_registerAcpDialect`.** New in this kit by owner decision, so a
third-party plugin can describe an agent Omnyo does not ship. A plugin calls it
at module load in its `omnyo.host` artifact with an `AcpDialect` (`id` plus the
optional hooks `toolIdentity`, `classifyToolCall`, `commandResult`,
`normalizeCommandEvent`, `clientRequestMethods` with `handleClientRequest`,
and `maintenance`) and names the id as `acpDialect` in its registration. It
throws for an empty id and for a built-in id (`acp`, `cursor`, `grok`, `omp`,
`opencode`); a second registration of the same id replaces the first; an id
nothing registered resolves to the generic dialect. Core uses the same path:
the bridge resolves every dialect, shipped or registered, through the one
registry (`packages/provider-bridge-acp-next/src/dialect.ts`,
`resolveAcpDialect`), and the built-in plugin names its dialects by id the way
a third-party plugin does.

**Audit before stabilizing.** Decide what `probeAcpAgent` owes a caller,
hook versioning for `AcpDialect`, naming a dialect by value, a bridge factory
instead of a module-level registry.

## `PluginProviderDeclaration.experimental_nativeSkillRoots`

**Kept experimental (2026-08-22).** every first-party provider declares it now (stabilization S5 moved the daemon's per-provider scan table here), but no third-party agent has validated the relative-path / 32-root rule or the per-root options, and the split between a global declaration and the per-workspace resolver (`experimental_resolvesNativeRoots`) is one release old.

**What it does.** Names the directories a provider's own agent reads skills
from, relative to the target host's home directory (`user`) or to the
workspace (`project`). Omnyo lists those skills beside its own and offers them in
the composer. It replaces the one thing the server used to dig out of an ACP
agent's launch spec: before the ACP tier was deleted, `GET /projects/:id/
commands` read `acpLaunchSpec.nativeSkillRoots` out of a config record. A
provider's skill layout is the provider's own fact, so it is declared, and
core never reaches into a plugin's opaque bridge options for it. Validated at
registration: `user` and `project` are relative paths only, no dot segments,
no duplicates, at most 32 roots per side. The declaration is global; a
directory only one host can name is the resolver's answer
(`experimental_resolvesNativeRoots`), and Omnyo scans each absolute path once
across the declared and resolved roots, the first in declaration order
winning ([provider-plugin-api.md](provider-plugin-api.md) §1).

**Closed (2026-08-22).** The `absolute` side is gone. Protocol 157 added it
for the pi plugin, which probed every connected host for the skills
directories pi's `settings.json` names and re-registered the union across
hosts — so a host-specific root reached every host's listing and a
project-scoped setting could not be declared at all. Pi now resolves those
directories per host through `experimental_resolvesNativeRoots` like every
other first-party plugin, nothing populated the side, and protocol 163
removed it from the declaration and the daemon wire.

**Audit before stabilizing.** Decide whether the two-bucket shape (`user`,
`project`) is the right vocabulary or whether a root should name its own base
explicitly; confirm the 32-root cap and the relative-path rule against a real
third-party agent; and decide whether this belongs on the declaration at all
or should be reported per host by the bridge, since where an agent keeps its
skills can differ per machine (today that difference is the resolver's job).
The per-root options and the symlink boundary rule are in
[provider-plugin-api.md](provider-plugin-api.md) §1 (the
`experimental_nativeSkillRoots` paragraph); audit whether those options are
the right vocabulary or whether a root should carry a shape like the
resolver's answer does.

## `PluginProviderDeclaration.experimental_nativeCommandRoots`

**What it does.** Names the directories a provider's agent reads its own
slash commands from — flat directories of `*.md` prompt files, Claude Code's
`.claude/commands` — in the same two-sided shape and with the same per-root
options as `experimental_nativeSkillRoots`. Omnyo offers the commands in the
composer beside the agent's skills. Added by stabilization S5 when the
daemon's per-provider scan table was deleted: the claude-code plugin is the
only first-party declarer.

**Audit before stabilizing.** Decide whether commands and skills should stay
two declarations or become one list of typed roots; confirm that a flat
`*.md` directory is the only command layout a third-party agent needs.

## `PluginProviderDeclaration.experimental_resolvesNativeRoots`

**What it does.** Declares that the plugin's `omnyo.host` entry implements
`experimental_nativeRootsHostContract`. When Omnyo lists a provider's commands or
skills it calls `resolveNativeRoots({ providerId, cwd })` on the workspace
host (cached for ten seconds per plugin, provider, host and workspace;
invalidated when the plugin's settings change or the provider re-registers)
and scans the answer beside the declared roots. This is where host-only
knowledge goes — a config-moved directory, installed vendor plugins,
config-file skill entries — including project-scoped entries a global
declaration cannot carry. A failed or malformed answer is logged and yields
no resolved roots; it never fails the listing.

**Closed (2026-08-22).** Pi's per-host probe converged on this RPC: the pi
plugin's host entry answers `resolveNativeRoots` with the directories its
`settings.json` names on that host, and the declaration's `absolute` side
that carried the probe's union is deleted (protocol 163). Every first-party
plugin with host-only roots now resolves them this way.

**Audit before stabilizing.** Decide whether the flag should exist at all or
whether the server should detect the method on the host entry; and settle
the cache TTL and the invalidation set against a real multi-host setup.

## `experimental_nativeRootsHostContract` (`@omnyo/plugin-sdk/host`)

**What it does.** The one-method RPC contract (`resolveNativeRoots`) a
provider plugin's host entry serves when its declaration sets
`experimental_resolvesNativeRoots`. Input `{ providerId, cwd: string | null }`;
output `{ skills, commands }`, each a list of host-absolute roots with
`origin` (`user` | `project`), `recursive`, `ancestors` (project roots inside
the workspace only), `namePrefix`, and a `shape` (`skills`, `skill`,
`skill-file`, `commands`, `command-file`) that tells the daemon how to read
the root. The contract fills the option defaults.

The optional `watchPaths` array declares up to 256 host-absolute configuration
files or plugin-cache directories used to resolve those roots. When supplied,
the command catalog observes these exact inputs instead of every immediate
file in the declared user roots' parents. An empty array declares no extra
inputs; omission preserves older plugins' parent-watch behavior. Codex uses
this path for its resolved home's `config.toml` and `plugins/cache`, while
actual command and skill metadata remain watched. The SDK filter preserves
these dependencies, and the server forwards them to the daemon (protocol 240).
Before stabilization, verify configuration and plugin-manifest refreshes,
missing-input creation, moved provider homes and multi-host invalidation.

**Audit before stabilizing.** Confirm the shape vocabulary covers a
third-party agent's layouts; decide whether the contract should accept a
relative path the daemon resolves (so a plugin need not know the host home)
and whether the 256-root cap per side is right.

## `experimental_filterResolvedNativeRoots` (`@omnyo/plugin-sdk/host`)

**What it does.** Checks a `resolveNativeRoots` answer root by root against
the contract (path, origin, name prefix, the manifest marker's form, shape,
the per-side cap of 256), drops a root that fails with a warning naming the
path and the reason, and truncates a side past the cap with one warning. A
resolver calls it before it answers, so one vendor plugin with an odd
manifest name cannot void the whole listing for the cache window; the server
boundary stays strict. A dropped root's reason names its malformed fields
when any field is malformed; the cross-field rules (ancestors on a user root,
a marker on a non-skills shape, a fallback name on a non-skill-file shape)
are judged only on a root whose fields all parse. Added by stabilization S6
after the S5 review.

**Audit before stabilizing.** Decide whether the per-root leniency belongs in
the contract's output schema itself (drop at the boundary, report the drops
in the answer) so a plugin cannot forget to call the helper, and whether
`dropped[].reason` is a contract a resolver's test may pin or free text for
the log.

## Vendor plugin roots (`experimental_resolveClaudePluginRoots` and `experimental_resolveVendorPluginRoots`, `@omnyo/plugin-sdk/host`)

**What it does.** The two readers a provider plugin's `resolveNativeRoots`
handler calls for the vendor plugins installed on the host.
`experimental_resolveVendorPluginRoots({ plugins, layout })` walks plugin
directories and answers the roots with `namePrefix: "<plugin>:"`; every
caller names the layout. `layout: "claude"` is the Claude plugin layout — per
plugin its root `SKILL.md` (named after the plugin when the file's
frontmatter has no name), `skills/`, `commands/`, then the manifest's
`skills` and `commands` entries (a `SKILL.md` file is one skill, a directory
holding `SKILL.md` is one skill, any other directory holds skills; a `.md`
file is one command, a directory holds commands; an absolute or escaping
entry is ignored). `layout: "grok"` lists the manifest's entries only, each
directory recursive. `experimental_resolveClaudePluginRoots({
cwd, homeDir, env })` reads Claude Code's registry first — installs from
`<claudeDir>/plugins/installed_plugins.json` (a `managed` or `user` install
is a user root; `project` and `local` count only for the workspace that
holds them, as project roots; an install path that is gone falls back to the
cache entry for the recorded commit, else the newest), enablement from the
user, project and local `enabledPlugins` settings with the manifest's
`defaultEnabled` for an unlisted plugin, and plugins dropped into the project
and user `skills` directories — and runs the walk over them; the answer also
carries `claudeDir` (`CLAUDE_CONFIG_DIR` or `~/.claude`) so a caller that
lists that directory's own `skills` and `commands` agrees with the reader.
The claude-code plugin answers both sides from it; the ACP plugin's omp and
grok resolvers take `.skills`; the codex plugin feeds its own enabled plugins
(from `config.toml` and the cache) into the walk.

Two rules every caller now shares. Symlinks: a user-origin plugin's skill
components are followed (a personal install commonly links a skill), a
project-origin plugin's are not (checked-in content must not reach outside
the repository), and command components never follow a link. Repeated
paths: within an answer a path appears once per side; the first root to
claim it, in answer order (plugins in the order given, each plugin's roots
in the order above), is kept and a later one is dropped. The contract accepts
a resolved answer that repeats a path and the daemon scans the first root per
path, so a reader that answered the same install twice (the same plugin
recorded under two scopes at one path) listed it once either way; the rule
makes the answer say what the daemon scans. A caller that takes `.skills`
only (omp, grok) still pays the reader's stat of each plugin's `commands/`
and manifest `commands` entries — accepted: a few stats per plugin per
listing, against a second option on the reader.

**Audit before stabilizing.** Decide whether the walk should keep taking a
layout name (`claude`, `grok`, each caller naming its own) or the two facts
behind it (conventional roots on or off, directories recursive or flat) once
a third vendor layout appears; whether `claudeDir` belongs on the answer or
the reader should also answer the config directory's own roots; whether a
skills-only caller should be able to ask for one side; whether the
repeated-path rule should be the contract's (drop at the boundary, first
root wins) rather than each helper's; and whether a plugin's `name` should
be validated as a name prefix here instead of at
`experimental_filterResolvedNativeRoots`.

## `PluginSettingDescriptor.experimental_multiline`

**What it does.** A `type: "string"` setting descriptor field
(`api.settings.define`). When `true`, the host renders the setting as a
multi-line text field instead of a one-line input: on the web a monospace
textarea below the label and description at the row's full width (six rows
minimum, growing with its content to twenty-four, then scrolling; spellcheck
off), on mobile a monospace multi-line `TextInput`. The stored value is the
same string as before — the flag changes the editor, not the contract, so the
CLI (`omnyo plugin config <id> set <key> <value>`) and `settings.get()` are
unaffected and a plugin still parses the text itself (the ACP plugin's
`customAgents` JSON array, the first consumer, parses on read and warns). A
descriptor that sets it beside `secret: true` is refused at define time:
secrets are edited in a password field and never echoed back. The field
travels in the settings view (`GET /plugins/:id/settings`), whose clients
parse descriptors with a strict schema; the web and mobile apps ship with
the server, so no client older than this field is served.

**Audit before stabilizing.**

1. **Name and shape.** Decide whether to stabilize as a boolean `multiline`
   or replace it with a `json` descriptor type that validates at the boundary
   (pretty-printing, parse errors shown in the form, a typed value from
   `settings.get()`), which would make this flag redundant for its first
   consumer. A `multiline` boolean still has a use for plain lists, so the two
   may coexist.
2. **Mobile.** Confirm that phones need the editor at all — a JSON array is
   hard to type on a soft keyboard — or whether the mobile form should show
   the value read-only with a "edit on desktop" note.
3. **Unknown descriptor fields.** The strict client schema turns every new
   presentation hint into a client release. Decide whether descriptor schemas
   should tolerate unknown fields so a hint degrades to the one-line input on
   an older client instead of failing the whole settings view.

## `api.sdk.threads.experimental_listPluginMetadata`

**What it does.** `POST /threads/plugin-metadata` with
`{ pluginId, threadIds }` (1–200 ids) returns `{ threads: { threadId,
metadata }[] }` for each requested thread that holds that plugin's metadata
namespace, archived and deleted threads included, in one
`WHERE plugin_id = ? AND thread_id IN (…)` query on the
`thread_plugin_metadata` primary key. Threads without a namespace are omitted;
corrupt namespaces are omitted and logged without their content, like the
single-thread read. The core SDK takes `{ pluginId, threadIds, signal? }`; the
plugin-bound SDKs (backend `api.sdk`, app `useSdk()`, and the fake host) default
`pluginId` to the calling plugin, like `getPluginMetadata` and
`updatePluginMetadata`. The route trusts its `pluginId` like the single-thread
routes, because app requests carry no plugin identity. First caller: push-notifications'
`threadNotifications.list`, which the Notifications thread action calls with
the ids it has not cached yet.

**Audit before stabilizing.**

1. **Route binding.** Any caller can read any plugin's namespace, as with
   the single-thread metadata routes. Decide whether plugin requests should
   carry an identity the routes can enforce.
2. **Batch size.** 200 ids per request; callers chunk. Revisit if the
   attributes layer replaces per-registration reads.

## `api.sdk.threads.experimental_listAncestors`

**What it does.** `POST /threads/ancestors` with `{ threadIds }` (1–200 ids)
returns `{ threads: { threadId, ancestorIds }[] }`: each requested thread that
exists, once, with its ancestors' ids from the parent up to the root (empty
for a root thread). Archived and deleted threads are included; unknown ids
are omitted. One recursive query follows `parent_thread_id` by primary key,
so the cost is one indexed lookup per level, and core's depth limit keeps
that to a few. Available unchanged on the core SDK and the plugin-bound SDKs.
First caller: push-notifications, which reads each thread's ancestors and
then their levels with `threads.experimental_listPluginMetadata`, so a
parent's limit always follows the current tree, including a thread nested
under a new parent or released when its parent is archived.

**Audit before stabilizing.**

1. **Shape.** Decide whether callers also need each ancestor's thread
   (title, status) rather than only ids, and whether it should merge with
   `experimental_listDescendants` into one tree read.
2. **Batch size.** 200 ids per request; callers chunk, like
   `experimental_listPluginMetadata`.

## `api.sdk.threads.experimental_listDescendants`

**What it does.** `POST /threads/descendants` with `{ threadIds,
includeArchived?, includeHidden? }` (1–200 ids) returns `{ threads: {
threadId, descendantIds }[] }`: each requested thread that exists and is not
deleted, once, with the ids of every thread below it in breadth-first order,
children first (empty for a leaf). Archived and hidden descendants are
omitted unless their flag is true, matching `threads.count`; the walk still
passes through them, so a visible thread under an archived one is returned.
Deleted threads, anything only reachable through one, and unknown ids are
always omitted. One recursive query follows `parent_thread_id` through
`threads_parent_idx`, so the cost is one indexed lookup per thread in the
subtree, archived ones included. Available unchanged on the core SDK and the
plugin-bound SDKs. First caller: push-notifications, which publishes the
levels of a thread and its unarchived, visible descendants when the thread's
level or parent changes, because a parent's level limits its whole subtree,
and republishes a thread's subtree on `thread.unarchived`.

**Audit before stabilizing.**

1. **Shape.** Decide whether callers need the tree's edges (each
   descendant's parent) or thread fields rather than a flat id list, and
   whether it should merge with `experimental_listAncestors`.
2. **Size.** A subtree of live threads has no cap, and the query walks
   archived threads even when it omits them. Decide whether to page.
3. **Omitted threads.** Unlike `experimental_listAncestors`, deleted threads
   are always omitted and archived and hidden ones by default. Confirm that
   callers never need deleted ones. No event announces a hidden thread
   becoming visible, so a caller that skips hidden threads cannot refresh
   one when it appears; decide whether visibility changes need an event.

## `api.sdk.threads.experimental_importNative` and `experimental_nativeSessionClaims`

**What it does.** `threads.experimental_importNative(request)` posts to
`POST /threads/import` (32 MB body limit, 413 above it) and turns one Codex or
Claude Code chat into an idle Omnyo thread without running a turn. The request
names the project, host, provider (`codex` or `claude-code`), the native
session id and file path, the chat's exact `cwd`, a title, the original
`createdAt` and `lastMessageAt`, and up to 5,000 normalized turns (user text
plus agent messages, command executions, file changes and tool calls, with
per-field caps in `NATIVE_HISTORY_LIMITS`). The server validates every history
row before writing, places the thread in a host environment at that `cwd`,
keeps the original `createdAt`, uses `lastMessageAt` as its read and attention
time, seeds the history as stored turn events, records the source in
`native_thread_imports`, and settles to idle without an Inbox receipt or owner
input. It returns 201 `{ kind: "imported", threadId }`, or 200
`{ kind: "already-claimed", threadId, via }` when a live thread already
imported that source or owns it through a `thread/identity` event on the same
provider and host. A failed import removes its record and soft-deletes the
thread, so a retry imports again. The first send forks the native session
(`thread.start` with `fork.sourceProviderThreadId`) on both the ready and the
reprovision dispatch paths, so the native file is never resumed in place. A
provider or host mismatch answers 409 `provider_session_unavailable`; an
existing identity or a completed context clear ends the fork. Editing the
first imported message starts a fresh session. The plugin-bound SDK stamps
`origin: "plugin"` and the caller's `originPluginId`.
`threads.experimental_nativeSessionClaims({ hostId, providerId })` reads
`GET /threads/native-sessions` and returns `{ claimed: { sourceProviderThreadId,
threadId, via }[] }`, the union of import records and identity events of
non-deleted threads for that provider and host. Core callers: the Chat import
plugin (`omnyo--chat-importer`), whose server backs its settings panel, the
onboarding Chats step, and `omnyo chat-import scan` and `run`.

**Audit before stabilizing.**

1. **History shape.** Decide whether the normalized item set (no images,
   reasoning or subagent turns) and the per-field caps are the right public
   contract for importers of other agents.
2. **Claims.** Identity claims of threads without an environment count on
   every host; decide whether that is the intended scope, and whether claims
   need paging on installations with many sessions.
3. **Fork semantics.** Confirm that forking on first send, rather than
   resuming in place, is what callers expect, including the Codex Account
   Pool guard that refuses default-provider forks.

Stabilization requires that audit, then a project-wide rename and the
removal of this entry.

## `PluginSettingDescriptor.experimental_optionLabels`

**What it does.** A `type: "select"` setting descriptor field
(`api.settings.define`): a record from option value to display label. The
settings form shows the label in the picker and as the current value; an
option without a label shows its value, as before. Stored values, defaults,
`settings.get()` and `omnyo plugin config <id> set <key> <value>` keep using the
option values, so a plugin can rename a label without migrating stored data.
A label keyed by something that is not one of `options` is refused at define
time. The field travels in the settings view (`GET /plugins/:id/settings`)
like `experimental_multiline`. First consumer: push-notifications'
`defaultLevel` and `childLevel` (`all` shows as "All activity").

**Audit before stabilizing.**

1. **Shape.** Decide between this parallel record and `options` accepting
   `{ value, label, description? }` objects; the object form keeps labels
   beside their values and makes per-option descriptions possible, but every
   reader of `options` (host policy, server contract, CLI, settings form) has
   to handle both forms.
2. **CLI.** `omnyo plugin config <id>` still lists raw option values, which is
   what `set` accepts; decide whether it should also print labels.

## `PluginSettingDescriptor.experimental_section`

**What it does.** An optional `{ title, description? }` on any setting
descriptor (`api.settings.define`). Fields naming the same `title` render as
one collapsed row on the plugin's settings page, after the ungrouped fields
and in the order each group's first field was defined. The row shows the
title, the description and "Set up" once any of its fields holds a value other
than its default (a secret counts once saved), otherwise "Not set up";
opening it shows the fields with the usual autosave. Every field naming a
title must repeat the same description; a conflict is refused at define time.
Stored values, `settings.get()` and `omnyo plugin config <id> set` are
unchanged; `omnyo plugin config <id>` prefixes each grouped label with its
section title. The field travels in the settings view
(`GET /plugins/:id/settings`), whose clients parse descriptors strictly.
First consumer: Canvas, which groups its data-source credentials by source.

**Audit before stabilizing.**

1. **Shape.** Decide whether a per-field object stays, or whether
   `api.settings.define` should take sections as an argument, so descriptions
   are declared once.
2. **Status.** Confirm that "Set up" from non-default values fits groups of
   toggles and choices as well as credentials, or whether a plugin should
   supply the status.

## `PluginSettingDescriptor.experimental_placeholder`

**What it does.** An optional example on `type: "string"` and
`type: "number"` descriptors, shown while the field is empty and never
stored. A saved secret still shows "Saved · type to replace"; an unset secret
shows the placeholder, or "Not set" without one. First consumer: Canvas,
which shows example origins and commands.

**Audit before stabilizing.**

1. **Scope.** Decide whether `select` and `project` pickers need a custom
   empty label too, and whether the CLI should print placeholders.

## `api.server.experimental_dataDir`

**Kept experimental (2026-08-22).** A bare data-directory path does not
stabilize.

**What it does.** The server's data directory — the one holding `config.json`,
`app.db` and `plugins/<id>/`. A plugin cannot compute it: a dev server derives
its data dir from its repo root and instance id (`~/.omnyo-dev/<instance>`). Its
only consumer is the Account Pool plugin, which keeps its account and
hub-token secret files under `plugins/<pluginId>/secrets/accounts` in that
directory.

**Audit before stabilizing.** The member was added for the ACP plugin's read
of the `customAcpAgents` array in `config.json`, which is removed. Decide
whether the Account Pool plugin's secret files can move to a plugin-scoped
primitive so the member can go. If it stays, decide whether a bare path is the
right shape or whether a plugin should get named accessors for the Omnyo-managed
locations it may use — a path invites writes into Omnyo's directory, which
`api.storage` exists to prevent.

## `api.server.experimental_appUrl`

**What it does.** This value gives plugins the operator-configured public app
URL from `OMNYO_APP_URL`. It is `null` when the operator did not configure that
value. Plugins can read it before the server starts to listen.

**Audit before stabilizing.** Decide whether `OMNYO_EXTERNAL_URL` or the Omnyo
connect URL should supply this value when `OMNYO_APP_URL` is empty. Confirm that
one public URL has clear behavior when a server has several access paths.

## Bridge record mode (`experimental_recordProviderChildIo` and `experimental_isProviderBridgeRecording`)

**Kept experimental (2026-08-22).** the recording entry shape is now consumed by the public testing kit, so it is a de-facto fixture format that must be frozen together with `experimental_readBridgeRecording` / `replayRecording`; the `{ threadId | null }` scope is untested against a multiplexing bridge.

**What it does.** `experimental_recordProviderChildIo` tees a provider
child's stdio into the bridge record mode (`OMNYO_PROVIDER_BRIDGE_RECORD_DIR`),
scoped to the Omnyo thread the child serves. It is a no-op when record mode is
off, so a bridge calls it unconditionally after `spawn()`.
`experimental_isProviderBridgeRecording` reports whether record mode is on,
for a bridge whose provider pipe is owned by an SDK and must take the spawn
over to tee it. See [provider-bridge-protocol.md](provider-bridge-protocol.md),
"Record mode".

**Audit before stabilizing.** Decide whether the bridge kit should own the
spawn itself (one helper that spawns and records) instead of a post-spawn
hook; confirm the `{ threadId | null }` scope is the right key once bridges
multiplex several threads over one child; and settle the recording entry
shape (`{ ts, run, seq, dir, line }`) as a documented fixture format.

## Portable provider spawn (`experimental_spawnPortableProcess`, `experimental_killPortableProcess`) (`@omnyo/plugin-sdk/provider-bridge`)

**What it does.** `experimental_spawnPortableProcess` spawns a provider
executable with the daemon's portable launcher instead of `node:child_process`
`spawn`. It takes `{ command, args, cwd?, env?, stdio?, detached? }` and returns
a `ChildProcess`. On Windows it resolves the command through PATH and PATHEXT,
runs npm `.cmd` shims, and hides the console window; on macOS and Linux it
behaves like `spawn`. `experimental_killPortableProcess(child, signal)` ends
such a child: on Windows it terminates the child's whole process tree, because a
`.cmd` shim makes the child a `cmd.exe` wrapper and Windows delivers no signals;
on macOS and Linux it sends `signal` to the child. The Codex and Pi bridges
launch and stop their CLIs with the pair.

**Audit before stabilizing.** Decide whether bridges should receive the managed
process handle (an awaited stop that reports whether the tree is confirmed gone)
instead of a raw `ChildProcess` plus a fire-and-forget kill. Confirm argument
quoting for `.cmd` targets with untrusted arguments, and whether `detached`
belongs in the public shape.

## `experimental_BridgeRecoveryError`

**Kept experimental (2026-08-22).** it is part of the provider-bridge authoring surface and stabilizes together with `experimental_defineProviderBridge` / `experimental_apiVersion` in the later bridge-kit audit.

**What it does.** A request handler throws it to reject the request with a
typed recovery hint: `runBridgeRequest` answers with the given JSON-RPC
`code` and `error.data.recovery { kind, message, retryable }`, the same way a
`ProviderRequestDecodeError` becomes `INVALID_PARAMS`. A handler that answers
by hand passes the hint to `sendError(id, code, message, { recovery })`
instead. The runtime reads the hint from the rejected request
(`JsonRpcResponseError.recovery`) and acts on the kind; see
[provider-bridge-protocol.md](provider-bridge-protocol.md), "Recovery hints".

**Audit before stabilizing.** Confirm the five kinds cover what third-party
bridges need to say about a rejection (a `notInstalled`/`needsUpdate` kind
for installation was deliberately left to `provider/installation/*`). Decide
whether `retryable` should be per kind (only `sessionArchived` and
`rateLimited` read it today) and whether the runtime should bound the
`rateLimited` ladder from the hint rather than from a constant.

## Provider maintenance toolkit (`experimental_resolveExecutablePath`, `experimental_readCliVersion`, `experimental_commandOutput`, `experimental_versionFrom`, `experimental_compareVersions`, `experimental_formatCommand`, `experimental_npmCommand`, `experimental_npmGlobalInstallCommand`, `experimental_npmLatestVersion`, `experimental_probeNpmGlobalPackage`, `experimental_npmGlobalInstallSource`, `experimental_installationVerification`, `experimental_downloadedInstallerCommand`, `experimental_clampPercent`) (`@omnyo/plugin-sdk/provider-bridge`)

**What it does.** The host-local probes and install-action plumbing behind a
bridge's `provider/health`, `provider/usage` and `provider/installation/*`
answers when its provider is a user-installed CLI. The probes:
`experimental_resolveExecutablePath` (the command's absolute path — the path
itself when given absolute and executable, else the first `which` hit, or on
Windows the first `where` hit whose extension is in `PATHEXT` so an npm `.cmd`
launcher wins over the extensionless shim beside it, null when absent; 5 s), `experimental_readCliVersion` (`<command>
--version` with stdin closed, so CLIs that start a stdio server on unknown
flags exit instead of hitting the timeout; the first version token on stdout
or stderr, or null if it is invalid SemVer; 5 s),
`experimental_commandOutput` (any command's trimmed stdout+stderr or null on
failure; 15 s), `experimental_versionFrom` (the first version token in a
banner, or null if it is invalid SemVer), `experimental_npmLatestVersion` (`npm view <package> version`) and
`experimental_probeNpmGlobalPackage` (`npm prefix -g` as the global bin
directory plus `npm list -g <package>` as the installed version). The
decisions: `experimental_compareVersions` (SemVer precedence, ignoring build
metadata; throws `TypeError` for invalid inputs), `experimental_npmGlobalInstallSource` (`npmGlobal` when
the executable sits inside npm's global bin, `external` otherwise,
`notInstalled` when absent) and `experimental_installationVerification` (an
install verifies by existence; an update by reaching the latest version the
status saw, or by any change when the registry was unreachable). The
actions: `experimental_npmGlobalInstallCommand` (`npm install -g
<package>@latest` with its display string), `experimental_downloadedInstallerCommand`
(a vendor's `curl | bash` script run from a temp file; given
`{ powershellUrl }` it returns `powershell.exe … "irm <url> | iex"` on Windows),
`experimental_npmCommand` (`npm` / `npm.cmd`) and
`experimental_formatCommand` (a display command line with shell-unsafe
arguments single-quoted). `experimental_clampPercent` rounds a usage
percentage into 0–100. The codex, claude-code and pi bridges and the ACP kit
build their maintenance answers from these; each keeps its own policy (the
minimum supported version, the login command, credential and usage readers,
dist-tag and `doctor` parsing) beside them.

**Audit before stabilizing.**

1. **Timeouts are fixed.** 5 s for `which`/`--version`, 15 s for npm and
   self-diagnostics; a bridge whose CLI is slow to start (a JVM, a first-run
   download) cannot lengthen them. Decide whether the budgets become
   arguments before the signatures are a promise.
2. **`compareVersions` uses `semver` precedence.** Numeric prerelease
   identifiers compare numerically, text identifiers use ASCII order, and
   build metadata does not affect precedence. Invalid inputs throw
   `TypeError`. The comparison subpath is bundled into the SDK and plugins;
   no consumer dependency is required. Confirm the throwing contract before
   stabilization.
3. **The npm helpers assume a global install.** `probeNpmGlobalPackage` and
   `npmGlobalInstallSource` model one layout (npm's global prefix); pnpm,
   volta and corepack shims read as `external`. Decide whether the source
   enum should grow before it is relied on.
4. **`downloadedInstallerCommand` is POSIX.** `sh -c` with `mktemp`, `curl`
   and `bash`; there is no Windows form. Decide whether it should refuse on
   win32 rather than hand the daemon a command that cannot run.

## Presentation builders (`experimental_presentationTitle`, `experimental_presentationDetail`, `experimental_withTitle`, `experimental_presentationFileName`, `experimental_COMPACTION_PRESENTATION`, `experimental_REASONING_PRESENTATION`, `experimental_fileReadPresentation`, `experimental_searchPresentation`, `experimental_webSearchPresentation`, `experimental_webFetchPresentation`, `experimental_planStepsPresentation`, `experimental_toolPresentation`) (`@omnyo/plugin-sdk/provider-bridge`)

**What it does.** The bridge kit's presentation building blocks for the
grammar-v3 `presentation` a bridge stamps on every item it opens
(docs/provider-plugin-api.md §3): `experimental_presentationTitle` takes the
first non-empty line of a text and caps it at 160 characters with an
ellipsis, returning undefined when there is nothing to headline;
`experimental_presentationDetail` caps a row detail at the persisted
schema's 280-character limit (the same constant the server validates with,
so a bridge can never build a detail the ingest rejects);
`experimental_withTitle` stamps a title on a presentation only when there is
one; `experimental_presentationFileName` is the last path segment a file row
headlines with. The two constants are the core-kind rows whose wording is the
same for every provider (compaction: "Compacting context" / "Compacted
context" under `Archive`; reasoning: "Thinking" / "Thought" under `Brain`),
and the five builders are the core shapes whose label and glyph do not depend
on the provider: file read (`FileText`, headlined by file name), search
(`content` → "Searching files" / `Search`, `path` → "Finding files" /
`FolderOpen`), web search (`Globe`, headlined by the query when there is
one), web fetch (`Browser`, headlined by the URL), and a plan-steps snapshot
("Updating plan" / `ListTodo`, collapsed by default, headlined by the active
step). `experimental_toolPresentation` is the generic "Running <tool>" /
"Ran <tool>" row under `Toolbox` for a tool with no kind and no presentation
of its own. The codex, claude-code and ACP bridges and the echo example
build their rows from these and keep only their own vocabulary (which native
tool is which kind, how a command headline is unwrapped, per-tool tables).

**Audit before stabilizing.**

1. **The wording is a product decision.** A third-party bridge that adopts
   the constants inherits Omnyo's English labels and glyph names; a bridge
   that wants its own wording builds the object itself. Decide whether the
   labels should come from the host (localized, themed) rather than be
   persisted from the bridge before the constants are a promise.
2. **The caps are the schema's.** The 160-character headline cap is a kit
   convention, the 280-character detail cap is the persisted schema's;
   stabilizing the helpers freezes both numbers as public behaviour.
3. **Plan-steps rows collapse by default.** `experimental_planStepsPresentation`
   sets `suppress: true` (the todo banner reads the snapshot); codex keeps
   its own uncollapsed variant. Decide which default a third-party bridge
   should get.

## `experimental_readBoundedLines` (`@omnyo/plugin-sdk/provider-bridge`)

**What it does.** The bridge kit's newline-delimited line reader, the one the
daemon reads every bridge's stdout with and the bridge worker reads its stdin
with: LF-only framing (never `readline`, which also splits on U+2028/U+2029
and tears a JSON line that carries them raw), a trailing CR stripped so a
CRLF producer parses, and a hard per-line cap (64 MiB by default) past which
the line is discarded up to its terminator and reported through `onOverflow`
with the byte count, so one runaway message costs its own content and
nothing else. A bridge that supervises a JSON-lines child (pi's `--mode rpc`
stdout and its extension channel) reads it with this instead of carrying
its own copy. The optional `onClose` fires once the input ends; a final
unterminated line is emitted before it.

**Audit before stabilizing.**

1. **The default cap is the wire's.** `maxLineBytes` defaults to the JSON-RPC
   line bound the runtime applies to the bridge itself; a provider child's
   payloads may deserve a different bound. Decide whether the default should
   be an explicit argument for child pipes.
2. **`onOverflow` is required.** The daemon logs the drop; a bridge might
   reasonably want to fail the session instead. Decide whether the reader
   should offer a fail-closed mode before the signature is a promise.

## Live-file navigation (`experimental_FileLink`, `experimental_AppNavigate.experimental_openFilePreview`, `experimental_AppNavigate.experimental_openFileExternally`, and `PluginFileOpenerSource.experimental_hostId`)

**Kept experimental (2026-08-22).** `experimental_hostId` is persisted inside opener-tab `paramsJson` (a rename needs a read-compat shim), Windows/UNC paths were never verified, and `experimental_openFilePreview` has no consumer.

**Core callers.** `usePanelFiles` owns file opening on the thread view, New
thread screen, and plugin page: core's workspace, host, and storage opens and
this API's `openFilePreview` build the same tab requests, and one scope rule
(workspace by environment, host files only with a thread and environment,
storage by thread; plugin pages accept any explicit target) is checked in
`usePanelFiles.test.tsx` against every surface. Links use `usePanelBrowser`
for in-app browser tabs and link-preference routing on every surface.

**What it does.** Gives plugin UI explicit, source-safe references to live
workspace, host, and thread-storage files. Ordinary `experimental_FileLink`
activation and the preview method use the current surface's shared file-tab
controller, including extension preferences and plugin file openers. The
external method resolves the current client's preferred file target, absolute
path, local/remote-SSH context, and line/column support. The boolean methods
report host acceptance; later OS failures remain host-owned. The host id added
to file-opener sources preserves explicit host identity when a plugin page
opens a host file without ambient thread context. Valid link targets expose a
scheme-safe href, while traversal paths, ill-formed Unicode, and other
malformed runtime targets remain inert in both the app and SDK test runtime.

**Audit before stabilizing.**

1. Verify strict target/path/location validation on POSIX, Windows drive, and
   UNC paths, including stale environment, host, and thread identities.
2. Confirm preview identity, persistence, opener preference, one-off Open with,
   disabled opener fallback, and explicit-host migration on Thread, New-thread,
   Settings, and plugin-page surfaces.
3. Audit external opening across local and remote clients, disconnected hosts,
   missing preferred apps, and targets with line but not column support.
4. Confirm link anchor behavior, unavailable menu states, copy semantics, and
   whether per-app external choices should remain host-owned menu affordances
   rather than become plugin-selectable API.
5. Measure the lazy boundary: mounting a file link must not start file reads,
   preview imports, editor discovery, or panel-destination loading.
6. Decide whether Git snapshots or deleted working-tree files merit separate
   target variants; do not weaken live-file guarantees to accommodate them.
7. Confirm `PluginFileOpenerSource.experimental_hostId` can become a stable
   required `hostId` field without breaking older opener implementations.

## Create a project in place (`experimental_AppNavigate.experimental_openProjectCreator`)

Opens Omnyo's shared project path picker without leaving the current page. It
reports whether the host accepted the request and delivers the created project's
ID and name after the user saves. Closing the picker leaves the current page
open and calls no completion handler. Plugins can check for the method on older
hosts.

The New chat launcher's project selector uses the same select-only flow in
`useQuickCreateProject` as the Automations importer. Before stabilization, verify
native folder pickers and the app's folder dialog both preserve and return to an
in-progress draft on save and cancel, including when the machine is disconnected.

## Terminal navigation (`experimental_AppNavigate.experimental_openTerminal`)

**What it does.** Shows an existing terminal session in the current surface's
Omnyo terminal panel: the host fetches the session, selects its tab (adding one
when needed), and reveals the panel. Plugins create the session with
`useSdk().terminals.create`, so the create scope (thread, environment, or host
path) decides the directory. A thread surface accepts only that thread's
terminals, the New thread screen only terminals in its current terminal scope,
and a plugin page any terminal, tagging the tab with the session's own scope.
It resolves false for unknown (404) or exited terminals and surfaces without a
terminal panel; other fetch failures reject. Closing the tab force-closes the
terminal, as for user-started terminals. Requested in #1132 and by a plugin
author whose code review page could not show a terminal in the reviewed
worktree.

**Core callers.** Every surface's terminal tabs go through
`usePanelTerminals`: its `open` is the navigation handler this API calls, and
core's Start terminal row, the `terminal.open` shortcut, and terminal tab
selection use the same `select` path after creating or choosing a terminal.
`usePanelTerminals.test.tsx` runs one contract table against the thread view,
New thread screen, and plugin page rules.

**Audit before stabilizing.**

1. Decide whether plugins need tabs that hide without closing the terminal
   (#1132's `closeBehavior: "detach"`). Thread and New-thread surfaces derive
   tabs from live sessions, so this needs a hidden-session notion in panel
   state rather than a flag on the call.
2. Confirm the per-surface acceptance rules with a real consumer, including
   environment terminals opened from a thread view and host-path terminals
   whose cwd differs from the New thread screen's target.
3. Verify compact-viewport drawer reveal, split panes, and opening a terminal
   whose host is disconnected.
4. Decide whether a nav panel should also declare a default terminal scope so
   the native "+ Terminal" button follows the page's worktree.

## Process-private temporary recovery and native directory inspection

`experimental_assertStorageAdmission`, `ExperimentalStorageAdmissionRequest`
and `ExperimentalStorageAdmission` are exported from `@omnyo/plugin-sdk/host`.
The helper validates a positive finite `expectedBytes`, a finite
`minimumFreeBytes`, and the exact destination filesystem before production.
It creates no directory, adopts no existing output and grants no deletion.
The receipt records the nearest existing physical directory, measured available
bytes and the required allocation plus reserve. This is admission, not an OS
quota or a guarantee about arbitrary filesystem writers.

Core process-private allocation, ManagedScratch and private publisher admission
use the same plain-Node implementation in process-utils. Before stabilization,
verify physical destination replacement, unsupported native filesystems and
concurrent producers. Preserve real-filesystem refusal and actual producer
integration coverage. Allocation declarations remain separate from owner grants,
consumer release, snapshot review and recovery authority.

`@omnyo/plugin-sdk/host` exports `experimental_inspectProcessPrivateTemps`,
`experimental_recoverProcessPrivateTemps` and `experimental_inspectDirectoryProcesses`.
Directory process inspection accepts a longer macOS timeout within a 30-second
bound for callers that must verify a large native process table before removal.
The process-private operations use the current account registry only. Their
options accept time, item and logical-byte budgets and reject caller-selected
registry roots. Recovery requires a fresh allocation marker, exact physical
identity, a kernel-proven stopped process generation, complete native activity
checks and no device or special-file boundary. Unknown or interrupted closeout
stays held. Windows crash recovery is held. Normal child closeout waits for the
direct child and checks native directory consumers before removal. Self-owned
workers check consumers once during `beforeExit`. Explicit exit and uncertain
consumers leave the durable journal for existing recovery. Provider stdin EOF
does not finish draining. A journal its producer closes while a scan is running
is skipped rather than failing the scan. Recovery rejects only before its first
removal; a failure for one allocation is returned as that allocation's held
result.

The common implementation is in `@omnyo/process-utils`. Actual core host and
provider workers allocate and close out through that implementation, and
Storage & retention uses the SDK path for maintenance. The native directory
inspector is shared by managed thread scratch and process-private recovery.
It returns idle, busy or unknown. Incomplete and unsupported observations never
become idle. These host helpers are bundled from the plugin's own SDK build;
no private workspace import is granted to plugin code.

Before stabilization, audit default registry isolation across installations,
receipt retention, native process-identity portability and the distinction
between normal-exit authority and crash recovery. Keep the real producer,
consumer-after-crash, EOF/drain and shared native-inspector behavior checks.

## Host plugin foundation (`api.hosts.experimental_client`, `ExperimentalHostClient.experimental_onWorkerExit`, `ExperimentalHostClient.experimental_onSignal`, `ExperimentalHostRpcContext.experimental_retainWorker`, `experimental_defineHostEntry`, `experimental_killProcessesWithCwdUnder`, `experimental_readProcessIdentity`, and `experimental_createHostEntryHarness`)

**Kept experimental (2026-08-22).** signals and watches have no consumer (decide whether to delete them or keep them experimental separately from calls), none of the lifetime/limit numbers has been measured against a plugin other than keep-awake, and the artifact-contract names (`experimental_apiVersion`, `experimental_signals`, the injected context members) are read by the daemon from installed artifacts, so renaming them needs a dual-name window plus a protocol bump.

**What it does.** Lets one plugin package declare a singular `omnyo.host` Node
entry, share a Standard Schema contract between its server and host entries,
and call methods on an explicit enrolled host. A client may observe unexpected
worker exits and typed, ephemeral host signals. The host context supplies
request and generation abort signals, persistent plugin-scoped data and
worker-scoped temporary directories, daemon-owned native file watches, and
explicit worker-retention leases for independent background work. Calls and
watches retain automatically; otherwise, the daemon gracefully evicts a worker
after five idle minutes and starts it again on the next call. There is no global
worker-count limit. When the server replaces a plugin (reload, update or install
over it), it no longer stops host workers; each daemon switches at the first call
for the new generation. A worker that holds retention leases keeps running on its
machine until its own work releases them (at most 25 hours). A shared host method
may declare `PluginRpcMethodContract.experimental_hostReplacementKey`, a nonempty
string of at most 128 characters. The caller and retained worker must declare
the exact same key for that method before a new-generation call can control
existing work. All other methods fail with `plugin_host_replacing`; reconnect
reconciliation follows the same rule when the plugin stays active. Change the
key when input, output or behavior becomes incompatible. Do not mark methods
that submit new work. Core uses the same dispatch and request-cancellation path
for every host call; cancellation stays bound to the worker that received it.
Missing legacy keys fail closed. The Resources job-control contract is the first
consumer. Stabilization requires cross-generation status, logs, cancellation and
completion acknowledgement, refusal of unmarked or changed contracts, and lease
drain into the new generation without replay.

Disable, removal, safe mode, maintenance and
server-move quiescence still dispose workers at once. Stabilization criteria:
Resources' updates complete with machines offline and without interrupting
leased jobs across a full release.

Daemon protocol 244 adds a nullable `replacementKey` to host calls, defaulting
legacy calls to no forwarding permission. Deliberate server-owned disposal sets
`includeRetained`; its default is false, preserving generation-bound legacy
disposal. The explicit flag also stops differently-versioned lease-holding
workers before the first replacement call. It does not change update or reload
admission, the single-worker rule, or the 25-hour replacement limit.
An already-retired disposer generation cannot use the flag to stop a newer
worker; exact-generation disposal keeps its existing ownership rule.
Each retained worker tracks its latest successor generation. Observing another
successor retires the prior caller even if it never owned a worker, without
resetting the replacement deadline. Delayed controls or disposal from that
forwarded generation cannot affect a later owner.

The single-worker, idle-eviction, retention, and call-timeout rules above are
specific to the host RPC consumer. Other daemon subsystems may attach the same
`omnyo.host` artifact through a different bootstrap and own their own process
lifecycle.

The initial builtin proof is Keep Awake: it owns a host target, a worker-owned
child process, desired-state reconciliation, and
unexpected-exit recovery without feature-specific core hooks.

**Audit before stabilizing.**

0a. **Process reap.** `experimental_killProcessesWithCwdUnder({ directories,
   graceMs? })` from `@omnyo/plugin-sdk/host` is the same helper Omnyo's own
daemon used to reap a managed workspace before removing it: SIGTERM to
every process whose working directory is at or under any of the paths,
SIGKILL after the grace, returning what it signalled. Each sweep lists
process working directories once for all paths, so batch callers pass every
directory in one call. The input was `{ directory }` through SDK 0.6.26;
the SDK export still accepts that shape at runtime but types only
`directories`, because git-installed plugins are rebuilt against the newest
matching SDK without a type check. Published for the worktree and
environment-personal-workspace plugins, which own their teardown and call it
before deleting the directory; Storage & retention passes whole cleanup
batches. Confirm the platform coverage (Linux
`/proc`, macOS `lsof`) and whether the grace should be per call.

0b. **Process identity.** `experimental_readProcessIdentity(pid)` from
`@omnyo/plugin-sdk/host` returns `{ command, startedAt }` (`ps` on POSIX,
CIM on Windows) or null. Omnyo's launcher uses the same probe to confirm a
recorded PID before stopping it. Storage & retention checks a development
instance's recorded launcher entry path and start time before signalling
it, so a reused PID is never killed. Confirm start-time precision per
platform and whether a combined verified-stop helper should replace it.

0. **Call timeout.** `ExperimentalHostCallOptions.timeoutMs` (default 30s,
   capped at 30 minutes) lets a plugin run a long host call — a setup
   script, a clone — as one call instead of a job it polls. Added for the
   worktree plugin; confirm the cap and whether the default should be
   declared per method on the contract instead.

1. **Contract shape.** Confirm Standard Schema values remain the right runtime
   boundary and decide whether method-specific typed errors are necessary.
2. **Targeting.** Confirm explicit host ids are enough for V1 and add an
   environment-aware primitive only alongside a plugin that proves its
   locking and workspace semantics.
3. **Process lifetime.** Measure whether five idle minutes is the right timeout,
   whether watches should continue retaining automatically, and whether leases
   acquired only during active handlers are expressive enough. Confirm there is
   no need for manifest lifetime flags, plugin-selected timeouts, a global
   worker limit, or plugin-specific restart policy. Confirm unexpected-exit
   notification is the right generic repair trigger, remains suppressed for
   graceful and idle disposal, and does not create crash loops.
   Verify reconnect generation reconciliation covers disable/uninstall during
   an outage without stopping a still-current worker on every transient drop.
4. **Signals and watches.** Confirm host signals should remain private,
   ephemeral invalidations rather than a durable event log. Audit native-watch
   coalescing, backpressure, rescan/error events, per-worker limits, and cleanup
   against a plugin that watches real workspace state.
5. **Paths.** Confirm the stable host data path layout and generation-temporary
   cleanup behavior across crashes and daemon restarts.
6. **Limits.** Audit the common call duration, startup/cancellation grace, 8
   MiB JSON payload cap, 256 MiB artifact cap, and per-plugin admission limits
   (256 active calls / 32 MiB of active inputs) against real plugins. Confirm
   retaining only the most recently materialized artifact digest per plugin is
   sufficient.
7. **Environment.** Confirm executable discovery through normalized `PATH`
   and stripping all daemon-owned `OMNYO_*` variables.
8. **Trust and dependencies.** V1 host plugins are trusted Node programs that
   may use `child_process`, filesystem, and network APIs. Decide whether later
   permissions, native artifacts, or an explicit dependency installer can be
   layered on without changing the RPC contract. Confirm rejecting all private
   `@omnyo/*` imports from host bundles is the correct permanent boundary, and
   audit the builder-supplied public SDK runtime against future host exports.
9. **Composition boundary.** Confirm host RPC methods and signals should remain
   private to the owning plugin while allowing another daemon subsystem to
   consume the same `omnyo.host` artifact through its own bootstrap and lifecycle.
10. **Test harness.** Audit both layers: the server harness's
    `experimental_callHostRpc` option, `experimental_hostEntry` option (a
    plugin whose manifest declares no `omnyo.host` entry, so the fake refuses
    `api.providers.register` and `experimental_aiServices.register` the way
    production does), `experimental_declaredIconNames` option (the names the
    manifest declares under `omnyo.branding.experimental_icons`, so the fake
    refuses a provider `icon` or a tool `presentation.icon.glyph` that names
    another plugin's icon or an undeclared one, with production's messages;
    the rule itself, `undeclaredIconProblem`, lives in the SDK's host policy
    and the server applies the same function at register and at ingest),
    `experimental_hostRpcCalls` inspection list, `experimental_emitHostWorkerExit`,
    and `experimental_emitHostSignal` behavior drivers; and the host-entry
    harness's `experimental_call`,
    `experimental_getSignals`, `experimental_getRetainedWorkerLeaseCount`,
    `experimental_lifecycleSignal`, path/watch options, and
    `experimental_dispose`. Confirm the host harness should
    continue simulating validation, cancellation, lifecycle, JSON, and size
    limits without pretending to model process startup, crashes, native watcher
    recovery, or reconnect behavior.

## Action history (`experimental_useActionHistory`)

**Experimental (2026-11-04).** One consumer: Canvas records board moves and
edits.

**What it does.** Gives plugins the app's single undo history. A plugin records
`{ label, undo, redo }` after a user action succeeds. Cmd+Z / Cmd+Shift+Z
(Cmd+Y on macOS, Ctrl+Y elsewhere) replay the newest entry from any source with
the same toast and error handling as chat actions. `canUndo` and `canRedo`
re-render through the history's subscription. Native text undo keeps priority
while the user is typing in a focused field.

**Audit before stabilizing.**

1. Entries are memory-only and survive plugin unmounts; decide whether a
   disabled or uninstalled plugin should drop its entries.
2. Decide whether entries need an owner scope (chat or plugin) for a future
   history menu.
3. Agent-authored changes are excluded by convention only; consider recording
   the actor.

## Fixed-tab targets (`experimental_target`, `experimental_useAppPanel`, and `experimental_useFixedTabTarget`)

**Kept experimental (2026-08-22).** `PluginNavPanelRegistration.fixedTabs` itself is stable (two shipped plugins plus the demo; host persistence tested). The target trio has one example consumer, and items 7–9 below (validator errors, target survival rules, a cross-thread surface) are unanswered.

**What it does.** Lets a nav panel declare ordered, non-closable tabs in the
host-owned right panel. The host owns tab selection, persistence, chrome,
Browser and Terminal tools. One tab is active per visible split pane, so
multiple fixed-tab components can be mounted concurrently; a component mounts
only while active in a visible pane and the panel is open. A fixed tab receives
the nav page's current `subPath`; `layout: "padded"` uses
host padding and scrolling, while `layout: "flush"` gives the component the
whole content region. On the first visit the first declared fixed tab opens on
wide layouts. A later user close remains closed. Every fixed-tab registration
must include a `panelId` matching its containing nav panel and is also its
stable, plugin-owner-and-panel-scoped reference. `experimental_useAppPanel()`
can select one of the calling plugin's eligible tabs on the current surface
and optionally submit a JSON-safe target. The tab's `experimental_target`
validator owns the target type and policy; `experimental_useFixedTabTarget()`
returns the validated current-session value with a sequence and explicit
`clear()`. Tab selection stays durable. Each tab's target remains memory-only,
but survives inactive-tab, closed-panel, and route remounts until its owner
clears it or the app refreshes. Core Changes targets and plugin targets resolve
through the same feature-agnostic controller.

**Public surface.** `ExperimentalFixedTabTargetContract`,
`ExperimentalPluginFixedTabReference` (the stable
`PluginFixedTabRegistration` / `PluginFixedTabDeclaration` carry the
`experimental_target` member through it), `ExperimentalAppPanelSurface`,
`ExperimentalFixedTabTargetState`, `ExperimentalOpenFixedTabOptions`,
`ExperimentalAppPanel`, `experimental_useAppPanel`, and
`experimental_useFixedTabTarget`. The frontend testing runtime mirrors this
with `ExperimentalFixedTabOpenCall`, the
`experimental_openFixedTab`/`experimental_fixedTabTarget` render options, and
the `experimental_fixedTabOpenCalls` inspection list.

**Audit before stabilizing.**

1. Confirm first-visit opening and subsequent close persistence across plugin
   reloads, app upgrades, wide/compact transitions, and page deep links.
2. Exercise multiple fixed tabs and dynamic registration changes; selection
   must remain stable when possible and fall back without mounting components
   that are inactive in every visible pane.
3. Confirm `subPath` is sufficient context and that fixed tabs should remain
   page-scoped rather than gaining independent routes or plugin-owned state.
4. Audit padded versus flush layout against Tasks, Docs, accessibility zoom,
   and nested scrolling before freezing the presentation contract.
5. Confirm named icon hints and the non-closable tab treatment remain the right
   amount of plugin-controlled chrome.
6. Audit registration objects as references: identity is scoped to the mounted
   plugin and current nav panel, with no cross-plugin addressing or global ids.
7. Confirm sync type guards remain the right owner validation contract and
   define error reporting if a validator throws or becomes stale after reload.
8. Exercise repeated equal targets, explicit clearing, crashes, inactive-tab,
   panel, and route remounts, refresh, and compact drawer animation. Targets
   must survive remounts in the current app session, never survive refresh, and
   never reappear after their owner clears them.
9. Decide whether a future cross-thread surface should navigate before opening;
   the initial public surface intentionally supports only `{ kind: "current" }`.
10. Keep core and plugin destinations on the same resolver and verify the
    controller never learns Changes, file, task, or document target shapes.

## `PluginNavPanelRegistration.experimental_sidebarAccessory`

**Kept experimental (2026-08-22).** one consumer (the tasks plugin); item 1 below (a narrower value/badge contract) would change the API shape.

**What it does.** Lets a nav panel register a no-props, presentational React
component for a live value beside its navigation entry. The component can own
an RPC query and realtime subscription, so a live count updates within that
subtree instead of lifting plugin state into the whole sidebar. The SDK
accepts the field, but no host surface mounts it, because the navigation rail
is icon-only.

**Audit before stabilizing.**

1. **Component versus value.** Confirm real consumers need component-owned
   live state, rather than a narrower string/number/badge value plus a separate
   host update primitive. Installed plugins are trusted, but a component can
   still render controls or markup that is inappropriate for row chrome.
2. **Budget.** Revisit the 4rem by 1.25rem cap against counts, short statuses,
   localization, browser zoom, and multiple plugin rows. Decide whether the
   host should expose a fixed badge treatment instead of accepting plugin
   styling.
3. **Host surface.** No host surface mounts the component. Decide where a
   live value belongs beside an icon-only rail destination (a badge, a
   tooltip, or nowhere) before stabilizing, or remove the field.
4. **Overflow and portals.** The wrapper clips ordinary descendants but cannot
   constrain content portalled elsewhere in the document. Confirm the
   presentational-only contract is sufficient, or enforce a non-component
   value before stabilization.
5. **Accessibility.** Accessory text is exposed beside the navigation button
   without changing that button's stable accessible name. Confirm that reading
   order and the focus-triggered accessory/options swap work for counts and
   short statuses, and decide whether a dedicated label prop or host-rendered
   status semantics are needed.

## `PluginContentScriptContext.experimental_setThreadRowSubtitle` and `PluginSidebarThread.experimental_subtitle`

An optional content-script setter accepts `{ text }` or `null` for an explicit
thread. The host trims and collapses whitespace and rejects blank or over-140
character text. Values belong to the frontend generation; the first active
owner wins, and disposing or deactivating that owner reveals the next value.

Core uses the same path: `useSidebarThreads` projects the owner-scoped store
into `PluginSidebarThread.experimental_subtitle`; the built-in thread-list
reads that field and renders a second line described by the existing row
anchor. Sticky parent rows omit it. No parallel core-only subtitle path exists.

The exported payload type is `ExperimentalThreadRowSubtitle`, following the
SDK's `Experimental*` convention for PascalCase experimental types. Runtime
members retain the `experimental_` prefix. Older hosts omit the setter/field;
plugins must feature-detect the setter and tolerate absent subtitle values.

Before stabilization, audit owner arbitration and replacement cleanup,
multi-window expectations, the 140-character limit and whitespace behavior,
sidebar density and sticky parents, and screen-reader descriptions without
changing the row link's accessible name. Current checks cover normalization,
older-host compatibility, store ownership, frontend cleanup, reactive sidebar
projection and the built-in row's description and sticky-parent omission.

## `PluginContentScriptContext.experimental_setThreadRowStatus`

**Kept experimental (2026-08-22).** kept: consumed by the collapsed-section
status rollup — `SidebarSectionRow` and `TopLevelSidebarSection` read the
app's thread-row-status store through `usePluginThreadRowStatusForThreads`,
so a hidden thread's plugin status reaches its collapsed section header. The
audit items below are unchanged.

Lets a plugin-lifetime content script set or clear one of its own status
indicators on an explicit thread row. The status survives route changes and is
cleared automatically when that frontend generation deactivates.

Before stabilization, audit:

- whether explicit thread targeting belongs on content-script context or a
  dedicated app-level controller;
- multiple simultaneous runs owned by one plugin on one thread;
- arbitration across plugins, frontend generations, and native thread
  statuses;
- persistence expectations across full app reloads and multiple windows;
- validation, accessibility labels, reduced motion, and cleanup on plugin
  reload/disable/removal;
- the name of `PluginComposerThreadRowStatus.tone`. The field is a state the
  plugin reports (`default | running | success | error`), not a tone: the host
  maps it to both a color and an animation (`running` pulses in the success
  color; `success` and `error` are static; omitted is muted). `state` is the
  candidate rename. Nothing under `plugins/*` sets a status today, so the
  rename is free until the prefix drops.

## `api.providers.register` (`experimental_bridgeOptions`, `experimental_visibility`, and the `experimental_providerBridge` artifact export)

**Kept experimental (2026-08-22).** `api.providers.register` and the declaration's target-state fields are stable. `experimental_bridgeOptions` and `experimental_visibility` have one consumer (the ACP plugin); docs/provider-plugin-api.md §1 lists both under "Still experimental on the declaration" — decide whether static options survive beside `deriveProviderOptions` before naming them. The `experimental_providerBridge` export name is an artifact contract read by the daemon bootstrap from every installed plugin; renaming it needs a dual-name acceptance window plus a protocol bump, so it stabilizes with the bridge kit once that deprecation policy exists.

**What it does.** Lets a plugin declare an agent provider into the server's
`ProviderRegistryService`. The declaration owns static metadata and opaque
bridge options; executable behavior is the bridge the plugin exports from its
`omnyo.host` artifact. Registering without one fails the plugin load. The
declaration is
validated at call time by the shared host policy
(`validatePluginProviderDeclaration`); registrations stage during the factory
and commit when the plugin load commits, are replaced wholesale on reload, and
are removed by the returned disposer or on unload/disable. Declarations are
the ONLY source of providers — the core catalog seed is deleted, so disabling
a provider plugin removes its provider. A registered provider is mapped onto
exactly one client shape, `ProviderInfo`, plus the backend-only
`ProviderServerCapabilities`, and appears in the composed provider listing
(`GET /system/providers` / execution options). `api.providers` is the namespace
(`api.agents` keeps `configure`, `registerTool`, `contributeInstructions`).

Ids are flat and first-wins: a live id collision fails the later plugin's
load, and no id is reserved ahead of time (`RESERVED_PROVIDER_ID_OWNERS` is
gone). Listing order is plugin install order — bundled first-party plugins
rank first, in their bundled-list order, then every other plugin by install
time — under the user's `providerOrder` / `defaultProviderId` app settings
(`PRODUCT_PROVIDER_ORDER` and `PRODUCT_DEFAULT_PROVIDER_ID` are gone).
`experimental_visibility: "installed"` withholds a provider from unscoped
listings until its own `provider/health` result is not `not_installed`.
`experimental_bridgeOptions` is validated as bounded JSON, rides every daemon
bridge launch, participates in the runtime process key, and arrives at the
bridge as provider-scoped static options. Core does not interpret its keys.

**Audit before stabilizing.**

1. **Install-order ranking.** Bundled plugins rank by their position in
   `BUNDLED_PLUGINS`; other plugins by `installedAt`. Confirm that a
   reinstalled builtin (tombstone then reinstall) keeping its bundled rank is
   right, and that `installedAt` is the fact users expect for third-party
   order (vs. first-load time). The user overlay (`providerOrder`) is an
   ordered id list that ignores unknown ids; decide whether stale ids should
   be pruned on write.
2. **Icon URL shape.** `icon` uses the `omnyo.branding.icon` grammar (a named host
   glyph, or a `./`-prefixed plugin-relative SVG) plus the plugin's own
   declared icons as `"<pluginId>/<name>"` (`omnyo.branding.experimental_icons`;
   a foreign plugin id or an undeclared name is refused at the register
   call). A path, or a declared icon's bytes, is snapshotted at registration
   and served from `/api/v1/system/providers/<id>/logo`; a host glyph name
   yields a null `logoUrl` and no server-side resolution at all. Decide
   whether the host should resolve declared glyph names for providers the way
   it does for plugin branding, and decide the logo route's cache policy,
   before either freezes into clients.
3. **Collision semantics.** Ids are first-come collision-rejected: a staged
   collision fails the whole plugin load; a post-activation registration
   throws to the plugin. With reservation gone, a disabled first-party plugin
   leaves its id claimable by anyone until it is re-enabled (which then fails
   to load). Confirm first-wins is right across plugin load order, and decide
   whether a namespace rule (plugin-scoped id prefixes) is wanted before
   third-party ids proliferate.
4. **Bridge delivery.** A provider bridge is a second consumer of the
   plugin's `omnyo.host` artifact: it is exported by name
   (`experimental_providerBridge`), built into `dist/host.js`, recorded in the
   one live-host-artifact registry, served by the one host artifact route, and
   cached once per plugin on the daemon. Thread commands carry `bridgeLaunch
{pluginId, source: {kind: "artifact", digest, byteLength}, envPassthrough}`.
   Every provider, first-party or not, arrives as an artifact (there is no
   daemon-bundled bridge since pi moved to its plugin). Before stabilizing:
   confirm one artifact per
   plugin survives (a plugin declaring several providers today ships one bridge
   for all of them, and there is no way to name a second), confirm the
   single-bundle shape survives per-platform needs, and decide whether a
   router-kind declaration — a picker entry resolving to another provider at
   submit time, removed from the contract because nothing ever resolved one —
   returns as its own surface.
5. **What a capability may be.** `supportsHostAiServices` was removed after
   shipping: it declared that Omnyo's voice-transcription and structured-inference
   features could route through the provider, which is a fact about the daemon
   bundle rather than about the provider. `supportsWorkflows` went the same
   way in WS2a: whether a session may use the Workflow tool is the Claude
   plugin's own knob (its `workflowsDisabled` setting, derived into
   `providerOptions`), not a fact core needs. Apply the same test to every
   remaining capability before stabilizing: a declaration may assert what the
   provider itself implements and an external consumer needs pre-session,
   never what Omnyo or its daemon can do with it.
6. **Static bridge options and visibility.** Confirm 64 KiB remains a suitable
   declaration-time limit, that opaque options should continue to be shared by
   every host rather than resolved per host, and whether deep-frozen plain JSON
   is the right stable value contract. Confirm `"always" | "installed"` is
   enough listing policy, that health failure should continue to hide an
   installed-only provider, and that targeted requests may continue resolving
   a registered provider even while discovery says it is absent.

## `@omnyo/plugin-sdk/provider-bridge` (the provider-bridge authoring surface)

**Kept experimental (2026-08-22).** `experimental_defineProviderBridge` / `experimental_apiVersion` are an artifact↔daemon contract (the bootstrap refuses anything but version 1 by name), and the deprecation window between independently-updating artifacts and daemons (item 4) is undecided.

**What it does.** The published module a provider bridge compiles against. A
bridge ships inside its plugin's `omnyo.host` artifact, and a host artifact may
not import private `@omnyo/*` workspace packages, so everything a bridge needs is
named here: `experimental_defineProviderBridge` (the export shape the
daemon-side bootstrap looks for), the Provider Bridge Protocol's method
vocabulary, the `thread/delta` grammar, and param schemas, the bridge kit's
authoring helpers (JSON-RPC framing, tool-call and interaction codecs,
visibility, dialect-parsing helpers), and the `@omnyo/domain` command-plane
vocabulary those params reference.
Curated by hand — named exports only, never `export *`. Unlike
`@omnyo/plugin-sdk` and `@omnyo/plugin-sdk/host`, it is NOT a build-time
runtime stub: it is pure schema and helper code with no daemon-pinned
behavior, so a provider plugin depends on the SDK for real and the artifact
build inlines the SDK's published, self-contained bundle.

**Audit before stabilizing.**

1. **Resolved (Aug 2026, the narrow-grammar cutover): the protocol owns its
   own timeline vocabulary.** Bridges no longer construct `ThreadEvent`s —
   they emit the protocol's own `thread/delta` grammar and the runtime's
   assembler constructs every canonical event — so the `@omnyo/domain` event
   vocabulary (`ThreadEvent`, the item types, `threadScope`/`turnScope` and
   the scope helpers) left the surface with the kit's assembly machinery
   (turn-state registry, scoped-item-ids, accepted-user-messages, item
   constructors, unhandled-event builders). What still comes from
   `@omnyo/domain` is deliberate and consumed by bridges today: the
   command-plane and interaction surface the protocol's params are made of
   (`PromptInput`, `PendingInteraction*`, `DynamicTool`,
   `RuntimePermissionPolicy`, permission/reasoning/service-tier values,
   rate-limit state, workflow snapshots) plus the enum/status types the
   delta shapes reference (`ThreadEventItemStatus`, `ThreadEventTurnStatus`,
   `ThreadEventPlanStep`, `ThreadEventTokenUsageBreakdown`,
   `ThreadEventContextWindowUsage`, `ThreadEventUserContent`). Those are
   shared server/app/runtime contracts, so the facade re-export (bundle
   inlining, `@omnyo/domain` staying private) is the permanent answer for
   them.
2. **Surface size.** 184 names after the cutover (was ~190, then ~216 with
   the delta grammar added, then the assembly surface deleted: the
   turn-state/scoped-id/accepted-message/constructor helpers, the orphaned
   `buildEditDiff`/`withParentToolCallId`, and the unconsumed domain
   re-exports came off). Single-consumer
   repatriation done (Aug 2026): `extractEnvOverrides` and
   `getMessageContentTypes` moved into the claude-code plugin,
   `normalizePendingInteractionRequestedPermissionProfile` (whole
   `pending-interaction-normalization` module plus test) into the codex
   plugin, and the `cloneReasoningEfforts` helper out of `@omnyo/domain` into
   claude-code's model catalog. The other named candidates turned out not to
   be movable: they are `@omnyo/domain`/protocol definitions with core consumers
   — the `acp*Cli`/`acpNativeReasoning` schemas are parsed by the ACP launch
   spec and config, and the workflow snapshot types are rendered by the app.
   The `claudeTaskTool*` schemas lost their last core consumer when the
   claude-code plugin took over its task vocabulary, and the
   `hostDaemonAcpLaunchSpec*` pair stopped being a wire shape at protocol
   155; both stay on the facade only as scheduled removals (above). The
   surface is still large; any further shrink is a per-name product
   decision, not a mechanical move.
   A follow-up de-overfitting pass (Aug 2026) then unwound the kit's
   over-general helpers: `buildToolUseItem`'s parser-callback router became
   per-provider switches over plain constructors (`buildFileChangeItem`,
   `buildGenericToolCallItem`); the generic session registry was split into
   `createPendingToolCallTracker` plus consumer-owned session maps;
   claude-code stopped borrowing codex's `shell_environment_policy` namespace
   (`buildShellEnvironmentPolicyConfig` now lives in provider-codex,
   `diffCumulativeText` in pi); the zero-consumer native tool-call decoder,
   the `finishOpenProviderTurn` wrapper, and the per-consumer flags
   (`completeWebItems`, `preserveUndefinedToolCallFields`) came off the
   surface; and the shared accepted-user-message drain folded into the
   turn-state registry core.
3. **Resolved (stabilization S2): the ACP launch spec is the ACP package's
   own.** `acpLaunchSpecSchema` moved out of `@omnyo/host-daemon-contract` into
   `@omnyo/provider-bridge-acp` and left this root entry; provider-scoped static
   options are opaque to Omnyo, and the shape is owned by the bridge that parses
   it and the plugin that stores it.
4. **`experimental_apiVersion` 1.** The bootstrap accepts version 1 only and
   refuses anything else by name. Decide the deprecation window for a version
   bump (a plugin's artifact and the daemon update independently) before the
   first third-party bridge ships.

## `@omnyo/plugin-sdk/provider-bridge/testing` (the provider-bridge testing kit)

**Kept experimental (2026-08-22).** items 3 and 6 below change the public shape (a pluggable replay child, pinning a grammar version in the exports).

**What it does.** The published kit a bridge author proves a bridge with
before shipping it, with no private `@omnyo/*` package in reach: the
conformance kit (`experimental_runBridgeConformance`,
`experimental_formatConformanceReport`) that drives a bridge through the
canonical protocol scenarios — the transport hands it raw wire messages
(`send` + `takeMessages`), the run names the bridge's `providerId`, and the
kit assembles every `thread/delta` batch itself, reverse-maps the turn ids
it names to the bridge, and releases the session it opened at the end; the
real delta assembler (`experimental_createDeltaAssembler`,
`ASSEMBLER_GRAMMAR_VERSIONS`) — the exact code the daemon runs, so a test
sees the canonical `ThreadEvent`s the runtime would build from the bridge's
`thread/delta` stream; the delta→event collector that feeds captured
notifications through it (`experimental_createBridgeDeltaEventCollector`,
`experimental_assembleCapturedThreadEvents`); the in-process JSON-RPC harness
(`experimental_captureBridgeJsonRpcOutput` with its `takeMessages` drain,
`experimental_createBridgeJsonRpcTestHarness`); the calibration
normalizer (`experimental_normalizeCalibrationEvents`,
`experimental_describeCalibrationEvents`); and the recorded-replay harness —
the regression oracle the first-party bridges use, keyed by the caller's
provider id and bridge module rather than a list of Omnyo's providers:
`experimental_resolveProviderBridgeLaunch` (the bridge process as the
runtime spawns it, through the bootstrap the kit ships beside its bundle),
`experimental_replayRecording` (the recorded runtime lane in, the recorded
provider lanes played by the kit's replay child, the bridge's output
assembled), `experimental_assembleRecordedEvents`,
`experimental_compareParity`, `experimental_checkRecordedCellReplay` (the
recorded-cell conformance verdicts), `experimental_rerecordCurrentBridgeLane`
(the bridge's current output written beside a recording that is never
rewritten), and the recording readers (`experimental_readBridgeRecording`,
`experimental_listRecordedCells`, `experimental_withCurrentBridgeLane`).
Framework-agnostic (the stdout capture patches `process.stdout.write`
itself; nothing imports a test runner). Curated by hand, named exports only.
The echo example and every first-party bridge suite import only this entry
and `@omnyo/plugin-sdk/provider-bridge` — the "zero first-party privilege"
proof for the testing surface. In-repo the kit is `@omnyo/provider-bridge-
protocol`'s `assembler`, `conformance`, and `testing` subpaths.

**Audit before stabilizing.**

1. **Calibration normalizer scope.** `experimental_normalizeCalibrationEvents`
   interns the id fields the first-party goldens needed
   (`turnId`, `itemId`, `id`, `parentToolCallId`) and drops
   `providerCheckpointId`. Confirm the defaults against a third-party
   bridge's goldens before fixing them.
2. **Surface size.** 24 value exports plus 57 types (the eight no consumer
   used — the conformance client and opens-before-delta check, the cumulative
   text differ, the parity value/event/row normalizers, the cell replayer and
   the bootstrap path resolver — came off in the stabilization audit; the
   three of those that 0.4.15 had published are named in the "Removed
   outright" bullet of the compatibility windows above, the other five never
   shipped. The assembled-event lane the transport once fed went when the
   kit took over the assembly: `experimental_toConformanceMessages` is
   removed (compatibility windows above) and
   `CONFORMANCE_ASSEMBLED_EVENT_METHOD` is a scheduled removal).
   The JSON-RPC harness duplicates a little of the bridge kit's envelope
   parsing; fold or keep deliberately.
3. **Replay profile shape.** `ReplayProviderProfile` is the three seams the
   first-party bridges needed (`env`, `rewriteRuntimeLine`, `prepareState`)
   and `ReplayDialect` is the three protocols the replay child speaks
   (`json-rpc`, `claude-cli`, `pi-rpc`). A third-party bridge whose CLI
   speaks none of them cannot replay its provider lanes. Decide whether the
   dialect set grows, or whether the child becomes pluggable, before the
   profile is a promise.
4. **Two shipped programs.** The kit's bundle spawns `provider-bridge-worker-entry.mjs`
   and `replay-provider-child.mjs` from beside itself (`import.meta.url`),
   so the published package carries both under `dist/`. Confirm the bundled
   bootstrap tracks the daemon's (`apps/host-daemon/scripts/bundle-manifest.mjs`
   builds the same entry) — a drift would make a replay differ from
   production in argv or framing.
5. **Workspace-path restoration.** `experimental_replayRecording` rewrites
   this replay's temp workspace back to the recorded `cwd` in every line the
   bridge emits, so a bridge that derives paths from `cwd` compares with the
   recording. It is a textual substitution of a unique temp path; confirm
   no bridge emits that path in a form the substitution misses (URL-encoded,
   JSON-escaped backslashes on Windows).
6. **The canonical event vocabulary by name.** The kit exports `ThreadEvent`,
   `ThreadEventItem`, `ThreadEventItemPresentation` (+ its label, icon and
   tint parts) and the named item kinds (`ThreadEventDelegationItem`,
   `ThreadEventExtensionItem`, `ThreadEventFileReadItem`,
   `ThreadEventSearchItem`, `ThreadEventPlanStepsItem`,
   `ThreadEventWebSearchItem`, `ThreadEventWebFetchItem`,
   `ThreadEventBackgroundTaskItem`) as types, re-exported from `@omnyo/domain`
   and inlined into the bundled declarations. Before this a plugin test named
   the event type as `ReturnType<BridgeDeltaEventCollector["assembleMessage"]>[number]`.
   They are types only: a bridge never constructs an event (the assembler
   does), so no `experimental_` value ships with them. Audit: the persisted
   vocabulary now has a second public home beside `ProviderInfo` on the root
   entry; a breaking change to an item shape is a breaking change to the kit.
   Decide whether the kit should pin a grammar version in its exports (the
   assembler already names `ASSEMBLER_GRAMMAR_VERSIONS`) before stabilizing.

## `experimental_scanPublicSdkOnly` (`@omnyo/plugin-sdk/testing`)

**What it does.** Scans a plugin package for imports outside the public SDK:
walks every `.ts`/`.tsx`/`.js` file below the package root (skipping
`node_modules` and `dist`), and returns the files it read, each import
specifier that is a private `@omnyo/*` package or falls outside the allowlist —
`@omnyo/plugin-sdk` and its published subpaths, `zod`, `node:` built-ins,
relative paths that stay inside the package root, plus the public packages
the plugin names in `allow`; test files may add the published testing
subpaths and `vitest` — a relative path that resolves outside the package
root (`outside-package`, unless an `allow` pattern names it), an `import()`
or `require()` whose argument is not a string literal (`dynamic-specifier`),
and the `@omnyo/*` names in the package.json dependency blocks. It returns data
and imports no test runner; the suite asserts on it. The echo-provider
example and the first-party ACP plugin run it over themselves: inside Omnyo's
monorepo a `@omnyo/*` import still typechecks and runs, and a relative path can
climb into a private package's source, which is exactly why it needs a test.

**Audit before stabilizing.**

1. **The allowlist is Omnyo's.** The default admits every published SDK subpath
   and `vitest`; a plugin on another runner or another schema library must
   name it in `allow`. Decide whether the defaults should read the plugin's
   own package.json dependencies instead of a fixed list.
2. **Regex import extraction.** Specifiers are found by a regular expression
   over the source (`from "…"`, `import("…")`, `require("…")`), not a
   parser; an `import()`/`require()` whose argument is not a string literal
   is reported as `dynamic-specifier` rather than read, a string literal
   split across lines is missed, and a string that merely looks like an
   import (in a comment, say) is reported. Decide whether a parser is owed
   before the scan is a promise.

## `app.experimental_useProviders` (`@omnyo/plugin-sdk/app`)

**Kept experimental (2026-08-22).** the hook returns `ProviderInfo`, which carries the unresolved `icon` / `logoUrl` pair and `maintenance` (the pre-stabilization booleans an earlier draft served beside it were withdrawn before release; see "Removed outright" above); stabilizing the hook freezes that shape.

**What it does.** The provider directory for plugin frontends: `{ status,
providers }` where `providers` is the host's own `ProviderInfo[]` roster in
picker order (the same query the composer's provider groups read, shared cache,
realtime invalidation). Pairs with the backend `api.sdk.providers.list()`. It
exists so that a plugin showing a thread's provider (tasks, automations,
provider-retry) stops vendoring provider names, icons, and copy.

**Audit before stabilizing.**

1. **Routing.** The hook reads the primary-host roster (no `environmentId` /
   `hostId` argument), so installed-only providers of another machine are not
   listed. Decide whether plugins need host-scoped listing before freezing the
   signature.
2. **Icons.** Every provider Omnyo ships now declares an SVG asset, served as
   `logoUrl` and drawn by the host as a `currentColor` mask (core vendors no
   brand marks), and a provider that declared a named glyph (`icon: "Zap"`)
   arrives as `icon: { glyph }` beside `logoUrl` (at most one of the two is
   set). Decide whether `icon` and `logoUrl` fold into one
   `{ glyph } | { url }` field — the presentation's `{ glyph }` form, where a
   glyph is a host name or `"<pluginId>/<name>"`, is the declaration-side
   precedent — when `ProviderInfo` stabilizes, and whether the mask rendering
   (monochrome by construction) is the contract or a full-color logo path is
   owed.

## `app.experimental_useCodeTheme` (`@omnyo/plugin-sdk/app`)

**What it does.** Returns `{ mode, name, theme }`: the app's active light/dark
mode, the registered name of the code theme Omnyo renders that mode with, and the
resolved VS Code theme document behind it (`type`, `fg`, `bg`, `colors`,
`tokenColors`) — the same document Omnyo's own highlighter paints from. It exists
for plugins that render code with an engine of their own (the Monaco file
editor is the first): without it, an embedded editor can only follow
light/dark and strands its syntax colors on a palette Omnyo is not using.
`theme` is null only before the first resolve, and holds the previous document
while a palette switch resolves, so a consumer never paints an unthemed frame.

**Audit before stabilizing.**

1. **Shape of the document.** `PluginCodeThemeData` mirrors Shiki's
   `ThemeRegistrationResolved` minus the fields Omnyo does not promise
   (`semanticTokenColors`, `include`, `displayName`). Decide whether freezing a
   Shiki-shaped payload is right, or whether the contract should be Omnyo's own
   normalized token model — a Shiki major that changes `settings` normalization
   changes what plugins receive.
2. **Both modes at once.** The hook serves only the active mode. An editor that
   wants to prebuild its light and dark themes has to toggle to see the other.
   Decide whether the state should carry the pair.
3. **Where the resolve happens.** Resolution runs in the app window through a
   dynamic `@pierre/diffs` import and caches per theme name for the window's
   lifetime; a custom palette edited on disk keeps its old document until
   reload, because the versioned wire name only changes when the server
   re-resolves. Confirm that matches what the built-in surfaces do.
4. **Consumer count.** One consumer today. Confirm a second engine (CodeMirror,
   xterm) needs the same payload before the prefix drops.

## `app.experimental_getNativeFileResolver` (`@omnyo/plugin-sdk/app`)

**What it does.** Returns the Omnyo desktop client's native File resolver, or
null when that capability is absent. `resolve(files)` preserves order and
returns a directory or regular file with its absolute client-local path, or null
for a File without disk backing. Older desktop clients can omit a regular-file
path. Core keeps a regular file local only when the selected execution host
matches the connected local daemon; other hosts use a cancellable upload within
the 35 MB file limit, checked before reading or sending bytes. JavaScript-created
Files cannot choose a native path. This is File possession, not a fresh-gesture
check or an execution-host identity claim. Native admission/stat errors reject;
callers must not fall through to server clipboard access or another resolver.

Core composer paste and drop use `apps/app/src/lib/native-files.ts`, the same
implementation exported to plugins. Folder Paste delegates native-capable
composer behavior to core and retains its existing local macOS browser mode
only when the native capability is absent. Desktop resolution works with the
selected remote app origin; only its registered top frame can invoke bounded
native stat, and navigation/server changes invalidate pending results. No
clipboard contents, filesystem contents, descendants, or host RPC are read.
The SDK test renderer truthfully returns null rather than emulating native Files.

**Audit before stabilizing.** Verify the actual Finder gestures separately from
native file-URL clipboard and compositor-input evidence. Verify Linux and Windows
File backing before claiming those platforms. Keep the nullable capability and
native rejection semantics explicit. Preserve mixed Files, copied-message and
large-text paste, caret, draft/selection guards, and disposal behavior across core
and plugin consumers. The CLI equivalent remains explicit path text through
`omnyo thread tell` or `api.sdk.threads.send`; a remote CLI cannot acquire this
client-local browser File capability.

## `app.experimental_copyToClipboard` (`@omnyo/plugin-sdk/app`)

**What it does.** `experimental_copyToClipboard({ text, html? })` writes the
system clipboard through `copyToClipboard`, the function Omnyo's own copy
actions call. It is a plain function, not a hook, so components, content
scripts, setup code, and command callbacks all call it the same way. Omnyo
Desktop writes through Electron's main-process clipboard, so a copy works
without document focus, transient activation, or a secure origin; a Desktop
build without the bridge, or a rejected bridge write, falls through to the
browser path: the Clipboard API (`write` with a plain and HTML item when
`html` is set, otherwise `writeText`), then `execCommand("copy")` with the
content set on the copy event. The promise resolves true only once some path
wrote the content, so a copy command that reports success without writing is
a failure. It never rejects. Callers own their toasts and fallback UI. Thread
list, Plugin Guide, GitHub, Docs, File Editor, Omnyo connect, Account Pooler, and
Storage retention copy through it.

The test harness replaces it with a fake clipboard. Writes are recorded in
the most recently rendered slot's `inspection.experimental_clipboardWrites`,
and resolve with that slot's `experimental_copyToClipboard` render option, or
true when it is omitted or no slot has rendered.

**Audit before stabilizing.**

1. **Content shape.** Only plain text and HTML are supported. Omnyo's message
   copy also writes an image, through its own path with Android and browser
   variants. Decide whether images belong in this contract or stay core-only.
2. **Harness scoping.** The clipboard is global, so the harness routes writes
   to the most recently rendered slot. Confirm that is enough for tests that
   render several slots, and decide whether content-script tests need their
   own capture.
3. **Desktop bridge failures.** A rejected bridge write falls through to the
   browser paths, which can then fail for the reasons the bridge avoids.
   Confirm on Linux Wayland and X11 that the bridge write lands.
4. **Feedback.** Every caller pairs the result with a toast or a manual-copy
   fallback. Decide whether a shared toast helper belongs in the SDK.

## `app.experimental_usePluginId` (`@omnyo/plugin-sdk/app`)

**What it does.** Returns the id of the plugin that owns the calling component,
the same value `api.pluginId` gives the plugin's server. The id comes from the
package name, so a plugin that keys browser-side state by it (a localStorage
mirror, log prefixes) keeps working unchanged when someone copies it and
publishes the copy under another name, instead of sharing or clobbering the
original's state. The Thread list plugin is the first consumer: its
preferences mirror key and log prefixes come from this hook. The test harness
returns `renderSlot`'s `pluginId` option, `test-plugin` by default.

**Audit before stabilizing.**

1. **Hook or setup value.** Code that runs in `definePluginApp`'s setup, not
   in a component, cannot call a hook. Decide whether the builder should carry
   the id as well, or instead.
2. **Scope.** The hook throws outside a plugin slot component, like the other
   SDK hooks. Content scripts already receive `context.pluginId`; confirm no
   other frontend entry point needs it.
3. **Consumer count.** One consumer today. Confirm a second plugin needs it
   before the prefix drops.

## `app.experimental_useQuestionFormHost` (`@omnyo/plugin-sdk/app`)

**What it does.** Returns the answer shortcuts Omnyo binds while a pending
interaction is open (`question.select.1` and on, which users can remap), keyed
by zero-based option index, and `registerChoiceHandler`, which receives the
index a person chose with a shortcut while the thread's pane is focused. A
`pendingInteraction` component shows each option's shortcut and decides what
choosing it means. Outside a pending interaction the map is empty and handlers
never run; the test harness returns that empty host. The registry's
`question-form-host` item re-exports it as `useQuestionFormHost`, so the
registry's `question-form` works in any plugin. Before this, the built-in Ask
User Question and pi plugins reached the same host context through a private
`@omnyo/shared-ui` module the build shimmed, which a copy of either plugin could
not import.

**Audit before stabilizing.**

1. **Props or hook.** The host already renders the pending-interaction slot;
   decide whether the shortcuts belong in `PluginPendingInteractionProps`
   instead of a hook any component can call.
2. **Scope.** Only pending interactions bind the shortcuts. Confirm no other
   surface (a message action form, a panel) should get them.
3. **Consumer count.** Two first-party consumers (Ask User Question, pi's
   extension dialogs). Confirm a third-party form needs it before the prefix
   drops.

## `app.slots.experimental_providerIcon` (`@omnyo/plugin-sdk/app`)

**Kept experimental (2026-08-22).** zero shipped registrations — first-party
agent, environment, and machine providers use declared glyphs or SVG assets,
and the provider catalogs' `glyph` / `logoUrl` icon metadata covers both forms
without a frontend bundle; the remaining questions concern bundle loading cost
and rendering behavior.

**What it does.** Lets a plugin frontend supply the React component Omnyo draws
as one agent, environment, or machine provider's icon: `{ providerKind, providerId, icon }`,
where `icon` receives only the host's `className` (sizing; agent providers also
have the declared `strings.iconTint`). The component wins over the provider's
served `logoUrl`, which the host otherwise draws as a `currentColor` mask.
Registrations target a provider kind and id. Omitted kinds in older plugins
normalize to all kinds; exact-kind matches take precedence over all-kind matches.
Persistent machine labels draw a laptop directly and bypass the slot. Existing
environment reuse, sidebar, and metadata rows still resolve only built-in glyphs;
those rows bypass both asset URLs and the slot.
Registrations are replaced wholesale with the rest of the plugin's slot set,
so disable/uninstall/failed reload falls back to `logoUrl`, then the declared
glyph, then the generic glyph. No provider Omnyo ships registers the slot: each
uses a declared glyph or SVG asset, which stays available without a frontend
bundle (an icon-only bundle cost four JS+CSS fetches and four icon remounts at
every boot).

**Audit before stabilizing.**

1. **Scoping and overrides.** `providerKind` and `providerId` select the target;
   cross-plugin icon overrides are allowed. Within each kind/id pair, the first
   claim by sorted plugin id wins and later claims warn. Verify kind isolation,
   specific-over-all precedence, and fallback after unload before stabilizing.
2. **Bundle size and boot ordering.** An icon now costs a frontend bundle: a
   provider plugin that previously shipped only a server entry pays esbuild +
   Tailwind on install and an extra module fetch, and the served logo covers
   the window before the bundle loads. That window is the whole session until
   a thread of the plugin's provider is opened, one of its forms is requested,
   or its panel route is visited: a provider plugin's bundle is deferred as a
   whole, so the icon (like every other slot the bundle registers) is absent
   from the picker and the sidebar at boot. The first-party provider plugins
   dropped their icon-only bundles for exactly this reason. Confirm the cost
   is acceptable for third-party icon-only plugins, or add a lighter delivery
   path (e.g. a declared inline SVG string sanitized by the host) before
   freezing the shape.
3. **Disposal and identity.** The icon component is resolved through a cached
   host wrapper keyed by provider id and `logoUrl`; the wrapper subscribes to
   the slot store so a disposed registration falls back mid-render. Audit that
   a crashing plugin icon is contained the way other slot components are (it
   renders inside host chrome, sometimes outside a slot error boundary), and
   that no host surface caches the resolved component across a reload.
4. **Rendering contract.** The host promises only `className` and expects
   inline markup. Decide whether to enforce that (no fetches, no portals, no
   interactive content) before plugins rely on richer components, and confirm
   the accessible label story: the host derives `ariaLabel` from its own
   provider data, falling back to the provider id, and the slot supplies none.

## `experimental_ProviderModelPicker` (`@omnyo/plugin-sdk/app`)

**What it does.** Exposes Omnyo's execution picker as a controlled
`{ providerId, model, reasoningLevel, serviceTier? }` component for plugin
frontends. The host adapter reuses `useThreadCreationOptions` for catalog,
fallback, reasoning reconciliation, service-tier capability, retired-model,
branding, and model-projection policy, and renders the same
`ModelReasoningPicker` used by first-party composers. The picker lists every
provider's models in one grouped list, with each model's reasoning levels as
cells. A cell, a model name, or a favorite emits
one complete value from that provider's verified catalog and closes the
picker, through the same tuple path the composers use; a model name lands on
the current level or the closest supported one. The service tier is
reconciled with `reconcileServiceTier` and omitted when the provider has no
tiers. The user's `modelPicker.favorites` and `modelPicker.hiddenModels`
preferences apply as in the composer; unavailable favorites stay disabled with
a reason and never emit. The component keeps its single trigger and never
shows the composer's favorites switcher. `routing` can target one enrolled
host or an existing environment;
omitting it uses primary-machine routing. `disabled` renders the same summary
without opening the picker. Verified catalogs fill an empty selection and
reconcile supported reasoning levels and service tiers. A selected model missing
from the catalog stays selected until the user explicitly chooses a replacement.
Placeholder, failed, and empty catalogs leave the controlled value unchanged.
`allowProviderChange={false}` shows only the controlled provider's group and
the favorites for that provider, while retaining model, reasoning, and
service-tier selection. Routing
never implies provider locking: an environment supplies host/workspace context
and can run more than one provider. `align` optionally places the popover at
the trigger's `"start"`, `"center"`, or `"end"` edge and defaults to
`"start"`.

Tasks delegation presets and Automations agent execution both use this
component end to end. They persist the same tuple and pass it to
`api.sdk.threads.spawn`; neither plugin exposes a parallel catalog RPC.
Core's Settings → Providers → Model picker uses the same component to choose a
favorite before Add.

Implementation: `apps/app/src/components/plugin/PluginProviderModelPicker.tsx`,
bound in `apps/app/src/lib/plugin-sdk-app-impl.tsx`.

**Audit before stabilizing.**

1. **Atomic controlled contract.** Confirm the four execution fields should
   remain one value and that one click should emit the complete tuple and
   close, including for another provider's cells and favorites.
2. **Routing.** Omitted `routing` follows the server's primary-machine routing;
   `{ kind: "host", hostId }` and `{ kind: "environment", environmentId }`
   cover machine- and workspace-dependent catalogs. Confirm those two routes
   are sufficient before stabilizing the discriminated union.
3. **Capability policy.** Confirm an unsupported provider should omit
   `serviceTier` while supported providers retain the controlled tier, and that
   reasoning should continue using the composer's closest-supported policy.
4. **Catalog failure and normalization policy.** Placeholder, failed, and empty
   catalogs never change the controlled value. A verified catalog fills an empty
   selection and reconciles supported reasoning and tiers. Missing and
   selected-only retired models stay selected until an explicit replacement.
   Confirm those boundaries match the composer's explicit-fallback policy.
5. **Scope.** Validate settings and compact-form usage in external plugins,
   especially whether they need an explicit loading/error callback. Tasks and
   Automations currently rely on the picker-owned loading/error UI. Environment,
   permission, and prompt submission stay separate controls. Confirm plugin
   pickers should keep honouring the user's favorites and hidden models instead
   of accepting their own lists.

## `experimental_PermissionModePicker` (`@omnyo/plugin-sdk/app`)

**What it does.** Exposes Omnyo's permission picker as a controlled
`{ providerId, value, onChange, routing?, align?, disabled?, className? }`
component. `align` accepts `"start"`, `"center"`, or `"end"` and defaults to
`"end"` for compatibility with the prompt-row placement.
The host adapter reuses `useThreadCreationOptions` and `PermissionModePicker`,
so supported modes, fallback order, compact labels, and the routed machine's
permission ceiling are identical to the composer. It displays modes above the
ceiling as disabled with the host explanation, renders a locked summary for a
provider with one mode, and emits a corrected mode when an authoritative
provider/routing change invalidates `value`. Placeholder, loading, and failed
lookups never mutate the controlled value.

Tasks delegation presets and Automations use this component beside
`experimental_ProviderModelPicker`; their frontend bundles no longer read the
provider directory or implement permission reconciliation. Server-side spawn
and update validation remains authoritative.

Implementation: `apps/app/src/components/plugin/PluginPermissionModePicker.tsx`,
bound in `apps/app/src/lib/plugin-sdk-app-impl.tsx`.

**Audit before stabilizing.**

1. **Controlled reconciliation.** Confirm automatic `onChange` after an
   authoritative capability/ceiling change is preferable to a separate
   invalid-state callback, and that provisional failures should remain
   read-only without changing the caller's value.
2. **Routing and provider coupling.** Confirm requiring both `providerId` and
   the shared host/environment routing is the right composable boundary. A
   provider switch across two sibling controls settles in two controlled
   updates rather than one combined execution tuple.
3. **Single-mode presentation.** Confirm compact/settings consumers should
   see a locked summary when only one mode is supported, while first-party
   composer call sites may continue hiding a non-choice.
4. **Permission ceiling behavior.** Audit hosts whose ceiling is below every
   mode a provider supports and decide whether the picker should render an
   explicit unavailable state instead of the controller's existing fallback.

## `app.slots.experimental_timelineRenderer` (`@omnyo/plugin-sdk/app`)

**Kept experimental (2026-08-22).** zero consumers; every audit item is about the prop shape and none has a consumer to answer it — the first real renderer (a Codex extension-kind body, or the echo example) precedes stabilization.

**Form rows (2026-09-16).** Register `"<pluginId>/<rendererId>"` to render a
`requestInput` form's history. `payload` is `describeSubmission().payload`
or `null`; `completedAt` is `null`. Before stabilization, decide whether form
and extension rows need distinct `kind` values.

**What it does.** Lets a provider plugin's frontend render the expanded body
of the timeline rows it owns: `{ kind, component }`, where `kind` is one of
the plugin's own extension item kinds (`"<pluginId>/<name>"`, as declared in
`api.providers.register({ extensionKinds })`) or `"tool"` for the
generic tool items of the providers the plugin registered. Core kinds
(messages, commands, file changes, reads, searches, delegations, plan steps)
always use Omnyo's renderers and are customized through the bridge's persisted
`presentation` alone (docs/provider-plugin-api.md §5, Q17). The component
receives `{ row, payload, presentation, thread, Original }`; `Original` is
the host's declarative base for the body. The row header (the presentation's
label, glyph, tint and headline) stays host-rendered. The host drops a kind
outside the plugin's namespace with a warning, scopes `"tool"` to the plugin
that owns the thread's provider (`ProviderInfo.pluginId`), contains a crash
to the row (the declarative base renders instead). A provider plugin's
bundle loads in the same deferred boot pass as every other plugin's.

**Audit before stabilizing.**

1. **Body versus whole row.** The slot owns the expanded body under a
   host-rendered header. Decide whether a plugin may also replace the header
   (an inline widget with no disclosure, e.g. a goal card) before freezing
   the prop shape, and whether `suppress` should stay a bridge-only decision
   or the renderer may opt a row back in.
2. **Tool-row payload.** A `"tool"` row hands the renderer
   `{ arguments, output }` where `output` is the server's inline preview
   (head+tail) for long outputs. Decide whether the renderer gets the full
   output on demand (the core body fetches it through
   `timelineTurnSummaryDetails`) or only the preview.
3. **Provider ownership source.** `"tool"` scoping reads the thread's
   `ProviderInfo.pluginId` from the nearest thread provider context: the
   route's detail view provides its thread's, and the SDK `ThreadChat`
   provides the embedded thread's own (so a panel showing thread B under
   thread A's page resolves B's provider plugin and hands the renderer B's
   `providerId`). A host surface that renders rows with no such context, and
   a provider whose plugin was uninstalled, both resolve to "unknown owner",
   so no renderer applies; confirm that is the right failure mode for both.
4. **Legacy rows.** `presentation` is null on a tool row persisted before
   bridges attached one. Decide whether the renderer should see such rows at
   all, or only rows with a presentation.
5. **Mobile parity.** Mobile renders the declarative base and loads no plugin
   JS (by design). Confirm the base (label, glyph, tint, title, detail) is
   sufficient for the first-party extension kinds before a third party
   relies on a web-only upgrade.

## `experimental_NewThreadComposer` (`@omnyo/plugin-sdk/app`)

**Kept experimental (2026-08-22).** zero consumers; items 1 (a newly required create-thread field going missing silently) and 6 (projectless switching) need a consumer to validate.

**What it does.** The host-owned new-thread compose surface, the create-side
counterpart to `ThreadChat`. It renders Omnyo's full control set — prompt editor
with @-mentions and expand, `+` attachments, provider/model/reasoning picker,
voice, submit, and the row beneath with project, environment, "Branch from:",
and permission mode — and calls `onSubmit` with a `NewThreadRequest`
carrying every resolved selection, including `sessionOptions` when the user
changed an agent option the provider declares.

The composer deliberately does **not** create the thread. The plugin does,
through `api.sdk.threads.spawn`, which auto-fills `origin: "plugin"` and
`originPluginId`. If the component created the thread it would go through the
host's `useCreateThread` and the thread would look host-originated. So the
rule is: the composer owns user selections; the plugin owns filing
(`sectionId`, `parentThreadId`, `title`, `visibility`) and attribution.

Implementation: the shared workflow is
`apps/app/src/components/promptbox/NewThreadComposer.tsx`; the SDK adapter is
`apps/app/src/components/plugin/PluginNewThreadComposer.tsx`, bound in
`apps/app/src/lib/plugin-sdk-app-impl.tsx`.

**Audit before stabilizing.**

1. **`NewThreadRequest` vs. what `threads.spawn` accepts.** The type mirrors
   the subset of `CreateThreadRequest` a composer can resolve. Confirm every
   field still round-trips through `api.sdk.threads.spawn` unchanged, that
   `executionInputSources` still means the same thing to the server, and that
   no newly required create-thread field is silently missing. Note the
   composer runs `useThreadCreationOptions` with `scope: "component-local"`,
   which never reports a `providerId` provenance source even though the
   composer always sends an explicit `providerId`; decide whether that is
   correct before freezing the shape.

2. **Page-level behavior the adapter skips.** Fork seeds,
   quick-create-project, the guided machine-setup dialog, and codex-version
   submit blocking are all deliberately absent.
   Confirm none of them has become load-bearing for correctness (rather than
   convenience) on a plugin surface — codex-version blocking in particular
   means a plugin can submit to a machine whose CLI the primary surface would
   have refused.

3. **Draft and selection scoping.** Drafts persist under a
   `plugin-new-thread` scope keyed by `draftKey ?? pluginId`, and execution
   selections are component-local so a plugin panel never rewrites the user's
   persisted root-composer defaults. Confirm that is still the behavior
   plugin authors expect, and that `draftKey` is the right knob (versus, say,
   a per-instance ephemeral draft).

4. **No plugin composer host binding.** The instance passes no
   `pluginComposerHost`, so plugin composer customizations, banners, and
   `useComposer()` writes do not reach it. Decide whether composers rendered
   by a plugin should participate in that surface before stabilizing.

5. **Seeding props and the round-trip guarantee.** The `default*` props
   (`defaultProviderId`, `defaultModel`, `defaultReasoningLevel`,
   `defaultServiceTier`, `defaultPermissionMode`, `defaultEnvironment`) seed
   the composer from a stored `NewThreadRequest` so a plugin can re-open a
   saved configuration without silently resetting it to project defaults.
   They are seeds (uncontrolled), take precedence over project defaults, and
   re-seed on any value change — including user-touched selections — via the
   creation-options resetKey. `defaultEnvironment` maps args back to picker
   selections in
   `apps/app/src/components/plugin/new-thread-environment-seed.ts`; its
   unrepresentable variants (`project-default`, `personal` without a
   `hostId`, an `unmanaged` `path`) are documented on the prop. Before
   stabilizing, confirm the mapping still inverts
   `resolveRootComposeThreadEnvironment` (the round-trip tests in
   `new-thread-environment-seed.test.ts` and
   `PluginNewThreadComposer.test.tsx` guard this) and re-decide whether the
   re-seed-on-change rule should instead be an explicit reset nonce.

6. **Projectless contract.** The picker always offers "Don't work in a
   project", including when a plugin seeds a specific project. That choice
   submits the personal-project id (not `null`) with a `personal` workspace;
   plugin authors forward both fields unchanged and must opt into personal
   project metadata with `projects.list({ includePersonal: true })`. Before
   stabilizing, confirm unconditional project switching is right for embedded
   plugin workflows, rather than adding an explicit project-locking policy.

## `app.slots.experimental_sidebarFooterCard` (`@omnyo/plugin-sdk/app`)

**What it does.** Mounts an additive plugin React card where the host shows
live status. The card receives `ExperimentalSidebarFooterCardProps` and retains
the standard PluginSlotMount contexts and crash boundary. The host owns its
position and visibility. It leaves the thread list, disclosures and controls in
place. Registrations disappear on disable or unload; frontend reload mounts a
new registration generation. A crash hides only that card.

**Placement prop (2026-10-22).** `experimental_placement` (`"rail"`,
`"sidebar"` or `"footer"`) tells the card where it is mounted so it can pick a
layout. The core caller is `PluginSidebarFooterCards`
(`apps/app/src/components/plugin/PluginSidebarFooterCards.tsx`), which passes
the placement it renders: on desktop, `AppFooter` mounts it with `footer` in
the one-line, 30px app footer that spans the window, with the usage card first
and the native Resources reading after the cards. On compact viewports the
drawer ends in the same kind of bottom rail (`MobileBottomRail`): Settings
under the navigation rail, then the usage card mounted with `footer` and the
native Resources reading, then the footer actions collapsed into More. That
rail is an `app-footer` container about 22rem wide, so cards adapt to it with
the same container queries as a narrow desktop footer. It shows only the
`omnyo--account-usage/usage` card; the other cards mount with `sidebar` above it,
and the sidebar placement excludes the usage card. Current hosts no longer
mount `rail`; earlier hosts used it for a gauge column in the navigation rail,
and older hosts that omit the prop mount cards only there, so plugins still
treat a missing value as `rail`. The bundled `account-usage` plugin shows every
pooled account in the footer as a small battery cell with its weekly percentage
or return time, including spent, five-hour-limited and disabled (`off`)
accounts. Below 40rem it collapses each provider to the average weekly
percentage left, or the next capacity time when nothing is usable; tapping it
opens the per-account details, as a bottom sheet on phones. It renders its
weekly strip in the sidebar.

**Audit before stabilizing.** Check crowded cards at narrow widths, collapsed
sidebar and mobile drawers, keyboard access, long content, route changes,
disclosures, multiple plugins, reload and disable. Decide whether appearance
ordering or a card-height limit is needed from observed usage. Confirm the
three placements are the durable set, whether a footer card needs a host
width budget or low-priority hiding contract beyond its own layout, and
whether the hard-coded usage and Resources choices should become ordering
preferences.

## `app.slots.experimental_titleBarCenter` (`@omnyo/plugin-sdk/app`)

**What it does.** Mounts additive plugin React components in the center
column of the window's top rail, between the left cluster (window controls,
then the breadcrumbs or a single pane's thread title) and the right cluster
(thread controls and the right-panel toggle). They follow any
`experimental_threadCompanion` toolbar rows. A registration is
`{ id, component }`; `id` is unique within the
plugin (letters, digits, `-`, `_`). The component receives
`ExperimentalTitleBarCenterProps`, which is deliberately empty, and reads live
state through SDK hooks. Registrations mount in plugin load order with the
standard PluginSlotMount contexts and crash boundary, so a crash hides only
that registration. Nothing renders when no plugin registers. The container is
a no-drag region, so the components receive pointer events inside the desktop
window's drag area. Registrations disappear on disable or unload; frontend
reload mounts a new registration generation. Phone-width layouts have no top
rail and do not mount the slot.

**Core caller (2026-10-25).** The core caller is `PluginTitleBarCenter`
(`apps/app/src/components/plugin/PluginTitleBarCenter.tsx`). It renders the
registrations in one flex row and takes a `className`, so the top rail can
place the row in its center column. Core registers no content of its own.

**Audit before stabilizing.** Check several plugins registering at once: how
they share the center column, and whether the host needs an ordering
preference or a width budget. Check narrow desktop widths, where the thread
title and the right cluster compete with the center content. Check
drag exceptions in the desktop apps: whether the no-drag container blocks
window dragging more than its content needs, and whether plugins need finer
drag regions. Check keyboard order: Tab should reach the center content
between the left cluster and the right cluster. Also check route changes,
reload, disable and crash recovery, and decide from observed usage whether
the component needs props such as a compact-width flag.

## `app.slots.experimental_appOverlay` (`@omnyo/plugin-sdk/app`)

**What it does.** Mounts an additive plugin React component once per Omnyo app
window, outside route-owned layout regions and inside `PluginSlotMount`. The
component receives no props and owns its chrome, positioning, visibility,
focus, and responsive behavior. It can call app-level SDK hooks and either
render fixed UI directly or create a React portal without losing plugin,
router, query, realtime, or sidebar thread/action context. Overlays share the
app's tooltip provider (300 ms delay, hoverable content disabled), including
through portals; host SDK components need no plugin-owned tooltip provider.
The pane-local code-highlighting worker pool is not inherited here; its hooks
support rendering without a pool. Hooks whose contract
requires a particular surface, including `useComposer`, remain limited to that
surface. One overlay crash hides only that registration;
sibling overlays remain mounted.

**Audit before stabilizing.**

1. **Name and boundary.** Confirm "app overlay" is broad enough for floating
   widgets, launchers, and transient app-wide UI without inviting plugins to
   replace host-owned navigation or layout.
2. **App-level versus pane-level context.** Define the selected route in split
   layouts and document which pane-local capabilities remain unavailable to a
   once-per-window owner, including composer and side-panel hosts.
3. **Host-owned layer.** Decide whether arbitrary fixed/portalled content is
   sufficient or Omnyo should provide a named overlay root, z-index band,
   collision area, docking, or drag persistence.
4. **Responsive and accessibility policy.** Audit keyboard access, focus
   restoration, escape behavior, compact drawers, reduced motion, and whether
   any of those must become host-owned rather than plugin-owned.
5. **Multiplicity and budgets.** Registrations are additive with no cap.
   Measure startup, query fan-out, visual collisions, and several plugins
   mounting persistent widgets in one window.
6. **Lifecycle.** Verify exact once-per-window mounting across route changes,
   split changes, frontend reload, disable, uninstall, app teardown, and
   multiple desktop windows or browser tabs.
7. **Crash and stylesheet lifetime.** Confirm a hidden crash fallback and the
   standard slot-owned CSS retention are the right failure semantics for UI
   that may have no in-layout representation.

## `experimental_ResponsiveDrawerShell` (`@omnyo/plugin-sdk/app`)

**Added experimental (2026-11-18).** `ExperimentalResponsiveDrawerShellProps`
exposes the host's compact bottom drawer to plugin components. The plugin owns
`open` and handles `onOpenChange`; the host owns placement, motion, focus and
nested dismissal. This component always presents a drawer. The caller chooses
when a compact drawer is appropriate and supplies its desktop presentation.

**Behavior and ownership.** The app runtime delegates to the same shared UI
`ResponsiveDrawerShell` used by `ComposerPopupHost`, `PendingInteractionShell`
and `ThreadTableOfContents`. It starts the shell before realizing children after
two animation frames, with the existing timer fallback. Once realized, the
subtree stays mounted across close and reopen; closed drawer content becomes
inert and hidden from assistive technology. Opening a drawer does not add
`inert` or `aria-hidden` to the application root.

The plugin supplies an accessible name through `srLabel` or `labelledBy` and
may connect a description with `describedBy`. Escape, backdrop and outside
interaction use the shared nested-overlay owner. `onEscapeKeyDown`,
`onPointerDownOutside` and `onInteractOutside` can prevent the default dismissal;
`closeOnBackdropClick` controls backdrop dismissal. `onAfterCloseAutoFocus`
runs through the existing focus-restoration path. `contentClassName` styles
the content, and `onContentAnimationEnd` reports the settled open state.
`motionDurationMs` retains a caller's normal-motion timing, while `animateClose`
can disable the close animation except for a swipe that follows the finger.
The host reads the existing plugin context when placing owned portals so the
caller's plugin styles retain their scope. Realization and focus hooks remain
internal implementation details.

**Guide and evidence.** The Compact drawers map calls the public component,
provides an accessible draft field and demonstrates close/reopen retention.
Its fixture contract links the host implementation and all three core callers;
the core overlay tests own motion, keyboard, focus, nested dismissal and
application accessibility behavior. Plugin adapters must use an SDK archive and
minimum SDK version that include this export; refreshing the archive does not
raise `engines.omnyoPluginSdk` automatically.

**Audit before stabilizing.**

1. Confirm the compact-only name, controlled state and label/description props
   cover independent plugin controls without exposing layout or motion internals.
2. Verify deferred realization and retained drafts across close, reopen,
   plugin disable/unmount and frontend replacement, including reduced motion.
3. Exercise nested core/plugin drawers, portaled child controls, cancellable
   Escape/outside events and focus restoration on fine and coarse pointers.
4. Verify plugin portal styling, keyboard insets and drag dismissal in compact
   Safari as well as desktop browsers, without hiding the app root.
5. Confirm SDK/runtime export parity and reject incompatible plugin manifests
   before activation; preserve existing standalone plugin packaging.

## `app.slots.experimental_newThreadPanelAction` (`@omnyo/plugin-sdk/app`)

**Kept experimental (2026-08-22).** zero consumers; item 5 (merging with `threadPanelAction`) is explicitly deferred until an external plugin adopts it.

**What it does.** Adds a plugin row to the root New thread screen's
right-panel Actions list. Activating it can open a closable panel tab whose
component receives `{ projectId: string | null, params: JsonValue | null }`.
It deliberately does not reuse `threadPanelAction`: that existing contract
requires `threadId: string`, and the in-repo and external consumers built
against it may assume a thread exists. The two slots are surface-specific and
never cross-render.

Before stabilization, audit:

1. **Surface naming.** Confirm "New thread" remains the product name and the
   slot should stay panel-specific rather than becoming a broader root-compose
   action surface.
2. **Context breadth.** Confirm the selected `projectId` is sufficient. A
   plugin can use the composer hooks for the live draft, but the slot does not
   expose the root composer's selected host, environment, provider, or model.
3. **Project changes.** An open tab receives the current project on every
   render, while `run` receives the project selected when the row was
   activated. Confirm that distinction is intuitive and whether changing
   projects should close or re-key open tabs.
4. **Persistence.** Tabs and JSON params persist in the root panel's fixed
   state. Confirm restoring a plugin tab before registrations load, after a
   plugin is removed, and in projectless compose has the right fallback.
5. **Relationship to `threadPanelAction`.** Confirm separate opt-in remains
   preferable to a unified discriminated context after external plugins have
   had time to adopt the root surface deliberately. The two contexts' `openPanel`
   signatures were already unified: both take `PluginPanelActionOpenOptions` and
   return `boolean` (true = accepted, false = declined), matching
   `messageAction`'s `openPanel` and `experimental_useAppNavigate().openThreadPanel`. Do not
   re-litigate that in the stabilization audit; audit only whether the two
   _contexts_ should merge.

## `app.experimental_sidebarFooter` (`@omnyo/plugin-sdk/app`)

**What it does.** Registers host-rendered icon items in the app sidebar footer.
An item is either an `action`, whose `onActivate` callback runs when selected,
or a `disclosure`, whose React component is revealed above the footer row. The
host owns button chrome, accessibility, responsive containment, and a
single active disclosure across all plugins. A disclosure component owns
everything inside its boundary and receives only `dismiss()`.

Registering an action returns nothing. Registering a disclosure returns a
controller that can request `open`, `close`, or `toggle`. Those requests go
through the host's shared active-item coordinator, so opening one plugin's
disclosure replaces another and a stale scoped `close` cannot dismiss a sibling.
The existing `app.slots.sidebarFooterAction` remains a compatibility surface and
renders in the same footer row.

**Audit before stabilizing.**

1. **Naming and shape.** Confirm `sidebarFooter`, `action`, and `disclosure` are
   the durable concepts, and whether the managed namespace should keep one
   discriminated `register` method or split registrations by behavior.
2. **Imperative controller.** Validate real plugins can issue open requests
   without leaking subscriptions across frontend generations. Decide whether
   a declarative external-store contract would be safer.
3. **Programmatic opening.** Confirm `open()` should remain available. The
   intended policy is direct user-driven flows; background changes should not
   surprise-open sidebar content.
4. **Disclosure lifecycle.** Components currently mount only while open and
   remount after dismissal. Confirm plugins do not require retained hidden state,
   or add an explicit retention policy before stabilizing.
5. **Footer capacity.** Establish overflow behavior when several plugins
   register items, including compact viewports and icon-collapsed sidebars.
6. **Compatibility.** Migrate representative users of
   `sidebarFooterAction`, then decide whether stabilization replaces and
   deprecates that method or keeps action registration in both surfaces.
7. **Focus and dismissal.** Validate icon toggling, Escape, focus return,
   disclosure replacement, plugin reload, crash isolation, and removal while
   open across desktop and compact sidebar layouts.

## `app.slots.experimental_threadList` (`@omnyo/plugin-sdk/app`)

**Kept experimental (2026-08-22).** examples only; no shipped consumer has tested the arbitration/fallback model or the accessibility contract.

**Scope prop (2026-10-22).** `PluginThreadListProps.experimental_scope`
(`PluginSidebarScope`: `{ kind: "inbox" }` or
`{ kind: "project", projectId }`) passes the navigation rail's selection to
the list. The core caller is `PluginThreadList`, which reads it from the
client sidebar scope (`apps/app/src/components/sidebar/sidebarScope.ts`).
The client stores the scope per device under `omnyo.sidebar.scope` and resolves
a project missing from the loaded catalog to the inbox. The scope follows
the location (`useSidebarScopeFollowsLocation`): when a chat, a
`/projects/:projectId/*` route or a project-scoped plugin page of another
project opens, a project scope moves to that project; the inbox scope never
changes. A plugin page is project-scoped when the first segment of its
sub-path is a project ID in the loaded catalog (Canvas uses
`<projectId>/<kind>/<id>`). `resolveLocationProject` is the one resolver for
all three route kinds; it returns nothing while the catalog is placeholder
data or for IDs outside it. The scope moves only when the resolved location
changes, so a tile click holds until another location opens. A tile click
on a page outside home returns to the last chat with
`SIDEBAR_SCOPE_KEEPING_NAVIGATION_STATE` in router state, and the follower
records that location without moving the scope; Back and Forward ignore the
marker. The rail marks the resolved project's tile with
`aria-current="location"` and a shorter pill than the selected one while
`aria-pressed` keeps marking the scope, and
`PluginThreadListProps.activeProjectId` carries the same resolved project.
In a project scope the header New chat starts in that project. The bundled
`thread-list` plugin, which core ships as its own list, honors the prop
through the same path: a project scope lists only that project's chats in
every organization mode and starts the list's new chats there, and the inbox
keeps the full list. Older hosts omit the prop, which plugins treat as the
inbox.

**What it does.** Replaces the sidebar's scrolling thread list with a plugin
component. Unlike every other `app.slots.*` member this slot is **exclusive**:
one list at a time fills the scroll area. Automatic activation is the default.
Omnyo ships its own list as the bundled `thread-list` plugin, and Automatic prefers
any other registered list: the first in the slot snapshot wins (plugin ids are
sorted, then each plugin's registration order is preserved), falling back to
the bundled plugin; removing the automatic winner reveals the next. The user can
override that behavior under Settings → Appearance by pinning a specific
provider, including the bundled one; the choice is the synced
`sidebar.threadListProvider` preference. Omnyo has no separate built-in list, so
there is no `Original` prop on this slot.

Placeholders keep the sidebar usable: while plugin frontends boot the region
shows skeleton rows; with no provider it shows "No thread list plugin is
enabled" with a link to Plugins; an unavailable pinned provider shows the same
without erasing the choice; and a crashing component shows a "stopped working"
placeholder with a Reload button (not the usual "plugin crashed" chip, which in
place of a whole sidebar would strand the user) plus one toast.

**Audit before stabilizing.**

1. **Arbitration.** Confirm automatic/pinned, with installed lists preferred
   over the bundled one, is the right long-term selection model and
   alphabetical plugin-id order is an acceptable default tie-breaker when
   multiple replacements are enabled.
2. **Fallback discoverability.** Confirm one toast plus the placeholder's
   Reload button is the right signal when the list crashes.
3. **Region boundary.** The plugin gets the scrolling list and nothing else:
   the New-thread button, the navigation rail, and the footer stay
   host-rendered, because they are shared surfaces (other plugins live in two
   of them) and a replaced list must not remove them. Confirm no real sidebar
   needs to claim more, and that passing those regions down as props — letting
   a plugin place them, at the risk of dropping them — stays the wrong trade.
4. **Search compatibility.** Confirm released plugins no longer need the
   required deprecated `searchQuery` field before removing it in a deliberate
   breaking change. Until then, the host supplies `""`.
5. **Accessibility.** Confirm the host can still guarantee list semantics,
   focus order, and the mobile close behavior when a plugin owns the markup —
   `onNavigate` is currently the plugin's responsibility to call.
6. **Scope shape.** Confirm `inbox` and `project` are the durable scope kinds
   before stabilizing `experimental_scope`, and whether other selections
   (a machine, a topic) belong in the same union or in separate props.
7. **Scope ownership.** Validate with Chat Topics and the bundled list that
   following the opened location never fights a user's rail choice, that a
   scope pointing at a removed project degrades to the inbox on every client, and
   whether the scope should stay per device or sync like
   `sidebar.threadListProvider`.

## AI services (`api.experimental_aiServices.register`)

**Reshaped (2026-09-22).** The host contract (`@omnyo/plugin-sdk/ai-services`),
its error codes, `kinds`, the reserved server-direct ids, and the old
inference and transcription settings are gone.
Consumers: the codex plugin; `experimental_prepare` is used by the Dictation by
Paraspeech plugin in `omnyo-plugins`.

**What it does.** A plugin registers plain server-side functions:
`api.experimental_aiServices.register({ id, displayName, complete?, transcribe?, status? })`.
`complete(prompt, { signal }) → Promise<string>` serves thread titles and
commit messages; `transcribe(audio: File, { signal, hint }) → Promise<string>`
serves voice input; `status() → Promise<{ ready: true } | { ready: false, message }>`
feeds the picker and availability display (cached ~10 s). Text tasks await a
fresh status, bounded at 2 s, before skipping a service whose cached status is
older. Voice execution bypasses advisory readiness and lets the selected service
enforce its actual enabled state and allowance, so a stale failure cannot block
an immediate retry. At least one of `complete` / `transcribe` is required; which tasks a
service appears for follows from the functions it declares. Omnyo owns the
prompts and the reply cleanup; the plugin owns the model, the API, and any retries. Failure is a
rejected promise, and core aborts `signal` at 8 s (text) or 70 s (voice).

The user picks per task with `omnyo settings ai-services set` or
`sdk.system.setAiServiceSelection` (`automatic` | `off` |
`{ pluginId, serviceId }`, stored server-side under the `aiServiceSelections`
app-settings key). Automatic tries all compatible registered services in
lexicographic order of plugin id and service id.
Third-party services participate without an explicit per-task selection.
The services view exposes each registration's position as `automaticRank`.
An explicit pick is strict: failure uses the plain fallback text and never
moves to another service. Services are keyed by plugin id plus service id, so
ids only need to be unique within a plugin: a plugin that registers one id
twice fails its load, and two plugins may share an id without either failing.
`automatic` and `off` are reserved ids because the CLI and selections use them
as modes. `omnyo settings ai-services set` takes `--plugin` to pick between
plugins that share an id. The CLI test result names both ids (`pluginId`, `serviceId`). The voice-transcription and test routes abort
the service's `signal` when the HTTP request is cancelled.

`experimental_prepare({ signal }) → Promise<void>` (added 2026-11-15) lets a
voice service get ready before audio arrives, for example by loading a local
model. Core calls it only for the first service the next transcription would
try (the explicit pick, or the first Automatic candidate), from one path,
`prepareVoiceInput` in `apps/server/src/services/ai/voice-prepare.ts`. Its two
callers are `POST /system/voice-transcription/prepare` (the app calls it when
recording starts; `sdk.system.experimental_prepareVoiceInput` and
`omnyo voice prepare` use the same route and log the reason `requested`), which
answers `{ ok: true }` without waiting, and the host-connected prewarm, which
runs once for each new daemon session of the primary host (read from the hub,
so other `host-connected` notifications neither trigger nor suppress it),
including a session that is already connected when the prewarm starts. Calls are single-flight per registration: a request while
one is running joins it and starts nothing, and the slot frees only when the
plugin's promise settles. The signal is server-owned, never tied to an HTTP
request, and aborts at 70 s or when the prewarm stops (maintenance or
shutdown). Success, timeout, cancellation and failure are logged (`Voice input
prepared`, `Voice input prepare timed out`, `Voice input prepare was cancelled`,
`Voice input prepare failed`) and never shown; the next `transcribe` reports any
real problem. A service with nothing it can prepare yet (for example a model that
is not downloaded) rejects, so the log never reports a prepare that did not
happen.

**Audit before stabilizing.**

1. **Structured input.** Confirm a bare prompt string stays enough, or whether
   services need the task (title vs commit) or a length hint without breaking
   the "plugin owns the model" split.
2. **Status freshness.** The picker and the microphone can show a status up
   to 10 s stale, and a task past that age waits up to 2 s for a fresh one; a
   plugin whose readiness flips (sign-in, quota) might want to push a change
   instead of waiting for the next poll.
3. **Voice payloads.** `transcribe` receives the whole `File` in process
   (25 MB cap). Decide whether streaming matters for long recordings.
4. **Automatic order as policy.** Core sorts by plugin id and service id,
   including third-party plugins. Decide whether
   this order and automatic inclusion should become user-editable settings.
5. **Several services per plugin.** Confirm the id-per-registration shape and
   the per-plugin id scope (plugin id plus service id).
6. **Prepare triggers.** Decide whether `experimental_prepare` should also run
   when the voice selection changes or the service registers after the primary
   host connected (a plugin reload today waits for the next recording), and
   whether it needs a `reason` argument.
7. **Prepare lifetime.** Decide whether services need a `release` counterpart
   or a hint for how long to stay ready, given that holding a plugin worker
   blocks idle runtime and plugin updates.

## `PluginFileOpenerSource.experimental_hostId` (`@omnyo/plugin-sdk/app`)

**Kept experimental (2026-08-22).** persisted in opener-tab `paramsJson`; items 3–4 (every source kind vs project-only; omission semantics) decide whether the stable name is `hostId?` or a required field.

**What it does.** Identifies the explicit host selected for a project-backed
workspace file when a file opener cannot resolve that source through a thread
or environment. It is omitted for environment-backed workspace files, host
files, thread-storage files, and project files that use the primary host.

**Audit before stabilizing.**

1. Confirm an explicit host id is the minimum missing project-routing context,
   rather than exposing the whole project workspace routing union.
2. Verify project-compose file tabs retain the selected host across reloads,
   host changes, plugin fallback, and per-open viewer overrides.
3. Decide whether host identity should be present for every source kind or
   remain project-specific once more file opener plugins exercise the API.
4. Confirm omission should continue to mean primary-host resolution and that
   this remains compatible with persisted opener tabs created before the field
   existed.

## `experimental_VoiceInputTextarea` (`@omnyo/plugin-sdk/app`)

**What it does.** A host-owned controlled textarea with Omnyo's voice input. It
takes `value`, `onValueChange`, and an optional `onVoiceInputActiveChange`;
every other textarea attribute, including `ref` and `className`, reaches the
underlying `<textarea>`. The caller styles the textarea; the host wraps it in
a relative container and, when the browser supports voice input, adds bottom
padding and the microphone, waveform, cancel, and stop controls. Finished
transcripts are appended to `value` through `onValueChange` and stay editable;
nothing is submitted. `onVoiceInputActiveChange` is true from the start of
recording until transcription finishes or is cancelled, and false on unmount,
so a form can hold navigation and submission. Unmounting discards late
transcripts. It uses the same microphone preference, transcription service,
and error handling as the prompt box. Without voice support it renders the
plain textarea; the test harness renders that plain textarea too.

The registry's `voice-input-textarea` item re-exports it, and the registry's
`question-form` renders its free-text answer with it. Inside Omnyo, the built-in
Ask User Question and pi plugins and Omnyo's own question form reach the same
component through the `@omnyo/shared-ui/voice-input-textarea` module the build
shims.

**Audit before stabilizing.**

1. **Prop surface.** Every textarea attribute passes through. Decide whether a
   narrower explicit list is the better contract, and whether callers need to
   style the host's wrapper (it is a plain block today, so a flex child cannot
   stretch it).
2. **Voice lifecycle.** Verify cancellation, microphone permissions, mobile
   capture, and late transcription isolation when the component unmounts or
   its `value` changes mid-transcription.
3. **Unsupported hosts.** The textarea renders without controls when voice is
   unsupported, with no reason shown. Decide whether callers need the
   unsupported reason or a way to hide the controls.
4. **Consumer count.** One form (the shared question form, used by Ask User
   Question, pi, and Omnyo's own questions). Confirm a third-party consumer before
   the prefix drops.

## `experimental_SourceCode` / `experimental_Diff` (`@omnyo/plugin-sdk/app`)

**Kept experimental (2026-08-22).** one consumer (the github plugin's `Diff`); items 2–4 (multi-file input, language override, worker pool at the component) all change the prop surface.

**What it does.** Two host-owned renderers for supplied code content.
`experimental_SourceCode` takes source text plus a path and owns syntax
highlighting, gutters, wrapping, highlighted-line presentation, and the live Omnyo
code theme. `experimental_Diff` takes a single-file patch plus a path and
optional `experimental_fullFileContents` for both text sides, and owns patch normalization
(a patch without a `diff --git` header is completed from `path`, which is what
makes GitHub's REST patches and bare `@@` hunks render), context enrichment,
syntax highlighting, unified/split presentation, gutters, and the same live
theme. Patch content that will not parse degrades to plain monospace text. The
caller still owns loading file contents; omission means a patch-only render
without context expansion.

These are the same components Omnyo's own file preview, timeline file diffs, and
environment diff panel render through, so an active
`experimental_sourceCodeRenderer` / `experimental_diffRenderer` replacement
covers first-party surfaces and plugin surfaces at once. Fetching files or git
data, multi-file lists, tabs, card headers, git actions, and add-to-prompt
behavior deliberately stay with the caller.

**Audit before stabilizing.**

1. **Prop surface.** Confirm content + path + presentation plus optional full
   diff sides is the right minimal contract, and decide whether `className`
   belongs in it at all — a
   replacement never receives it today, so a `className` that only styles Omnyo's
   renderer is a quiet inconsistency.
2. **Diff input shape.** Confirm single-file patch text is the right currency.
   Multi-file patches, `processFile`-style pre-parsed input, and per-hunk
   rendering are all things callers have wanted; none are expressible now.
3. **Language selection.** Highlighting is inferred from `path` only. Confirm
   an explicit language override is not needed before the names freeze, and
   that no implementation-library language union leaks in when it is added.
4. **Worker pool.** Highlighting needs Omnyo's Pierre worker pool from React
   context. Thread panes and plugin nav panels provide one; homepage and
   settings sections do not, so a diff rendered there is unhighlighted rather
   than broken. Decide whether the host should provide the pool at the
   component instead of the surface.
5. **Selection to chat.** Omnyo's own surfaces pass a selection-to-composer
   handler that the public component withholds. Confirm plugins should reach
   that through `useComposer()` rather than a renderer prop.
6. **Size and virtualization.** Neither component caps input size or
   virtualizes. Audit against a plugin that renders a very large file or patch.
7. **Resolved (Aug 2026): context expansion takes resolved semantic data, not
   a loader callback.** `experimental_fullFileContents` carries required `old` and `new`
   `{ path, content }` objects. This keeps lazy loading, retries, and viewport
   policy with the caller while letting Omnyo's renderer and a replacement consume
   complete UTF-8 sides without exposing Pierre's `FileContents` type. A
   replacement always receives the caller-resolved field as an object or
   `null`, and owns patch-consistency validation if it uses those contents for
   expansion. Omnyo's original validates only when its lazy renderer mounts.

## `app.slots.experimental_sourceCodeRenderer` / `app.slots.experimental_diffRenderer` (`@omnyo/plugin-sdk/app`)

**Kept experimental (2026-08-22).** zero registrations; "two slots or one" changes the registration shape.

**What it does.** Replaces Omnyo's source or diff renderer everywhere it draws
supplied content — the native file preview, timeline file diffs, the
environment diff panel's file bodies, and every plugin calling the public
components. Like `experimental_threadList` these slots are **exclusive**: one
renderer each. Registering activates it while the plugin is enabled; if several
are registered the first in slot snapshot order wins (plugin ids sorted, then
each plugin's registration order). The user can override that under
Settings → Appearance ("Source code" and "Diffs") by pinning Omnyo's renderer or
a specific provider; the choice is per client, and it is the same
automatic/built-in/named-provider model the sidebar thread list uses. There are
deliberately no scope, extension, or enabled-by-setting filters on the
registration — conditional behavior belongs in the component, which decides per
call from its semantic props and renders `Original` when it does
not want the render.

Fallbacks: no registration renders Omnyo's renderer; a disabled or uninstalled
plugin reveals the next registration or Omnyo's renderer; a component that throws
renders Omnyo's renderer through the slot's crash fallback. A pinned provider that
is temporarily unavailable renders Omnyo's renderer without erasing the pin.

**Audit before stabilizing.**

1. **Arbitration.** Confirm automatic/pinned/built-in is the right long-term
   selection model here as it is for the thread list. **Resolved (Aug 2026):
   the pin stays per client.** A device-local override matches the sidebar
   thread list, even though the key/value app settings added in #1875 would
   now make an account-level pin cheap to add. Still open: the two renderers
   pin independently; confirm users do not instead expect one "code rendering"
   choice.
2. **Resolved (Aug 2026): a crash swaps back to Omnyo's renderer silently.**
   A diff card is not a whole sidebar — the reader still sees a correct diff,
   where a blank thread list strands them — so neither host passes `onCrash`.
   Authors are not left without a signal: `PluginSlotBoundary` still
   `console.warn`s the plugin id, slot key, and component stack. The hosts pass
   no `instanceId`, so the first crash disables the slot for the session rather
   than letting cards crash one at a time.
3. **Resolved (Aug 2026): the replacement is global, other plugins'
   surfaces included.** "Install this and every diff looks like X" is the
   point; covering Omnyo's surfaces but not the GitHub plugin's would be a
   half-measure, and a plugin calling `experimental_Diff` would silently opt
   its users out. No first-party-only or own-surfaces-only scope. Audit this as
   precedent rather than as a fact about these two slots: no other slot lets a
   plugin reach into another plugin's rendered output.
4. **Capability parity. Resolved for context expansion (Aug 2026):** a
   replacement receives `experimental_fullFileContents` as an object or `null`,
   matching the public host component and first-party diff cards. These are
   caller-resolved contents; a replacement that implements expansion also owns
   consistency validation against `patch`. Selection-to-chat and the
   deleted-file gate remain host-only; confirm that remaining asymmetry is
   acceptable, or promote either capability before stabilization.
5. **Two slots or one.** Confirm source and diff should stay separately
   replaceable rather than one "code renderer" registration.

## `app.slots.experimental_codeFenceRenderer` (`@omnyo/plugin-sdk/app`)

**What it does.** `app.slots.experimental_codeFenceRenderer({ id, languages,
component })` renders fenced code blocks of the claimed languages in assistant
and nested-agent message Markdown with a plugin component — the same places
`messageDirective` activates. User messages, file previews, and plugin
Markdown keep Omnyo's code block. `id` is unique within the plugin (letters,
digits, `-`, `_`); `languages` is non-empty, each lowercase
`/^[a-z0-9][a-z0-9+#._-]*$/`, and a language may be claimed once per plugin
(duplicates across that plugin's registrations are rejected at load).

The component receives `{ code, language, status, index, message, Original }`.
`code` is the fence body so far and grows while the reply streams. `status` is
`"streaming"` (no closing delimiter yet, reply still being written),
`"closed"` (closing delimiter present, `code` final), or `"unclosed"` (the
reply ended without one). `index` is the zero-based ordinal among fences of
the same language in the message. `Original` renders Omnyo's code block (syntax
highlighting, copy button, mermaid diagram for `mermaid`). Inside the
component `experimental_useAppNavigate().openThreadPanel` works as it does for
`messageDirective`.

Omnyo mounts the component once per fence and keeps that instance for as long as
the message stays on screen. The Markdown tree renders an empty placeholder
where the fence sits; a host around the message's Markdown owns the component
and portals it into a container that follows the placeholder, so the instance
survives the placeholder moving from the streaming tail to the settled region
and the reply finishing. A fence is identified by the source offset of its
opening delimiter, which does not move while a reply is appended to. Where
the browser supports `Element.moveBefore`, an iframe inside the component
also survives those moves without reloading; elsewhere component state
survives and the iframe reloads. State that must outlive the mounted
component belongs under `${message.id}#${language}#${index}`.

Fallbacks: Omnyo's code block renders when two plugins claim one language (Omnyo
logs a console warning naming them), when the plugin is missing or disabled,
and for a fence whose component throws. A throw affects that fence only, and
Omnyo tries the component again when that fence's `code` or `status` changes.

**Core callers on the same path.** Assistant and nested-agent message Markdown
rendering — `MarkdownPreview`'s code renderer, the pipeline that also resolves
`messageDirective`. The built-in `inline-vis` plugin renders its
` ```inline-vis ` pages through this slot. Omnyo's `mermaid` diagram stays
a core special case inside `Original`, because it renders on every Markdown
surface and this slot is scoped to messages. The SDK testing harness exposes
registrations as `loadPluginApp(...).codeFenceRenderers`, renderable with
`renderSlot`.

**Audit before stabilizing.**

1. **Collision model.** Confirm that a contested language falling back to
   Omnyo's code block is enough, or whether users need a per-language picker
   like the source/diff renderer pin.
2. **Streaming contract.** Confirm `code`/`status`/`index` cover real
   generative-UI renderers (partial JSON/DSL parsing), and whether the rest
   of the info string should be exposed as `meta`.
3. **Scope.** Confirm the slot should stay limited to assistant and
   nested-agent Markdown, whether common languages (`json`, `ts`) should be
   claimable, and whether `mermaid` should be claimable or reserved for Omnyo.
4. **Identity.** Confirm keying a fence by source offset holds for every
   path that rewrites a message's text, and decide whether iframes must
   survive the tail-to-settled move in browsers without `moveBefore`.
5. **Source visibility.** Decide whether Omnyo should offer its own "view
   source" control for claimed fences instead of leaving it to each plugin.

## `experimental_useSidebarThreads` / `experimental_useSidebarThreadActions` (`@omnyo/plugin-sdk/app`)

**New-thread machine selection (Sep 2026).**
`PluginSidebarThreadActions.openNewThread` accepts `hostId` to
preselect a known machine with an available environment provider for a new
environment. `environmentId` takes priority when both are present. The public
name follows the requested `hostId` spelling without an experimental prefix;
audit the selection semantics and router-state transport as the API evolves.

**Kept experimental (2026-08-22).** zero consumers; items 4 (a paged/windowed read at 10k threads) and 5 (the draft indicator gap) are unresolvable without one and both change the contract.

**Archive selection (Sep 2026).** `experimental_useSidebarThreads` accepts
`experimental_lifecycles` (active, archived, or both; active by default).
`PluginSidebarThreadsState.experimental_archived` is null for active-only reads;
otherwise it exposes archive loading/error state, pagination flags, and
`fetchNextPage`. Archive reads share the host query and realtime cache. Audit
archive-only loading/errors, combined views, pagination retries, and archived
row actions before stabilizing these additions.

**Machine list (Sep 2026).** `PluginSidebarThreadsState.experimental_hosts`
contains the current machines in host query order, including those with no
threads. Older hosts may omit the field; consumers can fall back to hosts
present on thread rows. It shares the host query and realtime cache. Audit empty machine
sections, machine removal, rename updates, and loading behavior before
stabilizing this field.

**Shelf selection (Oct 2026).** `experimental_lifecycles` also accepts
`shelved`. `PluginSidebarThreadsState.experimental_shelved` is null unless
shelved threads are requested; otherwise it has the same status and paging
fields as `experimental_archived`, and its pages arrive in Shelf order.
`PluginSidebarThread.experimental_shelvedAt` is when the thread's family was
shelved, or null. The host places each thread in one lifecycle: archived when
`archivedAt` is set, else shelved when `experimental_shelvedAt` is set, else
active. It pools the bootstrap with the requested paged lists, and a bootstrap
entry wins over a paged copy, so an optimistic shelve or unshelve moves the
family before the server answers. Shelf reads share the host query, the
`shelf-state-changed` realtime invalidation and the row hooks
(`useSidebarThreadEntry` resolves shelved rows). The bundled thread-list's
Shelf section (`plugins/thread-list/app/model/use-sidebar-data.ts`) is the core
caller on the same path; it requests `shelved` alongside `active`. Audit before
stabilizing: overall `status` for
paged-only reads (any failed paged query reports `error`), offset paging when
threads return to the active list between page loads, and whether a boolean
would serve plugins better than the timestamp.

**Shelf order (Nov 2026).** `PluginSidebarThread.experimental_shelfSortKey` is
the owner's Shelf order for a shelved family: every live member of the family
carries the root's key, keys sort lexicographically ascending, and shelved
pages arrive in that order with each root before its sub-chats. Shelving puts
the family before the current first key; unshelving clears the key. A null key
on a shelved thread means an optimistic shelve the server has not answered, and
lists put it first. `sdk.threads.experimental_reorderShelved({ threadId,
previousThreadId, nextThreadId })` (`PATCH /api/v1/threads/:id/shelf-order`)
moves a visible top-level Shelf thread between its new neighbors (null for the
top or bottom), returns the moved root as a thread list, and refuses stale or
reversed neighbors with 409 and agent callers with 403 `owner_only`. The plugin
SDK wrapper merges the returned key into the host caches, and the
`shelf-state-changed` notification refreshes other windows. Core callers: the
bundled thread-list's Shelf section (`ShelfThreadTree` through
`ProjectList`'s reorder handler) and `omnyo thread reorder-shelved`. The 0170
migration keyed existing Shelf families newest shelved first. Audit before
stabilizing: drags across a partially loaded Shelf (a move only sees loaded
neighbors), concurrent reorders from two windows, and whether the Inbox
snapshot's `shelf` list should follow this order.

**What it does.** Gives a plugin component the sidebar's live thread view and
the actions that mutate it. The read hook wraps the host's own
`useSidebarNavigation` query — the same cache and realtime subscriptions the
built-in sidebar uses — so a plugin list costs no extra request and updates on
exactly the same events. The action hook routes to the host's own mutations, so
optimistic updates, toasts, and cache invalidation are identical.

`PluginSidebarThread` is a deliberate copy of the fields a sidebar needs, not a
re-export of the internal `ThreadListEntry`. `indicator` is
`resolveThreadListIndicator` already run by the host, so plugins inherit Omnyo's
precedence (attention before work; plan and goal before the spinner) instead of
reimplementing it, and `indicatorLabel` carries the matching accessible string.

**Audit before stabilizing.**

1. **DTO scope.** Confirm every field earns its place and that the copy stays
   worth its maintenance over `ThreadListEntry`. `hasUnsubmittedDraft` is
   deliberately absent (client-local composer state); confirm plugins do not
   need it. **Widened (Sep 2026)** with the columns Omnyo's own list reads that
   the copy had dropped: `status`, `runtimeStatus`, `queuedWork`,
   `pinSortKey`, `isHidden`, `lifecycleOwnerThreadId`, `sourceThreadId`, and
   `environment.path` / `environment.isWorktree`; `indicator` now reports
   `queued-failed` and `queued-waiting` instead of coercing them to `none`.
   `status` and `runtimeStatus` freeze the domain enums into the contract the
   way `indicator` already does; the same treat-unknown-as-fallback rule
   applies. `host` is resolved host-side to `{ id, name }` because a plugin
   cannot turn a host id into a machine name — confirm resolution belongs here
   rather than in a separate hosts hook, and that falling back to the id for an
   unknown host is the right failure.
2. **Indicator coupling.** `indicator` freezes Omnyo's precedence into the
   contract. Confirm new kinds can ship without breaking plugins, and that the
   documented "treat unknown as none" rule is enough.
3. **Unread semantics.** `isUnread` is plain read state, so it is true for
   child threads and running threads that `isUnreadDoneThread` excludes by
   design. Confirm that is the more useful primitive for a replaced list.
4. **Scale.** Confirm one array of every thread is right at ten thousand
   threads, versus a paged or windowed read. Today the host memoizes each
   thread DTO per unchanged `ThreadListEntry` (React Query structurally shares
   the payload), so a refetch that changes one thread hands plugins the same
   objects for every other thread and a `memo`/compiler-memoized row bails
   out; the array itself is new whenever the payload changes. Plugin lists
   are still expected to window their rows (the built-in sidebar does): the
   host does not cap the array, and mounting one row per thread on a phone is
   the plugin's cost. Decide whether that expectation should be enforced by
   the contract (paged/windowed read) before stabilizing.
5. **Draft indicators.** `indicator` never reports "draft" or "working-draft",
   because an unsubmitted draft is per-composer client state the host reads per
   row. An idle unread thread holding a draft therefore reads as
   "unread-success" where the built-in row paints "draft". Decide whether to
   close that gap (a per-thread draft hook) or keep it documented.
6. **Sections (Sep 2026).** `sections` rides on the state (same bootstrap
   payload, no extra request) as the read side; writes are deliberately not
   wrapped as actions because they are plain public API calls with realtime
   fan-out. Confirm that split holds once a replaced list ships section
   drag-and-drop, where the built-in list's optimistic cache transactions
   have no plugin equivalent. `openNewThread` gained `sectionId` and
   `environmentId`, and `hostId`, which today ride on router
   state; confirm router state stays the right transport.
7. **Action surface.** Destructive and dialog-bearing actions route through
   `useThreadActions()`, so `archive` closes panes and repairs the route, and
   `requestDelete` opens Omnyo's confirmation rather than deleting silently.
   Confirm that split (silent `rename`, host-confirmed delete) is the right
   line, and decide whether bulk actions and undo belong here.
8. **Permission.** Decide whether `archive` and `requestDelete` need any plugin
   permission gate beyond installation trust.
9. **`experimental_useSidebarThreadPullRequest`.** Per-row and opt-in, because
   a PR lookup hits the git host and therefore cannot sit on the payload every
   sidebar loads. It reuses the host's environment-keyed query, so threads
   sharing a worktree share one lookup and the host keeps its own staleness and
   refetch rules. `PluginSidebarPullRequest` also exposes
   `experimental_autoMerge`, nullable `experimental_inMergeQueue` (null means
   the queue lookup failed), and `experimental_checks`, `experimental_review`,
   and `experimental_mergeability` with normalized `state` fields. Attention
   includes `queued`; failures precede waiting states and generic blocking is
   a fallback after checks and reviews. Before stabilizing, confirm the state
   summaries and unknown-queue semantics meet sidebar needs;
   a sidebar of many distinct worktrees does not stampede the git host; and
   returning `null` for "lookup failed" (rather than an error) is the right
   failure for a row that should simply show nothing.
10. **`experimental_useSidebarThreadSplit`.** Gives a custom row the built-in
    drag-to-split gesture: spread `splitProps` onto the row, gate any affordance
    on `isAvailable`, and read `layout` to paint where the thread already sits.
    The host owns every rule — the drag engages only after the pointer leaves the
    sidebar, an edge drop splits, a center drop replaces, an open thread focuses
    its pane, and the pane cap turns a split into a replace — so a plugin cannot
    reach a layout the built-in sidebar cannot. Before stabilizing, confirm: a
    list with its own pointer-drag (reorder, swipe) still composes with the
    host's engage threshold; `splitProps` staying an open object is the right
    forward-compatible shape, or it should narrow to a named handler; and
    exposing the full `panes` array does not leak more layout state than a row
    needs.

## `app.slots.experimental_threadHeaderAction` (`@omnyo/plugin-sdk/app`)

**Kept experimental (2026-08-22).** zero consumers; item 1 (merging behind one registration with `api.ui.registerThreadAction`) is cheapest to decide before the first one.

**What it does.** Renders a plugin component in the thread's header controls.
For a single pane on a wide window those controls sit in the window title
bar's right cluster; split panes keep a header row in each pane. Phone-width
layouts (under 768px) do not mount it: their header holds only the title, the
one thread menu and the right-panel toggle, so a plugin registers an
`experimental_threadAction` for anything that must stay reachable there. The frontend sibling of the backend `api.ui.registerThreadAction`,
which renders a host-owned button and runs server-side: use that one for "do a
thing", and this one when the control must draw live state (a count, a
cluster, a status).

The host places it first in the controls, before the open-in-editor button.
In the title bar, the right-panel toggle follows; in
a pane row, maximize and close follow. Windows narrower than 1024px move the
open-in-editor button into the thread menu. It mounts once per visible thread,
each with that thread's `threadId`. A crash removes just that control and
leaves the rest of the header working. `isCompactViewport` is true on coarse
(touch) pointers, never because of width alone.

**Audit before stabilizing.**

1. **Two APIs, one region.** `api.ui.registerThreadAction` and this slot now
   share a row. Confirm the ordering rule between them, and whether the two
   should merge behind one registration.
2. **Budget.** Decided (2026-11-20): the host owns the budget. A narrow pane
   row shrinks the plugin controls and clips them horizontally (`min-w-0
shrink`, `overflow-x: clip`, vertical overflow stays visible) before the
   title and the thread menu lose room, so nothing paints over the title.
   Phone-width layouts omit the slot. Still open: whether wide rows need a
   count cap.
3. **Compact viewport.** Decided (2026-11-20): the host-owned overflow is the
   thread menu, and plugins reach it through `experimental_threadAction`, the
   path core's own header items use (core folds its open-in-editor, outline
   and lineage controls into the same menu as inline items). Still open:
   whether this slot should gain an optional menu-item hook so a control that
   reads thread-view context (for example `experimental_useThreadGit`) can
   fold into the menu, since `experimental_threadAction` `useData` runs
   app-wide.
4. **Per-pane mounting.** Confirm plugins handle mounting once per pane, and
   that a popover opened in one pane cannot leak into another.
5. **Height discipline.** The host clamps the control's layout box
   (`max-h-7 max-w-64`) so it cannot grow the chrome row, and does NOT clip
   vertical overflow — clipping it would also hide a popover anchored below
   the control, which is the normal way to show anything taller. In a pane
   row it clips horizontal overflow, so an unportalled popover wider than the
   plugin controls is cut at their edges. Decide whether the host should
   require a portal.
6. **Other headers.** Plugin panels: decided (2026-11-21): they do not need
   this slot. A navPanel's own `headerContent` already renders in the same
   title bar actions region on a single wide pane, and in the page's header
   row in split panes and below 768px. Still open: whether the compose screen
   and the workspace header need the same slot, or stay host-only.
7. **Title bar placement.** In a single wide pane the controls share the window
   title bar with the thread title and the center column. Confirm the title
   still truncates first with several plugins, and whether the 1024px overflow
   breakpoint should measure the bar instead.

### Note on `experimental_threadHeaderAction` crash isolation

`PluginSlotMount` takes an optional `instanceId` that participates in the
crashed-instance key, so one pane's crashed header control does not disable the
other pane's copy (or release its owned state). The thread-list slot omits it
deliberately: it mounts once, and a crash there should disable it everywhere.
Confirm that split before stabilizing, and decide whether other multi-mount
slots need the same treatment.

## `app.slots.experimental_threadCompanion` (`@omnyo/plugin-sdk/app`)

**What it does.** Shows a live companion for the open thread. A registration
is `{ id, title, icon, component }`; the component receives
`ExperimentalThreadCompanionProps` (`threadId`, `projectId`, `placement`).
Core owns the placement through one pure rule table
(`resolveThreadCompanionPlacement`). Phone-width layouts render it `"inline"`
in the stack above the composer. Otherwise it is an `"aside"`: a 288px card at
the top right of the thread pane, outside the scrolling timeline. That needs
room beside the centered 760px chat column: 16px on each side of the card plus a 44px reserve
for the scrollbar and the table-of-contents rail, with a 24px hysteresis band
so it never flaps. Without room, it is a `"toolbar"` row in the title bar's
center column, before `experimental_titleBarCenter` registrations. Each split
pane shows its aside when it fits; only the focused pane takes the toolbar,
and an unfocused pane without room shows nothing. The host adds no toggle:
the `"toolbar"` row is the component's own control, so Glance opens its card
from the row (2026-11-18; the earlier title-bar toggle duplicated that row and
was removed with its per-companion aside preference). The host mounts the
component once per visible thread pane, through a portal into a stable
container that it moves between placements, so component state survives a
move. Each move plays a 300ms FLIP morph on the Web Animations API (transform
and opacity only, `--motion-ease-spring`): a cloned ghost leaves the old rect
while the moved node grows from it. Reduced motion makes it instant. A crash
hides only that registration.

**Core caller (2026-10-30).** `ThreadCompanionHost`, `ThreadPaneTopOverlay`,
and `ThreadCompanionInlineSlot` in
`apps/app/src/components/thread-companion/ThreadCompanions.tsx`, mounted by
`ThreadDetailView` and `ThreadDetailPromptArea`. Core registers no companion
of its own; Glance is the first consumer.

**Audit before stabilizing.**

1. **Several companions.** Check how asides stack in one column and how
   toolbar rows share the center column with `experimental_titleBarCenter`;
   decide whether the host needs a width budget.
2. **Fixed geometry.** The fit rule uses constants for the chat column, the
   card, and the rail reserve. Confirm them against the table-of-contents rail
   and scrollbar as those change, and decide whether to measure them instead.
3. **Morph ghost.** The outgoing ghost is a DOM clone without iframes, media,
   or ids. Confirm canvases, iframes, and focused controls survive a move, and
   whether the host should restore focus after it.
4. **Hiding the aside.** The aside can no longer be dismissed on a wide pane.
   Decide whether companions need a host-owned hide control, and if so where,
   without duplicating the toolbar row.
5. **Props.** Decide from Glance's use whether components need the available
   width or more than `placement`.
6. **Unused registration fields.** `title` and `icon` lost their only host use
   with the toggle. Use them (for example to label the inline card) or drop
   them when plugins next re-vendor the SDK.

## `app.slots.experimental_threadView` (`@omnyo/plugin-sdk/app`)

**What it does.** Replaces the main pane of an open thread, below the
host-owned thread header. The thread header, the secondary panel, split panes,
and the compact drawer stay host-rendered. The registration is
`{ id, title, component }`; the component receives `{ threadId, projectId,
defaultView, transcript, composer, isCompactViewport }`. `defaultView` is
core's unmodified pane (timeline and composer); `transcript` is the same
timeline pane with no composer footer; `composer` is the thread composer
(`ThreadDetailPromptArea`) in the same footer chrome the timeline gives it
(`PageShellFooter` with `chat-prompt-box`). The view receives every thread and
renders `defaultView` for threads it does not claim. All three nodes reset the
plugin context, so core content inside a plugin view behaves as core.

The slot is exclusive: `resolveReplacement` picks the first registration in
deterministic slot order (plugins sorted by id, then registration order). With
no registration, including while plugin frontends boot, core renders
`defaultView` directly. A crash renders `defaultView` in its place and shows a
"Thread view plugin crashed" toast. The mount uses `instanceId` and
`crashResetKey` set to the thread id, so a crash disables the view for that
thread for the session without affecting other panes or threads.

The standalone composer still publishes to the pane's
`PluginComposerHostScopeProvider`, so drafts, queueing, banners, and the
secondary panel's composer host work. It sits outside the transcript's
`BottomAnchoredScrollBody`, so sending does not scroll a separately rendered
transcript, the scroll-to-bottom button is absent, and pending-interaction
forms are not height-limited to the scroll area. The plugin view's wrapper
carries `data-thread-window`, so the composer's `thread-pane` container
queries measure the plugin view.

Core uses the same path: `ThreadDetailSecondaryContent` always renders
`PluginThreadView`, which renders `defaultView` when no plugin registers.

Implementation: `apps/app/src/components/plugin/PluginThreadView.tsx`, used by
`apps/app/src/views/thread-detail/ThreadDetailSecondaryContent.tsx`.

**Audit before stabilizing.**

1. **Ownership choice.** First-by-plugin-id is not a user choice. Decide
   whether the user should pick the provider, as Settings → Appearance does
   for the thread list, before a second plugin registers a view.
2. **Per-thread claims.** The plugin decides per thread by rendering
   `defaultView`. Decide whether a declarative `claims(thread)` predicate is
   better, so core can skip mounting the plugin for unclaimed threads.
3. **Remounting.** The pane remounts when plugin frontends finish booting and
   on every plugin reload, which also remounts the composer and drops its
   focus. Drafts survive through draft storage. Confirm that is acceptable or
   keep the composer mounted across the switch.
4. **Composer outside the scroll body.** Decide whether `composer` should keep
   scroll-to-bottom and pending-interaction sizing when rendered beside
   `transcript`, for example through a host-owned layout component.
5. **Mutually exclusive nodes.** Rendering `defaultView` with `composer`
   mounts two composers for one thread. Decide whether the host should prevent
   this instead of documenting it.
6. **Crash scope.** Confirm per-thread crash disabling is right, or whether a
   crash should disable the view everywhere like the thread list.

## `app.slots.experimental_threadAction` / `experimental_useThreadActions` / `experimental_useThreadActionRegistrations` / `experimental_ThreadActionsMenu` / `experimental_ThreadActionsContextMenu` / `experimental_THREAD_ACTION_GROUPS` (`@omnyo/plugin-sdk/app`)

**What it does.** A registration is `{ id, title, icon, useData?, item }`.
`useData` is a React hook the host calls once for the whole app, in one
collector per registration mounted under `ThreadActionsProvider` inside the
registering plugin's context, never per row or per open menu. `item` is a pure
function of `{ thread, data, sdk, navigate }` (the registering plugin's bound
SDK and navigation) that returns a `PluginThreadAction` or null to hide it.
Collected data lives in a module store read with `useSyncExternalStore`, so a
surface pays one subscription and one pure `item` call per registration; a
throw from `useData` drops that registration, a throw from `item` drops it for
that thread, and `run` errors are logged and contained.

`useData` receives `{ threadIds }`: every thread some surface currently
evaluates actions for (`experimental_useThreadActions` callers, so sidebar
rows on screen, the open thread's header, and open menus), reference-counted
in the registry, sorted and deduplicated. A change is published once the set
has been quiet for 32 ms, at most 100 ms after the first change, so rows that
mount a frame apart during a scroll step arrive in one change. A surface
counts only while it is visible: the app sidebar wraps the thread list in
`ThreadActionSurfaceVisibility`, visible when its body is shown and the
sidebar (or the compact drawer) is open, so a hidden sidebar on a settings
route contributes no ids even if a plugin list mounts rows. It lives in
its own store read only by the collectors, so a change re-renders one
collector per registration, never the rows. Registrations without per-thread
state ignore it. This is the recommended pattern for per-thread data until an
attributes layer lands: keep an id-keyed cache, fetch only the ids not in it
in one batch, apply realtime updates per id, and fetch nothing for an empty
list.

Placement is static: a registration carries `group` and `order?`, and the
host keeps registrations sorted by `group` (string compare), then `order`
(unset sorts last), then registration order, so menus (with a separator
between groups) and the quick-action picker share one order. An evaluated
action is `{ label, detail?, icon, variant?, disabled?, choices?, run }`;
`detail` is a muted second line under the label (and follows the label in a
quick-action tooltip), such as a choice list's current value. Omnyo's groups are `experimental_THREAD_ACTION_GROUPS` (`1_open`,
`2_organize`, `3_settings`, `4_lifecycle`); any other string forms its own
group. `choices` is data (heading, hint, items): a submenu on desktop, a drawer
step with Back at compact width, a popover from a row quick-action button; the
picked id reaches `run` as `value`. `heading` (default: the label) titles the
drawer step and the popover; desktop submenus show none because their trigger
names them. `hint` is a footnote below the choices. `run` also receives `requestRename`, the
surface's own rename editor or Omnyo's dialog.

Omnyo's own actions are registrations of the same shape under the reserved
`omnyo--core` owner (keys `omnyo--core/<id>`), grouped as Open in split, New
thread in environment and Copy link in `1_open`; Rename, Pin/Unpin and Mark
read/unread in `2_organize`; and Shelve/Unshelve, Archive/Unarchive and Delete
in `4_lifecycle`. Shelve
(`omnyo--core/shelve`) reads `PluginThreadActionTarget.shelvedAt`, appears only
for top-level threads that are not archived, opens the next chat when it
shelves the one in view, and offers Undo; Unshelve shows no toast. Both run
through the host's optimistic shelf path, the same one `useSdk().threads.shelve`
and `unshelve` use. Desktop menus show the effective shortcut beside core
actions bound to app commands (`thread.copyLink`, `thread.shelve`,
`thread.archive`, `thread.rename`); that map is host-side, so the plugin API is unchanged and the
compact drawer shows none. The
thread-list plugin registers Move to section (`thread-list/move`) because the
destinations depend on its organization and section-order preferences. The
push-notifications plugin registers Notifications
(`push-notifications/notifications`) in `3_settings`: its `useData` keeps an
id-keyed cache of levels, fetches the `threadIds` it has not loaded in
`threadNotifications.list` batches of up to 200 (built on
`threads.experimental_listAncestors` and
`threads.experimental_listPluginMetadata`, so a parent's limit is read from
the current tree), and refetches the ones on screen after a reconnect. When a
thread's level or parent changes (its `threadNotifications.set` RPC, or
`experimental_thread.parentChanged`), the plugin server resolves that thread
and its unarchived, visible descendants
(`threads.experimental_listDescendants`) and publishes their levels on the
`threadNotifications` realtime channel, and does the same for a thread on
`thread.unarchived`; clients apply the rows they hold without a request. `item` resolves the level
with the plugin's shared resolver, shows it as `detail` with a per-level icon
(inline `push-notifications/ringing` and `push-notifications/off`, built-in
`BellDot`), and `choices` sets it. The
header menu, mobile recents, and both sidebar row menus render the host
components; the row's hover quick actions read `experimental_useThreadActions`
with `keys`; the thread archive keyboard command runs `omnyo--core/archive`,
the thread shelve keyboard command runs `omnyo--core/shelve`, and the thread
copy link keyboard command (`Mod+Shift+C` by default) runs
`omnyo--core/copyLink`.

`experimental_useThreadActions(thread, { keys?, requestRename? })` returns
`{ key, pluginId, action }` with `run(value?)` bound to the caller's
`requestRename`, contained, and resolving when the action settles.
`experimental_useThreadActionRegistrations()` lists registrations with their
static title and icon, independent of any thread (the row-actions picker).
`experimental_ThreadActionsMenu` (a drawer at compact width) takes `trigger`
as a render function: it receives the Radix trigger's props and ref
(`PluginThreadActionsTriggerProps`) and must spread them onto its button. The
host logs an error when the ref is never attached, and the SDK test fake
throws, because a trigger that drops them leaves a button that never opens.
It and
`experimental_ThreadActionsContextMenu` (right-click; touch long-press at
compact width) take `inline` items (`{ key, group, action }`) appended to their group (the thread
list's Customize row actions, the header's overflowed workspace and git
actions) and `requestRename`.

**Core callers on the same path.** `CORE_THREAD_ACTIONS`
(`apps/app/src/lib/thread-actions/core-thread-actions.ts`), the header menu
(`ThreadDetailView` → `ThreadDetailHeader`),
`ThreadArchiveCommandHandler`, and `ThreadShelveCommandHandler`. The contract table in
`apps/app/src/components/thread/ThreadActionsMenu.test.tsx` runs every host
menu surface against the same registrations.

**Audit before stabilizing.**

1. **Per-thread data.** `threadIds` makes each registration fetch and cache
   per-thread state itself. Decide whether a host attributes layer should
   batch those reads across registrations, and whether `useData` should move
   onto `experimental_useRpcQuery`.
2. **Picker catalog.** The row-actions picker lists every registration,
   including actions that rarely make sense as row buttons (Delete, New thread
   in environment). Decide whether a registration should opt out.
3. **Run input.** `requestRename` is the only surface-supplied capability.
   Confirm no second one is needed before stabilizing the run signature.
4. **Inline items.** `inline` exists for surface-specific entries that are not
   about a thread. Confirm it should stay a component prop rather than a
   registration.

## `experimental_useArchiveEnvironmentThreads` (`@omnyo/plugin-sdk/app`)

**What it does.** Returns `(environmentId) => Promise<void>`, the same
function core's environment-group archive uses (`ThreadActionsProvider`'s
`archiveEnvironmentThreads`): the bound SDK's optimistic
`environments.archiveThreads`, closing the archived threads' split panes,
moving off a route that shows one, and one Undo toast that unarchives them and
returns to that route. It rejects after Omnyo has shown an error toast. It is the
one host UI flow of the deprecated `experimental_useSidebarThreadActions` that
plain SDK calls cannot reproduce; the thread list's environment group menu is
the caller.

**Audit before stabilizing.**

1. **Scope.** A per-flow hook was the smallest honest path. If more host UI
   flows need exposing (thread archive and delete outside a menu), decide
   whether they become thread actions, bound-SDK side effects, or a small
   flows area instead of one hook each.
2. **Undo route repair.** The toast's route restore assumes the user has not
   navigated since; confirm that matches plugin-hosted surfaces.

## `app.slots.experimental_browserToolbarAction` (`@omnyo/plugin-sdk/app`)

**What it does.** Renders a plugin component beside the address bar in each
open Browser tab. The component receives the owning `threadId`, active `tabId`,
current `url`, and compact-viewport hint. Each tab mount has its own crash
boundary.

**Audit before stabilizing.** Confirm the toolbar can hold multiple plugin
controls without crowding the address field, whether ordering needs a user
preference, and whether plugins need browser instance or environment identity
instead of resolving it server-side from the thread and tab ids.

## `ExperimentalPluginBrowserToolbarActionProps.experimental_page` (`@omnyo/plugin-sdk/app`)

**What it does.** Gives a Browser toolbar action script access to its tab's
top-level document without a CDP lease. `evaluate(expression, { world })` runs
an expression through Electron `executeJavaScript` (`main`) or in Omnyo's isolated
world 1717 (`isolated`, the default), awaits it, and resolves the JSON-cloned
value. Isolated-world expressions receive `omnyo.postMessage(data)`, backed by a
Browser-tab preload that exposes the bridge only to that world; messages reach
`onMessage` listeners scoped to the calling plugin id and tab. The value is
`null` outside the desktop app.

**Audit before stabilizing.** Decide whether any enabled plugin may evaluate in
personal-profile tabs or whether this needs a user gesture, capability grant,
or origin allowlist. Plugins share one isolated world, so a plugin can post on
another plugin's channel; decide whether per-plugin worlds are required.
Confirm message size and rate bounds, subframe support, behavior during
navigation and renderer crashes, whether `evaluate` should time out while a
page is still loading, and whether an SDK or `omnyo` CLI surface is needed for
automation outside the toolbar component.

## `PluginMentionProviderRegistration.resolve().experimental_images` (`@omnyo/plugin-sdk`)

**What it does.** Lets a mention provider resolve a picked composer mention to
agent-only image inputs alongside its agent-only text context. Each image may
include a short agent-only text input immediately before it. The host validates
the same image paths and URLs used by ordinary prompt inputs before dispatch.

**Audit before stabilizing.** Confirm images are the only binary input mention
providers need, the 50-image boundary is appropriate, and local image access
should remain governed by the thread dispatch validator rather than an earlier
plugin-specific check.

## Composer API redesign: final names without the experimental prefix

**What shipped.** `useComposer()` returns one stable handle per composer
(`key`, `layout`, `isRunning`, `isSubmitting`, `isSubmittingBlocked`,
`submittingBlockedReason`, `isEmpty`, `attachmentCount`, `draft`, `insert`),
`removeMention`, `onSubmitted`, `submit` and `setSelection` replace their
`experimental_` names, `ComposerCustomization.sendMenu` replaces the send
menu's hard-coded plugin ids, `PluginMessageActionContext.composer`
exposes the message thread's composer, and `useComposers()` lists a handle for
every composer on screen that customizations mount in (excluding the
sent-message editor), oldest first. Michael decided to ship these under
final names as an explicit exception to the experimental-prefix rule, so
plugin authors migrate once. Replaced members (`useComposerView`,
`ComposerView`, `richText.onDraftChange`, `ComposerStructuredDraft`, the
`experimental_` composer names, the `side-chat` scope and the `zen` layout)
are tagged `@internal`: `stripInternal` removes them from the published
declarations while the runtime keeps exporting and implementing them, so
existing plugins keep working. The frontend export parity test lists the
runtime-only exports.

**Audit.**

1. **Handle semantics.** A stable handle with reactive getters means memo
   dependencies must name fields (`composer.draft`), not the handle. Confirm
   the lint and documentation guidance is enough.
2. **Mention shape.** `ComposerMention` exposes core resource fields (path
   source and entry kind, command source and origin, and the stored path an
   `attachment` mention shares with a file attached to the same draft).
   Confirm these are stable enough to be public.
3. **Canonical pill text.** `insert` writes the editor's canonical pill text
   (`@label` for plugin mentions), while `insertMention` keeps writing the
   bare label. Decide whether `insertMention` should converge.
4. **Message-action composers.** They have no slot lifecycle, so
   `setTextEffect` and `setInputLock` warn and do nothing there. Confirm.
   `useComposers()` handles behave the same way.
5. **Runtime-only aliases.** Decide when, if ever, the runtime drops the
   `@internal` names.
6. **Composer list order and membership.** `useComposers()` orders by mount
   and omits the sent-message editor. Decide whether panels also need the
   last-focused composer to pick a default target.

## Composer mention removal and successful submission subscriptions

`PluginComposerApi.removeMention({ provider, id })` removes all matching mentions owned by the calling plugin from the current unsent draft, deletes their label text, rebases other mentions, and preserves attachments. It does not delete server records or alter sent messages.

`PluginComposerApi.onSubmitted(listener)` observes successful local thread-send, queue-create, and new-thread-create mutations in the matching composer scope. It returns an unsubscribe function; host teardown also disposes subscriptions. Failed requests, draft clearing, and editing an existing queued message do not notify. This is a local UI notification, not a cross-device server event.

Before stabilization, audit handoff scope routing, decide whether to include the submitted structured draft in notifications to distinguish annotations created while a request is pending, and verify disposal, failure restoration, mention rebasing, and callback failure isolation across every composer host.

## `useComposer().submit` and dispatch `experimental_submission`

**What it does.** Submits exactly as pressing Enter would, applying the same
checks as the host's send button (it waits for uploads in progress, then
rejects with `submittingBlockedReason`), with the draft that is on screen, preserving attachments, @-mentions, and the execution and
environment choices visible in a new-thread composer. `sendAt` schedules the
submission. `experimental_data` carries opaque JSON to every message dispatch
hook on the initial attempt in an `experimental_submission` envelope containing
the calling plugin's id. Core validates JSON but does not persist or interpret
it. Hooks run before operational core waits; a plugin-authored wait persists
its owner through the queued row's existing `waitingOn` value. Backed host-side
by an optional `submit` on the internal
`PluginComposerHost`, supplied by the thread, `ThreadChat` and new-thread
composers. Rejects
with a user-presentable message when the composer cannot submit and restores
the draft after request failure. Consumers: `plugins/scheduled-send` and
`plugins/drafts`.

**Audit before stabilizing.**

1. **Programmatic send authority.** `experimental_data` permits an immediate
   submission without `sendAt`. Confirm which composer customizations should
   receive that authority before stabilization.
2. **Editors that save instead of send.** The queued-message and sent-message
   editors and the route-draft fallback have no `submit` and reject with
   "cannot submit programmatically". `isSubmittingBlocked` lets a row disable
   itself before a click; confirm whether those surfaces also need a
   distinct capability flag.
3. **Data visibility.** Every dispatch hook sees the envelope and its owner id,
   not only the plugin that submitted it. Confirm that dispatch hooks remain
   the right trust boundary for plugin-owned submission data.
4. **Freshness of `sendAt`.** The host rejects a non-future `sendAt` at
   call time and the server accepts any non-negative timestamp, dispatching a
   past one inline at once. The only guard against a time that goes stale
   between the plugin computing it and the request landing is that window
   being small. Decide whether the send/create routes should refuse a
   `sendAt` in the past outright.
5. **No submission identity is returned.** The method resolves with nothing, so
   a plugin cannot address the queued row it just created (to edit or delete
   it) without listing the thread's queue. Confirm whether the queued message
   id belongs in the result.
6. **Plugin-hosted new-thread composers.** `sendAt` reaches a hosting plugin's
   `onSubmit` and must be forwarded. The opaque submission envelope is currently
   a core-host detail and is not part of `NewThreadRequest`, so another plugin's
   `experimental_data` can be lost in that surface. Decide whether to expose a
   forwardable experimental field or reject data-bearing submissions there.

## `ComposerSubmitOptions.experimental_expectHeld`

**What it does.** `submit({ experimental_data, experimental_expectHeld: {
reason } })` tells the host that the calling plugin's own `message.dispatch`
hook will hold this submission with `{ action: "wait", reason }`. The thread
composer host turns the hint into `expectedPluginWait` on the send request,
and `optimisticSendWait` predicts a queued message waiting on that plugin and
reason, so the message appears at once in the queue and the chat keeps its
resting status instead of flashing a sent row and Working until the server
answers. In the new-thread composer the starting chat's row shows Waiting
instead of Starting chat, and the starting chat stays out of the Inbox's
Running list. The hint never reaches the server; the server's delivery always
wins, and an unheld submission is corrected to a sent message by the existing
reconciliation. The host rejects the hint without `experimental_data` and
rejects a reason that is empty or longer than 200 characters, before anything
is sent. Consumer: `plugins/drafts`, which also confirms "Draft saved" as soon
as it calls `submit` and replaces the confirmation with the error if the
submission fails. Core composers never set the hint; they take the same
`optimisticSendWait` path through `readCachedThreadDispatchWait` when a
dispatch-readiness handler predicts a wait.

**Audit before stabilizing.**

1. **Trust.** A plugin that sets the hint but whose hook does not hold the
   message shows a brief queued-then-sent flicker. Decide whether the host
   should derive the prediction from a registered dispatch-readiness handler
   instead of a per-call hint.
2. **Scheduled and held together.** The hint wins over `sendAt` in the
   prediction, matching the server, where dispatch hooks run before time
   waits. Confirm once a consumer combines them.
3. **Plugin-hosted new-thread composers.** The hint reaches a hosting
   plugin's `onSubmit` as part of the submission fields; decide whether to
   strip it there with the other host-only fields.

## `useComposer().setSelection`

**Reactive read added after #4474.** `PluginComposerApi.selection` is a final-named
member by the same explicit composer API naming exception as `setSelection`.
It reports the current picker/submission selection as a stable snapshot and
re-renders `useComposer()` and `useComposers()` consumers when a user or plugin
changes a picker. Queued-message and sent-message editors report their
read-only pickers: the thread's provider with the queued message's settings or
the thread composer's settings. It is `null` for composers without pickers. Missing fields
represent unavailable or unselected values; `isSubmittingBlocked` remains the
submission readiness signal. Audit snapshot identity across provider catalog
reconciliation and off-screen composer lifetimes before treating the read
contract as stabilized.

**What it does.** Sets a composer's pickers (provider, model, reasoning level,
service tier, permission mode, and in a new-thread composer the project and
environment) through the same handlers the pickers call, so a plugin-made
choice is indistinguishable from a hand-made one: in the new-thread composer
the values become the remembered defaults and are reported as explicit in
`executionInputSources`; in a thread composer a provider change begins the
handoff (snapshot for exit, handoff block prepended to the draft) and a
same-provider model change does not, exactly like the picker. Omitted fields
are left alone. Fields the composer has no picker for are ignored, not
rejected: a thread composer drops `projectId` and `environment`, a provider
without service tiers drops `serviceTier`, a fork draft keeps its locked
project, provider and environment, and a provider the composer does not list
is ignored together with the model and reasoning level meant for it. The new-thread host switches the project
first and awaits it (attachment copy, and the composer remounts plugin
surfaces), then applies the environment and machine with the new project's
setters, then a provider change and a catalog reload, then model, reasoning,
tier and permission mode each on its own commit. Resolves with the composer's
own selection once the applied values have committed and the model catalog
for the selected provider and machine has settled (data present and not a
placeholder, or the query errored), bounded at 15 seconds after which the
selection as it stands is returned. Backed by an optional `setSelection` on
the internal `PluginComposerHost`, supplied by the thread and new-thread
composers, including the plugin-embedded `experimental_NewThreadComposer`
whose component-local selections leave the stored new-thread preferences
untouched. The input type is `ComposerSelection`; the hook
validates it and rejects unknown reasoning levels, tiers and permission
modes. The testing harness records accepted calls in `composer.selections`.

**Audit before stabilizing.**

1. **Provenance.** A value set by a plugin in the new-thread composer is
   stored and reported exactly like a hand-picked one, so a routed thread is
   indistinguishable from a chosen one in the user's preference history. A
   plugin that needs to tell them apart tags its own threads through plugin
   metadata. Decide whether `executionInputSources` should carry a plugin
   source before a second consumer needs it.
2. **Timeout shape.** The bounded catalog wait resolves with the unsettled
   selection rather than rejecting. Confirm that is the right failure mode
   for a plugin that shows the result to the user.
3. **Provider inputs.** `environment.inputs` are not applied; the provider's
   inputs control keeps its own value. Decide whether the seed path's inputs
   handling should be reused here.
4. **Guard semantics after a project switch.** The `isActive` guard stops a
   stale surface from starting a call but a call already in flight survives
   its own surface's unmount and resolves with the settled result. Confirm
   that is the behavior plugins expect, and whether the promise should also
   resolve early when the composer itself unmounts.
5. **Model-only thread changes.** A model change in a thread without a
   provider change sets the next turn's model in place, as the picker does.
   Confirm plugins do not expect it to start a handoff.
6. **Empty selections in the result.** `providerId` and `model` are omitted
   while the composer has nothing selected and `environment` while nothing is
   submittable, which overloads "missing" with "no picker here". Decide
   whether the result should distinguish them.

## Desktop browser control

`api.sdk.experimental_desktopBrowsers.profileRenderer(input)` captures the actual
app-shell renderer selected by `hostId`, `instanceId` and `generation`, without a
thread, browser tab or control lease. `ExperimentalDesktopRendererProfileInput`
accepts `durationMs` from 200 to 5000, default 2000. Only native clients advertising
`rendererProfiling: true` receive the command; absence returns unsupported before
dispatch. Core CLI uses this same route through `omnyo browser profile-renderer`.
The bounded `ExperimentalDesktopRendererProfile` returns same-origin app asset
paths, one-based source coordinates, sample counts, fixed engine counts and
omission/truncation information. Sampling interval is configured, not a guarantee
of actual spacing. No function names, raw URLs, stack trees or user content leave
the desktop. The command does not focus, reload or change throttling; it refuses
an existing debugger and owns only its temporary attachment. Before stabilizing,
verify source attribution, navigation/destruction and timeout cleanup, debugger
ownership, privacy canaries, sample conservation, stale windows and old-client
refusal. Native installation remains separate from runtime/SDK delivery.

`api.sdk.experimental_desktopBrowsers` and the exported `ExperimentalDesktopBrowsersArea`, `ExperimentalDesktopBrowserScope`, `ExperimentalDesktopBrowserLease`, `ExperimentalDesktopBrowserCreateInput`, and `ExperimentalDesktopBrowserAcquireInput` expose explicit host/window/thread discovery, tab creation in the Omnyo browser profile, expiring control leases, scoped CDP connections, capture, reveal, close, release, disposable tab-state subscriptions, and cookie import from an installed browser through `listImportSources` (with an optional `recommended` selection for the macOS default browser) and `importCookies` (`ExperimentalDesktopBrowserInstanceRequest`, `ExperimentalDesktopBrowserImportCookiesInput`, `ExperimentalDesktopBrowserImportSources`, `ExperimentalDesktopBrowserImportOutcome`). The matching core CLI is `omnyo browser`.

While a scoped CDP connection controls a tab, the page's `alert()` and `confirm()` dialogs never open natively over the desktop window. They wait for the controller to answer `Page.javascriptDialogOpening` with `Page.handleJavaScriptDialog`; Playwright dismisses them unless the script listens for `page.on("dialog")`. A dialog still open when control ends is dismissed, and later dialogs open natively again (`apps/desktop/src/desktop-browser-dialogs.ts`).

Every desktop tab, including tabs created for an agent, uses the single Omnyo browser profile and its signed-in cookies. Before stabilization, audit control and cookie import authorization: any caller with server access can control tabs carrying the user's logins and copy the desktop user's browser sessions into that profile, with OS consent only where the platform demands it (macOS Keychain for Chromium, Full Disk Access for Safari; none for Firefox or keyring-free Linux Chromium). Decide whether control or import should require a desktop-side confirmation. Also audit per-tab mutual exclusion and child-target scope, native popup handling, debugger detachment, daemon/desktop disconnect and reconnect generations, expiry and cancellation races, bounded screenshot bytes, and cross-platform desktop startup. Connection credentials must remain private to workers on the browser host. `subscribe` polls every two seconds with one outstanding request; it is state observation, not a lossless event log. Cloud browsers and external provider registration are outside this surface.

## Machine paths and environment cleanup

`api.sdk.hosts.get({ hostId })` includes nullable `threadStorageRootPath`
from the machine's latest daemon session, even offline or without live threads.
It is null before a session has reported paths. Reading details does not wake the
machine or create directories. CLI: `omnyo machine show <id-or-name> [--json]`.

`api.sdk.environments.experimental_cleanup({ environmentId, hookStopped? })` explicitly requests
removal of an unused provider-managed environment, overriding automatic retention
or keep policy and bypassing cleanup backoff. Normal retirement and failed-cleanup
retries remain automatic; callers do not need to invoke this during routine
thread work. It rejects live threads and
unmanaged environments; already-removed provider environments succeed without
another removal. Acceptance is not completion; inspect the ordinary environment
lifecycle fields for progress. `hookStopped: true` records the caller's
confirmation, after inspection, that an interrupted teardown hook whose outcome
became unknown is no longer running; removal then proceeds without rerunning that
hook. Automatic cleanup never sets it. CLI:
`omnyo environment cleanup <id> [--hook-stopped] [--json]`.

Before stabilization, audit path portability and session freshness after machine
re-enrollment, and cleanup retry behavior across unavailable providers, concurrent
attempts, and environments shared by archived and live threads. These APIs reuse
existing session data and provider lifecycle state.

## Host process primitives (`@omnyo/plugin-sdk/host`)

`experimental_spawnPortableOutputProcess`,
`experimental_sanitizeInheritedChildProcessEnv`, and
`ExperimentalSanitizeInheritedChildProcessEnvArgs` expose output-only child
process spawning and inherited-environment sanitization for host-local plugin
operations. The private environment host module uses these for git commands.
Core runs `.omnyo-env-setup.sh` after an owned-path create and
`.omnyo-env-teardown.sh` before removal; providers must not run those hooks.
The unused public process-group kill and platform-check exports were removed.

Before stabilization, audit command cancellation, inherited environment filtering,
and portable output handling for host-local plugin commands on every supported OS.

- `PluginEnvironmentProviderCreateContext.experimental_claimPath(path)`: durable,
  asynchronous atomic host/path reservation on the launch row before provider
  mutation; resolves false for competing claims or stale attempts. Claims use
  the supplied host/path, with trailing slashes normalized. The claim
  is released by attachment or completed cancellation cleanup,
  including after failure. Stabilize after restart, cancellation,
  competing checkout, and path-reservation behavior has been audited.

## `TimelineOutputPreview.experimental_fullOutputAvailability` (`@omnyo/plugin-sdk`)

**What it does.** Distinguishes why a timeline row contains a preview instead
of the full completed output. `available` means an explicit detail read can
still hydrate the retained value, `detail-limit` means that read stayed
previewed because its response byte budget was exceeded, and
`retention-expired` means the full value reached its retention deadline and no
longer exists. The field is reachable through the timeline results returned by
`api.sdk.threads.timeline` and lets clients avoid retrying an expired value or
describing it as merely too large.

**Audit before stabilizing.**

1. Confirm these three states remain complete if another output storage tier
   or hydration limit is introduced.
2. Confirm plugins need the storage-policy distinction rather than a simpler
   boolean indicating whether a detail read can succeed.
3. Verify old persisted previews and mixed-version clients still receive a
   deterministic state before making the field stable.

## Document Markdown (`MarkdownProps.experimental_document`)

The existing Markdown component accepts explicit `{ target, rootPath, threadId }`
document context. `target` is an existing workspace or thread-storage live-file
identity; `rootPath` is its resolved filesystem root. Relative links and images
resolve from the document directory within that root. Links open the explicit
file target; images use the selected thread's existing source-confined route.
Thread-storage targets must name the same thread. Omission retains message
routing; malformed context does not fall back to the ambient workspace.
Explicit absolute paths retain existing host-file behavior. HTML is unaffected.
Stabilize after plugin consumers verify nested paths, source identity, missing
files, containment and line locations, then rename and remove this audit entry.

## `PluginFileOpenerProps.experimental_lineRange` (`@omnyo/plugin-sdk/app`)

**What it does.** Passes the owning file tab's latest one-based, inclusive
`{ startLineNumber, endLineNumber }` range to its opener. `null` means no
requested navigation; older hosts may omit the optional property. The app
supplies a new object on each targeted open, even when the active file and
line numbers match. Openers should observe that identity, reveal the latest
range after asynchronous loading, and navigate without replacing an existing
editor model. Monaco selects the complete lines and clamps targets past EOF.
Columns are not part of the existing preview range contract.

The range uses the existing tab owner and persistence policy. This adds no
RPC fields, server-daemon messages, file permissions, or new CLI syntax.
Existing `omnyo thread open <thread> <path> --line <line>` / SDK thread-open requests
and plugin file navigation feed the same opener boundary.

**Audit before stabilizing.**

1. Verify first, changed, identical, and rapid targets across workspace, host,
   and thread-storage files, tab remounts, and server synchronization.
2. Validate the identity-based repeat signal with third-party openers and
   decide whether an explicit request sequence is needed before stabilization.
3. Confirm absent-target, inclusive selection, EOF clamping, column support,
   file-tree navigation, and unsaved-edit behavior with more editor consumers.
4. Verify older hosts omit the prop safely and older plugins ignore it; audit
   reload restoration and cross-client range updates under the existing tab policy.

## `api.experimental_eventSources.register`

`PluginEventSources.register(PluginEventSourceDeclaration)` adds one wait event
family, so `omnyo wait --event <family>:<target>` and `registerWait({events})` can
name its keys. The declaration gives `family` (2 to 32 lowercase letters, digits
or dashes, unique across plugins and Omnyo's core families), `label`, `keyFormat`,
one to five `examples` that pass `validate`, `approval` (`none` or `owner`),
`validate(target)` and `describe(target)`, an optional `poll` (`everyMs` of at
least 60 000 and `check(targets, {signal})`) and an optional
`proof({signal})`. Registration throws for an invalid declaration or a taken
family; a disposed plugin's families disappear with it.

The server owns scheduling and health. Its `inbox-event-sources` sweep groups
pending event conditions of live waits by family and calls `check` once per
family with every distinct pending target, at most every `everyMs`. The source
returns `{target, result}` for each target that fired and `{target, problem}`
for each target it cannot check; omitted targets keep waiting. A check or proof
that throws, times out after 30 seconds or returns another shape is a source
failure: the next poll backs off exponentially to at most six hours, and after
three consecutive failures each affected wait gets one `stall` receipt, "Can't
check "<describe>": <error>". Three consecutive problems for one target raise
the same receipt on that target's waits alone. A successful check clears the
markers. Before the first check, and again after a failed check, the server
runs `proof`; while it fails, registration of the family's keys is refused with
the proof's message, and `checkEvent` re-runs the proof. A push source
(`poll: null`) reports through `reportEvent`. `approval: "owner"` makes an agent,
automation or plugin wait on the family's keys a `watch` proposal that runs only
after the owner accepts it.

Core callers use the same path: Omnyo's own `host-reconnect`,
`coordinator-version` and `automation-run` families live in the same registry as
push sources, `registerWait` validates and describes every key through it,
`omnyo wait sources` and `omnyo wait check` read it through `eventSources` and
`checkEvent`, the bundled GitHub plugin registers `github-pr` and
`github-checks`, and the bundled Wait sources plugin registers `http`, `file`
and `command` through this member. A watch proposal's receipt names every key
that needs approval in full, so the owner sees the exact URL or command. Stabilization requires the poll sweep,
backoff and stall receipts to survive a server restart without duplicate
receipts, a disposed plugin's in-flight check to be ignored, proof results to
expire on a schedule rather than only after a failed check, and a third-party
family to round-trip through `omnyo plugin new --event-source`, `omnyo wait check` and
a resumed wait on a dev server.

## `api.experimental_secrets`

`PluginSecrets` keeps a plugin's string values in
`<dataDir>/plugins/<id>/secrets/<name>`, sealed with AES-256-GCM under the
data directory's vault key, which the macOS Keychain, Windows DPAPI or an
explicit key file holds. `get(name)` returns the value, or `undefined` when the
secret does not exist. `set(name, value)` replaces the file atomically with
ciphertext. `delete(name)` removes it. `list(prefix?)` returns the `/`-joined
names that start with `prefix` as a plain string prefix, sorted, like
`storage.kv.list`. A name has one to four `/`-separated segments of letters,
digits, `.`, `_` and `-`. No segment starts with `.`, and the whole name is at
most 200 characters. Any other name throws before the server touches the disk.
The server runs the operations on one name one at a time, so a read that seals
a legacy file cannot overwrite a concurrent `set`.

A plugin's first call in a server process seals every regular plaintext file in
its `secrets/` folder, whatever its name, including the core-reserved
`.http-token`. The sweep skips symbolic links and other dot-named files, which
are temporary files. The server logs the name and error code of a file it
cannot seal, and reading that file reports the error. Reading a legacy plaintext file also
seals it in place, byte for byte. A sealed file from another data directory's
vault fails with `wrong_vault`. Omnyo never replaces it with a new value.

Core callers use the same store. A secret setting (`settings.define` with
`secret: true`) is the secret named after its key, and core seals the declared
keys when the plugin defines them. The plugin HTTP token is the reserved name
`.http-token`, which the name rule keeps out of plugin reach. Server-move
pending boot reads the `credential` secret of Omnyo account and Connect through
it. `omnyo server export`, server moves and the standalone export helper decrypt
every sealed file in memory, so archives carry plaintext as before and never
include `vault/`. The bundled Account Pooler, Omnyo account, Connect and
Automations plugins keep their credentials through this member.

Stabilization requires a decision on a value size limit, a name rule that
accounts for case-insensitive file systems (`Token` and `token` are one file
on default macOS and Windows volumes), a third-party plugin round trip through
the fake plugin host, and Keychain and DPAPI proofs on every platform that runs
a coordinator.

## `api.experimental_serverAccess.recheck`

`recheck` sends a system `config-changed` notification to connected clients.
It carries no payload. Connect signals when its paired state or public URL
changes, rather than on every tunnel status publish.

The configuration response refreshes registered providers' availability in
parallel, with a five-second deadline per check. Exceptions, invalid output, and
timeouts produce an unavailable result without exposing raw provider errors.
Machines settings, manual setup, and promptbox banners consume this same status.
Reading configuration never acquires a grant; acquisition checks its selected
provider independently, including when an existing machine retains an older
provider selection.

Stabilization requires proving that a recheck from an unregistered or disposed
plugin is inert, that a provider cannot use it to force repeated refreshes of
unrelated configuration, and that pairing, unpairing and credential rejection
each reach the Machines settings section without a manual reload.

## `api.experimental_serverAccess.register`

Availability may include an optional public `serverUrl`. Core validates HTTP(S)
URLs without embedded credentials before exposing them through configuration.
Machines settings displays that URL for available providers; an available result
without a URL is valid. The acquired grant's URL still drives machine traffic.

`PluginServerAccess` registers server access through `ServerAccessProviderDeclaration`: id,
displayName, description, availability, acquire({ key, hostId, signal }) and
release({ key, hostId, grantId }). Acquire returns either a `ServerAccessGrant` carrying
`{ id, serverUrl, headers?: Record<string, string> }` or
`{ status: "failed", message }`.
Machines attach these optional headers to enrollment, HTTP, WebSocket and runtime
requests. A direct grant omits headers; access providers own credential redemption.
Core chooses the configured access provider and retains it for the machine. Core persists only
provider id and grant id per host; credentials travel in bootstrap delivery.
Direct access reads machineServerUrl with OMNYO_EXTERNAL_URL fallback.
defaultMachineAccess selects a provider; otherwise core uses the first registered
provider, or direct when none are registered. Access covers account-pool and other
runtime requests after enrolment. Connect redeems Cloud codes server-side and persists connectMachineId with the
grant before returning it, allowing release to revoke even before enrollment.
Host detail retains connectMachineId from trusted gate metadata for legacy grants.

The failed acquisition result exposes its deliberate user-safe recovery message
through the plugin boundary; ordinary thrown errors stay redacted. Release receives a null grantId when acquire was interrupted. Core persists the
provider before acquisition and retries release by key and hostId. Keep intent and credential-bearing grants in private plugin storage; never
put credentials in machine resources, inputs, or progress output.

Before stabilization, prove retry-safe acquire/release across process death,
credential privacy and revocation, explicit and automatic defaults, expired
codes, removal while a provider is unavailable, and both enrolment and runtime
traffic with independent direct and Connect consumers. Availability does not
prove reachability from a remote machine.

## Machine enrollment and bootstrap

`api.experimental_machines.bootstrap` prepares enrollment and waits for the daemon connection. Enrollment keys are scoped to the calling plugin and retain their host identity. Pending credentials are single-use and short-lived. Manual bootstrap bundles live only in server memory, so the user regenerates the command after a restart. Bootstrap bundles carry optional access headers. A successful exchange is recovered as `enrolled` after a server crash.

`MachineExecutor` requires argv, stdin, a timeout, an abort signal, and an output callback; it returns only an exit code. `bootstrap` requires the executor, passes the bundle through private stdin, and streams command output into progress logs. It installs pending enrollments and restarts enrolled identities after snapshot restoration. Core Manual setup uses internal enrollment operations. Bootstrap returns the reserved host ID. Installation requires Node, npm, and curl and installs no OS packages. Cancellation propagates through enrollment preparation and access acquisition.

Stabilization requires independent Modal and SSH consumers, failure verification for expired credentials, concurrent retries, interrupted exchange, cancellation, identity mismatch, and restored snapshots, plus an audit that credentials never enter resource data or logs. Migration and live vendor verification remain part of the integration release gate.

The bootstrap surface's supporting exports are `MachineExecutorRequest`,
`MachineExecutor`, `MachineBootstrapRequest`, and `MachineBootstrapApi`.
They belong to experimental `PluginMachines`; their unprefixed names do not
indicate stabilization. Bootstrap uses executor `exec`. Create must persist an
allocated resource with `await checkpoint(resource)`, then bootstrap with its
durable key. Stabilization must verify cleanup
of checkpointed allocation before successful enrollment, including safe no-op
uninstall when installation never began, and retry after partial installation.

## Machine provider `reconcileCleanup`

Required reconciliation-only cancellation callback on `PluginMachineProviderDefinition`.
It remains experimental through `api.experimental_machines`; the unprefixed callback
name does not indicate stabilization.
Core supplies the durable launch key, progress reporter and a cleanup signal.
This callback is only used without a resource checkpoint; remove receives known resources. Providers discover and remove uncertain
allocations using vendor tags, names or metadata; the callback must never allocate or bootstrap.
Return removed only after cleanup is settled (including no submitted allocation), or
failed while the allocation is unresolved. Core persists the core cleanup retry deadline
across sweeps and restarts, including subsequent access release failures.
Stabilization requires crash/abort coverage before submission, after submission but
before checkpoint, eventual vendor discovery, and access-release retry coverage for
each shipped provider.

## Machine provider `ephemeral`

Optional boolean on `PluginMachineProviderDefinition`, defaulting to false.
Providers set it only when they create disposable compute. After the last
live thread and its creating/ready machine launch are gone, core automatically
requests removal regardless of environment retirement policy. Ephemeral removal
does not invoke environment providers or resume suspended compute; after compute
removal succeeds, core marks every attached environment destroyed with teardown
removed as read-only history. The request uses the ordinary durable machine
removal lifecycle, including `removeRetryAt` retries. Manually enrolled machines and providers
that omit the field are never automatically removed. Stabilization requires
another compute provider and recovery coverage across environment retirement,
live-work races, provider unavailability, and repeated removal failures.

### Machine lifecycle allocation checkpoint

`PluginMachineProviderLifecycleContext.checkpoint(resource): Promise<void>` on
the experimental machine-provider contract persists a bounded recovery record.
Create extends this context; suspend and resume add the current host and resource.
It is not a filesystem save, and daemon-connected is not agent-ready: checkout
setup and provider authentication remain core work.
Core fences provider ownership, lifecycle phase and a persisted operation ID;
stale resume, suspend and removal completions cannot replace newer state. Restart
uses the checkpoint with the same enrollment key. Stabilization requires real-DB
crash recovery after allocation/before bootstrap, competing lifecycle operations,
wrong-owner rejection and no duplicate enrollment. Standalone launch submission
is durable; SDK submit/launch/follow/cancel match CLI create/status/cancel.

Unknown-allocation reconciliation, known-resource removal, and access release
retain failed cleanup state and retry at the core retry interval until successful.

## Transient provider setup data

Manual setup is built into core. Core keeps the
manual bootstrap bundle in memory and serves the command and expiry through the
host-keyed enrollment-command endpoint. Reading does not renew the enrollment.
Completion, removal, expiry, and server restart remove the cached command. Commands stay out of
persisted progress and transcripts. Machine credentials cannot retrieve commands.

Stabilization requires expiry/removal, credential authorization and
transcript-redaction coverage.

## Project checkout ownership

The provider context's `projectCheckout.experimental_ownsPath` identifies a
checkout materialised by core. The field is a required boolean whenever a
checkout is present, derived from persisted source ownership, never
from caller inputs. Project checkout reports ownsPath only for that exact path,
so core's environment hook policy applies to fresh machine clones and leaves
user-maintained attachments alone. Audit ownership propagation and recovery before stabilizing.

## Coordinated machine maintenance

Plugins own idle timing using event notifications, plugin KV and background schedules.
Core does not impose a second idle timeout or veto pause merely because work is active.

`api.sdk.hosts.experimental_suspend({hostId})` accepts follow-ups into the existing host-wait queue, drains active turns, setup hooks
and terminals with a five-minute bound, then invokes the provider's suspend callback.
It rejects with `machine_busy` while persisted state still ties a live thread launch or a
provisioning environment to the host, or while core is preparing a project checkout there.
Automatic idle schedulers retry after that state clears.
`await suspend.checkpoint(resource)` durably persists opaque provider state before destructive
cleanup. Core fences operations and resumes the same host identity without rerunning checkout setup. Providers own vendor observations, snapshots, loss reporting,
and expiry scheduling using `api.background.schedule` and startup reconciliation.
Providers must reserve the full drain bound plus snapshot time and scheduling jitter;
a server outage or late wake cannot guarantee preservation. Unsafe recovery must fail
inside the provider; a dispatch hook is not an integrity boundary.

The host DTO's lifecycle phase and progress expose maintenance state and suspension
or resume failures. Explicit machine removal remains available.
Stabilization requires interruption, checkpoint/restart, removal serialization,
failed drain, bounded drain and same-identity restore tests.

## Thread-sequence and terminal-input notifications

`PluginEvents.on("experimental_thread.events", handler)` delivers `{thread, sequence}`.
Core coalesces appends per thread into one notification per one-second window, reading
the latest sequence and current public thread DTO at delivery. Continuous output is
reported periodically; the last pending window is delivered after output stops.
Reads/polling do not emit it. No contents, replay, activity classification or veto.

`PluginEvents.on("experimental_thread.events", handler, {experimental_eventTypes})`
filters known append batches before core builds that DTO. Unfiltered subscribers
retain the existing rich delivery. Each filtered subscription receives its first
batch for each thread for history catch-up; unknown or discontinuous coverage also
delivers. Core retains the last observed range for at most 512 recently notified
threads per subscription; a thread evicted from that metadata starts with catch-up
again. Older hosts ignore the option and deliver every batch, so handlers retain
their local relevance checks.

`experimental_eventTypes` and `experimental_coveredSequence: {from, to}` on the
payload describe exactly the contiguous appends captured at notification time.
Both are absent when any merged notification has unknown or gapped coverage.
The rich snapshot and `sequence` may be newer than that range. Consumers advance
durable cursors only through events they actually read, and retain startup and
first-notification catch-up. Stats, Codex async questions, composer predictions,
Account Pooler composer validation and State Machines use the shared dispatch path.
Stabilization requires mixed legacy/filtered delivery, old-host option compatibility,
initial catch-up, bounded metadata eviction and append-during-flush range proofs.

`PluginEvents.on("experimental_terminal.input", handler)` delivers `{terminal}` after
real nonempty user input is forwarded, including interactive terminal input. No input
contents, output or keepalives are exposed. The public terminal DTO identifies its host.

Modal v1 bumps its own idle clock when the delivered thread is active, and on terminal
input to its machines. It does not fetch or classify thread events. Stabilization
requires coalescing tests, live streaming/terminal verification, current-status behavior,
and review of event delivery overhead. No daemon wire change is required.

Follow-ups before the suspend callback cancel preparation after work stopping settles.
After callback invocation, core completes pause and resumes for queued work. Reconnection
alone must not release work during preservation. Cancellation is reported as a rejected
pause, not a successful save.

## Conditional generated thread titles

`threads.update({ threadId, title, experimental_titleIfUntitled: true, signal })`
accepts a title without other metadata changes. The server uses core's
`applyGeneratedThreadTitle` synchronously and writes only while the current title
is empty. It returns the current thread with `experimental_titleApplied`:
`true` when applied, or `false` when an existing title was preserved.

The SDK's optional `signal` controls the request and is not sent in the payload.
Cancellation before the write prevents mutation; cancellation after commit does
not undo it. Core provider titles and metadata inference use the same helper.
Before stabilization, verify same-turn naming, concurrent manual renaming, and
cancellation at the request/write boundary.

## Thread parent-change notifications

`PluginEvents.on("experimental_thread.parentChanged", handler)` delivers
`{thread, previousParentThreadId}` after a thread's `parentThreadId` changes:
a `threads.update` that moves or releases it (from the shared ownership seam,
which also writes the ownership timeline entry and parent system messages), or
core releasing an archived thread's unarchived children (one event per
released child, after the archive transaction commits). An update that keeps
the same parent delivers nothing. `thread` is the public DTO with the new
parent. Threads below the moved one move with it and get no event; callers
read them with `api.sdk.threads.experimental_listDescendants`. Delivery is
fire-and-forget like every other event, so a plugin that was not loaded never
sees the move. Push-notifications uses it to publish the moved subtree's
levels to open menus; before it, the only signal was the ownership timeline
entry behind `experimental_thread.events`, which forced the plugin to remember
each thread's last parent. Stabilization requires deciding whether a general
`thread.updated` event should replace it, and a second consumer.

## Thread maintenance runs

`PluginEvents.on("experimental_thread.maintenance", handler)` delivers
`{thread, phase, outcome}` when a core maintenance run starts (`phase:
"started"`, `outcome: null`) and when it ends (`phase: "ended"`, `outcome`
`completed`, `failed` or `stopped`). The only maintenance run today is
`auto-compaction`: core compacting an idle Claude Code chat about 50 minutes
after its last request, before the one-hour prompt cache expires. A maintenance
run is not the owner's turn, so core reports it here instead of through
`thread.active`, `thread.idle`, `thread.failed` and `turn.failed`, and it always
ends with the thread idle.

Every thread DTO in event payloads also carries `experimental_maintenance`:
`"auto-compaction"` while that run is active, otherwise null. Core classifies the
run with the same `isMaintenanceRunActive` helper that the Inbox engine, the
lifecycle outcome and the work-readiness listener use, so a plugin and core
never disagree about whether a run is maintenance. The classification comes from
the latest stored `client/turn/requested` event's `maintenance` field.

Concurrency-limit uses the field to leave maintenance runs out of its running
count and the `ended` event to free capacity; smart-queues settles on `ended`
like `thread.idle`. Stabilization requires a second maintenance kind or a
decision that one kind is enough, an audit of every `thread.*` listener for
runs that are not the owner's, and deciding whether the DTO field should also
appear on `GET /threads/:id`.

## `api.sdk.threads.experimental_setAutoCompaction`

`experimental_setAutoCompaction({threadId, enabled})`
(`PUT /threads/:id/auto-compaction` with `{enabled}`) turns automatic
compaction before the prompt cache expires on or off for one chat and returns
`{enabled}`. Core stores the choice in its own per-chat metadata; an unreadable
record counts as off. `GET /threads/:id/context` reports the result in
`autoCompaction`: `disabled` with reason `opted-out` while it is off, otherwise
`scheduled` with the due time, `skipped` with reason `lapsed`, the outcome
(`done`, `failed` or `stopped`, with `cacheReadShare`) of the latest automatic
compaction, or `disabled` with the eligibility rule that blocks it. The app's
composer chip "Keep full history" switch and `omnyo thread auto-compaction
THREAD_ID --on|--off` use this path.

Stabilization requires the experiment `autoCompactBeforeCacheExpiry` to ship on
by default, a week of measured maintenance outcomes, and a decision whether the
setting should also apply to future chats as a global default.

## Host deletion notifications

`PluginEvents.on("experimental_host.deleted", handler)` delivers `{host}` once after a
machine is removed: from `DELETE /hosts/:id` for manually added machines, and after a
machine provider finishes removal for provider machines. `host` is the public host DTO
at removal time (status `disconnected`); `api.sdk.hosts.get` returns 404 for it afterwards.
Delivery is fire-and-forget like every other event: a plugin that is not loaded at
removal time never sees it, so per-host state must also be reconciled against a 404
from `api.sdk.hosts.get`. Connect does both to prune shared ports of removed machines.
Stabilization requires deciding whether hosts deserve their own event map instead of
`PluginThreadEventPayloads`, covering removal paths added later, and a second consumer.

## `api.experimental_machines.getResource`

Returns core’s current persisted host resource as JSON, or null when the host or
resource is absent. Reads are available across plugins, following the host access
model; callers parse provider-specific data. Resources must contain identifiers
and configuration, never credentials. This lets provider RPCs inspect existing
machines without duplicating lifecycle state in plugin KV. Stabilization requires
validating missing-resource semantics and use by additional machine providers.

## Environment compositions

`api.experimental_environments.register({ id, displayName, description, icon, machineProviderId,
environmentProviderId })` declares a new-machine environment option backed by
one concrete environment provider. It cannot also supply lifecycle callbacks
or inputs. Its required icon is resolved from the composition’s owning plugin;
a provider-icon slot may customize its rendering. The server resolves the references before creating the launch,
persists the concrete provider and explicit machine selection, and uses the
existing provisioning lifecycle. Machine registration alone adds no picker row.

The environment-provider listing includes nullable `machineProviderId` and, for
compositions only, the target `environmentProviderId`. Clients keep the composition’s label and mount the target provider’s input
controls without changing the submitted composition ID.
Compositions appear outside host groups; explicit SDK/CLI creation omits machine
selection. Ordinary environment selections still require a machine. Core rejects
conflicting machine selectors, missing referenced providers and required missing
Git remotes before allocation. Modal combines its machine with project-checkout;
core retains checkout cloning, project-source registration and setup hooks.
A clone failure leaves the ready machine intact and records the thread error.

Stabilization requires UI/CLI parity, registration validation, pre-allocation
refusals, provisioning timeline coverage, clone-failure machine retention and
later project-checkout/worktree reuse. There is no clone plugin or new lifecycle.

For new-machine composition inputs, `experimental_useBranches` accepts a null
host and obtains branch suggestions from the project’s default local source.
Project-checkout treats that selection as a fresh clone: no source-checkout
conflict/dirty-state blockers apply, and an omitted branch uses the repository
default. Explicit branch inputs still pass to the concrete provider.

## Experimental host SDK machine operations

New host methods are experimental_create, experimental_getEnrollmentCommand,
experimental_listProviders, experimental_suspend, experimental_resume and
experimental_retryCleanup. There are no unprefixed aliases. Creation returns a
reserved host immediately when `wait: false`; otherwise it polls that host until
active. The enrollment-command method exists for the manual setup UI and CLI and
returns a credential only while that host is creating. Its optional
`shortCommand` carries a short setup code, the typeable `/m/<code>`
commands and, as `pageUrl`, the `/m/<code>` address a browser opens to show
those commands, while that code is usable; absence means only the full command
works. Servers before `pageUrl` omit it.

Before stabilizing, verify creation cancellation through host removal,
same-host restoration, serialized removal, plugin callers and UI/CLI parity.

## Moving the server (`api.sdk.experimental_server`, `hosts.experimental_deleteOldServerCopy`)

`experimental_server.checkMove({ targetHostId, serverUrl })` returns the pre-move
checklist (`ServerMoveCheckResponse`): blockers, warnings, whether a new server
address is required, and any standalone Omnyo data on the target that must be
archived. `startMove({ targetHostId, serverUrl, stopRunningWork: true,
archiveExistingTargetServerData })` freezes the server, stops running work,
copies server-owned data to the target, starts the new server there, switches
machines over, and retires this server process. `moveStatus()` returns the
active move and the last completed move (`lastMove`). A move whose activation
was never confirmed reports `recovery_required`: this server stays up and
frozen until the target confirms (activation retry or `<serverUrl>/health`
reporting ready). In direct mode the status carries `destinationStatusUrl`, the
new server's CORS-readable `/health`, so a client can follow the destination
after this server retires; it is null for Omnyo connect. `cancelMove()` works
until the switch starts, and in `recovery_required` it abandons the move and
rolls the switch back. `export({ signal })` streams an unencrypted gzip server
archive and returns its `fileName`, `body`, and the `sha256` digest the server
sent. `hosts.experimental_deleteOldServerCopy({
hostId })` deletes the locked old server data on that machine. All refuse
requests authenticated by a machine credential. `checkMove`, `startMove`,
`export`, and old-copy deletion also require the default-off `serverMove`
experiment and otherwise fail with 403 `server_move_experiment_disabled`. The CLI equivalents are
`omnyo server move|export|import|unlock|allow-connect|delete-old-copy|install-machine-service`.

Before stabilization, audit: authorization for plugin backends (`api.sdk` runs
with owner access, so a plugin can export every secret or move the server);
the switch ordering against the Omnyo connect tunnel and daemons that miss
`server.moved`; archive size limits and streaming memory use; cancellation
and failure recovery at every step, including a server restart mid-move;
behavior when the target runs a provider-managed machine; and whether
`startMove` should return immediately or expose progress through a durable
operation id instead of the in-memory status.

## `app.experimental_icons.register` and `experimental_Icon`

Plugins register inline React artwork during app setup with `{ name, component }`.
Names are trimmed, nonempty strings; namespaces are recommended but optional.
Names are shared across plugins, and any client component or app icon field may
reference them. Registration returns `void`. Duplicate names within one plugin
reject setup; across plugins the first plugin id in lexical order wins and the
host warns about collisions. All explicit registrations override built-ins.
The host commits icons with the plugin's other app registrations and removes
or replaces them on unload or reload, restoring the next owner or built-in.
A rejected setup leaves the previous generation intact.

`experimental_Icon` is the same renderer used by host app icons. It accepts
`name`, optional `fallback` (default `Zap`), `className`, `style`, `aria-label`,
and `aria-hidden`. Custom components receive sizing through `className`; the
host owns the accessible wrapper and applies tint through inherited color.
Missing references try the fallback, then the built-in `Zap`. Recursive
components terminate at the underlying built-in or `Zap`; throwing components
are contained and recover when their registration is replaced. Mounted icons
subscribe to changes in their requested and fallback definitions.

Per-item icon precedence changed in #4443: resolved explicit names win over
plugin branding for mentions, message actions (including text selection), nav
panels and fixed tabs, thread/new-thread panel launchers and their opened tabs,
and legacy sidebar-footer actions. Unknown or omitted names fall back to
branding, then `Zap`. This changes the documented branding-first behavior of
`threadPanelAction`, `experimental_newThreadPanelAction`, and
`sidebarFooterAction`; plugins that depended on their hints being hidden now
show those hints. Omit optional icons or use the branding glyph explicitly to
retain that appearance. Plugin identity surfaces (Tools, Settings, and plugin
detail tabs) remain branding-first. No new API fields or wire changes are
introduced. Verify icon precedence and load/unload fallback across these
surfaces before stabilizing the icon API.

This is an app registry, independent of all manifest branding and declared SVG
asset contracts. It adds no server/daemon wire fields, persisted icon definitions,
or cross-client delivery. Mobile and desktop load the same web app and plugin
frontend registrations. Server-side presentation validation remains unchanged;
registering an app icon does not declare a manifest SVG or authorize a new
namespaced server presentation glyph.

Before stabilizing, audit component sizing and accessibility, fallback behavior,
collision precedence, whether per-registration disposal is needed beyond the
existing setup lifecycle, and compatibility for plugins vendoring older Icon
components. The existing built-in icon list and artwork remain fixed; new
plugin app icons use this registration API. The manifest API is unchanged,
and individual plugins can still declare their own branding SVG assets using
the existing manifest fields.

## `experimental_ProjectIcon`

Shared frontend renderer for a project's icon, exported from
`@omnyo/plugin-sdk/app`. Pass `projectId` plus optional `className` and
`style`, which size and shape the decorative wrapper; the face fills it and
inherits font size for the monogram. It renders the project's discovered icon
file (`icon.png`, `icon.svg`, `favicon`, …) from its default source when the
source's machine is connected, else the hue-tinted monogram, or the personal
glyph for the personal project. It reads the sidebar catalog and returns null
for an unknown project or before the catalog loads. Core callers: the sidebar
project rail renders the same `ProjectFace` through
`apps/app/src/components/sidebar/ProjectFace.tsx`, sharing icon discovery,
caching and retry. The Chat Topics Inbox uses it to identify each chat's
project. Stabilize after deciding whether plugins need a non-decorative
labelled variant and size presets, then rename project-wide and remove this
entry.

## `experimental_ProviderIcon`

Shared frontend renderer for agent, machine, and environment provider artwork,
exported from `@omnyo/plugin-sdk/app`. Pass required `providerKind` and the
existing record as `provider`, plus optional
`fallback` (default `Code`), `className`, `aria-label`, and `aria-hidden`.
The renderer reads `provider.id`, `logoUrl`, `icon` (agent `{ glyph }` or machine/environment
string), and `strings.iconTint`. It performs no fetch; `{ id }` alone resolves
frontend slot registrations and fallback. Marks are decorative by default.
Resolution is a matching kind/id override, then a legacy unscoped override,
supplied logo mask, supplied glyph through
the app registry, then fallback. Invalid tints are ignored. Overrides update on
load/reload/unload, remount per generation, and fall back on render errors or
recursive provider references. Without an accessible label the mark is decorative.

The Omnyo provider helper, machine/environment provider marks, Provider Usage and Tasks
comment avatars use the same renderer. Both plugin responses preserve the SDK's
`icon` and `strings.iconTint` field shapes so callers pass records directly. Tasks
adds this artwork to computed comment-provider RPC data; no persisted records, manifest API,
server/daemon wire fields or registration lifecycle change. This rendering-only
surface uses existing provider SDK queries and CLI provider/plugin management.

Stabilization: audit SDK prop ergonomics against all three provider kinds,
same-id isolation and legacy override fallback,
asset-vs-glyph precedence, cross-plugin overrides, reload/error/recursion behavior,
accessibility and theme rendering on desktop and mobile. Keep metadata fetching
and plugin branding separate from provider artwork resolution.

## `experimental_ThreadStatusGlyph` (`@omnyo/plugin-sdk/app`)

**What it does.** Renders Omnyo's thread status glyph, the one Omnyo's own thread
lists draw, from `PluginThreadStatusGlyphProps`: `indicator` (a
`PluginSidebarThreadIndicator` the caller resolved), optional `archived`,
`rowStatus` (another plugin's row status, which replaces every indicator
except `runtime`, `unread-error`, and `waiting-for-input`),
`hideIdleDraftLabel`, and `size` (`default` or `compact`). The host owns the
icons, colors, shimmer, and accessible labels; the caller owns the indicator,
so a row can fold in collapsed children or a client-local draft first. The
SDK test fake renders nothing for `none` without a row status and otherwise
exposes the props as `data-thread-status-glyph`, `data-row-status`,
`data-row-status-tone`, `data-hide-idle-draft-label`, and `data-size`.

**Core callers on the same path.** `ThreadStatusGlyph`
(`apps/app/src/components/thread/ThreadStatusGlyph.tsx`) is the SDK
implementation and the glyph in the thread search palette, the related threads
info section, and mobile recents. The thread-list plugin draws its rows and
collapsed-group rollups with it.

**Audit before stabilizing.**

1. **Indicator resolution.** The caller resolves the indicator, so the
   thread-list plugin keeps its own copy of the indicator precedence and labels
   that `@omnyo/client-core` holds for Omnyo's surfaces. Decide whether the SDK should
   export the resolver and labels instead.
2. **Archived rows.** No plugin passes `archived` yet; confirm the archived
   glyph belongs on this component rather than in the archived list.

## Running subagent count (`@omnyo/plugin-sdk/app`)

**What it does.** `PluginSidebarThreadActivity.experimental_subagents` is the
number of subagents a thread is running now. The server counts one per
spawning call: each pending delegation started after the thread's latest root
turn began, while that turn is open; each pending background agent
(`local_agent` or `local_subagent`), keyed by the tool call that launched it so
a foreground Claude agent counts once; and each `running` agent in a pending
workflow's latest snapshot. Delegations left pending in a closed root turn, or
under a nested turn that never finished, count zero. The field is absent only
on hosts that predate it. The same number is `activity.activeSubagentCount` in
`omnyo thread list --json` and the SDK thread list. The server resends the thread
list entry whenever the count changes.

`PluginThreadStatusGlyphProps.experimental_subagents` draws that count inside
the working spinner: a thin track ring, a spinning arc, and the number, with
the accessible label "Working · 3 subagents". Zero, an absent value, or a glyph
that is not working (including a non-running row status) draws the existing
glyph unchanged. The SDK test fake exposes it as `data-subagents`.

**Core callers on the same path.** `toPluginSidebarThread`
(`apps/app/src/lib/plugin-sidebar-threads.ts`) maps the server count into the
activity. The thread-list plugin's `ThreadRow` passes the row thread's own
count to its trailing `experimental_ThreadStatusGlyph`; collapsed-group
rollups do not pass one.

**Audit before stabilizing.**

1. **Collapsed groups.** Decide whether a collapsed parent should sum its
   hidden children's counts.
2. **Large counts.** Two digits fit the 16 px ring only with proportional
   figures and tighter tracking at the sanctioned 10 px size; three digits
   overflow it. Decide whether counts above 99 need a cap.
3. **Background delegations.** A `background: true` delegation stops counting
   when its root turn closes; confirm that matches every provider that emits
   one.

## `HostsArea.experimental_reconcile`

Explicitly reconcile a provider-managed machine with core’s recorded state.
For suspended machines, coordinate the existing provider suspension operation
and return HTTP 202 after starting it; callers can poll host status for completion.
Provider suspend and resume implementations must be idempotent.
Active and transitional states are left unchanged;
the plugin uses `experimental_suspend` to request a new pause. Core schedules
no provider polling. Validate concurrent resume/removal, failure reporting,
long-running caller behavior, and the scope of supported states before
stabilizing this API. Exposed as `omnyo machine reconcile`.

## Lifecycle ownership on thread creation

`api.sdk.threads.spawn` and `api.sdk.threads.fork` accept `lifecycleOwnerThreadId`;
thread responses expose its nullable value. This adds data fields to existing
SDK methods, not a new `PluginApi` property, app export or slot method, so no
new unprefixed public API member is introduced. Audit before stabilization:
immutable cross-project ownership, cross-host cleanup, archive/delete retries,
creation races, and preservation of existing unowned threads. The Plugin Guide SDK card
describes the public behavior.

## Environment provider existing-path selection

`PluginEnvironmentProviderDefinition.experimental_existingPath(inputs)` returns
an absolute path or null from parsed inputs without performing mutations. On an
existing machine, core checks that project's environment at the path after
selection validation. A usable environment follows the normal reuse flow,
preserving its provider, ownership, resource, merge base, and cleanup identity.
An unusable environment is refused; a missing record follows normal creation,
where the provider still validates the directory. Other projects' managed paths
remain forbidden. New-machine selections continue through creation.

Stabilization requires lifecycle coverage for reuse, missing paths, cleanup in
progress, cross-project ownership, and concurrent creation before binding.

## Composer editing: `insert` and `replace`

Michael explicitly requested the final names `insert` and `replace`, an
exception to the experimental-prefix rule. `PluginComposerApi.replace` accepts
an explicit `ComposerDraftReplacement` or a synchronous updater from the latest
immutable `ComposerDraftSnapshot`. `draft` now includes uploaded attachments.
Text and mention metadata commit together, even if text is unchanged. Omitted
attachments are preserved; an explicit list replaces them. Ranges must be valid
and non-overlapping; replacement never infers mention reconciliation. Invalid
results and throwing updaters do not mutate the draft. Returning the supplied
snapshot is a no-op. `insert` remains the cursor/end insertion primitive.

Core quoting, prefills and history restoration call this same contract. Quotes
are pure draft transformations that append blockquoted text and merge attachments
by path, followed by `focus()`. Attachments remain independent draft items, not
children of a quote. `replace` preserves source-project references; core copies
those files into the destination project on submission. Submission rollback,
restore-if-empty seeds, uploads, and editor transactions remain beneath these
actions. Command completion's trigger-range replacement and autocomplete
dismissal remain a documented boundary, not a hidden option on `replace`.

`setText`, `updateText`, `clear`, `addQuote`, `insertMention`, and
`removeMention` are marked internal and stripped from published declarations,
but remain at runtime for older plugins. Their existing formatting, focus, and
ownership behavior is preserved.
Core actions and annotations use insert/replace. No runtime removal is scheduled
in this change. The unshipped experimental replacement, quote, and attachment
members introduced during this work were removed rather than retained as aliases.

Before stabilization, audit snapshot identity and updater failure/lifetime
behavior across mounted, offscreen, and ephemeral editors, replay of attachment
paths in their owning project, and migration of third-party text transforms to
explicit mention ranges. Decide whether command application merits a shared
public operation. These operations edit client-local drafts; existing SDK/CLI
thread creation and send surfaces still accept structured inputs.

Core history conversion is centralized in the composer adapter; quoting operates
on text and attachments directly without a mention-format round trip. Persisted
and editor mention formats remain unchanged, while the action layer reads one
complete draft snapshot instead of separate content and attachment getters.

## Thread creation placement

`PluginSidebarThreadActions.openNewThread` accepts `experimental_placement`
with explicit `sectionId: string | null` and `pinned: boolean`. It overrides
the legacy section option. Omission clears prior composer placement and uses
the legacy section or the general thread list, unpinned. The composer sends
this placement with normal and scheduled creation. Audit pinned groups, custom sections, project/machine groups,
route transitions, draft recovery, and third-party sidebar compatibility
before stabilizing this option.

### Provider discovery metadata

`package.json` → `omnyo.experimental_providers` statically declares
`{ kind, id, displayName }` provider identities before a plugin runs. `kind`
uses the `providerKind` vocabulary and currently accepts only `"agent"`, which
feeds Settings → Providers so disabled plugins' agents stay discoverable. It does
not grant runtime capabilities or execute code. Core also retains the last
registered agent identities when disabling a plugin, preserving custom providers
across restart. Add `"environment"` or `"machine"` only together with a consumer.
Stabilize after validating first-install discovery, shared-plugin enablement,
dynamic provider removal, plugin upgrades, and duplicate-ID ownership behavior
with third-party providers.

## Global prompt history (`api.sdk.experimental_promptHistory`)

`api.sdk.experimental_promptHistory.list({ cursor?, limit?, signal? })` returns `{ entries, nextCursor }`: every accepted user prompt across projects and threads, newest first, each with `id`, `createdAt`, `input`, `projectId`, `threadId`, and `scope`: `"project"` for a prompt that started a top-level thread, the prompts core's new-thread composer recalls, or `"thread"` for a follow-up. The Prompt Library plugin ranks prompts whose scope matches the searching composer higher. `limit` is a digit string, defaulting to 100 and capped at 1000. `nextCursor` is an opaque string, or null on the last page. A page can hold fewer than `limit` entries while `nextCursor` is set, because stored rows whose input no longer parses are skipped. Prompts from a deleted thread remain listed until the thread row is removed, which cascades to its prompt history. The same route backs `omnyo prompt-history list`.

Before stabilization, audit whether `limit` should be a number, whether the cursor format needs versioning, whether project or thread filters belong on this call rather than on `projects.promptHistory` and `threads.promptHistory`, and whether skipped rows should fill the page.

## `ThreadChatMessageReference.experimental_messageSeq`

The message reference handed to `messageAction` runs, `ThreadChat` consumer
message actions, and prose selections carries the event sequence that recorded
the message. It is the `msg` value of a message link and the seq accepted by
`sdk.threads.message` and `omnyo thread log --message`, so a plugin can build or
resolve a message link without guessing. It equals `sourceSeqEnd` except for a
steer, which is recorded by its request and shown at its acceptance.
Stabilize once message links have shipped and the seq has stayed stable across
edit-and-rerun, forks and context clears, and decide whether `sourceSeqEnd`
should remain alongside it.

## `PluginSidebarThreadActions.experimental_archiveEnvironmentThreads`

Archives an environment's active thread trees through the host flow, including optimistic cache updates, pane cleanup, shared toast styling, and one ten-second Undo action. Undo restores only returned archived IDs, sequentially with lifecycle owners first. Archive failures show a host error toast and reject; Undo failures show a host error toast.

Stabilize after verifying group archive and Undo with descendants, already archived threads, split panes, navigation during the Undo window, and failure rollback across sidebar organization modes.

## `PluginSdk.plugins.experimental_startUpdate` and `experimental_updateJobs`

Starts a server-owned plugin update and returns its job immediately. `experimental_updateJobs.list/get` exposes queued/running phases and terminal update, rollback, or failure results. Jobs continue across client disconnects; finished jobs remain for ten minutes. Jobs are in memory and do not survive server restarts. `applyUpdate` retains its result contract by polling the job; raw callers without `Prefer: respond-async` retain the synchronous response. Running updates cannot be cancelled during activation or rollback.

Stabilization requires exercising reconnect/reload, concurrent deduplication, rollback delivery, missing jobs after restart, and CLI/SDK parity before dropping the experimental prefix. No host-daemon wire change.

## `PluginSdk.system.experimental_recordTelemetryEvent`

`system.experimental_recordTelemetryEvent(event)` posts a strictly bounded product event to `POST /api/v1/system/telemetry/events`. The coordinator requires an active client-scoped consent capability and an interactive request, applies daily caps, and sends only the reviewed product schema. A legacy global usage preference never grants behavioral analytics. The request schema is a strict allow-list of setup-guide events with fixed enum or boolean properties; anything else is rejected with 400. Core callers, all through `recordTelemetryEvent` in `apps/app/src/components/onboarding/onboarding-telemetry.ts`: the setup guide (`OnboardingFlow`). Stabilize after deciding whether third-party plugins may emit product events at all (and, if so, how events are namespaced per plugin and rate limited), then rename project-wide and remove this entry.

## `system.experimental_usageStatus`, `experimental_usageConsent`, `experimental_usagePreview` and `experimental_eraseUsageAnalytics`

These core SDK methods share the coordinator privacy owner used by Settings and `omnyo settings usage`. Status reports purpose-specific effective state. Consent records an explicit count, product or notice choice; only an eligible product grant returns a client capability. Preview returns synthetic permitted fields without sending them. Erasure requires the saved capability, withdraws before dispatch and reports pending or complete. Clients must retain prior proofs for retry and must never forward them to plugin endpoints or another coordinator. Stabilize after browser, CLI, withdrawal and receiver expiry acceptance across supported releases. See [the data dictionary](usage-privacy.md).

## `PluginSdk.system.experimental_reportBug`

`system.experimental_reportBug({ message, email?, associatedEventId? })` posts to `POST /api/v1/system/bug-reports`. The coordinator sends one Sentry user-feedback event through its existing error-reporting client (`sendProcessBugReport` in `packages/process-utils/src/error-reporting.ts`), tagged with the runtime release, and waits up to 10 seconds for Sentry's answer. It returns `{ status: "sent", reportId }`, or `{ status: "unavailable", reason: "crash-reports-off" | "not-configured" }` without sending anything; a rejected or timed-out send is a retryable 502. The message is 1–4,000 characters after trimming, the email must be valid, and `associatedEventId` must be a 32-character Sentry event id. A feedback-only event processor rebuilds the outbound event so it carries only the message (credentials redacted, home directory replaced by `~`), email, linked event id, release, environment, runtime and service tags. Core callers: the sidebar footer's Report a bug dialog (`apps/app/src/components/dialogs/BugReportDialog.tsx`, which links the last web error delivered to Sentry) and `omnyo bug report`. Stabilize after deciding whether plugins may send reports on a user's behalf and whether reports need a per-install rate limit, then rename project-wide and remove this entry.

## `PluginSdk.hosts.experimental_discoverRepos`

`hosts.experimental_discoverRepos({ hostId })` asks the machine for git repositories under the user's home directory with local activity in the last 30 days, newest first, capped at 10. Each entry has `path`, `name`, `lastActivityAt`, `originUrl`, and `projectId` (the Omnyo project already bound to that path on that machine, or null). `truncated` is true when the three-second walk budget ran out. The walk stops at each repository root, skips dot-directories, common build directories, scratch directories (`tmp`, `temp`, `tmp-*`, `Downloads`), linked worktrees, and submodules. The first-run setup guide and `omnyo project discover` use it. Host-daemon wire change: the `host.discover_repos` command (protocol 230).

Stabilize after deciding whether depth, recency window, and limit should be caller options, and after exercising slow or network-mounted home directories and Windows hosts.

## `PluginSdk.threads.experimental_continue` and continuation state

The chat Continue control, sidebar Continue all, SDK and CLI share server-owned continuation admission. `experimental_continuationState` and `experimental_continuations` expose current eligibility; `experimental_continue` and `experimental_continueAll` preserve claimed, scheduled and in-flight recovery; a queued continuation that only the failure pause holds is released once through the automatic claim, so dispatch hooks such as the concurrency limit still apply, and a new recovery that a dispatch hook holds releases the failure pause for the owner so it is sent once the hook clears. Recovery reuses failed-turn input acceptance, persisted startup intent and the workspace provider. Missing facts stay visible and return an explicit refusal. Stabilize after genuine server/daemon and native-list proof across accepted/rejected failures, startup/workspace failures, pending retries and overlapping individual, automatic and bulk calls. Core callers: ThreadContinueControl and ContinueAllThreads.

## `PluginSdk.threads.experimental_moveStart` and `experimental_listStartMachines`

A waiting new chat can start on another machine before its first turn. `omnyo thread start-on` and plugins call one server service, `moveWaitingThreadStart` in `apps/server/src/services/threads/thread-start-move.ts`, which re-places the chat with a compare-and-set on its saved machine choice and wakes its start row without the requeue pacing. `experimental_listStartMachines` returns the origin machine and, for every other machine, whether it can take the chat and why not. Plugin calls carry the plugin as initiator through the plugin SDK wrapper; a plugin cannot move a chat a person pinned, while a person's move pins the chat. A move never changes the chat's model or mode; it refuses a machine that cannot serve them. Stabilize after the concurrency-limit overflow policy and the temporary-copy provider have run on real machines, and after deciding whether admission should choose among allowed machines itself. Core callers: the thread CLI and the waiting-row Start on control in `QueuedMessagesList`, both through the same SDK methods and route.

## `PluginBackground.service().experimental_stopTimeoutMs`

`api.background.service(name, { start, experimental_stopTimeoutMs? })` accepts an integer shutdown allowance from 1 to 300000 milliseconds. Omission uses the host default. The runtime waits for the aborted service to settle within that allowance during disposal and after an uncaught exception. A timeout remains visible as a degraded plugin; the host never starts a second instance while the old service is still settling. If a reload was requested, the host completes it after the final old service settles, unless a newer disable, removal, shutdown, suspension, server move, or safe-mode action cancelled it.

Account Pooler's hub uses the same descriptor and validation path as other plugins. Its allowance covers its configured bounded stream drain plus five seconds for cleanup. Core registration, runtime supervision, and the SDK fake host share the contract; other services retain the host default.

Before stabilization, verify boundary values and invalid declarations, normal and late settlement, simultaneous services, uncaught exceptions, cancellation of pending reloads under every newer lifecycle intent, and that allowance expiry never creates duplicate service instances. Audit whether five minutes is the appropriate upper bound and whether the descriptor should remain a service declaration rather than plugin-wide configuration.

## Machine availability

`hosts.experimental_setAvailability({ hostId, availability })` sets a machine to
`away` or `available` through `PATCH /hosts/:id/availability`, the same route
the Machines settings switch and `omnyo machine away|available` use. Away stops the
host's running threads, ends its Omnyo host job processes on Windows, holds new
turns with a `host-away` queue wait and re-applies on reconnect; Available
releases those waits. Stabilization requires review of first-turn threads whose
environment is not yet provisioned, Resources job admission on Away hosts, and
automatic Away triggers.

## `system.experimental_recordAttachmentDiagnostic`

Records one strictly validated, content-free report when an attachment upload
is empty, either before upload or as rejected by the server with
`attachment_empty`. Core's upload queue and `omnyo project attachment diagnostic`
use the same route; the server logs it as `Attachment upload diagnostic`. The
report carries sizes at paste and upload, a browser re-read result, clipboard
type names, timing, native-path facts and the web bundle basename. It accepts no
filenames, paths, bytes or raw errors. Stabilize after a real empty-paste report
identifies the cause and the fields prove sufficient. The existing server logger
owns retention; no third-party telemetry is added.

## `system.experimental_recordVoiceDiagnostic`

Records one strictly validated, content-free voice failure or recovery in the
authenticated coordinator's rotating log. Core's recording hook and `omnyo voice
diagnostic` use the same route. The report preserves occurrence time, loaded web
bundle basename and recording/attempt correlation across bounded offline replay;
it accepts neither audio/text nor raw errors, URLs or device identifiers.
Stabilize after deployed ingestion, strict rejection, retry correlation and
old-client/new-uploader replay contracts have passing evidence. The existing
server logger owns retention; no third-party telemetry is added.

## `system.experimental_prepareVoiceInput`

Asks the selected voice service to get ready now through
`POST /system/voice-transcription/prepare` and resolves `{ ok: true }` at once,
without waiting for the service. Core's recording hook calls the same route when
recording starts, and `omnyo voice prepare` wraps it. It shares
`prepareVoiceInput` with the host-connected prewarm, so single flight, the 70 s
server-owned timeout and the logging described under AI services apply. The
response does not say whether a service was prepared; the server log does.
Stabilize together with `PluginAiServiceDeclaration.experimental_prepare`, after
deciding whether callers need the prepare outcome and whether the route should
take a reason.

# Native thread attention

`sdk.experimental_attention.snapshot`, `history`, `command` and `adopt` expose
native question/callback state and lifecycle. The native composer, question
overview, CLI, Ask User Question and Decisions adapters use the same service.
`adopt` accepts only the two existing legacy plugin IDs, fences their old
SQLite writers, retains source rows and records a durable import receipt.
It is an explicit ownership cutover, not an automatic startup import.

`command` action `answers` resolves several open questions of one chat in one
transaction: each entry carries `id`, `revision` and an `answer`, or `null` to
skip it. Every answer lands in one queued message that is sent once; a batch of
only skips sends nothing. Any stale or closed entry rejects the whole batch, and
repeating an accepted batch cannot send twice. The native composer answers
through it, including a single question.

`command` results carry required `routedToThreadId: string | null`; it is
`null` for root chats and every non-`open` action. A child chat (a parent and no
fork or handoff origin) whose parent is live never asks the owner: `open` stores
no question and adds no Needs you, queues one system message with the questions
to the parent, and returns the parent's ID with empty `questions`,
`cleared: false` and `callbackMarker: null`. The parent answers with
`omnyo thread tell <child> --mode auto` (SDK `threads.send`), which the child
receives as an ordinary message, or asks its own question when only the owner can
decide. Grandchildren reach their own parent. A chat created through the CLI
from inside another chat (its recorded launcher) and without a parent link
routes the same way to that launching chat, so only owner-created chats ask the
owner. A child whose parent, or a launched chat whose launcher, is archived or
deleted keeps the root behavior. A provider-native `user_question`
interaction from a routed child is sent to the parent the same way and then
rejected with a reason saying it was delivered, so no pending interaction or
Needs you appears on the child.

Each question input carries `delegable` (default `false`); the asking agent sets
it only for a reversible choice within the authority it already holds. A caller
that identifies as a chat, automation or plugin may `answer` or `answers` only
when every involved question is `delegable` (otherwise 403 `owner_only`, with no
change). A plugin answer must include `delegation: { ruleId, reason }`; any other
caller's answer with `delegation` is refused with 400. Only the owner or the
asking chat may raise `delegable` through `update`, and plugins may `skip` or
`withdraw` only `delegable` questions. Every answered question records
`answeredBy` (`owner`, `thread`, `automation` or `plugin` with its rule). Only
owner answers mark the chat's Inbox receipts handled; a plugin answer is sent
with the plugin's message source and a line naming the plugin and rule.

`PluginSidebarThread.experimental_attention` exposes native attention details;
absence identifies an older server. `experimental_ThreadAttention` renders the
same native panel used by core's composer, including answer and skip actions.
Needs You consumes the native indicator and callback data and supplies no
independent state classifier or row status writer.

Stabilization requires migration/replay tests, exact callback matching and
restart proof, required/optional and provider-native UI coverage, plugin-disable
coverage, child routing coverage for root, live-parent, archived-parent,
grandchild and provider-native cases, public SDK/CLI parity and a private
delivery receipt.

`experimental_threadIndicators` exposes the shared native resolve, label, working
and attention-merge functions. Core rows, collapsed activity and the bundled
Thread List use the same domain implementation; plugins do not maintain their
own priority table. Stabilization requires the shared contract cases to pass
through core, SDK and replacement-list consumers, including native attention
and custom-row-status precedence.

`testing.experimental_threadIndicatorCases` supplies the same status contract
cases to core, SDK and forkable-list tests without private cross-plugin imports.

## Thread bootstrap plugin reads

- `PluginRpcMethodContract.experimental_dispatchReadiness: true` opts a side-effect-free
  local admission read into the same bootstrap. Core supplies `{thread: {id, status}, host:
{id, name} | null}` using the thread's actual or intended machine. The method returns
  `{action: "proceed"}` or `{action: "wait", reason}`; core validates that shape and tags its
  `experimental_pluginData` entry with `dispatchReadiness: true`. Invocation failures and
  malformed decisions remain visible RPC errors. Core's Send and Send now cache owners read
  these cached hints without plugin identifiers or executing dispatch hooks. The real dispatch
  decision remains authoritative. This flag implies bootstrap inclusion without preloading a
  plugin's settings frontend. Concurrency limit shares one capacity decision between this RPC
  and its dispatch hook, and publishes `dispatch-readiness-changed` when configuration, capacity
  or thread occupancy changes. Stabilization requires shared global/host/steering decisions,
  intended-host bootstrap coverage, and live capacity refresh before either send action.
- `PluginRpcMethodContract.experimental_threadBootstrap: true` opts a fast local read into
  `threads.get({include: "experimental_pluginData"})`. Core validates the public thread first,
  invokes registered methods with `{threadId}` through the existing RPC validation and client
  caller boundary, and returns each method's result or visible error alongside conversation data.
  Only loaded plugins participate; absent cards remain explicit `null` results. This opt-in is for
  authoritative local reads, not mutations, inference or external network work.
- `experimental_useThreadBootstrapData(threadId, method)` reads the calling plugin's result from
  the optional plugin bootstrap query that core's thread view owns. Core conversation content loads
  independently. The observer starts no request and
  distinguishes pending, unavailable, ready and error. `updatedAt` identifies the cached snapshot;
  ready `current` identifies a response completed for the active router entry, even when the
  plugin mounted after completion. A prior-entry cached result is not current. Plugins retain
  explicit revalidation and visible retained/error states.
- Core caller: `useThreadPluginBootstrap` requests the include separately from
  `useThreadDetailBootstrap`; the plugin hook observes that exact plugin-data query. Dispatch
  readiness, frontend discovery and query invalidation share its owner. Request cancellation
  reaches the existing RPC invocation context. There is no parallel bootstrap endpoint.
  CLI and SDK callers use the existing `omnyo thread show --include experimental_pluginData --json` /
  `sdk.threads.get` include contract.
- Stabilization requires shared bootstrap isolation, schema/error/absence tests, and a live cold
  open where the card accompanies conversation rendering without inheriting the independent RPC
  wait. Glance adopts the same path; plugin-specific sorting or hardcoded identifiers are absent.

## Conversation initial loading

`experimental_useInitialLoadPending(pending)` holds the initial conversation reveal
while a mounted plugin loads data its first layout needs. Only missing data holds;
refreshing cached data never does. Supporting holds (plugin reads, settings, styles
and secondary core queries) release after one second, so a stalled plugin cannot
hide a chat; the conversation bootstrap, timeline and plugin frontends hold until
ready. It has no effect after reveal or outside a conversation. Core notices, queued
messages and execution defaults use the same implementation. Composer predictions
render from the conversation bootstrap and never hold. Plugin RPC calls, settings
and styles are included automatically. Stabilization requires delayed, failed and
unmounted plugin coverage and navigation proof.

## Shared VCS process admission (`@omnyo/plugin-sdk/host`)

`experimental_runVcsProcess(command, args, operation, options)` admits a `git`
or `gh` operation to the runtime's shared queue before invoking it. `args` are
the command's arguments; they classify git network subcommands (`fetch`,
`pull`, `push`, `clone`, `ls-remote`, `submodule update`, `remote update`).
Arguments without a network subcommand, including an empty list for pipelines,
admit to the local pool. The call holds the permit until the returned promise
settles; callers must await child close and termination cleanup. Calls nested
inside an admitted operation run under the outer permit without queueing again.
`ExperimentalVcsProcessOptions` accepts `priority` (`interactive`, `status`,
`background`), an optional cancellation signal, and `slots` for pipelines
that start multiple git children. Queue cancellation prevents spawning; callers
own cancellation of running children. Execution timeouts begin after admission.

The runtime keeps two disjoint pools. The local pool admits
`clamp(os.availableParallelism() - 2, 4, 6)` local git children, computed once
per runtime: background work can fill two fewer slots and status work one
fewer, so eight or more cores give six, five, and four. The
network pool admits at most four network git or `gh` children, with at most two
`gh`: background work can fill two slots and status work three. Waiters gain one
priority level every 15 seconds. FIFO applies within effective priority in each
pool: when the first waiter that is not held back by the GitHub lane needs more
slots than its pool has free, later waiters in that pool wait behind it, so
pipelines are not starved by single-slot work. A blocked GitHub waiter does not
block eligible network git work, and neither pool blocks the other. The budget
is shared across module copies in one Node runtime, including bundled plugins.
Separate host daemons and server processes own separate budgets; arbitrary
commands run by agents or terminals are outside this queue.

Core buffered git/gh reads, streaming status/diff reads, blob reads, shell
pipelines, watcher setup, environment provisioning, and the GitHub plugin use
this path. The CLI and SDK's workspace reads and mutations reach the same host
handlers. Host commands give explicit user mutations and diff panels interactive
priority, status reads status priority, and PR polling/watcher setup/provisioning
background priority.

Before stabilization, audit cancellation and permit release on all supported
platforms, mixed plugin bundles sharing the singleton, aging under sustained
load, whether the CPU-scaled local capacity needs a host override and reflects
container CPU quotas on supported hosts, whether argument
classification should cover more network commands (for example `git lfs`), and
whether work that escapes an admitted operation's async context should regain
admission. Verify that every caller holds permits until its last admitted child
exits, including pipelines.

## `PluginComposerApi.experimental_onSubmittedDraft`

Returns a disposable listener for the immutable draft actually accepted by the existing send, queue or new-thread mutation owner. Legacy zero-argument submission listeners are unchanged. Failed sends and draft clearing do not emit accepted drafts. Core constructs the snapshot from the exact submitted input, preserving immutable plugin mention IDs. Agent Annotations uses this shared path to clear only matching note revisions; Browser Automation consumes the same contract. Audit queued sends, delayed uploads, edits during context resolution, remounts, and origin-scope rebinding before stabilization.

## `ExperimentalPluginBrowserPage.experimental_capture`

Captures the exact toolbar tab through the existing desktop target and native screenshot SDK route, without acquiring a second debugger/controller. Returns JPEG base64 plus actual bitmap dimensions; absence explicitly means the host cannot provide this capability. Agent Annotations fences document, element identity/content/geometry and viewport before and after capture, then stages cropped bytes as project-owned attachments. Audit capture limits, renderer crashes, navigation and concurrent ownership before stabilization. CLI/SDK automation uses the existing desktop-browsers capture route.

## `experimental_ImagePreview`

Displays an authenticated raster image object URL through Omnyo's existing ImageLightbox. Accepts same-origin blob URLs and PNG/JPEG/WebP MIME types, alt text, optional title and className. Callers own authenticated byte reads and object URL disposal; the component neither fetches files nor infers project/host context. Glance is the initial consumer. Core's Markdown and this component use the same ImageLightbox implementation. Audit URL lifetime, narrow/coarse-pointer interaction and unmount behavior before stabilization.

## Explicit attachment retention

`PluginSdk.projects.attachments.experimental_retain({ projectId, threadId,
paths, signal? })` retains up to 24 existing attachment paths for a real owning
thread without adding prompt history or copying file bytes. `projectId` names
the attachment's source project; the owning thread may belong to another
project. Both must be available through the existing public entity guards.
The request rejects unknown fields, missing files, pending uploads and files
already claimed for deletion. Ownership is acquired atomically and repeated
claims are idempotent.

Core prompt history, queued messages and events use the same database claim
primitive through `acquireProjectAttachmentOwnership`; explicit references use
`acquireProjectAttachmentReferences` with source-project/path pairs. Existing
same-project thread forks copy every ownership row, including references to
other projects. Hard deletion of the last owning thread releases retention;
source-project deletion retains its existing attachment deletion semantics.
Glance visual references use this API before storing their card.

Stabilization requires cross-project source validation, ready-file and deletion
race coverage, all-or-nothing claims, repeated requests, fork inheritance and
pruning after the final owner is deleted. SDK cancellation, CLI discovery and
public route validation must stay aligned with the same service path.

## `PluginSidebarThread.experimental_work`

The server supplies one revisioned work summary in thread lists, detail,
bootstrap, realtime, SDK and CLI responses. The sidebar adapter exposes the same
summary through `experimental_work`. It is absent or null only on legacy hosts.
Clients show Open with an unavailable explanation until authoritative work arrives.
Unreadness and Shelf placement remain separate fields.

The primary label is Needs you, Working, Blocked, Waiting, Open, External or
Ready to archive. Needs you also covers a current assessment that names an
action the owner must take (`assessment.ask`, reason code `assessed-ask`) when no
recorded activity, failure, wait or postponement outranks it; the ask suppresses
any outside event, names You as the next actor and blocks archive
recommendation. External means a current assessment names an outside event
(`assessment.waitingOn`), has no ask, and no recorded evidence outranks it; such
a chat is never archive-recommended. Required and optional input, independent activity, failures, actors,
assessment availability and explicit postponement remain separate facts. A
required question can coexist with a running job. Optional input never requires
a response. `archive.recommended` is advisory and a ready-only archive action
revalidates its basis on the server.

`experimental_threadIndicators` now maps this summary to glyphs and decorates a
local draft. Its input is `{work, hasUnsubmittedDraft}`. It does not accept raw
runtime, unread, queue or attention booleans. `strongest` ranks already-classified
summaries for collapsed groups, whose consumers retain the underlying summaries.
The old attention classifier and client workflow polling have been removed.

Core uses this contract in the default sidebar, mobile recents, related chats,
search and rail counts. Composer Predictions uses it for its work line and stale
suggestion suppression. Stabilization requires real-app parity across these views,
concurrent question/activity coverage, legacy-unavailable rendering, and no
readiness flash on bootstrap or reconnect.

## `api.sdk.threads.experimental_work` / `experimental_publishWork` / `experimental_archiveReady`

`experimental_work({threadId})` reads the same current server summary carried by
list, detail, bootstrap and realtime. `experimental_publishWork({threadId,
pluginId,contribution})` validates one plugin's observation namespace or an
assessment bound to its exact opaque work basis, which identifies the conversation.
Assessments of an older conversation return 409.
Signals declare coverage and source-owned expiry with `validUntil`; unknown or
expired ownership cannot establish readiness. Terminal failures remain recorded.
Model assessments retain omission and external-wait explanations without creating
verified ownership from those explanations.

`experimental_archiveReady({threadId,basis})` checks the current recommendation
and expected basis atomically before archiving only that chat. Ordinary manual
archive remains available through its existing action. Core's ready-only service
and Tidy use this same path; Composer Predictions publishes its existing results
through the shared contribution path. Resources publishes its existing job facts
without per-thread RPC fan-out.

Stabilization requires stale-basis rejection, producer coverage and expiry,
concurrent facts, manual-archive parity and ready-only archive races. New messages
must invalidate assessments, and questions and obligations must veto the
recommendation live; read or Shelf changes must not establish a different work
state. No API may run inference just to read labels.

## `experimental_useInboxSnapshot` (`@omnyo/plugin-sdk/app`)

Reads the server-owned Inbox state and reason from the app's single shared query.
Returns `snapshot` (null until loaded), `status` (`loading`, `ready`, or `error`),
`stale` (a retained snapshot has failed to refresh), and `refresh()` (a coalesced
refresh request). Realtime changes except appended events and history compaction,
window focus, and reconnect refresh the query; failed reads retry three times
with backoff. Failures retain the last snapshot and remain visible through status.
Core Home counts and `ThreadInboxReason` use the same hook as plugins.
Stabilization requires shared-query deduplication, bounded realtime coalescing,
focus/reconnect refresh, retry and retained-data error coverage across consumers.

## Chat groups and chat selection (`@omnyo/plugin-sdk/app`)

`PluginSidebarThreadsState.experimental_groups` lists every chat group (a
purely visual, named folder that holds top-level chats from one project) from
the sidebar bootstrap, and `PluginSidebarThread.experimental_groupId` names a
chat's group. `experimental_setChatSelection(threadIds)` publishes the active
thread list's multi-selection to the host and `experimental_useChatSelection()`
reads it; Omnyo's `thread.group` command (Mod+G, available only while chats
are selected) and the selection's right-click menu in
`experimental_ThreadActionsContextMenu` act on it.
`experimental_useThreadGroupActions()` returns `group`, `rename`, `ungroup` and
`move`, which update the sidebar caches at once, show Omnyo's toasts (Undo for
group and ungroup) and reject after the error toast. Core callers: the Group
command handler, the selection context menu and the core `moveToGroup` thread
action use the same `useThreadGroupActions` implementation; the bundled
thread-list and Chat Topics publish selection and render folders. The CLI uses
the same `threadGroups` SDK area (`omnyo thread group`). Stabilization requires
folder rendering parity across both lists, drag in and out of folders, and a
decision on whether sections and groups merge.

## `experimental_useThreadWork` (`@omnyo/plugin-sdk/app`)

Reads one selected chat's server work summary from the shared thread-detail query,
including Shelf and Archive. It uses the core detail cache and realtime subscription;
it does not scan or paginate sidebar lists or call a plugin readiness resolver.
A null thread ID disables the read. Missing detail returns null until loaded.
Composer Predictions is the core caller. Stabilization requires placement-independent
read, realtime and reconnect parity with the sidebar, SDK and CLI work summary.

## Inbox and waits (`api.sdk.experimental_inbox`)

`snapshot()` reads the server's Inbox projection (`GET /inbox`): every
top-level chat's view (Inbox, Waiting, Running, Resting on the Shelf, Archive),
its card with every outstanding cause and one primary, its Waiting row with a
return time, the header counts and the owner's most recent move. Lists keep the
order the UI renders. `act({request})` (`POST /inbox/act`) applies one owner
action named by `request.action`: `ok`, `archive`, `wait`, `wait-report`,
`accept-proposal`, `keep-waiting`, `remind-later`, `happened`, `shelf`,
`snooze-question`, `cancel-wait`, `resume` or `continue-with-result`. Card
actions carry the card's `latch` and the receipt IDs it displayed; the server
handles exactly those receipts and refuses with 409 `inbox_updated` when either
changed. `undo({moveId})` (`POST /inbox/undo`) reverses the owner's most recent
move while no later owner message exists.

`waits`, `registerWait`, `rearmWait`, `metWait`, `doneWait` and `cancelWait`
(`/threads/:id/waits...`) read and drive a chat's continuations. Registration is
idempotent per stable `key`; the same key with different content fails.
`rearmWait` and `metWait` apply only in the turn the wait woke. An agent's
`doneWait` resolves a report-it wait only in a turn that consumed the owner's
message sent after the wait was armed. `wait({threadId, waitId})`
(`GET /threads/:id/waits/:waitId`) reads one wait, closed or not, with its
`closedReason`; a check that ended without a rearm reads `resumed`.

`startProducer({threadId, kind: "goal", label})` (`POST
/threads/:id/producers`) records the chat's own producer, such as a pursue goal.
Only a plugin may call it, and it returns the active producer for the same
plugin and kind when one exists. The chat counts as Running under `label`. The
owner inputs of the turn that started it move to the producer. While it is
active, each root turn end that consumed no owner input holds its receipt for
the verdict, for at most 15 minutes. `settleProducer({threadId, producerId,
verdict, summary})` (`POST /threads/:id/producers/:producerId/settle`) applies
the verdict. `unmet` drops the held receipt and keeps the producer active.
`met`, `limit` and `failed` end it with one receipt carrying `summary` that
covers the handed-off inputs. `stopped` ends it the same way, but writes the
receipt only when something was held or owed. Archive ends a family's
producers; undoing it covers handed-off inputs with one receipt.

`declineRetry({threadId, turnRequestId, reason, incident})` (`POST
/threads/:id/retry/decline`) is the retry decider's "no automatic retry". Only
a plugin may call it. The failure becomes actionable at once instead of after
the 30-second decision window. `incident` (`{key, label, resetAt}`) names the
provider, category and account the failure shares with other chats. Problems
that share a key become one card. When every member has the same verified
`resetAt`, the card's primary is `resume-all-at-reset`; the act request of the
same name schedules one held retry per chat at that time. Provider-retry sends
this on every decline.

`pendingEvents({prefix})` (`GET /inbox/events`) lists the distinct event keys
that live waits are pending on. `reportEvent({key, result})` (`POST
/inbox/events`) meets those conditions and dispatches each wait whose readiness
completes, returning how many resumed. Both need a plugin, and only the plugin
that registered the key's family through `api.experimental_eventSources` may
report it (403 `event_reporter_required`).

`eventSources()` (`GET /inbox/events/sources`) lists every family a wait may
name: Omnyo's push families and each plugin's registration, with label, key format,
examples, approval, poll cadence, pending key count and health (`idle`, `ok`,
`failing` or `proof-failed`, with the last error and proof). `checkEvent({key})`
(`POST /inbox/events/check`) validates one key and, for a poll source, runs its
proof and one check without registering a wait; it reports `fired` and the
result, or the error. Dry runs of an owner-approved family run only for the
owner.

The server derives the caller from `x-omnyo-caller-thread-id`,
`x-omnyo-automation-id`, `x-omnyo-automation-run-id` and the plugin backend's
identity; a request with none of them is the owner. Inbox actions are
owner-only (403 `owner_only`). Agents register waits only on their own chat. A
report-it wait from an agent or automation becomes a proposal, and an agent's
cancel of a wait the owner created or accepted becomes a proposal.

Core callers use the same path: the public `inbox` routes are the
implementation, `omnyo inbox`, `omnyo inbox act|undo` and every `omnyo wait` command
call these members, Chat Topics renders and acts through the same snapshot and
act routes, and pursue registers its loops as check waits and its goals as
producers. Stabilization requires `omnyo inbox --json` and
the UI to render the same snapshot in the same order, the ported invariant
model to pass as a property test against the real projection, coverage of latch
and displayed-receipt races, Undo restoring exactly the move's write set, owner,
thread, automation and plugin authority on every mutating member, and one-shot
wake dispatch across restarts. Then rename project-wide and remove this entry.

## Finite tool transcript identity import (`@omnyo/plugin-sdk/provider-bridge`)

`experimental_importLegacyOwnedToolNameV1(name)` maps only the two recorded V1
workflow tool names to their canonical names; other names return
null. `experimental_LEGACY_BRIDGE_MCP_SERVER_V1` identifies the recorded Claude
bridge namespace. Both are read-only transcript helpers, without registration,
dispatch or replay authority.

The shared implementation is `packages/domain/src/legacy-tool-identity-v1.ts`.
Core stored-event reads use it without rewriting SQLite rows. Claude and Codex
provider classifiers use the same function only when the current injected tool
is registered. Current sessions advertise canonical names. Authentication,
watermarks, plugin ownership and zero-activity cutover gates remain authoritative;
a pending historical item never authorizes executing a tool.

Stabilization requires real SQLite preservation, exact-name and foreign-namespace
controls, current/resumed provider transcript fixtures and authenticated dispatch
rejection for legacy names. Retain the versioned reader while recorded V1 events
remain readable; adding another mapping needs its original producer contract and
independent preservation proof.

## `ThreadChatProps.experimental_conversation`

Embeds one plugin-owned conversation in an existing thread using the native
composer, execution pickers, queue and transcript. `id` namespaces its saved
draft beneath the owning plugin and thread. `mention` is resolved through the
calling plugin's mention provider and is included in every submitted input, so
attribution survives queueing, retries and reloads. The transcript displays
turns containing that exact plugin mention; steering within a shared turn can
share that turn's response. Older turns remain available through native history
pagination. Normal `ThreadChat` instances retain their existing behavior.

Core's embedded composer uses the same attachment preparation and send/queue
owner for ordinary and attributed conversations. Canvas is the first consumer.
Stabilization requires native acceptance for independent drafts, attachments,
queued delivery, reload, streamed replies and interleaved conversations.

## Host housekeeping inspection

`api.sdk.hosts.experimental_housekeeping({ hostId, signal? })` returns the last
host idle-session cleanup result without triggering cleanup or waking the host.
The same endpoint backs `omnyo machine housekeeping`. Results distinguish an
unrun or failed check from complete coverage and include memory-pressure policy,
released sessions and retained reasons with thread/environment/provider/process
identity. Process identity and memory describe the provider bridge, excluding its
children. Memory is explicitly RSS or unavailable; a shared process is
not additional memory for every hosted session. Stabilization requires auditing
snapshot age, unsupported platforms, pressure-sampling failure, protected work,
process identity and compatibility with enrolled host protocols.

## `app.slots.experimental_projectSidebarItems` and `experimental_useProjectSidebarItems`

Plugins register `ExperimentalProjectSidebarItemsRegistration.useItems`, a React
hook called once under the registering plugin's context with every sidebar
project, including empty projects. It returns project groups of navigation rows.
Rows carry links, icons, optional status, counts, children and mutation callbacks.
The host validates the result, scopes groups to existing projects, stamps owner
keys, and clears the contribution when the registration unmounts or fails.

The public hook reads this same data. Core's bundled thread-list uses it in
`ProjectSidebarItems` and `ProjectList`: project groups render the contributed
trees before ordinary chats. Recursive `threadId` claims remove duplicate chats
only in project mode, including pinned rows. Chronological and machine modes
retain ordinary chat rows. This changes placement, never server visibility or
Inbox attention. Replacement lists must render the tree before honoring claims.

`onReorder` receives the row's ordered child IDs. `onDrop` receives a row ID
from the same owner and project; the plugin validates whether that move is
allowed. Rename failures remain in the shared rename editor; menu and drag
failures show a toast. Collapsed state belongs to the device.

Before stabilization, audit ownership during plugin reload and failure, stable
row IDs, keyboard and compact interaction, project isolation, and claim parity
across every replacement list that adopts the hook. These two public surfaces
remain experimental until that audit and cross-plugin acceptance pass.

## `app.slots.experimental_sidebarEntry` (@omnyo/plugin-sdk/app)

**What it does.** A plugin registers `{ id, title, icon, panel, tooltip,
useStatus? }`. Core draws one labeled row between "New thread" and the chat
list in every sidebar scope and in the phone drawer, outside the scrolling list
and any replacement chat list. `panel` names one of the plugin's own nav
panels; the row links to it and core gives that panel no rail icon (the
cached nav-panel chrome carries `sidebarEntry`). `useStatus` returns `null`
while loading or `ExperimentalSidebarEntryStatus` (`dot`, `tooltip`,
`state`); the row shows a dot, never a number. The hook runs inside the
plugin's `PluginSlotMount`; a throw keeps the label and shows a muted "!".
Only the first enabled plugin's entry renders.

**Core caller (2026-11-22).** `apps/app/src/components/plugin/PluginSidebarEntry.tsx`,
mounted by `AppSidebar`. First consumer: the Chief plugin.

**Audit before stabilizing.** Ordering when several plugins register,
whether the row should be remembered before plugins load (it is absent until
then), keyboard navigation alongside thread shortcuts, and coarse-pointer
height on the phone drawer.

## `ThreadChatProps.experimental_placeholder`

**What it does.** Replaces the idle composer placeholder ("Reply…") in an
embedded `ThreadChat`; core keeps "Provisioning thread..." and "Stopping
thread..." while those apply.

**Core caller (2026-11-22).** `PluginThreadChat` passes it to
`EmbeddedThreadChat`'s composer, the same path core's own placeholder uses.

**Audit before stabilizing.** Localization and whether the timeline variant
should reject it.

## Idle chats: `ThreadSpawnArgs.experimental_idle` (@omnyo/sdk)

**What it does.** `threads.spawn({ ..., experimental_idle: true })` with no
`prompt` or `input` creates a visible chat with no first message and no agent
turn. The server saves a seeded provision context (`seedWithoutRun`,
`execution: null`, `input: []`, `silentSettle`) so the workspace is prepared,
the chat settles idle without an Inbox receipt, and the first message later
starts the provider normally. The wire field is `CreateThreadRequest.idle`;
idle chats refuse input, `sendAt`, forks, parents, plugin submissions and
hidden visibility.

**Core caller (2026-11-22).** `createIdleThread` in
`apps/server/src/services/threads/thread-create.ts` shares the native-import
seed path (`native-import.ts`) and `settleSeededThreadProvisioning`.

**Audit before stabilizing.** A message sent while the idle chat is still
provisioning (exactly one turn), provider/model selection on the first send,
and a CLI `omnyo thread spawn --idle` surface.

## Quiet chats: `ThreadSpawnArgs.experimental_quiet` (@omnyo/sdk)

**What it does.** `threads.spawn({ ..., experimental_quiet: true })` (wire
`CreateThreadRequest.quiet`, column `threads.quiet`) creates a chat whose
children never wake its model. A child joining it records a thread-scoped
`system/operation` activity (`activityKind: "child"`, operation id
`child-activity:<childId>`) that reads running; the child's completed, failed
or interrupted turn settles that row with the first paragraph of its last
output (280 characters). A child that reports again after its row settled gets
a new row. Needs-attention notices and child questions stay on the child.
User messages to a quiet chat start turns normally.

**Core caller (2026-11-24).** `queueChildThreadTurnNotificationBestEffort`,
`queueChildThreadNeedsAttentionNotificationBestEffort` and
`resolveQuestionOwnerThread` consult `Thread.quiet`; `createThreadFromRequest`
and the outcome path write rows through `recordQuietParentChildActivity` in
`apps/server/src/services/threads/quiet-parent.ts`. The State Machines plugin
creates its run chats idle and quiet.

**Audit before stabilizing.** Turning an existing chat quiet or loud through
`threads.update`, a needs-you state on the child row, rows for children that
are re-parented into a quiet chat, and a CLI `omnyo thread spawn --quiet`
surface.

## Plugin home chats: `experimental_pluginHome`

**What it does.** `threads.spawn({ ..., experimental_pluginHome: true })` (wire
`CreateThreadRequest.pluginHome`) and `threads.update({ threadId,
experimental_pluginHome })` set `threads.plugin_home`. Setting it needs the
calling plugin's identity header and `originPluginId` equal to it; the owner
may clear it. This is attribution, not authentication: any local API caller
can already create hidden chats. Core clears the flag for a plugin's chats when
the plugin is disabled or removed. A home chat stays visible (so it can hold
native questions) and pinned data is unchanged, but list filters, project
lists, pinned and shelved lists, search, counts, attention, `listInboxRoots`,
client list caches, the push sender and storage retention leave it out. Lists
include it with `includeHidden` or `experimental_includePluginHome`; the CLI
`thread list` always includes it, marked `home of <plugin>`.
`ThreadListEntry.pluginHome` and `Thread.pluginHome` expose it.

**Core caller (2026-11-22).** `listedThread()` in
`packages/db/src/data/threads.ts`, `listInboxRoots` in
`apps/server/src/services/inbox/collect.ts`, and `clearPluginHomeThreads` from
`plugin-service.ts`. First consumer: the Chief plugin's Talk chat.

**Audit before stabilizing.** "Continue all" (`thread-continue.ts`) still
includes home chats; home chats' own failures need a plugin-side signal because
the Inbox leaves them out; one home chat per plugin is not enforced.
