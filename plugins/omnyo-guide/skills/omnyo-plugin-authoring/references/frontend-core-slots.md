# Content scripts and core slots

### Trusted frontend content scripts

`app.contentScripts.register({ id, mount })` runs ordinary
bundled JavaScript/TypeScript in the Omnyo app shell without a React slot. It is
full-trust, same-origin page code — **not a security sandbox**. It can access
the app DOM and any authenticated client state available to ordinary page
code, so install only plugins you trust. Omnyo does not use `eval`, `Function`,
or persisted source strings: the existing `omnyo.app` build emits a normal CSP-
compatible ESM bundle.

The host mounts scripts in registration order after the bundle loads and
`definePluginApp` setup validates. `mount` receives
`{ pluginId, generation, signal, experimental_setThreadRowStatus?, experimental_setThreadRowSubtitle? }`:
`generation` is a monotonic per-window mount attempt number, and `signal`
aborts before cleanup starts. The optional experimental setter targets an
explicit thread row with `{ icon, label, tone? }` or clears it with `null`.
Use `tone: "running"` for the host's animated running treatment. The host
scopes statuses to the calling plugin and automatically clears them when that
frontend generation deactivates; feature-detect the setter for compatibility
with older Omnyo clients.

`experimental_setThreadRowSubtitle?.(threadId, { text })` accepts
`ExperimentalThreadRowSubtitle` and adds a plain-text
second line through `experimental_useSidebarThreads()` and the built-in
thread list. Pass `null` to clear it. The host trims and collapses whitespace,
rejects empty text or text over 140 characters, and clears values on generation
deactivation. The first active owner wins; clearing it reveals the next owner.
Sticky parent rows omit the subtitle. Feature-detect the setter on older hosts.

A script may return nothing, a disposer, or a promise of either; async mount
setup is time-boxed to 10 seconds. Keep long-running work outside the returned
promise, observe `signal`, and catch failures in work the host does not await.

A replacement bundle and setup validate before lifecycle cutover. The host
then aborts and disposes the prior generation before mounting candidate scripts,
so listeners and observers never overlap. If a mount throws or rejects, the
host aborts that candidate, disposes already-mounted candidate scripts in
reverse registration order, and publishes none of its slots or CSS. Import or
setup failure also deactivates stale UI because the corresponding backend may
already have been replaced. Disable, stop, removal, and app-window teardown
follow the same abort-then-reverse-dispose path; every returned disposer is
called at most once. Each desktop window, browser tab, and remote client owns
an independent instance.

Synchronous and awaited asynchronous mount/dispose failures are contained and
logged; they cannot stop sibling plugins from activating. The current
window's last load/setup/mount/dispose failure appears on the plugin Settings
detail page. The host cannot catch a detached promise that plugin code creates
and never returns, so detached work must handle its own errors.

Prefer the existing imported `app.css` pipeline for static styles. Its lifetime
follows the plugin UI and content scripts that use it: the host keeps the
stylesheet active while a slot, panel header/accessory, or plugin portal is
rendered and throughout an active content-script generation, then releases it
after the final consumer. Imported `app.css` is therefore not an app-wide CSS
hook. Put app-wide selectable palette CSS in manifest `omnyo.themes` entries;
theme CSS has an independent app-theme lifetime.

Styling or decorating existing app-shell DOM belongs in a content script. A
content script may create DOM or `<style>` nodes when behavior genuinely
requires it, but its abort handler/disposer must remove every node, observer,
listener, timer, class, and style it owns. The context deliberately has no
route/project/thread snapshot yet; use stable SDK hooks inside React slots
rather than polling or installing global navigation observers. Complete
cleanup-safe example: `examples/plugins/content-script`.

Slot props contracts (versioned, additive-only):

- `homepageSection` → `{ projectId: string | null }` (project in view on
  the compose surface). Registration: `{ id, title, component }`.
