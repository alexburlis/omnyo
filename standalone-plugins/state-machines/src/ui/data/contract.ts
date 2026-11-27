import type {
  ExperimentalPermissionModePickerProps,
  ExperimentalProviderModelPickerValue,
  StandardSchemaV1InferOutput,
} from "@omnyo/plugin-sdk/app";

import type { stateMachinesRpc } from "../../contracts/rpc.js";
import type { EditorDraft, EditorGuard } from "../../definition/draft.js";

export type {
  ContextSchema,
  Decision,
  Effect,
  GraphLayout,
  GuardExpression,
  JsonObject,
  JsonValue,
  MachineDefinition,
  Path,
  PatchOperation,
  StateDefinition,
  Trigger,
  TypedField,
  ValueSchema,
  WaitTrigger,
} from "../../contracts/definition.js";

export type { AttemptStatus, Lifecycle, Phase } from "../../contracts/events.js";

export type { EditorDraft, EditorGuard };

export type SmContract = typeof stateMachinesRpc;

export type SmMethodName = Extract<keyof SmContract, string>;

export type SmInput<Name extends SmMethodName> = StandardSchemaV1InferOutput<
  SmContract[Name]["input"]
>;

export type SmEnvelope<Name extends SmMethodName> = StandardSchemaV1InferOutput<
  SmContract[Name]["output"]
>;

export type SmOutput<Name extends SmMethodName> = Extract<SmEnvelope<Name>, { ok: true }>["value"];

export type SmErrorPayload = Extract<SmEnvelope<"sm_machine_list">, { ok: false }>["error"];

export type MachineSummary = SmOutput<"sm_machine_list">[number];

export type InstanceSummary = SmOutput<"sm_instance_list">[number];

export type DraftView = SmOutput<"sm_machine_draft_get">;

export type ValidationView = SmOutput<"sm_machine_validate">;

export type Problem = DraftView["problems"][number];

export type ChangeSummary = DraftView["changeSummary"];

export type VersionSummary = SmOutput<"sm_machine_versions">[number];

export type VersionView = SmOutput<"sm_machine_version_get">;

export type InstanceView = SmOutput<"sm_instance_inspect">;

export type StepView = InstanceView["steps"][number];

export type AttentionItem = SmOutput<"sm_attention_list">[number];

export type AttentionKind = AttentionItem["kind"];

export type AttentionDecision = AttentionItem["decisions"][number];

export type HistoryPage = SmOutput<"sm_history_list">;

export type HistoryEntry = HistoryPage["entries"][number];

export type HistoryKind = SmInput<"sm_history_list">["kinds"][number];

export type StateHistoryPage = SmOutput<"sm_state_history">;

export type StateVisit = StateHistoryPage["visits"][number];

export type EventCatalogEntry = SmOutput<"sm_events_catalog">[number];

export type LogPage = SmOutput<"sm_log_read">;

export type EnvironmentOption = SmOutput<"sm_environment_list">[number];

export type ControlOperation = SmInput<"sm_instance_control">["operation"];

export type DraftState = EditorDraft["states"][number];

export type DraftTransition = EditorDraft["transitions"][number];

export type StateKind = DraftState["kind"];

export type ActionDraftState = Extract<DraftState, { kind: "agent" | "command" }>;

export type AgentDraftState = Extract<DraftState, { kind: "agent" }>;

export type CommandDraftState = Extract<DraftState, { kind: "command" }>;

export type WaitDraftState = Extract<DraftState, { kind: "wait" }>;

export type ManualDraftState = Extract<DraftState, { kind: "manual" }>;

export type EndDraftState = Extract<DraftState, { kind: "end" }>;

export type ArgvPart = CommandDraftState["action"]["argv"][number];

export type ResultOutcome = AgentDraftState["action"]["result"]["outcomes"][number];

export type PermissionMode = ExperimentalPermissionModePickerProps["value"];

export type Execution = ExperimentalProviderModelPickerValue;

export type GraphDefinition = Pick<EditorDraft, "initialStateId" | "layout"> & {
  states: readonly DraftState[];
  transitions: readonly DraftTransition[];
};

export const REALTIME_CHANNEL = "state-machines.changed";
