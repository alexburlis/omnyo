import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  experimental_Icon as Icon,
  experimental_ProjectIcon as ProjectIcon,
  experimental_useSidebarThreads,
  experimental_useAppNavigate,
} from "@omnyo/plugin-sdk/app";
import type {
  ExperimentalSidebarFooterCardProps,
  PluginSidebarThread,
} from "@omnyo/plugin-sdk/app";
import { CARD_LABEL, PHASE_LABEL, age, cardPhase, cardStateOf } from "../lib/feed.ts";
import { revealRunningSection, useInboxMounted } from "../lib/feed-store.ts";
import { useGlanceCards } from "../lib/glance.ts";
import { useInboxSections } from "../lib/inbox-order.ts";
import {
  buildTree,
  groupThreadOf,
  inboxRoots,
  rootAttention,
  type ChatNode,
  type ChatState,
} from "../lib/grouping.ts";
import { DOT_OF_STATE, StateDot } from "./state-dot.tsx";
import { openFromClick } from "./feed.tsx";
import { chatTapOptions } from "../lib/chat-tap.ts";

const ALERT_TIME = 4500;

const NEED_ALERT_TIME = 15_000;

const PANEL_GAP = 8;

interface Alert {
  id: string;
  projectId: string;
  title: string;
  line: string | null;
  state: ChatState;
  label: string;
  duration: number;
  raisedAt: number;
}

interface PanelPosition {
  left: number;
  bottom: number;
  originX: number;
}

type PanelState = "closed" | "open" | "closing";

function inputKeys(node: ChatNode): string[] {
  const work = node.thread.work;

  return [...(work?.requiredInput ?? []), ...(work?.optionalInput ?? [])].map(
    (input) => `${node.thread.id}:${input.id}`,
  );
}

function dismiss(state: PanelState): PanelState {
  return state === "open" ? "closing" : state;
}

function Fold({ children }: { children: ReactNode }) {
  return (
    <span className="ctl-fold">
      <span className="ctl-fold-inner">{children}</span>
    </span>
  );
}

