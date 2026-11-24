# Frontend registration and major surfaces

## Frontend (`omnyo.app` entry)

`app.tsx` default-exports `definePluginApp` from `@omnyo/plugin-sdk/app`.
React and the SDK are **never bundled** — `omnyo plugin build` shims them to
the host's shared runtime, so the bundle only works inside Omnyo.

```tsx
import {
  definePluginApp,
  useRpc,
  useRealtime,
  useRealtimeConnectionState,
  useSettings,
  experimental_useAppContext,
  experimental_useAppNavigate,
  experimental_FileLink as FileLink,
  UrlLink as UrlLink,
  useComposer,
} from "@omnyo/plugin-sdk/app";
import { toast } from "sonner"; // shimmed to the host toaster
import { Button } from "@/components/ui/button"; // vendored source YOU own
import { Dialog, DialogContent } from "@/components/ui/dialog";

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "editor-enhancement",
    mount({ pluginId, generation, signal }) {
      const onKeyDown = (event: KeyboardEvent) => {
        // Ordinary trusted, same-origin DOM behavior.
      };
      document.addEventListener("keydown", onKeyDown, { signal });
      return () => document.removeEventListener("keydown", onKeyDown);
    },
  });
  app.slots.homepageSection({
    id: "issues",
    title: "Open issues",
    component: IssuesSection,
  });
  app.slots.settingsSection({
    id: "settings",
    title: "Connection",
    description: "Configure the remote service used by this plugin.",
    component: SettingsSection,
  });
  app.slots.experimental_appOverlay({
    id: "floating-status",
    component: FloatingStatus,
  });
  app.slots.navPanel({
    id: "board",
    title: "Board",
    icon: "Columns",
    path: "board",
    component: Board,
    fixedTabs: [
      {
        panelId: "board",
        id: "navigation",
        title: "Navigation",
        icon: "PanelRight",
        component: BoardNavigation,
        layout: "flush",
      },
    ],
    experimental_sidebarAccessory: OpenIssueCount,
  });
  app.slots.threadPanelAction({
    id: "issue",
    title: "Open issue",
    component: IssuePanel,
    run: async ({ threadId, openPanel }) => {
      openPanel({ title: `Issue for ${threadId}` });
    },
  });
  app.slots.experimental_newThreadPanelAction({
    id: "template",
    title: "Apply template",
    component: TemplatePanel,
    run: ({ projectId, openPanel }) => {
      openPanel({ title: `Template for ${projectId ?? "projectless"}` });
    },
  });
  app.composer.customize({
    id: "prompt-tools",
    actions: [{ id: "improve", component: ImprovePromptAction }],
    plusMenu: [
      {
        id: "append-checklist",
        label: "Append checklist",
        run: ({ composer }) =>
          composer.insert("- Verify behavior\n- Run checks", {
            at: "end",
            block: true,
          }),
      },
    ],
    banners: [{ id: "workflow", component: WorkflowBanner }],
    richText: {
      effects: [
        {
          id: "todo",
          className: "plugin-todo-highlight",
          match: (text) =>
            Array.from(text.matchAll(/\bTODO\b/g), (match) => ({
              from: match.index,
              to: match.index + match[0].length,
            })),
        },
      ],
    },
  });
  app.slots.pendingInteraction({
    id: "credentials",
    component: CredentialForm,
  });
  app.experimental_sidebarFooter.register({
    kind: "action",
    id: "remote",
    label: "Remote access",
    icon: "Smartphone",
    onActivate: ({ openPluginDetails }) => openPluginDetails(),
  });
  app.slots.experimental_sidebarFooterCard({
    id: "sync-status",
    component: SyncStatusCard,
  });
  app.slots.experimental_titleBarCenter({
    id: "live",
    component: LiveIsland,
  });
  app.slots.experimental_sidebarEntry({
    id: "row",
    title: "Board",
    icon: "Diamond",
    panel: "board",
    tooltip: "What needs you across all projects",
    useStatus: useBoardStatus,
  });
  app.slots.messageDirective({ id: "inline-vis", component: InlineVis });
  app.slots.experimental_codeFenceRenderer({
    id: "ui-blocks",
    languages: ["ui"],
    component: UiBlock,
  });
  app.slots.experimental_threadList({
    id: "inbox",
    title: "Inbox",
    description: "One flat list, newest thread on top.",
    component: InboxList,
  });
});
```

### A nav panel page for one project

A `navPanel` page whose sub-path starts with a project ID
(`/plugins/<pluginId>/<path>/<projectId>/...`) belongs to that project. The
rail marks the project's tile as the current location, a rail scoped to
another project moves to it, and `activeProjectId` in a replaced thread list
names it. Pass the project ID raw, exactly as the sidebar lists it, as the
first segment of `toPluginPanel(path, { subPath })`, which encodes each
segment itself. Canvas uses `<projectId>/<kind>/<id>`.

### A live status card

`app.slots.experimental_sidebarFooterCard` mounts a small always-visible card
for live status, such as usage or sync state. The component receives:

```ts
interface ExperimentalSidebarFooterCardProps {
  experimental_placement?: "rail" | "sidebar" | "footer";
}
```

