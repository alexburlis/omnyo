import type {
  ClientTurnRequestId,
  DynamicTool,
  InstructionMode,
  JsonObject,
  PromptInput,
  PromptMode,
  ReasoningLevel,
  RuntimePermissionPolicy,
  ServiceTier,
  SessionOptionSelections,
} from "@omnyo/domain";
import type {
  modelListParamsSchema,
  ProviderInstallationRunParams,
  ProviderInstallationStatusParams,
  threadDiscardParamsSchema,
} from "@omnyo/provider-bridge-protocol";
import type { z } from "zod";
import type {
  AgentRuntimeBridgeLaunch,
  AgentRuntimeSkillRoot,
} from "./types.js";

export interface CreateBridgeAdapterOptions {
  additionalWorkspaceWriteRoots: readonly string[];
  bridgeLaunch: AgentRuntimeBridgeLaunch;
  bridgeBundleDir?: string;
  bridgeNodeEnv?: Record<string, string>;
  bridgeNodeExecutablePath?: string;
}

export type ProviderExecutionContext = {
  model?: string;
  serviceTier?: ServiceTier;
  reasoningLevel?: ReasoningLevel;
  promptMode?: PromptMode;
  sessionOptions?: SessionOptionSelections;
  providerOptions: JsonObject;
  instructions?: string;
  envVars?: Record<string, string>;
} & RuntimePermissionPolicy;

type ThreadReferenceFields = Pick<
  z.infer<typeof threadDiscardParamsSchema>,
  "threadId" | "providerThreadId"
>;

export type AdapterCommand =
  | {
      type: "skills/configure";
      skillRoots: readonly AgentRuntimeSkillRoot[];
    }
  | ({ type: "model/list" } & Pick<
      z.infer<typeof modelListParamsSchema>,
      "cwd" | "envVars"
    >)
  | { type: "provider/health"; cwd?: string }
  | { type: "provider/usage"; cwd?: string; envVars?: Record<string, string> }
  | ({ type: "provider/installation/status" } & Pick<
      ProviderInstallationStatusParams,
      "cwd" | "requirement" | "checkUpdates"
    >)
  | ({ type: "provider/installation/run" } & Pick<
      ProviderInstallationRunParams,
      "action" | "cwd"
    >)
  | {
      type: "thread/start";
      threadId: string;
      cwd: string;
      options: ProviderExecutionContext;
      dynamicTools?: DynamicTool[];
      instructionMode: InstructionMode;
    }
  | {
      type: "thread/resume";
      threadId: string;
      cwd: string;
      providerThreadId: string;
      options: ProviderExecutionContext;
      dynamicTools?: DynamicTool[];
      instructionMode: InstructionMode;
    }
  | {
      type: "thread/fork";
      threadId: string;
      cwd: string;
      sourceProviderThreadId: string;
      sourceProviderCheckpointId?: string;
      options: ProviderExecutionContext;
      dynamicTools?: DynamicTool[];
      instructionMode: InstructionMode;
    }
  | {
      type: "turn/start";
      threadId: string;
      providerThreadId: string;
      input: PromptInput[];
      clientRequestId: ClientTurnRequestId;
      options: ProviderExecutionContext;
    }
  | {
      type: "turn/steer";
      threadId: string;
      providerThreadId: string;
      expectedTurnId: string;
      input: PromptInput[];
      clientRequestId: ClientTurnRequestId;
      options: ProviderExecutionContext;
    }
  | {
      type: "thread/stop";
      threadId: string;
      providerThreadId: string;
      activeTurnId: string | null;
    }
  | ({ type: "thread/discard" } & ThreadReferenceFields)
  | ({
      type: "thread/speed/set";
      serviceTier: ServiceTier;
    } & ThreadReferenceFields)
  | ({ type: "thread/goal/clear" } & ThreadReferenceFields)
  | ({
      type: "thread/name/set";
      title: string;
    } & ThreadReferenceFields)
  | ({ type: "thread/archive" } & ThreadReferenceFields)
  | ({ type: "thread/unarchive" } & ThreadReferenceFields);
