import { describe, expectTypeOf, it } from "vitest";
import type {
  OmnyoRealtime as RootOmnyoRealtime,
  OmnyoSdk as RootOmnyoSdk,
  OmnyoRealtimeConnectionEvent as RootRealtimeConnection,
  EnvironmentStatusResult as RootEnvironmentStatus,
  FileReadResult as RootFileRead,
  GuideRenderResult as RootGuideRender,
  HostGetResult as RootHostGet,
  PluginListResult as RootPluginList,
  PluginGetSourceResult as RootPluginGetSource,
  PluginApplyUpdateResult as RootPluginApplyUpdate,
  PluginCatalogStatusResult as RootPluginCatalogStatus,
  PermissionMode as RootPermissionMode,
  ProjectAttachmentUploadResult as RootProjectAttachmentUpload,
  ProjectFileContentResult as RootProjectFileContent,
  ProjectGetResult as RootProjectGet,
  ProjectWorkspaceRoutingArgs as RootProjectWorkspaceRoutingArgs,
  ProviderListArgs as RootProviderListArgs,
  ProviderListResult as RootProviderList,
  ProviderModelsArgs as RootProviderModelsArgs,
  StatusResult as RootStatus,
  SystemVersionResult as RootSystemVersion,
  TerminalCreateArgs as RootTerminalCreateArgs,
  TerminalListResult as RootTerminalListResult,
  ThemeCatalogResult as RootThemeCatalog,
  ThemeSetInput as RootThemeSetInput,
  ThreadSectionListResult as RootThreadSectionList,
  ThreadSpawnResult as RootThreadSpawn,
} from "@omnyo/sdk";
import type {
  OmnyoSdk as BrowserOmnyoSdk,
  BrowserOmnyoSdk as BrowserRuntimeOmnyoSdk,
  OmnyoRealtimeConnectionEvent as BrowserRealtimeConnection,
  EnvironmentStatusResult as BrowserEnvironmentStatus,
  FileReadResult as BrowserFileRead,
  GuideRenderResult as BrowserGuideRender,
  HostGetResult as BrowserHostGet,
  PluginListResult as BrowserPluginList,
  PluginGetSourceResult as BrowserPluginGetSource,
  PluginApplyUpdateResult as BrowserPluginApplyUpdate,
  PluginCatalogStatusResult as BrowserPluginCatalogStatus,
  ProjectAttachmentUploadResult as BrowserProjectAttachmentUpload,
  ProjectFileContentResult as BrowserProjectFileContent,
  ProjectGetResult as BrowserProjectGet,
  ProjectWorkspaceRoutingArgs as BrowserProjectWorkspaceRoutingArgs,
  ProviderListArgs as BrowserProviderListArgs,
  ProviderListResult as BrowserProviderList,
  ProviderModelsArgs as BrowserProviderModelsArgs,
  StatusResult as BrowserStatus,
  SystemVersionResult as BrowserSystemVersion,
  TerminalCreateArgs as BrowserTerminalCreateArgs,
  TerminalListResult as BrowserTerminalListResult,
  ThemeCatalogResult as BrowserThemeCatalog,
  ThemeSetInput as BrowserThemeSetInput,
  ThreadSectionListResult as BrowserThreadSectionList,
  ThreadSpawnResult as BrowserThreadSpawn,
} from "@omnyo/sdk/browser";
import type {
  OmnyoSdk as CoreOmnyoSdk,
  OmnyoRealtimeConnectionEvent as CoreRealtimeConnection,
  EnvironmentStatusResult as CoreEnvironmentStatus,
  FileReadResult as CoreFileRead,
  GuideRenderResult as CoreGuideRender,
  HostGetResult as CoreHostGet,
  PluginListResult as CorePluginList,
  PluginGetSourceResult as CorePluginGetSource,
  PluginApplyUpdateResult as CorePluginApplyUpdate,
  PluginCatalogStatusResult as CorePluginCatalogStatus,
  ProjectAttachmentUploadResult as CoreProjectAttachmentUpload,
  ProjectFileContentResult as CoreProjectFileContent,
  ProjectGetResult as CoreProjectGet,
  ProjectWorkspaceRoutingArgs as CoreProjectWorkspaceRoutingArgs,
  ProviderListArgs as CoreProviderListArgs,
  ProviderListResult as CoreProviderList,
  ProviderModelsArgs as CoreProviderModelsArgs,
  StatusResult as CoreStatus,
  SystemVersionResult as CoreSystemVersion,
  TerminalCreateArgs as CoreTerminalCreateArgs,
  TerminalListResult as CoreTerminalListResult,
  ThemeCatalogResult as CoreThemeCatalog,
  ThemeSetInput as CoreThemeSetInput,
  ThreadSectionListResult as CoreThreadSectionList,
  ThreadSpawnResult as CoreThreadSpawn,
} from "@omnyo/sdk/core";
import type {
  OmnyoSdk as NodeOmnyoSdk,
  OmnyoRealtimeConnectionEvent as NodeRealtimeConnection,
  EnvironmentStatusResult as NodeEnvironmentStatus,
  FileReadResult as NodeFileRead,
  GuideRenderResult as NodeGuideRender,
  HostGetResult as NodeHostGet,
  PluginListResult as NodePluginList,
  PluginGetSourceResult as NodePluginGetSource,
  PluginApplyUpdateResult as NodePluginApplyUpdate,
  PluginCatalogStatusResult as NodePluginCatalogStatus,
  ProjectAttachmentUploadResult as NodeProjectAttachmentUpload,
  ProjectFileContentResult as NodeProjectFileContent,
  ProjectGetResult as NodeProjectGet,
  ProjectWorkspaceRoutingArgs as NodeProjectWorkspaceRoutingArgs,
  ProviderListArgs as NodeProviderListArgs,
  ProviderListResult as NodeProviderList,
  ProviderModelsArgs as NodeProviderModelsArgs,
  StatusResult as NodeStatus,
  SystemVersionResult as NodeSystemVersion,
  TerminalCreateArgs as NodeTerminalCreateArgs,
  TerminalListResult as NodeTerminalListResult,
  ThemeCatalogResult as NodeThemeCatalog,
  ThemeSetInput as NodeThemeSetInput,
  ThreadSectionListResult as NodeThreadSectionList,
  ThreadSpawnResult as NodeThreadSpawn,
} from "@omnyo/sdk/node";
import type { createBrowserOmnyoSdk } from "@omnyo/sdk/browser";

