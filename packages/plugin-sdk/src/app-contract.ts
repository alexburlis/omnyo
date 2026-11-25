import type {
  PluginResourceOptions,
  PluginResourceState,
} from "./plugin-resource-contract.js";

export type {
  PluginResourceKey,
  PluginResourceOptions,
  PluginResourceState,
} from "./plugin-resource-contract.js";

import type {
  ComponentPropsWithRef,
  ComponentPropsWithoutRef,
  ComponentType,
  CSSProperties,
  ReactNode,
} from "react";
import type {
  InboxSnapshot,
  PermissionMode,
  PromptInput,
  ProviderInfo,
  ReasoningLevel,
  ServiceTier,
  SessionOptionSelections,
  EnvironmentWorkspaceDisplayKind,
  ThreadQueuedWork,
  ThreadRuntimeDisplayStatus,
  ThreadStatus,
  ClaudeProfileSelection,
  WorkspaceGitOperation,
} from "@omnyo/domain";
import type {
  CreateExecutionInputSources,
  CreateThreadEnvironmentArgs,
  ProjectResponse,
} from "@omnyo/server-contract";
import type {
  OmnyoSdkAreas,
  PluginThreadMetadataListArgs,
  PluginThreadMetadataListResult,
  ThreadPluginMetadataArgs,
  ThreadPluginMetadataResult,
  ThreadPluginMetadataUpdateArgs,
} from "@omnyo/sdk";
import type { JsonValue } from "./json-value.js";
import type {
  PluginRpcCallArgs,
  PluginRpcContract,
  PluginRpcResult,
} from "./rpc-contract.js";

/**
 * The `@omnyo/plugin-sdk/app` contract (plugin design §5.2) — pure types with no
 * side effects. The Omnyo app imports these to keep its real implementation in
 * sync (`satisfies PluginSdkApp`). Plugin authors import the same shapes through
 * `@omnyo/plugin-sdk/app`.
 *
 * Per-slot props are versioned contracts: additive-only within an SDK major.
 */

// ---------------------------------------------------------------------------
// Slot props (the versioned per-slot contracts).
// ---------------------------------------------------------------------------

/** Props passed to a `homepageSection` component. */
export interface PluginHomepageSectionProps {
  /** Project in view on the compose surface; null when none is selected. */
  projectId: string | null;
}

/**
 * Props passed to a `settingsSection` component.
 *
 * Deliberately empty in V1; versioned additive like the other slot props.
 */
export interface PluginSettingsSectionProps {}

/**
 * Props passed to an `experimental_appOverlay` component.
 *
 * Deliberately empty while the component reads live app state through SDK
 * hooks; versioned additive like the other slot props.
 */
export interface ExperimentalAppOverlayProps {}

/** Props passed to a `navPanel` component (it owns its whole route). */
export interface PluginNavPanelProps {
  /**
   * The route remainder after the panel root, "" at the root. The panel's
   * route is `/plugins/<pluginId>/<path>/*`, so a deep link like
   * `/plugins/notes/notes/work/ideas.md` renders the panel with
   * `subPath: "work/ideas.md"`. Navigate within the panel via
   * `experimental_useAppNavigate().toPluginPanel(path, { subPath })` — browser
   * back/forward then walks panel-internal history.
   */
  subPath: string;
}

/**
 * Props passed to a panel tab opened by a `threadPanelAction`.
 *
 * This slot is rendered only for an existing thread. Use
 * `experimental_newThreadPanelAction` for the root New thread screen.
 */
export interface PluginThreadPanelProps {
  threadId: string;
  /**
   * The JSON value the action's `openPanel` call passed (round-tripped
   * through persistence, so the tab restores across reloads); null when the
   * action opened the panel without params.
   */
  params: JsonValue | null;
}

/** Props passed to a panel tab opened by `experimental_newThreadPanelAction`. */
export interface PluginNewThreadPanelProps {
  /** Project selected in the root composer; null in projectless compose. */
  projectId: string | null;
  /**
   * The JSON value the action's `openPanel` call passed (round-tripped
   * through persistence, so the tab restores across reloads); null when the
   * action opened the panel without params.
   */
  params: JsonValue | null;
}

export interface PluginPendingInteractionView {
  id: string;
  threadId: string;
  title: string;
  payload: JsonValue;
  createdAt: number;
  expiresAt: number | null;
}

export interface PluginPendingInteractionProps {
  interaction: PluginPendingInteractionView;
  submit(value: JsonValue): Promise<void>;
  cancel(): Promise<void>;
}

/** Display and accessibility metadata for a host-owned answer shortcut. */
export interface ExperimentalQuestionShortcut {
  label: string;
  ariaKeyshortcuts: string;
}

/**
 * The keyboard shortcuts Omnyo binds while a pending interaction is open. The
 * host owns the bindings (users can remap them); a form shows them and decides
 * what choosing an option means.
 */
export interface ExperimentalQuestionFormHost {
  /**
   * Shortcut per zero-based option index, as a string (`"0"` is the first
   * option). Missing entries have no binding.
   */
  shortcuts: ReadonlyMap<string, ExperimentalQuestionShortcut>;
  /**
   * Receive the index of the option the person chose with a shortcut while
   * the thread's pane is focused. Return true when the index names an option
   * the form handled. The last registered handler wins; call the returned
   * function to unregister.
   */
  registerChoiceHandler(handler: (index: number) => boolean): () => void;
}

/**
 * Props of the host-owned `experimental_VoiceInputTextarea`: a controlled
 * textarea with Omnyo's voice input. Other textarea attributes, including `ref`
 * and `className`, reach the underlying `<textarea>`; the caller styles it and
 * the host adds room for its microphone controls when voice input is
 * available.
 */
export interface ExperimentalVoiceInputTextareaProps extends Omit<
  ComponentPropsWithRef<"textarea">,
  "value" | "defaultValue" | "onChange" | "children"
> {
  value: string;
  /**
   * Receives typed edits and finished transcripts, which the host appends to
   * `value`. Transcripts stay editable and are never submitted.
   */
  onValueChange(value: string): void;
  /**
   * True from the start of recording until transcription finishes or is
   * cancelled, and false on unmount. Hold submission while it is true.
   */
  onVoiceInputActiveChange?(active: boolean): void;
}

/**
 * Props for a `sidebarFooterAction` — host-rendered (no plugin component).
 * Deliberately empty; the registration's `run` carries the behavior.
 */
export interface PluginSidebarFooterActionProps {}

/** Props passed to an experimental sidebar-footer disclosure component. */
export interface ExperimentalSidebarFooterDisclosureProps {
  /** Hide this disclosure without affecting another plugin's open disclosure. */
  dismiss(): void;
}

/**
 * What the sidebar shows, chosen in the navigation rail. `inbox` covers every
 * project; `project` narrows the sidebar to one project of the catalog,
 * including Personal and projects without chats.
 */
export type PluginSidebarScope =
  | { kind: "inbox" }
  | { kind: "project"; projectId: string };

/**
 * Props passed to an `experimental_threadList` component — the sidebar's
 * scrolling thread area, replaced wholesale by one plugin.
 */
export interface PluginThreadListProps {
  /** The thread the route currently shows; null on non-thread routes. */
  activeThreadId: string | null;
  /** The project the route currently shows; null when none is selected. */
  activeProjectId: string | null;
  /** True on phone-width viewports and coarse pointers. */
  isCompactViewport: boolean;
  /**
   * The rail's current scope. With `inbox`, list chats from every project.
   * With `project`, list only the chats of `projectId`. The host persists the
   * choice per device and moves a project scope to the project of a chat the
   * user opens elsewhere. Hosts without a project rail omit it.
   */
  experimental_scope?: PluginSidebarScope;
  /**
   * Call after the user opens a thread. It closes the mobile sidebar drawer.
   */
  onNavigate: () => void;
  /**
   * Compatibility value for the former sidebar search field. Omnyo now searches
   * threads in the quick palette, so the host always supplies "".
   *
   * @deprecated The quick palette owns thread search. Ignore this value.
   */
  searchQuery: string;
}

/**
 * Props passed to an `experimental_threadHeaderAction` component, rendered in
 * the thread's header controls: the window title bar's right cluster for a
 * single wide pane, or the pane's own header row in split panes. Phone-width
 * layouts do not mount it (see {@link PluginThreadHeaderActionRegistration}).
 */
export interface PluginThreadHeaderActionProps {
  /**
   * The thread these controls belong to. Never null: the slot is not rendered
   * on the compose screen or other non-thread routes. A split layout renders
   * one header per pane, so the component mounts once per visible thread,
   * each with its own id — keep per-thread state in the component, never in a
   * module-level singleton.
   */
  threadId: string;
  projectId: string;
  /**
   * True on coarse (touch) pointers, such as a tablet, where Omnyo's own
   * header controls grow to touch size. Collapse to an icon-sized control when
   * it is true. Never true because of width alone: phone-width layouts do not
   * mount header actions at all.
   */
  isCompactViewport: boolean;
}

/**
 * Props passed to an `experimental_threadView` component, which renders the
 * main pane of an open thread below the host-owned thread header.
 *
 * The three nodes are alternatives: render `defaultView`, or any of
 * `transcript` and `composer`. `defaultView` already contains the composer, so
 * rendering it together with `composer` mounts two composers for one thread.
 */
export interface PluginThreadViewProps {
  /**
   * The thread this pane shows. A split layout mounts the view once per pane,
   * each with its own id — keep per-thread state in the component.
   */
  threadId: string;
  projectId: string;
  /**
   * Core's unmodified main pane (timeline + composer). Render it for threads
   * this plugin does not claim.
   */
  defaultView: ReactNode;
  /**
   * Core's transcript without the composer, for a plugin view that shows
   * history on demand.
   */
  transcript: ReactNode;
  /**
   * Core's thread composer alone (send, queue, drafts, banners), for a plugin
   * view that replaces the transcript. Place it at the bottom of a flex column;
   * it does not shrink. Sending does not scroll a separately rendered
   * `transcript`.
   */
  composer: ReactNode;
  /** True on phone-width viewports and coarse pointers. */
  isCompactViewport: boolean;
}

/** JavaScript world a Browser page expression runs in. */
export type ExperimentalPluginBrowserPageWorld = "isolated" | "main";

export interface ExperimentalPluginBrowserPageEvaluateOptions {
  /**
   * `isolated` (default) runs in an Omnyo-owned world that shares the page DOM but
   * not page globals, and binds `api.postMessage(data)`. `main` runs beside the
   * page's own scripts, where `omnyo` is `null`.
   */
  world?: ExperimentalPluginBrowserPageWorld;
}

/**
 * Script access to the top-level document of one Browser tab. Independent of
 * CDP control leases: it never attaches a debugger or shows a control banner.
 */
export interface ExperimentalPluginBrowserPage {
  /**
   * Evaluate a JavaScript expression and resolve its JSON-serialized value.
   * Promises are awaited and `undefined` resolves to `null`. The expression
   * can reference `omnyo`. Rejects when the tab is gone or the expression throws.
   * Anything the expression installs is lost when the document navigates.
   */
  evaluate(
    expression: string,
    options?: ExperimentalPluginBrowserPageEvaluateOptions,
  ): Promise<JsonValue>;
  /**
   * Subscribe to values this plugin's isolated-world scripts in this tab send
   * with `api.postMessage(data)`. Returns the unsubscribe function.
   */
  onMessage(listener: (data: JsonValue) => void): () => void;
  /** Capture this bound desktop tab through its existing native owner. */
  experimental_capture?(): Promise<{
    base64: string;
    mimeType: "image/jpeg";
    width: number;
    height: number;
  }>;
}

export interface ExperimentalPluginBrowserToolbarActionProps {
  /** Thread that owns the Browser tab. */
  threadId: string;
  /** Browser tab currently rendering the action. */
  tabId: string;
  /** Current top-level URL shown in the address bar. */
  url: string;
  /** True when the Browser chrome needs compact controls. */
  isCompactViewport: boolean;
  /** Script access to this tab's page; `null` outside the desktop app. */
  experimental_page: ExperimentalPluginBrowserPage | null;
}

/**
 * Where a file being opened by a `fileOpener` lives. `path` semantics follow
 * the source: workspace paths are relative to the environment's worktree,
 * thread-storage paths are relative to the thread's storage root, host paths
 * are absolute on the thread's host.
 */
export interface PluginFileOpenerSource {
  kind: "workspace" | "host" | "thread-storage";
  threadId: string | null;
  environmentId: string | null;
  projectId: string | null;
  /**
   * Explicit host selected for a project-backed workspace file. Omitted when
   * the source is resolved by its environment/thread or the primary host.
   *
   * @experimental Audit before relying on this as a stable contract.
   */
  experimental_hostId?: string;
}

/** Props passed to a `fileOpener` component (rendered as a panel file tab). */
export interface PluginFileOpenerProps {
  path: string;
  source: PluginFileOpenerSource;
  /**
   * One-based, inclusive lines requested by the latest file open, or null when
   * untargeted. Omnyo supplies a new object for each targeted open, including an
   * identical target in the active tab. Observe object identity to navigate
   * again; keep the editor model intact. Older hosts may omit this prop.
   *
   * @experimental Audit navigation, remount, and persistence semantics before stabilizing.
   */
  experimental_lineRange?: {
    startLineNumber: number;
    endLineNumber: number;
  } | null;
  /**
   * Omnyo's file preview, bound to this file. Render it to delegate conditionally
   * without re-entering plugin replacement resolution.
   *
   * @experimental Audit before relying on this as a stable contract.
   */
  Original: ComponentType;
}

// ---------------------------------------------------------------------------
// Host-owned code rendering (SourceCode / Diff) — the public components and
// the props their replacements receive.
// ---------------------------------------------------------------------------

/** How a code line longer than the viewport is presented. */
export type CodeOverflowMode = "scroll" | "wrap";

/** How a diff presents its two sides. */
export type DiffViewMode = "unified" | "split";

/** A 1-based, inclusive line range. */
export interface SourceCodeLineRange {
  start: number;
  end: number;
}

/** One complete text side of a diff, resolved by the caller. */
export interface ExperimentalDiffFileContent {
  /** File path for this side. May differ between `old` and `new` for a rename. */
  path: string;
  /** Complete UTF-8 file contents, including unchanged lines outside the patch. */
  content: string;
}

/** Complete text contents for both sides of a diff. */
export interface ExperimentalDiffFullFileContents {
  old: ExperimentalDiffFileContent;
  new: ExperimentalDiffFileContent;
}

/**
 * Props of the host-owned `experimental_SourceCode` component — Omnyo's source
 * viewer. The host owns syntax highlighting, gutters, wrapping, line-selection
 * presentation, and the live Omnyo code theme; the caller owns loading the text
 * and any surrounding chrome.
 */
export interface SourceCodeProps {
  /** The complete source text to render. */
  content: string;
  /** File path or name. Drives language detection and the a11y label. */
  path: string;
  /** Long-line presentation. Defaults to `"scroll"`. */
  overflow?: CodeOverflowMode;
  /**
   * Lines to highlight and scroll into view (1-based, inclusive). Defaults to
   * `null` — nothing highlighted.
   */
  highlightedLines?: SourceCodeLineRange | null;
  /** Applied to the renderer's root element. */
  className?: string;
}

/**
 * Props of the host-owned `experimental_Diff` component — Omnyo's diff viewer.
 * The host owns patch normalization (a patch without a `diff --git` header is
 * completed from `path`), syntax highlighting, unified/split presentation,
 * gutters, line-selection presentation, optional full-file context expansion,
 * and the live Omnyo code theme. Content that cannot be parsed as a patch
 * degrades to plain monospace text.
 */
export interface DiffProps {
  /** Unified patch text for exactly ONE file. */
  patch: string;
  /**
   * The file the patch applies to. Used to complete a patch that arrives
   * without a `diff --git` header (GitHub's REST patches, single `@@` hunks)
   * and for language detection.
   */
  path: string;
  /** Side-by-side or inline. Defaults to `"unified"`. */
  view?: DiffViewMode;
  /** Long-line presentation. Defaults to `"scroll"`. */
  overflow?: CodeOverflowMode;
  /** Whether the gutter shows line numbers. Defaults to `true`. */
  showLineNumbers?: boolean;
  /**
   * Complete text for both file sides. When present and consistent with the
   * patch, Omnyo enables expand-context controls between hunks. The caller owns
   * loading these contents; omit the field to render from the patch alone.
   */
  experimental_fullFileContents?: ExperimentalDiffFullFileContents;
  /** Applied to the renderer's root element. */
  className?: string;
}

/**
 * Props passed to an `experimental_sourceCodeRenderer` component. Every value
 * is already resolved — the replacement never re-applies a host default.
 */
export interface PluginSourceCodeRendererProps {
  content: string;
  path: string;
  overflow: CodeOverflowMode;
  highlightedLines: SourceCodeLineRange | null;
  /**
   * Omnyo's source renderer, bound to this request. Render it to delegate
   * conditionally without re-entering plugin replacement resolution.
   *
   * @experimental Audit before relying on this as a stable contract.
   */
  Original: ComponentType;
}

/**
 * Props passed to an `experimental_diffRenderer` component. `patch` is always
 * a complete single-file unified patch, whatever shape the caller supplied,
 * and optional full-file context is resolved to an object or `null`.
 */
export interface PluginDiffRendererProps {
  patch: string;
  path: string;
  view: DiffViewMode;
  overflow: CodeOverflowMode;
  showLineNumbers: boolean;
  /**
   * Caller-resolved text for both sides, or `null` when the caller supplied
   * only the patch. A replacement can use this to implement context expansion,
   * but must verify that the paths and hunk lines agree with `patch` before
   * treating the contents as complete. Omnyo's original renderer performs that
   * verification when it mounts.
   */
  experimental_fullFileContents: ExperimentalDiffFullFileContents | null;
  /**
   * Omnyo's diff renderer, bound to this request. Render it to delegate
   * conditionally without re-entering plugin replacement resolution.
   *
   * @experimental Audit before relying on this as a stable contract.
   */
  Original: ComponentType;
}

/**
 * Message context passed to a `messageDirective` component — the user,
 * assistant, or nested agent message that contained the directive.
 */
export interface PluginMessageDirectiveMessage {
  id: string;
  threadId: string;
  turnId: string | null;
  projectId: string | null;
}

/**
 * Open a worktree-relative file in the host's workspace file viewer. Returns
 * true when the host accepted the path; false when the path is invalid or the
 * viewer declined it.
 */
export type PluginMessageDirectiveOpenWorkspaceFile = (path: string) => boolean;

/**
 * Props passed to a `messageDirective` component. Attributes are untrusted
 * strings parsed from the directive; the plugin validates its own fields.
 */
export interface PluginMessageDirectiveProps {
  /** Parsed, untrusted directive attributes (e.g. `{ file: "demo.html" }`). */
  attributes: Readonly<Record<string, string>>;
  /** Original directive source text (useful for diagnostics / crash fallback). */
  source: string;
  message: PluginMessageDirectiveMessage;
  /**
   * Opens a worktree-relative file in the host's workspace file viewer. Null
   * when the message surface has no workspace viewer available.
   */
  openWorkspaceFile: PluginMessageDirectiveOpenWorkspaceFile | null;
}

/**
 * Where a fenced code block stands while its message is written.
 *
 * - `"streaming"`: the closing delimiter has not arrived and the message is
 *   still being written; `code` is a prefix of the final body.
 * - `"closed"`: the closing delimiter is present; `code` is final.
 * - `"unclosed"`: the message ended without a closing delimiter (for example
 *   an interrupted reply); `code` will not grow.
 *
 * @experimental Audit before relying on this as a stable contract.
 */
export type ExperimentalCodeFenceStatus = "streaming" | "closed" | "unclosed";

/**
 * Props passed to an `experimental_codeFenceRenderer` component — one fenced
 * code block whose info-string language the plugin claimed, inside assistant
 * (or nested agent) message Markdown. Omnyo mounts the component once per fence
 * and keeps that instance for as long as the message stays on screen, so
 * component state survives the whole stream, including the moment the fence
 * closes and the moment the reply finishes.
 *
 * @experimental Audit before relying on this as a stable contract.
 */
export interface ExperimentalCodeFenceRendererProps {
  /** The fence body received so far, without the fence delimiters. */
  code: string;
  /** The matched lowercase info-string language (e.g. `"ui"`). */
  language: string;
  status: ExperimentalCodeFenceStatus;
  /**
   * Zero-based ordinal of this fence among the fences of the same language in
   * the same message. It does not change while the message streams, so
   * `${message.id}#${language}#${index}` keys state that must outlive the
   * mounted component (a reload, or the message scrolling out of the rendered
   * window).
   */
  index: number;
  message: PluginMessageDirectiveMessage;
  /**
   * Omnyo's own code block for this fence. Render it to show the source, for
   * example while `status` is `"streaming"` or when `code` does not parse.
   */
  Original: ComponentType;
}

// ---------------------------------------------------------------------------
// Slot registrations (the arguments to `app.slots.*`).
// ---------------------------------------------------------------------------

export interface PluginHomepageSectionRegistration {
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  title: string;
  component: ComponentType<PluginHomepageSectionProps>;
}

export interface PluginSettingsSectionRegistration {
  /** Render on Mobile settings instead of the plugin configuration page. */
  experimental_page?: "mobile";
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  /** Optional host-rendered section heading. */
  title?: string;
  /**
   * Optional one-line host-rendered subheading under `title`, in the built-in
   * SettingsSection idiom (ignored when `title` is absent).
   */
  description?: string;
  component: ComponentType<PluginSettingsSectionProps>;
}

/**
 * Render app-wide plugin UI outside Omnyo's layout regions.
 *
 * The host mounts each registration once per app window through the ordinary
 * plugin React boundary. The component therefore keeps PluginContext, router,
 * query, realtime, and other app-level SDK contexts when it renders fixed UI
 * or creates a React portal. Omnyo supplies no chrome, positioning, visibility,
 * or interaction policy; the plugin owns those details and responsive
 * behavior. Registrations are additive and a crash hides only that overlay.
 */
export interface ExperimentalAppOverlayRegistration {
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  component: ComponentType<ExperimentalAppOverlayProps>;
}

/**
 * Props passed to an `experimental_sidebarFooterCard` component.
 */
export interface ExperimentalSidebarFooterCardProps {
  /**
   * Where the host mounted this card. `footer` is the one-line app footer
   * that spans the desktop window, about 30px tall, and the phone drawer's
   * bottom rail, which is far narrower; `sidebar` is the sidebar footer above
   * its action row. Render a layout that fits the placement. Earlier hosts used
   * `rail` for the narrow navigation-rail column, and older hosts omit it and
   * mount cards only in the rail.
   */
  experimental_placement?: "rail" | "sidebar" | "footer";
}

