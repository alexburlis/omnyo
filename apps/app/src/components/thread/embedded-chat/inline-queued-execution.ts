import type {
  ExecutionControlsProps,
  ExecutionPermissionConfig,
} from "@/components/promptbox/ExecutionControls";
import type { ModelPickerOption } from "@/components/pickers/model-picker-option";
import type { InlineQueuedMessageEditState } from "./useInlineQueuedMessageEditing";

type QueuedExecutionField =
  | "model"
  | "permissionMode"
  | "reasoningLevel"
  | "serviceTier";

type QueuedExecutionPatch = Partial<
  Pick<InlineQueuedMessageEditState, QueuedExecutionField>
>;

interface InlineQueuedExecutionControlsArgs {
  edit: InlineQueuedMessageEditState;
  execution: ExecutionControlsProps;
  permission: ExecutionPermissionConfig;
  permissionLocked: boolean;
  providerId: string;
  update: (
    updater: (
      current: InlineQueuedMessageEditState | null,
    ) => InlineQueuedMessageEditState | null,
  ) => void;
}

interface InlineQueuedExecutionControls {
  execution: ExecutionControlsProps;
  permission: ExecutionPermissionConfig;
}

function findModelOption(
  execution: ExecutionControlsProps,
  providerId: string,
  model: string,
): ModelPickerOption | undefined {
  return [
    ...execution.model.options,
    ...execution.model.moreOptions,
    ...execution.catalog.modelOptions,
  ].find(
    (option) =>
      option.value === model &&
      (option.routeProviderId === undefined ||
        option.routeProviderId === providerId),
  );
}

export function inlineQueuedExecutionControls({
  edit,
  execution,
  permission,
  permissionLocked,
  providerId,
  update,
}: InlineQueuedExecutionControlsArgs): InlineQueuedExecutionControls {
  const { editSessionId } = edit;

  const patch = (next: QueuedExecutionPatch) =>
    update((current) =>
      current?.editSessionId === editSessionId
        ? { ...current, ...next }
        : current,
    );

  const reasoningForModel = (model: string, current: string) => {
    const option = findModelOption(execution, providerId, model);

    if (
      option === undefined ||
      option.reasoningOptions.some(({ value }) => value === current)
    ) {
      return current;
    }

    return option.defaultReasoningLevel;
  };

  const modelOption = findModelOption(execution, providerId, edit.model);

  const {
    handoff: _handoff,
    favoriteChips: _favoriteChips,
    agentOptions: _agentOptions,
    provider: { onChange: _onProviderChange, ...provider },
    ...base
  } = execution;

  return {
    execution: {
      ...base,
      provider: { ...provider, selectedId: providerId },
      selection: {
        onChange: (selection) => {
          if (selection.providerId !== providerId) return;
          patch({
            model: selection.model,
            reasoningLevel: selection.reasoningLevel,
            ...(selection.serviceTier !== undefined
              ? { serviceTier: selection.serviceTier }
              : {}),
          });
        },
      },
      model: {
        ...execution.model,
        active: { model: edit.model },
        selected: edit.model,
        onChange: (model) =>
          patch({
            model,
            reasoningLevel: reasoningForModel(model, edit.reasoningLevel),
          }),
      },
      reasoning: {
        ...execution.reasoning,
        isLoading:
          execution.reasoning.isLoading &&
          edit.model === execution.model.selected,
        options: modelOption?.reasoningOptions ?? execution.reasoning.options,
        value: edit.reasoningLevel,
        onChange: (reasoningLevel) => patch({ reasoningLevel }),
      },
      ...(execution.serviceTier
        ? {
            serviceTier: {
              ...execution.serviceTier,
              value: edit.serviceTier,
              onChange: (serviceTier) => {
                if (serviceTier !== undefined) patch({ serviceTier });
              },
            },
          }
        : {}),
    },
    permission: permissionLocked
      ? { ...permission, value: edit.permissionMode }
      : {
          ...permission,
          value: edit.permissionMode,
          onChange: (permissionMode) => patch({ permissionMode }),
        },
  };
}