interface RootSurface {
  environmentStatus: RootEnvironmentStatus;
  fileRead: RootFileRead;
  guideRender: RootGuideRender;
  hostGet: RootHostGet;
  pluginList: RootPluginList;
  pluginGetSource: RootPluginGetSource;
  pluginApplyUpdate: RootPluginApplyUpdate;
  pluginCatalogStatus: RootPluginCatalogStatus;
  projectAttachmentUpload: RootProjectAttachmentUpload;
  projectFileContent: RootProjectFileContent;
  projectGet: RootProjectGet;
  projectWorkspaceRoutingArgs: RootProjectWorkspaceRoutingArgs;
  providerList: RootProviderList;
  providerListArgs: RootProviderListArgs;
  providerModelsArgs: RootProviderModelsArgs;
  realtimeConnection: RootRealtimeConnection;
  status: RootStatus;
  systemVersion: RootSystemVersion;
  terminalCreateArgs: RootTerminalCreateArgs;
  terminalList: RootTerminalListResult;
  themeCatalog: RootThemeCatalog;
  themeSetInput: RootThemeSetInput;
  threadSectionList: RootThreadSectionList;
  threadSpawn: RootThreadSpawn;
}

interface BrowserSurface {
  environmentStatus: BrowserEnvironmentStatus;
  fileRead: BrowserFileRead;
  guideRender: BrowserGuideRender;
  hostGet: BrowserHostGet;
  pluginList: BrowserPluginList;
  pluginGetSource: BrowserPluginGetSource;
  pluginApplyUpdate: BrowserPluginApplyUpdate;
  pluginCatalogStatus: BrowserPluginCatalogStatus;
  projectAttachmentUpload: BrowserProjectAttachmentUpload;
  projectFileContent: BrowserProjectFileContent;
  projectGet: BrowserProjectGet;
  projectWorkspaceRoutingArgs: BrowserProjectWorkspaceRoutingArgs;
  providerList: BrowserProviderList;
  providerListArgs: BrowserProviderListArgs;
  providerModelsArgs: BrowserProviderModelsArgs;
  realtimeConnection: BrowserRealtimeConnection;
  status: BrowserStatus;
  systemVersion: BrowserSystemVersion;
  terminalCreateArgs: BrowserTerminalCreateArgs;
  terminalList: BrowserTerminalListResult;
  themeCatalog: BrowserThemeCatalog;
  themeSetInput: BrowserThemeSetInput;
  threadSectionList: BrowserThreadSectionList;
  threadSpawn: BrowserThreadSpawn;
}