/**
 * Mount an additive card in the app footer on desktop, or in the drawer's
 * bottom rail and sidebar footer on compact viewports. The host supplies the
 * ordinary plugin contexts and crash boundary, passes the placement, and
 * keeps its own controls in place.
 */
export interface ExperimentalSidebarFooterCardRegistration {
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  component: ComponentType<ExperimentalSidebarFooterCardProps>;
}

/**
 * Props passed to an `experimental_titleBarCenter` component.
 *
 * Deliberately empty while the component reads live app state through SDK
 * hooks; versioned additive like the other slot props.
 */
export interface ExperimentalTitleBarCenterProps {}

/**
 * Mount an additive component in the center column of the window's top rail,
 * between the left cluster (window controls, then the breadcrumbs or a single
 * pane's thread title) and the right cluster (thread controls and the
 * right-panel toggle). The host mounts every registration in plugin load
 * order after any `experimental_threadCompanion` toolbar items, with the
 * ordinary plugin contexts and crash boundary, renders nothing when no plugin
 * registers, and lets the component receive pointer events inside the desktop
 * window's drag region. A crash hides only that registration. Render one
 * compact row; the left cluster truncates before it reaches it. Phone-width
 * layouts have no top rail and do not mount it.
 */
export interface ExperimentalTitleBarCenterRegistration {
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  component: ComponentType<ExperimentalTitleBarCenterProps>;
}

/**
 * What an `experimental_sidebarEntry` status hook reports. `dot` lights the
 * row's indicator (`"attention"` amber, `"failed"` red); `tooltip` replaces
 * the registration's idle tooltip while set; `state` shows a muted
 * `"Paused"` label before the dot or a muted `"!"` in place of it.
 */
export interface ExperimentalSidebarEntryStatus {
  dot: "attention" | "failed" | null;
  tooltip: string | null;
  state: "paused" | "error" | null;
}

/**
 * A labeled row the host draws in the sidebar body, directly under "New
 * thread" and above the chat list, in every sidebar scope and in the phone
 * drawer. It stays outside the scrolling list and outside any replacement
 * chat list. The row opens `panel`, one of this plugin's own `navPanel`
 * registrations, and that page gets no rail icon. The host draws the label,
 * icon, selection and indicator; the plugin only supplies state through
 * `useStatus`, which the host calls inside the plugin's contexts and crash
 * boundary. Return `null` while loading. A crash or thrown hook shows the
 * error state without hiding the row. When several enabled plugins register
 * an entry, the host shows only the first in plugin load order.
 *
 * Experimental: see docs/api_to_audit.md.
 */
export interface ExperimentalSidebarEntryRegistration {
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  title: string;
  icon: IconName;
  /** The `id` of a `navPanel` registered by the same plugin. */
  panel: string;
  /** Tooltip while the status reports none. */
  tooltip: string;
  useStatus?: () => ExperimentalSidebarEntryStatus | null;
}

/**
 * Where the host currently shows an `experimental_threadCompanion`:
 *
 * - `"aside"`: a 288px floating card at the top right of the thread pane,
 *   beside the chat column. It never scrolls with the timeline.
 * - `"toolbar"`: one compact row, at most 28px tall, in the window title bar's
 *   center column.
 * - `"inline"`: a full-width card in the stack above the composer, on
 *   phone-width layouts.
 */
export type ExperimentalThreadCompanionPlacement =
  | "aside"
  | "toolbar"
  | "inline";

/**
 * Props passed to an `experimental_threadCompanion` component.
 */
export interface ExperimentalThreadCompanionProps {
  /** The thread the companion accompanies. */
  threadId: string;
  projectId: string;
  /**
   * The host's current placement. Lay the component out for it: a card for
   * `"aside"` and `"inline"`, one short row for `"toolbar"`. The component
   * stays mounted when the placement changes, so its state survives the move.
   */
  placement: ExperimentalThreadCompanionPlacement;
}

/**
 * Show a live companion for the open thread. The host owns where it appears:
 * phone-width layouts render it `"inline"` above the composer. Otherwise it is
 * an `"aside"` card while the pane has room beside the centered chat column,
 * and a `"toolbar"` row in the window title bar when it does not. The host
 * adds no control of its own: the component's `"toolbar"` row is the way in,
 * so let it open the full card when the row is clicked.
 * In split panes, each pane shows its aside only when it fits, and only the
 * focused pane's companion takes the toolbar. When the placement changes,
 * the host moves the mounted component and animates the move.
 *
 * The host mounts the component with the ordinary plugin contexts and crash
 * boundary. A crash hides only that registration.
 */
export interface ExperimentalThreadCompanionRegistration {
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  /** Names the companion. The host does not display it today. */
  title: string;
  /** Identifies the companion. The host does not display it today. */
  icon: IconName;
  component: ComponentType<ExperimentalThreadCompanionProps>;
}

/**
 * A name the host resolves to a glyph, in this order: a name any plugin
 * registered with `app.experimental_icons.register()`, then a built-in Omnyo icon
 * name (`"Zap"`), then a namespaced `"<pluginId>/<name>"` glyph naming an
 * entry of that plugin's manifest `omnyo.branding.experimental_icons` map. A
 * registration therefore shadows a built-in, and either shadows a declared
 * icon of the same name. Names that resolve to none of the three fall back to
 * the surface's generic icon.
 *
 * Declared icons and registrations are one vocabulary here: the same name
 * works in `experimental_Icon`, in every field below, and — for a declared
 * icon — in the tool, provider and bridge-row declarations that accept one.
 * Declared icons need no frontend bundle and survive the plugin being stopped;
 * registrations can be any React component but live only while the plugin's
 * app bundle is loaded.
 */
type IconName = string;

/**
 * Owner-defined validator for a fixed tab's transient target. The host first
 * verifies that the value is JSON-safe, then calls this validator before
 * selecting the tab or delivering the target.
 */
export interface ExperimentalFixedTabTargetContract<Target extends JsonValue> {
  validate(value: JsonValue): value is Target;
}

/** Stable, owner-scoped reference used by the app-panel controller. */
export type ExperimentalPluginFixedTabReference<
  Target extends JsonValue = never,
> = {
  /** The owning `navPanel` id; validated against the containing registration. */
  readonly panelId: string;
  /** Unique within the owning nav panel; letters, digits, `-`, `_`. */
  readonly id: string;
} & ([Target] extends [never]
  ? {
      /** An untargeted tab cannot be opened with a target. */
      readonly experimental_target?: never;
    }
  : {
      /** Owner validation required before the host delivers a target. */
      readonly experimental_target: ExperimentalFixedTabTargetContract<Target>;
    });

/** A fixed tab declared by a plugin nav panel. */
export type PluginFixedTabRegistration<Target extends JsonValue = never> =
  ExperimentalPluginFixedTabReference<Target> & {
    title: string;
    /** Resolved names take precedence over plugin branding; unknown names fall back to branding. */
    icon: IconName;
    component: ComponentType<PluginNavPanelProps>;
    /** `flush` lets the component own padding and scrolling. */
    layout?: "padded" | "flush";
  };

/** A fixed tab with either no target or an owner-validated JSON target. */
export type PluginFixedTabDeclaration =
  | PluginFixedTabRegistration
  | PluginFixedTabRegistration<JsonValue>;

export interface PluginNavPanelRegistration {
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  title: string;
  /** Resolved names take precedence over plugin branding in navigation and the header; unknown names fall back to branding. */
  icon: IconName;
  /** URL segment under `/plugins/<pluginId>/`; letters, digits, `-`, `_`. */
  path: string;
  component: ComponentType<PluginNavPanelProps>;
  /**
   * Ordered, non-closable tabs shown in this page's host-owned right panel.
   * Omnyo owns selection and persistence and always includes its native Browser
   * and Terminal tools beside them. One tab is active in each visible split
   * pane, so multiple fixed-tab components can be mounted concurrently. A
   * component mounts only while its tab is active in a visible pane and the
   * panel is open, and receives the same `subPath` as the page component.
   *
   * Experimental: see docs/api_to_audit.md.
   */
  fixedTabs?: readonly PluginFixedTabDeclaration[];
  /**
   * Optional presentational component for a narrow live value next to this
   * panel's entry in the sidebar. It receives no props so it can own that
   * value through the ordinary SDK hooks without coupling its state to the
   * host sidebar. The host still validates it, but no host surface currently
   * mounts it. Keep it to a small, single-line box; do not render controls or
   * rely on unbounded content here.
   *
   * Experimental: see docs/api_to_audit.md.
   */
  experimental_sidebarAccessory?: ComponentType;
  /**
   * Optional component rendered on the right side of the shared title bar
   * (e.g. a sync button or a count). Contained separately from the body: a
   * throwing headerContent is hidden without breaking the title bar.
   */
  headerContent?: ComponentType<PluginNavPanelProps>;
}

/**
 * What a plugin action passes when it asks the host to open one of its panel
 * tabs. Shared by every `openPanel` entry point so a plugin registering more
 * than one kind of action can write a single open routine;
 * `PluginTargetedPanelActionOpenOptions` adds the `actionId` a caller
 * outside a panel action must pass to name the panel it wants.
 */
export interface PluginPanelActionOpenOptions {
  /** Tab label. Default: the action's `title`. */
  title?: string;
  /**
   * Persisted with the tab and handed to the component as its `params` prop.
   * Must be a JSON value; anything else is a declined open.
   */
  params?: JsonValue;
}

/**
 * Context handed to a `threadPanelAction`'s `run`.
 *
 * The action is thread-only and is never offered on the root New thread
 * screen, so `threadId` is always present.
 */
export interface PluginThreadPanelActionContext {
  /** The thread whose panel launcher invoked the action. */
  threadId: string;
  /**
   * Open a tab in the thread's side panel rendering this action's
   * `component`. `title` labels the tab (default: the action's `title`);
   * `params` must be JSON-serializable — it is persisted with the tab and
   * reaches the component as its `params` prop. Opening with params
   * identical to an already-open tab of this action focuses that tab
   * (updating its title) instead of duplicating it. May be called more than
   * once (different params ⇒ multiple tabs) or not at all.
   *
   * Returns true when the host accepted the open; false when it declined —
   * from this launcher, only a `params` that is not a JSON value. The true /
   * false contract is shared with `messageAction`'s `openPanel` and
   * `experimental_useAppNavigate().openThreadPanel` (which decline for more reasons) so one
   * open routine can serve every action kind. A decline is never thrown: the
   * host logs it and reports it here.
   */
  openPanel(options?: PluginPanelActionOpenOptions): boolean;
}

export interface PluginThreadPanelActionRegistration {
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  /** Label of the action row in the panel's new-tab launcher. */
  title: string;
  /**
   * Resolved names take precedence over plugin branding in the launcher and
   * opened tabs. Omitted or unknown names fall back to plugin branding.
   */
  icon?: IconName;
  /** Rendered inside every panel tab this action opens. */
  component: ComponentType<PluginThreadPanelProps>;
  /**
   * How the host frames the tab content. "padded" (default) wraps the
   * component in the panel's scroll container with standard padding —
   * right for document-like content. "flush" gives the component the full
   * tab area (no padding, definite height, no host scrolling) — right for
   * app-like content that manages its own layout, such as
   * `ThreadChat`.
   */
  layout?: "padded" | "flush";
  /**
   * Runs when the user activates the action: call your RPC methods, show a
   * toast, and/or open panel tabs via `context.openPanel`. Omitted =
   * immediately open a panel tab with defaults. Errors (sync or async) are
   * contained and logged; they never break the launcher.
   */
  run?(context: PluginThreadPanelActionContext): void | Promise<void>;
}

/** Context handed to an `experimental_newThreadPanelAction`'s `run`. */
export interface PluginNewThreadPanelActionContext {
  /** Project selected in the root composer; null in projectless compose. */
  projectId: string | null;
  /**
   * Open a tab in the root New thread screen's side panel rendering this
   * action's `component`. The title, params, deduplication, return value, and
   * error semantics match `threadPanelAction`.
   */
  openPanel(options?: PluginPanelActionOpenOptions): boolean;
}

/** Registration for the root New thread screen's panel Actions list. */
export interface PluginNewThreadPanelActionRegistration {
  /** Unique within this slot for the plugin; letters, digits, `-`, `_`. */
  id: string;
  /** Label of the action row in the panel's new-tab launcher. */
  title: string;
  /** Resolved names take precedence over plugin branding; omitted or unknown names fall back to branding. */
  icon?: IconName;
  /** Rendered inside every panel tab this action opens. */
  component: ComponentType<PluginNewThreadPanelProps>;
  /** Host framing; matches `threadPanelAction`. */
  layout?: "padded" | "flush";
  /**
   * Runs when the user activates the action. Omitted = immediately open a
   * panel tab with defaults. Errors are contained and logged.
   */
  run?(context: PluginNewThreadPanelActionContext): void | Promise<void>;
}

/**
 * A form for a pending interaction. Where it renders follows the request: an
 * `api.ui.requestInput` form belongs to no turn, so it is pinned above the
 * composer, which stays usable with its queue, and on phones it waits as a
 * chip until tapped. A provider bridge's `interaction/request` blocks its turn,
 * so its form replaces the composer and opens at once on phones.
 */
export interface PluginPendingInteractionRegistration {
  /**
   * The renderer's plugin-local name. Two addresses resolve to it: the
   * `rendererId` a backend passes to `api.ui.requestInput`, and the `<name>`
   * half of a provider bridge's `interaction/request` kind
   * `"<pluginId>/<name>"` (docs/provider-plugin-api.md §4), which the client
   * splits on the slash to find this registration under its plugin.
   * `api.ui.requestInput` validates `rendererId` against `/^[a-zA-Z0-9_-]+$/`;
   * an extension kind must match `/^[a-z0-9-]+\/[a-z0-9-]+$/`
   * (`EXTENSION_KIND_PATTERN` in @omnyo/domain), so an id addressable both ways
   * uses lowercase letters, digits, and "-" only.
   */
  id: string;
  component: ComponentType<PluginPendingInteractionProps>;
}

/** Context handed to a `sidebarFooterAction`'s `run`. */
export interface PluginSidebarFooterActionContext {
  /**
   * Navigate to this plugin's detail page in Tools, where declarative settings
   * and `settingsSection` slots render.
   */
  openSettings(): void;
}

/**
 * An icon button in the app sidebar footer (next to Settings / bug report).
 * Host-rendered for consistent chrome — plugins supply icon, label, and
 * `run` behavior only.
 */
export interface PluginSidebarFooterActionRegistration {
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  /** Tooltip and accessible label for the icon button. */
  title: string;
  /** Resolved names take precedence over plugin branding; omitted or unknown names fall back to branding. */
  icon: IconName;
  /**
   * Runs when the user activates the action (e.g. call `openSettings()`,
   * open a panel via other surfaces, toast). Errors (sync or async) are
   * contained and logged; they never break the sidebar.
   */
  run(context: PluginSidebarFooterActionContext): void | Promise<void>;
}

/** Context handed to an experimental sidebar-footer action. */
export interface ExperimentalSidebarFooterActionContext {
  /** Navigate to this plugin's detail page in Tools. */
  openPluginDetails(): void;
}

/** Fields shared by both experimental sidebar-footer item behaviors. */
export interface ExperimentalSidebarFooterItemBase {
  /** Unique within the plugin's unified sidebar footer; letters, digits, `-`, `_`. */
  id: string;
  /** Tooltip and accessible label for the host-rendered icon button. */
  label: string;
  icon: IconName;
}

/** A sidebar-footer item that runs a callback when activated. */
export interface ExperimentalSidebarFooterActionRegistration extends ExperimentalSidebarFooterItemBase {
  kind: "action";
  onActivate(
    context: ExperimentalSidebarFooterActionContext,
  ): void | Promise<void>;
}

/** A sidebar-footer item that reveals plugin-rendered content above the row. */
export interface ExperimentalSidebarFooterDisclosureRegistration extends ExperimentalSidebarFooterItemBase {
  kind: "disclosure";
  component: ComponentType<ExperimentalSidebarFooterDisclosureProps>;
}

/** One host-rendered item in the app sidebar footer. */
export type ExperimentalSidebarFooterItemRegistration =
  | ExperimentalSidebarFooterActionRegistration
  | ExperimentalSidebarFooterDisclosureRegistration;

/** Live controls for an experimental sidebar-footer disclosure. */
export interface ExperimentalSidebarFooterDisclosureController {
  /** Request that the host open this disclosure, replacing any open sibling. */
  open(): void;
  /** Close this disclosure if it is currently open. */
  close(): void;
  /** Open this disclosure, or close it when it is currently open. */
  toggle(): void;
}

/** Managed registration surface for items in the app sidebar footer. */
export interface ExperimentalSidebarFooter {
  register(registration: ExperimentalSidebarFooterActionRegistration): void;
  register(
    registration: ExperimentalSidebarFooterDisclosureRegistration,
  ): ExperimentalSidebarFooterDisclosureController;
}

// ---------------------------------------------------------------------------
// Sidebar thread data (the `experimental_useSidebarThreads` contract).
// ---------------------------------------------------------------------------

/**
 * The glyph mapped from the server-owned work summary. Read unreadness from
 * `isUnread` independently. Local drafts may decorate the glyph without
 * changing work state or archive eligibility.
 */
export type PluginSidebarThreadIndicator =
  import("@omnyo/domain").ThreadListIndicatorKind;

/** Live work counts on a thread. All zero means nothing is running. */
export interface PluginSidebarThreadActivity {
  workflows: number;
  backgroundAgents: number;
  backgroundCommands: number;
  planMode: number;
  goals: number;
  /**
   * Subagents running now: delegated agents in the open turn, background
   * agents, and running workflow agents, one per spawning call. Absent only
   * on hosts that predate the field.
   * Experimental: see docs/api_to_audit.md.
   */
  experimental_subagents?: number;
}

/**
 * One thread in the sidebar's live view.
 *
 * A deliberate copy of the fields a sidebar needs — not a re-export of the
 * host's internal thread row type, which changes whenever the app needs a
 * field. Timestamps are epoch milliseconds.
 */
export interface PluginSidebarThread {
  /** Server-owned work summary; absent or null only on legacy hosts. */
  experimental_work?: import("@omnyo/domain").ThreadWorkSummary | null;
  /** Native question/callback state; absent only on older servers. */
  experimental_attention?: import("@omnyo/domain").ThreadAttention;
  id: string;
  projectId: string;
  /** Null while a thread is still unnamed; pair with `titleFallback`. */
  title: string | null;
  titleFallback: string | null;
  /**
   * What Omnyo shows for this thread as plain text: `title`, else
   * `titleFallback`, else a short id, with any `@project:`, `@section:`, and
   * `@thread:` mentions in it resolved to their names. Sort on it and use it
   * for accessible names; render {@link PluginSdkApp.ThreadTitle} for the
   * same text with mention chips.
   */
  displayTitle: string;
  /** Plugin-authored second line; null when no active plugin owns a subtitle. */
  experimental_subtitle: string | null;
  /** The thread this one was forked from or spawned under; null at the root. */
  parentThreadId: string | null;
  /**
   * The thread whose lifecycle this one follows (a delegated child stops
   * when its owner stops); null when the thread owns its own lifecycle.
   */
  lifecycleOwnerThreadId: string | null;
  /**
   * The thread this one was forked from (`originKind` "fork") or handed off
   * from (`originKind` "handoff"); null when `originKind` is null.
   */
  sourceThreadId: string | null;
  sectionId: string | null;
  /**
   * The chat group this chat sits in (see
   * {@link PluginSidebarThreadsState.experimental_groups}); null when
   * ungrouped. A sub-chat shows under its parent whatever its own group.
   * Absent only on hosts that predate groups. Experimental: see
   * docs/api_to_audit.md.
   */
  experimental_groupId?: string | null;
  /**
   * How this thread came from `sourceThreadId`: "fork" copies the source's
   * history, "handoff" continues the source's work under the same title.
   * The source and its existing children become children of the handoff.
   * Null when the thread has no source.
   */
  originKind: "fork" | "handoff" | null;
  /** The plugin that spawned it, or null for non-plugin origins. */
  originPluginId: string | null;
  /** The agent provider this thread runs on; resolve it through
   * {@link PluginSdkApp.experimental_useProviders} for a name and icon. */
  providerId: string;

  /**
   * The thread's execution status. Omnyo's list sorts busy threads ("starting",
   * "active", "stopping") above idle ones. Treat an unknown value as "idle".
   */
  status: ThreadStatus;
  /**
   * `status` refined by host and environment state: adds "provisioning" and
   * "waiting-for-host" for a thread whose machine is not ready. Treat an
   * unknown value as `status`.
   */
  runtimeStatus: ThreadRuntimeDisplayStatus;
  /**
   * Whether a message is queued behind the running turn ("waiting") or a
   * queued message failed to send ("failed"). "none" otherwise.
   */
  queuedWork: ThreadQueuedWork;
  /** The agent is blocked on the user: an approval or a question. */
  hasPendingInteraction: boolean;
  activity: PluginSidebarThreadActivity;
  indicator: PluginSidebarThreadIndicator;
  /**
   * The host's accessible label for `indicator`, e.g. "Thread needs user
   * input"; null when the indicator is "none". Use it for `aria-label` so
   * screen-reader text stays consistent across sidebars.
   */
  indicatorLabel: string | null;

  isUnread: boolean;
  isPinned: boolean;
  /** When the thread was pinned (epoch ms); null when unpinned. */
  pinnedAt: number | null;
  /**
   * The user's manual order among pinned threads (lexicographic, ascending);
   * null for an unpinned thread or a pin that has never been reordered, which
   * Omnyo's list sorts after keyed pins by `pinnedAt`.
   */
  pinSortKey: string | null;
  isArchived: boolean;
  /** When the thread was archived (epoch ms); null when not archived. */
  archivedAt: number | null;
  /**
   * When the thread's family was moved to the Shelf (epoch ms); null when it
   * is not shelved. A shelved thread is not archived: archiving clears it,
   * and new activity in the family returns it. Experimental: see
   * docs/api_to_audit.md.
   */
  experimental_shelvedAt: number | null;
  /**
   * The owner's Shelf order (lexicographic, ascending) for a shelved thread's
   * family; null when the thread is not shelved or was shelved a moment ago
   * and the server has not answered yet, which lists it first. Move a
   * top-level Shelf thread with `sdk.threads.experimental_reorderShelved`.
   * Experimental: see docs/api_to_audit.md.
   */
  experimental_shelfSortKey: string | null;
  /**
   * The app-relative URL Omnyo opens for this thread, e.g.
   * `/projects/<projectId>/threads/<id>`. Put it on your row's anchor: the
   * host routes a plain click in place, and middle-click, copy-link, and
   * open-in-new-window work without further code.
   */
  href: string;
  /**
   * True for threads Omnyo keeps out of its own list (internal helper threads a
   * plugin spawned with `visibility: "hidden"`). The array includes them so a
   * list that wants them can show them; Omnyo's list filters them out.
   */
  isHidden: boolean;