- `settingsSection` → `{}` (deliberately no props in V1). Rendered on the
  plugin detail page below the host-rendered declarative settings
  form for running, needs-configuration, and degraded plugins. Registration:
  `{ id, title?, description?, component }`; `title` is an optional host-rendered
  section heading and `description` is optional supporting copy rendered with
  that heading. Use the existing hooks (`useRpc`, `useRealtime`,
  `useRealtimeConnectionState`, `useSettings`, `experimental_useAppNavigate`, `experimental_useAppContext`)
  for data. Enabled plugins appear in the
  settings sidebar when they declare settings descriptors OR register
  settings sections.
- `experimental_appOverlay` → `{}` (deliberately no props). An additive,
  app-wide React owner for floating plugin UI. Registration:
  `{ id, component }`. Omnyo mounts every registration once per app window
  through `PluginSlotMount`, outside route-owned layout regions. The component
  can therefore call app-level SDK hooks, including the sidebar thread data and
  action hooks, and keep their React contexts through a portal. Hooks whose
  contract requires a particular surface, including `useComposer`, remain
  limited to that surface. Omnyo supplies no chrome,
  positioning, visibility, focus, or responsive behavior; render fixed UI
  directly or use the vendored responsive overlay primitives. A crash hides
  only that overlay. Use a content script instead for DOM enhancement that does
  not need React context. Experimental: see `docs/api_to_audit.md`.
- `navPanel` → `{ subPath: string }` — owns the whole route at
  `/plugins/<pluginId>/<path>/*` and gets its own navigation rail destination. `subPath`
  is the route remainder after the panel root (`""` at the root), so deep
  links like `/plugins/notes/notes/work/ideas.md` land with
  `subPath: "work/ideas.md"`. Navigate within the panel via
  `experimental_useAppNavigate().toPluginPanel(path, { subPath, replace? })` — browser
  back/forward then walks panel-internal history (prefer this over hash
  routing).
  Registration:
  `{ id, title, icon, path, component, fixedTabs?, experimental_sidebarAccessory?, headerContent? }`.
  Omnyo automatically wraps every plugin page in the same host-owned App panel
  used by New thread and thread pages. The page component supplies only its
  main body; it must not mount a second panel layout or register Browser and
  Terminal itself. Omnyo owns the desktop split, compact drawer, header/panel
  toggle, resizing, tab strip, persistence, and the shared `panel.toggle`,
  `panel.newTab`, `panel.reopenClosedTab`, and `terminal.open` keyboard
  commands.

  New tab is a transient host launcher. On a plugin page it offers Browser
  (when the desktop browser is available) and Terminal; it does not offer
  workspace file search because a generic plugin page has no implicit project,
  environment, or working directory. The Terminal row includes a compact
  connected-machine selector, initially resolving the server machine and then
  the first connected fallback. Changing the selector does not launch
  anything; activating Start terminal uses the selected machine. The selection
  is page-session UI state, not plugin storage.

  Browser and Terminal tabs are normal host content tabs. Closing the final
  content tab closes an otherwise empty panel; if fixed tabs remain, Omnyo falls
  back to the first one instead. Hydration closes an open panel when no durable
  tab survived.

  `fixedTabs` declares ordered, non-closable page views in that
  same host tab strip:
  `{ id, panelId, title, icon, component, layout?, experimental_target? }`.
  Omnyo opens the
  first fixed tab on the page's first wide-layout visit, but remembers a later
  user close. One tab is active per visible split pane, so multiple fixed-tab
  components can be mounted concurrently. A component mounts only while its
  tab is active in a visible pane; closing the panel unmounts it. It receives
  the same `{ subPath }` as the main page. `layout: "padded"` (the default) gives it
  host padding and scrolling; `layout: "flush"` gives it the full panel content
  region so it can own both. Fixed tabs add content to the shared panel; they
  do not replace its native chrome, Browser, Terminal, or keyboard commands.
  Experimental: see `docs/api_to_audit.md`.

  Every registration's `panelId` must exactly match its containing nav panel's
  `id`; the registration is also the stable reference for selecting that
  plugin-owned tab. A targetable tab declares
  `experimental_target: { validate(value): value is Target }`; Omnyo checks JSON
  safety before calling the owner validator. From any component of the same
  plugin on that page, call
  `experimental_useAppPanel().openFixedTab({ surface: { kind: "current" }, tab,
target? })`. Inside the fixed-tab component,
  `experimental_useFixedTabTarget(tab)` returns `{ sequence, target, clear }`
  after validation. The per-tab target survives inactive-tab, closed-panel,
  and route remounts for the current app session; call `clear()` when the tab
  returns to its untargeted state. Selection persists through the host's
  ordinary panel state, while targets remain memory-only and disappear on app
  refresh. Invalid, unavailable, untargeted, or other-plugin references return
  false without changing valid panel state.

  `experimental_sidebarAccessory` is a no-props, presentational component for
  a live count or short status beside the panel's navigation entry. The SDK
  accepts it, but no host surface mounts it, because the navigation rail is
  icon-only. Experimental: see `docs/api_to_audit.md`.
  The host renders your compact plugin icon + `title` (or the host's
  breadcrumbs, for pages such as Automations) with your optional
  `headerContent` component as the header actions on the right, so do NOT
  repeat the title inside your component. In a single pane on a window at
  least 768px wide, both sit in the window title bar, the same place a
  thread's title and header controls go, and the page has no header row of
  its own. Split panes and windows under 768px keep a header row at the top
  of the page instead. In a split pane, the pane's maximize and close buttons
  follow your `headerContent`; under 768px, only the close button does. Keep `headerContent` to title-bar-sized controls (at most
  28px tall). The component owns the full-bleed
  body below with zero host padding; add your own padding and scrolling when
  the design needs them. `headerContent` is plugin code inside host chrome
  and is contained separately: a throw hides the header content without
  breaking the title or the panel body. For a classic page, use an outer scroll region
  with `p-4 md:p-5` and wrap its content in a
  `mx-auto w-full max-w-3xl space-y-4` div.

