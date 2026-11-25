// @vitest-environment jsdom

import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExperimentalComposerSelection } from "@omnyo/plugin-sdk";
import type { ReuseThreadOption } from "@/components/pickers/ReuseEnvironmentPicker";
import { sdk } from "@/lib/sdk";
import {
  NEW_CHAT_ENVIRONMENT_PROVIDERS,
  NEW_CHAT_HOST_IDS,
  NEW_CHAT_INPUTS_CONTROL_PROVIDER_IDS,
  NEW_CHAT_NOW,
  newChatProjectNamed,
  newChatProvidersByHostId,
  makeNewChatHosts,
} from "@/test/fixtures/new-chat";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  NewChatDock,
  NewChatStageDock,
  type NewChatDockProps,
} from "./NewChatDock";
import type { NewChatWhere } from "./new-chat-where";

vi.mock("@/lib/sdk", () => ({
  sdk: { plugins: { callRpc: vi.fn() } },
}));

vi.mock("@/components/sidebar/ProjectFace", () => ({
  ProjectIcon: ({ projectId }: { projectId: string }) => (
    <span data-project-icon={projectId} />
  ),
  ProjectFace: ({
    project,
    variant,
  }: {
    project: { id: string };
    variant: string;
  }) => <span data-project-face={project.id} data-variant={variant} />,
  useConnectedHostIds: () => new Set<string>(),
}));

vi.mock("@/hooks/queries/sidebar-navigation-query", () => ({
  useSidebarNavigation: () => ({
    data: {
      personalProject: { id: "personal" },
      projects: [
        { id: "proj_omnyoprivate", name: "omnyo-private" },
        { id: "proj_stratoclash", name: "Stratoclash" },
      ],
    },
  }),
}));

vi.mock("@/hooks/queries/project-queries", () => ({
  useProjectSourceBranches: () => ({
    data: {
      checkout: { kind: "branch", branchName: "main", headSha: "abc1234" },
      defaultBranch: "main",
      defaultWorktreeBaseBranch: "main",
    },
  }),
}));

const MAC = NEW_CHAT_HOST_IDS.macPro;

const RTX3090 = NEW_CHAT_HOST_IDS.rtx3090;

const DAY_MS = 86_400_000;

const omnyoPrivate = newChatProjectNamed("omnyo-private");

const stratoclash = newChatProjectNamed("Stratoclash");

const hosts = makeNewChatHosts({
  rtx5080: { status: "disconnected", lastSeenAt: NEW_CHAT_NOW - 3 * DAY_MS },
});

const launcherEnvironment: ReuseThreadOption = {
  environmentId: "env_launcher",
  branchName: "launcher/dock",
  name: "Launcher dock",
  path: "/Users/developer/wt/launcher-dock",
  environmentProviderId: "git-worktree",
  hostId: MAC,
  hostName: "Mac Pro",
  threads: [],
};

function renderDock({
  project = omnyoPrivate,
  projectless = false,
  where = {
    machine: { kind: "host", hostId: MAC },
    workspace: { kind: "checkout" },
  },
  select = vi.fn(async (selection: ExperimentalComposerSelection) => selection),
  worktreeOptions = [],
}: {
  project?: typeof omnyoPrivate;
  projectless?: boolean;
  where?: NewChatWhere;
  select?: (
    selection: ExperimentalComposerSelection,
  ) => Promise<ExperimentalComposerSelection>;
  worktreeOptions?: readonly ReuseThreadOption[];
} = {}) {
  const { wrapper } = createQueryClientTestHarness();
  const onProjectChange = vi.fn();

  const props: NewChatDockProps = {
    dock: {
      where,
      defaultThreadMachineId: MAC,
      rankedProjectIds: [omnyoPrivate.id, stratoclash.id],
      select,
    },
    project: {
      projects: [omnyoPrivate, stratoclash].map(({ id, name }) => ({
        id,
        name,
      })),
      value: projectless ? null : project.id,
      onChange: onProjectChange,
      allowNoProject: true,
    },
    environment: {
      value: "",
      sources: project.sources,
      host: null,
      isLocal: false,
      machines: { hosts, localDaemonHostId: MAC, primaryHostId: MAC },
      providers: NEW_CHAT_ENVIRONMENT_PROVIDERS,
      providersByHostId: newChatProvidersByHostId({
        hosts,
        sources: project.sources,
      }),
      inputsControlProviderIds: NEW_CHAT_INPUTS_CONTROL_PROVIDER_IDS,
      onRequestMachineSetup: vi.fn(),
    },
    worktree: { options: worktreeOptions, value: null, onChange: vi.fn() },
    favorites: <div data-testid="favorites-bar" />,
    approvals: null,
    sessionOptionsControl: null,
    environmentProviderInputsSlot: null,
    machineProviderInputsSlot: null,
    promptActions: undefined,
    canAttach: false,
    promptBoxRef: { current: null },
  };

  render(<NewChatDock {...props} />, {
    wrapper: ({ children }: { children: ReactNode }) => wrapper({ children }),
  });

  return { onProjectChange, select, props };
}

