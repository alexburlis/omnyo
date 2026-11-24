import {
  createDesktopBrowsersArea,
  type ExperimentalDesktopBrowsersArea,
} from "./areas/desktop-browsers.js";
import type { OmnyoSdkContext, OmnyoSdkTransport } from "./transport.js";
import {
  createEnvironmentsArea,
  type EnvironmentsArea,
} from "./areas/environments.js";
import { createFilesArea, type FilesArea } from "./areas/files.js";
import type { GuideArea } from "./areas/guide.js";
import { createHostsArea, type HostsArea } from "./areas/hosts.js";
import {
  createServerArea,
  type ExperimentalServerArea,
} from "./areas/server.js";
import { createProjectsArea, type ProjectsArea } from "./areas/projects.js";
import { createPreviewsArea, type PreviewsArea } from "./areas/previews.js";
import { createProvidersArea, type ProvidersArea } from "./areas/providers.js";
import { createPluginsArea, type PluginsArea } from "./areas/plugins.js";
import {
  createPromptHistoryArea,
  type ExperimentalPromptHistoryArea,
} from "./areas/prompt-history.js";
import { createOmnyoRealtimeClient } from "./realtime-client.js";
import type { OmnyoRealtime } from "./realtime-types.js";
import { createStatusArea, type StatusArea } from "./areas/status.js";
import { createSkillsArea, type SkillsArea } from "./areas/skills.js";
import { createThemeArea, type ThemeArea } from "./areas/theme.js";
import { createSystemArea, type SystemArea } from "./areas/system.js";
import { createTerminalsArea, type TerminalsArea } from "./areas/terminals.js";
import { createThreadsArea, type ThreadsArea } from "./areas/threads.js";
import {
  createThreadSectionsArea,
  type ThreadSectionsArea,
} from "./areas/thread-sections.js";
import {
  createThreadGroupsArea,
  type ThreadGroupsArea,
} from "./areas/thread-groups.js";

export type * from "./public-types.js";

export { createBuiltinPlanCommandTextInput } from "@omnyo/domain";

export interface CreateOmnyoSdkArgs {
  context?: OmnyoSdkContext;
  transport: OmnyoSdkTransport;
}

export interface CreateOmnyoSdkWithGuideArgs extends CreateOmnyoSdkArgs {
  guide: GuideArea;
}

export interface OmnyoSdkAreas extends OmnyoRealtime {
  experimental_attention: ExperimentalThreadAttentionArea;
  experimental_inbox: ExperimentalInboxArea;
  experimental_desktopBrowsers: ExperimentalDesktopBrowsersArea;
  experimental_promptHistory: ExperimentalPromptHistoryArea;
  server: ExperimentalServerArea;
  experimental_server: ExperimentalServerArea;
  environments: EnvironmentsArea;
  files: FilesArea;
  hosts: HostsArea;
  projects: ProjectsArea;
  previews: PreviewsArea;
  plugins: PluginsArea;
  providers: ProvidersArea;
  skills: SkillsArea;
  status: StatusArea;
  system: SystemArea;
  terminals: TerminalsArea;
  theme: ThemeArea;
  threadSections: ThreadSectionsArea;
  threadGroups: ThreadGroupsArea;
  threads: ThreadsArea;
}

export interface OmnyoSdk extends OmnyoSdkAreas {
  guide: GuideArea;
}

export function createOmnyoSdk(args: CreateOmnyoSdkWithGuideArgs): OmnyoSdk;
export function createOmnyoSdk(args: CreateOmnyoSdkArgs): OmnyoSdkAreas;
export function createOmnyoSdk(
  args: CreateOmnyoSdkArgs | CreateOmnyoSdkWithGuideArgs,
): OmnyoSdkAreas | OmnyoSdk {
  const sdkContext = { transport: args.transport };

  const realtime = createOmnyoRealtimeClient({
    transport: args.transport,
  });

  const areas: OmnyoSdkAreas = {
    experimental_attention: createThreadAttentionArea(sdkContext),
    experimental_inbox: createInboxArea(sdkContext),
    experimental_desktopBrowsers: createDesktopBrowsersArea(sdkContext),
    experimental_promptHistory: createPromptHistoryArea(sdkContext),
    server: createServerArea(sdkContext),
    experimental_server: createServerArea(sdkContext),
    environments: createEnvironmentsArea(sdkContext),
    files: createFilesArea(sdkContext),
    hosts: createHostsArea(sdkContext),
    subscribe(args) {
      return realtime.subscribe(args);
    },
    projects: createProjectsArea(sdkContext),
    previews: createPreviewsArea(sdkContext),
    plugins: createPluginsArea(sdkContext),
    providers: createProvidersArea(sdkContext),
    skills: createSkillsArea(sdkContext),
    status: createStatusArea(sdkContext),
    system: createSystemArea(sdkContext),
    terminals: createTerminalsArea(sdkContext),
    theme: createThemeArea(sdkContext),
    threadSections: createThreadSectionsArea(sdkContext),
    threadGroups: createThreadGroupsArea(sdkContext),
    threads: createThreadsArea(sdkContext),
  };

  return "guide" in args ? { ...areas, guide: args.guide } : areas;
}

import {
  createThreadAttentionArea,
  type ExperimentalThreadAttentionArea,
} from "./areas/thread-attention.js";
import {
  createInboxArea,
  type ExperimentalInboxArea,
} from "./areas/inbox.js";
