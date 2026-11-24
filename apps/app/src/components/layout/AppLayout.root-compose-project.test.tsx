// @vitest-environment jsdom

import {
  act,
  cleanup,
  render as renderWithoutClient,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { useStore } from "jotai";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newChatLauncherAtom } from "@/components/new-chat-launcher/new-chat-launcher";
import { AppLayout } from "./AppLayout";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";

function render(ui: ReactNode) {
  const { wrapper } = createQueryClientTestHarness();

  return renderWithoutClient(ui, { wrapper });
}

type JotaiStore = ReturnType<typeof useStore>;

function StoreProbe({ onStore }: { onStore: (store: JotaiStore) => void }) {
  onStore(useStore());

  return null;
}

const ROOT_COMPOSE_PROJECT_ID_STORAGE_KEY = "omnyo.root-compose.project-id";

const SIDEBAR_SCOPE_STORAGE_KEY = "omnyo.sidebar.scope";

const mockUseThread = vi.hoisted(() => vi.fn());

const mockUseThreadDetailBootstrap = vi.hoisted(() => vi.fn());

const commandHandlers = vi.hoisted(() => new Map<string, () => boolean>());

vi.mock("@/components/commands/AppCommandProvider", () => ({
  hasOpenModal: () => false,
  useIndexedAppCommandHandlers: () => {},
  useAppCommandKeyDispatch: () => () => false,
  useAppCommandHandler: (command: string, handler: () => boolean) => {
    commandHandlers.set(command, handler);
  },
  useAppCommandShortcut: () => null,
  useAppCommandShortcuts: () => new Map(),
  useAppCommandRunner: () => ({
    dispatch: () => false,
    getShortcutCommand: () => null,
    isCommandAvailable: () => false,
  }),
  useIsAppCommandModifierHeld: () => false,
}));

vi.mock("@/components/new-chat-launcher/NewChatLauncherOverlay", () => ({
  NewChatLauncherOverlay: () => null,
}));

vi.mock("@/components/sidebar/AppSidebar", () => ({
  AppSidebar: () => <aside data-testid="app-sidebar" />,
}));

vi.mock("./AppFooter", () => ({
  AppFooter: () => <footer data-testid="app-footer" />,
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useUiPreferences: () => ({ data: undefined, isError: false }),
  useSystemConfig: () => ({
    data: {
      experiments: {
        serverMove: false,
        performanceDiagnostics: false,
      },
    },
  }),
}));

vi.mock("@/hooks/useHostDaemon", () => ({
  useHostDaemon: () => ({ hasDaemon: false }),
  useLocalHostDaemonAccess: () => ({ accessState: "unavailable" }),
}));

vi.mock("@/hooks/usePluginSafeModeCommands", () => ({
  usePluginSafeModeCommands: () => undefined,
}));