`experimental_placement` names where Omnyo mounted the card. On desktop Omnyo
mounts cards with `footer` in the one-line app footer that spans the window,
about 30px tall, so render a single compact row there. On phone-width
viewports Omnyo mounts cards in the navigation rail (`rail`, a narrow column) or
the drawer's sidebar footer (`sidebar`). Older hosts omit the prop and mount cards only in
the rail, so treat a missing value as `rail`. Tooltips in the footer should
open upward.

### A row under New thread

`app.slots.experimental_sidebarEntry` adds one labeled row under "New thread"
that opens one of the plugin's own pages, which then gets no rail icon. The
host draws the label, icon, selection and a dot; `useStatus` only reports
state (`dot`, `tooltip`, `state`) and returns `null` while loading. Keep the
hook cheap: it runs on every sidebar render.

### Content in the top bar

`app.slots.experimental_titleBarCenter` mounts a component in the center of
the window's top rail, such as a live status island. The component receives
no props:

```ts
interface ExperimentalTitleBarCenterProps {}
```

Read live state through SDK hooks and render one compact row; the left
cluster, with the breadcrumbs or a single pane's thread title, truncates before
it reaches it. Popovers should open downward. Registrations from several
plugins share the center column in plugin load order, after any thread
companion rows. Phone-width layouts have no top rail, so pair it with
`experimental_sidebarFooterCard` when phones need the same status.

### A control in the thread header

`app.slots.experimental_threadHeaderAction` renders a component in the
thread's header controls. Use it for live plugin state. For a single pane on a
wide window, those controls sit in the window's top bar, right of center,
before the open-in-editor button and the right-panel toggle. Split panes and
phone-width windows keep a header row in each pane.

```tsx
app.slots.experimental_threadHeaderAction({
  id: "subagents",
  title: "Subagents",
  component: ({ threadId, projectId, isCompactViewport }) => { ... },
});
```

Both rows hold 28px controls. Render one inline control.
Put taller content in a portalled popover. The host limits the layout box, but
it does not clip painted overflow. `title`
names the host's wrapper region — your icon-only button still needs its own
accessible name. A split layout renders one header
per pane, so your component mounts once per visible thread — keep per-thread
state in the component, never in a module-level singleton.

A common pairing with a replaced sidebar: hide child threads from the list and
surface them here instead, filtering `experimental_useSidebarThreads()` by
`parentThreadId === threadId`.

### A companion beside the thread

`app.slots.experimental_threadCompanion` shows a live companion for the open
thread, such as a status card. Omnyo decides where it appears and passes the
current `placement`:

```tsx
app.slots.experimental_threadCompanion({
  id: "status",
  title: "Status",
  icon: "GridView",
  component: ({ threadId, projectId, placement }) => { ... },
});
```

- `"aside"`: a 288px card floating at the top right of the thread, beside the
  chat column. Omnyo uses it while the user's aside preference is on and the pane
  has room.
- `"toolbar"`: one row, at most 28px tall, in the center of the window's top
  bar. Omnyo uses it when the aside does not fit or the user turned it off.
- `"inline"`: a full-width card above the composer on phone-width windows.

The top bar shows a toggle per companion, with your `icon` and `title` as its
accessible name; it turns the aside on and off and Omnyo remembers the choice.
Omnyo keeps your component mounted when the placement changes and animates the
move, so keep state in the component and lay out from `placement` alone. In
split panes, each pane shows its aside when it fits, and only the focused
pane's companion takes the toolbar.

### Replace a thread's main pane

`app.slots.experimental_threadView` replaces the pane below an open thread's
header. The header, the side panel, split panes, and the compact drawer stay
Omnyo's. The slot is exclusive: only the first registration in plugin-id order is
active, and it receives every thread.

```tsx
app.slots.experimental_threadView({
  id: "canvas",
  title: "Canvas",
  component: ({ threadId, defaultView, transcript, composer }) =>
    claims(threadId) ? (
      <div className="flex min-h-0 flex-1 flex-col">
        <Canvas threadId={threadId} history={transcript} />
        {composer}
      </div>
    ) : (
      defaultView
    ),
});
```

Render `defaultView` for threads you do not claim. It is Omnyo's unmodified pane,
timeline and composer. For a claimed thread, render `transcript` (the timeline
without the composer) and `composer` (send, queue, drafts, banners) wherever
you need them. Never render `defaultView` together with `composer`: that mounts
two composers. Put `composer` at the bottom of a flex column; sending does not
scroll a separately rendered `transcript`. Omnyo shows its default pane while
plugin frontends boot and in place of a view that crashes. A crash disables
the view for that thread for the session.

### An action in every thread menu

`app.slots.experimental_threadAction` adds an entry to the thread header's
actions menu, the sidebar row's menu, its right-click menu, the compact
long-press drawer, and, when the user picks it in Customize row actions, a
sidebar row's quick-action buttons. Omnyo's own actions are registrations of the
same shape.

