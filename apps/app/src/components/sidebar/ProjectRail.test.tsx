// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Host } from "@omnyo/domain";
import type { SidebarBootstrapResponse } from "@omnyo/server-contract";
import {
  makeHost,
  makeThreadListEntry,
  makeThreadWorkSummary,
} from "@omnyo/test-helpers/domain-fixtures";
import { CompactViewportOverrideProvider } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { TooltipProvider } from "@omnyo/shared-ui/tooltip";
import { SidebarProvider } from "@/components/ui/sidebar";
import { buildProjectFileContentUrl } from "@/lib/file-content-urls";
import { useRootComposeProjectId } from "@/lib/root-compose-selection";
import { focusWithKeyboard } from "@/test/keyboard-focus";
import { InboxRailTile, ProjectRailTiles } from "./ProjectRail";
import { useProjectRailCatalog } from "./project-rail-catalog";
import { sidebarHiddenGroupsAtom } from "./projectRailPreferences";
import { railAttentionFixtureCatalog } from "./rail-attention.fixture";
import { useSetSidebarScope, useSidebarScope } from "./sidebarScope";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  reorder: vi.fn(),
  openCreateDialog: vi.fn(),
}));

let navigation: SidebarBootstrapResponse = railAttentionFixtureCatalog();

let hosts: Host[] = [];

vi.mock("@/hooks/queries/sidebar-navigation-query", () => ({
  useSidebarNavigation: () => ({ data: navigation, isPlaceholderData: false }),
}));

vi.mock("@/hooks/queries/host-queries", () => ({
  useHosts: () => ({ data: hosts }),
}));

let quickCreateProject = { isAvailable: true, isCreating: false };

vi.mock("@/hooks/useQuickCreateProject", () => ({
  useQuickCreateProjectController: () => ({
    ...quickCreateProject,
    openCreateDialog: mocks.openCreateDialog,
  }),
}));

vi.mock("@/lib/sdk", () => ({
  sdk: {
    files: { list: mocks.list },
    projects: { reorder: mocks.reorder },
  },
}));

function Harness({ currentProjectId }: { currentProjectId: string | null }) {
  const catalog = useProjectRailCatalog();
  const scope = useSidebarScope();
  const setScope = useSetSidebarScope();
  const location = useLocation();
  const [composeProjectId] = useRootComposeProjectId();

  return (
    <>
      <InboxRailTile
        counts={catalog.inbox}
        attentionRoots={catalog.attentionRoots}
        triage={catalog.triage}
        scope={scope}
        onSelectScope={setScope}
      />
      <ProjectRailTiles
        entries={catalog.entries}
        scope={scope}
        currentProjectId={currentProjectId}
        onSelectScope={setScope}
      />
      <output data-testid="location">{location.pathname}</output>
      <output data-testid="location-state">
        {JSON.stringify(location.state)}
      </output>
      <output data-testid="compose-project">{composeProjectId}</output>
    </>
  );
}

function renderRail(
  store = createStore(),
  isCompactViewport = false,
  currentProjectId: string | null = null,
) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <Provider store={store}>
        <MemoryRouter
          initialEntries={["/projects/proj_omnyo/threads/thr_omnyo_idle"]}
        >
          <TooltipProvider>
            <SidebarProvider>
              <CompactViewportOverrideProvider
                isCompactViewport={isCompactViewport}
              >
                <Harness currentProjectId={currentProjectId} />
              </CompactViewportOverrideProvider>
            </SidebarProvider>
          </TooltipProvider>
        </MemoryRouter>
      </Provider>
    </QueryClientProvider>,
  );
}

function tiles(): HTMLElement[] {
  return within(screen.getByRole("group", { name: "Projects" }))
    .getAllByRole("button")
    .filter((button) => button.hasAttribute("data-rail-tile"));
}

function tile(projectId: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(
    `[data-rail-project="${projectId}"] button`,
  );

  if (button === null) throw new Error(`Expected a tile for ${projectId}`);

  return button;
}

function inbox(): HTMLElement {
  return screen.getByRole("button", { name: /^Inbox/u });
}

function badge(button: HTMLElement) {
  const element =
    button.querySelector<HTMLElement>("[data-rail-tile-badge]") ??
    button.parentElement?.querySelector<HTMLElement>(
      "[data-rail-tile-badge]",
    ) ??
    null;

  return element === null
    ? null
    : {
        count: element.textContent,
        kind: element.dataset.railTileBadge,
        failedColor: element.classList.contains("bg-destructive"),
        needsColor: element.classList.contains("bg-attention"),
      };
}

