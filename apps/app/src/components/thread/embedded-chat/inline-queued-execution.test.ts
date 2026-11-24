import { describe, expect, it } from "vitest";
import type {
  ExecutionControlsProps,
  ExecutionPermissionConfig,
} from "@/components/promptbox/ExecutionControls";
import type { ModelPickerOption } from "@/components/pickers/model-picker-option";
import { inlineQueuedExecutionControls } from "./inline-queued-execution";
import type { InlineQueuedMessageEditState } from "./useInlineQueuedMessageEditing";

const ignore = () => {};

function modelOption(
  value: string,
  reasoning: readonly string[],
  defaultReasoningLevel: string,
): ModelPickerOption {
  return {
    value,
    label: value,
    reasoningOptions: reasoning.map((level) => ({
      value: level,
      label: level,
    })),
    defaultReasoningLevel,
    serviceTierOptions: [],
  };
}

const composerExecution: ExecutionControlsProps = {
  catalog: { providers: [], verified: true, modelOptions: [] },
  provider: { selectedId: "codex", onChange: ignore },
  model: {
    active: { model: "composer-model" },
    selected: "composer-model",
    options: [
      modelOption("gpt-5", ["low", "medium", "high"], "medium"),
      modelOption("gpt-5-mini", ["minimal", "low"], "low"),
    ],
    moreOptions: [],
    isLoading: false,
    loadFailed: false,
    onChange: ignore,
  },
  serviceTier: {
    value: "default",
    onChange: ignore,
    supported: true,
    options: [],
  },
  reasoning: { value: "high", options: [], onChange: ignore },
  selection: { onChange: ignore },
  favoriteChips: true,
};

const composerPermission: ExecutionPermissionConfig = {
  value: "full",
  options: [],
  onChange: ignore,
  supported: true,
};

function editing(): {
  controls: () => ReturnType<typeof inlineQueuedExecutionControls>;
  current: () => InlineQueuedMessageEditState | null;
} {
  let state: InlineQueuedMessageEditState | null = {
    draft: { attachments: [], mentions: [], text: "queued" },
    editSessionId: 7,
    expectedUpdatedAt: 1,
    model: "gpt-5",
    ownerThreadId: "thr_1",
    permissionMode: "auto",
    queuedMessageId: "qmsg_1",
    queuedMessageIndex: 0,
    reasoningLevel: "medium",
    serviceTier: "default",
  };

  const controls = () => {
    if (state === null) throw new Error("edit ended");

    return inlineQueuedExecutionControls({
      edit: state,
      execution: composerExecution,
      permission: composerPermission,
      permissionLocked: false,
      providerId: "codex",
      update: (updater) => {
        state = updater(state);
      },
    });
  };

  return { controls, current: () => state };
}

describe("inlineQueuedExecutionControls", () => {
  it("shows the queued message's own model, reasoning and permission", () => {
    const { controls } = editing();
    const { execution, permission } = controls();

    expect(execution.model.active).toEqual({ model: "gpt-5" });
    expect(execution.reasoning.value).toBe("medium");
    expect(execution.reasoning.options.map(({ value }) => value)).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(permission.value).toBe("auto");
  });

  it("writes picker changes to the edited message instead of the composer", () => {
    const { controls, current } = editing();

    controls().execution.model.onChange("gpt-5-mini");
    expect(current()).toMatchObject({
      model: "gpt-5-mini",
      reasoningLevel: "low",
    });

    controls().execution.reasoning.onChange("minimal");
    controls().execution.serviceTier?.onChange("fast");
    controls().permission.onChange("accept-edits");
    expect(current()).toMatchObject({
      model: "gpt-5-mini",
      reasoningLevel: "minimal",
      serviceTier: "fast",
      permissionMode: "accept-edits",
    });

    controls().execution.selection.onChange({
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "high",
    });
    expect(current()).toMatchObject({
      model: "gpt-5",
      reasoningLevel: "high",
      serviceTier: "fast",
    });
  });

  it("ignores a selection from another provider and drops handoff controls", () => {
    const { controls, current } = editing();
    const { execution } = controls();

    execution.selection.onChange({
      providerId: "claude-code",
      model: "opus",
      reasoningLevel: "high",
    });

    expect(current()?.model).toBe("gpt-5");
    expect(execution.provider.onChange).toBeUndefined();
    expect(execution.handoff).toBeUndefined();
  });
});
