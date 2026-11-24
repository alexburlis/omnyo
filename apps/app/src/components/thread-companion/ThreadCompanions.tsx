import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { ExperimentalThreadCompanionPlacement } from "@omnyo/plugin-sdk";
import { useIsCompactViewport } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { useWindowTitleBarSlots } from "@/components/layout/window-title-bar-slots";
import { PluginSlotMount } from "@/components/plugin/PluginSlotMount";
import {
  usePluginSlots,
  type ExperimentalThreadCompanionSlot,
} from "@/lib/plugin-slots";
import {
  captureCompanionMorphSnapshot,
  playCompanionMorph,
  type CompanionMorphSnapshot,
} from "./morph";
import {
  asideFitsBesideChat,
  resolveThreadCompanionPlacement,
  THREAD_COMPANION_ASIDE_GEOMETRY,
} from "./placement";

type Placement = ExperimentalThreadCompanionPlacement;

type PlacementTargets = Readonly<Record<Placement, HTMLElement | null>>;

const GOAL_PILL_CLEARANCE_PX = 44;

const CONTAINER_CLASS: Readonly<Record<Placement, string>> = {
  aside: "pointer-events-auto min-w-0",
  toolbar: "flex min-w-0 max-w-80 items-center",
  inline: "min-w-0",
};

function companionKey(slot: ExperimentalThreadCompanionSlot): string {
  return `${slot.pluginId}/${slot.id}`;
}

interface ThreadCompanionPaneSlots {
  setAsideSlot: (element: HTMLElement | null) => void;
  setInlineSlot: (element: HTMLElement | null) => void;
  reportPaneWidth: (width: number) => void;
}

const ThreadCompanionPaneSlotsContext =
  createContext<ThreadCompanionPaneSlots | null>(null);

export function ThreadCompanionHost({
  children,
  focused,
  projectId,
  threadId,
}: {
  children: ReactNode;
  focused: boolean;
  projectId: string;
  threadId: string;
}) {
  const { threadCompanions } = usePluginSlots();
  const compact = useIsCompactViewport();
  const companionToolbar = useWindowTitleBarSlots()?.companionToolbar ?? null;
  const [asideSlot, setAsideSlot] = useState<HTMLElement | null>(null);
  const [inlineSlot, setInlineSlot] = useState<HTMLElement | null>(null);
  const [asideFits, setAsideFits] = useState(false);

  const paneSlots = useMemo<ThreadCompanionPaneSlots>(
    () => ({
      setAsideSlot,
      setInlineSlot,
      reportPaneWidth: (width) =>
        setAsideFits((previous) => asideFitsBesideChat(width, previous)),
    }),
    [],
  );

  const targets = useMemo<PlacementTargets>(
    () => ({ aside: asideSlot, toolbar: companionToolbar, inline: inlineSlot }),
    [asideSlot, companionToolbar, inlineSlot],
  );

  return (
    <ThreadCompanionPaneSlotsContext.Provider value={paneSlots}>
      {children}
      {threadCompanions.map((slot, order) => (
        <ThreadCompanionInstance
          key={`${companionKey(slot)}/${slot.generation}`}
          slot={slot}
          order={order}
          threadId={threadId}
          projectId={projectId}
          compact={compact}
          focused={focused}
          asideFits={asideFits}
          targets={targets}
        />
      ))}
    </ThreadCompanionPaneSlotsContext.Provider>
  );
}

function ThreadCompanionInstance({
  asideFits,
  compact,
  focused,
  order,
  projectId,
  slot,
  targets,
  threadId,
}: {
  asideFits: boolean;
  compact: boolean;
  focused: boolean;
  order: number;
  projectId: string;
  slot: ExperimentalThreadCompanionSlot;
  targets: PlacementTargets;
  threadId: string;
}) {
  const placement = resolveThreadCompanionPlacement({
    compact,
    focused,
    asideFits,
  });

  const [container] = useState(() => document.createElement("div"));
  const [rendered, setRendered] = useState(placement);
  const pendingMorph = useRef<CompanionMorphSnapshot | null>(null);
  const cancelMorph = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    if (placement === rendered) return;
    pendingMorph.current =
      placement !== null && rendered !== null
        ? captureCompanionMorphSnapshot(container)
        : null;
    setRendered(placement);
  }, [container, placement, rendered]);

  const target = rendered === null ? null : targets[rendered];

  useLayoutEffect(() => {
    const snapshot = pendingMorph.current;
    pendingMorph.current = null;

    if (rendered === null || target === null) {
      container.remove();

      return;
    }

    container.className = CONTAINER_CLASS[rendered];
    container.style.order = String(order);
    container.dataset.threadCompanion = companionKey(slot);
    container.dataset.placement = rendered;

    if (container.parentElement !== target) target.append(container);

    if (snapshot !== null) {
      cancelMorph.current();
      cancelMorph.current = playCompanionMorph(snapshot, container);
    }
  }, [container, order, rendered, slot, target]);

  useLayoutEffect(
    () => () => {
      cancelMorph.current();
      container.remove();
    },
    [container],
  );

  if (rendered === null) return null;
  const Component = slot.component;

  return createPortal(
    <PluginSlotMount
      pluginId={slot.pluginId}
      slotKind="threadCompanion"
      slotId={slot.id}
      instanceId={threadId}
      crashFallback={null}
    >
      <Component
        threadId={threadId}
        projectId={projectId}
        placement={rendered}
      />
    </PluginSlotMount>,
    container,
  );
}

export function ThreadPaneTopOverlay({
  goal,
  goalShown,
}: {
  goal: ReactNode;
  goalShown: boolean;
}) {
  const paneSlots = useContext(ThreadCompanionPaneSlotsContext);
  const stripRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const strip = stripRef.current;

    if (strip === null || paneSlots === null) return;

    const measure = () => {
      const width = strip.getBoundingClientRect().width;

      if (width > 0) paneSlots.reportPaneWidth(width);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(strip);

    return () => observer.disconnect();
  }, [paneSlots]);

  return (
    <div
      ref={stripRef}
      data-thread-pane-top-overlay=""
      className="relative z-20 h-0 shrink-0"
    >
      {goal}
      {paneSlots === null ? null : (
        <div
          ref={paneSlots.setAsideSlot}
          data-thread-companion-aside=""
          className="pointer-events-none absolute flex flex-col gap-2"
          style={{
            top: goalShown
              ? GOAL_PILL_CLEARANCE_PX
              : THREAD_COMPANION_ASIDE_GEOMETRY.inset,
            right:
              THREAD_COMPANION_ASIDE_GEOMETRY.edgeReserve +
              THREAD_COMPANION_ASIDE_GEOMETRY.inset,
            width: THREAD_COMPANION_ASIDE_GEOMETRY.cardWidth,
          }}
        />
      )}
    </div>
  );
}

export function ThreadCompanionInlineSlot() {
  const paneSlots = useContext(ThreadCompanionPaneSlotsContext);

  if (paneSlots === null) return null;

  return (
    <div
      ref={paneSlots.setInlineSlot}
      data-thread-companion-inline=""
      className="grid min-w-0 gap-2 empty:hidden"
    />
  );
}
