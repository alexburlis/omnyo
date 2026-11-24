// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { makeProviderInfo } from "@omnyo/test-helpers/domain-fixtures";
import { afterEach, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { ModelReasoningPicker } from "./ModelReasoningPicker";
import type { ModelPickerOption } from "./model-picker-option";

const MEDIUM = [{ value: "medium", label: "Medium" }];

function modelRow(value: string, label: string): ModelPickerOption {
  return {
    value,
    label,
    reasoningOptions: MEDIUM,
    defaultReasoningLevel: "medium",
    serviceTierOptions: [],
  };
}

const menu = vi.hoisted(() => ({ imports: 0, release: () => {} }));

vi.mock("./ModelReasoningMenu", async (importOriginal) => {
  menu.imports += 1;
  await new Promise<void>((resolve) => {
    menu.release = resolve;
  });

  return importOriginal();
});

afterEach(cleanup);

it("keeps search typing and keyboard selection across the first menu download", async () => {
  const onSelectionChange = vi.fn(() => true);
  const { wrapper } = createQueryClientTestHarness();

  const modelOptions = [
    modelRow("gpt-5.5", "GPT-5.5"),
    modelRow("gpt-5.2", "GPT-5.2"),
    modelRow("gpt-4.1", "GPT-4.1"),
    modelRow("o3", "o3"),
    modelRow("o4-mini", "o4-mini"),
    modelRow("sonnet-in-codex", "Sonnet"),
  ];

  render(
    <ModelReasoningPicker
      providers={[makeProviderInfo({ id: "codex", displayName: "Codex" })]}
      providerOptions={[
        { value: "codex", label: "Codex", brandPrefix: "GPT-" },
      ]}
      selectedProviderId="codex"
      onSelectedProviderChange={() => {}}
      hasMultipleProviders={false}
      modelValue="gpt-5.5"
      modelOptions={modelOptions}
      moreModelOptions={[]}
      catalogModelOptions={modelOptions}
      modelCatalogIsVerified
      modelIsLoading={false}
      modelLoadError={null}
      onModelChange={() => {}}
      reasoningValue="medium"
      reasoningOptions={MEDIUM}
      onReasoningChange={() => {}}
      onSelectionChange={onSelectionChange}
      serviceTierValue={undefined}
      serviceTierOptions={[]}
      onServiceTierChange={() => {}}
      modal={false}
    />,
    { wrapper },
  );
  await act(async () => {});
  expect(menu.imports).toBe(0);
  expect(screen.queryByPlaceholderText("Search models")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Provider, model and reasoning" }),
  );
  await waitFor(() => expect(menu.imports).toBe(1));
  const search = screen.getByPlaceholderText("Search models");
  await waitFor(() => expect(document.activeElement).toBe(search));
  expect(
    screen.getByRole("status", { name: "Loading model picker" }),
  ).toBeTruthy();
  fireEvent.change(search, { target: { value: "o4m" } });
  fireEvent.keyDown(search, { key: "ArrowDown" });
  expect(menu.imports).toBe(1);
  await act(async () => menu.release());
  expect(await screen.findByText("o4-mini")).toBeTruthy();
  expect(screen.queryByText("Sonnet")).toBeNull();
  expect(search).toHaveProperty("value", "o4m");
  expect(document.activeElement).toBe(search);
  fireEvent.keyDown(search, { key: "Enter" });
  expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith({
    providerId: "codex",
    model: "o4-mini",
    reasoningLevel: "medium",
  });
});
