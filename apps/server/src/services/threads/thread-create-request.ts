import type {
  JsonObject,
  PromptInput,
  StartedOnBehalfOf,
  ThreadCreateOrigin,
  ThreadOriginKind,
  ThreadVisibility,
} from "@omnyo/domain";
import type {
  CreateThreadEnvironmentArgs,
  CreateThreadRequest,
  EnvironmentArgs,
  ProviderEnvironmentArgs,
} from "@omnyo/server-contract";

export interface ThreadCreateServiceRequestInput {
  environment: CreateThreadEnvironmentArgs;
  executionInputSources?: CreateThreadRequest["executionInputSources"];

  sendAt?: CreateThreadRequest["sendAt"];
  idle?: CreateThreadRequest["idle"];
  pluginHome?: CreateThreadRequest["pluginHome"];
  quiet?: CreateThreadRequest["quiet"];
  callerPluginId?: string | null;
  input: PromptInput[];
  pluginMetadata?: CreateThreadRequest["pluginMetadata"];
  pluginSubmission?: CreateThreadRequest["pluginSubmission"];
  sectionId?: CreateThreadRequest["sectionId"];
  pinned?: CreateThreadRequest["pinned"];
  model?: CreateThreadRequest["model"];
  origin: ThreadCreateOrigin | null;
  originPluginId?: CreateThreadRequest["originPluginId"];
  originKind?: ThreadOriginKind | null;
  parentThreadId?: string;
  lifecycleOwnerThreadId?: string;
  launchedByThreadId?: string;
  permissionMode?: CreateThreadRequest["permissionMode"];
  projectId: string;
  providerId?: CreateThreadRequest["providerId"];
  claudeProfile?: CreateThreadRequest["claudeProfile"];
  claudeProfileBinding?: import("@omnyo/domain").ClaudeProfileBinding | null;
  reasoningLevel?: CreateThreadRequest["reasoningLevel"];
  serviceTier?: CreateThreadRequest["serviceTier"];
  sessionOptions?: CreateThreadRequest["sessionOptions"];
  sourceSeqEnd?: CreateThreadRequest["sourceSeqEnd"];
  sourceThreadId?: string;
  startedOnBehalfOf: StartedOnBehalfOf | null;
  title?: string;
  visibility?: ThreadVisibility;
}

export interface ThreadCreateServiceRequest extends Omit<
  ThreadCreateServiceRequestInput,
  "environment" | "pluginMetadata" | "providerId"
> {
  environment: EnvironmentArgs | ProviderEnvironmentArgs;
  machinePinned: boolean;
  pluginMetadata: { pluginId: string; metadata: JsonObject } | null;
  providerId: string;
  titleFallback: string | null;
  visibility: ThreadVisibility;
}

export function machineCameFromDefault(
  environment: CreateThreadEnvironmentArgs,
): boolean {
  switch (environment.type) {
    case "project-default":
      return true;
    case "host":
      return (
        environment.hostId === undefined ||
        environment.machineChoice === "default"
      );
    case "provider":
      return (
        environment.machine === undefined ||
        environment.machineChoice === "default"
      );
    case "reuse":
      return false;
  }
}
