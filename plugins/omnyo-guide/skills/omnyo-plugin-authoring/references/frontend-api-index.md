# Frontend API symbol index

Use this index to check public imports from `@omnyo/plugin-sdk/app`.
Read the other frontend references for behavior, fields, and examples.
Read the installed SDK declarations for the exact current signatures.

## Runtime values

- `experimental_Icon`
- `experimental_ProviderIcon`
- `experimental_ProjectIcon` — decorative project artwork from the sidebar
  catalog, with monogram or personal-glyph fallback; renders nothing for an
  unknown project or while the catalog loads. Pass `projectId`, `className?`
  and `style?`; the host owns icon discovery and caching.

- `definePluginApp`
- `ThreadChat`
- `experimental_ResponsiveDrawerShell` — the host responsive drawer; pass
  controlled `open` and `onOpenChange`, content, and an accessible heading or
  `srLabel`. `ExperimentalResponsiveDrawerShellProps` defines its focus,
  backdrop, and animation callbacks.
- `Markdown`
- `experimental_ImagePreview` — host image lightbox for an authenticated
  same-origin blob URL. Pass `src`, `alt`, PNG/JPEG/WebP `mimeType`, `title?`
  and `className?`; the caller owns authenticated byte reads and object URL
  disposal. The component does not fetch files.
- `experimental_FileLink`
- `UrlLink`
- `experimental_NewThreadComposer`
- `experimental_VoiceInputTextarea` — a controlled textarea with Omnyo's voice
  input
- `experimental_ProviderModelPicker`
- `experimental_PermissionModePicker`
- `experimental_BranchPicker` — the host's branch picker with its options
  loading, for an environment provider's inputs control
- `experimental_useBranches` — searchable local and remote branch lists with
  host-backed refresh for a project source
- `experimental_useCheckoutState` — checkout facts for composing a plugin's
  own checkout branch control with `experimental_useBranches`
- `experimental_useThreadGit` — the hosting thread's branch, changes, commits
  and pull request, with Omnyo's own commit, merge, file-open and diff actions
- `experimental_ThreadMergeBasePicker` — Omnyo's merge base branch picker for the
  hosting thread
- `experimental_SourceCode`
- `experimental_Diff`
- `useRpc`
- `useRealtime`
- `useRealtimeConnectionState`
- `useSettings`
- `experimental_useAppContext`
- `experimental_useVisibleAppContext` — the window-local visible view, project,
  chat, and panel; excludes retained or hidden panels. Returns
  `ExperimentalVisibleAppContext`.
- `experimental_useInboxSnapshot` — the shared server Inbox projection with
  `snapshot`, `status`, `stale`, and `refresh()`. A refresh error retains the
  older snapshot and reports that it is stale.
- `experimental_useChatSelection` — selected chat IDs in display order.
- `experimental_setChatSelection` — publish selection from a replacement chat
  list; pass an empty array when the selection clears.
- `experimental_useThreadGroupActions` — core group, rename, ungroup, and move
  actions, including host toasts and Undo where supported.
- `experimental_useProjectSidebarItems` — shared project navigation groups;
  honor thread claims only while rendering the project tree.
- `experimental_usePluginId` — this plugin's id, for keying browser-side
  state such as localStorage entries
- `experimental_useInitialLoadPending(pending)` — hold the initial conversation
  reveal for missing first-layout data, never for cached-data refreshes. This
  supporting hold releases after one second and has no effect after reveal or
  outside a conversation. Plugin RPC, settings and styles participate
  automatically.
- `experimental_useThreadBootstrapData(threadId, method)` — observe this
  plugin's opted-in RPC result in the shared conversation bootstrap without
  starting a request. Returns `ExperimentalThreadBootstrapData`; a ready
  result's `current` distinguishes the active route entry from an older cached
  snapshot. Opt in through `PluginRpcMethodContract.experimental_threadBootstrap`.