vi.mock("@/components/project/ProjectActionsProvider", () => ({
  ProjectActionsProvider: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@/hooks/mutations/thread-state-mutations", () => ({}));

vi.mock("@/components/thread/ThreadActionsProvider", () => ({
  ThreadActionsProvider: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@/components/dialogs/ProjectPathDialog", () => ({
  ProjectPathDialog: () => null,
}));

vi.mock("./AppPageHeader", () => ({
  HEADER_ICON_BUTTON_CLASS: "header-icon-button",
  AppPageHeader: ({
    center,
    actions,
  }: {
    center?: ReactNode;
    actions?: ReactNode;
  }) => (
    <header>
      {center}
      {actions}
    </header>
  ),
}));

vi.mock("@/lib/iframe-drag-guard", () => ({
  IframeDragGuardOverlay: () => null,
}));

vi.mock("@/lib/omnyo-desktop", () => ({
  BROWSER_SIDEBAR_TRIGGER_INSET_CLASS: "",
  CHROME_ROW_CLASS: "",
  DEFAULT_DESKTOP_WINDOW_STATE: { isFullScreen: false },
  MACOS_APP_REGION_NO_DRAG_CLASS: "",
  MACOS_CHROME_CONTROL_AXIS_CLASS: "",
  MACOS_CHROME_CONTROL_NO_DRAG_CLASS: "",
  MACOS_TRAFFIC_LIGHT_RESERVE_OFFSET_CLASS: "",
  MACOS_TRAFFIC_LIGHT_RESERVE_PADDING_CLASS: "",
  MACOS_WINDOW_DRAG_CLASS: "",
  MACOS_WINDOW_NO_DRAG_CLASS: "",
  getOmnyoDesktopInfo: () => null,
  shouldReserveMacosTrafficLights: () => false,
  shouldUseMacosDesktopChrome: () => false,
}));

vi.mock("@/lib/favicon-color-preference", () => ({
  useFaviconBadge: vi.fn(),
}));

vi.mock("@/hooks/useQuickCreateProject", () => ({
  useQuickCreateProjectController: () => ({
    hostId: null,
    hostName: null,
    isCreating: false,
    platform: "darwin",
    projectPathDialog: {
      onOpenChange: vi.fn(),
      target: null,
    },
    submitProjectPath: vi.fn(),
  }),
}));

vi.mock("@/hooks/queries/sidebar-navigation-query", () => ({
  useSidebarNavigation: () => ({
    data: {
      sections: [],
      orderedProjectIds: [],
      personalProject: {
        id: "proj_personal",
        kind: "personal",
        name: "Personal",
        sources: [],
        threads: [],
        defaultExecutionOptions: null,
        createdAt: 1,
        updatedAt: 1,
      },
      projects: [
        {
          id: "proj_opened",
          kind: "standard",
          name: "Opened Project",
          sources: [],
          threads: [],
          defaultExecutionOptions: null,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "proj_scoped",
          kind: "standard",
          name: "Scoped Project",
          sources: [],
          threads: [],
          defaultExecutionOptions: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    },
    isError: false,
    isSuccess: true,
  }),
}));

vi.mock("@/hooks/queries/thread-queries", () => ({
  useArchivedThreads: () => ({ data: undefined }),
  useShelvedThreads: () => ({ data: undefined }),
  didThreadDetailBootstrapRefreshAfterMount: () => true,
  useThread: (...args: unknown[]) => mockUseThread(...args),
  useThreadDetailBootstrap: (...args: unknown[]) =>
    mockUseThreadDetailBootstrap(...args),
  useThreadPendingInteractions: () => ({ data: undefined }),
}));

describe("AppLayout root compose project preference", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    commandHandlers.clear();
    mockUseThread.mockReturnValue({
      data: {
        id: "thr_opened",
        projectId: "proj_opened",
        title: "Opened Thread",
        titleFallback: "Opened Thread",
        lastReadAt: 100,
        latestAttentionAt: 100,
      },
    });
    mockUseThreadDetailBootstrap.mockReturnValue({
      isError: false,
      isSuccess: true,
    });
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    window.sessionStorage.clear();
    commandHandlers.clear();
    vi.clearAllMocks();
  });

  it("opens the launcher over a chat instead of leaving it", async () => {
    const probe: { store: JotaiStore | null } = { store: null };

    render(
      <MemoryRouter
        initialEntries={["/projects/proj_opened/threads/thr_opened"]}
      >
        <AppLayout>
          <StoreProbe onStore={(next) => (probe.store = next)} />
          <div>Thread route</div>
        </AppLayout>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(document.title).toBe("Opened Thread");
    });

    act(() => {
      expect(commandHandlers.get("thread.new")?.()).toBe(true);
    });

    expect(probe.store?.get(newChatLauncherAtom).open).toBe(true);
    expect(screen.getByText("Thread route")).not.toBeNull();
  });

  it("shows the New chat page instead of the launcher when it is already open", () => {
    const probe: { store: JotaiStore | null } = { store: null };

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppLayout>
          <StoreProbe onStore={(next) => (probe.store = next)} />
          <div>New chat route</div>
        </AppLayout>
      </MemoryRouter>,
    );

    act(() => {
      expect(commandHandlers.get("thread.new")?.()).toBe(true);
    });

    expect(probe.store?.get(newChatLauncherAtom).open).toBe(false);
  });

  it("uses the opened thread project for the new-thread command", async () => {
    window.localStorage.setItem(
      ROOT_COMPOSE_PROJECT_ID_STORAGE_KEY,
      "proj_last_run",
    );

    render(
      <MemoryRouter
        initialEntries={["/projects/proj_opened/threads/thr_opened"]}
      >
        <AppLayout>
          <div>Thread route</div>
        </AppLayout>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(document.title).toBe("Opened Thread");
    });

    act(() => {
      expect(commandHandlers.get("thread.new")?.()).toBe(true);
    });

    await waitFor(() => {
      expect(
        window.localStorage.getItem(ROOT_COMPOSE_PROJECT_ID_STORAGE_KEY),
      ).toBe("proj_opened");
    });
  });

  it("keeps the stored project when the route has no project", () => {
    window.localStorage.setItem(
      ROOT_COMPOSE_PROJECT_ID_STORAGE_KEY,
      "proj_last_run",
    );

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppLayout>
          <div>New thread route</div>
        </AppLayout>
      </MemoryRouter>,
    );

    act(() => {
      expect(commandHandlers.get("thread.new")?.()).toBe(true);
    });

    expect(
      window.localStorage.getItem(ROOT_COMPOSE_PROJECT_ID_STORAGE_KEY),
    ).toBe("proj_last_run");
  });

  it("starts the new-thread command in the rail's project scope", () => {
    window.localStorage.setItem(
      ROOT_COMPOSE_PROJECT_ID_STORAGE_KEY,
      "proj_last_run",
    );
    window.localStorage.setItem(
      SIDEBAR_SCOPE_STORAGE_KEY,
      JSON.stringify({ kind: "project", projectId: "proj_scoped" }),
    );

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppLayout>
          <div>New thread route</div>
        </AppLayout>
      </MemoryRouter>,
    );

    act(() => {
      expect(commandHandlers.get("thread.new")?.()).toBe(true);
    });

    expect(
      window.localStorage.getItem(ROOT_COMPOSE_PROJECT_ID_STORAGE_KEY),
    ).toBe("proj_scoped");
  });

  it("prefers the rail's project scope over the opened thread's project", async () => {
    window.localStorage.setItem(
      SIDEBAR_SCOPE_STORAGE_KEY,
      JSON.stringify({ kind: "project", projectId: "proj_scoped" }),
    );

    render(
      <MemoryRouter
        initialEntries={["/projects/proj_opened/threads/thr_opened"]}
      >
        <AppLayout>
          <div>Thread route</div>
        </AppLayout>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(document.title).toBe("Opened Thread");
    });

    act(() => {
      expect(commandHandlers.get("thread.new")?.()).toBe(true);
    });

    expect(
      window.localStorage.getItem(ROOT_COMPOSE_PROJECT_ID_STORAGE_KEY),
    ).toBe("proj_scoped");
  });

  it("keeps the opened thread's project in the inbox scope", async () => {
    window.localStorage.setItem(
      SIDEBAR_SCOPE_STORAGE_KEY,
      JSON.stringify({ kind: "inbox" }),
    );

    render(
      <MemoryRouter
        initialEntries={["/projects/proj_opened/threads/thr_opened"]}
      >
        <AppLayout>
          <div>Thread route</div>
        </AppLayout>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(document.title).toBe("Opened Thread");
    });

    act(() => {
      expect(commandHandlers.get("thread.new")?.()).toBe(true);
    });

    await waitFor(() => {
      expect(
        window.localStorage.getItem(ROOT_COMPOSE_PROJECT_ID_STORAGE_KEY),
      ).toBe("proj_opened");
    });
  });
});