`useData` is a hook the host runs once for the whole app, never per row: read
your preferences or a realtime channel there. It receives `{ threadIds }`, the
sorted ids of every thread on screen or in an open menu; for per-thread state,
keep an id-keyed cache and fetch only the ids not in it, in one batch (for
example `useSdk().threads.experimental_listPluginMetadata({ threadIds })`).
`item` is pure: it gets `{ thread, data, sdk, navigate }` (your bound
`useSdk()` and `experimental_useAppNavigate()`) and returns the action for that thread, or
null to hide it. Menus and the quick-action picker sort registrations by
their static `group`, a separator between groups, then by `order`. Join one
of Omnyo's groups through `experimental_THREAD_ACTION_GROUPS` or name your own. `choices` renders as a submenu, a drawer step with Back, or
a popover; the picked id reaches `run` as `value`. Set `detail` to show the
current value on a muted line under the label, and `choices.hint` for a footnote below the
choices.

```tsx
app.slots.experimental_threadAction({
  id: "notifications",
  title: "Notifications",
  icon: "Notification",
  group: experimental_THREAD_ACTION_GROUPS.settings,
  useData: ({ threadIds }) => useNotificationLevels(threadIds),
  item: ({ thread, data, sdk }) => ({
    label: "Notifications",
    detail: data.get(thread.id) === "muted" ? "Muted" : "All activity",
    icon: "Notification",
    choices: {
      items: [
        {
          id: "all",
          label: "All activity",
          selected: data.get(thread.id) === "all",
        },
        {
          id: "muted",
          label: "Muted",
          selected: data.get(thread.id) === "muted",
        },
      ],
    },
    run: ({ value }) => saveLevel(sdk, thread.id, value),
  }),
});
```

A replacement thread list renders Omnyo's menus with
`experimental_ThreadActionsMenu` and `experimental_ThreadActionsContextMenu`,
passing its own rename editor as `requestRename` and list-only entries as
`inline` (`{ key, group, action }`). `trigger` is a function: spread the props
and ref it receives onto your button, or the menu never opens. `experimental_useThreadActions(thread, { keys })` returns bound
actions for quick-action buttons, and
`experimental_useThreadActionRegistrations()` lists every action's static
title and icon for a picker. Keys are `omnyo--core/<id>` and `<pluginId>/<id>`.

### A control in the Browser toolbar

`app.slots.experimental_browserToolbarAction` renders a component beside the
address bar of every built-in Browser tab. The component receives the owning
`threadId`, current `tabId`, top-level `url`, and `isCompactViewport` state.
Use these host-provided values to scope actions to the visible tab; do not infer
the active Browser from global state.

```tsx
app.slots.experimental_browserToolbarAction({
  id: "annotate",
  title: "Annotate page",
  component: ({ threadId, tabId, url, isCompactViewport }) => { ... },
});
```

Render a compact toolbar control and move larger UI into a host-owned panel or
portalled popover. `title` names the host wrapper; icon-only controls still need
their own accessible name. A component instance belongs to one Browser tab and
must release tab-scoped resources when it unmounts.

`experimental_page` scripts the tab's top-level document in the desktop app and
is `null` elsewhere. It does not take a CDP control lease, so no control banner
appears and agent automation can keep its debugger.

```tsx
component: ({ experimental_page: page }) => {
  useEffect(() => page?.onMessage((data) => console.log(data)), [page]);
  const pick = () =>
    page?.evaluate(
      "(document.addEventListener('click', (e) => omnyo.postMessage(e.target.tagName), { once: true }), true)",
    );
  ...
}
```

`evaluate(expression, { world })` awaits the expression and resolves its
JSON-cloned value. The default `isolated` world shares the DOM but not page
globals and binds `omnyo.postMessage(data)`; `onMessage` receives those values for
this plugin and tab. `world: "main"` runs beside page scripts (for example to
read framework state on DOM nodes) and binds `omnyo` to `null`. Anything installed
is lost when the document navigates; check again when `url` changes. Browser page evaluation requires Omnyo desktop 0.46.242 or newer; older or unknown native versions refuse before dispatch.

### Replacing the sidebar thread list

Read [sidebar replacement](frontend-core-slots.md#replace-the-sidebar-thread-list)
for the registration, server-owned work summaries, row controls, and keyboard contract.

### The provider directory

`experimental_useProviders()` returns `{ status, providers }` — every
registered agent provider in picker order, as the same `ProviderInfo` the
host's composer reads (`id`, `pluginId`, `displayName`, `family`, `icon`,
`logoUrl`, `available`, `capabilities`, `maintenance`, `extensionKinds`,
`composerActions`, and the declared `strings`, `reasoningLevels`,
`serviceTiers`). It reads the host's own cached roster, so
it costs no extra request. Use it whenever a surface shows a thread's or
automation's provider: never vendor provider names or copy in a plugin.

```tsx
const { providers } = experimental_useProviders();
const name =
  providers.find((provider) => provider.id === thread.providerId)
    ?.displayName ?? thread.providerId;
```

`status` is `"loading"` until the roster arrives and `"error"` when the request
failed; `providers` is empty in both cases, so fall back to the id. The
backend counterpart is `api.sdk.providers.list()`. Keep the hook in the plugin
entry (`app.tsx`) and pass names down as props, so view components stay pure
and testable outside the plugin runtime.