- `experimental_useQuestionFormHost` — Omnyo's answer shortcuts inside a
  `pendingInteraction` form
- `experimental_useAppNavigate` — navigation, including experimental thread-open prefetch
- `experimental_useAppPanel`
- `experimental_useActionHistory` — record user actions in Omnyo's single undo
  history; never bind Cmd+Z yourself
- `experimental_useFixedTabTarget`
- `useComposer`
- `useComposers`
- `experimental_useThreadWork(threadId)` — one chat's server work summary
  from the shared thread-detail cache, including Shelf and Archive; `null`
  disables the read and is returned until the detail loads
- `useComposerView` — deprecated, runtime-only for older plugins; use `useComposer`
- `experimental_useSidebarThreads`
- `experimental_useSidebarThreadActions` — deprecated, runtime-only for older
  plugins; use the thread action registry, `useSdk().threads`, and
  `experimental_useAppNavigate()`
- `experimental_useArchiveEnvironmentThreads` — archive an environment's
  threads with Omnyo's pane cleanup, route repair, and Undo toast
- `experimental_useThreadActions` — every thread action for one thread, in
  menu order, or only `keys` for a row's quick actions
- `experimental_useThreadActionRegistrations` — every registered thread
  action's static title and icon, for a quick-action picker
- `experimental_ThreadActionsMenu` — Omnyo's thread menu behind your trigger
- `experimental_ThreadActionsContextMenu` — Omnyo's thread menu on right-click
  or long-press
- `experimental_THREAD_ACTION_GROUPS` — Omnyo's thread menu group names
- `experimental_useSidebarThreadPullRequest`
- `experimental_useSidebarThreadSplit`
- `useSidebarThreadDraft` — whether the composer holds an unsent draft for
  one thread, for the pencil glyph Omnyo's row paints
- `useSidebarThreadDraftIds` — every thread id with an unsent draft, for
  collapsed-group rollups
- `useSidebarThreadRowStatus` — the row status another plugin's app-wide
  script set on a thread, or null
- `useSidebarThreadRowStatuses` — every row status by thread id, for
  collapsed-group rollups
- `useSidebarSplitLayout` — the whole split layout with the thread each pane
  shows, or null when nothing is split
- `useSidebarThreadShortcut` — the jump shortcut assigned to a row while the
  app command modifier is held, or null
- `ThreadTitle` — a thread's display title with its `@project:`, `@section:`,
  and `@thread:` mentions rendered as Omnyo's chips
- `experimental_ThreadStatusGlyph` — Omnyo's thread status glyph for an
  indicator you resolve, with another plugin's row status and Omnyo's labels
- `experimental_ThreadAttention` — render the host's native question/callback
  panel, including answer and skip actions, with `{ threadId }`.
- `experimental_threadIndicators` — shared `resolve`, `label`, `working` and
  `attention` functions used by core thread rows and collapsed groups. Reuse
  these functions instead of maintaining another status-priority table.
- `useEnvironmentProviders` — Omnyo's environment provider catalog, for naming
  and drawing the environment a thread runs in
- `useSdk` — Omnyo's public API client bound to this plugin, the same areas the
  `api` CLI and the backend `api.sdk` expose
- `experimental_useProviders`
- `experimental_useCodeTheme`
- `experimental_copyToClipboard`
- `experimental_getNativeFileResolver` — this desktop client's resolver for
  disk-backed `File` values, or null when unavailable

## Type exports

- `ExperimentalNativeFileClassification`
- `ExperimentalNativeFileResolver`
- `ExperimentalAppIcons`
- `ExperimentalIconRegistration`
- `ExperimentalIconProps`
- `ExperimentalProviderIconProps`
- `ExperimentalProjectIconProps` — `projectId`, optional `className` and `style`
- `ExperimentalImagePreviewProps` — `src`, `alt`, raster `mimeType`, optional
  `title` and `className`
- `ExperimentalThreadBootstrapData` — `pending`, `unavailable`, `error` with
  `message` and `updatedAt`, or `ready` with JSON `result`, `updatedAt` and
  `current`

