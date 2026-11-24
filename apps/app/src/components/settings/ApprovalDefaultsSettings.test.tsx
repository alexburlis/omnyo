// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultAppSettings } from "@omnyo/domain";
import { makeProviderInfo } from "@omnyo/test-helpers/domain-fixtures";
import { ApprovalDefaultsSettings } from "./ApprovalDefaultsSettings";

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemExecutionOptions: () => ({
    data: {
      models: [{ model: "model-a", displayName: "Model A" }],
      selectedOnlyModels: [],
      modelLoadError: null,
    },
    isPending: false,
    isError: false,
  }),
}));

afterEach(cleanup);

describe("ApprovalDefaultsSettings", () => {
  it("saves the global default without changing model overrides", () => {
    const onChange = vi.fn();
    render(
      <ApprovalDefaultsSettings
        disabled={false}
        providers={[]}
        settings={defaultAppSettings}
        onChange={onChange}
      />,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "Permission mode" }), {
      key: "Enter",
    });
    fireEvent.click(screen.getByRole("menuitem", { name: /Accept Edits/ }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith({
      defaultPermissionMode: "accept-edits",
    });
  });

  it("resets one model to inheritance while preserving other model overrides", () => {
    const onChange = vi.fn();
    render(
      <ApprovalDefaultsSettings
        disabled={false}
        providers={[
          makeProviderInfo({ id: "provider-a", displayName: "Provider A" }),
        ]}
        settings={{
          ...defaultAppSettings,
          modelPermissionModes: {
            "provider-a": { "model-a": "full", "model-b": "accept-edits" },
          },
        }}
        onChange={onChange}
      />,
    );
    fireEvent.keyDown(
      screen.getByRole("button", { name: "Approval override model" }),
      { key: "Enter" },
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Model A" }));
    fireEvent.keyDown(
      screen.getByRole("button", { name: "Model approval mode" }),
      { key: "Enter" },
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Use default" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith({
      modelPermissionModes: { "provider-a": { "model-b": "accept-edits" } },
    });
  });
});