- `threadPanelAction` → an entry in the thread right panel's new-tab
  Actions list (next to "Start side chat" / "Start terminal"), labeled
  `title` with your compact plugin icon. This slot is only offered for an
  existing thread; it never renders on the root New thread screen, and its
  `threadId` stays required. Registration:
  `{ id, title, icon?, component, layout?, run? }`. Activating it calls
  `run({ threadId, openPanel })` — do anything there (rpc, toast), and/or
  call `openPanel({ title?, params? })` to open a closable panel tab
  rendering `component` with `{ threadId: string, params: JsonValue | null }`.
  `openPanel` returns `boolean` — true when the host accepted the open, false
  when it declined (non-JSON `params`, unavailable action, or a surface with
  no side panel). A decline is a return value, never a throw, and matches
  `messageAction`'s `openPanel` and `experimental_useAppNavigate().openThreadPanel`, so one
  open routine can serve every action kind. Because `run` is declared
  `void | Promise<void>`, call `openPanel` from a braced body
  (`run: ({ openPanel }) => { openPanel(); }`), not a concise arrow.
  Omitting `run` opens a tab immediately with defaults. Write parameters are
  typed as the recursively JSON-safe `JsonValue` exported by both
  `@omnyo/plugin-sdk` and `@omnyo/plugin-sdk/app`; they persist with the tab across reloads (null when
  none was passed); identical action+params re-opens focus the existing
  tab (title refreshed), different params open sibling tabs. The tab pill
  shows your compact plugin icon + the tab title. Errors thrown from `run`
  (sync or async) are contained and logged, never breaking the launcher.
  `layout` frames the tab content: `"padded"` (default) wraps `component`
  in the panel's scroll container with standard padding — right for
  document-like content; `"flush"` gives it the full tab area (no padding,
  definite height, no host scrolling) — right for app-like content that
  owns its layout, such as `ThreadChat`.