- `PluginHomepageSectionProps`
- `PluginSettingsSectionProps`
- `ExperimentalAppOverlayProps`
- `ExperimentalTitleBarCenterProps`
- `ExperimentalThreadCompanionProps` — `threadId`, `projectId`, and
  `placement`, an `ExperimentalThreadCompanionPlacement` of `"aside"`,
  `"toolbar"`, or `"inline"`
- `PluginNavPanelProps`
- `PluginThreadPanelProps`
- `PluginNewThreadPanelProps`
- `PluginPendingInteractionView`
- `PluginPendingInteractionProps`
- `ExperimentalQuestionFormHost`
- `ExperimentalQuestionShortcut`
- `BranchPickerProps`
- `UseBranchesArgs`
- `BranchesState`
- `UseCheckoutStateArgs`
- `CheckoutState`
- `PluginEnvironmentProviderInputsChange`
- `PluginEnvironmentProviderInputsProps`
- `PluginEnvironmentProviderInputsRegistration` — the registration accepted by
  `app.slots.experimental_environmentProviderInputs`
- `PluginMachineProviderInputsChange`
- `PluginMachineProviderInputsProps`
- `PluginMachineProviderInputsRegistration` — the registration accepted by
  `app.slots.experimental_machineProviderInputs`
- `PluginSidebarFooterActionProps`
- `ExperimentalSidebarFooterDisclosureProps`
- `PluginThreadListProps`
- `PluginThreadHeaderActionProps`
- `ExperimentalThreadGit` — `loading`, or `ready` with branch, working tree,
  comparison, pull request and actions; read with `experimental_useThreadGit`
- `ExperimentalThreadGitChanges`
- `ExperimentalThreadGitFile`
- `ExperimentalThreadGitComparison`
- `ExperimentalThreadGitCommit`
- `ExperimentalThreadGitPullRequestActions`
- `ExperimentalThreadGitMergeMethod`
- `ExperimentalThreadGitFileSource`
- `ExperimentalThreadMergeBasePickerProps`
- `PluginThreadViewProps`
- `ExperimentalPluginBrowserToolbarActionProps`
- `ExperimentalPluginBrowserPage`
- `ExperimentalPluginBrowserPageEvaluateOptions`
- `ExperimentalPluginBrowserPageWorld`
- `PluginFileOpenerSource`
- `PluginFileOpenerProps`
- `CodeOverflowMode`
- `DiffViewMode`
- `SourceCodeLineRange`
- `ExperimentalDiffFileContent`
- `ExperimentalDiffFullFileContents`
- `SourceCodeProps`
- `DiffProps`
- `PluginSourceCodeRendererProps`
- `PluginDiffRendererProps`
- `PluginMessageDirectiveMessage`
- `PluginMessageDirectiveOpenWorkspaceFile`
- `PluginMessageDirectiveProps`
- `ExperimentalCodeFenceRendererProps`
- `PluginHomepageSectionRegistration`
- `PluginSettingsSectionRegistration`
- `ExperimentalAppOverlayRegistration`
- `ExperimentalTitleBarCenterRegistration` — the registration accepted by
  `app.slots.experimental_titleBarCenter`
- `ExperimentalSidebarEntryRegistration` and `ExperimentalSidebarEntryStatus` —
  the registration accepted by `app.slots.experimental_sidebarEntry` and what
  its `useStatus` hook returns
- `ExperimentalThreadCompanionRegistration` — the registration accepted by
  `app.slots.experimental_threadCompanion`
