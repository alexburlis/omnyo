// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadMachineStatusBanner } from "./ThreadMachineStatus";

const provider = {
  id: "modal-sandbox",
  displayName: "Modal Sandbox",
  description: "Run a machine for development.",
  icon: "Cloud",
  logoUrl: null,
  pluginId: "environment-modal-sandbox",
  inputs: null,
  acceptsEmptyInputs: true,
  supportsSuspend: true,
};

afterEach(cleanup);

describe("ThreadMachineStatusBanner", () => {
  it("names the paused state generically and keeps the provider icon", () => {
    const { container } = render(
      <ThreadMachineStatusBanner
        host={{
          name: "Modal sandbox ugxe6e",
          type: "ephemeral",
          machineProviderId: provider.id,
        }}
        provider={provider}
        phase="suspended"
        error={null}
        onResume={vi.fn()}
      />,
    );

    expect(screen.getByRole("status").textContent).toBe("Machine is paused");
    expect(container.querySelector('[data-icon="Cloud"]')).not.toBeNull();
    expect(screen.queryByText("Modal sandbox ugxe6e")).toBeNull();
    expect(screen.queryByText(provider.displayName)).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Resume" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it.each([
    ["suspending", "Machine is pausing…"],
    ["resuming", "Machine is resuming…"],
  ] as const)("renders the durable %s phase", (phase, status) => {
    render(
      <ThreadMachineStatusBanner
        host={{
          name: "Modal sandbox ugxe6e",
          type: "ephemeral",
          machineProviderId: provider.id,
        }}
        provider={provider}
        phase={phase}
        error={null}
        onResume={vi.fn()}
      />,
    );

    expect(screen.getByRole("status").textContent).toBe(status);
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  });

  it("names a failed resume and keeps the reason visible beside Try again", () => {
    const onResume = vi.fn();
    render(
      <ThreadMachineStatusBanner
        host={{
          name: "Modal sandbox ugxe6e",
          type: "ephemeral",
          machineProviderId: provider.id,
        }}
        provider={provider}
        phase="suspended"
        error="Modal is temporarily unavailable."
        onResume={onResume}
      />,
    );

    expect(screen.getByRole("status").textContent).toBe(
      "Couldn’t resume the machine",
    );
    expect(screen.getByRole("alert").textContent).toBe(
      "Modal is temporarily unavailable.",
    );
    screen.getByRole("button", { name: "Try again" }).click();
    expect(onResume).toHaveBeenCalledTimes(1);
  });
});