  environment: {
    id: string | null;
    name: string | null;
    branchName: string | null;
    /** The checkout's absolute path on its host; null when unknown. */
    path: string | null;
    /**
     * True when the environment is a git worktree, which is what Omnyo's
     * "group by environment" clusters; false for a plain checkout; null when
     * unknown.
     */
    isWorktree: boolean | null;
    /**
     * The id of the environment provider that produced this environment, or
     * null for a project's own checkout. Resolve it against
     * `GET /system/environment-providers` for a display name and icon.
     */
    providerId: string | null;
    /** @deprecated Use providerId and the environment provider catalog instead. */
    workspaceDisplayKind: EnvironmentWorkspaceDisplayKind | null;
  } | null;
  /**
   * The machine this thread's work runs on, with the name resolved for you.
   * Null when the thread has no environment yet, or when its host is not in
   * the known-hosts list. Useful where a thread has no branch to show — a
   * personal-project thread has a machine but no worktree.
   */
  host: { id: string; name: string } | null;

  createdAt: number;
  updatedAt: number;
  lastReadAt: number | null;
  latestAttentionAt: number;
  /**
   * When the latest user or agent message in the thread was sent; null
   * before the first message.
   */
  lastMessageAt: number | null;
}

/**
 * The pull request for a thread's branch, narrowed to what a sidebar row
 * needs. `attention` is Omnyo's rolled-up "does this need you" signal, so a row
 * can colour a badge without reading checks, review, and mergeability itself.
 */
export interface PluginSidebarPullRequest {
  /** Whether GitHub auto-merge is enabled. */
  experimental_autoMerge: boolean;
  /** Null when the GitHub merge queue lookup is unavailable. */
  experimental_inMergeQueue: boolean | null;
  experimental_checks: {
    state: "passing" | "failing" | "pending" | "no_checks" | "unknown";
  };
  experimental_review: {
    state:
      | "approved"
      | "changes_requested"
      | "review_required"
      | "review_requested"
      | "none";
  };
  experimental_mergeability: {
    state: "mergeable" | "conflicts" | "blocked" | "draft" | "unknown";
  };
  number: number;
  title: string;
  url: string;
  state: "draft" | "open" | "merged" | "closed";
  attention:
    | "checks_failed"
    | "checks_pending"
    | "changes_requested"
    | "review_requested"
    | "conflicts"
    | "blocked"
    | "draft"
    | "queued"
    | "ready_to_merge"
    | "merged"
    | "closed"
    | "none";
}

export interface PluginSidebarThreadPullRequestState {
  /** True while the first lookup for this thread's environment is in flight. */
  isLoading: boolean;
  /**
   * The pull request, or null when the branch has none, the thread has no
   * environment, or the lookup could not run (a git-host hiccup). A row should
   * treat null as "nothing to show", never as an error.
   */
  pullRequest: PluginSidebarPullRequest | null;
}

/** One project in the sidebar's live view. */
export interface ExperimentalProjectSidebarMenuItem {
  id: string;
  label: string;
  icon?: IconName;
  destructive?: boolean;
  run(): void | Promise<void>;
}

export interface ExperimentalProjectSidebarItem {
  id: string;
  label: string;
  icon: IconName;
  href: string;
  threadId?: string;
  status?: { icon: IconName; label: string };
  indicator?: PluginSidebarThreadIndicator;
  count?: number;
  unread?: boolean;
  children?: readonly ExperimentalProjectSidebarItem[];
  onRename?: (label: string) => void | Promise<void>;
  onReorder?: (orderedChildIds: readonly string[]) => void | Promise<void>;
  onDrop?: (itemId: string) => void | Promise<void>;
  menuItems?: readonly ExperimentalProjectSidebarMenuItem[];
}

export interface ExperimentalProjectSidebarGroup {
  /** Host-stamped owner identity; providers omit this field. */
  key?: string;
  projectId: string;
  items: readonly ExperimentalProjectSidebarItem[];
}

export interface ExperimentalProjectSidebarItemsRegistration {
  id: string;
  useItems(context: {
    projects: readonly PluginSidebarProject[];
  }): readonly ExperimentalProjectSidebarGroup[];
}

export interface PluginSidebarProject {
  id: string;
  name: string;
  /** True for the implicit personal project. */
  isPersonal: boolean;
  /** The app-relative URL of the project's compose screen. */
  href: string;
  /** The app-relative URL of the project's settings page. */
  settingsHref: string;
}

/**
 * One user-named thread section ("Later", "Slop Cop") in the sidebar's live
 * view. A thread belongs to at most one section via `sectionId`; a null
 * `sectionId` means the loose "Threads" bucket. Sections are created,
 * renamed, and deleted through the public API (`threadSections` in the SDK,
 * `omnyo thread section` in the CLI); this state is the read side.
 */
export interface PluginSidebarSection {
  id: string;
  name: string;
  /** Epoch milliseconds. */
  createdAt: number;
  updatedAt: number;
}

/**
 * One chat group: a named, purely visual folder that holds chats from one
 * project. A chat belongs to at most one group via
 * {@link PluginSidebarThread.experimental_groupId}; grouped chats run, ask
 * the owner and appear in the Inbox exactly as ungrouped ones. Create, rename
 * and ungroup through {@link PluginSdkApp.experimental_useThreadGroupActions}
 * (`threadGroups` in the SDK, `omnyo thread group` in the CLI); this is the
 * read side. Experimental: see docs/api_to_audit.md.
 */
export interface PluginSidebarThreadGroup {
  id: string;
  projectId: string;
  name: string;
  /** Epoch milliseconds. */
  createdAt: number;
  updatedAt: number;
}

/**
 * Omnyo's chat group actions (see
 * {@link PluginSdkApp.experimental_useThreadGroupActions}). Each updates the
 * sidebar at once, shows Omnyo's own toasts, and rejects after Omnyo has
 * shown an error toast.
 */
export interface PluginThreadGroupActions {
  /**
   * Put these chats in a new group and clear the selection. Chats outside
   * the first chat's project are left out; Omnyo names the group after the
   * words their titles share. Resolves to the new group's id, or null when
   * no chat could be grouped. The toast offers Undo.
   */
  group(threadIds: readonly string[]): Promise<string | null>;
  rename(groupId: string, name: string): Promise<void>;
  /** Delete the group; its chats stay where they are. The toast offers Undo. */
  ungroup(groupId: string): Promise<void>;
  /** Move one chat into a group of its project, or out of its group with null. */
  move(threadId: string, groupId: string | null): Promise<void>;
}

export interface PluginSidebarThreadsState {
  /** Null when archived threads were not requested. */
  experimental_archived: {
    status: "loading" | "ready" | "error";
    hasNextPage: boolean;
    isFetchingNextPage: boolean;
    isFetchNextPageError: boolean;
    fetchNextPage(): Promise<void>;
  } | null;
  /**
   * Null when shelved threads were not requested. Pages arrive newest
   * shelved first. Experimental: see docs/api_to_audit.md.
   */
  experimental_shelved: PluginSidebarThreadsState["experimental_archived"];
  status: "loading" | "ready" | "error";
  threads: readonly PluginSidebarThread[];
  experimental_hosts?: readonly { id: string; name: string }[];
  projects: readonly PluginSidebarProject[];
  /** Every section, in the server's order (creation order). */
  sections: readonly PluginSidebarSection[];
  /**
   * Every chat group, in creation order. Absent only on hosts that predate
   * groups. Experimental: see docs/api_to_audit.md.
   */
  experimental_groups?: readonly PluginSidebarThreadGroup[];
}

/**
 * The provider directory (see {@link PluginSdkApp.experimental_useProviders}):
 * every registered agent provider in picker order, as the same `ProviderInfo`
 * the host's own pickers read. `logoUrl` is server-relative
 * (`/api/v1/system/providers/<id>/logo`) or null when the provider declared a
 * glyph or no icon; `strings` carries the provider's declared copy.
 */
export interface PluginProvidersState {
  status: "loading" | "ready" | "error";
  providers: readonly ProviderInfo[];
}

/**
 * One TextMate token rule from the active code theme, in the shape VS Code
 * theme files author it.
 */
export interface PluginCodeThemeTokenRule {
  /** Scope(s) the rule paints; absent means the theme's base rule. */
  scope?: string | readonly string[];
  settings: {
    /** `#rrggbb` or `#rrggbbaa`. */
    foreground?: string;
    background?: string;
    /** Space-separated TextMate font styles, e.g. `"bold italic"`. */
    fontStyle?: string;
  };
}

/**
 * The active code theme as a VS Code theme file: the same document Omnyo's own
 * highlighter renders from, so a plugin that embeds a third-party editor can
 * translate it into that editor's theme format rather than guessing colors
 * from CSS variables.
 */
export interface PluginCodeThemeData {
  /** Registered theme name — a bundled Shiki name or an Omnyo-registered id. */
  name: string;
  type: "light" | "dark";
  /** Default editor foreground, as `#rrggbb[aa]`. */
  fg: string;
  /** Default editor background, as `#rrggbb[aa]`. */
  bg: string;
  /** VS Code workbench colors (`editor.background`, `editorCursor.foreground`, …). */
  colors: Readonly<Record<string, string>>;
  tokenColors: readonly PluginCodeThemeTokenRule[];
}

/**
 * The code theme Omnyo is currently rendering with (see
 * {@link PluginSdkApp.experimental_useCodeTheme}). `mode` and `name` change
 * the moment the user switches palette or light/dark; `theme` follows once
 * the theme file resolves, and keeps the previous document until then so a
 * consumer never has to paint an unthemed frame. Compare `theme.name` with
 * `name` to tell a settled state from one still resolving.
 */
export interface PluginCodeThemeState {
  mode: "light" | "dark";
  name: string;
  /** null only before the first theme file resolves. */
  theme: PluginCodeThemeData | null;
}

/**
 * What {@link PluginSdkApp.experimental_copyToClipboard} writes: plain text,
 * plus an HTML representation for paste targets that accept rich text.
 * Without `html`, only plain text is written.
 */
export interface ExperimentalClipboardContent {
  text: string;
  html?: string;
}

export type ExperimentalNativeFileClassification =
  | { kind: "directory"; path: string }
  | { kind: "file"; path?: string }
  | null;

export interface ExperimentalNativeFileResolver {
  /** Classifies disk-backed Files on this desktop client, preserving order. */
  resolve(
    files: readonly File[],
  ): Promise<readonly ExperimentalNativeFileClassification[]>;
}

/**
 * The `threads` area of {@link experimental_PluginBrowserSdk}: Omnyo's public thread API
 * with the calling plugin's identity filled in. `spawn` and `fork` stamp
 * `origin: "plugin"` and `originPluginId` unless the call names another
 * origin, and the plugin-metadata calls default `pluginId`. The same
 * narrowing the backend `api.sdk` applies.
 */
export type PluginBoundThreadsArea = Omit<
  OmnyoSdkAreas["threads"],
  | "getPluginMetadata"
  | "updatePluginMetadata"
  | "experimental_listPluginMetadata"
> & {
  getPluginMetadata(
    args: Omit<ThreadPluginMetadataArgs, "pluginId"> & { pluginId?: string },
  ): Promise<ThreadPluginMetadataResult>;
  experimental_listPluginMetadata(
    args: Omit<PluginThreadMetadataListArgs, "pluginId"> & {
      pluginId?: string;
    },
  ): Promise<PluginThreadMetadataListResult>;
  updatePluginMetadata(
    args: Omit<ThreadPluginMetadataUpdateArgs, "pluginId"> & {
      pluginId?: string;
    },
  ): Promise<ThreadPluginMetadataResult>;
};

/**
 * Omnyo's public API client, bound to the calling plugin, for plugin frontends
 * (see {@link PluginSdkApp.useSdk}). The same areas the `omnyo` CLI and the
 * backend `api.sdk` expose: threads, thread sections, projects, environments,
 * hosts, files, and the rest. Requests carry the signed-in user's session on
 * the app origin, so every call runs with the user's own authority; there
 * is no narrower plugin scope.
 */
export type experimental_PluginBrowserSdk = Omit<OmnyoSdkAreas, "threads"> & {
  threads: PluginBoundThreadsArea;
};

/** Props for {@link PluginSdkApp.ThreadTitle}. */
export interface PluginThreadTitleProps {
  /** A thread in the sidebar's live view; renders nothing for an unknown id. */
  threadId: string;
}

/**
 * Props for {@link PluginSdkApp.experimental_ThreadStatusGlyph}: Omnyo's thread
 * status glyph, the one its own lists draw. The caller resolves the
 * indicator, so a row can fold in state the host does not know about, such
 * as collapsed children or a client-local draft.
 */
export interface PluginThreadStatusGlyphProps {
  /** The indicator to draw; "none" draws nothing unless `rowStatus` shows. */
  indicator: PluginSidebarThreadIndicator;
  /** Draws the archive glyph instead of the indicator. */
  archived?: boolean;
  /**
   * A status another plugin set on the row (see
   * {@link PluginSdkApp.useSidebarThreadRowStatus}). It replaces every
   * indicator except "runtime", "unread-error", and "waiting-for-input".
   */
  rowStatus?: PluginSidebarThreadRowStatus | null;
  /** Hides the idle draft glyph from assistive technology. */
  hideIdleDraftLabel?: boolean;
  /** "compact" draws a 14 px glyph; "default" matches Omnyo's sidebar rows. */
  size?: "default" | "compact";
  /**
   * Running subagents to draw inside the working spinner, such as the row
   * thread's `activity.experimental_subagents`. Zero, absent, or a glyph
   * that is not the working spinner draws the glyph unchanged.
   * Experimental: see docs/api_to_audit.md.
   */
  experimental_subagents?: number;
}

/**
 * One environment provider from Omnyo's catalog (see
 * {@link PluginSdkApp.useEnvironmentProviders}): what a sidebar needs to
 * name and draw the environment a thread runs in. `icon` and `logoUrl` are
 * what `experimental_ProviderIcon` reads with `providerKind: "environment"`.
 */
export interface PluginEnvironmentProvider {
  id: string;
  displayName: string;
  description: string | null;
  icon: string | null;
  logoUrl: string | null;
  /** The plugin that registered the provider. */
  pluginId: string;
  /** The machine provider it runs on, or null for the local machine. */
  machineProviderId: string | null;
}

export interface PluginEnvironmentProvidersState {
  status: "loading" | "ready" | "error";
  providers: readonly PluginEnvironmentProvider[];
}

/**
 * Whether the composer holds unsent text for a thread (see
 * {@link PluginSdkApp.useSidebarThreadDraft}). This is per-client state, so
 * it lives beside `indicator` rather than in it: Omnyo's row paints a pencil for
 * an idle thread with a draft and a "working-draft" glyph for a busy one.
 */
export interface PluginSidebarThreadDraftState {
  hasUnsubmittedDraft: boolean;
}

/**
 * The status another plugin's app-wide script set on a thread's row through
 * the content-script context's `experimental_setThreadRowStatus` (see
 * {@link PluginSdkApp.useSidebarThreadRowStatus}). Omnyo's row draws it in
 * place of the draft glyph while it is set; a replaced list should do the
 * same so a status set by, say, the drafts or workflows plugin does not
 * vanish when the list changes hands.
 */
export type PluginSidebarThreadRowStatus = PluginComposerThreadRowStatus;

/**
 * The jump-to-thread shortcut Omnyo assigned to a row while the app command
 * modifier is held (see {@link PluginSdkApp.useSidebarThreadShortcut}).
 */
export interface PluginSidebarThreadShortcut {
  /** Human-readable key label, e.g. "⌘1", for a pill on the row. */
  label: string;
  /** Value for the row's `aria-keyshortcuts` attribute. */
  ariaKeyshortcuts: string;
}

/**
 * Act on threads from a plugin surface. Every method routes to the host's own
 * flow, so optimistic updates, toasts, dialogs, pane closing, and route repair
 * behave exactly as they do in the built-in sidebar. Unknown thread ids are
 * ignored by `open` and rejected by the rest.
 *
 * @internal Superseded by `app.slots.experimental_threadAction` and
 * `experimental_ThreadActionsMenu`, `useSdk().threads` for data writes, and
 * `experimental_useAppNavigate().toThread` / `toCompose` for navigation; kept for plugins
 * built against older SDKs.
 */
export interface PluginSidebarThreadActions {
  /**
   * Navigate to a thread. `split: true` applies Omnyo's split placement rules —
   * a right split by default, focus when the thread is already open, replace
   * at the pane cap — and falls back to plain navigation where splits are off.
   * Opening also expands the thread's conversation if the secondary panel had
   * collapsed it, as Omnyo's own row does.
   */
  open(threadId: string, options?: { split?: boolean }): void;
  /**
   * Go to the new-thread screen. Passing `projectId` also makes that project
   * the composer's selection, so the thread is created where you asked.
   * `sectionId` files the new thread under that section, and
   * `environmentId` reuses that environment (the "New thread in
   * environment" affordance), both exactly as Omnyo's own list does.
   * `experimental_placement` explicitly selects the section and pin state,
   * overriding `sectionId`. Omitting placement starts unpinned, outside sections
   * unless `sectionId` is supplied; previous composer placement is cleared.
   * `hostId` selects a machine for a new environment when it
   * is known and supports an environment provider. `environmentId` wins when
   * both are supplied.
   */
  openNewThread(options?: {
    projectId?: string;
    sectionId?: string;
    experimental_placement?: { sectionId: string | null; pinned: boolean };
    environmentId?: string;
    hostId?: string;
    focusPrompt?: boolean;
  }): void;
  setPinned(threadId: string, pinned: boolean): Promise<void>;
  setRead(threadId: string, read: boolean): Promise<void>;
  /** Silent rename — no dialog. For inline editing in your own row. */
  rename(threadId: string, title: string): Promise<void>;
  /** Confirms before including child threads unless archive confirmation is disabled in Settings → General. */
  archive(threadId: string): void;
  /** Archives an environment's active thread trees with Omnyo's optimistic updates, pane cleanup, and one Undo toast. Rejects after Omnyo shows an error toast on failure. */
  experimental_archiveEnvironmentThreads(environmentId: string): Promise<void>;
  /**
   * Opens Omnyo's delete confirmation, which counts child threads first. Deletion
   * is destructive and recursive, so the host owns the confirmation: there is
   * deliberately no silent `delete`.
   */
  requestDelete(threadId: string): void;
}

/**
 * Render a plugin component in the thread's header controls.
 *
 * The frontend sibling of the backend `api.ui.registerThreadAction`, which
 * renders a host-owned button and runs server-side. Use that one for "do a
 * thing"; use this one when the control must draw live state.
 *
 * For a single pane on a wide window, the host places it in the window title
 * bar's right cluster, a 40px row, before the open-in-editor button and the
 * right-panel toggle. In split panes, each pane keeps its own 48px header
 * row, with the control before the open-in-editor button, maximize, and
 * close. Both rows hold 28px controls: render one inline control that fits,
 * and put anything taller in a portalled popover. When a narrow pane row runs
 * out of room, the host shrinks and clips the plugin controls horizontally
 * before it touches the thread title or its menu.
 *
 * The header row is a host-owned budget. On phone-width layouts the host
 * omits header actions entirely and keeps only the title, the single thread
 * menu and the right-panel toggle. Register an `experimental_threadAction`
 * for anything that must stay reachable there: it appears in that menu.
 */
export interface PluginThreadHeaderActionRegistration {
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  /**
   * Names the region the host wraps around your component (a labelled group).
   * It does NOT label your control: an icon-only button still needs its own
   * accessible name.
   */
  title: string;
  component: ComponentType<PluginThreadHeaderActionProps>;
}

/**
 * Replace the main pane of every open thread with a plugin component. The
 * thread header, the side panel, split panes, and the compact drawer stay
 * host-rendered.
 *
 * This slot is **exclusive**: at most one registration is active, the first in
 * deterministic slot order (plugins sorted by id, then registration order
 * within a plugin). The component receives every thread; render `defaultView`
 * for threads the plugin does not claim. Omnyo renders its default pane while
 * plugin frontends are still booting, when no plugin registers, and in place
 * of a view that crashes (a crash disables the view for that thread for the
 * session and shows an error toast).
 */
export interface PluginThreadViewRegistration {
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  /** Label shown in capability details and the crash notice. */
  title: string;
  component: ComponentType<PluginThreadViewProps>;
}

export interface ExperimentalPluginBrowserToolbarActionRegistration {
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  /** Accessible name for the host-wrapped control group. */
  title: string;
  /** Component rendered beside the Browser address bar. */
  component: ComponentType<ExperimentalPluginBrowserToolbarActionProps>;
}

/**
 * The thread a thread action is evaluated for: the fields Omnyo's own actions
 * read, copied from the thread payload by the surface that shows the menu.
 */
export interface PluginThreadActionTarget {
  id: string;
  projectId: string;
  parentThreadId: string | null;
  archivedAt: number | null;
  pinnedAt: number | null;
  shelvedAt: number | null;
  sectionId: string | null;
  isUnread: boolean;
  status: ThreadStatus;
  /**
   * The thread's environment when a new thread can reuse it, null otherwise.
   * `path` is the checkout path, null when the environment has none.
   */
  environment: { id: string; path: string | null } | null;
}

/** One row of a thread action's choice list. */
export interface PluginThreadActionChoice {
  id: string;
  label: string;
  icon?: IconName;
  selected?: boolean;
  disabled?: boolean;
}

/**
 * A choice list instead of a direct action: a submenu in desktop menus, a step
 * with Back in the compact drawer, and a popover from a row's quick-action
 * button. `run` receives the picked choice's `id` as `value`.
 */
export interface PluginThreadActionChoices {
  /**
   * Title of the drawer step and the quick-action popover; defaults to the
   * action's label. Desktop submenus show none: their trigger names them.
   */
  heading?: string;
  /** Footnote below the choices, e.g. why the current value differs from the pick. */
  hint?: string;
  items: readonly PluginThreadActionChoice[];
}

/** What a thread action's `run` receives. */
export interface PluginThreadActionRunInput {
  /** The picked choice's `id` when the action has `choices`; otherwise undefined. */
  value?: string;
  /**
   * Start renaming a thread with the editor of the surface that showed the
   * menu: inline in the sidebar row or thread header, Omnyo's rename dialog
   * elsewhere.
   */
  requestRename(threadId: string): void;
}