beforeEach(() => {
  navigation = railAttentionFixtureCatalog();
  hosts = [];
  mocks.list.mockReset();
  mocks.reorder.mockReset();
  mocks.openCreateDialog.mockReset();
  quickCreateProject = { isAvailable: true, isCreating: false };
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("ProjectRail", () => {
  it("lists every catalog project in order, empty projects included and Personal last", () => {
    renderRail();

    expect(tiles().map((button) => button.getAttribute("aria-label"))).toEqual([
      "omnyo-private, 1 failed, 1 needs you, 1 running",
      "web, 2 failed, 3 running",
      "ops, 2 running",
      "empty",
      "Personal, 1 needs you, 1 running",
      "Add project",
    ]);
    expect(inbox().getAttribute("aria-label")).toBe(
      "Inbox, 2 need you, 3 failed, 2 unread, 7 running",
    );
  });

  it("opens the counted project attention chats directly from the rail badge", async () => {
    renderRail();

    fireEvent.click(
      screen.getByRole("button", { name: /^Show Attention in omnyo-private/u }),
    );

    const list = await screen.findByRole("dialog", {
      name: "Attention in omnyo-private",
    });

    const links = within(list).getAllByRole("link");
    expect(links).toHaveLength(2);
    const [first] = links;

    if (first === undefined) throw new Error("Expected an attention chat");
    const href = first.getAttribute("href");
    expect(href).toMatch(/^\/projects\/proj_omnyo\/threads\//u);
    fireEvent.click(first);
    expect(screen.getByTestId("location").textContent).toBe(href);
  });

  it("badges failed plus needs-you roots from the shared fixture, red when any failed", () => {
    renderRail();

    expect(badge(tile("proj_omnyo"))).toEqual({
      count: "2",
      kind: "failed",
      failedColor: true,
      needsColor: false,
    });
    expect(badge(tile("proj_web"))?.count).toBe("2");
    expect(badge(tile("proj_ops"))).toBeNull();
    expect(badge(tile("proj_empty"))).toBeNull();
    expect(badge(tile("proj_personal"))).toEqual({
      count: "1",
      kind: "needs",
      failedColor: false,
      needsColor: true,
    });
    expect(badge(inbox())).toEqual({
      count: "5",
      kind: "failed",
      failedColor: true,
      needsColor: false,
    });
  });

  it("keeps optional input out of the Inbox badge and retains ready-to-archive counts in its tooltip", async () => {
    const ready = (id: string, lastReadAt: number) =>
      makeThreadListEntry({
        id,
        projectId: "proj_omnyo",
        lastReadAt,
        latestAttentionAt: 200,
        work: makeThreadWorkSummary({
          primary: {
            label: "ready-to-archive",
            reason: { code: "test", text: "Done" },
          },
          optionalInput: [
            {
              id: `${id}_optional`,
              kind: "question",
              label: "Any preference?",
            },
          ],
        }),
      });

    navigation = {
      ...navigation,
      projects: navigation.projects.map((project) =>
        project.id === "proj_omnyo"
          ? {
              ...project,
              threads: [
                ...project.threads,
                ready("ready_a", 200),
                ready("ready_b", 200),
              ],
            }
          : project,
      ),
    };
    renderRail();

    expect(badge(inbox())?.count).toBe("5");
    expect(document.querySelector("[data-inbox-triage]")).toBeNull();
    expect(inbox().getAttribute("aria-label")).toBe(
      "Inbox, 2 need you, 3 failed, 2 unread, 2 ready to archive, 7 running",
    );

    focusWithKeyboard(inbox());

    const tooltip = await screen.findByRole("tooltip");

    const rows = [
      ...tooltip.querySelectorAll<HTMLElement>("[data-inbox-triage-row]"),
    ].map((row) => [row.dataset.inboxTriageRow, row.textContent]);

    expect(rows).toEqual([
      ["needs", "2 need you"],
      ["failed", "3 failed"],
      ["unread", "2 unread"],
      ["ready", "2 ready to archive"],
    ]);
  });

  it("marks running work, new results and quiet projects", () => {
    renderRail();

    const running = (projectId: string) =>
      tile(projectId).querySelector("[data-rail-tile-running]") !== null;

    const pill = (button: HTMLElement) =>
      button.querySelector<HTMLElement>("[data-rail-tile-pill]")?.dataset
        .railTilePill;

    expect(
      ["proj_omnyo", "proj_web", "proj_ops", "proj_empty", "proj_personal"].map(
        (projectId) => [
          running(projectId),
          pill(tile(projectId)),
          tile(projectId).hasAttribute("data-quiet"),
        ],
      ),
    ).toEqual([
      [true, "none", false],
      [true, "none", false],
      [true, "none", false],
      [false, "none", true],
      [true, "none", false],
    ]);
    expect(inbox().querySelector("[data-rail-tile-running]")).not.toBeNull();
  });

  it("keeps status in fixed markers: the running bar replaces the corner spinner and no unread dot sits beside the tile", () => {
    renderRail();

    const runningBar = tile("proj_omnyo").querySelector<HTMLElement>(
      "[data-rail-tile-running]",
    );

    expect(runningBar?.querySelector("svg")).toBeNull();
    expect(runningBar?.classList.contains("bg-success")).toBe(true);
    expect(document.querySelector("[data-rail-tile-unread]")).toBeNull();
    expect(badge(tile("proj_web"))?.kind).toBe("failed");

    fireEvent.click(tile("proj_web"));

    expect(tile("proj_web").getAttribute("aria-pressed")).toBe("true");
    expect(pillOf(tile("proj_web"))).toBe("selected");
  });

  it.each(["working", "needs-you"] as const)(
    "hides the project unread pill during %s activity, keeps the Inbox unread count, and restores the pill after completion",
    (label) => {
      const active = makeThreadListEntry({
        id: "active",
        projectId: "proj_omnyo",
        work: makeThreadWorkSummary({
          primary: { label, reason: { code: "test", text: "Work is running" } },
          activity: [
            {
              id: "job",
              kind: "command",
              phase: "running",
              label: "Command",
              actor: { kind: "agent", id: null, label: "Agent" },
            },
          ],
        }),
      });

      const unread = makeThreadListEntry({
        id: "unread",
        projectId: "proj_omnyo",
        lastReadAt: 100,
        latestAttentionAt: 200,
      });

      navigation = {
        ...navigation,
        projects: navigation.projects.map((project) => ({
          ...project,
          threads: project.id === "proj_omnyo" ? [active, unread] : [],
        })),
        personalProject: { ...navigation.personalProject, threads: [] },
      };
      renderRail();

      expect(pillOf(tile("proj_omnyo"))).toBe("none");
      expect(tile("proj_omnyo").getAttribute("aria-label")).not.toContain(
        "unread",
      );
      expect(inbox().getAttribute("aria-label")).toContain("1 unread");

      navigation = {
        ...navigation,
        projects: navigation.projects.map((project) => ({
          ...project,
          threads: project.id === "proj_omnyo" ? [unread] : [],
        })),
      };
      cleanup();
      renderRail();
      expect(pillOf(tile("proj_omnyo"))).toBe("fresh");
    },
  );

  it("selects a scope on click and marks the selected tile", () => {
    renderRail();

    expect(inbox().getAttribute("aria-pressed")).toBe("true");
    expect(pillOf(inbox())).toBe("selected");

    fireEvent.click(tile("proj_empty"));

    expect(tile("proj_empty").getAttribute("aria-pressed")).toBe("true");
    expect(pillOf(tile("proj_empty"))).toBe("selected");
    expect(inbox().getAttribute("aria-pressed")).toBe("false");
    expect(
      JSON.parse(window.localStorage.getItem("omnyo.sidebar.scope") ?? ""),
    ).toEqual({ kind: "project", projectId: "proj_empty" });

    fireEvent.click(inbox());
    expect(inbox().getAttribute("aria-pressed")).toBe("true");
    expect(tile("proj_empty").getAttribute("aria-pressed")).toBe("false");
  });

  it("marks the project the page shows while the Inbox stays selected", () => {
    renderRail(createStore(), false, "proj_web");

    expect(inbox().getAttribute("aria-pressed")).toBe("true");
    expect(pillOf(inbox())).toBe("selected");
    expect(inbox().hasAttribute("aria-current")).toBe(false);
    expect(tile("proj_web").getAttribute("aria-current")).toBe("location");
    expect(tile("proj_web").getAttribute("aria-pressed")).toBe("false");
    expect(pillOf(tile("proj_web"))).toBe("current");
    expect(
      ["proj_omnyo", "proj_ops", "proj_empty", "proj_personal"].map(
        (projectId) => tile(projectId).hasAttribute("aria-current"),
      ),
    ).toEqual([false, false, false, false]);
  });

  it("draws the selected pill when the scope is the current project", () => {
    renderRail(createStore(), false, "proj_empty");

    fireEvent.click(tile("proj_empty"));

    expect(tile("proj_empty").getAttribute("aria-pressed")).toBe("true");
    expect(tile("proj_empty").getAttribute("aria-current")).toBe("location");
    expect(pillOf(tile("proj_empty"))).toBe("selected");
  });

  it("opens the add-project dialog from the last rail tile", () => {
    renderRail();

    fireEvent.click(screen.getByRole("button", { name: "Add project" }));

    expect(mocks.openCreateDialog).toHaveBeenCalledTimes(1);
  });

  it("disables the add-project tile while a project is being created", () => {
    quickCreateProject = { isAvailable: true, isCreating: true };
    renderRail();

    const button = screen.getByRole("button", { name: "Adding project…" });

    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(mocks.openCreateDialog).not.toHaveBeenCalled();
  });

  it("starts a new chat in the project from its context menu", async () => {
    renderRail();

    fireEvent.contextMenu(tile("proj_web"));
    const menu = await screen.findByRole("menu", { name: "web options" });

    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual([
      "New chat in web",
      "Project settings",
      "Move up",
      "Move down",
      "Hide from rail",
    ]);

    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "New chat in web" }),
    );

    expect(screen.getByTestId("location").textContent).toBe("/");
    expect(screen.getByTestId("location-state").textContent).toBe(
      JSON.stringify({ focusPrompt: true }),
    );
    expect(screen.getByTestId("compose-project").textContent).toBe("proj_web");
  });

  it("opens project settings from the context menu, except for Personal", async () => {
    renderRail();

    fireEvent.contextMenu(tile("proj_personal"));

    const personalMenu = await screen.findByRole("menu", {
      name: "Personal options",
    });

    expect(
      within(personalMenu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual([
      "New chat in Personal",
      "Move up",
      "Move down",
      "Hide from rail",
    ]);
    fireEvent.keyDown(personalMenu, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByRole("menu", { name: "Personal options" }),
      ).toBeNull(),
    );

    fireEvent.contextMenu(tile("proj_ops"));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Project settings" }),
    );

    expect(screen.getByTestId("location").textContent).toBe(
      "/settings/projects/proj_ops",
    );
  });

  it("recovers a failed project image, rediscovers its path and bounds retries until focus returns", async () => {
    hosts = [makeHost({ id: "host_mac", status: "connected" })];
    navigation = {
      ...navigation,
      projects: navigation.projects.map((project) =>
        project.id === "proj_web"
          ? {
              ...project,
              sources: [
                {
                  id: "src_web",
                  projectId: "proj_web",
                  type: "local_path",
                  isDefault: true,
                  hostId: "host_mac",
                  path: "/Users/developer/projects/web",
                  createdAt: 0,
                  updatedAt: 0,
                },
              ],
            }
          : project,
      ),
    };
    mocks.list.mockResolvedValue({
      files: [{ path: "public/icon.svg", name: "icon.svg" }],
      truncated: false,
    });

    renderRail();

    const image = await waitFor(() => {
      const found = tile("proj_web").querySelector("img");

      if (found === null) throw new Error("Expected the project icon");

      return found;
    });

    expect(image.getAttribute("src")).toBe(
      buildProjectFileContentUrl("proj_web", "public/icon.svg", {
        environmentId: null,
        hostId: "host_mac",
      }),
    );
    expect(image.getAttribute("alt")).toBe("");
    expect(
      tile("proj_omnyo").querySelector("[data-rail-tile-monogram]")
        ?.textContent,
    ).toBe("op");

    vi.useFakeTimers();
    fireEvent.error(image);

    expect(tile("proj_web").querySelector("img")).toBeNull();
    expect(
      tile("proj_web").querySelector("[data-rail-tile-monogram]")?.textContent,
    ).toBe("we");

    mocks.list.mockResolvedValue({
      files: [{ path: "assets/icon.png", name: "icon.png" }],
      truncated: false,
    });
    await act(() => vi.advanceTimersByTimeAsync(1000));
    vi.useRealTimers();

    const recovered = await waitFor(() => {
      const found = tile("proj_web").querySelector("img");
      expect(found?.getAttribute("src")).toContain("assets/icon.png");

      return found!;
    });

    vi.useFakeTimers();
    fireEvent.error(recovered);
    await act(() => vi.advanceTimersByTimeAsync(2000));
    vi.useRealTimers();

    const lastAttempt = await waitFor(() => {
      const found = tile("proj_web").querySelector("img");
      expect(found).not.toBeNull();

      return found!;
    });

    vi.useFakeTimers();
    fireEvent.error(lastAttempt);
    await act(() => vi.advanceTimersByTimeAsync(10000));
    expect(tile("proj_web").querySelector("img")).toBeNull();
    vi.useRealTimers();

    fireEvent.focus(window);
    await waitFor(() =>
      expect(tile("proj_web").querySelector("img")).not.toBeNull(),
    );
  });
});