- `experimental_newThreadPanelAction` → the root New thread counterpart to
  `threadPanelAction`. It appears in that screen's right-panel Actions list
  and never appears beside an existing thread. Registration has the same
  `{ id, title, icon?, component, layout?, run? }` shape, but activating it
  calls `run({ projectId, openPanel })` and its component receives
  `{ projectId: string | null, params: JsonValue | null }`; `projectId` is
  null in projectless compose. Panel opening, JSON params, layout, persistence,
  deduplication, the `boolean` return, and error containment otherwise match
  `threadPanelAction`.
  Experimental: see `docs/api_to_audit.md`.
- Removed pre-1.0: `composerAccessory` was the legacy composer footer. Migrate
  controls to `app.composer.customize({ actions })` or `plusMenu`, larger
  content to `banners`, and legacy `{ projectId, threadId }` prop reads to
  `useComposer().scope`.
- `pendingInteraction` → `{ interaction, submit, cancel }` — replaces the
  thread composer only while a matching plugin interaction is pending.
  Registration: `{ id, component }`; `id` must equal the backend request's
  `rendererId`. `interaction` contains metadata plus the JSON `payload`;
  `submit(value)` returns the JSON value to the waiting backend invocation,
  while `cancel()` settles it without a value. Keep sensitive field values in
  component state only.
- `experimental_sidebarFooter.register` → managed host-rendered icon items in
  the app sidebar footer. Both variants take `{ id, label, icon }`. An action
  adds `{ kind: "action", onActivate }`; its callback receives
  `openPluginDetails()`. A disclosure adds
  `{ kind: "disclosure", component }`; Omnyo toggles that component above the
  row and passes it only `{ dismiss }`. A disclosure registration returns a
  controller that requests `open`, `close`, or `toggle`; an action registration
  returns nothing. Omnyo keeps only one disclosure open across all plugins.
  The component owns everything inside, including tabs and navigation.
  Experimental: see `docs/api_to_audit.md`.
- `experimental_sidebarFooterCard` → an additive React card in the footer. On
  desktop it sits at the start of the app-wide footer; on compact viewports it
  sits in the rail or above the drawer's footer action row.
  `ExperimentalSidebarFooterCardRegistration` takes `{ id, component }`; the
  component receives `{ experimental_placement?: "rail" | "sidebar" | "footer" }`
  so it can render a one-line form in the 30 px footer, and keeps the normal
  plugin contexts and crash boundary. Cards disappear when their plugin is
  disabled. Experimental: see `docs/api_to_audit.md`.
- `experimental_sidebarEntry` → no component; the host draws the row.
  `ExperimentalSidebarEntryRegistration` takes `{ id, title, icon, panel,
tooltip, useStatus? }`. The host draws one labeled row directly under "New
  thread" and above the chat list, in every sidebar scope and in the phone
  drawer, outside the scrolling list and outside replacement chat lists.
  `panel` is the `id` of one of the plugin's own `navPanel` registrations; the
  row opens it and that page gets no rail icon. `useStatus()` runs inside the
  plugin's contexts and crash boundary and returns `null` while loading or
  `ExperimentalSidebarEntryStatus` `{ dot: "attention" | "failed" | null,
tooltip: string | null, state: "paused" | "error" | null }`. The row shows a
  dot, never a number; a throw shows a muted "!" and keeps the label. Only the
  first enabled plugin's entry shows. Experimental: see `docs/api_to_audit.md`.
- `experimental_titleBarCenter` → `{}` (deliberately no props). An additive
  component in the center column of the window's top rail, between the left
  cluster (window controls, then the breadcrumbs or a single pane's thread
  title) and the right cluster (thread controls and the right-panel toggle),
  after any thread companion rows.
  `ExperimentalTitleBarCenterRegistration` takes `{ id, component }`; `id` is
  unique within the plugin (letters, digits, `-`, `_`). Omnyo mounts every
  registration in plugin load order with the normal plugin contexts and crash
  boundary, so a crash hides only that registration, and renders nothing when
  no plugin registers. The host container is a no-drag region, so the
  component receives clicks and hover inside the desktop window's drag area.
  Render one compact row and read live state through SDK hooks. Phone-width
  layouts have no top rail and do not mount it. Experimental: see
  `docs/api_to_audit.md`.