export function LiveCapsule({
  experimental_placement: placement = "rail",
}: ExperimentalSidebarFooterCardProps) {
  const full = placement === "footer";
  const { status, threads, projects } = experimental_useSidebarThreads();
  const glance = useGlanceCards();
  const navigate = experimental_useAppNavigate();
  const inboxMounted = useInboxMounted();
  const inboxShowsRunning = !useInboxSections().hidden.has("run");
  const pillRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const previous = useRef<ReadonlySet<string> | null>(null);
  const previousNeed = useRef<ReadonlySet<string> | null>(null);
  const previousInputs = useRef<ReadonlySet<string> | null>(null);
  const alertDeadline = useRef<{ remaining: number; startedAt: number } | null>(null);
  const [panel, setPanel] = useState<PanelState>("closed");
  const [position, setPosition] = useState<PanelPosition | null>(null);
  const [alert, setAlert] = useState<Alert | null>(null);
  const [alertPaused, setAlertPaused] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const visible = useMemo(
    () => threads.filter((thread) => !thread.isHidden && !thread.isArchived),
    [threads],
  );

  const byId = useMemo(() => new Map(visible.map((thread) => [thread.id, thread])), [visible]);

  const tree = useMemo(() => buildTree(visible.map(groupThreadOf)), [visible]);

  const needing = useMemo(
    () => (full ? inboxRoots(tree).filter((node) => rootAttention(node).state === "need") : []),
    [tree, full],
  );

  const running = useMemo(
    () =>
      tree.roots.filter((node) => {
        const attention = rootAttention(node);

        return attention.running && !(full && attention.state === "need");
      }),
    [tree, full],
  );

  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );

  useEffect(() => {
    const ids = new Set(running.map((node) => node.thread.id));

    const needIds = new Set(
      inboxRoots(tree)
        .filter((node) => rootAttention(node).state === "need")
        .map((node) => node.thread.id),
    );

    const inputIds = new Set(inboxRoots(tree).flatMap(inputKeys));
    const before = previous.current;
    const needBefore = previousNeed.current;
    const inputsBefore = previousInputs.current;

    previous.current = ids;
    previousNeed.current = needIds;
    previousInputs.current = inputIds;

    if (before === null || needBefore === null || inputsBefore === null) return;

    const alertOf = (node: ChatNode): Alert => {
      const { state, reason } = rootAttention(node);

      return {
        id: node.thread.id,
        projectId: node.thread.projectId,
        title: node.thread.displayTitle,
        line: reason,
        label: CARD_LABEL[cardStateOf(state)],
        state,
        duration: state === "need" ? NEED_ALERT_TIME : ALERT_TIME,
        raisedAt: Date.now(),
      };
    };

    let next: Alert | null = null;

    for (const id of before) {
      if (ids.has(id)) continue;
      const node = tree.nodes.get(id);

      if (node === undefined || !rootAttention(node).unread) continue;

      next = alertOf(node);
    }

    for (const id of needIds) {
      if (needBefore.has(id)) continue;
      const node = tree.nodes.get(id);

      if (node === undefined) continue;

      if (rootAttention(node).asking && inputKeys(node).every((key) => inputsBefore.has(key)))
        continue;

      next = alertOf(node);
    }

    if (next !== null) setAlert(next);
  }, [running, tree, glance.cards]);

  useEffect(() => {
    setAlertPaused(false);
    alertDeadline.current = alert === null ? null : { remaining: alert.duration, startedAt: 0 };
  }, [alert]);

  useEffect(() => {
    const deadline = alertDeadline.current;

    if (alert === null || alertPaused || deadline === null) return;
    deadline.startedAt = Date.now();
    const timer = setTimeout(() => setAlert(null), deadline.remaining);

    return () => {
      clearTimeout(timer);
      deadline.remaining = Math.max(0, deadline.remaining - (Date.now() - deadline.startedAt));
    };
  }, [alert, alertPaused]);

  useEffect(() => {
    if (panel === "closed") return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);

    return () => clearInterval(timer);
  }, [panel]);

  useEffect(() => {
    if (panel !== "open") return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPanel(dismiss);
    };

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;

      if (
        target instanceof Node &&
        !pillRef.current?.contains(target) &&
        !panelRef.current?.contains(target)
      )
        setPanel(dismiss);
    };

    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown, true);

    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [panel]);

  useLayoutEffect(() => {
    if (panel !== "closing") return;
    const exits = panelRef.current?.getAnimations() ?? [];
    let current = true;

    void Promise.allSettled(exits.map((animation) => animation.finished)).then(() => {
      if (current) setPanel("closed");
    });

    return () => {
      current = false;
    };
  }, [panel]);

  const place = useCallback(() => {
    const rect = pillRef.current?.getBoundingClientRect();

    if (rect === undefined) return;
    const width = Math.min(420, window.innerWidth - 24);
    const center = rect.left + rect.width / 2;
    const left = Math.max(12, Math.min(center - width / 2, window.innerWidth - width - 12));

    setPosition({
      left,
      bottom: window.innerHeight - rect.top + PANEL_GAP,
      originX: center - left,
    });
  }, []);

  const openThread = useCallback(
    (node: ChatNode, split: boolean) => {
      setPanel(dismiss);
      navigate.toThread(node.thread.id, chatTapOptions(split));
    },
    [navigate],
  );

  const empty = running.length === 0 && needing.length === 0 && alert === null;
  const live = status === "ready" && !empty;

  useEffect(() => {
    if (!live) setPanel("closed");
  }, [live]);

  if (!live) return null;

  const counts = [
    ...(running.length > 0
      ? [`${running.length} chat${running.length === 1 ? "" : "s"} running.`]
      : []),
    ...(needing.length > 0
      ? [`${needing.length} need${needing.length === 1 ? "s" : ""} you.`]
      : []),
  ].join(" ");

  const label =
    alert !== null ? `${alert.label}: ${alert.title}. Open it.` : `${counts} Click to list them.`;

  const onPillClick = () => {
    if (alert !== null) {
      const node = tree.nodes.get(alert.id);
      setAlert(null);

      if (node !== undefined) openThread(node, false);

      return;
    }

    if (!full && inboxMounted && inboxShowsRunning) {
      revealRunningSection();
      setPanel(dismiss);

      return;
    }

    if (panel === "open") {
      setPanel(dismiss);

      return;
    }

    place();
    setPanel("open");
  };

  const groups = new Map<string, ChatNode[]>();

  for (const node of running) {
    const list = groups.get(node.thread.projectId) ?? [];
    list.push(node);
    groups.set(node.thread.projectId, list);
  }

  const listed = running.length + needing.length;

  const projectCount = new Set([...needing, ...running].map((node) => node.thread.projectId)).size;

  return (
    <div
      className="ctl"
      data-live-capsule=""
      data-placement={placement}
      data-alert={alert !== null}
      onPointerEnter={alert === null ? undefined : () => setAlertPaused(true)}
      onPointerLeave={alert === null ? undefined : () => setAlertPaused(false)}
    >
      <button
        ref={pillRef}
        type="button"
        className="ctl-pill"
        aria-label={label}
        aria-expanded={full ? panel === "open" : undefined}
        onClick={onPillClick}
      >
        {alert === null ? null : (
          <Fold>
            <span className="ctl-alert-face">
              <span className="ctl-done" aria-hidden>
                <StateDot kind={DOT_OF_STATE[alert.state]} label={null} />
              </span>
              <ProjectIcon projectId={alert.projectId} className="ctl-face" />
              <span className="ctl-alert">
                <b>{alert.title}</b>
                {!full || alert.line === null ? null : <span>{alert.line}</span>}
              </span>
            </span>
          </Fold>
        )}
        {alert !== null || running.length === 0 ? null : (
          <Fold>
            <span className="ctl-running">
              {full ? (
                <span className="ctl-run-dot" aria-hidden />
              ) : (
                <span className="ctl-run" aria-hidden>
                  <Icon name="Spinner" className="size-3" />
                </span>
              )}
              <span className="ctl-count">{running.length}</span>
              {full ? <span className="ctl-label">running</span> : null}
            </span>
          </Fold>
        )}
        {alert !== null || needing.length === 0 ? null : (
          <Fold>
            <span className="ctl-need" data-island-need="" data-separated={running.length > 0}>
              <span className="ctl-need-dot" aria-hidden />
              <span className="ctl-need-count">{needing.length}</span>
              <span className="ctl-label">{needing.length === 1 ? "needs you" : "need you"}</span>
            </span>
          </Fold>
        )}
        {alert === null ? null : (
          <span
            key={`${alert.id}:${alert.raisedAt}`}
            className="ctl-alert-time"
            aria-hidden
            data-paused={alertPaused}
            data-state={alert.state}
            style={{ animationDuration: `${alert.duration}ms` }}
          />
        )}
      </button>
      {panel !== "closed" && position !== null
        ? createPortal(
            <div
              ref={panelRef}
              className="ctl-panel"
              role="dialog"
              aria-label="Live chats"
              data-state={panel}
              inert={panel === "closing"}
              style={{
                left: position.left,
                bottom: position.bottom,
                transformOrigin: `${position.originX}px calc(100% + ${PANEL_GAP}px)`,
              }}
            >
              <div className="ctl-panel-head">
                <b>Live</b>
                <span>
                  {listed} agent{listed === 1 ? "" : "s"} · {projectCount} project
                  {projectCount === 1 ? "" : "s"}
                </span>
              </div>
              <div className="ctl-panel-body">
                {needing.length === 0 ? null : (
                  <div className="ctl-group" data-need-group="">
                    <div className="ctl-group-head">
                      <StateDot kind="need" label={null} />
                      Needs you · {needing.length}
                    </div>
                    {needing.map((node) => (
                      <LiveRow
                        key={node.thread.id}
                        node={node}
                        thread={byId.get(node.thread.id)}
                        phaseCard={null}
                        now={now}
                        need
                        onOpen={openThread}
                      />
                    ))}
                  </div>
                )}
                {[...groups]
                  .sort((a, b) => b[1].length - a[1].length)
                  .map(([projectId, list]) => (
                    <div key={projectId} className="ctl-group">
                      <div className="ctl-group-head">
                        <ProjectIcon projectId={projectId} className="ctl-face" />
                        {projectNames.get(projectId) ?? "Project"} · {list.length}
                      </div>
                      {list.map((node) => (
                        <LiveRow
                          key={node.thread.id}
                          node={node}
                          thread={byId.get(node.thread.id)}
                          phaseCard={glance.cards.get(node.thread.id) ?? null}
                          now={now}
                          need={false}
                          onOpen={openThread}
                        />
                      ))}
                    </div>
                  ))}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

interface LiveRowProps {
  node: ChatNode;
  thread: PluginSidebarThread | undefined;
  phaseCard: Parameters<typeof cardPhase>[0];
  now: number;
  need: boolean;
  onOpen: (node: ChatNode, split: boolean) => void;
}

function LiveRow({ node, thread, phaseCard, now, need, onOpen }: LiveRowProps) {
  if (thread === undefined) return null;
  const phase = phaseCard !== null && phaseCard.status === "working" ? cardPhase(phaseCard) : null;
  const reason = need ? rootAttention(node).reason : null;

  return (
    <a
      href={thread.href}
      className="ctl-row"
      data-live-row={need ? undefined : ""}
      data-need-row={need ? "" : undefined}
      onClick={(event) => openFromClick(event, (split) => onOpen(node, split))}
    >
      <span className="ctl-row-glyph" aria-hidden>
        {need ? (
          <StateDot kind="need" label={null} />
        ) : (
          <Icon name="Spinner" className="size-3.5" />
        )}
      </span>
      {reason === null ? (
        <span className="ctl-row-title">{thread.displayTitle}</span>
      ) : (
        <span className="ctl-row-text">
          <span className="ctl-row-title">{thread.displayTitle}</span>
          <span className="ctl-row-reason">{reason}</span>
        </span>
      )}
      {phase === null ? null : <span className="ctl-row-phase">{PHASE_LABEL[phase]}</span>}
      <span className="ctl-row-age">{age(now, node.attentionAt)}</span>
    </a>
  );
}
