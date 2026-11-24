import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  useRpc,
  useRealtime,
  useRealtimeConnectionState,
  experimental_useSidebarThreads as useSidebarThreads,
  experimental_Icon as Icon,
  experimental_useAppNavigate,
  type PluginSidebarThread,
} from "@omnyo/plugin-sdk/app";
import type { rpcContract } from "./contract";
import type { SidebarRepo } from "./git";
import { ProjectDetails, type WorkItem } from "./sidebar-details";

type ProjectSnapshot = { id: string; repos: SidebarRepo[]; errors: string[] };

type Snapshot = { projects: ProjectSnapshot[]; checkedAt: string };

type Mount = { projectId: string; element: HTMLElement };

type Disclosure = {
  projectId: string;
  anchor: HTMLElement;
  section: "checkout" | "work";
};

function running(thread: PluginSidebarThread) {
  return (
    ["active", "starting", "stopping"].includes(thread.status) ||
    Object.values(thread.activity).some((count) => count > 0)
  );
}

function workItems(
  project: ProjectSnapshot,
  threads: readonly PluginSidebarThread[],
) {
  return project.repos.flatMap((repo) => {
    const items = repo.worktrees.flatMap<WorkItem>((w, index) => {
      const active = threads.filter((thread) => {
        const path = thread.environment?.path;

        if (!path) return false;

        const checkout = repo.worktrees
          .filter(
            (candidate) =>
              path === candidate.path || path.startsWith(`${candidate.path}/`),
          )
          .sort((a, b) => b.path.length - a.path.length)[0];

        return running(thread) && checkout?.path === w.path;
      });

      if (
        !active.length &&
        !(w.ahead && w.ahead > 0) &&
        (index === 0 || !w.dirty)
      )
        return [];

      return [
        {
          key: `${repo.path}:${w.path}`,
          label: w.branch ?? "Detached HEAD",
          path: w.path,
          kind: index === 0 ? "Checkout" : "Worktree",
          dirtyFiles: w.dirtyFiles,
          ahead: w.ahead,
          base: repo.base,
          active: active.map((thread) => thread.displayTitle),
          error: w.error,
        },
      ];
    });

    const branches = repo.branches.flatMap<WorkItem>((b) =>
      b.worktrees.length || !(b.ahead && b.ahead > 0)
        ? []
        : [
            {
              key: `${repo.path}:${b.name}`,
              label: b.name,
              path: repo.path,
              kind: "Branch",
              dirtyFiles: [],
              ahead: b.ahead,
              base: repo.base,
              active: [],
              error: null,
            },
          ],
    );

    return [...items, ...branches];
  });
}