/** One evaluated thread action: what a registration shows for one thread. */
export interface PluginThreadAction {
  label: string;
  /**
   * Short secondary text on a muted second line under the label, e.g. the
   * current value of a choice list.
   */
  detail?: string;
  icon: IconName;
  variant?: "default" | "destructive";
  disabled?: boolean;
  choices?: PluginThreadActionChoices;
  /**
   * Runs when the user activates the action or picks a choice. Errors (sync
   * or async) are contained and logged; they never break the menu.
   */
  run(input: PluginThreadActionRunInput): void | Promise<void>;
}

/** What a registration's `useData` receives. */
export interface PluginThreadActionDataInput {
  /**
   * Every thread a visible surface currently shows actions for (sidebar rows
   * on screen, the open thread's header, open menus); a hidden sidebar
   * contributes none. Sorted, deduplicated, and published once the set has
   * been quiet for 32 ms (at most 100 ms after the first change), so rows
   * that mount a frame apart arrive together. Load per-thread state for these
   * ids, fetching only ids not loaded yet.
   */
  threadIds: readonly string[];
}

/** What a registration's `item` receives for each thread it is shown for. */
export interface PluginThreadActionItemInput<Data> {
  thread: PluginThreadActionTarget;
  /** What `useData` last returned; undefined when the registration has none. */
  data: Data;
  /** The registering plugin's `useSdk()` client. */
  sdk: experimental_PluginBrowserSdk;
  /**
   * The registering plugin's `experimental_useAppNavigate()`. Thread menus are not inside a
   * side panel, so `openThreadPanel` opens in the focused thread view, as
   * plugin commands do, and returns false when no thread view is open.
   */
  navigate: experimental_AppNavigate;
}

/**
 * Add an action to every thread actions menu: the thread header's menu, the
 * sidebar row's menu and right-click menu, the compact long-press drawer, and,
 * when the user picks it, a sidebar row's quick-action buttons. Omnyo's own
 * actions (Open in split, Copy thread link, Mark read, Pin, Rename, Archive,
 * Delete, …) are registrations of this same shape.
 *
 * `useData` is a React hook the host calls once for the whole app, never per
 * thread or per menu; read app-wide state there (preferences, a realtime
 * channel, per-thread state for the `threadIds` it receives, fetched in one
 * batch for the ids not loaded yet). `item` is pure and synchronous: it
 * derives the action for one thread from that thread and `data`, closing over
 * everything `run` needs, or returns null to hide it. A throw from either
 * drops only this registration.
 */
export interface PluginThreadActionRegistration<Data = undefined> {
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  /** Static name, shown where the user picks a row's quick actions. */
  title: string;
  /** Static icon for that picker; the evaluated action's `icon` wins in menus. */
  icon: IconName;
  /**
   * Menus and the quick-action picker sort by `group` (string compare) with a
   * separator between groups, then by `order` within a group (unset sorts
   * last), then by registration order. Omnyo's groups are
   * {@link PluginSdkApp.experimental_THREAD_ACTION_GROUPS}; any other string
   * is a group of its own, placed where it sorts.
   */
  group: string;
  order?: number;
  useData?(input: PluginThreadActionDataInput): Data;
  item(input: PluginThreadActionItemInput<Data>): PluginThreadAction | null;
}

/**
 * A thread action as {@link PluginSdkApp.experimental_useThreadActions}
 * returns it: `run` is bound to the caller's `requestRename` (or Omnyo's rename
 * dialog), contains errors, and resolves when the action settles.
 */
export interface PluginBoundThreadAction extends Omit<
  PluginThreadAction,
  "run"
> {
  /** `value` is the picked choice's `id` for an action with `choices`. */
  run(value?: string): Promise<void>;
}

/**
 * One row of {@link PluginSdkApp.experimental_useThreadActions}: `key` is
 * `<owner>/<id>`, where the owner is the registering plugin's id or
 * `omnyo--core` for Omnyo's own actions.
 */
export interface PluginThreadActionEntry {
  key: string;
  pluginId: string;
  /** The registration's group, for separators in a caller's own list. */
  group: string;
  action: PluginBoundThreadAction;
}

/** One row of {@link PluginSdkApp.experimental_useThreadActionRegistrations}. */
export interface PluginThreadActionRegistrationInfo {
  key: string;
  pluginId: string;
  title: string;
  icon: IconName;
}

/** Options for {@link PluginSdkApp.experimental_useThreadActions}. */
export interface PluginThreadActionsOptions {
  /** Return only these keys, in this order. Omit for every action in menu order. */
  keys?: readonly string[];
  /**
   * The surface's own rename editor, passed to `run` as `requestRename`.
   * Omit to use Omnyo's rename dialog.
   */
  requestRename?(threadId: string): void;
}

/**
 * An action a surface adds to its own copy of the thread menu, not a
 * registration: appended to the end of its `group`. `key` must be unique in
 * the menu.
 */
export interface PluginThreadActionsInlineItem {
  key: string;
  group: string;
  action: PluginThreadAction;
}

/**
 * What a thread menu's `trigger` receives: the menu's ARIA state, event
 * handlers, and ref. Spread all of them onto the button you render (compose
 * your own handlers after calling theirs); a trigger that drops them never
 * opens the menu.
 */
export type PluginThreadActionsTriggerProps = ComponentPropsWithRef<"button">;

interface PluginThreadActionsMenuBaseProps {
  thread: PluginThreadActionTarget;
  inline?: readonly PluginThreadActionsInlineItem[];
  /** See {@link PluginThreadActionsOptions.requestRename}. */
  requestRename?(threadId: string): void;
  onOpenChange?(open: boolean): void;
  /** Radix's close auto-focus hook, to restore focus to the surface's own control. */
  onCloseAutoFocus?(event: Event): void;
}

/**
 * Props of the host-owned `experimental_ThreadActionsMenu`: Omnyo's thread menu
 * opened from the button `trigger` renders (see
 * {@link PluginThreadActionsTriggerProps}), a drawer at compact width.
 */
export interface PluginThreadActionsMenuProps extends PluginThreadActionsMenuBaseProps {
  trigger(props: PluginThreadActionsTriggerProps): ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  sideOffset?: number;
}

/**
 * Props of the host-owned `experimental_ThreadActionsContextMenu`: Omnyo's thread
 * menu on right-click of `children`, or on touch long-press at compact width.
 */
export interface PluginThreadActionsContextMenuProps extends PluginThreadActionsMenuBaseProps {
  children: ReactNode;
  /** Suppresses the menu, e.g. while the row edits its title. */
  disabled?: boolean;
  /** Closes the menu and suppresses opening while the row is being dragged. */
  dragging?: boolean;
}

/** One pane's place in the split layout, as fractions of the split area. */
export interface PluginSidebarSplitPane {
  paneId: string;
  rect: { x: number; y: number; width: number; height: number };
  /** This pane holds the thread the row represents. */
  isMe: boolean;
  isFocused: boolean;
}

/**
 * The whole split layout (see {@link PluginSdkApp.useSidebarSplitLayout}):
 * every pane with its rect as fractions of the split area and the thread it
 * shows, or null when there is no split (a single pane, a compact viewport,
 * or splits disabled). Use it for group rollups, a collapsed section that
 * should show where its threads are open; a row wants
 * `experimental_useSidebarThreadSplit` instead.
 */
export interface PluginSidebarSplitLayout {
  panes: readonly {
    paneId: string;
    rect: { x: number; y: number; width: number; height: number };
    /** The thread this pane shows, or null for non-thread content. */
    threadId: string | null;
    isFocused: boolean;
  }[];
}

/**
 * Drag-to-split support for one row, plus where that thread currently sits in
 * the split layout.
 */
export interface PluginSidebarThreadSplit {
  /**
   * Spread onto the row's interactive element. Carries the pointer handler
   * that starts a split drag; empty when splits are unavailable, so spreading
   * it is always safe.
   *
   * The host owns every rule: the gesture engages only once the pointer leaves
   * the sidebar toward the main area (so a list with its own drag-to-reorder
   * keeps working), an edge drop splits, a center drop replaces, an
   * already-open thread focuses its pane, and the pane cap coerces a split
   * into a replace.
   */
  splitProps: {
    onPointerDown?: (event: import("react").PointerEvent<HTMLElement>) => void;
  };
  /**
   * False on compact viewports, when the user disabled splits, and for an
   * unknown thread id. Gate any "open in split" affordance you draw on it.
   */
  isAvailable: boolean;
  /**
   * Where this thread sits in the split layout, or null when it is not open in
   * one (including single-pane layouts). Draw a mini-map, a tint, or nothing.
   */
  layout: { panes: readonly PluginSidebarSplitPane[] } | null;
}

/**
 * Replace the sidebar's thread list with a plugin component.
 *
 * Unlike every other slot, this one is EXCLUSIVE: two lists cannot share one
 * scroll area. Omnyo ships its own list as the bundled Thread list plugin
 * (`thread-list/thread-list`). Registering activates the replacement while the
 * plugin is enabled: by default the first registered list other than the
 * bundled one, in deterministic slot order, is active, falling back to the
 * bundled list; removing it reveals the next. The user can pin a specific
 * provider, including the bundled one, under Settings → Appearance → Sidebar.
 * A missing pinned provider or a crashing list shows a placeholder rather than
 * leaving the user with no sidebar.
 *
 * The plugin gets the scrolling list and nothing else. The New-thread button,
 * the search action, the plugin nav rows, and the footer stay host-rendered in
 * every sidebar — they are shared surfaces (other plugins live in two of
 * them), and a replaced list must not be able to remove them.
 */
export interface PluginThreadListRegistration {
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  /** Label shown in Settings → Appearance and capability details. */
  title: string;
  /** Optional one-line description shown with the provider choice. */
  description?: string;
  component: ComponentType<PluginThreadListProps>;
}

/**
 * Register this plugin as a viewer/editor for file extensions. By default,
 * matching files render the first applicable opener in deterministic slot
 * order. The user can pin Omnyo's preview or a specific opener per extension
 * under Settings → Files. The file tab's "Open with" menu can override that
 * choice for one open. A plugin can also use its own setting and render
 * `Original` conditionally. Applies to working-tree, host, and
 * thread-storage files — never to git-ref snapshots (diff views always use
 * Omnyo's preview).
 */
export interface PluginFileOpenerRegistration {
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  /** Label in the "Open with" menu (e.g. "Notes editor"). */
  title: string;
  /** Lowercase alphanumeric extensions without the dot; single underscores or hyphens may separate segments. */
  extensions: readonly string[];
  component: ComponentType<PluginFileOpenerProps>;
}

/**
 * Replace Omnyo's source-code renderer everywhere it renders supplied source
 * text — the native file preview and every plugin that calls
 * `experimental_SourceCode`. Like `experimental_threadList` this slot is
 * **exclusive**: one renderer at a time. Registering activates it while the
 * plugin is enabled; if several are registered the first in deterministic slot
 * order wins. A missing, disabled, or crashing replacement falls back to Omnyo's
 * renderer, and a replacement can render `Original` to delegate
 * per call (behind its own setting, by language, by size — whatever it needs).
 */
export interface PluginSourceCodeRendererRegistration {
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  /** Label shown in capability details. */
  title: string;
  /** Optional one-line description shown with the provider choice. */
  description?: string;
  component: ComponentType<PluginSourceCodeRendererProps>;
}

/**
 * Replace Omnyo's diff renderer everywhere it renders supplied diff content — the
 * timeline file diffs, the environment diff panel's text bodies, and every
 * plugin that calls `experimental_Diff`. Exclusive, with the same activation,
 * fallback, and `Original` delegation rules as
 * {@link PluginSourceCodeRendererRegistration}.
 */
export interface PluginDiffRendererRegistration {
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  /** Label shown in capability details. */
  title: string;
  /** Optional one-line description shown with the provider choice. */
  description?: string;
  component: ComponentType<PluginDiffRendererProps>;
}

/**
 * Register a leaf message directive rendered inside user, assistant, and nested
 * agent message Markdown. Complete registered directives render in prose,
 * including after text on the same line. Fenced examples remain code.
 * `id` is the directive name: `inline-vis` matches
 * `::inline-vis{file="demo.html"}`.
 */
export interface PluginMessageDirectiveRegistration {
  /**
   * The directive name. Lowercase kebab-case beginning with a letter.
   */
  id: string;
  component: ComponentType<PluginMessageDirectiveProps>;
}

/**
 * Render fenced code blocks of chosen languages inside assistant (and nested
 * agent) message Markdown. ` ```ui ` matches a registration whose `languages`
 * include `"ui"`. Fences elsewhere (user messages, file previews, plugin
 * Markdown) keep Omnyo's code block.
 *
 * Omnyo's code block also renders when two plugins claim the same language (Omnyo
 * logs a warning naming them), when the plugin is disabled, and for a fence
 * whose component throws. A throw affects that fence only, and Omnyo tries the
 * component again when the fence's `code` or `status` changes.
 *
 * @experimental Audit before relying on this as a stable contract.
 */
export interface ExperimentalCodeFenceRendererRegistration {
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  /**
   * Lowercase info-string languages, e.g. `["ui", "app"]`. Each starts with a
   * letter or digit and contains only `a-z`, `0-9`, `+`, `#`, `.`, `_`, `-`.
   * A language may be claimed once per plugin.
   */
  languages: readonly string[];
  component: ComponentType<ExperimentalCodeFenceRendererProps>;
}

/**
 * A narrow, stable reference to one rendered chat message — NOT an internal
 * timeline row. `sourceSeqEnd` is the last source event sequence the message
 * covers, the anchor the server accepts for provider-history forks.
 */
export interface ThreadChatMessageReference {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  /** Visible text of the message. */
  text: string;
  sourceSeqEnd: number;
  /**
   * The event sequence that recorded this message: the `msg` value of a
   * message link and the seq that `sdk.threads.message` and
   * `omnyo thread log --message` read. For a steer this is its request sequence,
   * which can differ from the acceptance sequence in `sourceSeqEnd`.
   */
  experimental_messageSeq: number;
}

/**
 * What a caller that is *not* itself a panel action passes to open one — a
 * `messageAction`'s `run`, or any component via `experimental_useAppNavigate()`. A panel
 * action opening its own tab is already the target, so it passes the bare
 * {@link PluginPanelActionOpenOptions} instead.
 */
export interface PluginTargetedPanelActionOpenOptions extends PluginPanelActionOpenOptions {
  /** A `threadPanelAction` id registered by this same plugin. */
  actionId: string;
}

/** Context handed to a `messageAction`'s `run`. */
export interface PluginMessageActionContext {
  /** The thread whose timeline surfaced the action. */
  threadId: string;
  message: ThreadChatMessageReference;
  /**
   * Present only when the action was invoked from the text-selection menu;
   * the exact text the user highlighted inside `message`.
   */
  selectedText?: string;
  /**
   * Open one of this plugin's `threadPanelAction` components in the current
   * thread's side panel — the registration-callback equivalent of
   * `experimental_useAppNavigate().openThreadPanel`.
   *
   * Returns true when the host accepted the open; false when it declined —
   * `params` was not a JSON value, the action id names no `threadPanelAction`
   * of this plugin, or the surface has no side panel (only the main thread
   * view does; a `ThreadChat` embedded in a plugin panel does not). A decline
   * is never thrown: the host logs it and reports it here.
   */
  openPanel(options: PluginTargetedPanelActionOpenOptions): boolean;
  /**
   * The composer of the thread the message is in, or null when that thread's
   * composer is not available on this surface. The same handle
   * `useComposer()` returns there.
   */
  composer: PluginComposerApi | null;
}

/**
 * An action on chat messages in the main thread timeline: an entry in the
 * per-message action menu (user and assistant messages) and in the
 * assistant-message text-selection menu. The message action menu is an icon
 * row revealed on hover or keyboard focus with a fine pointer, and a sheet
 * opened by a long press on the message with a touch pointer. Embedded `ThreadChat` timelines
 * do not show slot-registered actions. Host-rendered chrome — the plugin
 * supplies title, icon, and `run` behavior only. Resolved icon names take precedence over
 * plugin branding; omitted or unknown names fall back to branding.
 */
export interface PluginMessageActionRegistration {
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  /** Tooltip / menu label for the action. */
  title: string;
  icon?: IconName;
  /**
   * Runs when the user activates the action. Errors (sync or async) are
   * contained and logged; they never break the timeline.
   */
  run(context: PluginMessageActionContext): void | Promise<void>;
}

/** Current context for palette and keyboard command invocations. */
export interface PluginCommandContext {
  /** The thread in view, or null on a surface without one. */
  threadId: string | null;
  projectId: string | null;
  /**
   * Open one of this plugin's panel components in the focused side panel.
   * In a thread, `actionId` resolves against `threadPanelAction`; on the New
   * thread screen, it resolves against `experimental_newThreadPanelAction`.
   * Register both slots with the same id to support commands on both screens.
   *
   * Returns true when the host accepted the open; false when it declined —
   * `params` was not a JSON value, the action id names no matching panel action
   * of this plugin on the focused surface, or the surface has no side panel.
   * The palette opens anywhere, so guard with `isAvailable` rather than assuming.
   */
  openPanel(options: PluginTargetedPanelActionOpenOptions): boolean;
}

/** A default keyboard shortcut. Omitted modifiers are false. */
export interface PluginCommandShortcut {
  key: string;
  /** Command on macOS, Control elsewhere. */
  mod?: boolean;
  meta?: boolean;
  control?: boolean;
  alt?: boolean;
  shift?: boolean;
}

/**
 * A command registered with `app.commands.register`, listed in Omnyo's quick
 * palette (Mod+Shift+P) under the plugin's name
 * beside Omnyo's own commands. Host-rendered: the plugin supplies a title and
 * `run`, and the host owns matching, ordering, and recency.
 */
export interface PluginCommandRegistration {
  /** Initial keyboard binding. Users can rebind every command, including ones without a default. Conflicting defaults remain unbound. */
  defaultShortcut?: PluginCommandShortcut;
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  /** The row's label, e.g. "Linear: open issue for this thread". */
  title: string;
  /**
   * Hide the row when it cannot do anything — typically when it needs a thread
   * and there is none. Called before palette listing and keyboard invocation;
   * keep it cheap and synchronous. Omitted means always listed.
   */
  isAvailable?(context: PluginCommandContext): boolean;
  /**
   * Runs on keyboard invocation, or after the palette closes and focus is
   * restored. Errors (sync or async) are contained and logged; they never break the palette.
   */
  run(context: PluginCommandContext): void | Promise<void>;
}

/**
 * A command handled by a composer through the same path as Omnyo's own "Focus
 * composer" command. Listed, rebindable and namespaced like any other plugin
 * command. The composer holding the caret runs it; with the caret outside every
 * composer, the focused pane's primary composer does. Like Omnyo's composer
 * commands, its shortcut is inactive while a terminal, browser tab or modal has
 * focus, and the palette lists it only when some composer would run it.
 */
export interface ExperimentalComposerCommandRegistration {
  /** Initial keyboard binding. Users can rebind every command, including ones without a default. Conflicting defaults remain unbound. */
  defaultShortcut?: PluginCommandShortcut;
  /** Unique within the plugin across every command; letters, digits, `-`, `_`. */
  id: string;
  /** The palette row's and keyboard settings' label. */
  title: string;
  /**
   * Runs with the handling composer, bound to this plugin like `useComposer()`.
   * Errors (sync or async) are contained and logged.
   */
  run(context: { composer: PluginComposerApi }): void | Promise<void>;
}

/** Registers commands for Omnyo's command palette. */
export interface PluginAppCommands {
  /** Register a command. IDs are unique within this plugin, including legacy slot registrations. */
  register(registration: PluginCommandRegistration): void;
}

/**
 * Supply an inline React mark for a provider. Agent, machine, and environment
 * icon renderers select the mark by provider kind and id.
 * Only surfaces using the provider icon renderer consult this slot. Persistent
 * machine labels use a laptop glyph directly.
 *
 * Provider logo assets use a currentColor mask. Inline components can also
 * render multiple colors and inherit the app's theme and sizing classes.
 *
 * The host passes `className` for sizing; color inherits from its wrapper.
 * the component must render an inline SVG (or other inline markup) and must
 * not fetch. One registration per provider kind and id per plugin; when two
 * plugins claim the same pair the host keeps the first by plugin id and warns.
 */
export interface PluginProviderIconRegistration {
  providerKind: "agent" | "machine" | "environment";
  /**
   * The provider this mark is for — the id Omnyo knows the provider by (the
   * provider declaration's id, e.g. `codex` or `acp-cursor`), not the plugin
   * id. Letters, digits, `-`, `_`.
   */
  providerId: string;
  /** Inline, theme-aware mark. Receives the host's sizing/color className. */
  icon: ComponentType<{ className?: string }>;
}

/**
 * The declarative presentation persisted with a timeline item (docs/
 * provider-plugin-api.md §3): what every client renders when no plugin code
 * is present. A renderer receives it so it can reuse the bridge's label,
 * glyph and tint instead of re-deriving them from the payload.
 */
export interface PluginTimelineRowPresentation {
  label: { pending: string; completed: string };
  icon: { glyph: string };
  title?: string;
  /** Short Markdown, length-capped at ingest. */
  detail?: string;
  suppress?: boolean;
  tint?: { light: string; dark: string };
}

export type PluginTimelineRowStatus =
  | "pending"
  | "completed"
  | "error"
  | "interrupted";

/** The projected row a `experimental_timelineRenderer` component receives. */
export interface PluginTimelineRendererRow {
  id: string;
  threadId: string;
  turnId: string | null;
  /**
   * The item kind the renderer registered for: this plugin's extension kind
   * (`"<pluginId>/<name>"`) or `"tool"` for a generic tool item.
   */
  kind: string;
  /** The tool name for a `"tool"` row; null for an extension row. */
  toolName: string | null;
  status: PluginTimelineRowStatus;
  startedAt: number;
  completedAt: number | null;
}

export interface PluginTimelineRendererProps {
  row: PluginTimelineRendererRow;
  /**
   * The item's data: an extension item's payload (validated against the
   * plugin's declared schema at ingest), or for a `"tool"` row the call's
   * `{ arguments, output }`.
   */
  payload: JsonValue;
  /**
   * The bridge's presentation for the row. Null only for a generic tool row
   * persisted before bridges attached presentation (grammar v2); an
   * extension row always has one.
   */
  presentation: PluginTimelineRowPresentation | null;
  /** The thread the row belongs to. */
  thread: { id: string; providerId: string | null };
  /**
   * The host's declarative base for this row's body (the presentation's
   * `detail`, or the tool call's arguments and output). Render it to keep
   * the default body beside the plugin's own content.
   */
  Original: ComponentType<Record<never, never>>;
}

