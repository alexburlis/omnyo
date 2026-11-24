// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Host } from "@omnyo/domain";
import { makeHost } from "@omnyo/test-helpers/domain-fixtures";
import { TooltipProvider } from "@omnyo/shared-ui/tooltip";
import { EMPTY_ORDERED_MENTION_SUGGESTIONS } from "@omnyo/client-core";
import { INERT_TYPEAHEAD_COMMAND_CONFIG } from "./PromptBoxInternal";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SystemEnvironmentProvider,
  SystemMachineProvider,
} from "@omnyo/server-contract";
import {
  EnvironmentSlot,
  NewThreadPromptBoxUI,
  ProjectlessMachineSlot,
} from "./NewThreadPromptBox";

vi.mock("@/components/promptbox/dock/NewChatDock", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/components/promptbox/dock/NewChatDock")
  >()),
  NewChatDock: () => <div data-testid="launcher-dock" />,
  NewChatStageDock: () => <div data-testid="stage-dock" />,
}));

vi.mock("@/components/sidebar/ProjectFace", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/components/sidebar/ProjectFace")
  >()),
  ProjectIcon: () => <span data-testid="project-icon" />,
}));

const host = makeHost({
  id: "host_test",
  name: "Local host",
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("NewThreadPromptBoxUI stage input type", () => {
  const STAGE_LINE_HEIGHT = "leading-(--text-lead--line-height)";

  function renderDocked(dockLayout: "launcher" | "stage") {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <NewThreadPromptBoxUI
            value=""
            mentionRanges={[]}
            onChange={vi.fn()}
            onSubmit={vi.fn()}
            isSubmitting={false}
            disabled={false}
            history={{
              currentDraft: { text: "", mentions: [], attachments: [] },
              entries: [],
              onSelectEntry: vi.fn(),
            }}
            typeahead={{
              mention: {
                results: EMPTY_ORDERED_MENTION_SUGGESTIONS,
                isLoading: false,
                isRefreshing: false,
                isError: false,
                onQueryChange: vi.fn(),
              },
              command: INERT_TYPEAHEAD_COMMAND_CONFIG,
            }}
            attachments={{ items: [], pendingUploads: [], isAttaching: false }}
            mentionMenuPlacement="bottom"
            modeConfig={{
              environment: {
                value: "",
                sources: [],
                host: null,
                isLocal: false,
              },
              worktree: { value: null, options: [], onChange: vi.fn() },
              permission: {
                options: [],
                onChange: vi.fn(),
                supported: false,
              },
            }}
            project={{ projects: [], value: "proj_a", onChange: vi.fn() }}
            dock={{
              where: {
                machine: { kind: "unresolved" },
                workspace: { kind: "checkout" },
              },
              defaultThreadMachineId: null,
              rankedProjectIds: [],
              select: vi.fn(),
            }}
            dockLayout={dockLayout}
            execution={{
              catalog: { providers: [], verified: true, modelOptions: [] },
              provider: {},
              model: {
                selected: "",
                options: [],
                moreOptions: [],
                isLoading: false,
                loadFailed: false,
                onChange: vi.fn(),
              },
              reasoning: { value: "medium", options: [], onChange: vi.fn() },
              selection: { onChange: vi.fn() },
            }}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );

    const editorScroll = document.querySelector(
      "[data-promptbox-editor-scroll]",
    );

    const shell = editorScroll?.closest("[data-promptbox-shell]");

    if (!(shell instanceof HTMLElement)) throw new Error("Composer missing");

    return shell.className.split(/\s+/u);
  }

  it("sets the home stage input at the lead size and its 24px line height", () => {
    const classes = renderDocked("stage");

    expect(screen.getByTestId("stage-dock")).toBeTruthy();
    expect(classes).toContain("[&_[data-promptbox-editor-scroll]]:text-lead");
    expect(classes).toContain(
      `[&_[data-promptbox-editor-scroll]]:${STAGE_LINE_HEIGHT}`,
    );
    expect(classes).toContain(
      `[&_[data-promptbox-editor-scroll]_.ProseMirror]:${STAGE_LINE_HEIGHT}`,
    );
    expect(classes).toContain(
      `[&_[data-promptbox-suggestion]]:${STAGE_LINE_HEIGHT}`,
    );
  });

  it("leaves the launcher composer at its own type", () => {
    const classes = renderDocked("launcher");

    expect(screen.getByTestId("launcher-dock")).toBeTruthy();
    expect(classes.some((name) => name.includes("text-lead"))).toBe(false);
  });
});

describe("NewThreadPromptBoxUI attachment submission", () => {
  it.each(["", "Review this image"])(
    "submits immediately while an image uploads with prompt %j",
    (value) => {
      const onSubmit = vi.fn();
      const file = new File(["image"], "screenshot.png", { type: "image/png" });

      render(
        <QueryClientProvider client={new QueryClient()}>
          <TooltipProvider>
            <NewThreadPromptBoxUI
              value={value}
              mentionRanges={[]}
              onChange={vi.fn()}
              onSubmit={onSubmit}
              isSubmitting={false}
              disabled={false}
              history={{
                currentDraft: { text: value, mentions: [], attachments: [] },
                entries: [],
                onSelectEntry: vi.fn(),
              }}
              typeahead={{
                mention: {
                  results: EMPTY_ORDERED_MENTION_SUGGESTIONS,
                  isLoading: false,
                  isRefreshing: false,
                  isError: false,
                  onQueryChange: vi.fn(),
                },
                command: INERT_TYPEAHEAD_COMMAND_CONFIG,
              }}
              attachments={{
                items: [],
                pendingUploads: [
                  {
                    id: "image-upload",
                    file,
                  },
                ],
                isAttaching: true,
              }}
              mentionMenuPlacement="bottom"
              modeConfig={{
                environment: {
                  value: "",
                  sources: [],
                  host: null,
                  isLocal: false,
                },
                worktree: { value: null, options: [], onChange: vi.fn() },
                permission: {
                  options: [],
                  onChange: vi.fn(),
                  supported: false,
                },
              }}
              execution={{
                catalog: { providers: [], verified: true, modelOptions: [] },
                provider: {},
                model: {
                  selected: "",
                  options: [],
                  moreOptions: [],
                  isLoading: false,
                  loadFailed: false,
                  onChange: vi.fn(),
                },
                reasoning: { value: "medium", options: [], onChange: vi.fn() },
                selection: { onChange: vi.fn() },
              }}
            />
          </TooltipProvider>
        </QueryClientProvider>,
      );

      const submit = document.querySelector(
        "button[data-promptbox-submit-action]",
      );

      if (!(submit instanceof HTMLButtonElement))
        throw new Error("Submit button missing");
      expect(submit).toHaveProperty("disabled", false);
      fireEvent.click(submit);
      expect(onSubmit).toHaveBeenCalledOnce();
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
      expect(onSubmit).toHaveBeenCalledTimes(2);
    },
  );
});

describe("ProjectlessMachineSlot", () => {
  const secondHost: Host = {
    ...host,
    id: "host_second",
    name: "Mac Studio",
  };

  const personalWorkspaceProvider: SystemEnvironmentProvider = {
    machineProviderId: null,
    id: "personal-workspace",
    displayName: "Personal workspace",
    description: "Prepare a workspace for this thread.",
    icon: "Folder",
    logoUrl: null,
    pluginId: "environment-personal-workspace",
    acceptsEmptyInputs: true,
    machineAvailability: {},
    availability: null,
    requires: {
      projectCheckout: false,
      gitCheckout: false,
      gitRemote: false,
      projectless: true,
    },
    inputs: null,
  };

  function makeEnvironment(overrides?: {
    selectedProviderHostId?: string;
    onSelectProvider?: (
      provider: SystemEnvironmentProvider,
      hostId: string | null,
    ) => void;
    machines?: {
      hosts: Host[];
      localDaemonHostId: string | null;
      primaryHostId: string | null;
    } | null;
    machineProviders?: readonly SystemMachineProvider[];
  }) {
    return {
      value: "provider:personal-workspace",
      sources: [],
      host,
      isLocal: true,
      machines:
        overrides && "machines" in overrides
          ? overrides.machines
          : {
              hosts: [host, secondHost],
              localDaemonHostId: host.id,
              primaryHostId: host.id,
            },
      providers: [personalWorkspaceProvider],
      machineProviders: overrides?.machineProviders,
      selectedProviderHostId: overrides?.selectedProviderHostId ?? host.id,
      onSelectProvider: overrides?.onSelectProvider ?? vi.fn(),
    };
  }

  it("renders no chip without multi-machine host data", () => {
    render(
      <ProjectlessMachineSlot
        environment={makeEnvironment({ machines: null })}
      />,
    );

    expect(screen.queryByRole("button", { name: "Machine" })).toBeNull();
  });

  it("keeps the selected machine discoverable with a single host", () => {
    render(
      <ProjectlessMachineSlot
        environment={makeEnvironment({
          machines: {
            hosts: [host],
            localDaemonHostId: host.id,
            primaryHostId: host.id,
          },
        })}
      />,
    );

    expect(screen.getByRole("button", { name: "Machine" })).toBeTruthy();
  });

  it("counts provider-made machines in the projectless machine chip", () => {
    const modalHost = makeHost({
      id: "host_modal",
      name: "Modal sandbox 3f9a",
      type: "ephemeral",
      machineProviderId: "modal-sandbox",
    });

    render(
      <ProjectlessMachineSlot
        environment={makeEnvironment({
          selectedProviderHostId: modalHost.id,
          machines: {
            hosts: [host, modalHost],
            localDaemonHostId: host.id,
            primaryHostId: host.id,
          },
          machineProviders: [
            {
              id: "modal-sandbox",
              displayName: "Modal Sandbox",
              description: "Run a machine for development.",
              icon: "Cloud",
              logoUrl: null,
              pluginId: "environment-modal-sandbox",
              inputs: null,
              acceptsEmptyInputs: true,
              supportsSuspend: true,
            },
          ],
        })}
      />,
    );

    const chip = screen.getByRole("button", { name: "Machine" });
    expect(chip.querySelector('[data-icon="Cloud"]')).not.toBeNull();
    expect(chip.querySelector('[data-icon="Laptop"]')).toBeNull();
    expect(chip.textContent).toContain(modalHost.name);
    expect(chip.textContent).not.toContain("Modal Sandbox");
  });

  it("routes a machine pick through the selected provider", () => {
    const onSelectProvider = vi.fn();
    render(
      <ProjectlessMachineSlot
        environment={makeEnvironment({
          selectedProviderHostId: secondHost.id,
          onSelectProvider,
        })}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Machine" });
    expect(trigger.textContent).toContain("Mac Studio");
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: /Local host/u }));

    expect(onSelectProvider).toHaveBeenCalledWith(
      personalWorkspaceProvider,
      host.id,
    );
  });
});