- `ExperimentalFixedTabTargetContract`
- `ExperimentalPluginFixedTabReference`
- `PluginFixedTabRegistration`
- `PluginFixedTabDeclaration`
- `PluginNavPanelRegistration`
- `PluginPanelActionOpenOptions`
- `PluginThreadPanelActionContext`
- `PluginThreadPanelActionRegistration`
- `PluginNewThreadPanelActionContext`
- `PluginNewThreadPanelActionRegistration`
- `PluginPendingInteractionRegistration`
- `PluginSidebarFooterActionContext`
- `PluginSidebarFooterActionRegistration`
- `ExperimentalSidebarFooterActionContext`
- `ExperimentalSidebarFooterItemBase`
- `ExperimentalSidebarFooterActionRegistration`
- `ExperimentalSidebarFooterDisclosureRegistration`
- `ExperimentalSidebarFooterItemRegistration`
- `ExperimentalSidebarFooterDisclosureController`
- `ExperimentalSidebarFooter`
- `PluginSidebarThreadIndicator`
- `PluginSidebarThreadActivity`
- `PluginSidebarThread`
- `PluginSidebarPullRequest`
- `PluginSidebarThreadPullRequestState`
- `PluginSidebarProject`
- `PluginSidebarSection`
- `PluginSidebarThreadsState`
- `PluginProvidersState`
- `PluginCodeThemeTokenRule`
- `PluginCodeThemeData`
- `PluginCodeThemeState`
- `ExperimentalClipboardContent`
- `PluginSidebarThreadDraftState`
- `PluginSidebarThreadRowStatus`
- `PluginSidebarThreadShortcut`
- `PluginThreadTitleProps`
- `PluginThreadStatusGlyphProps`
- `PluginEnvironmentProvider`
- `PluginEnvironmentProvidersState`
- `PluginBoundThreadsArea`
- `experimental_PluginBrowserSdk`
- `PluginThreadHeaderActionRegistration`
- `PluginThreadViewRegistration` — the registration accepted by
  `app.slots.experimental_threadView`
- `PluginThreadActionTarget`
- `PluginThreadActionChoice`
- `PluginThreadActionChoices`
- `PluginThreadActionRunInput`
- `PluginThreadAction`
- `PluginThreadActionDataInput` — what a registration's `useData` receives (`threadIds`)
- `PluginThreadActionItemInput` — what a registration's `item` receives
- `PluginThreadActionRegistration` — the registration accepted by
  `app.slots.experimental_threadAction`
- `PluginBoundThreadAction`
- `PluginThreadActionEntry` — one row of `experimental_useThreadActions`
- `PluginThreadActionRegistrationInfo`
- `PluginThreadActionsOptions`
- `PluginThreadActionsInlineItem`
- `PluginThreadActionsTriggerProps` — what a thread menu's `trigger` must
  spread onto its button