/**
 * Render the expanded body of the timeline rows this plugin owns: its own
 * extension item kinds (`"<pluginId>/<name>"`, where `<pluginId>` is this
 * plugin), and `"tool"` for the generic tool items of the providers this
 * plugin registered. Core kinds (message, command, fileChange, fileRead,
 * search, delegation, planSteps, …) always use the core renderers and are
 * customized through the bridge's presentation alone.
 *
 * The row's header — the bridge's label, glyph, tint and headline — stays
 * host-rendered so the timeline reads uniformly; the component owns the
 * body. When no renderer is registered for a kind (the plugin is not loaded,
 * uninstalled, or never shipped an app bundle) the declarative base renders
 * instead, so a row never goes blank. Crashes are contained per row.
 */
export interface PluginTimelineRendererRegistration {
  /**
   * `"<pluginId>/<name>"` for one of this plugin's extension kinds, or
   * `"tool"` for the generic tool items of this plugin's providers.
   */
  kind: string;
  component: ComponentType<PluginTimelineRendererProps>;
}

/**
 * Props passed to an `experimental_environmentProviderInputs` component — the
 * control the New Thread environment picker renders beside this plugin's
 * selected environment provider, for the provider's declared `inputs`.
 */
export interface PluginEnvironmentProviderInputsProps {
  /** Project selected in the composer; null in projectless compose. */
  projectId: string | null;
  /** Whether setup uses an existing host or provisions a new host before create. */
  target: { kind: "existing-host"; hostId: string } | { kind: "new-host" };
  /**
   * The `inputs` value the selection will carry: null until `onChange`
   * supplies one.
   * The server parses it with the provider's `inputs` schema at create time,
   * so the component only has to produce a value that schema accepts.
   */
  value: JsonValue | null;
  /**
   * Replace the inputs that will be submitted or block submission with the
   * reason the control should show.
   */
  onChange(next: PluginEnvironmentProviderInputsChange): void;
}

export type PluginEnvironmentProviderInputsChange =
  | { status: "ready"; value: JsonValue }
  | { status: "blocked"; reason: string };

/**
 * Supply the control for one of this plugin's environment providers that
 * declared `inputs` (registered server-side via
 * `api.experimental_environments.register`). The New Thread environment picker
 * renders the component beside the picker while that provider is selected and
 * submits the component's latest `onChange` value as the selection's `inputs`.
 * A provider whose schema rejects empty inputs cannot be submitted without a
 * registration that reports ready inputs.
 */
export interface PluginEnvironmentProviderInputsRegistration {
  /** The environment provider id this control supplies inputs for. */
  environmentProviderId: string;
  component: ComponentType<PluginEnvironmentProviderInputsProps>;
}

/**
 * Props passed to an `experimental_machineProviderInputs` component. Machine
 * inputs are persisted and readable by every plugin, so they must contain only
 * non-secret configuration and references to credentials held in plugin
 * settings.
 */
export interface PluginMachineProviderInputsProps {
  /** The value persisted with the machine selection. */
  value: JsonValue | null;
  /** Replace the submitted value or block submission with a visible reason. */
  onChange(next: PluginMachineProviderInputsChange): void;
}

export type PluginMachineProviderInputsChange =
  | { status: "ready"; value: JsonValue }
  | { status: "blocked"; reason: string };

/**
 * Supply the inputs control for one machine provider registered server-side
 * through `api.experimental_machines.register`.
 */
export interface PluginMachineProviderInputsRegistration {
  /** The machine provider id this control supplies inputs for. */
  machineProviderId: string;
  component: ComponentType<PluginMachineProviderInputsProps>;
}

// ---------------------------------------------------------------------------
// definePluginApp
// ---------------------------------------------------------------------------

export interface PluginAppSlots {
  /** Add project navigation data under the registering plugin context. Experimental: see docs/api_to_audit.md. */
  experimental_projectSidebarItems(
    registration: ExperimentalProjectSidebarItemsRegistration,
  ): void;
  homepageSection(registration: PluginHomepageSectionRegistration): void;
  settingsSection(registration: PluginSettingsSectionRegistration): void;
  /**
   * Render one app-wide overlay component (see
   * {@link ExperimentalAppOverlayRegistration}). Experimental: see
   * docs/api_to_audit.md.
   */
  experimental_appOverlay(
    registration: ExperimentalAppOverlayRegistration,
  ): void;
  /**
   * Render an additive footer card (see
   * {@link ExperimentalSidebarFooterCardRegistration}). Experimental: see
   * docs/api_to_audit.md.
   */
  experimental_sidebarFooterCard(
    registration: ExperimentalSidebarFooterCardRegistration,
  ): void;
  /**
   * Render an additive component in the top rail's center column (see
   * {@link ExperimentalTitleBarCenterRegistration}). Experimental: see
   * docs/api_to_audit.md.
   */
  experimental_titleBarCenter(
    registration: ExperimentalTitleBarCenterRegistration,
  ): void;
  /**
   * Add a labeled row under "New thread" that opens one of this plugin's
   * pages (see {@link ExperimentalSidebarEntryRegistration}). Experimental:
   * see docs/api_to_audit.md.
   */
  experimental_sidebarEntry(
    registration: ExperimentalSidebarEntryRegistration,
  ): void;
  navPanel(registration: PluginNavPanelRegistration): void;
  /**
   * Add an action to an existing thread's panel launcher. This slot is
   * thread-only; use `experimental_newThreadPanelAction` for root compose.
   */
  threadPanelAction(registration: PluginThreadPanelActionRegistration): void;
  /**
   * Add an action to the root New thread screen's panel launcher (see
   * {@link PluginNewThreadPanelActionRegistration}). Experimental: see
   * docs/api_to_audit.md.
   */
  experimental_newThreadPanelAction(
    registration: PluginNewThreadPanelActionRegistration,
  ): void;
  pendingInteraction(registration: PluginPendingInteractionRegistration): void;
  sidebarFooterAction(
    registration: PluginSidebarFooterActionRegistration,
  ): void;
  /**
   * Replace the sidebar's thread list (see
   * {@link PluginThreadListRegistration}). Experimental: see
   * docs/api_to_audit.md for what to audit before the prefix drops.
   */
  experimental_threadList(registration: PluginThreadListRegistration): void;
  /**
   * Render a component in the thread's header controls (see
   * {@link PluginThreadHeaderActionRegistration}). Experimental: see
   * docs/api_to_audit.md.
   */
  experimental_threadHeaderAction(
    registration: PluginThreadHeaderActionRegistration,
  ): void;
  /**
   * Show a live companion beside the open thread, in the title bar, or above
   * the composer, as the host decides (see
   * {@link ExperimentalThreadCompanionRegistration}). Experimental: see
   * docs/api_to_audit.md.
   */
  experimental_threadCompanion(
    registration: ExperimentalThreadCompanionRegistration,
  ): void;
  /**
   * Replace an open thread's main pane, below its header (see
   * {@link PluginThreadViewRegistration}). Exclusive: only the first
   * registration in plugin-id order is active. Experimental: see
   * docs/api_to_audit.md.
   */
  experimental_threadView(registration: PluginThreadViewRegistration): void;
  /**
   * Add an action to every thread actions menu (see
   * {@link PluginThreadActionRegistration}). Experimental: see
   * docs/api_to_audit.md.
   */
  experimental_threadAction<Data = undefined>(
    registration: PluginThreadActionRegistration<Data>,
  ): void;
  /** Render a component beside each Browser tab's address bar. */
  experimental_browserToolbarAction(
    registration: ExperimentalPluginBrowserToolbarActionRegistration,
  ): void;
  fileOpener(registration: PluginFileOpenerRegistration): void;
  /**
   * Replace Omnyo's source-code renderer (see
   * {@link PluginSourceCodeRendererRegistration}). Experimental: see
   * docs/api_to_audit.md.
   */
  experimental_sourceCodeRenderer(
    registration: PluginSourceCodeRendererRegistration,
  ): void;
  /**
   * Replace Omnyo's diff renderer (see
   * {@link PluginDiffRendererRegistration}). Experimental: see
   * docs/api_to_audit.md.
   */
  experimental_diffRenderer(registration: PluginDiffRendererRegistration): void;
  messageDirective(registration: PluginMessageDirectiveRegistration): void;
  /**
   * Render fenced code blocks of chosen languages in assistant messages (see
   * {@link ExperimentalCodeFenceRendererRegistration}). Experimental: see
   * docs/api_to_audit.md.
   */
  experimental_codeFenceRenderer(
    registration: ExperimentalCodeFenceRendererRegistration,
  ): void;
  messageAction(registration: PluginMessageActionRegistration): void;
  /**
   * @deprecated Use `app.commands.register` with the same registration.
   * Both entry points share the same command registry and ID namespace.
   */
  commandPaletteAction(registration: PluginCommandRegistration): void;
  /**
   * Draw one agent, environment, or machine provider's icon with an inline
   * React component instead of its masked logo asset (see
   * {@link PluginProviderIconRegistration}). Experimental: see
   * docs/api_to_audit.md.
   */
  experimental_providerIcon(registration: PluginProviderIconRegistration): void;
  /**
   * Render the body of this plugin's own timeline rows: its extension kinds
   * and its providers' generic tool items (see
   * {@link PluginTimelineRendererRegistration}). Experimental: see
   * docs/api_to_audit.md.
   */
  experimental_timelineRenderer(
    registration: PluginTimelineRendererRegistration,
  ): void;
  /**
   * Supply the inputs control the New Thread environment picker renders
   * beside one of this plugin's selected environment providers (see
   * {@link PluginEnvironmentProviderInputsRegistration}). Experimental:
   * see docs/api_to_audit.md.
   */
  experimental_environmentProviderInputs(
    registration: PluginEnvironmentProviderInputsRegistration,
  ): void;
  /**
   * Supply the non-secret machine inputs control rendered by machine creation
   * surfaces (see {@link PluginMachineProviderInputsRegistration}).
   * Experimental: see docs/api_to_audit.md.
   */
  experimental_machineProviderInputs(
    registration: PluginMachineProviderInputsRegistration,
  ): void;
}

export interface PluginAppComposer {
  customize(registration: ComposerCustomization): void;
  /** Register a command that the composer holding the caret runs. IDs share the `app.commands` namespace. */
  experimental_registerCommand(
    registration: ExperimentalComposerCommandRegistration,
  ): void;
}

export interface ExperimentalThreadRowSubtitle {
  /** Plain text, trimmed with whitespace collapsed, at most 140 characters. */
  text: string;
}

/** Stable lifecycle values for one content-script instance in one Omnyo client. */
export interface PluginContentScriptContext {
  /** The id of the plugin that owns this script. */
  readonly pluginId: string;
  /** Monotonic per-client generation, starting at 1. */
  readonly generation: number;
  /** Aborted before cleanup begins on replacement, deactivation, or teardown. */
  readonly signal: AbortSignal;
  /**
   * Persistently decorate any thread row for this plugin generation.
   *
   * The status is owned by the frontend generation and therefore survives
   * route changes. Passing `null` clears the plugin's status for that thread.
   * The host clears every remaining status when the frontend generation
   * deactivates.
   *
   * Optional so bundles can feature-detect support while this experimental
   * surface rolls out across 0.x clients.
   */
  readonly experimental_setThreadRowStatus?: (
    threadId: string,
    status: PluginComposerThreadRowStatus | null,
  ) => void;
  /**
   * Decorate a sidebar row with plain text for this frontend generation.
   * The first active owner wins; null clears this generation's value.
   * Blank or overlength text is rejected. Deactivation clears owned values.
   * Optional for compatibility with hosts that predate this experimental API.
   */
  readonly experimental_setThreadRowSubtitle?: (
    threadId: string,
    subtitle: ExperimentalThreadRowSubtitle | null,
  ) => void;
}

/** Cleanup returned by a frontend content script. */
export type PluginContentScriptDisposer = () => void | Promise<void>;

/**
 * Trusted same-origin JavaScript/TypeScript mounted once per active frontend
 * generation in each Omnyo app window or browser tab.
 */
export interface PluginContentScriptRegistration {
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  /**
   * Install behavior into the Omnyo app shell. The host awaits a returned
   * promise, retains the plugin's imported frontend stylesheet for this
   * generation, contains failures, and calls the returned disposer exactly
   * once. Styling or decorating existing app-shell DOM belongs here rather
   * than in an always-on frontend stylesheet.
   */
  mount(
    context: PluginContentScriptContext,
  ):
    | void
    | PluginContentScriptDisposer
    | Promise<void | PluginContentScriptDisposer>;
}

/** Lifecycle surface for trusted frontend content scripts. */
export interface PluginAppContentScripts {
  register(registration: PluginContentScriptRegistration): void;
}

export interface ExperimentalIconProps {
  name: string;
  /** Used when the requested name is missing; defaults to the host Zap icon. */
  fallback?: string;
  className?: string;
  style?: CSSProperties;
  "aria-hidden"?: boolean | "true" | "false";
  "aria-label"?: string;
}

/** Shared agent, machine, or environment artwork without fetching metadata. */
export interface ExperimentalProjectIconProps {
  /** A project id from the sidebar's live view, including the personal project. */
  projectId: string;
  /** Sizes and shapes the decorative mark; the face fills it and inherits font size. */
  className?: string;
  style?: CSSProperties;
}

export interface ExperimentalProviderIconProps {
  /** Keeps same-id agent, machine, and environment providers distinct. */
  providerKind: PluginProviderIconRegistration["providerKind"];
  /**
   * Existing agent, machine, or environment provider record. Reads id, logoUrl, icon and
   * strings.iconTint; other fields are ignored. An id-only record is sufficient
   * when only frontend registrations and fallback are needed. Does not fetch.
   */
  provider: {
    id: string;
    logoUrl?: string | null;
    /** Agent providers use { glyph }; machine and environment providers use a string. */
    icon?: { glyph: string } | string | null;
    strings?: { iconTint?: { light: string; dark: string } | null } | null;
  };
  /** Used when no artwork is available; defaults to Code. */
  fallback?: string;
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
  "aria-label"?: string;
}

/**
 * An app icon registered by a plugin. The registry is app-wide: a registered
 * name is usable wherever a `IconName` is — `experimental_Icon`, and every
 * host-rendered surface that takes one — by this plugin or any other.
 */
export interface ExperimentalIconRegistration {
  /** Shared app name. Namespacing is recommended, but not required. */
  name: string;
  /** Inline artwork. Honor className for sizing; use currentColor for tint. */
  component: ComponentType<{ className?: string }>;
}

export interface ExperimentalAppIcons {
  /**
   * Add or override an app icon during setup. A registered name shadows a
   * built-in of the same name. Returns nothing; the host replaces
   * registrations on reload and removes them on unload. Duplicate names within
   * a plugin reject setup. Between plugins, the first plugin id in lexical
   * order wins, independent of bundle load order.
   */
  register(registration: ExperimentalIconRegistration): void;
}

export interface PluginAppBuilder {
  experimental_icons: ExperimentalAppIcons;
  commands: PluginAppCommands;
  slots: PluginAppSlots;
  composer: PluginAppComposer;
  contentScripts: PluginAppContentScripts;
  /** Experimental managed region for actions and disclosures in the sidebar footer. */
  experimental_sidebarFooter: ExperimentalSidebarFooter;
}

export type PluginAppSetup = (app: PluginAppBuilder) => void;

/**
 * The opaque product of `definePluginApp` — a plugin's `app.tsx` default
 * export. The host re-runs `setup` against a fresh collector on every
 * (re)interpretation, replacing that plugin's registrations wholesale.
 */
export interface PluginAppDefinition {
  /** Brand the host checks before interpreting a bundle's default export. */
  readonly __omnyoPluginApp: true;
  readonly setup: PluginAppSetup;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export interface PluginRpcClient<
  Contract extends PluginRpcContract = PluginRpcContract,
> {
  /**
   * Invoke one of the plugin's `api.rpc` methods (POST
   * /api/v1/plugins/&lt;id&gt;/rpc/&lt;method&gt;). Resolves with the method's
   * inferred output; rejects with an `Error` carrying the server's message,
   * stable `code`, and validation `issues` when present.
   */
  call<Method extends Extract<keyof Contract, string>>(
    method: Method,
    ...args: PluginRpcCallArgs<Contract[Method]>
  ): Promise<PluginRpcResult<Contract[Method]>>;
}

export interface PluginSettingsState {
  /**
   * Effective non-secret setting values (secret settings are excluded —
   * read them server-side). Undefined while loading or unavailable.
   */
  values: Record<string, string | number | boolean> | undefined;
  isLoading: boolean;
}

/** State of the app's shared realtime connection to the omnyo server. */
export type PluginRealtimeConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting";

/** Where `useComposer()` writes. */
export type PluginComposerScope =
  | { kind: "thread"; threadId: string }
  | {
      kind: "queued-message";
      threadId: string;
      queuedMessageId: string;
    }
  | {
      kind: "new-thread";
      /** Root compose's effective selected project; null only while unresolved. */
      projectId: string | null;
    };

/** One plugin-owned composer customization registration. */
export interface ComposerCustomization {
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  /** Composer kinds where this customization is active; omit for all kinds. */
  scopes?: readonly PluginComposerScope["kind"][];
  actions?: readonly { id: string; component: ComponentType }[];
  banners?: readonly {
    id: string;
    /** Host chrome around the banner. Defaults to `"card"`. */
    chrome?: "card" | "bare";
    /** `"adjacent-to-composer"` renders the banner after the host's own banners, directly above the editor, keeping registration order among such banners. While messages are queued, the queue tray stays attached to the editor and these banners sit above it. Omit to keep the default position. */
    experimental_placement?: "adjacent-to-composer";
    component: ComponentType;
  }[];
  plusMenu?: readonly ComposerPlusMenuItem[];
  /** Host-rendered rows in the menu next to the composer's send button. */
  sendMenu?: readonly ComposerSendMenuItem[];
  richText?: ComposerRichTextSpec;
  /** Host-managed popups sharing the mention menu's above/below placement, with a responsive drawer on compact screens. Open by popup id, unique within this plugin. */
  experimental_popups?: readonly ExperimentalComposerPopupRegistration[];
}

/** Content for one composer's popup. The host owns placement, dismissal and focus restoration; the component owns its content and keyboard navigation. */
export interface ExperimentalComposerPopupRegistration {
  /** Popup id, unique across this plugin's composer customizations. */
  id: string;
  /** Accessible name of the popup and compact drawer. */
  label: string;
  /** Inside this component, useComposer() is bound to the composer that opened it. */
  component: ComponentType;
}

/** Host-rendered menu row in the composer's `+` menu. */
export interface ComposerPlusMenuItem {
  id: string;
  label: string;
  /** Takes precedence over the plugin's `omnyo.branding.icon`, which is drawn when this is omitted. */
  icon?: IconName;
  /** Accessible description for the host-rendered row. */
  description?: string;
  disabled?: boolean | ((composer: PluginComposerApi) => boolean);
  run(context: { composer: PluginComposerApi }): void | Promise<void>;
}

/**
 * Host-rendered row in the menu next to the composer's send button, for
 * alternatives to sending right away (save as a draft, send later). The menu
 * shows only while the composer can submit.
 */
export interface ComposerSendMenuItem {
  id: string;
  label: string;
  /** Takes precedence over the plugin's `omnyo.branding.icon`, which is drawn when this is omitted. */
  icon?: IconName;
  /** Accessible description for the host-rendered row. */
  description?: string;
  disabled?: boolean | ((composer: PluginComposerApi) => boolean);
  run(context: { composer: PluginComposerApi }): void | Promise<void>;
}

/**
 * Reactive read-side of the composer a plugin surface is mounted in.
 * @internal Superseded by `useComposer()`; kept for plugins built against
 * older SDKs.
 */
export interface ComposerView {
  scope: PluginComposerScope;
  layout: "expanded" | "compact" | "zen";
  draft: { text: string; isEmpty: boolean; attachmentCount: number };
  run: { isRunning: boolean; isSubmitting: boolean };
}

export interface ComposerRichTextSpec {
  /** Content-derived paint: match ranges receive `className`; text is never mutated. */
  effects?: readonly {
    id: string;
    /** Plain-text offsets into the current structured draft. */
    match(text: string): readonly { from: number; to: number }[];
    className: string;
  }[];
  /**
   * Debounced, read-only observation of the structured draft.
   * @internal Superseded by `useComposer().draft`; kept for plugins built
   * against older SDKs.
   */
  onDraftChange?(draft: ComposerStructuredDraft, view: ComposerView): void;
}

/**
 * @internal Superseded by {@link ComposerDraft}; kept for plugins built
 * against older SDKs.
 */
export interface ComposerStructuredDraft {
  text: string;
  mentions: readonly {
    from: number;
    to: number;
    provider: string;
    id: string;
    label: string;
  }[];
}

/** The composer's text and the @-mention pills in it. */
export interface ComposerDraft {
  text: string;
  mentions: readonly ComposerMention[];
}

/**
 * A composer attachment: an uploaded file, optionally owned by another
 * project, or an absolute path on one machine. Never both.
 */
export type ComposerAttachment = {
  type: "localImage" | "localFile";
  path: string;
  name: string;
  mimeType?: string;
  /** Exact size in bytes; omit when unknown. Zero is treated as unknown. A wrong nonzero size can make the send fail when Omnyo stages a file. */
  sizeBytes?: number;
} & (
  | {
      /** Project that currently owns this uploaded path; omit for destination-relative attachments. */
      sourceProjectId?: string;
      hostId?: never;
    }
  | {
      /** Machine whose absolute `path` this is; core rejects sending it to a thread on another machine. */
      hostId: string;
      sourceProjectId?: never;
    }
);

/** The complete current draft. Snapshots and their entries are immutable. */
export interface ComposerDraftSnapshot extends ComposerDraft {
  readonly attachments: readonly ComposerAttachment[];
}

/** Atomic text and mention replacement, optionally replacing uploaded attachments too. */
export interface ComposerDraftReplacement extends ComposerDraft {
  /** Omit to preserve attachments; supply an empty array to remove them all. Does not upload or copy files. */
  attachments?: readonly ComposerAttachment[];
}

/**
 * One @-mention pill: its range in `ComposerDraft.text` plus everything the
 * host needs to recreate it, so a mention read from `draft` can be passed
 * back to `insert` unchanged.
 */
export type ComposerMention = {
  from: number;
  to: number;
  label: string;
} & (
  | { kind: "thread"; threadId: string; projectId?: string }
  | { kind: "project"; projectId: string }
  | { kind: "section"; sectionId: string }
  | {
      kind: "path";
      path: string;
      source: "workspace" | "thread-storage";
      entryKind: "file" | "directory";
    }
  | {
      kind: "command";
      trigger: "/" | "$";
      name: string;
      source: "skill" | "command";
      origin: "builtin" | "project" | "user";
      argumentHint: string | null;
    }
  | {
      kind: "attachment";
      /** The stored path of a file attached to the same draft. */
      path: string;
    }
  | {
      kind: "plugin";
      /** The plugin that owns the pill. */
      pluginId: string;
      /** The mention provider id that plugin registered. */
      provider: string;
      /** The item id the provider's `resolve` receives at send time. */
      id: string;
      icon?: string | null;
    }
);

/**
 * What `insert` accepts: text, a mention read from `draft` (any kind), or one
 * of the calling plugin's own mentions (`{ provider, id, label }`, no `kind`).
 */
export type ComposerInsertPart =
  | string
  | ComposerMention
  | PluginComposerMention;

/** Where `insert` puts its content. */
export interface ComposerInsertOptions {
  /**
   * `"cursor"` (default) inserts at the editor's selection, replacing any
   * selected text; the selection is kept while focus is elsewhere, and the
   * composer must be on screen. `"end"` inserts after the last character and
   * also works for a composer that is not on screen.
   */
  at?: "cursor" | "end";
  /** Put the content on its own paragraph, adding a paragraph break before and after only where text is adjacent. */
  block?: boolean;
}

/** Host-rendered paint applied to the editable composer text. */
export interface PluginComposerTextEffect {
  className: string;
}

/**
 * A suggested next message the host shows inside an empty composer.
 *
 * `ready` shows `text` in muted type across the editor's full width, above a
 * "Suggested reply" caption with Insert, dismiss and, when `onRegenerate` is
 * supplied, a control that asks for another suggestion. Until the user clicks
 * or types in the editor, the send button submits `text` exactly as Enter
 * submits a draft, without focusing the editor. Insert and Tab in the empty
 * editor put it in the draft as editable text. `loading` shows an animated
 * waiting line whose stop control calls `onDismiss`; `failed` shows `message`
 * with Retry; `none` shows `reason` with a control that calls `onRequest` to
 * ask for a suggestion anyway. Escape in the empty editor and the dismiss
 * control call `onDismiss`.
 *
 * On compact viewports the host shows the suggestion as a card above the
 * editor instead: `ready` shows the full `text` clamped to three lines (tap to
 * expand), with Edit, which inserts it as editable text, and a Send button
 * that submits it in one tap and stays visible but disabled, with the reason,
 * while the composer cannot submit. The composer's own send button does not
 * send the suggestion there.
 */
export type ExperimentalComposerSuggestion =
  | {
      status: "ready";
      text: string;
      onDismiss(): void;
      onRegenerate?(): void;
    }
  | { status: "loading"; onDismiss(): void }
  | { status: "failed"; message: string; onRetry(): void; onDismiss(): void }
  | { status: "none"; reason: string; onRequest(): void; onDismiss(): void };

/** Host-rendered status that temporarily replaces a thread's draft glyph. */
export interface PluginComposerThreadRowStatus {
  /**
   * Always drawn as given: unlike the plugin-badged surfaces, this one has no
   * preference for the plugin's own `omnyo.branding.icon`.
   */
  icon: IconName;
  /** Accessible label for the status glyph. */
  label: string;
  /**
   * Semantic host treatment for the status glyph. `running` automatically
   * shimmers; terminal `success` and `error` tones are static. Defaults to the
   * neutral tone.
   */
  tone?: "default" | "running" | "success" | "error";
}

/** An @-mention pill bound to one of the calling plugin's mention providers. */
export interface PluginComposerMention {
  /** Mention provider id registered by THIS plugin via `api.ui.registerMentionProvider`. */
  provider: string;
  /** Item id your provider's `resolve` will receive at send time. */
  id: string;
  /** Pill text shown in the composer. */
  label: string;
}

/**
 * One composer: its state and the writes a plugin can make. `useComposer()`
 * returns the composer the calling surface belongs to — inside a composer
 * slot, that composer; in a thread's panels, that thread's composer;
 * elsewhere, the current route's draft (the thread in view, or the new-thread
 * draft).
 *
 * The handle is stable: the same composer returns the same object across
 * renders, and its methods always act on the current draft, so it is safe to
 * keep in effects, callbacks and async work. Its reactive fields (`text`,
 * `draft`, `selection`, `isEmpty`, …) re-render the calling component when they change;
 * depend on those fields, not on the handle, in memo dependency lists.
 *
 * A handle always writes to its own composer's draft. Thread and new-thread
 * drafts persist, so a write after the composer left the screen still lands
 * in that draft. When the draft no longer exists (a queued-message or
 * sent-message editor that closed), `insert`, `replace`, `removeMention`, `submit` and
 * `setSelection` throw "This composer is no longer available"; the older
 * text methods log a warning and do nothing.
 */
export interface PluginComposerApi {
  /** Open this plugin's registered composer popup by popup id in this mounted composer. Returns false for an unavailable, suppressed or out-of-scope popup. */
  experimental_openPopup(popupId: string): boolean;
  /** Close this plugin's open popup in this composer and restore editor focus. Returns false if this plugin has no open popup. */
  experimental_closePopup(): boolean;
  scope: PluginComposerScope;
  /**
   * Stable identity for this composer's draft: the same across remounts and
   * reloads for thread and new-thread composers (including a `ThreadChat`),
   * and per editing session for queued-message and sent-message editors.
   */
  readonly key: string;
  /** `"compact"` in the collapsed single-line layout, otherwise `"expanded"`. */
  readonly layout: "expanded" | "compact";
  /** The thread's agent is running or stopping. Always false in a new-thread composer. */
  readonly isRunning: boolean;
  /** The composer is submitting right now. */
  readonly isSubmitting: boolean;
  /**
   * Pressing Enter would not submit right now: the same decision as the
   * host's send button (empty draft, uploads in progress, loading, a
   * selection or setup missing, a pending interaction, voice input, …).
   */
  readonly isSubmittingBlocked: boolean;
  /** The host's message for why submitting is blocked, or null when it is not. */
  readonly submittingBlockedReason: string | null;
  /** No text (ignoring whitespace), no mentions and no attachments. */
  readonly isEmpty: boolean;
  /** Attachments that have finished uploading. */
  readonly attachmentCount: number;
  /** Current plain text for this composer scope. */
  readonly text: string;
  /** The complete current draft, including uploaded attachments. Stable until the draft changes. */
  readonly draft: ComposerDraftSnapshot;
  /** Current picker values, or null when this composer has no pickers. Stable until a picker value changes. */
  readonly selection: ComposerSelection | null;
  /**
   * Replace text and mentions together in one committed change. An updater
   * receives the latest immutable snapshot, including attachments, and must
   * return its result synchronously. Returning that same snapshot is a no-op.
   * Omitted attachments are preserved; an explicit list replaces them, and
   * an empty list clears them. Does not infer or rebase mention ranges.
   * Ranges are non-overlapping UTF-16 offsets into the supplied text.
   * Invalid results, throwing updaters, and unavailable editors leave the
   * draft unchanged. Source project references on uploaded attachments are
   * preserved; core copies them into the destination project when the draft
   * is submitted. Does not focus or submit. Use `insert` for insertion at the
   * editor's cursor.
   */
  replace(
    next:
      | ComposerDraftReplacement
      | ((current: ComposerDraftSnapshot) => ComposerDraftReplacement),
  ): void;