interface CoreSurface {
  environmentStatus: CoreEnvironmentStatus;
  fileRead: CoreFileRead;
  guideRender: CoreGuideRender;
  hostGet: CoreHostGet;
  pluginList: CorePluginList;
  pluginGetSource: CorePluginGetSource;
  pluginApplyUpdate: CorePluginApplyUpdate;
  pluginCatalogStatus: CorePluginCatalogStatus;
  projectAttachmentUpload: CoreProjectAttachmentUpload;
  projectFileContent: CoreProjectFileContent;
  projectGet: CoreProjectGet;
  projectWorkspaceRoutingArgs: CoreProjectWorkspaceRoutingArgs;
  providerList: CoreProviderList;
  providerListArgs: CoreProviderListArgs;
  providerModelsArgs: CoreProviderModelsArgs;
  realtimeConnection: CoreRealtimeConnection;
  status: CoreStatus;
  systemVersion: CoreSystemVersion;
  terminalCreateArgs: CoreTerminalCreateArgs;
  terminalList: CoreTerminalListResult;
  themeCatalog: CoreThemeCatalog;
  themeSetInput: CoreThemeSetInput;
  threadSectionList: CoreThreadSectionList;
  threadSpawn: CoreThreadSpawn;
}

interface NodeSurface {
  environmentStatus: NodeEnvironmentStatus;
  fileRead: NodeFileRead;
  guideRender: NodeGuideRender;
  hostGet: NodeHostGet;
  pluginList: NodePluginList;
  pluginGetSource: NodePluginGetSource;
  pluginApplyUpdate: NodePluginApplyUpdate;
  pluginCatalogStatus: NodePluginCatalogStatus;
  projectAttachmentUpload: NodeProjectAttachmentUpload;
  projectFileContent: NodeProjectFileContent;
  projectGet: NodeProjectGet;
  projectWorkspaceRoutingArgs: NodeProjectWorkspaceRoutingArgs;
  providerList: NodeProviderList;
  providerListArgs: NodeProviderListArgs;
  providerModelsArgs: NodeProviderModelsArgs;
  realtimeConnection: NodeRealtimeConnection;
  status: NodeStatus;
  systemVersion: NodeSystemVersion;
  terminalCreateArgs: NodeTerminalCreateArgs;
  terminalList: NodeTerminalListResult;
  themeCatalog: NodeThemeCatalog;
  themeSetInput: NodeThemeSetInput;
  threadSectionList: NodeThreadSectionList;
  threadSpawn: NodeThreadSpawn;
}