- `PluginThreadActionsMenuProps`
- `PluginThreadActionsContextMenuProps`
- `ExperimentalPluginBrowserToolbarActionRegistration`
- `PluginSidebarSplitPane`
- `PluginSidebarSplitLayout`
- `PluginSidebarThreadSplit`
- `PluginThreadListRegistration`
- `PluginFileOpenerRegistration`
- `PluginSourceCodeRendererRegistration`
- `PluginDiffRendererRegistration`
- `PluginMessageDirectiveRegistration`
- `ExperimentalCodeFenceRendererRegistration`
- `ExperimentalCodeFenceStatus`
- `ThreadChatMessageReference`
- `PluginTargetedPanelActionOpenOptions`
- `PluginMessageActionContext`
- `PluginMessageActionRegistration`
- `PluginAppCommands`
- `PluginCommandContext`
- `PluginCommandShortcut`
- `PluginCommandRegistration`
- `ExperimentalComposerCommandRegistration`
- `PluginProviderIconRegistration`
- `PluginTimelineRowPresentation`
- `PluginTimelineRowStatus`
- `PluginTimelineRendererRow`
- `PluginTimelineRendererProps`
- `PluginTimelineRendererRegistration`
- `PluginAppSlots`
- `PluginAppComposer`
- `PluginContentScriptContext`
- `PluginContentScriptDisposer`
- `PluginContentScriptRegistration`
- `PluginAppContentScripts`
- `PluginAppBuilder`
- `PluginAppSetup`
- `PluginAppDefinition`
- `PluginRpcClient`
- `PluginSettingsState`
- `PluginRealtimeConnectionState`
- `PluginComposerScope`
- `ComposerCustomization`
- `ExperimentalComposerPopupRegistration`
- `ComposerPlusMenuItem`
- `ComposerSendMenuItem`
- `ComposerSubmitOptions`
- `ComposerSelection`
- `ComposerRichTextSpec`
- `ComposerDraft`
- `ComposerDraftSnapshot`
- `ComposerDraftReplacement`
- `ComposerAttachment`
- `ComposerMention`
- `ComposerInsertPart`
- `ComposerInsertOptions`
- `PluginComposerTextEffect`
- `ExperimentalComposerSuggestion`
- `PluginComposerThreadRowStatus`
- `PluginComposerMention`
- `PluginComposerApi`
- `ThreadChatMessageAction`
- `ThreadChatProps`
- `ExperimentalProviderModelPickerValue`
- `ExperimentalProviderModelPickerRouting`
- `ExperimentalProviderModelPickerProps`
- `ExperimentalPermissionModePickerProps`
- `NewThreadRequest`
- `NewThreadComposerProps`
- `ExperimentalVoiceInputTextareaProps`
- `MarkdownProps`
- `UrlLinkProps`
- `ExperimentalLiveFileTarget`
- `ExperimentalFileLocation`
- `ExperimentalFileOpenOptions`
- `ExperimentalFileLinkProps`
- `ExperimentalAppPanelSurface`
- `ExperimentalFixedTabTargetState`
- `ExperimentalOpenFixedTabOptions`
- `ExperimentalAppPanel`
- `ExperimentalActionHistoryEntry` — one action to record: `label` names it in
  the Undid/Redid toast; `undo` and `redo` reject to show Omnyo's error toast
- `ExperimentalActionHistory` — what `experimental_useActionHistory` returns:
  `record(entry)` after a user action succeeds, `undo()` and `redo()` replay
  the newest entry as the shortcuts do, plus `canUndo` and `canRedo`
- `experimental_AppContext`
- `experimental_AppNavigate`
- `PluginSdkApp`
- `JsonValue`
- `ReadonlyJsonValue`
- `PluginRpcCallArgs`
- `PluginRpcContract`
- `PluginRpcError`
- `PluginRpcErrorCode`
- `PluginRpcHandlers`
- `PluginRpcIssuePathSegment`
- `PluginRpcMethodContract`
- `PluginRpcResult`
- `PluginRpcValidationIssue`
- `StandardSchemaV1`
- `StandardSchemaV1InferInput`
- `StandardSchemaV1InferOutput`
- `StandardSchemaV1Issue`
- `StandardSchemaV1Result`

## Project navigation and chat groups

- `ExperimentalProjectSidebarMenuItem` — an item action with an ID, label,
  optional icon and destructive marker, and `run()`.
- `ExperimentalProjectSidebarItem` — a navigation item with optional children,
  status, count, unread state, rename/reorder/drop callbacks, and menu actions.
- `ExperimentalProjectSidebarGroup` — a project's items; core stamps the
  optional owner key.
- `ExperimentalProjectSidebarItemsRegistration` — register `id` and
  `useItems({ projects })` through `app.slots.experimental_projectSidebarItems`.
- `PluginSidebarThreadGroup` — a named visual group within one project.
- `PluginThreadGroupActions` — the group action contract returned by
  `experimental_useThreadGroupActions`. Grouping keeps only chats from the
  first chat's project; ungrouping removes the group and preserves its chats.

`ExperimentalComposerSelection` and `ExperimentalComposerSubmitOptions` are
compatibility aliases for `ComposerSelection` and `ComposerSubmitOptions`.
`ComposerStructuredDraft` and `PluginSidebarThreadActions` are internal
compatibility types; use `ComposerDraft` and the current thread action registry
for new plugins.
