import { maxZoom, nodeChange } from "../lib/layout";
import type { NodeWorkspace } from "./node";
import { ProjectContentsTree, ProjectOutline } from "./project-outline";
import { useIsCompactViewport } from "../ui/components/ui/hooks/use-compact-viewport";
import { ReturnBoard } from "./project-return";
import { useProjectHistory } from "./project-history";
import { ProjectDrawer } from "./project-drawer";
import { OtherCanvases, useOtherCanvases } from "./project-switcher";
import { projectHomeViewId, projectOverviewId, sectionOwnView } from "./project-home";
import { useProjectHeader } from "./project-header";
import { projectPath, projectHref, readProjectRoute } from "./project-route";
import { CanvasOverview } from "./overview";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import {
  experimental_Icon as Icon,
  experimental_useAppNavigate,
  experimental_useSidebarThreads,
  ThreadTitle,
  useRealtime,
  useRpc,
  type PluginNavPanelProps,
} from "@omnyo/plugin-sdk/app";
import type { Board, CanvasNode, CanvasRpcContract } from "../contract";
import {
  projectRealtimeChannel,
  type ProjectCanvas,
  type ProjectChat,
  type ProjectSection,
  type ProjectView,
} from "../project-contract";
import type { SourceState } from "../source-contract";
import type { BoardLayout, Rect, Viewport } from "../lib/layout";
import { islandGroups, updateIsland } from "../lib/composition";
import { WorldSurface, type BoardCommands, type WorldNode } from "./world";
import { useSemanticDetail } from "./semantic-detail";
import { ProjectChatSurface, type CanvasChatTarget } from "./project-chat";
import { ProjectSectionLayer, type ProjectLayerModel } from "./project-section";
import {
  fitProjectSurface,
  intersects,
  projectMinZoom,
  projectSurfaceOptions,
  projectFit,
  projectViewTarget,
  unionRects,
  worldWindow,
} from "./project-geometry";
import { EditorWorkbench, type WorkbenchMode } from "./editor";
import { useWorkspaceEditor } from "./workspace-data";
import { readingGroups } from "../lib/layout";
import { useProjectRenderReport } from "./project-render-report";

const projectSignal = z.object({ projectId: z.string() });

const storedCamera = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  zoom: z.number().min(projectMinZoom).max(maxZoom),
});

type Geometry = { board: Board; layer: ProjectLayerModel };

const emptyWorkspace = { hostId: null, environmentId: null };

const emptySources: readonly SourceState[] = [];