type ExpectedOmnyoSdkKey =
  | "experimental_attention"
  | "experimental_inbox"
  | "server"
  | "experimental_desktopBrowsers"
  | "experimental_promptHistory"
  | "experimental_server"
  | "environments"
  | "files"
  | "guide"
  | "hosts"
  | "plugins"
  | "projects"
  | "previews"
  | "providers"
  | "skills"
  | "status"
  | "subscribe"
  | "system"
  | "terminals"
  | "theme"
  | "threadGroups"
  | "threadSections"
  | "threads";

type ExpectedPreviewsKey =
  | "register"
  | "list"
  | "get"
  | "status"
  | "restart"
  | "experimental_remove";

type ExpectedRealtimeKey = "subscribe";

type ExpectedEnvironmentsKey =
  | "experimental_cleanup"
  | "archiveThreads"
  | "commit"
  | "delete"
  | "list"
  | "listProviders"
  | "diff"
  | "diffBranches"
  | "diffFile"
  | "diffFiles"
  | "diffPatch"
  | "get"
  | "markPullRequestDraft"
  | "markPullRequestReady"
  | "mergePullRequest"
  | "paths"
  | "pullRequest"
  | "status"
  | "update";

type ExpectedFilesKey =
  | "createPreview"
  | "list"
  | "listPaths"
  | "mkdir"
  | "move"
  | "read"
  | "remove"
  | "write";

type ExpectedGuideKey = "render";

type ExpectedHostsKey =
  | "experimental_housekeeping"
  | "convertToDirect"
  | "cloneDefaultPath"
  | "experimental_create"
  | "experimental_getEnrollmentCommand"
  | "experimental_reconnect"
  | "createJoinCode"
  | "delete"
  | "experimental_deleteOldServerCopy"
  | "directory"
  | "experimental_discoverRepos"
  | "get"
  | "installProviderCli"
  | "list"
  | "experimental_listProviders"
  | "pathsExist"
  | "pickFolder"
  | "providerCliStatus"
  | "experimental_resume"
  | "experimental_retryCleanup"
  | "retryUpdate"
  | "rtkStatus"
  | "experimental_setAvailability"
  | "experimental_suspend"
  | "experimental_reconcile"
  | "update";

type ExpectedPluginsKey =
  | "experimental_discoverRpc"
  | "experimental_getSafeMode"
  | "experimental_setSafeMode"
  | "experimental_pruneCache"
  | "experimental_relocatePathSources"
  | "applyUpdate"
  | "experimental_startUpdate"
  | "experimental_updateJobs"
  | "callRpc"
  | "catalog"
  | "checkUpdates"
  | "disable"
  | "enable"
  | "getSettings"
  | "getSource"
  | "install"
  | "installJobs"
  | "list"
  | "listUpdateResults"
  | "marketplaces"
  | "reload"
  | "remove"
  | "startInstall"
  | "token"
  | "updateSettings";

type ExpectedPluginCatalogKey =
  | "install"
  | "installPlan"
  | "search"
  | "startInstall"
  | "status";

type ExpectedPluginMarketplacesKey = "add" | "list" | "refresh" | "remove";

type ExpectedPluginInstallJobsKey = "cancel" | "get" | "list";

type ExpectedExperimentalPromptHistoryKey = "list";

type ExpectedProjectsKey =
  | "machineEnvironment"
  | "replaceMachineEnvironment"
  | "setMachineEnvironmentVariable"
  | "deleteMachineEnvironmentVariable"
  | "attachments"
  | "branches"
  | "commandCatalog"
  | "commands"
  | "create"
  | "defaultExecutionOptions"
  | "delete"
  | "fileContent"
  | "files"
  | "get"
  | "list"
  | "paths"
  | "promptHistory"
  | "reorder"
  | "sidebarBootstrap"
  | "sources"
  | "update";

type ExpectedProjectSourcesKey = "add" | "delete" | "update";

type ExpectedProjectAttachmentsKey =
  | "copy"
  | "experimental_retain"
  | "read"
  | "upload";

type ExpectedProvidersKey =
  | "catalog"
  | "claudeProfiles"
  | "list"
  | "models"
  | "setEnabled";

