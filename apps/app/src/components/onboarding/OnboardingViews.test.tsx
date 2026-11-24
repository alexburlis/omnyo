// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentStep,
  DevicesStep,
  OnboardingLayout,
  type OnboardingAgent,
  type OnboardingConnectState,
} from "./OnboardingViews";
import { onboardingSteps, type AgentSetupState } from "./onboarding-model";

function agent(id: string, state: AgentSetupState): OnboardingAgent {
  return { id, name: id, provider: { id, logoUrl: null }, state };
}

function renderAgents(agents: OnboardingAgent[]) {
  const handlers = {
    onSignIn: vi.fn(),
    onInstall: vi.fn(),
    onViewInstallLog: vi.fn(),
    onCancelSignIn: vi.fn(),
    onRecheck: vi.fn(),
  };

  render(<AgentStep machineName="bee" agents={agents} {...handlers} />);

  return handlers;
}

afterEach(cleanup);

describe("AgentStep", () => {
  it("offers the install log only on the agent whose install failed", () => {
    const handlers = renderAgents([
      agent("claude-code", { status: "install", canInstall: true }),
      agent("codex", {
        status: "installFailed",
        message: "Install failed",
        canInstall: true,
      }),
      agent("pi", { status: "installing" }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "View log" }));

    expect(handlers.onViewInstallLog).toHaveBeenCalledExactlyOnceWith("codex");
    expect(handlers.onInstall).not.toHaveBeenCalled();
  });

  it("keeps the install log reachable when the machine offers no retry", () => {
    const handlers = renderAgents([
      agent("codex", {
        status: "installFailed",
        message: "Install failed",
        canInstall: false,
      }),
    ]);

    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View log" }));

    expect(handlers.onViewInstallLog).toHaveBeenCalledExactlyOnceWith("codex");
  });
});

function renderDevices(connect: OnboardingConnectState) {
  render(
    <DevicesStep
      connect={connect}
      connectSetup={null}
      connectSetupOpen={false}
      otherMachineCount={0}
      onToggleConnectSetup={vi.fn()}
      onCopyConnectUrl={vi.fn()}
      onAddMachine={vi.fn()}
    />,
  );
}

describe("DevicesStep", () => {
  it("leaves out browser access when the connect plugin is off", () => {
    renderDevices({ status: "unavailable" });

    expect(screen.queryByText("Open Omnyo from any browser")).toBeNull();
    expect(screen.getByRole("button", { name: "Add machine" })).toBeTruthy();
  });

  it("offers browser access setup when the connect plugin is on but not set up", () => {
    renderDevices({ status: "off" });

    expect(screen.getByText("Open Omnyo from any browser")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set up" })).toBeTruthy();
  });
});

function renderLayout(chatImporterEnabled: boolean) {
  const onSelectStep = vi.fn();

  render(
    <OnboardingLayout
      step="chats"
      steps={onboardingSteps({
        browserLogins: false,
        chatImporterEnabled,
        automationsEnabled: false,
      })}
      title="Pick up where you left off"
      description="Bring your chats."
      primaryLabel="Continue"
      onPrimary={vi.fn()}
      onSelectStep={onSelectStep}
      onSkipAll={vi.fn()}
    >
      <p>Import panel</p>
    </OnboardingLayout>,
  );

  return onSelectStep;
}

function stepButtons() {
  return within(screen.getByRole("navigation", { name: "Setup steps" }))
    .getAllByRole("button")
    .map((button) => ({
      label: button.textContent?.replace(/^\d+/, "") ?? "",
      current: button.getAttribute("aria-current") === "step",
      done: !(button as HTMLButtonElement).disabled,
      button,
    }));
}

describe("OnboardingLayout stepper", () => {
  it("lists the chats step between projects and plugins and marks it current", () => {
    renderLayout(true);

    const steps = stepButtons();

    expect(steps.map((step) => step.label)).toEqual([
      "Agent",
      "Projects",
      "Chats",
      "Plugins",
      "Devices",
    ]);

    expect(
      steps.filter((step) => step.current).map((step) => step.label),
    ).toEqual(["Chats"]);
  });

  it("leaves the chats step out when the chat importer is off", () => {
    renderLayout(false);

    expect(stepButtons().map((step) => step.label)).toEqual([
      "Agent",
      "Projects",
      "Plugins",
      "Devices",
    ]);
  });

  it("lets a finished step be revisited from the stepper", () => {
    const onSelectStep = renderLayout(true);

    const projects = stepButtons().find((step) => step.label === "Projects");

    expect(projects?.done).toBe(true);
    fireEvent.click(projects!.button);

    expect(onSelectStep).toHaveBeenCalledExactlyOnceWith("projects");
  });
});
