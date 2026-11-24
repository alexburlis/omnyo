import {
  OmnyoHttpError,
  OmnyoRequestTimeoutError,
  ThreadWaitTimeoutError,
  ThreadWaitUnreachableError,
  createNodeOmnyoSdk,
  type OmnyoSdk as CoreSdk,
  type CreateNodeOmnyoSdkArgs,
} from "@omnyo/sdk/node";
import type {
  OmnyoRealtimeSubscribeArgs,
  OmnyoRealtimeSocket,
  OmnyoRealtimeSocketFactory,
  OmnyoRealtimeSocketMessageEvent,
  ThreadGetResult,
  ThreadStatusArgs,
} from "@omnyo/sdk/node";

export {
  OmnyoHttpError,
  OmnyoRequestTimeoutError,
  ThreadWaitTimeoutError,
  ThreadWaitUnreachableError,
};

export type * from "@omnyo/sdk/node";

export type {
  GitBranchSelection,
  JsonValue,
  PermissionMode,
  PromptInput,
  PromptTextMention,
  ReasoningLevel,
  ServiceTier,
  ThreadStatus,
} from "@omnyo/sdk/node";

export type {
  CreateExecutionInputSources,
  EnvironmentArgs,
  ExistingThreadExecutionInputSources,
  UnmanagedBranchSpec,
  WorkspaceArgs,
} from "@omnyo/sdk/node";

export type { CallerExecutionInputSource as ExecutionInputSource } from "@omnyo/sdk/node";

export type OmnyoSdkOptions = CreateNodeOmnyoSdkArgs;

export type OmnyoSdkRealtimeSubscribeArgs = OmnyoRealtimeSubscribeArgs;

export type OmnyoSdkRealtimeSocket = OmnyoRealtimeSocket;

export type OmnyoSdkRealtimeSocketFactory = OmnyoRealtimeSocketFactory;

export type OmnyoSdkRealtimeSocketMessageEvent = OmnyoRealtimeSocketMessageEvent;

export type OmnyoSdkStatusArea = CoreSdk["status"];

export type OmnyoSdkSkillsArea = CoreSdk["skills"];

export type OmnyoSdkTerminalsArea = CoreSdk["terminals"];

export type OmnyoSdkThread = ThreadGetResult;

export type OmnyoSdkThreadsArea = CoreSdk["threads"];

export type ThreadIdArgs = ThreadStatusArgs;

export type OmnyoHttpErrorConstructor = typeof OmnyoHttpError;

export type OmnyoRequestTimeoutErrorConstructor = typeof OmnyoRequestTimeoutError;

export type ThreadWaitTimeoutErrorConstructor = typeof ThreadWaitTimeoutError;

export type ThreadWaitUnreachableErrorConstructor =
  typeof ThreadWaitUnreachableError;

export class OmnyoSdk implements CoreSdk {
  readonly environments: CoreSdk["environments"];
  readonly experimental_attention: CoreSdk["experimental_attention"];
  readonly experimental_desktopBrowsers: CoreSdk["experimental_desktopBrowsers"];
  readonly experimental_inbox: CoreSdk["experimental_inbox"];
  readonly experimental_promptHistory: CoreSdk["experimental_promptHistory"];
  readonly server: CoreSdk["server"];
  readonly experimental_server: CoreSdk["experimental_server"];
  readonly files: CoreSdk["files"];
  readonly guide: CoreSdk["guide"];
  readonly hosts: CoreSdk["hosts"];
  readonly plugins: CoreSdk["plugins"];
  readonly previews: CoreSdk["previews"];
  readonly projects: CoreSdk["projects"];
  readonly providers: CoreSdk["providers"];
  readonly skills: CoreSdk["skills"];
  readonly status: CoreSdk["status"];
  readonly system: CoreSdk["system"];
  readonly terminals: CoreSdk["terminals"];
  readonly theme: CoreSdk["theme"];
  readonly threadGroups: CoreSdk["threadGroups"];
  readonly threadSections: CoreSdk["threadSections"];
  readonly threads: CoreSdk["threads"];
  readonly subscribe: CoreSdk["subscribe"];

  constructor(options: OmnyoSdkOptions = {}) {
    const sdk = createNodeOmnyoSdk(options);
    this.environments = sdk.environments;
    this.experimental_attention = sdk.experimental_attention;
    this.experimental_desktopBrowsers = sdk.experimental_desktopBrowsers;
    this.experimental_inbox = sdk.experimental_inbox;
    this.experimental_promptHistory = sdk.experimental_promptHistory;
    this.server = sdk.server;
    this.experimental_server = sdk.experimental_server;
    this.files = sdk.files;
    this.guide = sdk.guide;
    this.hosts = sdk.hosts;
    this.plugins = sdk.plugins;
    this.previews = sdk.previews;
    this.projects = sdk.projects;
    this.providers = sdk.providers;
    this.skills = sdk.skills;
    this.status = sdk.status;
    this.system = sdk.system;
    this.terminals = sdk.terminals;
    this.theme = sdk.theme;
    this.threadGroups = sdk.threadGroups;
    this.threadSections = sdk.threadSections;
    this.threads = sdk.threads;
    this.subscribe = sdk.subscribe;
  }
}

export function createOmnyoSdk(options: OmnyoSdkOptions = {}): OmnyoSdk {
  return new OmnyoSdk(options);
}