type ExpectedStatusKey = "get";

type ExpectedSystemKey =
  | "webUpdateStatus"
  | "webUpdateBegin"
  | "webUpdateUpload"
  | "webUpdateApply"
  | "webUpdateAbort"
  | "webUpdateRollback"
  | "acknowledgeAppUpdate"
  | "cancelAppUpdate"
  | "appUpdate"
  | "applyAppUpdate"
  | "setMachineEnvironmentVariable"
  | "deleteMachineEnvironmentVariable"
  | "machineEnvironment"
  | "replaceMachineEnvironment"
  | "aiServices"
  | "attention"
  | "experimental_boot"
  | "experimental_webAssets"
  | "cliSkillsStatus"
  | "config"
  | "executionOptions"
  | "installCliSkills"
  | "experimental_recordTelemetryEvent"
  | "experimental_usageStatus"
  | "experimental_usageConsent"
  | "experimental_usagePreview"
  | "experimental_eraseUsageAnalytics"
  | "experimental_reportBug"
  | "experimental_prepareVoiceInput"
  | "experimental_recordAttachmentDiagnostic"
  | "experimental_recordVoiceDiagnostic"
  | "reloadConfig"
  | "setAiServiceSelection"
  | "testAiService"
  | "transcribeVoice"
  | "uiPreferences"
  | "updateExperiments"
  | "updateGeneralSettings"
  | "updateKeyboardSettings"
  | "providerStates"
  | "usageLimits"
  | "version";

type ExpectedSystemUiPreferencesKey = "list" | "reset" | "set";

type ExpectedThemeKey = "catalog" | "get" | "resolve" | "set";

type ExpectedThreadSectionsKey = "create" | "delete" | "list" | "update";

type ExpectedThreadsKey =
  | "experimental_importNative"
  | "experimental_nativeSessionClaims"
  | "experimental_continue"
  | "experimental_continueAll"
  | "experimental_continuationState"
  | "experimental_continuations"
  | "experimental_listStartMachines"
  | "experimental_moveStart"
  | "experimental_reorderShelved"
  | "experimental_listAncestors"
  | "experimental_listDescendants"
  | "experimental_listPluginMetadata"
  | "experimental_lookupCommandProofs"
  | "getPluginMetadata"
  | "updatePluginMetadata"
  | "context"
  | "experimental_setAutoCompaction"
  | "archive"
  | "archiveAll"
  | "cancelPlan"
  | "childSummary"
  | "clearContext"
  | "clearGoal"
  | "compact"
  | "conversation"
  | "conversationOutline"
  | "count"
  | "defaultExecutionOptions"
  | "delete"
  | "editMessage"
  | "events"
  | "fork"
  | "get"
  | "interactions"
  | "list"
  | "listRunning"
  | "markRead"
  | "markUnread"
  | "message"
  | "open"
  | "output"
  | "paneAction"
  | "pin"
  | "promptHistory"
  | "queue"
  | "queuedMessages"
  | "submissions"
  | "reorderPinned"
  | "resolveMentions"
  | "restoreEnvironment"
  | "retry"
  | "search"
  | "send"
  | "shelve"
  | "spawn"
  | "stop"
  | "storageFiles"
  | "storageLocation"
  | "storagePaths"
  | "tabs"
  | "timeline"
  | "timelineTurnSummaryDetails"
  | "unarchive"
  | "unpin"
  | "unshelve"
  | "update"
  | "wait"
  | "experimental_work"
  | "experimental_publishWork"
  | "experimental_archiveReady";

type ExpectedThreadEventsKey = "list" | "wait";

type ExpectedThreadQueueKey = "list";

type ExpectedThreadInteractionsKey =
  | "cancel"
  | "get"
  | "list"
  | "resolve"
  | "respond";

