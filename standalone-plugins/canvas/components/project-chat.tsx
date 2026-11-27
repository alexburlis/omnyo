import { useIsCompactViewport } from "../ui/components/ui/hooks/use-compact-viewport";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  experimental_Icon as Icon,
  experimental_NewThreadComposer as NewThreadComposer,
  experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  experimental_useAppNavigate,
  experimental_useSidebarThreads,
  ThreadChat,
  ThreadTitle,
  useRpc,
  useSdk,
  experimental_ResponsiveDrawerShell as ResponsiveDrawerShell,
} from "@omnyo/plugin-sdk/app";
import type { CanvasRpcContract } from "../contract";
import type { ProjectCanvas, ProjectChat } from "../project-contract";
import type { Rect, Viewport } from "../lib/layout";
import { useProjectHistory } from "./project-history";
import { chatConnector, openChatCardRect, OPEN_CHAT_CARD_WIDTH } from "./project-geometry";

export interface CanvasChatTarget {
  regionId: string | null;
  kind: ProjectChat["anchorKind"];
  id: string | null;
  x: number;
  y: number;
  label: string;
}

export function ProjectChatSurface({
  project,
  camera,
  size,
  target,
  sectionRects,
  openThreadId,
  changedNodes,
  filterActive = false,
  onOpen,
  onClose,
  onCreated,
  onJumpNode,
  onChanges,
}: {
  project: ProjectCanvas;
  camera: Viewport;
  size: { width: number; height: number };
  target: CanvasChatTarget;
  sectionRects: ReadonlyMap<string, Rect>;
  openThreadId: string | null;
  changedNodes: readonly { sectionId: string; nodeId: string; rect: Rect }[];
  filterActive?: boolean;
  onOpen(threadId: string): void;
  onClose(): void;
  onCreated(threadId: string): void;
  onJumpNode(sectionId: string, nodeId: string): void;
  onChanges(sectionId: string, threadId: string): void;
}) {
  const compact = useIsCompactViewport();
  const sdk = useSdk();
  const rpc = useRpc<CanvasRpcContract>();
  const remember = useProjectHistory();
  const navigate = experimental_useAppNavigate();

  const { threads } = experimental_useSidebarThreads({
    experimental_lifecycles: ["active", "archived", "shelved"],
  });

  const [expanded, setExpanded] = useState(false);
  const [initialPrompt, setInitialPrompt] = useState("");
  const [wholeCanvas, setWholeCanvas] = useState(false);
  const [recipient, setRecipient] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);

  const [drag, setDrag] = useState<{
    threadId: string;
    x: number;
    y: number;
    savedAtRevision: number | null;
  } | null>(null);

  const [openCardHeight, setOpenCardHeight] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const dragCleanup = useRef<(() => void) | null>(null);

  useEffect(() => () => dragCleanup.current?.(), []);
  useEffect(
    () =>
      setDrag((current) =>
        current?.savedAtRevision != null && current.savedAtRevision !== project.revision
          ? null
          : current,
      ),
    [project.revision],
  );

  const measureOpenCard = useCallback((element: HTMLElement) => {
    const measure = () => setOpenCardHeight(element.offsetHeight || null);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);

    return () => {
      observer.disconnect();
      setOpenCardHeight(null);
    };
  }, []);

  useEffect(() => {
    if (!project.sections.some((section) => section.archivedAt === null)) {
      setExpanded(true);
      setFocusRequest(1);
    }
  }, []);
  useEffect(() => setWholeCanvas(false), [target.regionId, target.kind, target.id]);
  useEffect(() => {
    setRecipient(openThreadId);
  }, [openThreadId]);

  function focus() {
    setFocusRequest((value) => value + 1);

    if (recipient) {
      onOpen(recipient);
      setExpanded(false);
    } else setExpanded(true);
  }

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const target = event.target;

      if (
        !(
          target === document.body ||
          (target instanceof Element &&
            target.closest(".cnv-project, .cnv-project-toolbar") !== null)
        )
      )
        return;

      if (event.key === "Escape" && !event.defaultPrevented) {
        setExpanded(false);
        onClose();

        return;
      }

      if (
        target instanceof Element &&
        target.closest("input,textarea,select,[contenteditable=true]")
      )
        return;

      if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        focus();
      }
    };

    window.addEventListener("keydown", keyboard);

    return () => window.removeEventListener("keydown", keyboard);
  });

  const connectors = useMemo(
    () => [
      ...new Map(changedNodes.map((node) => [`${node.sectionId}:${node.nodeId}`, node])).values(),
    ],
    [changedNodes],
  );

  const cards = project.chats.filter(
    (chat) =>
      chat.role === "spawned" &&
      chat.state === "open" &&
      !threads.find((thread) => thread.id === chat.threadId)?.isArchived,
  );

  function worldPoint(chat: ProjectChat) {
    if (drag?.threadId === chat.threadId) return drag;
    const section = project.sections.find((entry) => entry.id === chat.regionId);

    return { x: chat.x + (section?.x ?? 0), y: chat.y + (section?.y ?? 0) };
  }

  function screenPoint(chat: ProjectChat) {
    const point = worldPoint(chat);

    return { x: camera.x + point.x * camera.zoom, y: camera.y + point.y * camera.zoom };
  }

  const openCard = compact ? undefined : cards.find((entry) => entry.threadId === openThreadId);

  const openCardRect = openCard
    ? openChatCardRect(screenPoint(openCard), size, openCardHeight)
    : null;

  function startDrag(event: React.PointerEvent<HTMLElement>, chat: ProjectChat) {
    if (
      event.button !== 0 ||
      (event.target instanceof Element && event.target.closest("button,select"))
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    dragCleanup.current?.();
    const start = { x: event.clientX, y: event.clientY };
    const element = event.currentTarget;

    const origin =
      openCardRect && openCard?.threadId === chat.threadId
        ? {
            x: (openCardRect.x - camera.x) / camera.zoom,
            y: (openCardRect.y - camera.y) / camera.zoom,
          }
        : worldPoint(chat);

    const dropPoint = (next: PointerEvent) => ({
      x: origin.x + (next.clientX - start.x) / camera.zoom,
      y: origin.y + (next.clientY - start.y) / camera.zoom,
    });

    element.setPointerCapture(event.pointerId);

    const move = (next: PointerEvent) => {
      if (next.pointerId === event.pointerId)
        setDrag({ threadId: chat.threadId, ...dropPoint(next), savedAtRevision: null });
    };

    const stop = (next: PointerEvent) => {
      if (next.pointerId !== event.pointerId) return;
      dragCleanup.current?.();

      if (
        next.type === "pointercancel" ||
        Math.hypot(next.clientX - start.x, next.clientY - start.y) < 4
      ) {
        setDrag(null);

        return;
      }

      const world = dropPoint(next);
      setDrag({ threadId: chat.threadId, ...world, savedAtRevision: project.revision });

      const section = project.sections.find((entry) => {
        const rect = sectionRects.get(entry.id);

        return (
          entry.archivedAt === null &&
          rect &&
          world.x >= rect.x &&
          world.x <= rect.x + rect.width &&
          world.y >= rect.y &&
          world.y <= rect.y + rect.height
        );
      });

      void rpc
        .call("project.chat.move", {
          projectId: project.projectId,
          expectedRevision: project.revision,
          actor: "human",
          threadId: chat.threadId,
          regionId: section?.id ?? null,
          anchorKind: section ? "section" : "free",
          anchorId: section?.id ?? null,
          x: world.x - (section?.x ?? 0),
          y: world.y - (section?.y ?? 0),
        })
        .then(remember)
        .catch((reason) => {
          setDrag(null);
          setError(reason instanceof Error ? reason.message : "The chat card could not move.");
        });
    };

    dragCleanup.current = () => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", stop);
      element.removeEventListener("pointercancel", stop);
      dragCleanup.current = null;
    };

    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", stop);
    element.addEventListener("pointercancel", stop);
  }

  const focusLabel = target.label.split(" › ").at(-1) ?? target.label;
  const emptyCanvas = !project.sections.some((section) => section.archivedAt === null);

  const placeholder = recipient
    ? "Reply in this chat…"
    : emptyCanvas
      ? "Describe the dashboard you want"
      : wholeCanvas
        ? "Ask or change something on this canvas…"
        : target.kind === "free"
          ? "Ask for something new here…"
          : `Ask or change something in ${focusLabel}…`;

  return (
    <div ref={root} className="cnv-project-chat-layer">
      {openCardRect && camera.zoom > 0.12 ? (
        <svg className="cnv-project-chat-connectors" aria-hidden="true">
          <g>
            {connectors.map((node) => {
              const line = chatConnector(openCardRect, {
                x: camera.x + node.rect.x * camera.zoom,
                y: camera.y + node.rect.y * camera.zoom,
                width: node.rect.width * camera.zoom,
                height: node.rect.height * camera.zoom,
              });

              return line ? (
                <path
                  key={`${node.sectionId}:${node.nodeId}`}
                  d={`M${line.from.x},${line.from.y} L${line.to.x},${line.to.y}`}
                />
              ) : null;
            })}
          </g>
        </svg>
      ) : null}
      {camera.zoom <= 0.12
        ? null
        : cards.map((chat) => {
            const thread = threads.find((entry) => entry.id === chat.threadId);
            const { x, y } = screenPoint(chat);
            const open = openThreadId === chat.threadId;
            const changedSection = chat.regionId ?? connectors[0]?.sectionId;
            const offscreen = x < 0 || y < 0 || x > size.width - 40 || y > size.height - 40;

            if (offscreen && !open)
              return thread?.hasPendingInteraction ? (
                <button
                  key={chat.threadId}
                  type="button"
                  className="cnv-project-attention"
                  title="This chat needs you. Click to open it."
                  style={{
                    left: Math.max(8, Math.min(size.width - 220, x)),
                    top: Math.max(8, Math.min(size.height - 50, y)),
                  }}
                  onClick={() => onOpen(chat.threadId)}
                >
                  <ThreadStatusGlyph indicator={thread.indicator} />
                  <span className="cnv-project-chat-title">
                    <ThreadTitle threadId={chat.threadId} />
                  </span>
                  <Icon name="ArrowRight" className="cnv-project-icon" aria-hidden />
                </button>
              ) : null;

            const card = (
              <section
                key={chat.threadId}
                ref={open && !compact ? measureOpenCard : undefined}
                className="cnv-project-chat-card"
                data-open={open || compact}
                data-attention={thread?.hasPendingInteraction}
                data-unread={thread?.isUnread || undefined}
                style={
                  compact
                    ? {
                        position: "relative",
                        inset: "auto",
                        width: "100%",
                        maxWidth: "none",
                        border: 0,
                        borderRadius: 0,
                        boxShadow: "none",
                      }
                    : open && openCardRect
                      ? { left: openCardRect.x, top: openCardRect.y, width: OPEN_CHAT_CARD_WIDTH }
                      : { left: x, top: y }
                }
                aria-label={thread?.displayTitle ?? "Canvas chat"}
                onClickCapture={(event) => {
                  const href =
                    event.target instanceof Element
                      ? event.target.closest("a[href]")?.getAttribute("href")
                      : null;

                  if (href?.startsWith("#canvas-node-") && chat.regionId) {
                    event.preventDefault();
                    onJumpNode(
                      chat.regionId,
                      decodeURIComponent(href.slice("#canvas-node-".length)),
                    );
                  }
                }}
              >
                <header onPointerDown={compact ? undefined : (event) => startDrag(event, chat)}>
                  {thread ? <ThreadStatusGlyph indicator={thread.indicator} /> : null}
                  <button
                    type="button"
                    className="cnv-project-chat-title"
                    title={open ? undefined : "Open this chat here"}
                    onClick={() => onOpen(chat.threadId)}
                  >
                    <ThreadTitle threadId={chat.threadId} />
                  </button>
                  {open || compact ? (
                    <>
                      <button
                        type="button"
                        className="cnv-project-icon-button"
                        aria-label="Open full chat"
                        title="Open as a full chat"
                        onClick={() => navigate.toThread(chat.threadId)}
                      >
                        <Icon name="ExternalLink" className="cnv-project-icon" aria-hidden />
                      </button>
                      <button
                        type="button"
                        className="cnv-project-icon-button"
                        aria-label="Close chat card"
                        title="Close (Esc)"
                        onClick={onClose}
                      >
                        <Icon name="Minus" className="cnv-project-icon" aria-hidden />
                      </button>
                    </>
                  ) : null}
                </header>
                {open || compact ? (
                  <>
                    <div className="cnv-project-chat-transcript">
                      <ThreadChat
                        threadId={chat.threadId}
                        variant="compact"
                        layout="contained"
                        focusRequest={focusRequest}
                      />
                    </div>
                    {changedSection ? (
                      <footer className="cnv-project-chat-card-foot">
                        <button
                          type="button"
                          className="cnv-project-quiet-button"
                          aria-pressed={filterActive}
                          title="Show only the changes this chat made"
                          onClick={() => {
                            onChanges(changedSection, chat.threadId);
                          }}
                        >
                          <Icon name="Clock" className="cnv-project-icon" aria-hidden />
                          Changed by this chat
                        </button>
                      </footer>
                    ) : null}
                  </>
                ) : null}
              </section>
            );

            if (!compact) return card;

            return (
              <Fragment key={chat.threadId}>
                {!open ? (
                  <button
                    type="button"
                    className="cnv-project-chat-card"
                    data-open="false"
                    data-attention={thread?.hasPendingInteraction}
                    style={{ left: x, top: y }}
                    onClick={() => onOpen(chat.threadId)}
                  >
                    {thread ? <ThreadStatusGlyph indicator={thread.indicator} /> : null}
                    <span className="cnv-project-chat-title">
                      <ThreadTitle threadId={chat.threadId} />
                    </span>
                  </button>
                ) : null}
                <ResponsiveDrawerShell
                  open={open}
                  onOpenChange={(next) => {
                    if (!next) onClose();
                  }}
                  srLabel={thread?.displayTitle ?? "Canvas chat"}
                  contentClassName="min-h-0 overflow-hidden"
                >
                  {card}
                </ResponsiveDrawerShell>
              </Fragment>
            );
          })}
      <section
        className="cnv-project-chat-box"
        data-expanded={expanded}
        data-composer={expanded && recipient === null}
        aria-label="Canvas chat composer"
      >
        <div className="cnv-project-chat-context">
          {emptyCanvas ? null : (
            <button
              type="button"
              className="cnv-project-chat-target"
              data-scope={wholeCanvas ? "canvas" : target.kind}
              aria-label={
                wholeCanvas
                  ? `Sending to the whole canvas. Switch to ${target.label}`
                  : `Sending to ${target.label}. Switch to the whole canvas`
              }
              title={
                wholeCanvas
                  ? `Click to send to ${target.label} instead`
                  : "Click to send to the whole canvas instead"
              }
              onClick={() => setWholeCanvas((current) => !current)}
            >
              <Icon
                name={wholeCanvas ? "GridView" : "Target"}
                className="cnv-project-icon"
                aria-hidden
              />
              <span className="cnv-project-chat-target-label">
                {wholeCanvas ? "Whole canvas" : target.label}
              </span>
              {wholeCanvas ? null : (
                <Icon name="X" className="cnv-project-icon cnv-project-chat-clear" aria-hidden />
              )}
            </button>
          )}
          <span className="cnv-project-toolbar-spacer" />
          {cards.length > 0 ? (
            <label
              className="cnv-project-chat-recipient"
              title="Start a new chat, or continue one already on the canvas"
            >
              <Icon
                name={recipient ? "MessageSquare" : "MessageSquarePlus"}
                className="cnv-project-icon"
                aria-hidden
              />
              <select
                aria-label="Chat recipient"
                value={recipient ?? ""}
                onChange={(event) => {
                  const value = event.target.value || null;
                  setRecipient(value);

                  if (value) {
                    onOpen(value);
                    setExpanded(false);
                  } else {
                    setExpanded(true);
                    setFocusRequest((current) => current + 1);
                  }
                }}
              >
                <option value="">New chat</option>
                {cards.map((chat) => (
                  <option key={chat.threadId} value={chat.threadId}>
                    {threads.find((thread) => thread.id === chat.threadId)?.displayTitle ??
                      "Canvas chat"}
                  </option>
                ))}
              </select>
              <Icon name="ChevronDown" className="cnv-project-icon" aria-hidden />
            </label>
          ) : (
            <span
              className="cnv-project-chat-recipient"
              data-static
              title="Each message starts a new chat, shown as a card here"
            >
              <Icon name="MessageSquarePlus" className="cnv-project-icon" aria-hidden />
              New chat
            </span>
          )}
          {expanded ? (
            <button
              type="button"
              className="cnv-project-icon-button"
              aria-label="Collapse chat box"
              title="Collapse (Esc)"
              onClick={() => setExpanded(false)}
            >
              <Icon name="ChevronDown" className="cnv-project-icon" aria-hidden />
            </button>
          ) : null}
        </div>
        {expanded && recipient === null ? (
          <div className="cnv-project-new-chat">
            <NewThreadComposer
              defaultProjectId={project.projectId}
              draftKey={`canvas-project-${project.projectId}`}
              initialPrompt={initialPrompt}
              placeholder={placeholder}
              layout="contained"
              focusRequest={focusRequest}
              onSubmit={async (request) => {
                if (request.projectId !== project.projectId)
                  throw new Error("Choose this canvas’s project before sending.");

                const anchor = wholeCanvas
                  ? {
                      regionId: null,
                      kind: "free",
                      id: null,
                      x: (-camera.x + size.width / 2) / camera.zoom,
                      y: (-camera.y + size.height / 2) / camera.zoom,
                    }
                  : target;

                try {
                  const thread = await sdk.threads.spawn({
                    ...request,
                    visibility: "visible",
                    pluginMetadata: {
                      canvasChat: true,
                      projectId: project.projectId,
                      regionId: anchor.regionId,
                      anchorKind: anchor.kind,
                      anchorId: anchor.id,
                      x: anchor.x,
                      y: anchor.y,
                    },
                  });

                  setExpanded(false);
                  setInitialPrompt("");
                  setRecipient(thread.id);
                  setError(null);
                  onCreated(thread.id);
                } catch (reason) {
                  setError(
                    reason instanceof Error ? reason.message : "The canvas chat could not start.",
                  );
                  throw reason;
                }
              }}
            />
          </div>
        ) : (
          <div className="cnv-project-chat-field">
            <input
              className="cnv-project-chat-line"
              aria-label={recipient ? "Reply in this canvas chat" : "Start a canvas chat"}
              placeholder={placeholder}
              value={initialPrompt}
              onChange={(event) => {
                setInitialPrompt(event.target.value);
                focus();
              }}
              onFocus={focus}
            />
            <kbd className="cnv-project-kbd" title="Press / to focus" aria-hidden="true">
              /
            </kbd>
            <button
              type="button"
              className="cnv-project-chat-expand"
              aria-label="Open canvas chat composer"
              title="Write a message"
              onClick={focus}
            >
              <Icon name="ArrowUp" className="cnv-project-icon" aria-hidden />
            </button>
          </div>
        )}
        {error ? (
          <p className="cnv-project-chat-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    </div>
  );
}