  /**
   * @internal Legacy text replacement; retained at runtime for older plugins.
   * @deprecated Use `replace` with explicit text and mentions. This legacy method reconciles mentions automatically.
   * Replace the draft's plain text. Attachments are preserved. Inline mentions
   * outside the changed range are preserved and rebased; mentions overlapped
   * by the replacement are removed because their text representation changed.
   */
  setText(next: string): void;
  /**
   * @internal Legacy text updater; retained at runtime for older plugins.
   * @deprecated Use `replace(current => next)` with explicit mention ranges.
   * Replace the draft's plain text from the latest committed value. Uses the
   * same structured-state reconciliation as `setText`.
   */
  updateText(updater: (current: string) => string): void;
  /**
   * @internal Legacy text clearing; retained at runtime for older plugins.
   * @deprecated Use `replace({ text: "", mentions: [] })`. Attachments are preserved.
   */
  clear(): void;
  /**
   * Insert text and mentions. See {@link ComposerInsertOptions} for placement.
   * Mentions read from `draft` are recreated exactly; the calling plugin's
   * own `{ provider, id, label }` resolves through its mention provider.
   * Throws for another plugin's mention without `kind`, and for
   * `at: "cursor"` when the composer is not on screen.
   */
  insert(
    parts: ComposerInsertPart | readonly ComposerInsertPart[],
    options?: ComposerInsertOptions,
  ): void;
  /**
   * Apply a host-rendered effect to this composer's editable text, or clear it.
   * Effects are scoped to the calling plugin and automatically clear when the
   * slot unmounts or its composer scope changes.
   */
  setTextEffect(effect: PluginComposerTextEffect | null): void;
  /**
   * Show a suggested next message inside this composer while its draft is
   * empty, or clear it with null: in the editor on wide viewports, or as a
   * card above the editor on compact viewports. Only one plugin's suggestion
   * shows at a time. Scoped to the calling plugin; clears automatically when
   * the slot unmounts or its composer scope changes.
   */
  experimental_setSuggestion(
    suggestion: ExperimentalComposerSuggestion | null,
  ): void;
  /**
   * Lock or unlock editing for this composer. Locks are scoped to the calling
   * plugin and automatically release when the slot unmounts or its composer
   * scope changes.
   */
  setInputLock(locked: boolean): void;
  /**
   * @internal Legacy quoting method; retained at runtime for older plugins.
   * Append text to the draft as a `> ` blockquote block and focus the
   * composer. Blank text is a no-op. This is the "reference this selection
   * in chat" primitive.
   */
  addQuote(text: string): void;
  /**
   * @internal Legacy mention insertion; retained at runtime for older plugins.
   * Append an @-mention pill that resolves through this plugin's mention
   * provider at send time. `insert` places mentions at the cursor instead.
   */
  insertMention(mention: PluginComposerMention): void;
  /** @internal Legacy mention removal; retained at runtime for older plugins. */
  removeMention(mention: { provider: string; id: string }): void;
  /** Subscribe to successful local submissions in this composer scope, including accepted queued messages. Failed sends and draft clearing do not notify. Dispose on unmount. */
  onSubmitted(listener: () => void): () => void;
  /** Observe the exact draft accepted by the existing send or queue owner. */
  experimental_onSubmittedDraft(
    listener: (draft: ComposerDraftSnapshot) => void,
  ): () => void;
  /** Focus the composer caret at the end of the draft. */
  focus(): void;
  /**
   * Submit this composer's draft exactly as pressing Enter would: the same
   * checks and the same action (send, or queue while the thread is busy; a
   * provider handoff creates a new thread). The draft's attachments and
   * @-mentions, and — in the new-thread composer — the provider, model,
   * reasoning level, service tier, permission mode and environment the user
   * has selected on screen, all travel with it.
   *
   * While attachments are uploading it waits for them, then checks again; it
   * rejects if an upload fails. Otherwise, when submitting is blocked it
   * rejects with `submittingBlockedReason`, a message safe to show to the
   * user. The queued-message and sent-message editors save edits and reject.
   *
   * `sendAt` queues the submission until that time. `experimental_data` is
   * opaque JSON delivered to dispatch hooks together with the calling plugin's
   * id on this initial attempt. Hooks run before operational core waits. If a
   * hook queues the message, its existing plugin wait identifies the owner on
   * later attempts; core does not persist or interpret the opaque data.
   *
   * Resolves once the host has accepted the submission and cleared the draft.
   * Failures of the underlying request are reported by Omnyo's own submit error
   * handling and restore the draft, exactly as an interactive failure does.
   */
  submit(options: ComposerSubmitOptions): Promise<void>;
  /**
   * Set this composer's pickers as if each value had been picked by hand.
   *
   * Every field is optional. An omitted field is left alone. A field this
   * composer has no picker for is ignored rather than rejected: a thread
   * composer has no project or environment; a provider without service tiers
   * has no tier; a fork draft locks its project, provider and environment.
   * Values travel through the same paths the pickers use, so in the
   * new-thread composer they become the remembered defaults for the next
   * thread and are reported as the user's explicit choices, and in a thread
   * composer a provider change starts the same handoff the picker starts:
   * the handoff block is prepended to the draft and the next send creates a
   * new thread. A same-provider model change in a thread does not start a
   * handoff, exactly like the picker.
   *
   * In the new-thread composer the project is switched first and awaited
   * (attachments are copied to the new project), then the environment and
   * machine are applied to the new project, then provider, model, reasoning
   * level, service tier and permission mode. A provider change reloads the
   * model catalog before the model and reasoning level are applied to it.
   * Because the project switch remounts plugin surfaces, the returned
   * promise is owned by the composer and still resolves after the calling
   * component has unmounted.
   *
   * Resolves with the composer's own selection once it has settled: the
   * applied values have committed and the model catalog for the selected
   * provider and machine has finished loading, so model, reasoning level and
   * permission mode have reconciled against it. The catalog wait is bounded;
   * if it has not finished after 15 seconds the promise resolves with the
   * selection as it stands. The result carries only the fields this composer
   * has, so a missing key means "no such picker here" and a value that
   * differs from the one passed was reconciled (a reasoning level the model
   * does not support, a service tier the model does not offer, a permission
   * mode above the machine's ceiling, a model the provider does not list). A provider the composer does not list is
   * ignored together with the model and reasoning level meant for it, so the
   * stored provider preference never names something the picker could not
   * have chosen. `environment` is absent while the composer
   * has no submittable environment; `providerId` and `model` are absent
   * while nothing is selected; `serviceTier` is present only when the
   * selected provider has tiers and one is chosen.
   *
   * Rejects, with a message safe to show to the user, in a composer with no
   * pickers at all (a queued-message editor, a side chat, a plugin surface
   * mounted outside any composer), when the calling surface is no longer
   * active, and when a value is not a known reasoning level or permission
   * mode, or is an empty service tier.
   */
  setSelection(selection: ComposerSelection): Promise<ComposerSelection>;
  /** @internal Old name of `removeMention`; kept for plugins built against older SDKs. */
  experimental_removeMention(mention: { provider: string; id: string }): void;
  /** @internal Old name of `onSubmitted`; kept for plugins built against older SDKs. */
  experimental_onSubmitted(listener: () => void): () => void;
  /** @internal Old name of `submit`; kept for plugins built against older SDKs. */
  experimental_submit(options: ComposerSubmitOptions): Promise<void>;
  /** @internal Old name of `setSelection`; kept for plugins built against older SDKs. */
  experimental_setSelection(
    selection: ComposerSelection,
  ): Promise<ComposerSelection>;
}

/**
 * Current picker values in `selection`, input for `setSelection`, and the shape it resolves with. Field names match `NewThreadRequest` and the `default*` props of
 * `experimental_NewThreadComposer`, so one routed decision can feed the
 * composer, the embedded composer and `api.sdk.threads.spawn` alike.
 */
export interface ComposerSelection {
  /** New-thread composers only. Omnyo's personal-project id means "Don't work in a project". */
  projectId?: string;
  /**
   * New-thread composers only. `{ type: "project-default" }` and a `host`
   * environment without a `hostId` seed nothing and are ignored. Provider
   * `inputs` are not applied; the provider's own inputs control keeps its
   * value, and the result reports what the composer would submit.
   */
  environment?: CreateThreadEnvironmentArgs;
  /** A provider the composer does not list is ignored, and `model` and `reasoningLevel` with it. */
  providerId?: string;
  /** Applied only when the composer ends up on the requested provider (or none was requested). */
  model?: string;
  /** Applied only when the composer ends up on the requested provider (or none was requested). */
  reasoningLevel?: ReasoningLevel;
  /**
   * A tier id the provider declares (`"default"`, `"fast"`, …). Ignored by a
   * provider with no service tiers; a tier the selected model does not offer
   * becomes `"default"`.
   */
  serviceTier?: ServiceTier;
  permissionMode?: PermissionMode;
}

/**
 * What `submit` does differently from pressing Enter.
 *
 * `experimental_data` is opaque JSON delivered to dispatch hooks. The runtime
 * associates it with the calling plugin automatically for the initial
 * dispatch attempt.
 *
 * `experimental_expectHeld` tells the host that the calling plugin's own
 * dispatch hook will hold this submission with `{ action: "wait", reason }`.
 * The host then shows the message at once as a queued message waiting on the
 * plugin with that reason, instead of briefly showing it as sent until the
 * server answers. It requires `experimental_data`, because that is how the
 * hook recognizes the submission. `reason` must be 1 to 200 characters. The
 * server's answer always wins: if the hook does not hold the message, the
 * prediction is corrected to a sent message.
 */
export type ComposerSubmitOptions =
  | {
      sendAt: number;
      experimental_data?: JsonValue;
      experimental_expectHeld?: { reason: string };
    }
  | {
      experimental_data: JsonValue;
      sendAt?: never;
      experimental_expectHeld?: { reason: string };
    };

/** @internal Old name of {@link ComposerSelection}. */
export type ExperimentalComposerSelection = ComposerSelection;

/** @internal Old name of {@link ComposerSubmitOptions}. */
export type ExperimentalComposerSubmitOptions = ComposerSubmitOptions;

// ---------------------------------------------------------------------------
// ThreadChat — the host-owned chat component.
// ---------------------------------------------------------------------------

/**
 * A consumer-supplied action on the messages of one `ThreadChat` instance,
 * rendered in the embedded timeline's per-message action menu (hover row on a
 * fine pointer, long-press sheet on touch) alongside the native actions. Slot-registered `messageAction`s do not appear there. Unlike
 * the `messageAction` slot this is scoped to the rendering component, not
 * registered globally.
 */
export interface ThreadChatMessageAction {
  /** Unique within this ThreadChat instance; letters, digits, `-`, `_`. */
  id: string;
  /** Tooltip / menu label for the action. */
  title: string;
  icon?: IconName;
  /**
   * Message roles the action applies to. Omitted = both user and assistant
   * messages.
   */
  roles?: readonly ("user" | "assistant")[];
  /**
   * Runs when the user activates the action. Errors (sync or async) are
   * contained and logged; they never break the timeline.
   */
  run(message: ThreadChatMessageReference): void | Promise<void>;
}

/**
 * Props of the host-owned `ThreadChat` component — one thread's chat
 * (timeline, and for the composer variants the full send/queue/draft
 * engine), rendered by the Omnyo app inside a plugin slot. This is the
 * deliberate exception to the no-host-components rule (§5.5): a stable
 * product capability, not a UI kit. Versioned additive like slot props;
 * internal timeline rows, query hooks, and prompt-box configuration are
 * deliberately not exposed.
 */
export interface ThreadChatProps {
  threadId: string;
  /** A plugin-owned conversation with an independent draft and durable mention attribution. */
  experimental_conversation?: { id: string; mention: PluginComposerMention };
  /**
   * "full" (default) is the page presentation (centered reading width);
   * "compact" is the side-panel presentation; "timeline" renders the
   * transcript without a composer.
   */
  variant?: "full" | "compact" | "timeline";
  /**
   * "contained" (default) fills and scrolls inside a bounded parent;
   * "document" grows with its content and defers scrolling to the page.
   */
  layout?: "contained" | "document";
  /** Bump to focus the composer (ignored by `variant: "timeline"`). */
  focusRequest?: number;
  /**
   * Who controls the permission mode sends run with. "inherit" (default)
   * pins every send to the thread's own resolved default and renders the
   * picker as a dimmed label — a plugin surface can never widen it.
   * "editable" gives this chat its own picker, so the user can raise or
   * lower permissions for this thread independently of the thread it was
   * forked from. Ignored by `variant: "timeline"` (no composer).
   */
  permissionPolicy?: "inherit" | "editable";
  className?: string;
  /**
   * Composer placeholder while the chat is idle. The host keeps its own
   * text while the chat is provisioning or stopping. Experimental: see
   * docs/api_to_audit.md.
   */
  experimental_placeholder?: string;
  /** Rendered above the conversation, scrolling with it. */
  leadingContent?: ReactNode;
  /**
   * Actions rendered in this instance's per-message action menu (see
   * {@link ThreadChatMessageAction}).
   */
  messageActions?: readonly ThreadChatMessageAction[];
}

// ---------------------------------------------------------------------------
// experimental_ProviderModelPicker — host-owned execution selection.
// ---------------------------------------------------------------------------

/**
 * The controlled execution selection resolved by the picker.
 *
 * Deliberately a single concrete shape, not a union: this value exists to be
 * forwarded verbatim to `api.sdk.threads.spawn`, so it must name a real
 * provider and model.
 */
export interface ExperimentalProviderModelPickerValue {
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel;
  /**
   * Present only when the selected provider supports service tiers. A tier
   * id the provider declares; `"default"` when the selected model offers none.
   */
  serviceTier?: ServiceTier;
}

/** Where the picker resolves the live provider and model catalog. */
export type ExperimentalProviderModelPickerRouting =
  | { kind: "host"; hostId: string }
  | { kind: "environment"; environmentId: string };

/**
 * Props of the host-owned `experimental_ProviderModelPicker` component.
 * The picker lists each provider's models in one grouped list, with every
 * model's reasoning levels as cells. One click on a cell, a model name, or a
 * favorite emits one complete value from that provider's verified catalog and
 * closes the picker; a model name lands on the current reasoning level or the
 * closest one it supports. The user's model picker favorites and hidden models
 * apply as in Omnyo's composers, and unavailable favorites never emit. Loading,
 * failed, or empty catalogs leave `value` unchanged. Omit `routing` to use
 * Omnyo's primary-machine routing. Environment routing is required when a
 * provider's model catalog depends on the selected workspace.
 */
export interface ExperimentalProviderModelPickerProps {
  value: ExperimentalProviderModelPickerValue;
  /**
   * Receives the complete selection once per committed choice, and when a
   * a verified catalog fills an empty selection or reconciles its supported
   * reasoning level and service tier. A selected model missing from the catalog
   * stays selected until the user explicitly chooses a replacement.
   */
  onChange(value: ExperimentalProviderModelPickerValue): void;
  /** Route discovery through an explicit machine or existing environment. */
  routing?: ExperimentalProviderModelPickerRouting;
  /**
   * Allow choosing another provider. Defaults to true; false shows only the
   * group and favorites of `value.providerId`.
   */
  allowProviderChange?: boolean;
  /** Horizontal popover alignment. Defaults to `"start"`. */
  align?: "start" | "center" | "end";
  /** Render the shared selection summary without allowing changes. */
  disabled?: boolean;
  className?: string;
}

/**
 * Props of the host-owned `experimental_BranchPicker` component — Omnyo's branch
 * picker bundled with its branch-options loading for the given host and
 * project. The host owns fetching, searching, and refreshing the branch list;
 * the caller owns the selection and its meaning.
 */
export interface BranchPickerProps {
  /**
   * The enrolled machine whose project checkout supplies the branch list.
   * Null renders the picker disabled with no options.
   */
  hostId: string | null;
  /** The project whose source on `hostId` is listed; null disables loading. */
  projectId: string | null;
  /**
   * The selected branch name, or null when no branch is chosen. A null value
   * shows the placeholder without selecting or implying a default branch.
   */
  value: string | null;
  /** Called with the picked branch name, or null when the pick is cleared. */
  onChange(next: string | null): void;
  /**
   * Text placed before the branch on the trigger and used as the menu heading,
   * e.g. "Compare with:". Omitted, the trigger is the branch alone and the menu
   * uses the neutral "Branches" heading.
   */
  label?: string;
  /**
   * The complete trigger text while nothing is picked, without the label
   * prefix. Defaults to "Select branch".
   */
  placeholder?: string;
  /** Render the current selection without allowing changes. */
  disabled?: boolean;
}

export interface UseBranchesArgs {
  hostId: string | null;
  projectId: string | null;
  query?: string;
}

export interface BranchesState {
  branches: readonly string[];
  remoteBranches: readonly string[];
  isLoading: boolean;
  refresh(): Promise<void>;
}

export interface UseCheckoutStateArgs {
  hostId: string | null;
  projectId: string | null;
}

export interface CheckoutState {
  isGit: boolean | null;
  unborn: boolean;
  detached: boolean;
  dirty: boolean;
  currentBranch: string | null;
  operation: WorkspaceGitOperation;
}

/** One changed file in a thread's workspace. */
export interface ExperimentalThreadGitFile {
  /** Path relative to the workspace root. */
  path: string;
  /**
   * Porcelain status: `M` modified, `A` added, `D` deleted, `R` renamed,
   * `C` copied, `U` conflicted, `??` untracked, `?` unknown.
   */
  status: "M" | "A" | "D" | "R" | "C" | "U" | "??" | "?";
  /** Null when the host could not count lines, e.g. for a binary file. */
  insertions: number | null;
  deletions: number | null;
}

/**
 * A set of changed files with totals. `files` can be shorter than
 * `fileCount` when the host caps a large change list.
 */
export interface ExperimentalThreadGitChanges {
  fileCount: number;
  insertions: number;
  deletions: number;
  /** False when at least one file has no line counts. */
  lineStatsComplete: boolean;
  files: readonly ExperimentalThreadGitFile[];
}

/** One commit on the thread's branch that the comparison base lacks. */
export interface ExperimentalThreadGitCommit {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  /** Epoch milliseconds. */
  authoredAt: number;
}

/** The thread branch compared with its merge base branch. */
export interface ExperimentalThreadGitComparison {
  /** The branch the thread merges into, e.g. `main`. */
  baseBranch: string;
  aheadCount: number;
  behindCount: number;
  /** Ahead commits, newest first. */
  commits: readonly ExperimentalThreadGitCommit[];
  /** Committed changes relative to the merge base. */
  changes: ExperimentalThreadGitChanges;
}

export type ExperimentalThreadGitMergeMethod = "merge" | "squash" | "rebase";

/** Pull request actions the host can perform for this thread. */
export interface ExperimentalThreadGitPullRequestActions {
  /** True while a pull request action is running. */
  isPending: boolean;
  /** The merge method Omnyo last used for this thread, the default choice. */
  mergeMethod: ExperimentalThreadGitMergeMethod;
  /** Null when the pull request cannot be marked ready. */
  markReady: (() => void) | null;
  /** Null when the pull request cannot be merged. */
  merge: ((method: ExperimentalThreadGitMergeMethod) => void) | null;
  /** Null when the pull request cannot return to draft. */
  convertToDraft: (() => void) | null;
}

/** Where a changed file was listed, which decides how it opens. */
export type ExperimentalThreadGitFileSource = "workingTree" | "comparison";

/**
 * Git state for one thread's workspace, read with
 * `experimental_useThreadGit()`.
 *
 * `loading` covers the first status lookup. `ready` carries the status and
 * the host's git actions; each action runs the same path as Omnyo's own git
 * controls.
 */
export type ExperimentalThreadGit =
  | { status: "loading" }
  | {
      status: "ready";
      /** Checked-out branch, or null for a detached HEAD. */
      branch: string | null;
      /** The repository's default branch. */
      defaultBranch: string;
      /** Uncommitted changes, untracked (`??`) files included. */
      workingTree: ExperimentalThreadGitChanges;
      /** Null when the host has no merge base to compare with. */
      comparison: ExperimentalThreadGitComparison | null;
      /** The branch's pull request, or null when there is none. */
      pullRequest: PluginSidebarPullRequest | null;
      /** Null when the host offers no pull request actions. */
      pullRequestActions: ExperimentalThreadGitPullRequestActions | null;
      /**
       * Opens Omnyo's commit flow for the uncommitted changes. Null when there
       * is nothing to commit or the thread cannot commit.
       */
      commit: (() => void) | null;
      /**
       * Opens one changed file the way Omnyo's change lists do: a diff for a
       * tracked change, a preview for an untracked file.
       */
      openFile(args: {
        path: string;
        source: ExperimentalThreadGitFileSource;
      }): void;
      /** Opens Omnyo's full diff panel for this thread. */
      openDiffPanel(): void;
    };

/** Props of the host-owned `experimental_ThreadMergeBasePicker`. */
export interface ExperimentalThreadMergeBasePickerProps {
  /** Horizontal menu alignment. Defaults to `"end"`. */
  align?: "start" | "center" | "end";
  className?: string;
}

/** Props of Omnyo's controlled, host-resolved permission-mode picker. */
export interface ExperimentalPermissionModePickerProps {
  /** Provider whose supported modes determine the available choices. */
  providerId: string;
  value: PermissionMode;
  onChange(value: PermissionMode): void;
  /** Route capability and machine-ceiling resolution like the execution picker. */
  routing?: ExperimentalProviderModelPickerRouting;
  /** Horizontal menu alignment. Defaults to `"end"`. */
  align?: "start" | "center" | "end";
  /** Render the resolved mode without allowing changes. */
  disabled?: boolean;
  className?: string;
}

// ---------------------------------------------------------------------------
// experimental_NewThreadComposer — the host-owned new-thread compose surface.
// ---------------------------------------------------------------------------

/**
 * Every selection the composer resolved, JSON-serializable so a plugin can
 * forward it to its own backend rpc verbatim and hand it straight to
 * `api.sdk.threads.spawn`.
 *
 * The split is deliberate: the composer owns *user selections*, the plugin
 * owns *filing and attribution*. `api.sdk.threads.spawn` auto-fills
 * `origin: "plugin"` and `originPluginId`, so a thread created this way stays
 * attributed to the plugin — which it would not be if the component created
 * the thread itself. The plugin adds `sectionId`, `parentThreadId`, `title`,
 * and `visibility` to the request on its own; they are deliberately not
 * composer props.
 */
export interface NewThreadRequest {
  /**
   * The selected project id. Choosing "Don't work in a project" submits Omnyo's
   * personal-project id (not `null`) together with a `personal` workspace
   * environment. Forward those fields unchanged to `threads.spawn`; if the
   * plugin needs project metadata, request it from the plugin backend with
   * `api.sdk.projects.list({ includePersonal: true })`.
   */
  projectId: string;
  providerId: string;
  claudeProfile?: ClaudeProfileSelection;
  model: string;
  reasoningLevel: ReasoningLevel;
  permissionMode: PermissionMode;
  /** Omitted when the selected provider has no service tiers. */
  serviceTier?: ServiceTier;
  /**
   * Agent options the user chose in the model picker or the mode menu, keyed
   * by option id. Present only when the user changed at least one option the
   * selected provider declares. Forward it to `threads.spawn` unchanged.
   */
  sessionOptions?: SessionOptionSelections;
  /**
   * Per-field provenance (caller-explicit vs. default) for the execution
   * options above, forwarded to `spawn` so the server records what the user
   * actually chose.
   */
  executionInputSources: CreateExecutionInputSources;
  environment: CreateThreadEnvironmentArgs;
  input: PromptInput[];
  /**
   * Epoch ms the first turn should dispatch at. Present only when the
   * submission came from `useComposer().submit` — a scheduled
   * create — and absent otherwise, which is what makes an ordinary submission
   * start work at once. Forward it to `threads.spawn` unchanged: the thread is
   * created `pending` and its first message is queued as a row until then.
   */
  sendAt?: number;
}

/**
 * Props of the host-owned `experimental_NewThreadComposer` component — Omnyo's
 * full new-thread compose surface (prompt editor with @-mentions and expand,
 * attachments, provider/model/reasoning picker, voice, submit, and the row
 * beneath with project, environment, branch-from, and permission mode),
 * rendered by the Omnyo app inside a plugin slot.
 *
 * It is the create-side counterpart to `ThreadChat`: same deliberate
 * exception to the no-host-components rule (§5.5), same additive versioning.
 */
export interface NewThreadComposerProps {
  /**
   * Seeds the project picker. The user can change it, including choosing
   * "Don't work in a project"; see {@link NewThreadRequest.projectId} for the
   * submitted projectless shape.
   */
  defaultProjectId?: string;
  /**
   * Seeds the provider picker. Like every `default*` prop this is a SEED, not
   * a controlled value: the composer stays uncontrolled, the user can change
   * it, and when omitted the composer falls back to the project's remembered
   * execution defaults exactly as before. When provided it takes precedence
   * over those project defaults.
   *
   * Re-seeding: the `default*` props are value-compared each render. When any
   * of them changes after mount, the composer re-seeds EVERY execution and
   * environment selection from the new props — including selections the user
   * had already touched — so switching between two saved records in the same
   * mounted composer reloads that record's values (the same rule
   * `defaultProjectId` already follows).
   *
   * Every seeded field is reported as caller-explicit in the submitted
   * request's `executionInputSources`. That is what makes the seed survive
   * `threads.spawn`: the server drops a requested `providerId`/`model` that
   * carries no provenance source and re-derives it from the project's stored
   * defaults, which would silently undo the seed.
   */
  defaultProviderId?: string;
  /** Seeds the model picker. Same seed semantics as {@link defaultProviderId}. */
  defaultModel?: string;
  /**
   * Seeds the reasoning-level picker. Same seed semantics as
   * {@link defaultProviderId}. If the seeded model does not support this
   * level, the composer reconciles to the closest supported one.
   */
  defaultReasoningLevel?: ReasoningLevel;
  /**
   * Seeds the service-tier picker. Same seed semantics as
   * {@link defaultProviderId}. Ignored (and omitted from the submitted
   * request) when the selected provider has no service tiers.
   */
  defaultServiceTier?: ServiceTier;
  /** Seeds the permission-mode picker. Same seed semantics as {@link defaultProviderId}. */
  defaultPermissionMode?: PermissionMode;
  /**
   * Seeds the environment and branch pickers from a previously submitted
   * `NewThreadRequest.environment`. Same seed semantics as
   * {@link defaultProviderId}: a seed the user can change, taking precedence
   * over the composer's own environment default when provided.
   *
   * Round trip: feeding a submitted request's `environment` back in and
   * resubmitting untouched reproduces an equivalent environment, with these
   * documented limits — the composer cannot represent every args variant:
   *
   * - `{ type: "project-default" }` seeds nothing; the composer resolves its
   *   own default and submits that concrete environment instead.
   * - A `host` environment whose host no longer exists (or whose project has
   *   no source on it) falls back to the composer's default host, exactly as
   *   the primary compose surface would.
   * - A `reuse` environment whose worktree no longer has unarchived threads
   *   falls back the same way.
   * - An `unmanaged` workspace's `path` has no composer control; the seeded
   *   selection submits `path: null` (the host's configured checkout). The
   *   composer itself never produces a non-null `path`, so real round trips
   *   are unaffected.
   * - A `managed-worktree` with `baseBranch: { kind: "default" }` leaves the
   *   branch picker on its default, which may resolve to a named base branch
   *   when the project configures a dedicated worktree base — the same branch
   *   the original `default` submission would have created from.
   */
  defaultEnvironment?: CreateThreadEnvironmentArgs;
  /**
   * Seeds the draft, only while the draft is still empty. Serialized
   * `@thread:<id>`, `@project:<id>`, and `@section:<id>` tokens become mention
   * pills with host-resolved titles/names. Missing projects/sections use their
   * IDs; unavailable generated thread IDs use "Unavailable thread" ("Thread"
   * if lookup fails). Other unknown thread IDs use the ID as their label.
   */
  initialPrompt?: string;
  placeholder?: string;
  /**
   * "contained" (default) fills and scrolls inside a bounded parent;
   * "document" grows with its content and defers scrolling to the page.
   */
  layout?: "contained" | "document";
  /** Bump to focus the editor. */
  focusRequest?: number;
  className?: string;
  /**
   * Where the draft persists. Drafts survive reloads and are shared by every
   * composer using the same key; defaults to a key scoped to this plugin.
   */
  draftKey?: string;
  /**
   * Fires on submit with every selection resolved. The draft clears when this
   * resolves and is KEPT if it throws, so a failed create never loses what the
   * user typed.
   */
  onSubmit: (request: NewThreadRequest) => void | Promise<void>;
}

/** Authenticated raster object URL rendered through the shared image lightbox. */
export interface ExperimentalImagePreviewProps {
  src: string;
  alt: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  title?: string;
  className?: string;
}

/**
 * Props of the host-owned `Markdown` component — Omnyo's chat message renderer
 * (the same typography, spacing, and code styling as timeline messages).
 * Use it wherever plugin UI quotes or previews message content so it reads
 * like the rest of the chat. Like `ThreadChat`, this is a stable product
 * capability, not a UI kit; renderer internals stay private.
 */
export interface MarkdownProps {
  /** Markdown source, rendered exactly like a chat message body. */
  content: string;
  className?: string;
  /** Resolve local destinations from this document; omission keeps message routing. */
  experimental_document?: {
    threadId: string;
    rootPath: string;
    target: Exclude<ExperimentalLiveFileTarget, { kind: "host" }>;
  };
}

/**
 * Props for Omnyo's semantic URL link. The host owns ordinary activation while
 * retaining browser-owned anchor behavior for app routes, modifiers, explicit
 * targets, copying, and unsupported schemes. New top-level targets preserve
 * supplied `rel` tokens and receive safe defaults unless `opener` is explicit.
 * Experimental: see docs/api_to_audit.md.
 */
export interface UrlLinkProps extends Omit<
  ComponentPropsWithoutRef<"a">,
  "href"
> {
  href: string;
}

/** A live file whose identity is complete without ambient route context. */
export type ExperimentalLiveFileTarget =
  | { kind: "workspace"; environmentId: string; path: string }
  | { kind: "host"; hostId: string; path: string }
  | { kind: "thread-storage"; threadId: string; path: string };

/** One-based location to reveal after a live file opens. */
export type ExperimentalFileLocation =
  | { kind: "line"; line: number; column: number | null }
  | { kind: "range"; startLine: number; endLine: number };

/** Options shared by Omnyo's preview and preferred-external file intents. */
export interface ExperimentalFileOpenOptions {
  target: ExperimentalLiveFileTarget;
  location: ExperimentalFileLocation | null;
}

/**
 * Props for Omnyo's host-rendered semantic file link. Valid targets receive a
 * scheme-safe anchor href; traversal paths, ill-formed Unicode, and other
 * malformed runtime targets remain inert.
 */
export interface ExperimentalFileLinkProps extends Omit<
  ComponentPropsWithoutRef<"a">,
  "href" | "target"
> {
  target: ExperimentalLiveFileTarget;
  location?: ExperimentalFileLocation | null;
}

/** The panel surface resolved by the component making the request. */
export type ExperimentalAppPanelSurface = { kind: "current" };

/**
 * The owning fixed tab's current memory-only target. It survives tab, panel,
 * and route remounts during the current app session, but is never persisted
 * across a refresh. Call `clear` when the owner returns to its untargeted state.
 */
export interface ExperimentalFixedTabTargetState<Target extends JsonValue> {
  readonly sequence: number;
  readonly target: Target;
  clear(): void;
}

export type ExperimentalOpenFixedTabOptions<Target extends JsonValue> = {
  surface: ExperimentalAppPanelSurface;
  tab: ExperimentalPluginFixedTabReference<Target>;
  /** Omit to select the tab without replacing its current session target. */
  target?: NoInfer<Target>;
};

/** Surface-aware controller for selecting owner-scoped fixed tabs. */
export interface ExperimentalAppPanel {
  openFixedTab<Target extends JsonValue = never>(
    options: ExperimentalOpenFixedTabOptions<Target>,
  ): boolean;
}

/**
 * One user action a plugin adds to Omnyo's single undo history. `label` names the
 * action in the Undid/Redid toast, so phrase it as the action: "Move Revenue
 * chart". `undo` and `redo` reject to show Omnyo's error toast.
 */
export interface ExperimentalActionHistoryEntry {
  label: string;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

/**
 * Omnyo's one app-wide undo history, shared with chat actions such as Archive.
 * Record only actions the user took, after they succeed; Cmd+Z / Cmd+Shift+Z
 * (Ctrl+Z / Ctrl+Y elsewhere) replay the newest entry wherever it came from,
 * after native text editing in the focused field. Plugins must not handle
 * those shortcuts themselves.
 */
export interface ExperimentalActionHistory {
  record(entry: ExperimentalActionHistoryEntry): void;
  /** Replay the newest entry, as the keyboard shortcut does. */
  undo(): Promise<void>;
  redo(): Promise<void>;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

/** Current app selection, derived from the route. */
export interface experimental_AppContext {
  projectId: string | null;
  threadId: string | null;
}

/** Window-local visible selection; retained or hidden panels are excluded. */
export interface ExperimentalVisibleAppContext {
  view:
    | "compose"
    | "thread"
    | "settings"
    | "archive"
    | "tools"
    | "plugin"
    | "other";
  projectId: string | null;
  threadId: string | null;
  panel: {
    kind:
      | "file"
      | "browser"
      | "terminal"
      | "diff"
      | "thread-info"
      | "plugin"
      | "new-tab";
    label: string;
    resourceId: string | null;
  } | null;
}

export interface experimental_AppNavigate {
  /**
   * Open a thread. `split: true` applies Omnyo's split placement rules (a right
   * split by default, focus when already open, replace at the pane cap) and
   * falls back to plain navigation where splits are off. Opening also expands
   * the thread's conversation if the side panel had collapsed it. Set
   * `experimental_userInitiated` for a direct chat open so iOS can give
   * feedback when the chat is off screen.
   */
  toThread(
    threadId: string,
    options?: { split?: boolean; experimental_userInitiated?: boolean },
  ): void;
  experimental_prefetchThreadOpen(threadId: string): void;
  toProject(projectId: string): void;
  /**
   * Open Omnyo's add-project picker while keeping the current page open.
   * Returns false if the host cannot open the picker. The callback receives
   * the project after a successful save and is not called on cancel.
   */
  experimental_openProjectCreator?(
    onCreated: (project: Pick<ProjectResponse, "id" | "name">) => void,
  ): boolean;
  /**
   * Navigate to one of this plugin's own nav panels by its `path`.
   * `subPath` targets a location inside the panel (the component's
   * `subPath` prop); `replace` swaps the current history entry instead of
   * pushing — use it for redirects so back does not bounce.
   */
  toPluginPanel(
    path: string,
    options?: { subPath?: string; replace?: boolean },
  ): void;
  /**
   * Navigate to the root compose surface (the new-thread screen). Pass
   * `initialPrompt` to seed the composer draft (serialized thread, project,
   * and section mention tokens become pills) and `focusPrompt` to focus the
   * composer on arrival — the pairing behind "Create via chat" style entry
   * points that drop the user into chat with a prefilled prompt.
   * `projectId` makes that project the composer's selection; `placement`
   * files the new thread in a section and pin state (omitted: unpinned,
   * outside sections); `environmentId` reuses that environment and `hostId`
   * picks a machine for a new one (`environmentId` wins when both are set).
   */
  toCompose(options?: {
    projectId?: string;
    initialPrompt?: string;
    focusPrompt?: boolean;
    placement?: { sectionId: string | null; pinned: boolean };
    environmentId?: string;
    hostId?: string;
  }): void;
  /**
   * Open one of this plugin's registered panel actions in the current
   * surface's side panel: a `threadPanelAction` in a thread, or an
   * `experimental_newThreadPanelAction` on the New thread screen. Plugin
   * commands and thread actions use the focused thread view's opener. Returns false when the surface has no side
   * panel actions (plugin pages) or the action is unavailable.
   */
  openThreadPanel(options: PluginTargetedPanelActionOpenOptions): boolean;
  /**
   * Open an HTTP(S) URL using this client's Omnyo browser preference. Returns
   * false for schemes the host does not own. Experimental: see
   * docs/api_to_audit.md.
   */
  openUrl(url: string): boolean;
  /** Open a live file in this surface's shared Omnyo preview panel. */
  experimental_openFilePreview(options: ExperimentalFileOpenOptions): boolean;
  /** Open a live file in this client's preferred external file target. */
  experimental_openFileExternally(
    options: ExperimentalFileOpenOptions,
  ): boolean;
  /**
   * Show a terminal session in this surface's Omnyo terminal panel: select its
   * tab, adding one when needed, and reveal the panel. Create the session
   * first with `useSdk().terminals.create`, whose scope chooses the thread,
   * environment, or host directory it runs in. A thread surface accepts only
   * that thread's terminals, the New thread screen only terminals in its
   * current terminal scope, and a plugin page any terminal. Resolves false
   * for unknown or exited terminals and surfaces without a terminal panel.
   * Closing the tab closes the terminal. Experimental: see
   * docs/api_to_audit.md.
   */
  experimental_openTerminal(options: { terminalId: string }): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// The whole runtime surface. Declaration-versus-runtime parity is tested
// against the actual `@omnyo/plugin-sdk/app` module namespace.
//
// Components are deliberately NOT part of this surface (removed 2026-07-03,
// plugin design §5.5): plugins vendor shadcn-style component source from the
// Omnyo registry (`npx shadcn add ./vendor/omnyo-ui/<name>.json`) and own it. `omnyo plugin build`
// shims react, the shared-singleton packages (portal radix families,
// sonner, vaul, @pierre/diffs) and the host-resident libraries every plugin
// would otherwise duplicate (clsx, tailwind-merge, class-variance-authority,
// the shared-ui icon); everything else bundles per plugin. Freezing 65
// component prop types here made every host component change a
// plugin-breaking change.
// ---------------------------------------------------------------------------

/**
 * Everything `@omnyo/plugin-sdk/app` resolves to at runtime. The Omnyo app builds
 * the real implementation and `satisfies` this interface; `omnyo plugin build`
 * shims the specifier to that object on `globalThis.__omnyoPluginRuntime`.
 */
export type ExperimentalThreadBootstrapData =
  | { status: "pending" }
  | { status: "unavailable" }
  | { status: "error"; message: string; updatedAt: number }
  | { status: "ready"; result: JsonValue; updatedAt: number; current: boolean };

type DrawerPointerDownOutsideEvent = CustomEvent<{
  originalEvent: PointerEvent;
}>;

/** Props for {@link PluginSdkApp.experimental_ResponsiveDrawerShell}. */
export interface ExperimentalResponsiveDrawerShellProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A screen-reader label when the content does not supply a visible heading. */
  srLabel?: string;
  /** ID of the visible heading, if supplied by the content. */
  labelledBy?: string;
  describedBy?: string;
  children: ReactNode;
  contentClassName?: string;
  closeOnBackdropClick?: boolean;
  /** Normal-motion duration in milliseconds. The default follows the host theme. */
  motionDurationMs?: number;
  /** Set false to close immediately except when a swipe follows the finger. */
  animateClose?: boolean;
  /** Prevent default to keep the drawer open. */
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  /** Prevent default to keep the drawer open when the backdrop is pressed. */
  onPointerDownOutside?: (event: DrawerPointerDownOutsideEvent) => void;
  onInteractOutside?: (event: DrawerPointerDownOutsideEvent) => void;
  onAfterCloseAutoFocus?: () => void;
  onContentAnimationEnd?: (open: boolean) => void;
}

export interface PluginSdkApp {
  usePluginResource<T>(
    options: PluginResourceOptions<T>,
  ): PluginResourceState<T>;
  experimental_useInitialLoadPending(pending: boolean): void;
  experimental_Icon: ComponentType<ExperimentalIconProps>;
  /**
   * Render provider slot override, then its logo, then its glyph, then fallback.
   * Pass a record from agent, machine, or environment provider queries;
   * an id-only record resolves frontend registrations, without fetching metadata.
   * Updates on plugin load, reload and unload. Throwing or recursive overrides
   * fall back to declared artwork. Logo assets render as currentColor masks.
   */
  experimental_ProviderIcon: ComponentType<ExperimentalProviderIconProps>;
  /**
   * Render a project's icon the way the sidebar project rail does: its icon file
   * when found, else its monogram, or the personal glyph. Decorative; renders
   * nothing for an unknown project or before the sidebar catalog loads.
   */
  experimental_ProjectIcon: ComponentType<ExperimentalProjectIconProps>;
  definePluginApp(setup: PluginAppSetup): PluginAppDefinition;
  useRpc<
    Contract extends PluginRpcContract = PluginRpcContract,
  >(): PluginRpcClient<Contract>;
  /** Read this plugin's opted-in result without another request. Ready current distinguishes active-entry responses from prior-entry snapshots. */
  experimental_useThreadBootstrapData(
    threadId: string,
    method: string,
  ): ExperimentalThreadBootstrapData;
  useRealtime(channel: string, handler: (payload: unknown) => void): void;
  /**
   * Observe the same shared connection that delivers `useRealtime` signals.
   * Use a subsequent transition to `connected` to reconcile server state that
   * may have changed while ephemeral signals could not be delivered. The first
   * connection can transition from `connecting` and is not a reconnection.
   */
  useRealtimeConnectionState(): PluginRealtimeConnectionState;
  useSettings(): PluginSettingsState;
  experimental_useAppContext(): experimental_AppContext;
  /** Read the visible window selection without fetching its content. */
  experimental_useVisibleAppContext(): ExperimentalVisibleAppContext;
  /**
   * The id of the plugin that owns the calling component: the same id
   * `api.pluginId` reports on the server, derived from the package name. Key
   * state the plugin keeps outside Omnyo's per-plugin storage with it, such as
   * localStorage entries and log prefixes, so a copy of the plugin published
   * under another name does not collide with the original. Experimental: see
   * docs/api_to_audit.md.
   */
  experimental_usePluginId(): string;
  /**
   * The answer shortcuts Omnyo binds while a pending interaction is open. Inside
   * a `pendingInteraction` component the form shows each option's shortcut and
   * registers a handler that chooses the option; outside one, the map is empty
   * and handlers never run. Experimental: see docs/api_to_audit.md.
   */
  experimental_useQuestionFormHost(): ExperimentalQuestionFormHost;
  experimental_useAppNavigate(): experimental_AppNavigate;
  /** Select one of this plugin's eligible fixed tabs on the current surface. */
  experimental_useAppPanel(): ExperimentalAppPanel;
  /** Omnyo's single undo history; re-renders when undo or redo availability changes. */
  experimental_useActionHistory(): ExperimentalActionHistory;
  /** Read or clear the owning tab's validated, session-scoped target. */
  experimental_useFixedTabTarget<Target extends JsonValue>(
    tab: ExperimentalPluginFixedTabReference<Target>,
  ): ExperimentalFixedTabTargetState<Target> | null;
  useComposer(): PluginComposerApi;
  /**
   * Every composer on screen that plugin composer customizations mount in,
   * oldest first: the thread page's composer, a `ThreadChat`'s composer, the
   * new-thread composer and open queued-message editors. Use it from a panel
   * or page that writes into a composer the user picks — label each by its
   * `scope`, then call `insert`, `focus` or `submit` on the chosen handle.
   *
   * Each handle is stable while its composer stays on screen and follows the
   * same lifetime rule as `useComposer()`. `setTextEffect` and `setInputLock`
   * have no effect here; call them from a composer slot's `useComposer()`.
   * The calling component re-renders when the list or any listed draft
   * changes.
   */
  useComposers(): readonly PluginComposerApi[];
  /** Reads the shared server Inbox projection, retaining older data on refresh errors. */
  experimental_useInboxSnapshot(): {
    snapshot: InboxSnapshot | null;
    status: "loading" | "ready" | "error";
    stale: boolean;
    refresh(): void;
  };
  /** Reads the selected chat's server work summary from the shared detail cache, independent of sidebar placement. */
  experimental_useThreadWork(
    threadId: string | null,
  ): NonNullable<PluginSidebarThread["experimental_work"]> | null;
  /**
   * The sidebar's live thread view (see {@link PluginSidebarThreadsState}).
   * Reads the host's own cache and realtime subscriptions, so it costs no
   * extra request and updates exactly when the built-in sidebar does.
   *
   * Active threads are uncapped. Opting into archived threads uses the host
   * archive query; request more pages through `experimental_archived`.
   * Opting into shelved threads uses the host shelf query; request more pages
   * through `experimental_shelved`. A thread belongs to one lifecycle:
   * archived when `archivedAt` is set, else shelved when
   * `experimental_shelvedAt` is set, else active.
   * `threads` contains the selected lifecycles across loaded pages. Thread
   * objects keep their identity across updates while the underlying entry is
   * unchanged, so a memoized row re-renders only when its own thread changed;
   * the array itself is new on every update. Window your rows (render only
   * what is on screen) as the built-in sidebar does — a list that mounts one
   * row per thread is slow on phones with many threads.
   * Experimental: see docs/api_to_audit.md.
   */
  /** Shared project navigation data; honor thread claims only while rendering the project tree. */
  experimental_useProjectSidebarItems(): readonly ExperimentalProjectSidebarGroup[];
  experimental_useSidebarThreads(options?: {
    /** Defaults to active threads only. An empty selection also means active. */
    experimental_lifecycles: readonly ("active" | "archived" | "shelved")[];
  }): PluginSidebarThreadsState;
  /**
   * The chats the owner has multi-selected in the active thread list, in the
   * list's display order; empty when nothing is selected. Omnyo's Group command
   * (Mod+G by default) and the selection's right-click menu act on them.
   * Experimental: see docs/api_to_audit.md.
   */
  experimental_useChatSelection(): readonly string[];
  /**
   * Publish the active thread list's multi-selection, in display order, so
   * Omnyo's commands and menus can act on it; pass an empty array when it
   * clears. Omnyo clears it
   * after grouping. Experimental: see docs/api_to_audit.md.
   */
  experimental_setChatSelection(threadIds: readonly string[]): void;
  /**
   * Omnyo's chat group actions (see {@link PluginThreadGroupActions}): the
   * same implementation Omnyo's Group command and menus use.
   * Experimental: see docs/api_to_audit.md.
   */
  experimental_useThreadGroupActions(): PluginThreadGroupActions;
  /**
   * Thread actions bound to the host's mutations (see
   * {@link PluginSidebarThreadActions}). Experimental: see
   * docs/api_to_audit.md.
   *
   * @internal Superseded by `experimental_useThreadActions`, the thread
   * action components, `useSdk().threads`, and `experimental_useAppNavigate()`; kept for
   * plugins built against older SDKs.
   */
  experimental_useSidebarThreadActions(): PluginSidebarThreadActions;
  /**
   * Archive an environment's active thread trees the way Omnyo's own list does:
   * optimistic removal, closing their split panes, leaving a route that shows
   * one of them, and one Undo toast that restores them and the route. The
   * promise rejects after Omnyo has shown an error toast. Experimental: see
   * docs/api_to_audit.md.
   */
  experimental_useArchiveEnvironmentThreads(): (
    environmentId: string,
  ) => Promise<void>;
  /**
   * Every thread action for one thread, in menu order (see
   * {@link PluginThreadAction} for grouping): Omnyo's own registrations first,
   * then plugins' in registration order. Registrations' `useData` hooks run
   * once for the app, so calling this per sidebar row costs one store
   * subscription and a pure `item` call per registration. Pass `keys` for a
   * row's quick actions. Experimental: see docs/api_to_audit.md.
   */
  experimental_useThreadActions(
    thread: PluginThreadActionTarget,
    options?: PluginThreadActionsOptions,
  ): readonly PluginThreadActionEntry[];
  /**
   * Every registered thread action with its static title and icon, in menu
   * order and independent of any thread: what a quick-action picker lists.
   * Experimental: see docs/api_to_audit.md.
   */
  experimental_useThreadActionRegistrations(): readonly PluginThreadActionRegistrationInfo[];
  /**
   * Omnyo's thread menu behind a trigger (see
   * {@link PluginThreadActionsMenuProps}): the same items, order, choice
   * submenus and compact drawer as the thread header's menu. Experimental: see
   * docs/api_to_audit.md.
   */
  experimental_ThreadActionsMenu: ComponentType<PluginThreadActionsMenuProps>;
  /**
   * Omnyo's thread menu on right-click or long-press (see
   * {@link PluginThreadActionsContextMenuProps}). Experimental: see
   * docs/api_to_audit.md.
   */
  experimental_ThreadActionsContextMenu: ComponentType<PluginThreadActionsContextMenuProps>;
  /**
   * Omnyo's thread menu groups, for a registration that joins one:
   * `open` (split), `organize` (copy, read, pin, move, rename), `settings`,
   * and `lifecycle` (archive, delete). Experimental: see docs/api_to_audit.md.
   */
  experimental_THREAD_ACTION_GROUPS: {
    readonly open: "1_open";
    readonly organize: "2_organize";
    readonly settings: "3_settings";
    readonly lifecycle: "4_lifecycle";
  };
  /**
   * The pull request for one thread's branch (see
   * {@link PluginSidebarThreadPullRequestState}).
   *
   * Per row and opt-in, because it costs a git-host lookup: it is NOT on the
   * thread payload every sidebar loads. Threads sharing an environment share
   * one query, and the host owns the polling and staleness rules — an open PR
   * with pending checks refreshes, a merged one does not.
   *
   * Experimental: see docs/api_to_audit.md.
   */
  experimental_useSidebarThreadPullRequest(
    threadId: string,
  ): PluginSidebarThreadPullRequestState;
  /**
   * Per-row drag-to-split support (see {@link PluginSidebarThreadSplit}).
   * Call it once per rendered row, like the built-in sidebar does.
   * Experimental: see docs/api_to_audit.md.
   */
  experimental_useSidebarThreadSplit(
    threadId: string,
  ): PluginSidebarThreadSplit;
  /**
   * Whether the composer holds an unsent draft for one thread (see
   * {@link PluginSidebarThreadDraftState}). Per row, because a draft is
   * client-local composer state the array-wide view cannot carry. Reports
   * false for an unknown thread.
   */
  useSidebarThreadDraft(threadId: string): PluginSidebarThreadDraftState;
  /**
   * The ids of every sidebar thread that currently holds an unsent draft, for
   * rollups on collapsed groups. One subscription for the whole list; prefer
   * {@link PluginSdkApp.useSidebarThreadDraft} inside a row.
   */
  useSidebarThreadDraftIds(): ReadonlySet<string>;
  /**
   * The row status another plugin set on this thread (see
   * {@link PluginSidebarThreadRowStatus}), or null. Draw it where Omnyo's row
   * would: in place of the draft glyph, with its `tone`.
   */
  useSidebarThreadRowStatus(
    threadId: string,
  ): PluginSidebarThreadRowStatus | null;
  /**
   * Every row status currently set, by thread id, for rollups on collapsed
   * groups. One subscription for the whole list; prefer
   * {@link PluginSdkApp.useSidebarThreadRowStatus} inside a row.
   */
  useSidebarThreadRowStatuses(): ReadonlyMap<
    string,
    PluginSidebarThreadRowStatus
  >;
  /**
   * The whole split layout (see {@link PluginSidebarSplitLayout}), or null
   * when nothing is split. One subscription for the whole list.
   */
  useSidebarSplitLayout(): PluginSidebarSplitLayout | null;
  /**
   * The jump shortcut assigned to this row while the app command modifier is
   * held (see {@link PluginSidebarThreadShortcut}), or null the rest of the
   * time. Omnyo assigns keys in DOM order to rows carrying the
   * `data-sidebar-thread-shortcut-target` attribute, so a row that omits it
   * always reads null.
   */
  useSidebarThreadShortcut(
    threadId: string,
  ): PluginSidebarThreadShortcut | null;
  /**
   * A thread's display title with `@project:`, `@section:`, and `@thread:`
   * mentions rendered as Omnyo's chips (see {@link PluginThreadTitleProps}).
   * Inline content; wrap it in your own truncating container. The plain-text
   * form is `displayTitle` on the thread.
   */
  ThreadTitle: ComponentType<PluginThreadTitleProps>;
  /**
   * Omnyo's thread status glyph (see {@link PluginThreadStatusGlyphProps}): the
   * same icons, colors, and accessible labels as Omnyo's own thread lists.
   * Experimental: see docs/api_to_audit.md.
   */
  experimental_ThreadStatusGlyph: ComponentType<PluginThreadStatusGlyphProps>;
  /** The native questions and callback panel used by core's composer. */
  experimental_ThreadAttention: ComponentType<{ threadId: string }>;
  experimental_threadIndicators: typeof import("@omnyo/domain").threadIndicators;
  /**
   * Omnyo's environment provider catalog (see
   * {@link PluginEnvironmentProvidersState}), the directory a thread's
   * `environment.providerId` points into. Reads the host's own cached
   * catalog, so it costs no extra request.
   */
  useEnvironmentProviders(): PluginEnvironmentProvidersState;
  /**
   * Omnyo's public API client bound to this plugin (see
   * {@link experimental_PluginBrowserSdk}). The first choice for reading and mutating
   * Omnyo state from a frontend: creating or renaming thread sections, moving a
   * thread into one, pinning, unarchiving, spawning a thread. The host's own
   * caches refresh over realtime, so a mutation made here shows up in Omnyo's
   * surfaces without further work. Reserve `useRpc` for work that needs your
   * server: secrets, host files, or your plugin's own storage.
   *
   * Thread title, section, parent, pin, and unpin writes are optimistic in
   * Omnyo's surfaces. Synchronous calls share one cache transaction; writes to
   * the same thread execute in order, so unpin and move can be submitted
   * together. Unarchive, environment-group archive, project/machine/environment
   * renames, and project/section removal are also optimistic and roll back on
   * failure. Created sections enter the cache when the server assigns their id.
   * Navigation belongs to `experimental_useAppNavigate()`; archive and delete
   * confirmation to the thread action menus.
   *
   * The client is stable for the plugin's lifetime, so it is safe in effect
   * and callback dependency lists.
   */
  useSdk(): experimental_PluginBrowserSdk;
  /**
   * The provider directory (see {@link PluginProvidersState}). Reads the
   * host's own cached provider roster, so a plugin that shows a thread's
   * provider never re-vendors provider names, icons, or copy. Experimental:
   * see docs/api_to_audit.md.
   */
  experimental_useProviders(): PluginProvidersState;
  /**
   * The active code theme as a VS Code theme file (see
   * {@link PluginCodeThemeState}), for a plugin that renders code with an
   * engine of its own and needs Omnyo's palette to reach it. Experimental: see
   * docs/api_to_audit.md.
   */
  experimental_useCodeTheme(): PluginCodeThemeState;
  /**
   * Writes content to the system clipboard through Omnyo's own clipboard writer,
   * the one Omnyo's copy actions use. A plain function, callable from
   * components, content scripts, and command callbacks. Omnyo Desktop writes
   * through the native clipboard, so copies work without window focus or a
   * secure origin; browsers use the Clipboard API, then the copy command.
   * Resolves true once the clipboard holds the content and false when every
   * write path failed; it never rejects. Callers own their success and
   * failure feedback. Experimental: see docs/api_to_audit.md.
   */
  experimental_copyToClipboard(
    content: ExperimentalClipboardContent,
  ): Promise<boolean>;
  /**
   * The desktop client's native File resolver, or null in a browser without
   * the capability. Generated Files have a null classification. Native errors
   * reject; callers must not substitute a server clipboard or another resolver.
   * File possession does not establish a fresh gesture or execution-host identity.
   * Core composer paste and drop use this same path. Experimental: see docs/api_to_audit.md.
   */
  experimental_getNativeFileResolver(): ExperimentalNativeFileResolver | null;
  /**
   * The host-owned chat component (see {@link ThreadChatProps}).
   */
  ThreadChat: ComponentType<ThreadChatProps>;
  /**
   * A controlled compact drawer. The host defers initially mounting its
   * content, retains mounted content on close, and scopes its portals to
   * the rendering plugin. Render it inside a plugin slot.
   * Experimental: see docs/api_to_audit.md.
   */
  experimental_ResponsiveDrawerShell: ComponentType<ExperimentalResponsiveDrawerShellProps>;
  /**
   * The host-owned chat-message markdown renderer (see
   * {@link MarkdownProps}).
   */
  Markdown: ComponentType<MarkdownProps>;
  experimental_ImagePreview: ComponentType<ExperimentalImagePreviewProps>;
  /**
   * A real anchor whose ordinary HTTP(S) activation uses Omnyo's URL preference.
   * Experimental: see docs/api_to_audit.md.
   */
  UrlLink: ComponentType<UrlLinkProps>;
  /** Host-rendered live-file link backed by the shared navigation controller. */
  experimental_FileLink: ComponentType<ExperimentalFileLinkProps>;
  /**
   * The host-owned new-thread compose surface (see
   * {@link NewThreadComposerProps}). Experimental: see
   * docs/api_to_audit.md for what to audit before the prefix drops.
   */
  experimental_NewThreadComposer: ComponentType<NewThreadComposerProps>;
  /**
   * Omnyo's textarea with voice input (see
   * {@link ExperimentalVoiceInputTextareaProps}): the same microphone
   * preference, transcription service, and error handling as the prompt box.
   * Experimental: see docs/api_to_audit.md.
   */
  experimental_VoiceInputTextarea: ComponentType<ExperimentalVoiceInputTextareaProps>;
  /**
   * Omnyo's controlled provider/model/reasoning picker. Provider changes emit
   * only after the new provider's verified defaults and capabilities resolve,
   * so `onChange` always receives one coherent value. Experimental: see
   * docs/api_to_audit.md.
   */
  experimental_ProviderModelPicker: ComponentType<ExperimentalProviderModelPickerProps>;
  /**
   * Omnyo's controlled permission-mode picker. The host resolves provider
   * capabilities and the routed machine's permission ceiling. Experimental:
   * see docs/api_to_audit.md.
   */
  experimental_PermissionModePicker: ComponentType<ExperimentalPermissionModePickerProps>;
  /**
   * Omnyo's branch picker with its branch-options loading for one host and
   * project (see {@link BranchPickerProps}) — the same control
   * the New Thread composer renders as "Branch from". Experimental: see
   * docs/api_to_audit.md.
   */
  experimental_BranchPicker: ComponentType<BranchPickerProps>;
  /**
   * Search and refresh the branch list for one project source. `query` is
   * debounced before it reaches the host, so a control can pass it on every
   * keystroke; filtering the returned lists stays the caller's job.
   * Experimental: see docs/api_to_audit.md.
   */
  experimental_useBranches(args: UseBranchesArgs): BranchesState;
  /**
   * Inspect the checkout state for one project source. Experimental: see
   * docs/api_to_audit.md.
   */
  experimental_useCheckoutState(args: UseCheckoutStateArgs): CheckoutState;
  /**
   * Git state and actions for the thread that hosts the calling component
   * (see {@link ExperimentalThreadGit}). Returns null outside a thread
   * (for example on the compose screen), when the thread has no git
   * workspace, when its environment is unavailable or archived, or when the
   * owner turned Git changes off in Settings. Omnyo's thread header renders git
   * status only through this hook. Experimental: see docs/api_to_audit.md.
   */
  experimental_useThreadGit(): ExperimentalThreadGit | null;
  /**
   * Omnyo's merge base branch picker for the thread that hosts the calling
   * component: the same control and branch loading Omnyo uses to choose what
   * the thread's changes compare with. Renders nothing outside a thread or
   * when no merge base applies. Experimental: see docs/api_to_audit.md.
   */
  experimental_ThreadMergeBasePicker: ComponentType<ExperimentalThreadMergeBasePickerProps>;
  /**
   * The host-owned source viewer (see {@link SourceCodeProps}). Renders
   * supplied source text with Omnyo's syntax highlighting, gutters, and live code
   * theme, and honours an active `experimental_sourceCodeRenderer`
   * replacement. Experimental: see docs/api_to_audit.md.
   */
  experimental_SourceCode: ComponentType<SourceCodeProps>;
  /**
   * The host-owned diff viewer (see {@link DiffProps}). Renders supplied patch
   * content with Omnyo's normalization, optional full-file context expansion,
   * syntax highlighting, unified/split presentation, and live code theme, and
   * honours an active
   * `experimental_diffRenderer` replacement. Experimental: see
   * docs/api_to_audit.md.
   */
  experimental_Diff: ComponentType<DiffProps>;
  /** @internal Superseded by `useComposer()`; kept for plugins built against older SDKs. */
  useComposerView(): ComposerView;
}