- `experimental_threadCompanion` → `{ threadId, projectId, placement }`. A
  live companion for the open thread. `ExperimentalThreadCompanionRegistration`
  takes `{ id, title, icon, component }`. Omnyo owns `placement`: `"aside"` (a
  288px card beside the chat column while the user's aside preference is on
  and the pane has room), `"toolbar"` (one row in the top bar's center column),
  or `"inline"` (above the composer on phone-width windows). The top bar shows
  a toggle per registration with its icon and title. Omnyo keeps the component
  mounted across placement changes and animates the move. Experimental: see
  `docs/api_to_audit.md`.
- `sidebarFooterAction` → compatibility API for a host-rendered footer action.
  Registration remains `{ id, title, icon, run }`, and `run` still receives
  `{ openSettings }`. New plugins should use
  `app.experimental_sidebarFooter.register({ kind: "action", ... })` so actions
  and disclosures share one surface.
- `fileOpener` → `{ path: string, source, experimental_lineRange?, Original }` — register as a viewer/editor
  for file extensions: `{ id, title, extensions: ["md"], component }`.
  Matching files use the first applicable opener in deterministic slot order
  by default. Users can pin Omnyo's preview or a specific opener per extension
  under Settings → "File openers", and
  right-clicking a file link in rendered markdown offers a one-off
  "Open with …" choice; matching files opened in the right panel then
  render your component in a plugin tab instead of the built-in preview —
  this includes links clicked in rendered markdown, the file picker, and
  `omnyo thread open`. `source` is
  `{ kind: "workspace" | "host" | "thread-storage", threadId, environmentId,
projectId, experimental_hostId? }` (nullable fields). The optional host ID
  selects a project-backed workspace host and persists in opener-tab parameters.
  The `path` follows the source (workspace:
  worktree-relative; host: absolute; thread-storage: storage-relative).
  `experimental_lineRange` (SDK 0.4.56) is a nullable, one-based inclusive
  `{ startLineNumber, endLineNumber }` target; older hosts may omit it. Observe
  object identity: each targeted open supplies a new object, including an
  identical range in the active tab. Apply the latest target after loading
  and on subsequent requests without replacing the editor model; null means
  no requested navigation.
  `Original` is Omnyo's preview bound to this file; render it to
  delegate conditionally without re-entering plugin replacement resolution.
  Applies only to live file content — git-ref snapshots and deleted files
  always use the built-in preview, and a removed/disabled opener degrades
  back to it. Pair with `api.sdk.files` (rpc from your server) to load and
  CAS-save the content.

## Replace the sidebar thread list

`app.slots.experimental_threadList` is the one **exclusive** slot: only one
list fills the sidebar's scroll area. Registering activates the replacement
while the plugin is enabled. If multiple plugins register one, the first in
deterministic slot order is active by default; removing it reveals the next.
The user can pin a specific provider under **Settings → Appearance →
Sidebar**. The choice is per client. Omnyo ships its own list as the bundled
`thread-list` plugin; there is no separate built-in list.

Your component gets the scrolling list and nothing else. The New-thread button,
the navigation rail, and the footer stay host-rendered —
other plugins live in two of those, so a replaced list must not remove them.
Put your own controls at the top of your scroll area instead.

If no thread list plugin is enabled, Omnyo shows a placeholder that links to
Plugins. If the active component throws, Omnyo shows a "stopped working"
placeholder with a Reload button plus one toast; nothing else in the sidebar
is affected.

The [sidebar thread-list props](#sidebar-thread-list-props)
cover the component contract and project scope.

**Reading and acting on threads.** One hook reads the list; writes go through
the plugin SDK and navigation:

```tsx
const { status, threads, projects, sections } =
  experimental_useSidebarThreads();
const navigate = experimental_useAppNavigate();
navigate.toThread(thread.id, { split: true });
navigate.toCompose({ projectId, placement: { sectionId, pinned: false } });
const archiveEnvironmentThreads = experimental_useArchiveEnvironmentThreads();

// sections: PluginSidebarSection[] — { id, name, createdAt, updatedAt } in
// server order. A thread's `sectionId` names one of these or is null for the
// loose "Threads" bucket. Create, rename, and delete sections and move
// threads between them through the public API client; the sidebar refreshes
// over realtime:
const sdk = useSdk();
await sdk.threadSections.create({ name: "Later" });
await sdk.threads.update({ id: thread.id, sectionId });

// threads: PluginSidebarThread[] — id, projectId, href (put it on the row's
// anchor; the host routes clicks in place), title, titleFallback,
// displayTitle, parentThreadId, lifecycleOwnerThreadId, sourceThreadId, sectionId,
// experimental_subtitle (plugin-authored second line, string | null; absent
// on hosts that predate the experimental setter),
// originKind, originPluginId, providerId, status (execution status; busy
// threads sort first in Omnyo's list), runtimeStatus (status refined by host
// readiness), queuedWork ("none" | "waiting" | "failed"), hasPendingInteraction,
// activity, isUnread/isPinned/pinnedAt/isArchived/archivedAt, pinSortKey
// (manual pin order),
// isHidden (Omnyo's list filters these out; the array keeps them),
// environment { id, name, branchName, path, isWorktree, providerId,
// workspaceDisplayKind }, where workspaceDisplayKind is deprecated
// compatibility data; host { id, name }, createdAt, updatedAt, lastReadAt,
// latestAttentionAt, lastMessageAt (latest user or agent message; null before
// the first), and `indicator` (Omnyo's resolved status kind) +
// `indicatorLabel` (its a11y string). `experimental_work` is the server-owned
// work summary. Use it with experimental_threadIndicators.resolve below;
// raw runtime status and activity counts do not decide work or archive readiness.

// Three more per-row facts are client-local, so they are hooks rather than
// fields on the thread: an unsent composer draft (Omnyo paints a pencil, or a
// "working-draft" glyph when the thread is busy), a row status another
// plugin's app-wide script set (Omnyo draws it in place of the draft glyph), and
// the jump shortcut Omnyo assigns while the app command modifier is held (Omnyo
// shows a key pill). Local drafts decorate the server work summary:
const { hasUnsubmittedDraft } = useSidebarThreadDraft(thread.id);
const indicator = experimental_threadIndicators.resolve({
  work: thread.experimental_work ?? null,
  hasUnsubmittedDraft,
});
const rowStatus = useSidebarThreadRowStatus(thread.id); // { icon, label, tone? } | null
const shortcut = useSidebarThreadShortcut(thread.id); // { label, ariaKeyshortcuts } | null
const draftIds = useSidebarThreadDraftIds(); // ReadonlySet<string>, for group rollups
const rowStatuses = useSidebarThreadRowStatuses(); // ReadonlyMap, for group rollups
const splitLayout = useSidebarSplitLayout(); // { panes: [{ paneId, rect, threadId, isFocused }] } | null
// projects: PluginSidebarProject[] — { id, name, isPersonal, href, settingsHref }

// Titles can contain @project:, @section:, and @thread: mentions. `displayTitle`
// is the resolved plain text (sort on it, use it for aria-label); <ThreadTitle>
// renders the same text with Omnyo's mention chips:
<span className="truncate">
  <ThreadTitle threadId={thread.id} />
</span>;

// `environment.providerId` names an entry in Omnyo's environment provider
// catalog; resolve it for a display name, and draw it with
// <experimental_ProviderIcon providerKind="environment" provider={entry} />:
const { providers: environmentProviders } = useEnvironmentProviders();

// Pull requests are per row and opt-in — a lookup hits the git host, so it is
// deliberately NOT on the thread payload every sidebar loads:
const { pullRequest } = experimental_useSidebarThreadPullRequest(thread.id);
// → { isLoading, pullRequest: { number, title, url, state, attention } | null }

const navigate = experimental_useAppNavigate();
const sdk = useSdk();
navigate.toThread(id, { split: true }); // Omnyo's split placement rules
navigate.toCompose({ projectId, focusPrompt: true });
navigate.toCompose({ projectId, placement: { sectionId, pinned: false } }); // file it under a section
navigate.toCompose({ projectId, environmentId }); // reuse an environment
await sdk.threads.pin({ threadId: id }); // optimistic in Omnyo's surfaces
await sdk.threads.markUnread({ threadId: id });
await sdk.threads.update({ threadId: id, title: "New title" }); // silent; for inline editing
```

Archive and delete go through Omnyo's thread menu (below), which owns the
confirmations: archiving a thread with children asks first and counts them,
and deletion always asks.

Unit-test a list with `renderSlot(...)` from `@omnyo/plugin-sdk/testing/app`:
seed rows with the `sidebarThreads` option (plus `sidebarDraftThreadIds`,
`sidebarRowStatuses`, and `sidebarShortcuts` for the per-row hooks) and assert against
`inspection.navigateCalls` and `inspection.sdkCalls`.

**Splits.** Rows can drag out to the split area:

```tsx
const { splitProps, isAvailable, layout } =
  experimental_useSidebarThreadSplit(thread.id);

<a {...splitProps} onClick={...}>
  {title}
  {/* layout is data: draw a mini-map, a tint, or nothing */}
</a>;
```

The host owns the gesture rules, including the one that matters if your list
has its own drag-to-reorder: a split drag engages only once the pointer leaves
the sidebar.

**Omnyo's menu on your row.** Render `experimental_ThreadActionsMenu` and
`experimental_ThreadActionsContextMenu` around your row for Omnyo's own thread
menu (archive and delete confirmation included) plus every plugin's thread
actions; see [thread-menu actions](frontend-registration.md#an-action-in-every-thread-menu).
`experimental_useArchiveEnvironmentThreads()` archives a whole environment
group with Omnyo's pane cleanup and Undo toast.

**Omnyo's status glyph on your row.** Render `experimental_ThreadStatusGlyph`
with the resolved `indicator` and `useSidebarThreadRowStatus(threadId)` as
`rowStatus`. Required input, running work, blocked work, and waits keep priority
over plugin row decorations. For collapsed groups,
`experimental_threadIndicators.strongest` selects the highest-priority server
summary. Missing work summaries remain Open and cannot establish Ready.

**Keyboard support is a DOM contract.** Omnyo's thread shortcuts find rows by
query selector, not by React state. Put both attributes on each row's anchor or
rebound `thread.jump.1…9` shortcuts, `thread.next`, and `thread.previous`
silently stop working. The default numbered shortcuts switch the project rail:

```tsx
<a data-sidebar-thread-shortcut-target="" data-sidebar-thread-id={thread.id}>
```

## Sidebar thread-list props

The component receives:

```ts
type PluginSidebarScope =
  { kind: "inbox" } | { kind: "project"; projectId: string };

interface PluginThreadListProps {
  activeThreadId: string | null;
  activeProjectId: string | null;
  isCompactViewport: boolean;
  /** The navigation rail's selection. Absent on hosts without a project
      rail; treat absence like the inbox. */
  experimental_scope?: PluginSidebarScope;
  /** Closes the mobile drawer. Always call it after opening a thread. */
  onNavigate: () => void;
  /** Deprecated compatibility value for the removed sidebar search field.
      The host always supplies "". */
  searchQuery: string;
}
```

`experimental_scope` follows the rail. With `inbox`, list chats from every
project. With `project`, list only the chats of `projectId` and start new
chats there; the project can be Personal or have no chats yet. The host
stores the choice per device. When the user opens a chat from another
project, for example from the quick palette, the host moves a project scope
to that chat's project. It never changes the inbox scope. Older hosts omit
the prop, so treat a missing value as the inbox.