function renderStage(options: Parameters<typeof renderDock>[0] = {}) {
  const { props, onProjectChange, select } = renderDock(options);
  cleanup();

  const shelf = document.createElement("div");
  document.body.append(shelf);

  const { wrapper } = createQueryClientTestHarness();

  render(<NewChatStageDock {...props} shelf={shelf} />, {
    wrapper: ({ children }: { children: ReactNode }) => wrapper({ children }),
  });

  return { shelf, onProjectChange, select };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NEW_CHAT_NOW });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("NewChatDock", () => {
  it("changes the project from a dock cell", () => {
    const { onProjectChange } = renderDock();

    fireEvent.click(screen.getByRole("button", { name: "Stratoclash" }));

    expect(onProjectChange).toHaveBeenCalledExactlyOnceWith(stratoclash.id);
  });

  it("puts the favorites above one line that names the machine and workspace", () => {
    renderDock();

    const favorites = document.querySelector("[data-new-chat-favorites]");
    const where = document.querySelector("[data-new-chat-where]");
    const machine = screen.getByRole("button", { name: "Machine: Mac Pro" });

    expect(
      favorites?.querySelector('[data-testid="favorites-bar"]'),
    ).not.toBeNull();
    expect(
      favorites?.compareDocumentPosition(where as Node) ??
        Node.DOCUMENT_POSITION_PRECEDING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(machine.textContent).toBe("Mac Pro");
    expect(machine.closest("[data-new-chat-where]")).toBe(where);
    expect(
      within(where as HTMLElement).getByRole("button", {
        name: "Start in: main",
      }),
    ).toBeTruthy();
  });

  it("starts the chat in a new worktree on its machine with one toggle", async () => {
    const { select } = renderDock();

    fireEvent.click(screen.getByRole("button", { name: "New worktree" }));

    await waitFor(() =>
      expect(select).toHaveBeenCalledExactlyOnceWith({
        environment: {
          type: "host",
          hostId: MAC,
          workspace: {
            type: "managed-worktree",
            baseBranch: { kind: "default" },
          },
        },
      }),
    );
  });

  it("starts the chat in an existing worktree picked from the list", async () => {
    vi.mocked(sdk.plugins.callRpc).mockResolvedValue({
      worktrees: [
        {
          path: "/Users/developer/wt/escape-fix",
          branch: "fix/escape",
          prunable: false,
        },
      ],
    });

    const { select } = renderDock();

    fireEvent.click(screen.getByRole("button", { name: "Start in: main" }));
    fireEvent.click(await screen.findByRole("button", { name: "fix/escape" }));

    await waitFor(() =>
      expect(select).toHaveBeenCalledExactlyOnceWith({
        environment: {
          type: "host",
          hostId: MAC,
          workspace: {
            type: "unmanaged",
            path: "/Users/developer/wt/escape-fix",
          },
        },
      }),
    );
  });

  it("keeps environments listed and names the machine when the worktree list fails", async () => {
    vi.mocked(sdk.plugins.callRpc).mockRejectedValue(new Error("offline"));

    renderDock({ worktreeOptions: [launcherEnvironment] });

    fireEvent.click(screen.getByRole("button", { name: "Start in: main" }));

    expect(
      await screen.findByText("Couldn't list worktrees on the Mac Pro."),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: /^Launcher dock/ }),
    ).not.toBeNull();
  });

  it("lists an offline machine as unavailable with its age", async () => {
    renderDock();

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Machine: Mac Pro" }),
      { button: 0 },
    );

    const offline = await screen.findByRole("menuitem", { name: /5080/ });

    expect(offline.getAttribute("aria-disabled")).toBe("true");
    expect(offline.textContent).toContain("Offline · last seen 3d ago");
  });

  it("explains why Stratoclash runs on the 3090", () => {
    renderDock({
      project: stratoclash,
      where: {
        machine: { kind: "host", hostId: RTX3090 },
        workspace: { kind: "checkout" },
      },
    });

    expect(
      screen.getByText(
        "Stratoclash isn't on the Mac Pro, so it runs on the 3090. The 5080 has it too but has been offline for 3 days.",
      ),
    ).not.toBeNull();
  });

  it("ignores another machine-scoped pick until the first one has applied", async () => {
    let release = () => {};

    const select = vi.fn(
      () =>
        new Promise<ExperimentalComposerSelection>((resolve) => {
          release = () => resolve({});
        }),
    );

    const { onProjectChange } = renderDock({ select });

    fireEvent.click(screen.getByRole("button", { name: "New worktree" }));
    fireEvent.click(screen.getByRole("button", { name: "Stratoclash" }));

    expect(select).toHaveBeenCalledOnce();
    expect(onProjectChange).not.toHaveBeenCalled();

    await act(async () => release());

    fireEvent.click(screen.getByRole("button", { name: "Stratoclash" }));

    expect(onProjectChange).toHaveBeenCalledExactlyOnceWith(stratoclash.id);
  });
});