describe("EnvironmentSlot", () => {
  const secondHost: Host = {
    ...host,
    id: "host_second",
    name: "Mac Studio",
  };

  const personalProvider: SystemEnvironmentProvider = {
    machineProviderId: null,
    id: "personal-workspace",
    displayName: "Personal workspace",
    description: "Prepare a workspace for this thread.",
    icon: "Folder",
    logoUrl: null,
    pluginId: "environment-personal-workspace",
    acceptsEmptyInputs: true,
    machineAvailability: {},
    availability: null,
    requires: {
      projectCheckout: false,
      gitCheckout: false,
      gitRemote: false,
      projectless: true,
    },
    inputs: null,
  };

  const sandboxProvider: SystemEnvironmentProvider = {
    machineProviderId: null,
    id: "modal-sandbox",
    displayName: "Modal sandbox",
    description: "Prepare a workspace for this thread.",
    icon: "Cloud",
    logoUrl: null,
    pluginId: "environment-modal-sandbox",
    acceptsEmptyInputs: true,
    machineAvailability: {},
    availability: null,
    requires: {
      projectCheckout: false,
      gitCheckout: false,
      gitRemote: false,
      projectless: false,
    },
    inputs: null,
  };

  const modalMachineProvider: SystemMachineProvider = {
    id: "modal-sandbox",
    displayName: "Modal sandbox",
    description: "Run a machine for development.",
    icon: "Box",
    logoUrl: null,
    pluginId: "environment-modal-sandbox",
    inputs: null,
    acceptsEmptyInputs: true,
    supportsSuspend: true,
  };

  function makeEnvironment(overrides: {
    isLoading?: boolean;
    value?: string;
    providers?: readonly SystemEnvironmentProvider[];
    machineProviders?: readonly SystemMachineProvider[];
    onSelectProvider?: (
      provider: SystemEnvironmentProvider,
      hostId: string | null,
    ) => void;
  }) {
    return {
      value: overrides.value ?? "provider:personal-workspace",
      sources: [],
      host,
      isLocal: true,
      machines: {
        hosts: [host, secondHost],
        localDaemonHostId: host.id,
        primaryHostId: host.id,
      },
      isLoading: overrides.isLoading ?? false,
      providers: overrides.providers ?? [personalProvider],
      selectedProviderHostId: host.id,
      onSelectProvider: overrides.onSelectProvider ?? vi.fn(),
      machineProviders: overrides.machineProviders,
    };
  }

  function makeWorktree(value: string | null = null) {
    return {
      options: [
        {
          environmentId: "env_personal",
          branchName: null,
          name: "Scratch space",
          path: null,
          environmentProviderId: "personal-workspace",
          threads: [{ id: "thr_1", title: "Earlier personal thread" }],
        },
      ],
      value,
      onChange: vi.fn(),
      disabled: false,
    };
  }

  it("shows environment loading before resolving to the machine slot", () => {
    const { rerender } = render(
      <EnvironmentSlot
        projectless
        environment={makeEnvironment({ providers: [], isLoading: true })}
        worktree={makeWorktree()}
      />,
    );

    expect(screen.getByRole("button", { name: "Environment" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Machine" })).toBeNull();
    rerender(
      <EnvironmentSlot
        projectless
        environment={makeEnvironment({
          providers: [personalProvider],
          isLoading: false,
        })}
        worktree={makeWorktree()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Environment" })).toBeNull();
    expect(screen.getByRole("button", { name: "Machine" })).not.toBeNull();
  });

  it("omits project-only providers from the projectless picker", () => {
    render(
      <EnvironmentSlot
        projectless
        environment={makeEnvironment({
          value: "provider:personal-workspace",
          providers: [personalProvider, sandboxProvider],
        })}
        worktree={makeWorktree()}
      />,
    );

    expect(screen.getByRole("button", { name: "Machine" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Environment" })).toBeNull();
    expect(screen.queryByText("Modal sandbox")).toBeNull();
  });

  it("keeps the machine slot when only one environment is available", () => {
    render(
      <EnvironmentSlot
        projectless
        environment={makeEnvironment({
          providers: [personalProvider],
          machineProviders: [modalMachineProvider],
        })}
        worktree={makeWorktree()}
      />,
    );
    expect(screen.getByRole("button", { name: "Machine" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Environment" })).toBeNull();
  });

  it("shows the reused environment instead of the machine slot when a thread reuses one", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <EnvironmentSlot
          projectless
          environment={makeEnvironment({
            value: "reuse:env_personal",
            providers: [personalProvider],
          })}
          worktree={makeWorktree("env_personal")}
        />
      </QueryClientProvider>,
    );

    expect(screen.queryByRole("button", { name: "Machine" })).toBeNull();
    const triggers = screen.getAllByRole("button", { name: "Environment" });
    expect(triggers).toHaveLength(2);
    expect(triggers[0]?.textContent).toContain("Reuse");
    expect(triggers[1]?.textContent).toContain("Scratch space");
  });

  it("keeps an open environment menu mounted while project scope replays", () => {
    const projectProvider = {
      ...sandboxProvider,
      requires: {
        ...sandboxProvider.requires,
        projectless: false,
      },
    };

    const environment = makeEnvironment({
      value: "reuse:env_personal",
      providers: [personalProvider, projectProvider],
    });

    const queryClient = new QueryClient();

    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <EnvironmentSlot
          projectless={false}
          environment={environment}
          worktree={makeWorktree("env_personal")}
        />
      </QueryClientProvider>,
    );

    const trigger = screen.getAllByRole("button", { name: "Environment" })[0];
    fireEvent.click(trigger!);
    expect(screen.getByRole("dialog", { name: "Environment" })).toBeTruthy();

    rerender(
      <QueryClientProvider client={queryClient}>
        <EnvironmentSlot
          projectless
          environment={environment}
          worktree={makeWorktree("env_personal")}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("dialog", { name: "Environment" })).toBeTruthy();
    expect(document.querySelector('button[aria-label="Environment"]')).toBe(
      trigger,
    );
  });

  it("keeps an open environment menu mounted while projectless options settle", () => {
    const loadingEnvironment = makeEnvironment({
      providers: [personalProvider],
      isLoading: true,
    });

    const queryClient = new QueryClient();

    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <EnvironmentSlot
          projectless
          environment={loadingEnvironment}
          worktree={makeWorktree()}
        />
      </QueryClientProvider>,
    );

    const trigger = screen.getByRole("button", { name: "Environment" });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Environment" })).toBeTruthy();

    rerender(
      <QueryClientProvider client={queryClient}>
        <EnvironmentSlot
          projectless
          environment={{ ...loadingEnvironment, isLoading: false }}
          worktree={makeWorktree()}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("dialog", { name: "Environment" })).toBeTruthy();
    expect(document.querySelector('button[aria-label="Environment"]')).toBe(
      trigger,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "Environment" })).toBeNull();
    expect(screen.getByRole("button", { name: "Machine" })).toBeTruthy();
  });
});
