// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { makeProviderInfo } from "@omnyo/test-helpers/domain-fixtures";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { makeSystemConfig } from "@/test/fixtures/system-config";
import { systemConfigQueryKey } from "@/hooks/queries/query-keys";
import {
  ExecutionControls,
  type ExecutionControlsProps,
} from "./ExecutionControls";
import { ModelReasoningMenu } from "@/components/pickers/ModelReasoningMenuSplit";
import type { ModelPickerOption } from "@/components/pickers/model-picker-option";

const MEDIUM_ONLY = [{ value: "medium", label: "Medium" }];

const gpt5: ModelPickerOption = {
  value: "gpt-5",
  label: "GPT-5",
  reasoningOptions: MEDIUM_ONLY,
  defaultReasoningLevel: "medium",
  serviceTierOptions: [],
};

function makeExecutionControlsProps(
  providerOnChange?: (value: string) => void,
): ExecutionControlsProps {
  return {
    catalog: {
      providers: [
        makeProviderInfo({ id: "codex", displayName: "Codex" }),
        makeProviderInfo({ id: "claude", displayName: "Claude Code" }),
      ],
      verified: true,
      modelOptions: [gpt5],
    },
    provider: {
      options: [
        { value: "codex", label: "Codex" },
        { value: "claude", label: "Claude Code" },
      ],
      selectedId: "codex",
      onChange: providerOnChange,
      hasMultiple: true,
    },
    model: {
      active: null,
      selected: "gpt-5",
      options: [gpt5],
      moreOptions: [],
      isLoading: false,
      loadFailed: false,
      loadError: null,
      onChange: vi.fn(),
    },
    reasoning: {
      value: "medium",
      options: MEDIUM_ONLY,
      onChange: vi.fn(),
    },
    selection: { onChange: vi.fn() },
  };
}

function renderExecutionControls(props: ExecutionControlsProps) {
  const { queryClient, wrapper } = createQueryClientTestHarness();
  const config = makeSystemConfig();
  queryClient.setQueryData(systemConfigQueryKey(), {
    ...config,
    generalSettings: { ...config.generalSettings, streamerMode: false },
  });

  return render(<ExecutionControls {...props} />, { wrapper });
}

beforeAll(() => ModelReasoningMenu.preload());

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ExecutionControls", () => {
  it("shows only the locked provider's group when provider changes are locked", () => {
    renderExecutionControls(makeExecutionControlsProps());

    fireEvent.click(
      screen.getByRole("button", {
        name: "Provider, model and reasoning",
      }),
    );

    expect(screen.getByRole("rowheader", { name: "Codex" })).not.toBeNull();
    expect(screen.queryByRole("rowheader", { name: "Claude Code" })).toBeNull();
  });

  it("lists every provider as a labelled group when provider changes are allowed", () => {
    renderExecutionControls(makeExecutionControlsProps(vi.fn()));

    fireEvent.click(
      screen.getByRole("button", {
        name: "Provider, model and reasoning",
      }),
    );

    expect(screen.getByRole("rowheader", { name: "Codex" })).not.toBeNull();
    expect(
      screen.getByRole("rowheader", { name: "Claude Code" }),
    ).not.toBeNull();
  });

  it("sends a cell click to the selection handler as one tuple", () => {
    const props = makeExecutionControlsProps();
    renderExecutionControls(props);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Provider, model and reasoning",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "GPT-5, Medium reasoning" }),
    );

    expect(props.selection.onChange).toHaveBeenCalledExactlyOnceWith({
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "medium",
    });
    expect(props.model.onChange).not.toHaveBeenCalled();
    expect(props.reasoning.onChange).not.toHaveBeenCalled();
  });

  it("keeps showing the known model when model options fail to load", () => {
    const props = makeExecutionControlsProps();
    renderExecutionControls({
      ...props,
      model: {
        ...props.model,
        active: { model: "o4-mini" },
        options: [],
        loadFailed: true,
        loadError: { providerId: "codex", code: "failed", detail: null },
      },
    });

    const trigger = screen.getByRole("button", {
      name: "Provider, model and reasoning",
    });

    expect(trigger.textContent).toContain("o4-mini");
    expect(trigger.textContent).not.toContain("Failed to load models");
  });

  it("maps disabled fast mode to the explicit default service tier", () => {
    const onServiceTierChange = vi.fn();
    renderExecutionControls({
      ...makeExecutionControlsProps(),
      serviceTier: {
        value: "fast",
        onChange: onServiceTierChange,
        supported: true,
        options: [{ id: "fast", label: "Fast" }],
      },
    });

    const speed = screen.getByRole("button", {
      name: "Fast mode, faster responses",
    });

    expect(speed.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(speed);

    expect(onServiceTierChange).toHaveBeenCalledWith("default");
  });
});