type ExpectedThreadQueuedMessagesKey =
  | "create"
  | "delete"
  | "experimental_holdForEdit"
  | "experimental_releaseEditHold"
  | "experimental_restore"
  | "list"
  | "reorder"
  | "send"
  | "setGroupBoundary"
  | "update";

type ExpectedThreadTabsKey = "get" | "update";

type ExpectedTerminalsKey =
  | "close"
  | "create"
  | "foreground"
  | "get"
  | "input"
  | "list"
  | "output"
  | "rename"
  | "restart"
  | "resize";

describe("SDK public type entrypoints", () => {
  it("export the same transport-independent DTO surface", () => {
    expectTypeOf<BrowserSurface>().toEqualTypeOf<RootSurface>();
    expectTypeOf<CoreSurface>().toEqualTypeOf<RootSurface>();
    expectTypeOf<NodeSurface>().toEqualTypeOf<RootSurface>();
  });

  it("preserves the complete SDK surface at every entrypoint", () => {
    expectTypeOf<keyof RootOmnyoSdk>().toEqualTypeOf<ExpectedOmnyoSdkKey>();
    expectTypeOf<BrowserOmnyoSdk>().toEqualTypeOf<RootOmnyoSdk>();
    expectTypeOf<CoreOmnyoSdk>().toEqualTypeOf<RootOmnyoSdk>();
    expectTypeOf<NodeOmnyoSdk>().toEqualTypeOf<RootOmnyoSdk>();
  });

  it("keeps the local guide area off the browser SDK instance", () => {
    expectTypeOf<keyof BrowserRuntimeOmnyoSdk>().toEqualTypeOf<
      Exclude<ExpectedOmnyoSdkKey, "guide">
    >();
    expectTypeOf<
      ReturnType<typeof createBrowserOmnyoSdk>
    >().toEqualTypeOf<BrowserRuntimeOmnyoSdk>();
  });

  it("exports only the public permission presets", () => {
    expectTypeOf<RootPermissionMode>().toEqualTypeOf<
      "accept-edits" | "auto" | "full"
    >();
  });

  it("makes provider host selectors mutually exclusive", () => {
    expectTypeOf<{
      environmentId: string;
      hostId: string;
    }>().not.toMatchTypeOf<RootProviderListArgs>();
    expectTypeOf<{ hostId: string }>().toMatchTypeOf<RootProviderModelsArgs>();
    expectTypeOf<{
      environmentId: string;
    }>().toMatchTypeOf<RootProviderModelsArgs>();
  });

  it("makes project workspace selectors mutually exclusive", () => {
    expectTypeOf<{
      environmentId: string;
      hostId: string;
    }>().not.toMatchTypeOf<RootProjectWorkspaceRoutingArgs>();
    expectTypeOf<{
      hostId: string;
    }>().toMatchTypeOf<RootProjectWorkspaceRoutingArgs>();
    expectTypeOf<{
      environmentId: string;
    }>().toMatchTypeOf<RootProjectWorkspaceRoutingArgs>();
  });

  it("uses explicit mutually exclusive terminal scopes", () => {
    expectTypeOf<{
      cols: number;
      rows: number;
      scope: {
        kind: "thread";
        threadId: string;
        environmentId: string;
      };
    }>().not.toMatchTypeOf<RootTerminalCreateArgs>();
    expectTypeOf<{
      cols: number;
      rows: number;
      scope: { kind: "environment"; environmentId: string };
    }>().toMatchTypeOf<RootTerminalCreateArgs>();
    expectTypeOf<{
      cols: number;
      rows: number;
      scope: { kind: "host_path"; hostId: string; cwd: null };
    }>().toMatchTypeOf<RootTerminalCreateArgs>();
  });

  it("snapshots every SDK area and nested method group", () => {
    expectTypeOf<
      keyof RootOmnyoRealtime
    >().toEqualTypeOf<ExpectedRealtimeKey>();
    expectTypeOf<
      keyof RootOmnyoSdk["environments"]
    >().toEqualTypeOf<ExpectedEnvironmentsKey>();
    expectTypeOf<
      keyof RootOmnyoSdk["files"]
    >().toEqualTypeOf<ExpectedFilesKey>();
    expectTypeOf<
      keyof RootOmnyoSdk["guide"]
    >().toEqualTypeOf<ExpectedGuideKey>();
    expectTypeOf<
      keyof RootOmnyoSdk["hosts"]
    >().toEqualTypeOf<ExpectedHostsKey>();
    expectTypeOf<
      keyof RootOmnyoSdk["plugins"]
    >().toEqualTypeOf<ExpectedPluginsKey>();
    expectTypeOf<
      keyof RootOmnyoSdk["plugins"]["catalog"]
    >().toEqualTypeOf<ExpectedPluginCatalogKey>();
    expectTypeOf<
      keyof RootOmnyoSdk["plugins"]["marketplaces"]
    >().toEqualTypeOf<ExpectedPluginMarketplacesKey>();
    expectTypeOf<
      keyof RootOmnyoSdk["plugins"]["installJobs"]
    >().toEqualTypeOf<ExpectedPluginInstallJobsKey>();
    expectTypeOf<
      keyof RootOmnyoSdk["projects"]
    >().toEqualTypeOf<ExpectedProjectsKey>();
    expectTypeOf<
      keyof RootOmnyoSdk["projects"]["attachments"]
    >().toEqualTypeOf<ExpectedProjectAttachmentsKey>();
    expectTypeOf<
      keyof RootOmnyoSdk["projects"]["sources"]
    >().toEqualTypeOf<ExpectedProjectSourcesKey>();
    expectTypeOf<
      keyof RootOmnyoSdk["experimental_promptHistory"]
    >().toEqualTypeOf<ExpectedExperimentalPromptHistoryKey>();
    expectTypeOf<
      keyof RootOmnyoSdk["providers"]
    >().toEqualTypeOf<ExpectedProvidersKey>();
    expectTypeOf<
      keyof RootOmnyoSdk["status"]
    >().toEqualTypeOf<ExpectedStatusKey>();
    expectTypeOf<
      keyof RootOmnyoSdk["system"]
    >().toEqualTypeOf<ExpectedSystemKey>();
    expectTypeOf<
      keyof RootOmnyoSdk["system"]["uiPreferences"]
    >().toEqualTypeOf<ExpectedSystemUiPreferencesKey>();
    expectTypeOf<
      keyof RootOmnyoSdk["terminals"]
    >().toEqualTypeOf<ExpectedTerminalsKey>();
    expectTypeOf<
      keyof RootOmnyoSdk["previews"]
    >().toEqualTypeOf<ExpectedPreviewsKey>();
    expectTypeOf<
      keyof RootOmnyoSdk["theme"]
    >().toEqualTypeOf<ExpectedThemeKey>();
    expectTypeOf<
      keyof RootOmnyoSdk["threadSections"]
    >().toEqualTypeOf<ExpectedThreadSectionsKey>();
    expectTypeOf<
      keyof RootOmnyoSdk["threads"]
    >().toEqualTypeOf<ExpectedThreadsKey>();
    expectTypeOf<
      keyof RootOmnyoSdk["threads"]["events"]
    >().toEqualTypeOf<ExpectedThreadEventsKey>();
    expectTypeOf<
      keyof RootOmnyoSdk["threads"]["queue"]
    >().toEqualTypeOf<ExpectedThreadQueueKey>();
    expectTypeOf<
      keyof RootOmnyoSdk["threads"]["interactions"]
    >().toEqualTypeOf<ExpectedThreadInteractionsKey>();
    expectTypeOf<
      keyof RootOmnyoSdk["threads"]["queuedMessages"]
    >().toEqualTypeOf<ExpectedThreadQueuedMessagesKey>();
    expectTypeOf<
      keyof RootOmnyoSdk["threads"]["tabs"]
    >().toEqualTypeOf<ExpectedThreadTabsKey>();
  });
});