export function SidebarStatus() {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const sidebar = useSidebarThreads();
  const navigate = experimental_useAppNavigate();
  const [mounts, setMounts] = useState<Mount[]>([]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [disclosure, setDisclosure] = useState<Disclosure | null>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const popup = useRef<HTMLDivElement>(null);
  useRealtime("scan-changed", () => setRefresh((value) => value + 1));

  useEffect(() => {
    const owned = new Map<HTMLElement, Mount>();
    let frame = 0;

    function reconcile() {
      frame = 0;

      const groups = document.querySelectorAll<HTMLElement>(
        "[data-sidebar-project-id]",
      );

      const parents = new Set<HTMLElement>();

      for (const group of Array.from(groups)) {
        const parent = group.querySelector<HTMLElement>(
          ":scope > [data-sidebar-sticky-group]",
        );

        const label = parent?.querySelector<HTMLElement>(
          ':scope > [data-sidebar="group-label"]',
        );

        const projectId = group.getAttribute("data-sidebar-project-id");

        if (!parent || !label || !projectId) continue;
        parents.add(parent);
        let mount = owned.get(parent);

        if (
          !mount ||
          mount.projectId !== projectId ||
          !mount.element.isConnected
        ) {
          mount?.element.remove();
          const element = document.createElement("div");
          element.className = "wt-sidebar-project-status";
          element.dataset.wtProjectId = projectId;
          label.append(element);
          mount = { projectId, element };
          owned.set(parent, mount);
        }

        if (
          mount.element.parentElement !== label ||
          mount.element.nextElementSibling
        )
          label.append(mount.element);
      }

      for (const [parent, mount] of owned)
        if (!parents.has(parent)) {
          mount.element.remove();
          owned.delete(parent);
        }

      const next = [...owned.values()];
      setMounts((current) =>
        current.length === next.length &&
        current.every((mount, index) => mount === next[index])
          ? current
          : next,
      );
    }

    const observer = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(reconcile);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-sidebar-project-id"],
    });
    reconcile();

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);

      for (const mount of owned.values()) mount.element.remove();
    };
  }, []);

  const projectKey = [...new Set(mounts.map((mount) => mount.projectId))]
    .sort()
    .join("\0");

  useEffect(() => {
    if (!projectKey) return;
    let alive = true;
    let reading = false;

    async function read() {
      if (reading || document.visibilityState === "hidden") return;
      reading = true;

      try {
        const result = await rpc.call("sidebar", {
          projectIds: projectKey.split("\0"),
        });

        if (alive) {
          setSnapshot(result);
          setError(null);
        }
      } catch (cause) {
        if (alive) {
          setSnapshot(null);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        reading = false;
      }
    }

    void read();

    return () => {
      alive = false;
    };
  }, [rpc, projectKey, refresh, connection]);

  useEffect(() => {
    if (!disclosure) return;

    function reposition() {
      if (!disclosure!.anchor.isConnected) {
        setDisclosure(null);

        return;
      }

      const rect = disclosure!.anchor
        .closest(".wt-sidebar-project-status")!
        .getBoundingClientRect();

      const width = Math.min(380, window.innerWidth - 24);
      setPosition({
        left: Math.max(
          12,
          Math.min(rect.right + 8, window.innerWidth - width - 12),
        ),
        top: Math.max(
          12,
          Math.min(
            rect.top,
            window.innerHeight - Math.min(520, window.innerHeight * 0.65) - 12,
          ),
        ),
      });
    }

    function dismiss(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !popup.current?.contains(event.target) &&
        !disclosure!.anchor.contains(event.target)
      )
        setDisclosure(null);
    }

    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") setDisclosure(null);
    }

    reposition();

    popup.current?.querySelector<HTMLButtonElement>(".wt-side-close")?.focus();
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", reposition);
    document.addEventListener("scroll", reposition, true);

    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", reposition);
      document.removeEventListener("scroll", reposition, true);
    };
  }, [disclosure]);

  function open(
    projectId: string,
    anchor: HTMLElement,
    section: "checkout" | "work",
  ) {
    setDisclosure((current) =>
      current?.anchor === anchor ? null : { projectId, anchor, section },
    );
  }

  const selected = snapshot?.projects.find(
    (project) => project.id === disclosure?.projectId,
  );

  const selectedName =
    sidebar.projects.find((project) => project.id === disclosure?.projectId)
      ?.name ?? "Project";

  const selectedThreads = sidebar.threads.filter(
    (thread) => thread.projectId === disclosure?.projectId,
  );

  const selectedWork = selected ? workItems(selected, selectedThreads) : [];

  return (
    <>
      {mounts.map((mount) => {
        const project = snapshot?.projects.find(
          (candidate) => candidate.id === mount.projectId,
        );

        const name =
          sidebar.projects.find((candidate) => candidate.id === mount.projectId)
            ?.name ?? "Project";

        const primary =
          project?.repos.flatMap((repo) =>
            repo.worktrees[0] ? [repo.worktrees[0]] : [],
          ) ?? [];

        const count = primary.reduce((sum, w) => sum + w.dirtyFiles.length, 0);

        const unknown = Boolean(
          error || project?.errors.length || primary.some((w) => w.error),
        );

        const workUnknown = Boolean(
          error ||
          project?.errors.length ||
          project?.repos.some(
            (repo) =>
              repo.worktrees.some((w) => w.error) ||
              repo.branches.some((b) => b.ahead === null),
          ),
        );

        const branches = [
          ...new Set(primary.map((w) => w.branch ?? "Detached")),
        ];

        const branch =
          branches.find((name) => name === "main" || name === "master") ??
          branches[0];

        const work = project
          ? workItems(
              project,
              sidebar.threads.filter(
                (thread) => thread.projectId === mount.projectId,
              ),
            )
          : [];

        const ready = Boolean(project);
        mount.element.dataset.dirtyCount = String(count);
        mount.element.dataset.state = ready
          ? "ready"
          : error
            ? "error"
            : "loading";

        function events(section: "checkout" | "work") {
          return {
            onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) =>
              event.stopPropagation(),
            onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) =>
              event.stopPropagation(),
            onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
              event.stopPropagation();
              open(mount.projectId, event.currentTarget, section);
            },
          };
        }

        return createPortal(
          <>
            <button
              type="button"
              className="wt-side-checkout"
              aria-label={`Checkout status for ${name}`}
              aria-expanded={
                disclosure?.projectId === mount.projectId &&
                disclosure.section === "checkout"
              }
              {...events("checkout")}
            >
              <span className="wt-side-branch">
                {branch ||
                  (unknown
                    ? "Unavailable"
                    : ready
                      ? "No local Git"
                      : "Checking…")}
              </span>
              {ready && primary.length > 0 && (
                <span
                  className={
                    count
                      ? "wt-side-dirty"
                      : unknown
                        ? "wt-side-unknown"
                        : "wt-side-clean"
                  }
                >
                  {count ? (
                    <>
                      <span aria-hidden="true">●</span> {count}
                      {unknown ? "+" : ""}
                    </>
                  ) : unknown ? (
                    "?"
                  ) : (
                    <Icon name="Check" aria-label="No dirty files" />
                  )}
                </span>
              )}
            </button>
            <button
              type="button"
              className={`wt-side-work ${work.length ? "wt-side-has-work" : ""}`}
              aria-label={`Work in progress for ${name}: ${ready && !workUnknown ? work.length : "unknown"}`}
              aria-expanded={
                disclosure?.projectId === mount.projectId &&
                disclosure.section === "work"
              }
              {...events("work")}
            >
              <Icon name="Layers" aria-hidden="true" />{" "}
              {workUnknown
                ? work.length
                  ? `${work.length}+`
                  : "?"
                : ready
                  ? work.length
                  : "…"}
            </button>
          </>,
          mount.element,
          `${mount.projectId}-${mounts.indexOf(mount)}`,
        );
      })}
      {disclosure &&
        createPortal(
          <div
            ref={popup}
            role="dialog"
            aria-label={`Git status for ${selectedName}`}
            className="wt-side-popover"
            style={position}
          >
            <header>
              <strong>{selectedName}</strong>
              <button
                className="wt-side-close"
                aria-label="Close project Git details"
                onClick={() => setDisclosure(null)}
              >
                ×
              </button>
            </header>
            {!selected ? (
              <p>{error ? "Git status unavailable" : "Checking Git status…"}</p>
            ) : (
              <>
                <ProjectDetails
                  key={`${disclosure.projectId}:${disclosure.section}`}
                  project={selected}
                  work={selectedWork}
                  section={disclosure.section}
                />
                <footer>
                  <small>
                    Checked{" "}
                    {new Date(snapshot!.checkedAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </small>
                  <button
                    onClick={() => {
                      setDisclosure(null);
                      navigate.toPluginPanel("storage", {
                        subPath: "worktrees",
                      });
                    }}
                  >
                    Worktrees &amp; branches
                  </button>
                </footer>
              </>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