describe("NewChatStageDock", () => {
  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
  });

  it("keeps plus, machine and workspace in the card and the favorites under it", () => {
    const { shelf } = renderStage();

    const row = document.querySelector("[data-new-chat-controls]");

    expect(row).not.toBeNull();
    expect(row?.querySelector('[data-testid="favorites-bar"]')).toBeNull();
    expect(
      shelf.querySelector(
        '[data-new-chat-favorites] [data-testid="favorites-bar"]',
      ),
    ).not.toBeNull();
    expect(
      row?.querySelector('[aria-label="Machine: Mac Pro"]'),
    ).not.toBeNull();
    expect(row?.querySelector('[aria-label="Start in: main"]')).not.toBeNull();
    expect(screen.queryByRole("button", { name: "New worktree" })).toBeNull();
  });

  it("moves the project tiles out of the card onto rail plates in the shelf", () => {
    const { shelf, onProjectChange } = renderStage();

    const projects = shelf.querySelector(
      '[role="group"][aria-label="Projects"]',
    );

    expect(projects).not.toBeNull();
    expect(
      document.querySelector("[data-new-chat-controls] [aria-label=Projects]"),
    ).toBeNull();
    expect(
      shelf
        .querySelector('[data-project-face="proj_omnyoprivate"]')
        ?.getAttribute("data-variant"),
    ).toBe("tile");

    const selected = screen.getByRole("button", { name: "omnyo-private" });

    expect(selected.getAttribute("aria-pressed")).toBe("true");
    expect(selected.className).not.toContain("bg-state-active");

    fireEvent.click(screen.getByRole("button", { name: "Stratoclash" }));

    expect(onProjectChange).toHaveBeenCalledExactlyOnceWith(stratoclash.id);
  });

  it("shows the machine as an icon that lists every machine and marks the chosen one", async () => {
    renderStage({ projectless: true });

    const machine = screen.getByRole("button", { name: "Machine: Mac Pro" });

    expect(machine.textContent).toBe("");
    expect(screen.queryByText("Personal workspace")).toBeNull();

    fireEvent.pointerDown(machine, { button: 0 });

    const chosen = await screen.findByRole("menuitem", { name: /Mac Pro/ });

    expect(chosen.querySelector('[data-icon="Check"]')).not.toBeNull();
    expect(
      screen
        .getByRole("menuitem", { name: /3090/ })
        .querySelector('[data-icon="Check"]'),
    ).toBeNull();
  });

  it("opens the folded workspace menu from the machine picker", async () => {
    vi.mocked(sdk.plugins.callRpc).mockResolvedValue({ worktrees: [] });
    renderStage();

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Machine: Mac Pro" }),
      { button: 0 },
    );

    fireEvent.click(await screen.findByRole("menuitem", { name: "Start in…" }));

    expect(
      await screen.findByRole("dialog", { name: "Start in" }),
    ).not.toBeNull();
  });
});