function pillOf(button: HTMLElement): string | undefined {
  return button.querySelector<HTMLElement>("[data-rail-tile-pill]")?.dataset
    .railTilePill;
}

function tileOrder(): (string | undefined)[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-rail-project]"),
  ).map((element) => element.dataset.railProject);
}

function hiddenProjectsTile(): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    "[data-rail-hidden-projects]",
  );

  if (element === null) throw new Error("Expected the hidden projects tile");

  return element;
}

async function chooseFromTileMenu(projectId: string, name: string) {
  fireEvent.contextMenu(tile(projectId));
  fireEvent.click(await screen.findByRole("menuitem", { name }));
}

describe("ProjectRail arrangement", () => {
  it("moves Personal from the last position and restores its saved position after reload", async () => {
    mocks.reorder.mockResolvedValue({});
    const { unmount } = renderRail();

    fireEvent.keyDown(tile("proj_personal"), {
      key: "ArrowUp",
      altKey: true,
    });

    await waitFor(() =>
      expect(mocks.reorder).toHaveBeenCalledWith({
        projectId: "proj_personal",
        previousProjectId: "proj_ops",
        nextProjectId: "proj_empty",
      }),
    );

    const savedOrder = [
      "proj_omnyo",
      "proj_web",
      "proj_ops",
      "proj_personal",
      "proj_empty",
    ];

    expect(tileOrder()).toEqual(savedOrder);
    unmount();
    navigation = { ...navigation, orderedProjectIds: savedOrder };
    renderRail();

    expect(tileOrder()).toEqual(savedOrder);
  });

  it("moves projects through projects.reorder and keeps Personal last", async () => {
    mocks.reorder.mockResolvedValue({});
    renderRail();

    await chooseFromTileMenu("proj_web", "Move up");

    expect(mocks.reorder).toHaveBeenCalledWith({
      projectId: "proj_web",
      previousProjectId: null,
      nextProjectId: "proj_omnyo",
    });
    expect(tileOrder()).toEqual([
      "proj_web",
      "proj_omnyo",
      "proj_ops",
      "proj_empty",
      "proj_personal",
    ]);
    expect(
      document.querySelector("[data-rail-announcement]")?.textContent,
    ).toBe("Moved web to position 1 of 5");
  });

  it("moves with Alt+Arrow keys, ignores plain keys and restores the order when saving fails", async () => {
    mocks.reorder.mockRejectedValue(new Error("offline"));
    renderRail();

    expect(tile("proj_ops").getAttribute("aria-keyshortcuts")).toBe(
      "Alt+ArrowUp Alt+ArrowDown",
    );
    expect(tile("proj_personal").getAttribute("aria-keyshortcuts")).toBe(
      "Alt+ArrowUp Alt+ArrowDown",
    );

    fireEvent.keyDown(tile("proj_ops"), { key: "ArrowDown", altKey: true });

    await waitFor(() =>
      expect(mocks.reorder).toHaveBeenCalledWith({
        projectId: "proj_ops",
        previousProjectId: "proj_empty",
        nextProjectId: "proj_personal",
      }),
    );
    await waitFor(() =>
      expect(tileOrder()).toEqual([
        "proj_omnyo",
        "proj_web",
        "proj_ops",
        "proj_empty",
        "proj_personal",
      ]),
    );

    fireEvent.keyDown(tile("proj_omnyo"), { key: "ArrowUp", altKey: true });
    fireEvent.keyDown(tile("proj_web"), { key: "ArrowUp" });
    expect(mocks.reorder).toHaveBeenCalledTimes(1);
  });

  it("disables moves past the top of the rail", async () => {
    renderRail();

    fireEvent.contextMenu(tile("proj_omnyo"));

    const menu = await screen.findByRole("menu", {
      name: "omnyo-private options",
    });

    expect(
      within(menu)
        .getByRole("menuitem", { name: "Move up" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(
      within(menu)
        .getByRole("menuitem", { name: "Move down" })
        .hasAttribute("aria-disabled"),
    ).toBe(false);
  });

  it("hides projects into a labelled Hidden projects menu stored in sidebar.hiddenGroups", async () => {
    const store = createStore();
    renderRail(store);

    expect(document.querySelector("[data-rail-hidden-projects]")).toBeNull();

    await chooseFromTileMenu("proj_ops", "Hide from rail");
    await chooseFromTileMenu("proj_personal", "Hide from rail");

    expect(store.get(sidebarHiddenGroupsAtom)).toEqual([
      "project:proj_ops",
      "project:proj_personal",
    ]);
    expect(tileOrder()).toEqual(["proj_omnyo", "proj_web", "proj_empty"]);
    expect(hiddenProjectsTile().getAttribute("aria-label")).toBe(
      "Hidden projects, 1 needs you, 3 running",
    );
    expect(hiddenProjectsTile().hasAttribute("aria-pressed")).toBe(false);
    expect(hiddenProjectsTile().textContent).toContain("+2");

    fireEvent.keyDown(hiddenProjectsTile(), { key: "Enter" });

    const menu = await screen.findByRole("menu", {
      name: /^Hidden projects/u,
    });

    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.getAttribute("aria-label") ?? item.textContent),
    ).toEqual([
      "ops, 2 running",
      "Personal, 1 needs you, 1 running",
      "Show in rail",
    ]);

    fireEvent.click(within(menu).getByRole("menuitem", { name: /^ops/u }));

    expect(tileOrder()).toEqual(["proj_omnyo", "proj_web", "proj_empty"]);
    expect(store.get(sidebarHiddenGroupsAtom)).toContain("project:proj_ops");
  });

  it.each([
    { layout: "compact", isCompactViewport: true },
    { layout: "floating", isCompactViewport: false },
  ])(
    "selects and restores hidden projects in the $layout menu",
    async ({ isCompactViewport }) => {
      const store = createStore();
      store.set(sidebarHiddenGroupsAtom, [
        "project:proj_ops",
        "project:proj_empty",
        "project:proj_personal",
      ]);
      renderRail(store, isCompactViewport);

      const openHiddenProjects = () => {
        if (isCompactViewport) fireEvent.click(hiddenProjectsTile());
        else fireEvent.keyDown(hiddenProjectsTile(), { key: "Enter" });
      };

      const openRestoreChoices = async () => {
        const restore = await screen.findByRole("menuitem", {
          name: "Show in rail",
        });

        if (isCompactViewport) fireEvent.click(restore);
        else fireEvent.keyDown(restore, { key: "ArrowRight" });

        return within(
          isCompactViewport
            ? screen.getByRole("dialog", { name: "Hidden projects" })
            : await screen.findByRole("menu", { name: "Show in rail" }),
        );
      };

      openHiddenProjects();
      fireEvent.click(await screen.findByRole("menuitem", { name: "empty" }));
      expect(tileOrder()).toEqual(["proj_omnyo", "proj_web"]);

      openHiddenProjects();
      const individualChoices = await openRestoreChoices();
      fireEvent.click(
        individualChoices.getByRole("menuitem", { name: "empty" }),
      );
      expect(tileOrder()).toEqual(["proj_omnyo", "proj_web", "proj_empty"]);
      expect(tile("proj_empty").getAttribute("aria-pressed")).toBe("true");

      openHiddenProjects();
      const allChoices = await openRestoreChoices();
      fireEvent.click(allChoices.getByRole("menuitem", { name: "Show all" }));
      expect(tileOrder()).toEqual([
        "proj_omnyo",
        "proj_web",
        "proj_ops",
        "proj_empty",
        "proj_personal",
      ]);
      expect(
        screen.queryByRole("button", { name: /^Hidden projects/u }),
      ).toBeNull();
    },
  );
});
