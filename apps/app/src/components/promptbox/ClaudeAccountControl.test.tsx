// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeAccountControl } from "./ClaudeAccountControl";

afterEach(cleanup);

const ready = {
  id: "11111111-1111-4111-8111-111111111111",
  label: "Personal Claude",
  status: "ready" as const,
  loginExpiresAt: null,
};

describe("Claude account control", () => {
  it("leaves unsupported servers without a selectable profile", () => {
    render(
      <ClaudeAccountControl
        data={{
          action: "list",
          supported: false,
          profiles: [],
          defaultSelection: { kind: "unprofiled" },
        }}
        error={false}
        selection={undefined}
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Claude account" })).toBeNull();
  });

  it("preserves an existing ordinary sign-in despite a new default", () => {
    const choose = vi.fn();
    render(
      <ClaudeAccountControl
        data={{
          action: "list",
          supported: true,
          profiles: [ready],
          defaultSelection: { kind: "profile", profileId: ready.id },
        }}
        error={false}
        selection={{ kind: "unprofiled" }}
        onChange={choose}
        handoff
      />,
    );
    expect(screen.getByText("Ordinary sign-in")).toBeTruthy();
    expect(choose).not.toHaveBeenCalled();
  });

  it("chooses a destination only after the user selects its account", async () => {
    const choose = vi.fn();
    render(
      <ClaudeAccountControl
        data={{
          action: "list",
          supported: true,
          profiles: [ready],
          defaultSelection: { kind: "unprofiled" },
        }}
        error={false}
        selection={{ kind: "unprofiled" }}
        onChange={choose}
        handoff
      />,
    );
    fireEvent.keyDown(
      screen.getByRole("button", { name: "Continue with Claude account" }),
      { key: "Enter" },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Personal Claude/ }),
    );
    expect(choose).toHaveBeenCalledExactlyOnceWith({
      kind: "profile",
      profileId: ready.id,
    });
  });
});