function sourceFreshness(sources: readonly SourceState[]): string {
  if (sources.some((entry) => entry.source.status === "error")) return "Source needs attention";

  if (sources.some((entry) => entry.source.status === "refreshing")) return "Refreshing…";

  const stamps = sources.flatMap((entry) =>
    entry.source.lastSuccessAt === null ? [] : [entry.source.lastSuccessAt],
  );

  return stamps.length === 0
    ? "Waiting for data"
    : `Updated ${new Date(Math.min(...stamps)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

function ago(timestamp: number): string {
  const minutes = Math.round((timestamp - Date.now()) / 60_000);

  if (Math.abs(minutes) < 1) return "just now";

  if (Math.abs(minutes) < 60) return relativeTime.format(minutes, "minute");

  if (Math.abs(minutes) < 1440) return relativeTime.format(Math.round(minutes / 60), "hour");

  return relativeTime.format(Math.round(minutes / 1440), "day");
}

function closeDetails(event: React.MouseEvent<HTMLElement>) {
  if (event.target instanceof Element && event.target.closest("button"))
    event.currentTarget.closest("details")?.removeAttribute("open");
}

function ChatLabel({ chat }: { chat: ProjectChat }) {
  return (
    <>
      <Icon name="MessageSquare" className="cnv-project-icon" aria-hidden />
      <span className="cnv-project-row-label">
        <ThreadTitle threadId={chat.threadId} />
      </span>
      {chat.role === "origin" ? <span className="cnv-project-tag">Original chat</span> : null}
    </>
  );
}

function remembered(projectId: string): Viewport | undefined {
  try {
    const value = storedCamera.safeParse(
      JSON.parse(localStorage.getItem(`canvas.project.camera.${projectId}`) ?? "null"),
    );

    return value.success ? value.data : undefined;
  } catch {
    return undefined;
  }
}

const contentsPreference = "canvas.project.contents";

function rememberedContents(): boolean {
  try {
    return localStorage.getItem(contentsPreference) === "open";
  } catch {
    return false;
  }
}

export function ProjectCanvasPage({ subPath }: PluginNavPanelProps) {
  const { projectId, kind: routeKind, id: routeId } = readProjectRoute(subPath);

  if (projectId === "") return <CanvasOverview />;

  return (
    <ProjectCanvasBody
      key={projectId}
      projectId={projectId}
      routeKind={routeKind}
      routeId={routeId}
    />
  );
}

function ProjectCanvasBody({
  projectId,
  routeKind,
  routeId,
}: {
  projectId: string;
  routeKind?: string;
  routeId?: string;
}) {
  const rpc = useRpc<CanvasRpcContract>();
  const navigate = experimental_useAppNavigate();
  const [project, setProject] = useState<ProjectCanvas | null>(null);
  const remember = useProjectHistory(setProject);
  const [error, setError] = useState<string | null>(null);
  const [boards, setBoards] = useState<ReadonlyMap<string, Board>>(new Map());

  const [sectionSources, setSectionSources] = useState<ReadonlyMap<string, readonly SourceState[]>>(
    new Map(),
  );

  const onSources = useCallback(
    (sectionId: string, sources: readonly SourceState[]) =>
      setSectionSources((current) =>
        current.get(sectionId) === sources ? current : new Map(current).set(sectionId, sources),
      ),
    [],
  );

  const [geometry, setGeometry] = useState<ReadonlyMap<string, Geometry>>(new Map());
  const requests = useRef(new Set<string>());
  const [camera, setCamera] = useState(() => remembered(projectId) ?? { x: 40, y: 80, zoom: 0.8 });
  const cameraDetail = useSemanticDetail(camera.zoom);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const commands = useRef<BoardCommands | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const compact = useIsCompactViewport();
  const [contents, setContentsState] = useState(() => compact || rememberedContents());

  const persistContents = useCallback(
    (value: boolean) => {
      if (!compact)
        try {
          localStorage.setItem(contentsPreference, value ? "open" : "closed");
        } catch {}
    },
    [compact],
  );

  const setContents = useCallback(
    (value: boolean) => {
      setContentsState(value);
      persistContents(value);
    },
    [persistContents],
  );

  const toggleContents = useCallback(
    () =>
      setContentsState((open) => {
        persistContents(!open);

        return !open;
      }),
    [persistContents],
  );

  const [compactMode, setCompactMode] = useState<"outline" | "board">("outline");
  const outlineVisible = compact && compactMode === "outline";
  const [outlineWorkspace, setOutlineWorkspace] = useState<NodeWorkspace>(emptyWorkspace);
  const [selectedSection, setSelectedSection] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedIsland, setSelectedIsland] = useState<string | null>(null);

  const [pendingView, setPendingView] = useState<string | null>(null);
  const [pendingViewSection, setPendingViewSection] = useState<string | null>(null);
  const [navigationRevision, setNavigationRevision] = useState(0);

  const [pendingNode, setPendingNode] = useState<{ sectionId: string; nodeId: string } | null>(
    null,
  );

  const [openChat, setOpenChat] = useState<string | null>(
    routeKind === "c" ? (routeId ?? null) : null,
  );

  const [chatChanges, setChatChanges] = useState<
    Array<{ sectionId: string; nodeId: string; changeId: string }>
  >([]);

  const [historyChat, setHistoryChat] = useState<string | null>(null);
  const attributionRequest = useRef(0);
  useEffect(() => {
    setHistoryChat((current) => (current === openChat ? current : null));
  }, [openChat]);

  const refreshChatChanges = useCallback(() => {
    const request = ++attributionRequest.current;

    if (!openChat) {
      setChatChanges([]);

      return;
    }

    void rpc.call("project.chat.changes", { projectId, threadId: openChat }).then(
      (value) => {
        if (request === attributionRequest.current) setChatChanges(value);
      },
      (reason) => {
        if (request === attributionRequest.current)
          setError(reason instanceof Error ? reason.message : "Chat changes could not load.");
      },
    );
  }, [rpc, projectId, openChat]);

  useEffect(refreshChatChanges, [refreshChatChanges, boards, project?.revision]);

  useEffect(() => {
    if (routeKind === "c" && routeId) setOpenChat(routeId);
  }, [routeKind, routeId]);
  const [mode, setMode] = useState<WorkbenchMode | null>(null);

  const [form, setForm] = useState<{
    kind: "section" | "view" | "rename" | "rename-view";
    title: string;
    id?: string;
  } | null>(null);

  const [placeHere, setPlaceHere] = useState(false);
  const [saving, setSaving] = useState(false);

  const [journal, setJournal] = useState<
    Array<{
      id: string;
      label: string;
      actor: string;
      createdAt: number;
      state: "applied" | "undone";
    }>
  >([]);

  const [showJournal, setShowJournal] = useState(false);

  useEffect(() => {
    if (!compact && (showJournal || mode !== null)) setContentsState(false);
  }, [compact, showJournal, mode]);

  useEffect(() => {
    if (compact || !contents) return;
    setShowJournal(false);
    setMode(null);
  }, [compact, contents]);

  const lastPanels = useRef({ journal: showJournal, mode });

  useEffect(() => {
    const previous = lastPanels.current;
    lastPanels.current = { journal: showJournal, mode };

    if (showJournal && !previous.journal && mode !== null) setMode(null);
    else if (mode !== null && previous.mode === null && showJournal) setShowJournal(false);
  }, [showJournal, mode]);

  const [menu, setMenu] = useState<string | null>(null);

  const [menuPoint, setMenuPoint] = useState<{
    x: number;
    y: number;
    align: "start" | "end";
  } | null>(null);

  const menuElement = useRef<HTMLDivElement>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    if (!menu) return;

    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !menuElement.current?.contains(event.target) &&
        !(event.target instanceof Element && event.target.closest("[data-section-menu-trigger]"))
      )
        setMenu(null);
    };

    document.addEventListener("pointerdown", outside, true);

    return () => document.removeEventListener("pointerdown", outside, true);
  }, [menu]);

  function openMenu(sectionId: string, anchor: Element, point?: { x: number; y: number }) {
    const board = anchor.closest(".cnv-board")?.getBoundingClientRect();
    const rect = anchor.getBoundingClientRect();

    setMenuPoint(
      board
        ? point
          ? { x: point.x - board.left, y: point.y - board.top, align: "start" }
          : { x: rect.right - board.left, y: rect.bottom - board.top + 6, align: "end" }
        : null,
    );
    setMenu(sectionId);
    window.requestAnimationFrame(() =>
      menuElement.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus(),
    );
  }

  const [viewAnchor, setViewAnchor] = useState<{ kind: "node" | "island"; id: string } | null>(
    null,
  );

  const [crossfade, setCrossfade] = useState(false);
  const fadeTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(fadeTimer.current), []);
  const [search, setSearch] = useState("");
  const others = useOtherCanvases(projectId, search);

  const projectName = experimental_useSidebarThreads().projects.find(
    (entry) => entry.id === projectId,
  )?.name;

  useEffect(() => {
    if (!contents) setSearch("");
  }, [contents]);
  const [fullScreen, setFullScreen] = useState(false);

  const [sectionDraft, setSectionDraft] = useState<{ id: string; x: number; y: number } | null>(
    null,
  );

  const initialized = useRef(false);
  const hadRemembered = useRef(remembered(projectId) !== undefined);
  const lastRoute = useRef("");
  const lastCompactRoute = useRef("");
  const [adopted, setAdopted] = useState<string | null>(null);
  const [returnSection, setReturnSection] = useState<ProjectSection | null>(null);

  const [boardOptions, setBoardOptions] = useState<
    Array<{ threadId: string; title: string; nodeCount: number; updatedAt: number }>
  >([]);

  const [picker, setPicker] = useState(false);
  const [adopting, setAdopting] = useState(false);

  const emptyCanvas =
    project !== null && !project.sections.some((section) => section.archivedAt === null);

  const settledEmpty = useRef(false);

  useEffect(() => {
    if (project === null || settledEmpty.current) return;
    settledEmpty.current = true;

    if (emptyCanvas && compact) setContentsState(false);
  }, [project, emptyCanvas, compact]);

  useEffect(() => {
    if (picker || emptyCanvas)
      void rpc
        .call("project.boards", { projectId })
        .then(setBoardOptions, (reason) =>
          setError(reason instanceof Error ? reason.message : "Chat boards could not load."),
        );
  }, [rpc, projectId, picker, emptyCanvas]);

  function adopt(threadId: string, title: string) {
    if (adopting) return;
    setAdopting(true);
    void rpc
      .call("project.adopt", {
        projectId,
        threadId,
        title,
        actor: "human",
        expectedRevision: project?.revision,
      })
      .then(async (value) => {
        await remember(value);
        const section = value.sections.find((entry) => entry.originThreadId === threadId);

        if (section) {
          setAdopted(section.id);
          jump("s", section.id);
        }

        setPicker(false);
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : "The board could not be added."),
      )
      .finally(() => setAdopting(false));
  }

  const refresh = useCallback(() => {
    void rpc
      .call("project.get", { projectId })
      .then(setProject, (reason) =>
        setError(reason instanceof Error ? reason.message : "Canvas could not load."),
      );
  }, [rpc, projectId]);

  useEffect(refresh, [refresh]);
  useRealtime(projectRealtimeChannel, (payload) => {
    const event = projectSignal.safeParse(payload);

    if (event.success && event.data.projectId === projectId) refresh();
  });

  const refreshBoard = useCallback(
    (sectionId: string) => {
      if (requests.current.has(sectionId)) return;
      requests.current.add(sectionId);
      void rpc
        .call("board.get", { board: { sectionId } })
        .then(
          ({ board }) => {
            if (board) setBoards((current) => new Map(current).set(sectionId, board));
            else {
              setPendingView(null);
              setError("That canvas section is no longer available.");
            }
          },
          (reason) => {
            setPendingView(null);
            setError(reason instanceof Error ? reason.message : "Section could not load.");
          },
        )
        .finally(() => requests.current.delete(sectionId));
    },
    [rpc],
  );

  useRealtime("canvas.changed", (payload) => {
    const value = z.object({ threadId: z.string() }).safeParse(payload);

    if (value.success && boards.has(value.data.threadId)) refreshBoard(value.data.threadId);
  });

  const sections = useMemo(
    () =>
      (project?.sections ?? [])
        .filter((entry) => entry.archivedAt === null)
        .map((section) =>
          sectionDraft?.id === section.id
            ? { ...section, x: sectionDraft.x, y: sectionDraft.y }
            : section,
        ),
    [project?.sections, sectionDraft],
  );

  const atlasSections = sections.slice(0, 64);

  const pendingAtlasSection = pendingView
    ? sections.find((section) => section.id === pendingViewSection)
    : undefined;

  if (pendingAtlasSection && !atlasSections.includes(pendingAtlasSection))
    atlasSections[63] = pendingAtlasSection;

  const sectionRect = useCallback(
    (section: ProjectSection): Rect => {
      const old = geometry.get(section.id)?.layer.layout.bounds;
      const original = geometry.get(section.id)?.layer.origin;

      return old
        ? {
            ...old,
            x: old.x + section.x - (original?.x ?? section.x),
            y: old.y + section.y - (original?.y ?? section.y),
          }
        : { x: section.x, y: section.y, width: 1400, height: 800 };
    },
    [geometry, project?.sections],
  );

  const bounds = useMemo(() => unionRects(sections.map(sectionRect)), [sections, sectionRect]);
  const expanded = useMemo(() => worldWindow(camera, size, 1), [camera, size]);
  const viewportRect = useMemo(() => worldWindow(camera, size), [camera, size]);

  useEffect(() => {
    if (camera.zoom <= 0.12 || size.width === 0) return;

    for (const section of sections)
      if (!boards.has(section.id) && intersects(sectionRect(section), expanded))
        refreshBoard(section.id);
  }, [sections, boards, sectionRect, expanded, refreshBoard, camera.zoom, size.width]);

  const onGeometry = useCallback(
    (sectionId: string, layer: ProjectLayerModel) => {
      setGeometry((current) => {
        const board = boards.get(sectionId);

        if (
          !board ||
          (current.get(sectionId)?.layer.layout === layer.layout &&
            current.get(sectionId)?.layer.measured === layer.measured &&
            current.get(sectionId)?.layer.realization === layer.realization &&
            current.get(sectionId)?.board === board &&
            current.get(sectionId)?.layer.origin.x === layer.origin.x &&
            current.get(sectionId)?.layer.origin.y === layer.origin.y)
        )
          return current;

        return new Map(current).set(sectionId, { board, layer });
      });
    },
    [boards],
  );

  const pendingCamera = useRef<Viewport | null>(null);
  const cameraTimer = useRef<number | undefined>(undefined);

  const flushCamera = useCallback(() => {
    window.clearTimeout(cameraTimer.current);
    cameraTimer.current = undefined;
    const viewport = pendingCamera.current;

    pendingCamera.current = null;

    if (viewport === null) return;

    try {
      localStorage.setItem(`canvas.project.camera.${projectId}`, JSON.stringify(viewport));
    } catch {}
  }, [projectId]);

  useEffect(() => {
    window.addEventListener("pagehide", flushCamera);

    return () => {
      window.removeEventListener("pagehide", flushCamera);
      flushCamera();
    };
  }, [flushCamera]);

  const updateCamera = useCallback(
    (viewport: Viewport, nextSize: { width: number; height: number }) => {
      setCamera(viewport);
      setSize((current) =>
        current.width === nextSize.width && current.height === nextSize.height ? current : nextSize,
      );

      pendingCamera.current = viewport;
      cameraTimer.current ??= window.setTimeout(flushCamera, 250);
    },
    [flushCamera],
  );

  const navigationFrame = useRef<number | undefined>(undefined);

  const cancelNavigationFit = useCallback(() => {
    if (navigationFrame.current !== undefined) window.cancelAnimationFrame(navigationFrame.current);
    navigationFrame.current = undefined;
  }, []);

  useEffect(() => cancelNavigationFit, [cancelNavigationFit]);

  const show = useCallback(
    (rect: Rect, settleViewport = false) => {
      cancelNavigationFit();

      const fit = () => {
        navigationFrame.current = undefined;
        let fitSize = size;

        if (settleViewport) {
          const surface = root.current?.querySelector<HTMLElement>(".cnv-project-world .cnv-board");

          if (!surface) return;
          fitSize = { width: surface.clientWidth, height: surface.clientHeight };
        }

        const next = projectFit(
          rect,
          fitSize,
          sections.filter((section) => intersects(sectionRect(section), rect)).length <= 1,
        );

        const distance = Math.hypot(next.x - camera.x, next.y - camera.y);
        setCrossfade(
          distance > fitSize.width * 5 &&
            !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        );
        window.clearTimeout(fadeTimer.current);
        fadeTimer.current = window.setTimeout(() => setCrossfade(false), 350);
        commands.current?.restore(next);
      };

      if (settleViewport)
        navigationFrame.current = window.requestAnimationFrame(() => {
          navigationFrame.current = window.requestAnimationFrame(fit);
        });
      else fit();
    },
    [size, camera, cancelNavigationFit, sections, sectionRect],
  );

  const jumpNode = useCallback(
    (sectionId: string, nodeId: string) => {
      if (outlineVisible) {
        setSelectedSection(sectionId);
        setSelectedNode(nodeId);
        setSelectedIsland(null);
        setPendingNode(null);
        refreshBoard(sectionId);

        return;
      }

      const rect = geometry.get(sectionId)?.layer.layout.nodes.get(nodeId);

      if (rect) {
        show(rect);
        setSelectedSection(sectionId);
        setSelectedNode(nodeId);
        setSelectedIsland(null);
        setPendingNode(null);
      } else {
        setPendingNode({ sectionId, nodeId });
        setSelectedSection(sectionId);
        refreshBoard(sectionId);
      }
    },
    [geometry, show, refreshBoard, outlineVisible],
  );

  useEffect(() => {
    if (!pendingNode) return;
    const value = geometry.get(pendingNode.sectionId);
    const rect = value?.layer.layout.nodes.get(pendingNode.nodeId);

    if (rect) jumpNode(pendingNode.sectionId, pendingNode.nodeId);
    else if (value && !requests.current.has(pendingNode.sectionId)) {
      setPendingNode(null);
      setError("That canvas module is no longer available.");
    }
  }, [pendingNode, geometry, jumpNode]);

  useEffect(() => {
    const element = root.current;

    const navigateNode = (event: Event) => {
      if (!(event instanceof CustomEvent) || !(event.target instanceof Element)) return;
      const nodeId = z.string().safeParse(event.detail);

      const sectionId = event.target.closest<HTMLElement>("[data-project-section-id]")?.dataset
        .projectSectionId;

      if (nodeId.success && sectionId) jumpNode(sectionId, nodeId.data);
    };

    element?.addEventListener("canvas-navigate", navigateNode);

    return () => element?.removeEventListener("canvas-navigate", navigateNode);
  }, [jumpNode, project?.projectId]);

  const jump = useCallback(
    (kind: "s" | "v", id: string, replace = false) => {
      lastRoute.current = "";
      lastCompactRoute.current = "";
      setNavigationRevision((value) => value + 1);

      if (compact) {
        setCompactMode("outline");
        setContents(false);

        if (kind === "s") {
          setSelectedSection(id);
          refreshBoard(id);
        }
      }

      const subPath = projectPath(projectId, { kind, id });

      navigate.toPluginPanel(
        "p",
        replace || (routeKind === kind && routeId === id)
          ? { subPath, replace: true }
          : { subPath },
      );
    },
    [navigate, projectId, compact, refreshBoard, setContents, routeKind, routeId],
  );

  const homeRedirected = useRef(false);

  useEffect(() => {
    if (routeKind !== "h") {
      homeRedirected.current = false;

      return;
    }

    if (!project || homeRedirected.current) return;
    homeRedirected.current = true;
    jump("v", projectHomeViewId(project), true);
  }, [routeKind, project, jump]);

  useEffect(() => {
    if (!project) return;

    const view =
      routeKind === "v"
        ? project.views.find((entry) => entry.id === routeId)
        : !routeKind && !initialized.current && !hadRemembered.current
          ? project.views.find((entry) => entry.id === project.homeViewId)
          : undefined;

    if (!view || (view.anchorKind !== "node" && view.anchorKind !== "island") || !view.regionId)
      return;

    if (sections.some((section) => section.id === view.regionId) && !boards.has(view.regionId))
      refreshBoard(view.regionId);
  }, [project, routeKind, routeId, sections, boards, refreshBoard]);

  function targetRect(view: ProjectView) {
    const currentGeometry = new Map(
      [...geometry].filter(([id, value]) => value.board === boards.get(id)),
    );

    if (view.id === projectOverviewId(projectId) && view.createdBy === "system") {
      const pending = sections.find((section) => !currentGeometry.has(section.id));

      return pending
        ? ({ kind: "loading", sectionId: pending.id } as const)
        : ({ kind: "ready", rect: bounds } as const);
    }

    return projectViewTarget(view, sections, project?.chats ?? [], currentGeometry);
  }

  function openView(view: ProjectView): boolean {
    const sectionId =
      view.anchorKind === "chat"
        ? project?.chats.find((chat) => chat.threadId === view.anchorId)?.regionId
        : view.regionId;

    if (sectionId) setSelectedSection(sectionId);
    const target = targetRect(view);

    if (target.kind === "loading") {
      setPendingView(view.title);
      setPendingViewSection(target.sectionId);

      if (!boards.has(target.sectionId)) refreshBoard(target.sectionId);

      return false;
    }

    setPendingView(null);
    setPendingViewSection(null);

    if (target.kind === "missing") setError(target.message);
    else {
      setError(null);

      if (!outlineVisible) show(target.rect, true);
    }

    return true;
  }

  useEffect(() => {
    if (!compact || !project) return;
    const key = `${routeKind ?? ""}/${routeId ?? ""}`;

    if (lastCompactRoute.current === key) return;

    const view =
      routeKind === "v" || routeKind === "u"
        ? project.views.find((entry) => entry.id === routeId)
        : undefined;

    if (routeKind === "u" && view) setForm({ kind: "view", title: view.title, id: view.id });

    const sectionId =
      routeKind === "s"
        ? routeId
        : routeKind === "c"
          ? project.chats.find((chat) => chat.threadId === routeId)?.regionId
          : view?.anchorKind === "chat"
            ? project.chats.find((chat) => chat.threadId === view.anchorId)?.regionId
            : (view?.regionId ?? (view ? sections[0]?.id : undefined));

    if (sectionId && sections.some((section) => section.id === sectionId)) {
      lastCompactRoute.current = key;
      setSelectedSection(sectionId);
      setCompactMode("outline");
      refreshBoard(sectionId);
      setContents(false);
    }
  }, [compact, projectId, routeKind, routeId, project?.views, refreshBoard, navigationRevision]);

  useEffect(() => {
    if (!project) return;
    const key = `${routeKind ?? ""}/${routeId ?? ""}`;

    if (lastRoute.current === key && initialized.current) return;
    setPendingView(null);

    if (outlineVisible && routeKind === "v" && routeId) {
      const view = project.views.find((entry) => entry.id === routeId);

      if (!view) setError("That view is no longer available.");
      else if (!openView(view)) return;
      lastRoute.current = key;
      initialized.current = true;

      return;
    }

    if (size.width === 0 || !commands.current) return;

    if (routeKind === "s" && routeId) {
      const section = sections.find((entry) => entry.id === routeId);

      if (section) {
        setSelectedSection(section.id);

        if (compact) refreshBoard(section.id);
        show(sectionRect(section));
      } else setError("That section is no longer available.");
    } else if (routeKind === "u" && routeId) {
      const view = project.views.find((entry) => entry.id === routeId);

      if (view) setForm({ kind: "view", title: view.title, id: view.id });
      else setError("That view is no longer available.");
    } else if (routeKind === "v" && routeId) {
      const view = project.views.find((entry) => entry.id === routeId);

      if (view) {
        if (!openView(view)) return;
      } else {
        setPendingView(null);
        setError("That view is no longer available.");
      }
    } else if (routeKind === "c" && routeId) {
      const chat = project.chats.find((entry) => entry.threadId === routeId);

      if (!chat) {
        lastRoute.current = "";

        return;
      }

      const section = sections.find((entry) => entry.id === chat?.regionId);

      if (chat)
        show({
          x: chat.x + (section?.x ?? 0) - 200,
          y: chat.y + (section?.y ?? 0) - 80,
          width: 900,
          height: 650,
        });
    } else if (!initialized.current && !hadRemembered.current) {
      const home = project.views.find((entry) => entry.id === project.homeViewId);

      if (home) {
        if (!openView(home)) return;
      } else show(bounds);
    }

    lastRoute.current = key;
    initialized.current = true;
  }, [
    project,
    size,
    navigationRevision,
    routeKind,
    routeId,
    sections,
    bounds,
    sectionRect,
    show,
    compactMode,
    geometry,
    boards,
  ]);

  const centerSection = sections.find((section) =>
    intersects(sectionRect(section), {
      x: viewportRect.x + viewportRect.width / 2,
      y: viewportRect.y + viewportRect.height / 2,
      width: 0,
      height: 0,
    }),
  );

  const place = outlineVisible
    ? (sections.find((section) => section.id === selectedSection)?.title ?? null)
    : (centerSection?.title ?? null);

  useEffect(() => {
    if (mode !== null && selectedSection !== null && !boards.has(selectedSection))
      refreshBoard(selectedSection);
  }, [mode, selectedSection, boards, refreshBoard]);

  const run = useCallback(
    (operation: Promise<ProjectCanvas>, keepHistory = true): Promise<boolean> =>
      operation
        .then(async (value) => {
          setProject(value);

          if (keepHistory) await remember(value);
          setError(null);

          return true;
        })
        .catch((reason) => {
          setError(reason instanceof Error ? reason.message : "The change could not be saved.");

          return false;
        }),
    [remember],
  );

  const mutation = { projectId, actor: "human" as const, expectedRevision: project?.revision };
  const currentBoard = selectedSection ? (boards.get(selectedSection) ?? null) : null;

  useEffect(() => {
    if (outlineVisible && selectedSection && !boards.has(selectedSection))
      refreshBoard(selectedSection);
  }, [outlineVisible, selectedSection, boards, refreshBoard]);
  const originThreadId = sections.find((entry) => entry.id === selectedSection)?.originThreadId;
  useEffect(() => {
    let active = true;
    setOutlineWorkspace(emptyWorkspace);

    if (originThreadId)
      void rpc.call("workspace.get", { threadId: originThreadId }).then(
        (value) => {
          if (active) setOutlineWorkspace(value);
        },
        (reason) => {
          if (active)
            setError(
              reason instanceof Error ? reason.message : "Section workspace could not load.",
            );
        },
      );

    return () => {
      active = false;
    };
  }, [rpc, originThreadId]);

  const boardRefresh = useCallback(() => {
    if (selectedSection) refreshBoard(selectedSection);
  }, [selectedSection, refreshBoard]);

  useEffect(() => {
    if (!outlineVisible || !currentBoard || currentBoard.revision <= currentBoard.seenRevision)
      return;
    void rpc
      .call("board.markSeen", {
        board: { sectionId: currentBoard.threadId },
        revision: currentBoard.revision,
      })
      .catch((reason) =>
        setError(
          reason instanceof Error ? reason.message : "The section could not be marked as read.",
        ),
      );
  }, [
    rpc,
    outlineVisible,
    currentBoard?.threadId,
    currentBoard?.revision,
    currentBoard?.seenRevision,
  ]);

  const report = useProjectRenderReport({
    root,
    boards,
    outlineVisible,
    selectedSection,
    enabled: project !== null,
    onError: () => setError("Couldn't check how modules rendered. Reload to try again."),
  });

  const editor = useWorkspaceEditor(
    selectedSection ?? "",
    currentBoard,
    boardRefresh,
    () => {},
    report,
    mode,
  );

  function saveView(id?: string) {
    setForm({ kind: "view", title: centerSection?.title ?? "Overview", id });
  }

  function save() {
    const title = form?.title.trim() ?? "";

    if (!form || !title || saving) return;
    let operation: Promise<ProjectCanvas> | null = null;

    if (form.kind === "section")
      operation = rpc.call("project.section.create", {
        ...mutation,
        title,
        x: placeHere ? viewportRect.x + viewportRect.width / 2 : undefined,
        y: placeHere ? viewportRect.y + viewportRect.height / 2 : undefined,
      });

    if (form.kind === "rename" && form.id)
      operation = rpc.call("project.section.update", {
        ...mutation,
        sectionId: form.id,
        title,
      });

    if (form.kind === "rename-view" && form.id) {
      const original = project?.views.find((view) => view.id === form.id);

      if (original)
        operation = rpc.call("project.view.put", {
          ...mutation,
          id: original.id,
          title,
          anchorKind: original.anchorKind,
          regionId: original.regionId,
          anchorId: original.anchorId,
          rect: original.rect,
        });
    }

    if (form.kind === "view") {
      const overlap = centerSection ? sectionRect(centerSection) : null;

      const area = overlap
        ? Math.max(
            0,
            Math.min(viewportRect.x + viewportRect.width, overlap.x + overlap.width) -
              Math.max(viewportRect.x, overlap.x),
          ) *
          Math.max(
            0,
            Math.min(viewportRect.y + viewportRect.height, overlap.y + overlap.height) -
              Math.max(viewportRect.y, overlap.y),
          )
        : 0;

      const anchor =
        centerSection && area >= viewportRect.width * viewportRect.height * 0.8
          ? centerSection
          : null;

      operation = rpc.call("project.view.put", {
        ...mutation,
        id: form.id,
        title,
        anchorKind: anchor ? "section" : "free",
        regionId: anchor?.id ?? null,
        anchorId: anchor?.id ?? null,
        rect: {
          ...viewportRect,
          x: viewportRect.x - (anchor?.x ?? 0),
          y: viewportRect.y - (anchor?.y ?? 0),
        },
      });
    }

    if (operation === null) {
      setForm(null);

      return;
    }

    setSaving(true);
    void run(operation).then((saved) => {
      setSaving(false);

      if (saved) setForm(null);
    });
  }

  useProjectHeader(
    projectId,
    {
      place,
      contents,
      changes: showJournal,
      sources: mode === "sources" && selectedSection !== null && boards.has(selectedSection),
      fullScreen,
      empty: emptyCanvas,
    },
    (action) => {
      switch (action) {
        case "save":
          saveView();
          break;
        case "contents":
          toggleContents();
          break;
        case "jump":
          setContents(true);
          window.requestAnimationFrame(() =>
            root.current?.querySelector<HTMLInputElement>(".cnv-project-contents input")?.focus(),
          );
          break;
        case "changes":
          setShowJournal((open) => !open);
          break;
        case "sources":
          setMode((current) => (current === "sources" ? null : "sources"));
          setSelectedSection((current) => current ?? centerSection?.id ?? sections[0]?.id ?? null);
          break;
        case "fit":
          show(bounds);
          break;
        case "fullscreen":
          setFullScreen((current) => !current);
          break;
      }
    },
  );

  useEffect(() => {
    if (showJournal)
      void rpc
        .call("project.journal", { projectId })
        .then(setJournal, (reason) =>
          setError(reason instanceof Error ? reason.message : "Changes could not load."),
        );
  }, [rpc, projectId, showJournal, project?.revision]);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;

      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;

      if (
        !(
          target === document.body ||
          (target instanceof Element &&
            (root.current?.contains(target) || target.closest(".cnv-project-toolbar") !== null))
        )
      )
        return;

      const close = (action: () => void) => {
        event.preventDefault();
        event.stopPropagation();
        action();
      };

      const rowMenu = root.current?.querySelector<HTMLDetailsElement>(
        "details.cnv-project-row-menu[open]",
      );

      if (menu)
        close(() => {
          const trigger = root.current?.querySelector<HTMLElement>(
            `[data-section-menu-trigger="${CSS.escape(menu)}"]`,
          );

          setMenu(null);
          trigger?.focus();
        });
      else if (rowMenu)
        close(() => {
          rowMenu.open = false;
          rowMenu.querySelector<HTMLElement>("summary")?.focus();
        });
      else if (form) close(() => setForm(null));
      else if (returnSection) close(() => setReturnSection(null));
      else if (contents && !compact) close(() => setContents(false));
      else if (showJournal) close(() => setShowJournal(false));
      else if (mode !== null)
        close(() => {
          setMode(null);
          setHistoryChat(null);
        });
      else if (openChat) return;
      else if (selectedNode || selectedIsland)
        close(() => {
          setSelectedNode(null);
          setSelectedIsland(null);
        });
      else if (fullScreen) close(() => setFullScreen(false));
    };

    window.addEventListener("keydown", escape, true);

    return () => window.removeEventListener("keydown", escape, true);
  });

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const open = document.querySelectorAll<HTMLDetailsElement>(
        "details.cnv-project-row-menu[open]",
      );

      for (const details of Array.from(open ?? []))
        if (!(event.target instanceof Node && details.contains(event.target))) details.open = false;
    };

    document.addEventListener("pointerdown", outside, true);

    return () => document.removeEventListener("pointerdown", outside, true);
  }, []);

  const layersMounted = useRef(false);

  useEffect(() => {
    if (!layersMounted.current) {
      layersMounted.current = true;

      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const active = document.activeElement;

      if (active === null || active === document.body) root.current?.focus({ preventScroll: true });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [contents, showJournal, mode, form, menu, returnSection]);

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest("input,textarea,select,[contenteditable=true]")
      )
        return;

      if (!(event.target instanceof Node) || !root.current?.contains(event.target)) return;

      if (event.metaKey || event.ctrlKey || event.altKey || event.key === "Escape") return;

      if (event.target instanceof Element && event.target.closest('[role="tree"], button, summary'))
        return;

      if (["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(event.key) && currentBoard) {
        const nodes = readingGroups(currentBoard).flatMap((group) => group.nodes);
        const current = nodes.findIndex((node) => node.id === selectedNode);
        const direction = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
        const next = nodes[Math.max(0, Math.min(nodes.length - 1, current + direction))];

        if (next && selectedSection) {
          event.preventDefault();
          setSelectedNode(next.id);

          if (!outlineVisible) jumpNode(selectedSection, next.id);
          root.current?.querySelectorAll<HTMLElement>("[data-node-id]").forEach((element) => {
            if (element.dataset.nodeId === next.id && element.offsetParent !== null)
              element.focus();
          });
        }
      }

      if (event.key.toLowerCase() === "c") toggleContents();

      if (event.key.toLowerCase() === "b") saveView();

      if (event.key.toLowerCase() === "f") {
        const rect =
          selectedNode && selectedSection
            ? geometry.get(selectedSection)?.layer.layout.nodes.get(selectedNode)
            : centerSection
              ? sectionRect(centerSection)
              : undefined;

        show(rect ?? bounds);
      }

      if (event.key === "0") {
        const overview = project?.views.find((view) => view.id === projectOverviewId(projectId));

        if (overview) jump("v", overview.id);
      }

      if (/^[1-9]$/u.test(event.key)) {
        const view = project?.views[Number(event.key) - 1];

        if (view) jump("v", view.id);
      }

      if (event.key === "[" || event.key === "]") {
        const views = project?.views ?? [];
        const index = views.findIndex((view) => view.id === routeId);
        const forward = event.key === "]";

        const view =
          index === -1
            ? forward
              ? views[0]
              : views.at(-1)
            : views[(index + (forward ? 1 : -1) + views.length) % views.length];

        if (view) jump("v", view.id);
      }
    };

    window.addEventListener("keydown", keys);

    return () => window.removeEventListener("keydown", keys);
  });

  const targetSection = sections.find((section) => section.id === selectedSection) ?? centerSection;
  const targetLayer = targetSection ? geometry.get(targetSection.id)?.layer : undefined;

  const targetNode =
    targetSection && selectedNode
      ? boards.get(targetSection.id)?.nodes.find((node) => node.id === selectedNode)
      : undefined;

  const targetIsland = targetLayer?.layout.islands.find((frame) => frame.id === selectedIsland);

  const anchorRect = targetNode
    ? targetLayer?.layout.nodes.get(targetNode.id)
    : (targetIsland?.rect ?? (targetSection ? sectionRect(targetSection) : undefined));

  const chatTarget: CanvasChatTarget = {
    regionId: targetSection?.id ?? null,
    kind: targetNode ? "node" : targetIsland ? "island" : targetSection ? "section" : "free",
    id: targetNode?.id ?? targetIsland?.id ?? targetSection?.id ?? null,
    x: anchorRect
      ? anchorRect.x + anchorRect.width + 80 - (targetSection?.x ?? 0)
      : viewportRect.x + viewportRect.width / 2,
    y: anchorRect
      ? anchorRect.y - (targetSection?.y ?? 0)
      : viewportRect.y + viewportRect.height / 2,
    label: targetNode
      ? `${targetSection?.title} › ${targetNode.title ?? targetNode.id}`
      : targetIsland
        ? `${targetSection?.title} › ${targetIsland.island.title}`
        : (targetSection?.title ?? "Free space"),
  };

  const aggregate = useMemo(() => {
    const nodes: WorldNode[] = [];
    const positions = new Map<string, Rect>();

    for (const section of sections) {
      const value = geometry.get(section.id);

      if (!value) continue;

      for (const node of value.board.nodes) {
        const id = `${section.id}:${node.id}`;
        const rect = value.layer.layout.nodes.get(node.id);
        nodes.push({ id, updatedRevision: node.updatedRevision, change: nodeChange(node, 0) });

        if (rect) positions.set(id, rect);
      }
    }

    const layout: BoardLayout = {
      nodes: positions,
      sections: sections.map((section) => ({ name: section.id, rect: sectionRect(section) })),
      islands: [],
      tracks: new Map(),
      slack: new Map(),
      bounds,
    };

    return { nodes, layout };
  }, [sections, geometry, bounds]);

  const selectLayerIsland = useCallback((sectionId: string, islandId: string) => {
    setSelectedSection(sectionId);
    setSelectedIsland(islandId);
    setSelectedNode(null);
    setMode("inspect");
  }, []);

  const selectLayerNode = useCallback((sectionId: string, node: CanvasNode) => {
    setSelectedSection(sectionId);
    setSelectedNode(node.id);
    setSelectedIsland(null);
    setMode("inspect");
  }, []);

  const moveLayerNode = useCallback(
    (sectionId: string, id: string, position: { x: number; y: number }) => {
      void rpc.call("node.move", { board: { sectionId }, id, position }).then(
        () => refreshBoard(sectionId),
        (reason) => setError(reason instanceof Error ? reason.message : "Module could not move."),
      );
    },
    [rpc, refreshBoard],
  );

  const moveLayerIsland = useCallback(
    (sectionId: string, id: string, position: { x: number; y: number }) => {
      const composition = boards.get(sectionId)?.composition;

      if (composition)
        void rpc
          .call("board.compose", {
            board: { sectionId },
            composition: updateIsland(composition, id, { offset: position }),
          })
          .then(
            () => refreshBoard(sectionId),
            (reason) =>
              setError(reason instanceof Error ? reason.message : "Group could not move."),
          );
    },
    [boards, rpc, refreshBoard],
  );

  function moveSection(event: React.PointerEvent<HTMLElement>, section: ProjectSection) {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest("button")))
      return;
    event.stopPropagation();
    const start = { x: event.clientX, y: event.clientY };
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);

    const move = (next: PointerEvent) => {
      if (next.pointerId === event.pointerId)
        setSectionDraft({
          id: section.id,
          x: Math.round((section.x + (next.clientX - start.x) / camera.zoom) / 40) * 40,
          y: Math.round((section.y + (next.clientY - start.y) / camera.zoom) / 40) * 40,
        });
    };

    const stop = (next: PointerEvent) => {
      if (next.pointerId !== event.pointerId) return;
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", stop);
      target.removeEventListener("pointercancel", cancel);
      const x = Math.round((section.x + (next.clientX - start.x) / camera.zoom) / 40) * 40;
      const y = Math.round((section.y + (next.clientY - start.y) / camera.zoom) / 40) * 40;
      setSectionDraft(null);

      if (Math.hypot(next.clientX - start.x, next.clientY - start.y) >= 4)
        run(rpc.call("project.section.move", { ...mutation, sectionId: section.id, x, y }));
    };

    const cancel = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", stop);
      target.removeEventListener("pointercancel", cancel);
      setSectionDraft(null);
    };

    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", stop);
    target.addEventListener("pointercancel", cancel);
  }

  function sectionMenu(section: ProjectSection) {
    return (
      <div
        className="cnv-project-menu"
        role="group"
        aria-label={`${section.title} options`}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="cnv-project-menu-item"
          onClick={() => {
            setForm({ kind: "rename", id: section.id, title: section.title });
            setMenu(null);
          }}
        >
          <Icon name="Edit" className="cnv-project-icon" aria-hidden />
          Rename
        </button>
        <button
          type="button"
          className="cnv-project-menu-item"
          onClick={() => {
            const content = geometry.get(section.id);

            const rect =
              viewAnchor?.kind === "node"
                ? content?.layer.layout.nodes.get(viewAnchor.id)
                : viewAnchor?.kind === "island"
                  ? content?.layer.layout.islands.find((frame) => frame.id === viewAnchor.id)?.rect
                  : sectionRect(section);

            if (!rect) return;
            run(
              rpc.call("project.view.put", {
                ...mutation,
                title: section.title,
                anchorKind: viewAnchor?.kind ?? "section",
                regionId: section.id,
                anchorId: viewAnchor?.id ?? section.id,
                rect: { ...rect, x: rect.x - section.x, y: rect.y - section.y },
              }),
            );
            setMenu(null);
          }}
        >
          <Icon name="Pin" className="cnv-project-icon" aria-hidden />
          {viewAnchor?.kind === "node"
            ? "Save view of this module"
            : viewAnchor?.kind === "island"
              ? "Save view of this group"
              : "Save view of this section"}
        </button>
        <button
          type="button"
          className="cnv-project-menu-item"
          onClick={() => {
            run(
              rpc.call("project.section.update", {
                ...mutation,
                sectionId: section.id,
                locked: !section.locked,
              }),
            );
            setMenu(null);
          }}
        >
          <Icon
            name={section.locked ? "SquareUnlock02" : "Lock"}
            className="cnv-project-icon"
            aria-hidden
          />
          {section.locked ? "Unlock for agents" : "Lock for agents"}
        </button>
        {(["sources", "changes"] as const).map((value) => (
          <button
            key={value}
            type="button"
            className="cnv-project-menu-item"
            onClick={() => {
              setSelectedSection(section.id);
              setMode(value);
              setMenu(null);
            }}
          >
            <Icon
              name={value === "sources" ? "Plug02" : "Clock"}
              className="cnv-project-icon"
              aria-hidden
            />
            {value === "sources" ? "Sources" : "Section changes"}
          </button>
        ))}
        {section.originThreadId ? (
          <button
            type="button"
            className="cnv-project-menu-item"
            onClick={() => {
              setReturnSection(section);
              setMenu(null);
            }}
          >
            <Icon name="MoveTo" className="cnv-project-icon" aria-hidden />
            Move back to chat
          </button>
        ) : null}
        <hr className="cnv-project-menu-separator" />
        <button
          type="button"
          className="cnv-project-menu-item"
          data-tone="destructive"
          onClick={() => {
            run(rpc.call("project.section.archive", { ...mutation, sectionId: section.id }));
            setMenu(null);
          }}
        >
          <Icon name="Archive" className="cnv-project-icon" aria-hidden />
          Archive
        </button>
      </div>
    );
  }

  const shownEditorError =
    mode === "changes" && editor.error === editor.historyError ? null : editor.error;

  if (!project)
    return (
      <div className="cnv-notice" aria-busy={!error}>
        {error ? (
          <>
            <p role="alert">{error}</p>
            <button type="button" className="cnv-button" onClick={refresh}>
              Retry
            </button>
          </>
        ) : (
          "Loading project canvas…"
        )}
      </div>
    );

  const emptyState = (
    <div className="cnv-project-empty" onPointerDown={(event) => event.stopPropagation()}>
      <span className="cnv-project-empty-mark" aria-hidden="true">
        <Icon name="GridView" className="cnv-project-icon" aria-hidden />
      </span>
      <h2>Start this project’s canvas</h2>
      <p>Describe the dashboard you want below, and an agent builds it here.</p>
      {boardOptions.length > 0 ? (
        <section className="cnv-project-empty-boards" aria-label="Start from a chat’s board">
          <h3>Or start from a chat’s board</h3>
          {boardOptions.slice(0, 4).map((option) => (
            <button
              key={option.threadId}
              type="button"
              className="cnv-project-row"
              disabled={adopting}
              onClick={() => adopt(option.threadId, option.title)}
            >
              <Icon name="GridView" className="cnv-project-icon" aria-hidden />
              <span className="cnv-project-row-label">{option.title}</span>
              <span className="cnv-project-row-meta">
                {option.nodeCount} {option.nodeCount === 1 ? "module" : "modules"}
              </span>
            </button>
          ))}
        </section>
      ) : null}
      <button
        type="button"
        className="cnv-project-quiet-button"
        onClick={() => setForm({ kind: "section", title: "New section" })}
      >
        <Icon name="Plus" className="cnv-project-icon" aria-hidden />
        Add an empty section instead
      </button>
    </div>
  );

  return (
    <div
      ref={root}
      className="cnv-panel cnv-project"
      tabIndex={0}
      role="region"
      aria-label="Project canvas"
      onWheelCapture={cancelNavigationFit}
      onPointerDownCapture={cancelNavigationFit}
      onKeyDownCapture={cancelNavigationFit}
      data-compact-mode={compact ? compactMode : undefined}
      data-fullscreen={fullScreen}
      data-crossfade={crossfade}
      onClickCapture={(event) => {
        const href =
          event.target instanceof Element
            ? event.target.closest("a[href]")?.getAttribute("href")
            : null;

        if (href?.startsWith("#canvas-view-")) {
          event.preventDefault();
          jump("v", href.slice("#canvas-view-".length));
        }
      }}
    >
      <div className="cnv-project-toasts">
        {pendingView ? (
          <div className="cnv-project-toast" role="status">
            <Icon name="Loading" className="cnv-project-icon cnv-project-spin" aria-hidden />
            Opening {pendingView}…
          </div>
        ) : null}
        {pendingNode ? (
          <div className="cnv-project-toast" role="status">
            <Icon name="Loading" className="cnv-project-icon cnv-project-spin" aria-hidden />
            Finding the linked module…
          </div>
        ) : null}
        {error || shownEditorError ? (
          <div className="cnv-project-toast" data-tone="destructive" role="alert">
            <Icon name="AlertCircle" className="cnv-project-icon" aria-hidden />
            <span className="cnv-project-toast-text">{error ?? shownEditorError}</span>
            <button
              type="button"
              className="cnv-project-toast-action"
              onClick={() => {
                setError(null);
                editor.clearError();
                refresh();
              }}
            >
              Reload
            </button>
            <button
              type="button"
              className="cnv-project-icon-button"
              aria-label="Dismiss"
              onClick={() => {
                setError(null);
                editor.clearError();
              }}
            >
              <Icon name="X" className="cnv-project-icon" aria-hidden />
            </button>
          </div>
        ) : null}
        {adopted ? (
          <div className="cnv-project-toast" role="status">
            <Icon name="Check" className="cnv-project-icon" aria-hidden />
            <span className="cnv-project-toast-text">Board added to the project canvas.</span>
            <button
              type="button"
              className="cnv-project-toast-action"
              onClick={() => {
                setReturnSection(
                  project.sections.find((section) => section.id === adopted) ?? null,
                );
              }}
            >
              Move back…
            </button>
            <button
              type="button"
              className="cnv-project-icon-button"
              aria-label="Dismiss"
              onClick={() => setAdopted(null)}
            >
              <Icon name="X" className="cnv-project-icon" aria-hidden />
            </button>
          </div>
        ) : null}
        {camera.zoom <= 0.12 && sections.length > 64 && dismissed !== "atlas-cap" ? (
          <div className="cnv-project-toast" role="status">
            <Icon name="Info" className="cnv-project-icon" aria-hidden />
            <span className="cnv-project-toast-text">
              Showing 64 of {sections.length} sections. Zoom in or open Contents for the rest.
            </span>
            <button
              type="button"
              className="cnv-project-icon-button"
              aria-label="Dismiss"
              onClick={() => setDismissed("atlas-cap")}
            >
              <Icon name="X" className="cnv-project-icon" aria-hidden />
            </button>
          </div>
        ) : null}
      </div>
      {compact ? (
        <div className="cnv-project-mode">
          <div className="cnv-project-segmented" role="group" aria-label="Canvas display">
            <button
              type="button"
              aria-pressed={compactMode === "outline"}
              onClick={() => setCompactMode("outline")}
            >
              Outline
            </button>
            <button
              type="button"
              aria-pressed={compactMode === "board"}
              onClick={() => {
                lastRoute.current = "";
                setCompactMode("board");
              }}
            >
              Board
            </button>
          </div>
          {compactMode === "board" ? (
            <button type="button" className="cnv-tool" data-labelled onClick={() => saveView()}>
              <Icon name="Pin" className="cnv-project-icon" aria-hidden />
              <span>Save view</span>
            </button>
          ) : null}
        </div>
      ) : null}
      {outlineVisible ? (
        currentBoard ? (
          <ProjectOutline
            board={currentBoard}
            workspace={outlineWorkspace}
            sources={editor.sources}
            selected={selectedNode}
            onSelect={setSelectedNode}
            anchor={{
              kind:
                routeKind === "v"
                  ? (project.views.find((entry) => entry.id === routeId)?.anchorKind ?? "section")
                  : selectedIsland
                    ? "island"
                    : "node",
              id:
                routeKind === "v"
                  ? (project.views.find((entry) => entry.id === routeId)?.anchorId ?? null)
                  : (selectedIsland ?? selectedNode),
              key: `${routeKind}/${routeId}`,
            }}
          >
            <header className="cnv-project-outline-head">
              <h2>{sections.find((entry) => entry.id === selectedSection)?.title}</h2>
              {sections.find((entry) => entry.id === selectedSection)?.question ? (
                <p>{sections.find((entry) => entry.id === selectedSection)?.question}</p>
              ) : null}
            </header>
            {project.chats.some(
              (chat) => chat.regionId === selectedSection && chat.state === "open",
            ) ? (
              <section aria-label="Chats" className="cnv-project-outline-chats">
                <h3>Chats</h3>
                {project.chats
                  .filter((chat) => chat.regionId === selectedSection && chat.state === "open")
                  .map((chat) => (
                    <button
                      key={chat.threadId}
                      type="button"
                      className="cnv-project-row"
                      onClick={() => {
                        if (chat.role === "origin") navigate.toThread(chat.threadId);
                        else {
                          setOpenChat(chat.threadId);
                          navigate.toPluginPanel("p", {
                            subPath: projectPath(projectId, { kind: "c", id: chat.threadId }),
                          });
                        }
                      }}
                    >
                      <ChatLabel chat={chat} />
                    </button>
                  ))}
              </section>
            ) : null}
          </ProjectOutline>
        ) : sections.length === 0 ? (
          <div className="cnv-project-outline">{emptyState}</div>
        ) : (
          <div className="cnv-project-outline">
            <p className="cnv-project-outline-note">
              {selectedSection
                ? "Opening section…"
                : "Choose a section in Contents to read it here."}
            </p>
          </div>
        )
      ) : null}
      <div className="cnv-project-world" hidden={outlineVisible}>
        <WorldSurface
          nodes={aggregate.nodes}
          layout={aggregate.layout}
          {...projectSurfaceOptions}
          fitBounds={fitProjectSurface}
          initialViewport={camera}
          onViewportChange={updateCamera}
          onSelect={() => {
            setSelectedNode(null);
          }}
          onCommands={(value) => {
            commands.current = value;
          }}
          render={(viewport) => (
            <>
              {(viewport.zoom <= 0.12 ? atlasSections : sections).map((section) => {
                const rect = sectionRect(section);
                const board = boards.get(section.id);

                return (
                  <div
                    key={section.id}
                    data-project-section-id={section.id}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      const element = event.target instanceof Element ? event.target : null;

                      const nodeId = element
                        ?.closest("[data-node-id]")
                        ?.getAttribute("data-node-id");

                      const islandId = element
                        ?.closest("[data-island-id]")
                        ?.getAttribute("data-island-id");

                      setViewAnchor(
                        nodeId
                          ? { kind: "node", id: nodeId }
                          : islandId
                            ? { kind: "island", id: islandId }
                            : null,
                      );
                      setSelectedSection(section.id);
                      openMenu(section.id, event.currentTarget, {
                        x: event.clientX,
                        y: event.clientY,
                      });
                    }}
                  >
                    <section
                      className="cnv-project-section"
                      data-atlas={viewport.zoom <= 0.12}
                      data-selected={selectedSection === section.id}
                      style={{
                        left: rect.x - 24,
                        top: rect.y - 72,
                        width: rect.width + 48,
                        height: rect.height + 96,
                      }}
                      aria-label={section.title}
                      onDoubleClick={() => jump("s", section.id)}
                    >
                      <header onPointerDown={(event) => moveSection(event, section)}>
                        <button
                          type="button"
                          className="cnv-project-section-title"
                          tabIndex={-1}
                          title="Go to this section"
                          onClick={() => jump("s", section.id)}
                        >
                          {section.title}
                        </button>
                        {section.locked ? (
                          <span
                            className="cnv-project-badge"
                            title="Agents can read this section but cannot change it"
                          >
                            <Icon name="Lock" className="cnv-project-icon" aria-hidden />
                            Locked
                          </span>
                        ) : null}
                        <span className="cnv-project-section-question">{section.question}</span>
                        {(sectionSources.get(section.id)?.length ?? 0) > 0 ? (
                          <span
                            className="cnv-project-badge"
                            data-tone={
                              sourceFreshness(sectionSources.get(section.id) ?? []) ===
                              "Source needs attention"
                                ? "attention"
                                : undefined
                            }
                          >
                            {sourceFreshness(sectionSources.get(section.id) ?? [])}
                          </span>
                        ) : null}
                        {(() => {
                          const count = project.chats.filter(
                            (chat) =>
                              chat.regionId === section.id &&
                              chat.state === "open" &&
                              chat.role === "spawned",
                          ).length;

                          return count > 0 ? (
                            <span
                              className="cnv-project-badge"
                              title={`${count} open ${count === 1 ? "chat" : "chats"} here`}
                            >
                              <Icon name="MessageSquare" className="cnv-project-icon" aria-hidden />
                              {count} {count === 1 ? "chat" : "chats"}
                            </span>
                          ) : null;
                        })()}
                        <button
                          type="button"
                          className="cnv-project-icon-button"
                          data-section-menu-trigger={section.id}
                          aria-label={`Menu for ${section.title}`}
                          aria-expanded={menu === section.id}
                          title="Section options"
                          onClick={(event) => {
                            setSelectedSection(section.id);
                            setViewAnchor(null);

                            if (menu === section.id) setMenu(null);
                            else openMenu(section.id, event.currentTarget);
                          }}
                        >
                          <Icon name="MoreHorizontal" className="cnv-project-icon" aria-hidden />
                        </button>
                      </header>
                      {viewport.zoom <= 0.12 ? (
                        <div className="cnv-project-atlas">
                          <h2>{section.title}</h2>
                          <p>
                            {board?.nodes.find(
                              (node) =>
                                geometry.get(section.id)?.layer.emphases.get(node.id) === "lead",
                            )?.body ?? section.question}
                          </p>
                        </div>
                      ) : null}
                    </section>
                    {board ? (
                      <ProjectSectionLayer
                        section={section}
                        board={board}
                        inView={intersects(sectionRect(section), viewportRect)}
                        zoom={viewport.zoom}
                        detail={cameraDetail}
                        selected={selectedSection === section.id ? selectedNode : null}
                        workspace={emptyWorkspace}
                        sources={selectedSection === section.id ? editor.sources : emptySources}
                        onSelectIsland={selectLayerIsland}
                        onGeometry={onGeometry}
                        onSources={onSources}
                        onSelect={selectLayerNode}
                        onMoveNode={moveLayerNode}
                        onMoveIsland={moveLayerIsland}
                      />
                    ) : null}
                  </div>
                );
              })}
            </>
          )}
          overlay={(viewport, detail) => (
            <>
              {viewport.zoom > 0.12 && (detail === "overview" || detail === "map") ? (
                <div className="cnv-island-labels" data-visible="true">
                  {sections.flatMap((section) =>
                    (geometry.get(section.id)?.layer.layout.islands ?? []).map((frame) => (
                      <button
                        key={`${section.id}:${frame.id}`}
                        type="button"
                        className="cnv-island-label"
                        data-accent={frame.accent}
                        style={{
                          left: viewport.x + (frame.rect.x + 24) * viewport.zoom,
                          top: viewport.y + (frame.rect.y + 24) * viewport.zoom,
                          maxWidth: Math.max(180, (frame.rect.width - 48) * viewport.zoom),
                        }}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={() => {
                          setSelectedSection(section.id);
                          show(frame.rect);
                        }}
                      >
                        <span className="cnv-island-label-title">
                          <span className="cnv-island-pip" aria-hidden="true" />
                          {frame.island.title}
                        </span>
                      </button>
                    )),
                  )}
                </div>
              ) : null}
              {fullScreen ? (
                <button
                  type="button"
                  className="cnv-project-exit"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => setFullScreen(false)}
                >
                  <Icon name="Minimize2" className="cnv-project-icon" aria-hidden />
                  Exit full screen
                </button>
              ) : null}
              {sections.length === 0 ? emptyState : null}
              {menu ? (
                <div
                  ref={menuElement}
                  className="cnv-project-section-tools"
                  style={
                    menuPoint
                      ? {
                          left: Math.max(
                            8,
                            Math.min(
                              size.width - 248,
                              menuPoint.align === "end" ? menuPoint.x - 232 : menuPoint.x,
                            ),
                          ),
                          top: Math.max(8, Math.min(size.height - 320, menuPoint.y)),
                        }
                      : undefined
                  }
                >
                  {(() => {
                    const section = sections.find((entry) => entry.id === menu);

                    return section ? sectionMenu(section) : null;
                  })()}
                </div>
              ) : null}
            </>
          )}
        />
      </div>
      <div className="cnv-project-announcement" aria-live="polite" aria-atomic="true">
        {routeKind === "v"
          ? `${project.views.find((entry) => entry.id === routeId)?.title ?? "View"}, ${currentBoard ? `${currentBoard.nodes.length} modules` : "Loading modules"}, ${sourceFreshness(editor.sources)}`
          : ""}
      </div>
      <ProjectChatSurface
        project={project}
        camera={camera}
        size={size}
        target={chatTarget}
        sectionRects={new Map(sections.map((section) => [section.id, sectionRect(section)]))}
        openThreadId={openChat}
        filterActive={historyChat !== null && historyChat === openChat}
        changedNodes={chatChanges.flatMap((change) => {
          const rect = geometry.get(change.sectionId)?.layer.layout.nodes.get(change.nodeId);

          return rect ? [{ sectionId: change.sectionId, nodeId: change.nodeId, rect }] : [];
        })}
        onOpen={(threadId) => {
          setOpenChat(threadId);
          navigate.toPluginPanel("p", {
            subPath: projectPath(projectId, { kind: "c", id: threadId }),
          });
        }}
        onClose={() => {
          setOpenChat(null);

          if (routeKind === "c") navigate.toPluginPanel("p", { subPath: projectId, replace: true });
        }}
        onCreated={(threadId) => {
          refresh();
          setOpenChat(threadId);
          navigate.toPluginPanel("p", {
            subPath: projectPath(projectId, { kind: "c", id: threadId }),
          });
        }}
        onJumpNode={jumpNode}
        onChanges={(sectionId, threadId) => {
          setSelectedSection(sectionId);
          setHistoryChat((current) => (current === threadId ? null : threadId));
          setMode("changes");
        }}
      />
      <ProjectDrawer
        open={contents}
        onOpenChange={setContents}
        label="Contents"
        className="cnv-project-contents"
      >
        <div className="cnv-project-panel-head">
          <strong>{compact && projectName ? `${projectName} · Contents` : "Contents"}</strong>
          <button
            type="button"
            className="cnv-project-icon-button"
            aria-label="Close Contents"
            title="Close (C)"
            onClick={() => setContents(false)}
          >
            <Icon name="X" className="cnv-project-icon" aria-hidden />
          </button>
        </div>
        <label className="cnv-project-search">
          <Icon name="Search" className="cnv-project-icon" aria-hidden />
          <input
            aria-label="Find a section, view or canvas"
            placeholder="Find a section, view or canvas"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <ProjectContentsTree>
          {project.views
            .filter(
              (view) =>
                view.title.toLowerCase().includes(search.toLowerCase()) &&
                !(
                  view.id !== project.homeViewId &&
                  sectionOwnView(view) &&
                  sections.some(
                    (section) => section.id === view.regionId && section.title === view.title,
                  )
                ),
            )
            .map((view) => ({ view, index: project.views.indexOf(view) }))
            .map(({ view, index }) => (
              <div
                key={view.id}
                role="treeitem"
                tabIndex={-1}
                aria-label={view.title}
                aria-selected={routeKind === "v" && routeId === view.id}
                className="cnv-project-view-row"
              >
                <button
                  type="button"
                  tabIndex={-1}
                  className="cnv-project-row"
                  title={index < 9 && search === "" ? `Jump here (${index + 1})` : "Jump here"}
                  onClick={() => jump("v", view.id)}
                >
                  <Icon
                    name={project.homeViewId === view.id ? "Star" : "Pin"}
                    className="cnv-project-icon"
                    aria-hidden
                  />
                  <span className="cnv-project-row-label">{view.title}</span>
                  {project.homeViewId === view.id ? (
                    <span className="cnv-project-tag">Home</span>
                  ) : null}
                  {view.createdBy !== "human" && view.createdBy !== "system" ? (
                    <span className="cnv-project-tag">Agent</span>
                  ) : null}
                </button>
                <details className="cnv-project-row-menu">
                  <summary aria-label={`Options for ${view.title}`} title="View options">
                    <Icon name="MoreHorizontal" className="cnv-project-icon" aria-hidden />
                  </summary>
                  <div className="cnv-project-menu" onClick={closeDetails}>
                    <button
                      type="button"
                      className="cnv-project-menu-item"
                      onClick={() =>
                        setForm({ kind: "rename-view", id: view.id, title: view.title })
                      }
                    >
                      <Icon name="Edit" className="cnv-project-icon" aria-hidden />
                      Rename
                    </button>
                    <button
                      type="button"
                      className="cnv-project-menu-item"
                      onClick={() => setForm({ kind: "view", id: view.id, title: view.title })}
                    >
                      <Icon name="Target" className="cnv-project-icon" aria-hidden />
                      Update to current position
                    </button>
                    <button
                      type="button"
                      className="cnv-project-menu-item"
                      onClick={() => {
                        const views = [...project.views];
                        const index = views.findIndex((entry) => entry.id === view.id);

                        if (index > 0) {
                          const before = views[index - 1];

                          if (before) {
                            views[index - 1] = view;
                            views[index] = before;
                            run(
                              rpc.call("project.view.reorder", {
                                ...mutation,
                                ids: views.map((entry) => entry.id),
                              }),
                            );
                          }
                        }
                      }}
                    >
                      <Icon name="ArrowUp" className="cnv-project-icon" aria-hidden />
                      Move up
                    </button>
                    <button
                      type="button"
                      className="cnv-project-menu-item"
                      onClick={() =>
                        run(rpc.call("project.view.home", { ...mutation, id: view.id }))
                      }
                    >
                      <Icon name="Star" className="cnv-project-icon" aria-hidden />
                      Set as home
                    </button>
                    <button
                      type="button"
                      className="cnv-project-menu-item"
                      onClick={() => {
                        const url = new URL(window.location.href);
                        url.pathname = projectHref("canvas", projectId, { kind: "v", id: view.id });
                        void navigator.clipboard
                          .writeText(url.href)
                          .catch(() => setError("The link could not be copied."));
                      }}
                    >
                      <Icon name="Link" className="cnv-project-icon" aria-hidden />
                      Copy link
                    </button>
                    {!view.id.startsWith("view_overview_") ? (
                      <>
                        <hr className="cnv-project-menu-separator" />
                        <button
                          type="button"
                          className="cnv-project-menu-item"
                          data-tone="destructive"
                          onClick={() =>
                            run(rpc.call("project.view.remove", { ...mutation, id: view.id }))
                          }
                        >
                          <Icon name="Trash2" className="cnv-project-icon" aria-hidden />
                          Remove
                        </button>
                      </>
                    ) : null}
                  </div>
                </details>
              </div>
            ))}
          {sections
            .filter((section) => section.title.toLowerCase().includes(search.toLowerCase()))
            .map((section) => (
              <details
                key={section.id}
                role="treeitem"
                tabIndex={-1}
                aria-label={section.title}
                aria-expanded={false}
                className="cnv-project-section-row"
                onToggle={(event) =>
                  event.currentTarget.setAttribute(
                    "aria-expanded",
                    String(event.currentTarget.open),
                  )
                }
              >
                <summary tabIndex={-1}>
                  <Icon name="ChevronRight" className="cnv-project-row-caret" aria-hidden />
                  <button
                    type="button"
                    className="cnv-project-row"
                    tabIndex={-1}
                    data-current={selectedSection === section.id || undefined}
                    aria-current={selectedSection === section.id || undefined}
                    title="Go to this section"
                    onClick={() => jump("s", section.id)}
                  >
                    <Icon name="Layers" className="cnv-project-icon" aria-hidden />
                    <span className="cnv-project-row-label">{section.title}</span>
                  </button>
                </summary>
                <div role="group">
                  {geometry.get(section.id)?.layer.layout.islands.map((frame) => (
                    <button
                      key={frame.id}
                      role="treeitem"
                      tabIndex={-1}
                      type="button"
                      className="cnv-project-row"
                      onClick={() => {
                        setSelectedSection(section.id);
                        setSelectedIsland(frame.id);

                        if (compact) {
                          setCompactMode("outline");
                          setContents(false);
                        }

                        show(frame.rect);
                      }}
                    >
                      <span
                        className="cnv-island-pip"
                        data-accent={frame.accent}
                        aria-hidden="true"
                      />
                      <span className="cnv-project-row-label">{frame.island.title}</span>
                    </button>
                  ))}
                  {project.chats
                    .filter((chat) => chat.regionId === section.id && chat.state === "open")
                    .map((chat) => (
                      <button
                        key={chat.threadId}
                        role="treeitem"
                        tabIndex={-1}
                        type="button"
                        className="cnv-project-row"
                        onClick={() => {
                          if (chat.role === "spawned") {
                            setOpenChat(chat.threadId);
                            navigate.toPluginPanel("p", {
                              subPath: projectPath(projectId, { kind: "c", id: chat.threadId }),
                            });
                          } else navigate.toThread(chat.threadId);
                        }}
                      >
                        <ChatLabel chat={chat} />
                      </button>
                    ))}
                </div>
              </details>
            ))}
          <OtherCanvases
            canvases={others.canvases}
            error={others.error}
            searching={search !== ""}
            onOpen={(id) => navigate.toPluginPanel("p", { subPath: `${id}/h` })}
            onRetry={others.retry}
          />
        </ProjectContentsTree>
        {search !== "" &&
        others.canvases.length === 0 &&
        !project.views.some((view) => view.title.toLowerCase().includes(search.toLowerCase())) &&
        !sections.some((section) => section.title.toLowerCase().includes(search.toLowerCase())) ? (
          <p className="cnv-project-panel-note">Nothing matches “{search}”.</p>
        ) : null}
        <div className="cnv-project-panel-actions">
          <button
            type="button"
            className="cnv-project-quiet-button"
            onClick={() => setForm({ kind: "section", title: "New section" })}
          >
            <Icon name="Plus" className="cnv-project-icon" aria-hidden />
            Add section
          </button>
          <button
            type="button"
            className="cnv-project-quiet-button"
            aria-expanded={picker}
            onClick={() => setPicker((open) => !open)}
          >
            <Icon name="GridView" className="cnv-project-icon" aria-hidden />
            Add a chat’s board
          </button>
        </div>
        {picker ? (
          <div className="cnv-project-board-picker">
            <strong>Choose a chat board</strong>
            {boardOptions.length === 0 ? (
              <p className="cnv-project-panel-note">No chat in this project has a board yet.</p>
            ) : (
              boardOptions.map((option) => (
                <button
                  key={option.threadId}
                  type="button"
                  className="cnv-project-row"
                  disabled={adopting}
                  onClick={() => adopt(option.threadId, option.title)}
                >
                  <Icon name="GridView" className="cnv-project-icon" aria-hidden />
                  <span className="cnv-project-row-label">{option.title}</span>
                  <span className="cnv-project-row-meta">
                    {option.nodeCount} {option.nodeCount === 1 ? "module" : "modules"}
                  </span>
                </button>
              ))
            )}
          </div>
        ) : null}
        {project.sections.some((section) => section.archivedAt !== null) ? (
          <details className="cnv-project-panel-group">
            <summary>
              <Icon name="ChevronRight" className="cnv-project-row-caret" aria-hidden />
              Archived sections
              <span className="cnv-project-row-meta">
                {project.sections.filter((section) => section.archivedAt !== null).length}
              </span>
            </summary>
            {project.sections
              .filter((section) => section.archivedAt !== null)
              .map((section) => (
                <div key={section.id} className="cnv-project-row" data-static>
                  <Icon name="Archive" className="cnv-project-icon" aria-hidden />
                  <span className="cnv-project-row-label">{section.title}</span>
                  <button
                    type="button"
                    className="cnv-project-toast-action"
                    onClick={() =>
                      run(
                        rpc.call("project.section.restore", { ...mutation, sectionId: section.id }),
                      )
                    }
                  >
                    Restore
                  </button>
                </div>
              ))}
          </details>
        ) : null}
        {project.chats.some((chat) => chat.state === "resolved") ? (
          <details className="cnv-project-panel-group">
            <summary>
              <Icon name="ChevronRight" className="cnv-project-row-caret" aria-hidden />
              Resolved chats
              <span className="cnv-project-row-meta">
                {project.chats.filter((chat) => chat.state === "resolved").length}
              </span>
            </summary>
            {project.chats
              .filter((chat) => chat.state === "resolved")
              .map((chat) => (
                <button
                  key={chat.threadId}
                  type="button"
                  className="cnv-project-row"
                  title="Open this chat"
                  onClick={() => navigate.toThread(chat.threadId)}
                >
                  <ChatLabel chat={chat} />
                </button>
              ))}
          </details>
        ) : null}
      </ProjectDrawer>
      {returnSection ? (
        <ReturnBoard
          projectId={projectId}
          sectionId={returnSection.id}
          onClose={() => setReturnSection(null)}
          onReturned={() => {
            setReturnSection(null);
            setAdopted(null);
            refresh();
          }}
        />
      ) : null}
      <ProjectDrawer
        open={form !== null}
        onOpenChange={(open) => {
          if (!open) setForm(null);
        }}
        label="Save canvas item"
        className="cnv-project-form"
      >
        {form ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <strong className="cnv-project-form-title">
              {form.kind === "view"
                ? form.id
                  ? "Update this view"
                  : "Save this view"
                : form.kind === "rename-view"
                  ? "Rename view"
                  : form.kind === "rename"
                    ? "Rename section"
                    : "New section"}
            </strong>
            {form.kind === "view" && form.id ? (
              <p className="cnv-project-form-hint">It will show what you see now.</p>
            ) : null}
            <label className="cnv-project-field">
              <span>
                {form.kind === "view" || form.kind === "rename-view" ? "View name" : "Section name"}
              </span>
              <input
                className="cnv-input"
                value={form.title}
                autoFocus
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => setForm({ ...form, title: event.target.value })}
                maxLength={200}
                required
              />
            </label>
            {form.kind === "section" ? (
              <label className="cnv-project-check">
                <input
                  type="checkbox"
                  checked={placeHere}
                  onChange={(event) => setPlaceHere(event.target.checked)}
                />
                Place it where I am looking
              </label>
            ) : null}
            <div className="cnv-project-form-actions">
              <button
                type="button"
                className="cnv-project-quiet-button"
                onClick={() => setForm(null)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="cnv-project-primary-button"
                disabled={saving || form.title.trim() === ""}
                title={form.title.trim() === "" ? "Enter a name first" : undefined}
              >
                {saving ? "Saving…" : form.kind === "section" ? "Add section" : "Save"}
              </button>
            </div>
          </form>
        ) : null}
      </ProjectDrawer>
      <ProjectDrawer
        open={showJournal}
        onOpenChange={setShowJournal}
        label="Project changes"
        className="cnv-project-journal"
      >
        <div className="cnv-project-panel-head">
          <strong>Project changes</strong>
          <button
            type="button"
            className="cnv-project-icon-button"
            aria-label="Close Project Changes"
            onClick={() => setShowJournal(false)}
          >
            <Icon name="X" className="cnv-project-icon" aria-hidden />
          </button>
        </div>
        <p className="cnv-project-panel-note">
          Changes inside a section are in that section’s menu.
        </p>
        {journal.length === 0 ? (
          <p className="cnv-project-panel-empty">No project changes yet.</p>
        ) : (
          <ol className="cnv-project-journal-list">
            {journal.map((entry) => (
              <li key={entry.id} data-state={entry.state}>
                <span className="cnv-project-journal-text">
                  <span>{entry.label}</span>
                  <span className="cnv-project-row-meta">
                    {entry.actor === "human"
                      ? "You"
                      : entry.actor === "system"
                        ? "Canvas"
                        : "An agent"}{" "}
                    · {ago(entry.createdAt)}
                    {entry.state === "undone" ? " · undone" : ""}
                  </span>
                </span>
                {entry.state === "applied" ? (
                  <button
                    type="button"
                    className="cnv-project-toast-action"
                    onClick={() =>
                      run(rpc.call("project.undo", { ...mutation, changeId: entry.id }), false)
                    }
                  >
                    <Icon name="ArrowTurnBackward" className="cnv-project-icon" aria-hidden />
                    Undo
                  </button>
                ) : (
                  <button
                    type="button"
                    className="cnv-project-toast-action"
                    onClick={() =>
                      run(rpc.call("project.redo", { ...mutation, changeId: entry.id }), false)
                    }
                  >
                    <Icon name="ArrowTurnForward" className="cnv-project-icon" aria-hidden />
                    Redo
                  </button>
                )}
              </li>
            ))}
          </ol>
        )}
      </ProjectDrawer>
      <ProjectDrawer
        open={mode !== null && currentBoard !== null && selectedSection !== null}
        onOpenChange={(open) => {
          if (!open) {
            setMode(null);
            setHistoryChat(null);
          }
        }}
        label={
          mode === "sources" ? "Sources" : mode === "changes" ? "Section changes" : "Module details"
        }
        className="cnv-project-workbench"
      >
        {mode && currentBoard && selectedSection ? (
          <EditorWorkbench
            threadId={selectedSection}
            mode={mode}
            onMode={setMode}
            onClose={() => {
              setMode(null);
              setHistoryChat(null);
            }}
            board={currentBoard}
            historyError={editor.historyError}
            selectedNode={currentBoard.nodes.find((node) => node.id === selectedNode) ?? null}
            selectedIsland={
              currentBoard.composition
                ? (islandGroups(currentBoard.composition.root).find(
                    (island) => island.id === selectedIsland,
                  ) ?? null)
                : null
            }
            sources={editor.sources}
            history={
              historyChat !== null && editor.history !== null
                ? {
                    ...editor.history,
                    entries: editor.history.entries.filter((entry) =>
                      chatChanges.some(
                        (change) =>
                          change.sectionId === selectedSection && change.changeId === entry.id,
                      ),
                    ),
                  }
                : editor.history
            }
            busy={editor.busy}
            actions={editor.actions}
            onSelectNode={setSelectedNode}
          />
        ) : null}
      </ProjectDrawer>
    </div>
  );
}
