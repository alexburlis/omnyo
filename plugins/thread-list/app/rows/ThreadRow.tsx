import {
  memo,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type MouseEventHandler,
  type PointerEventHandler,
  type ReactNode,
} from "react";
import { useComposedRefs } from "@radix-ui/react-compose-refs";
import { useAtomValue } from "jotai";
import { Icon } from "@/components/ui/icon";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  COARSE_POINTER_COMPACT_ROW_HEIGHT_CLASS,
  COARSE_POINTER_ROW_HEIGHT_CLASS,
} from "@/components/ui/coarse-pointer-sizing";
import { cn } from "@/lib/utils";
import { LIST_HOVER_TRANSITION } from "@/components/ui/motion";
import {
  hasThreadListWorkingActivity,
  strongestThreadWorkSummary,
  resolveThreadStatus,
  threadListIndicatorStateForThread,
  NO_COLLAPSED_CHILD_ACTIVITY,
  type CollapsedChildActivity,
  type ThreadListIndicatorState,
} from "../model/thread-activity.js";
import {
  experimental_ThreadActionsContextMenu as ThreadActionsContextMenu,
  experimental_ThreadActionsMenu as ThreadActionsMenu,
  experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  experimental_THREAD_ACTION_GROUPS,
  experimental_useThreadActions,
  experimental_useSidebarThreadSplit,
  experimental_ProviderIcon as ProviderIcon,
  ThreadTitle,
  useSidebarThreadDraft,
  useSidebarThreadRowStatus,
  useSidebarThreadShortcut,
  useSdk,
  type PluginThreadActionsInlineItem,
  type PluginThreadActionsTriggerProps,
  type PluginSidebarThreadRowStatus,
  type PluginProvidersState,
} from "@omnyo/plugin-sdk/app";
import type { SidebarThread } from "../model/sidebar-thread.js";
import { useSidebarThreadSelected } from "../list/SidebarThreadSelection.js";
import { useThreadHandoffLineage } from "../model/handoff-lineage.js";
import {
  sidebarThreadLifecycle,
  type SidebarThreadLifecycle,
} from "../model/sidebar-thread-lifecycle.js";
import {
  NO_THREAD_IDS,
  useThreadsHaveDraft,
} from "../list/sidebarDraftPresence.js";
import { useSidebarProjectName } from "../model/use-sidebar-data.js";
import {
  sidebarShowProviderIconsAtom,
  threadRowActionsAtom,
} from "../preferences/atoms.js";
import { AppCommandShortcutPill } from "../ui/AppCommandShortcutPill.js";
import { SidebarStickyTier } from "../ui/sidebar.js";
import {
  SIDEBAR_HOVER_ACTIONS_CLASS,
  SIDEBAR_HOVER_ACTIONS_FADE_CLASS,
  SIDEBAR_HOVER_ACTIONS_INSET_CLASS,
  SIDEBAR_HOVER_ACTIONS_ROW_CLASS,
} from "@/components/ui/sidebar-hover-actions";
import type { ConsumeDragClickSuppression } from "@/components/ui/use-drag-click-suppression";
import { useSidebarRename } from "./SidebarInlineRename.js";
import { SidebarRowControls } from "./SidebarRowControls.js";
import {
  SIDEBAR_CONTROL_BUTTON_CLASS,
  SIDEBAR_ROW_BASE_CLASS,
  SIDEBAR_ROW_GLYPH_SLOT_CLASS,
  SIDEBAR_ROW_ACCENT_STATE_CLASS,
  SIDEBAR_ROW_INTERACTIVE_STATE_CLASS,
  SIDEBAR_ROW_OPEN_IN_SPLIT_STATE_CLASS,
  SIDEBAR_ROW_SELECTED_STATE_CLASS,
  SIDEBAR_STATUS_GLYPH_BOX_CLASS,
  getSidebarThreadGroupLineLeft,
  getSidebarThreadRowPaddingLeft,
} from "@/components/ui/sidebar-row-classes";
import type {
  SidebarNestTargetState,
  SidebarReorderPlacement,
  ThreadRowNestDrop,
} from "./sidebarThreadRowDroppable.js";
import type { SidebarSortableDragBindings } from "@/components/ui/sortable-motion";
import { SidebarThreadDragChip } from "../dnd/sidebarThreadDragChip.js";
import { SplitPaneMiniMap } from "./SplitPaneMiniMap.js";
import { ThreadRowAge } from "./ThreadRowAge.js";
import { ThreadRowQuickActions } from "./ThreadRowQuickActions.js";
import { toThreadActionTarget } from "./threadActionTarget.js";
import {
  useOpenThreadInSplit,
  usePrefetchThreadOpen,
} from "./threadRowNavigation.js";
import { Button } from "@/components/ui/button";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@/components/ui/coarse-pointer-sizing";
import {
  useCustomizeThreadRowActions,
  useThreadRowActionsCustomizing,
} from "../list/customizeRowActionsContext.js";
import {
  ThreadRowActionsEditor,
  focusFirstRowActionSlot,
} from "../list/ThreadRowActionsCustomize.js";

const SIDEBAR_TITLE_DOUBLE_CLICK_MS = 400;

export const SidebarProvidersContext = createContext<
  PluginProvidersState["providers"]
>([]);

let lastSidebarTitleClick: { at: number; threadId: string } | null = null;

function consumeSidebarTitleDoubleClick(threadId: string): boolean {
  const now = Date.now();
  const previous = lastSidebarTitleClick;
  lastSidebarTitleClick = { at: now, threadId };

  return (
    previous !== null &&
    previous.threadId === threadId &&
    now - previous.at < SIDEBAR_TITLE_DOUBLE_CLICK_MS
  );
}

export function resetSidebarTitleDoubleClickForTest(): void {
  lastSidebarTitleClick = null;
}

interface ThreadRowBaseOptions {
  depth: number;
  isChild: boolean;
  isCompact: boolean;
  consumeClickSuppression?: ConsumeDragClickSuppression;
  dragBindings?: SidebarSortableDragBindings;
  nestDrop?: ThreadRowNestDrop;
}

export type ThreadRowOptions =
  | (ThreadRowBaseOptions & {
      kind: "default";
    })
  | (ThreadRowBaseOptions & {
      kind: "parent";
      childCount: number;
      childActivity: CollapsedChildActivity;
      stickyLevel?: number;
    });

interface ThreadRowProps {
  thread: SidebarThread;
  crossProjectId: string | null;
  isActive: boolean;
  onProjectSelect?: () => void;
  options: ThreadRowOptions;
}

type ThreadRowClickCaptureHandler = MouseEventHandler<HTMLDivElement>;

interface ThreadRowContainerArgs {
  selectable: boolean;
  children: ReactNode;
  className: string;
  containerRef: (element: HTMLDivElement | null) => void;
  dragBindings?: SidebarSortableDragBindings;
  handoffHighlighted: boolean;
  nestTargetState: SidebarNestTargetState | null;
  reorderPlacement: SidebarReorderPlacement | null;
  onClick?: MouseEventHandler<HTMLDivElement>;
  onPointerEnter?: PointerEventHandler<HTMLElement>;
  onPointerLeave?: PointerEventHandler<HTMLElement>;
  onDoubleClick?: MouseEventHandler<HTMLDivElement>;
  onClickCapture?: ThreadRowClickCaptureHandler;
  onSplitDragPointerDown?: PointerEventHandler<HTMLElement>;
  stickyLevel?: number;
  style: CSSProperties;
}

const NEST_TARGET_STATE_CLASS: Record<SidebarNestTargetState, string> = {
  valid:
    "bg-sidebar-accent text-sidebar-accent-foreground ring-1 ring-inset ring-sidebar-ring",
  blocked: "ring-1 ring-inset ring-destructive/60",
  unchanged: "ring-1 ring-inset ring-sidebar-border",
};

export const REORDER_PLACEMENT_CLASS: Record<SidebarReorderPlacement, string> =
  {
    before:
      "before:pointer-events-none before:absolute before:inset-x-1 before:-top-px before:h-0.5 before:rounded-full before:bg-sidebar-ring before:content-['']",
    after:
      "after:pointer-events-none after:absolute after:inset-x-1 after:-bottom-px after:h-0.5 after:rounded-full after:bg-sidebar-ring after:content-['']",
  };

function getHoverActionsInsetStyle(actionCount: number): CSSProperties {
  return {
    "--omnyo-sidebar-hover-actions-inset": `calc(var(--spacing) * ${7.5 * actionCount})`,
  } as CSSProperties;
}

function getThreadRowStyle(depth: number): CSSProperties {
  return {
    paddingLeft: getSidebarThreadRowPaddingLeft(depth),
  };
}

function renderThreadRowContainer({
  children,
  selectable,
  className,
  containerRef,
  dragBindings,
  handoffHighlighted,
  nestTargetState,
  onClick,
  onDoubleClick,
  onClickCapture,
  onPointerEnter,
  onPointerLeave,
  onSplitDragPointerDown,
  reorderPlacement,
  stickyLevel,
  style,
}: ThreadRowContainerArgs) {
  const containerProps = {
    "data-sidebar-rename-row": "",
    "data-sidebar-selectable-thread": selectable ? "" : undefined,
    className,
    style,
    "data-sidebar-handoff-highlight": handoffHighlighted ? "true" : undefined,
    "data-sidebar-nest-target": nestTargetState ?? undefined,
    "data-sidebar-reorder-placement": reorderPlacement ?? undefined,
    ...dragBindings?.attributes,
    ...(dragBindings?.listeners ?? {}),
    onClick,
    onDoubleClick,
    onClickCapture,
    onPointerDown: onSplitDragPointerDown,
    onPointerEnter,
    onPointerLeave,
  };

  if (stickyLevel !== undefined) {
    return (
      <SidebarStickyTier
        ref={containerRef}
        tier="parent"
        level={stickyLevel}
        {...containerProps}
      >
        {children}
      </SidebarStickyTier>
    );
  }

  return (
    <div ref={containerRef} {...containerProps}>
      {children}
    </div>
  );
}

interface CollapsedThreadStatusGlyphProps {
  activity: CollapsedChildActivity;
  pluginStatus?: PluginSidebarThreadRowStatus | null;
}

export function CollapsedThreadStatusGlyph({
  activity,
  pluginStatus = null,
}: CollapsedThreadStatusGlyphProps) {
  const hasUnsubmittedDraft = useThreadsHaveDraft(activity.threadIds);

  const statusProps: ThreadListIndicatorState = {
    work: activity.work,
    hasUnsubmittedDraft,
  };

  const resolution = resolveThreadStatus(statusProps, pluginStatus);

  return (
    <>
      {resolution.indicatorKind === "input-welcome" &&
      hasThreadListWorkingActivity(statusProps) ? (
        <ThreadStatusGlyph indicator="runtime" />
      ) : null}
      <ThreadStatusGlyph
        indicator={resolution.indicatorKind}
        rowStatus={resolution.rowStatus}
      />
    </>
  );
}

function threadStatusTooltip(
  accessibleLabel: string | null,
  subagents: number,
): string | null {
  const helpers =
    subagents <= 0
      ? null
      : subagents === 1
        ? "1 subagent running"
        : `${subagents} subagents running`;

  if (accessibleLabel === null) return helpers;

  return helpers === null ? accessibleLabel : `${accessibleLabel} · ${helpers}`;
}

function ThreadTrailingIndicator({
  state,
  hideIdleDraftLabel,
  rowStatus,
  stopping,
  subagents,
  onActivate,
}: {
  state: ThreadListIndicatorState;
  hideIdleDraftLabel: boolean;
  rowStatus: PluginSidebarThreadRowStatus | null;
  stopping: boolean;
  subagents: number;
  onActivate: (modifiers: {
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  }) => void;
}) {
  const {
    indicatorKind,
    rowStatusIsVisible,
    rowStatus: resolvedRowStatus,
    accessibleLabel,
  } = resolveThreadStatus(state, rowStatus, stopping);

  if (indicatorKind === "none" && !rowStatusIsVisible) {
    return null;
  }

  const tooltip = threadStatusTooltip(accessibleLabel, subagents);

  const glyph = (
    <span
      data-sidebar-thread-trailing-indicator=""
      data-status-reason={accessibleLabel ?? undefined}
      className={cn(
        SIDEBAR_ROW_GLYPH_SLOT_CLASS,
        SIDEBAR_STATUS_GLYPH_BOX_CLASS,
        tooltip !== null && "pointer-events-auto relative z-[31]",
      )}
      onClick={
        tooltip === null
          ? undefined
          : (event) => {
              event.preventDefault();
              event.stopPropagation();
              onActivate({
                metaKey: event.metaKey,
                ctrlKey: event.ctrlKey,
                shiftKey: event.shiftKey,
                altKey: event.altKey,
              });
            }
      }
    >
      <ThreadStatusGlyph
        indicator={indicatorKind}
        rowStatus={resolvedRowStatus}
        hideIdleDraftLabel={hideIdleDraftLabel}
        experimental_subagents={subagents}
      />
    </span>
  );

  return (
    <>
      {indicatorKind === "input-welcome" &&
      hasThreadListWorkingActivity(state) ? (
        <ThreadStatusGlyph
          indicator="runtime"
          experimental_subagents={subagents}
        />
      ) : null}
      {tooltip === null ? (
        glyph
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>{glyph}</TooltipTrigger>
          <TooltipContent side="top" className="max-w-64">
            {tooltip}
          </TooltipContent>
        </Tooltip>
      )}
    </>
  );
}

const LIFECYCLE_ROW_ACTION_KEYS: Record<
  Exclude<SidebarThreadLifecycle, "active">,
  readonly string[]
> = {
  archived: ["omnyo--core/archive"],
  shelved: ["omnyo--core/shelve"],
};

const CUSTOMIZE_ROW_ACTIONS_KEY = "thread-list/customizeRowActions";

function renderThreadActionsTrigger(props: PluginThreadActionsTriggerProps) {
  return (
    <Button
      {...props}
      type="button"
      variant="ghost"
      size="icon"
      className={cn(
        props.className,
        "rounded-md p-0",
        "data-[state=open]:bg-state-active data-[state=open]:text-foreground",
        SIDEBAR_CONTROL_BUTTON_CLASS,
      )}
      aria-label="Thread actions"
      data-thread-actions-trigger=""
      onClick={(event) => {
        props.onClick?.(event);
        event.stopPropagation();
      }}
    >
      <Icon name="MoreHorizontal" className={COARSE_POINTER_ICON_SIZE_CLASS} />
    </Button>
  );
}

function ThreadRowComponent({
  thread,
  crossProjectId,
  isActive,
  onProjectSelect,
  options,
}: ThreadRowProps) {
  const [isDropdownActionsOpen, setIsDropdownActionsOpen] = useState(false);
  const [isContextActionsOpen, setIsContextActionsOpen] = useState(false);
  const sdk = useSdk();
  const openThreadInSplit = useOpenThreadInSplit();
  const prefetchThreadOpen = usePrefetchThreadOpen();
  const prefetchTimerRef = useRef<number | null>(null);
  const showProviderIcons = useAtomValue(sidebarShowProviderIconsAtom);
  const providers = useContext(SidebarProvidersContext);

  const provider = showProviderIcons
    ? providers.find((candidate) => candidate.id === thread.providerId)
    : undefined;

  const shortcut = useSidebarThreadShortcut(thread.id);
  const pluginThreadRowStatus = useSidebarThreadRowStatus(thread.id);
  const handoffLineage = useThreadHandoffLineage(thread.id);
  const unhoverHandoffLineage = handoffLineage.unhover;

  useEffect(() => unhoverHandoffLineage, [unhoverHandoffLineage]);

  const { hasUnsubmittedDraft: hasComposerDraft } = useSidebarThreadDraft(
    thread.id,
  );

  const showActive = isActive;
  const isSelected = useSidebarThreadSelected(thread.id);

  const threadStatus = threadListIndicatorStateForThread(
    thread,
    hasComposerDraft,
  );

  const labelTitle = thread.displayTitle;
  const crossProjectName = useSidebarProjectName(crossProjectId);

  const crossProjectLabel =
    crossProjectId === null
      ? null
      : crossProjectName
        ? `In project ${crossProjectName}`
        : "In another project";

  const handleRename = useCallback(
    async (nextTitle: string) => {
      await sdk.threads.update({ threadId: thread.id, title: nextTitle });
    },
    [sdk, thread.id],
  );

  const rename = useSidebarRename({
    kind: "thread",
    id: thread.id,
    name: labelTitle,
    label: "Thread name",
    onSave: handleRename,
  });

  const { editor, isEditing, startEditing, startEditingFromDoubleClick } =
    rename;

  const finishCustomizingActions = useThreadRowActionsCustomizing(thread.id);
  const isCustomizingActions = finishCustomizingActions !== null;

  const cancelThreadOpenPrefetch = useCallback(() => {
    if (prefetchTimerRef.current === null) return;
    window.clearTimeout(prefetchTimerRef.current);
    prefetchTimerRef.current = null;
  }, []);

  const scheduleThreadOpenPrefetch = useCallback(
    (pointerType?: string) => {
      cancelThreadOpenPrefetch();

      if (
        isEditing ||
        isCustomizingActions ||
        pointerType === "touch" ||
        pointerType === "pen"
      ) {
        return;
      }

      prefetchTimerRef.current = window.setTimeout(() => {
        prefetchTimerRef.current = null;

        if (!isEditing && !isCustomizingActions) {
          prefetchThreadOpen(thread.id);
        }
      }, 100);
    },
    [
      cancelThreadOpenPrefetch,
      isCustomizingActions,
      isEditing,
      prefetchThreadOpen,
      thread.id,
    ],
  );

  useEffect(
    () => () => {
      cancelThreadOpenPrefetch();
    },
    [cancelThreadOpenPrefetch],
  );
  useEffect(() => {
    if (isEditing || isCustomizingActions) cancelThreadOpenPrefetch();
  }, [cancelThreadOpenPrefetch, isCustomizingActions, isEditing]);

  const startTitleEditing = useCallback(
    (event: { preventDefault: () => void; stopPropagation: () => void }) => {
      event.preventDefault();
      event.stopPropagation();
      startEditingFromDoubleClick();
    },
    [startEditingFromDoubleClick],
  );

  const split = experimental_useSidebarThreadSplit(thread.id);
  const miniMap = split.layout?.panes ?? null;
  const isOpenInSplit = miniMap !== null;
  const onSplitDragPointerDown = split.splitProps.onPointerDown;

  const handleRowPointerDown = useCallback<PointerEventHandler<HTMLElement>>(
    (event) => {
      cancelThreadOpenPrefetch();
      onSplitDragPointerDown?.(event);
    },
    [cancelThreadOpenPrefetch, onSplitDragPointerDown],
  );

  const splitAvailable = split.isAvailable;

  const openInSplit = useCallback(() => {
    openThreadInSplit(thread.id);
  }, [openThreadInSplit, thread.id]);

  const rowActionKeys = useAtomValue(threadRowActionsAtom);
  const actionTarget = toThreadActionTarget(thread);
  const lifecycle = sidebarThreadLifecycle(thread);

  const quickActions = experimental_useThreadActions(actionTarget, {
    keys:
      lifecycle === "active"
        ? rowActionKeys
        : LIFECYCLE_ROW_ACTION_KEYS[lifecycle],
    requestRename: () => {
      startEditing();
    },
  });

  const customizeRowActions = useCustomizeThreadRowActions();
  const isCompactViewport = useIsCompactViewport();
  const pendingMenuCustomize = useRef<(() => void) | null>(null);

  const inlineMenuActions: PluginThreadActionsInlineItem[] =
    customizeRowActions === null
      ? []
      : [
          {
            key: CUSTOMIZE_ROW_ACTIONS_KEY,
            group: experimental_THREAD_ACTION_GROUPS.settings,
            action: {
              label: "Customize row actions",
              icon: "FilterHorizontal",
              run: () => {
                const begin = () => customizeRowActions(thread.id);

                if (isCompactViewport) begin();
                else pendingMenuCustomize.current = begin;
              },
            },
          },
        ];

  const requestRenameFromMenu = () => {
    rename.startEditingFromMenu();
  };

  const parentOptions = options.kind === "parent" ? options : null;
  const isParentRow = parentOptions !== null;
  const childCount = parentOptions?.childCount ?? 0;

  const childActivity =
    parentOptions?.childActivity ?? NO_COLLAPSED_CHILD_ACTIVITY;

  const hasChildren = childCount > 0;

  const reserveActionSpace =
    crossProjectLabel !== null || (isParentRow && hasChildren);

  const trailingIndicatorState: ThreadListIndicatorState = {
    work: hasChildren
      ? strongestThreadWorkSummary([
          threadStatus.work,
          ...childActivity.parentRowWork,
        ])
      : threadStatus.work,
    hasUnsubmittedDraft: threadStatus.hasUnsubmittedDraft,
  };

  const stopping = thread.status === "stopping";

  const trailingIndicatorResolution = resolveThreadStatus(
    trailingIndicatorState,
    pluginThreadRowStatus,
    stopping,
  );

  const trailingIndicatorKind = trailingIndicatorResolution.indicatorKind;

  const splitIndicatorIsWorking = hasThreadListWorkingActivity(threadStatus);

  const rowIsWorking = threadStatus.work?.primary.label === "working";

  const splitIndicatorLabel = trailingIndicatorResolution.accessibleLabel
    ? `${labelTitle} — open in split; ${trailingIndicatorResolution.accessibleLabel}`
    : `${labelTitle} — open in split`;

  const linkLabel = hasComposerDraft
    ? `Open ${labelTitle} (unsubmitted draft)`
    : `Open ${labelTitle}`;

  const subtitle =
    parentOptions?.stickyLevel === undefined && !rowIsWorking
      ? thread.experimental_subtitle
      : null;

  const subtitleId = useId();

  const rowDragBindings =
    isEditing || isCustomizingActions ? undefined : options.dragBindings;

  const nestTargetState = options.nestDrop?.state ?? null;
  const reorderPlacement = options.nestDrop?.reorderPlacement ?? null;

  const containerRef = useComposedRefs<HTMLDivElement>(
    rowDragBindings?.setActivatorNodeRef,
    options.nestDrop?.setNodeRef,
  );

  const isActionsOpen = isDropdownActionsOpen || isContextActionsOpen;

  const rowClassName = cn(
    SIDEBAR_HOVER_ACTIONS_ROW_CLASS,
    "group/thread-row cursor-pointer",
    rowIsWorking && "omnyo-sidebar-working-row opacity-70",
    SIDEBAR_ROW_BASE_CLASS,
    options.isChild && "text-xs",
    LIST_HOVER_TRANSITION,
    parentOptions?.stickyLevel === undefined && "relative",
    subtitle && "flex-wrap gap-y-0",
    subtitle
      ? options.isCompact
        ? "min-h-7 max-md:pointer-coarse:min-h-9"
        : "min-h-(--omnyo-sidebar-row-height) max-md:pointer-coarse:min-h-(--omnyo-sidebar-row-height-coarse)"
      : options.isCompact
        ? COARSE_POINTER_COMPACT_ROW_HEIGHT_CLASS
        : COARSE_POINTER_ROW_HEIGHT_CLASS,
    isSelected && "ring-1 ring-inset ring-sidebar-ring/60",
    showActive || isSelected
      ? SIDEBAR_ROW_SELECTED_STATE_CLASS
      : SIDEBAR_ROW_INTERACTIVE_STATE_CLASS,
    !showActive && isOpenInSplit && SIDEBAR_ROW_OPEN_IN_SPLIT_STATE_CLASS,
    !showActive && SIDEBAR_ROW_ACCENT_STATE_CLASS,
    rowDragBindings && !rowDragBindings.disabled && "select-none",
    !isActionsOpen && "data-[sidebar-touch-armed=true]:!bg-transparent",
    nestTargetState && NEST_TARGET_STATE_CLASS[nestTargetState],
    reorderPlacement && REORDER_PLACEMENT_CLASS[reorderPlacement],
    isCustomizingActions && "bg-sidebar-accent",
    handoffLineage.isHighlighted &&
      "opacity-100 shadow-[inset_3px_0_0_var(--timeline-accent)]",
  );

  const rowStyle = getThreadRowStyle(options.depth);

  const parentGuideLeft =
    options.depth > 0 ? getSidebarThreadGroupLineLeft(options.depth - 1) : null;

  const handleRowClickCapture = useCallback<ThreadRowClickCaptureHandler>(
    (event) => {
      if (!options.consumeClickSuppression?.()) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
    },
    [options],
  );

  const rowLinkRef = useRef<HTMLAnchorElement>(null);

  const activateRowLink = useCallback(
    (modifiers: {
      metaKey: boolean;
      ctrlKey: boolean;
      shiftKey: boolean;
      altKey: boolean;
    }) => {
      rowLinkRef.current?.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          ...modifiers,
        }),
      );
    },
    [],
  );

  useEffect(() => {
    if (isCustomizingActions) {
      focusFirstRowActionSlot(
        rowLinkRef.current?.closest("[data-sidebar-rename-row]"),
      );
    }
  }, [isCustomizingActions]);

  const handleRowClick = useCallback<MouseEventHandler<HTMLDivElement>>(
    (event) => {
      if (event.target !== event.currentTarget) {
        if (!(event.target instanceof Element)) return;

        if (!event.target.closest("[data-sidebar-thread-trailing]")) return;

        if (event.target.closest("a, button")) return;
      }

      rowLinkRef.current?.click();
    },
    [],
  );

  const handleRowDoubleClick = useCallback<MouseEventHandler<HTMLDivElement>>(
    (event) => {
      if (!(event.target instanceof Element)) return;
      const control = event.target.closest("a, button, input, [role=button]");

      if (control && control !== event.currentTarget) return;

      if (options.consumeClickSuppression?.()) return;

      startTitleEditing(event);
    },
    [options, startTitleEditing],
  );

  const handleActionsMenuCloseAutoFocus = (event: Event) => {
    const begin = pendingMenuCustomize.current;

    if (begin) {
      pendingMenuCustomize.current = null;
      event.preventDefault();
      begin();

      return;
    }

    rename.onCloseAutoFocus(event);
  };

  const rowContent = (
    <>
      {parentOptions?.stickyLevel !== undefined && parentGuideLeft !== null ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-0.5 top-0 z-[1] w-px bg-border-hairline opacity-70"
          style={{ left: parentGuideLeft }}
        />
      ) : null}
      <span
        className={cn(
          "relative flex min-w-0 flex-1 items-center gap-1.5 self-stretch",
          !isActionsOpen &&
            "group-data-[sidebar-touch-armed=true]/thread-row:hidden",
          !shortcut &&
            !isEditing &&
            !isCustomizingActions &&
            (reserveActionSpace
              ? "pr-(--omnyo-sidebar-hover-actions-inset) [@media(hover:none)]:pr-0"
              : SIDEBAR_HOVER_ACTIONS_INSET_CLASS),
        )}
        style={getHoverActionsInsetStyle(quickActions.length)}
      >
        <a
          ref={rowLinkRef}
          href={thread.href}
          draggable={false}
          data-sidebar-thread-shortcut-target=""
          data-sidebar-thread-id={thread.id}
          data-sidebar-rename-anchor=""
          onPointerEnter={(event) =>
            scheduleThreadOpenPrefetch(event.pointerType)
          }
          onPointerLeave={cancelThreadOpenPrefetch}
          onPointerDown={cancelThreadOpenPrefetch}
          onFocus={() => scheduleThreadOpenPrefetch()}
          onBlur={cancelThreadOpenPrefetch}
          onClick={(event) => {
            cancelThreadOpenPrefetch();

            if (isEditing) {
              event.preventDefault();
              event.stopPropagation();

              return;
            }

            if (splitAvailable && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              openInSplit();

              return;
            }

            if (consumeSidebarTitleDoubleClick(thread.id)) {
              startEditingFromDoubleClick();
              event.preventDefault();
              event.stopPropagation();

              return;
            }

            onProjectSelect?.();
          }}
          onDoubleClick={isEditing ? undefined : startTitleEditing}
          aria-label={isSelected ? `${linkLabel}, selected` : linkLabel}
          aria-describedby={subtitle ? subtitleId : undefined}
          aria-keyshortcuts={shortcut?.ariaKeyshortcuts}
          className="absolute inset-0 rounded-md outline-none"
        />
        {lifecycle === "active" && !shortcut && !miniMap ? (
          <ThreadTrailingIndicator
            state={trailingIndicatorState}
            hideIdleDraftLabel={trailingIndicatorKind === "draft"}
            rowStatus={pluginThreadRowStatus}
            stopping={stopping}
            onActivate={activateRowLink}
            subagents={
              (thread.activity.experimental_subagents ?? 0) +
              childActivity.summaries.filter((work) =>
                hasThreadListWorkingActivity({
                  work,
                  hasUnsubmittedDraft: false,
                }),
              ).length
            }
          />
        ) : null}
        <span
          className={cn(
            "pointer-events-none relative flex min-w-0 items-center self-stretch",
            ((crossProjectLabel === null && (!parentOptions || !hasChildren)) ||
              isEditing) &&
              "flex-1",
          )}
        >
          {provider ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  data-sidebar-thread-provider={provider.id}
                  role="img"
                  aria-label={provider.displayName}
                  className="pointer-events-auto relative z-[31] flex size-4 shrink-0 items-center justify-center mr-1.5 text-muted-foreground"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    rowLinkRef.current?.click();
                  }}
                >
                  <ProviderIcon
                    providerKind="agent"
                    provider={provider}
                    className="size-4"
                  />
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">{provider.displayName}</TooltipContent>
            </Tooltip>
          ) : null}
          {isEditing ? (
            <span className="pointer-events-auto relative z-10 min-w-0 flex-1 overflow-visible">
              {editor}
            </span>
          ) : (
            <span
              className={cn(
                "omnyo-thread-title",
                crossProjectLabel !== null && "min-w-0 truncate",
                hasChildren && "font-medium",
                lifecycle !== "shelved" && thread.isUnread && "font-semibold",
              )}
              title={labelTitle}
              onDoubleClick={startTitleEditing}
            >
              <ThreadTitle threadId={thread.id} />
            </span>
          )}
          {handoffLineage.isLinked && !isEditing ? (
            <span
              data-sidebar-thread-handoff=""
              className="ml-1 flex shrink-0 text-subtle-foreground"
            >
              <Icon name="ArrowTurnForward" className="size-3" aria-hidden />
            </span>
          ) : null}
        </span>
        {thread.isUnread ? (
          <span
            data-sidebar-thread-unread=""
            role="img"
            aria-label="Unread"
            className="pointer-events-none size-1.5 shrink-0 rounded-full bg-attention"
          />
        ) : null}
        {crossProjectLabel !== null ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                data-sidebar-thread-cross-project=""
                role="img"
                aria-label={crossProjectLabel}
                className="relative z-[31] flex size-5 shrink-0 items-center justify-center text-muted-foreground"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  rowLinkRef.current?.click();
                }}
              >
                <Icon name="FolderExport" className="size-3.5" aria-hidden />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">{crossProjectLabel}</TooltipContent>
          </Tooltip>
        ) : null}
      </span>
      {rowDragBindings && !rowDragBindings.disabled && !isActionsOpen ? (
        <SidebarThreadDragChip
          title={labelTitle}
          visualOnly
          className="hidden group-data-[sidebar-touch-armed=true]/thread-row:flex"
        />
      ) : null}
      <span
        data-sidebar-thread-trailing=""
        className={cn(
          "flex shrink-0 items-center gap-0.5",
          !isActionsOpen &&
            "group-data-[sidebar-touch-armed=true]/thread-row:hidden",
          (isEditing || isCustomizingActions) && "hidden",
        )}
      >
        {lifecycle !== "active" ? (
          <>
            <span
              className="relative z-10 pointer-events-auto [@media(hover:none)]:hidden"
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <ThreadRowQuickActions
                entries={quickActions}
                className={SIDEBAR_CONTROL_BUTTON_CLASS}
              />
            </span>
            <span
              data-sidebar-thread-morph=""
              className="relative flex min-w-13 items-center justify-end h-7 max-md:pointer-coarse:h-9"
            >
              <span
                data-sidebar-hover-actions-open={
                  isActionsOpen ? "true" : undefined
                }
                className={cn(
                  SIDEBAR_HOVER_ACTIONS_FADE_CLASS,
                  "omnyo-thread-row-time-rest",
                )}
              >
                <ThreadRowAge createdAt={thread.createdAt} />
              </span>
              <div
                data-sidebar-hover-actions-open={
                  isActionsOpen ? "true" : undefined
                }
                className={cn(
                  SIDEBAR_HOVER_ACTIONS_CLASS,
                  "omnyo-thread-row-time-actions absolute inset-y-0 right-0 z-10 flex items-center [@media(hover:none)]:hidden",
                )}
              >
                <ThreadActionsMenu
                  thread={actionTarget}
                  trigger={renderThreadActionsTrigger}
                  inline={inlineMenuActions}
                  requestRename={requestRenameFromMenu}
                  side="right"
                  align="start"
                  sideOffset={8}
                  onOpenChange={setIsDropdownActionsOpen}
                  onCloseAutoFocus={handleActionsMenuCloseAutoFocus}
                />
              </div>
            </span>
          </>
        ) : shortcut ? (
          <>
            <AppCommandShortcutPill shortcut={shortcut} />
            <ThreadRowAge createdAt={thread.createdAt} />
          </>
        ) : (
          <span
            data-sidebar-thread-morph=""
            className={cn(
              "relative flex min-w-8 shrink-0 items-center justify-end [@media(hover:none)]:pointer-events-none",
              COARSE_POINTER_COMPACT_ROW_HEIGHT_CLASS,
            )}
          >
            <span
              data-sidebar-hover-actions-open={
                isActionsOpen ? "true" : undefined
              }
              className={cn(
                SIDEBAR_HOVER_ACTIONS_FADE_CLASS,
                "omnyo-thread-row-time-rest flex items-center gap-1.5",
              )}
            >
              {miniMap ? (
                <span
                  className={cn(
                    "flex shrink-0 items-center justify-center",
                    SIDEBAR_STATUS_GLYPH_BOX_CLASS,
                  )}
                >
                  <span
                    data-sidebar-thread-trailing-indicator=""
                    className={cn(
                      SIDEBAR_ROW_GLYPH_SLOT_CLASS,
                      SIDEBAR_STATUS_GLYPH_BOX_CLASS,
                    )}
                  >
                    <SplitPaneMiniMap
                      slots={miniMap}
                      label={splitIndicatorLabel}
                      isWorking={splitIndicatorIsWorking}
                    />
                  </span>
                </span>
              ) : null}
              <ThreadRowAge createdAt={thread.createdAt} />
            </span>
            <div
              data-sidebar-hover-actions-open={
                isActionsOpen ? "true" : undefined
              }
              className={cn(
                SIDEBAR_HOVER_ACTIONS_CLASS,
                "omnyo-thread-row-time-actions absolute inset-y-0 right-0 z-10 flex items-center justify-end [@media(hover:none)]:hidden",
                isEditing && "invisible pointer-events-none",
              )}
            >
              <SidebarRowControls
                primaryAction={
                  <ThreadRowQuickActions
                    entries={quickActions}
                    className={SIDEBAR_CONTROL_BUTTON_CLASS}
                    onMenuOpenChange={setIsDropdownActionsOpen}
                  />
                }
              >
                <ThreadActionsMenu
                  thread={actionTarget}
                  trigger={renderThreadActionsTrigger}
                  inline={inlineMenuActions}
                  requestRename={requestRenameFromMenu}
                  side="right"
                  align="start"
                  sideOffset={8}
                  onOpenChange={setIsDropdownActionsOpen}
                  onCloseAutoFocus={handleActionsMenuCloseAutoFocus}
                />
              </SidebarRowControls>
            </div>
          </span>
        )}
      </span>
      {subtitle ? (
        <span
          id={subtitleId}
          data-sidebar-thread-subtitle=""
          className={cn(
            "pointer-events-none order-last line-clamp-2 basis-full break-words pr-2 pb-1 text-xs leading-4 text-muted-foreground",
            !isActionsOpen &&
              "group-data-[sidebar-touch-armed=true]/thread-row:hidden",
          )}
        >
          {subtitle}
        </span>
      ) : null}
      {finishCustomizingActions ? (
        <ThreadRowActionsEditor onDone={finishCustomizingActions} />
      ) : null}
    </>
  );

  const row = renderThreadRowContainer({
    children: rowContent,
    className: rowClassName,
    selectable: !isEditing && !isCustomizingActions,
    containerRef,
    dragBindings: rowDragBindings,
    handoffHighlighted: handoffLineage.isHighlighted,
    nestTargetState,
    reorderPlacement,
    onClick: isEditing ? undefined : handleRowClick,
    onPointerEnter: handoffLineage.isLinked
      ? (event) => {
          if (event.pointerType !== "touch") handoffLineage.hover();
        }
      : undefined,
    onPointerLeave: handoffLineage.isLinked
      ? handoffLineage.unhover
      : undefined,
    onDoubleClick:
      isEditing || isCustomizingActions ? undefined : handleRowDoubleClick,
    onClickCapture:
      !isEditing && options.consumeClickSuppression
        ? handleRowClickCapture
        : undefined,
    onSplitDragPointerDown: isEditing ? undefined : handleRowPointerDown,
    stickyLevel: parentOptions?.stickyLevel,
    style: rowStyle,
  });

  return (
    <ThreadActionsContextMenu
      thread={actionTarget}
      inline={inlineMenuActions}
      requestRename={requestRenameFromMenu}
      onOpenChange={setIsContextActionsOpen}
      onCloseAutoFocus={handleActionsMenuCloseAutoFocus}
      disabled={isEditing}
      dragging={rowDragBindings?.isDragging ?? false}
    >
      {row}
    </ThreadActionsContextMenu>
  );
}

function sameItems<T>(left: readonly T[], right: readonly T[]): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => item === right[index])
  );
}

function sameChildActivity(
  left: CollapsedChildActivity,
  right: CollapsedChildActivity,
): boolean {
  return (
    left === right ||
    (left.work === right.work &&
      left.unread === right.unread &&
      left.unreadError === right.unreadError &&
      sameItems(left.threadIds, right.threadIds) &&
      sameItems(left.summaries, right.summaries) &&
      sameItems(left.parentRowWork, right.parentRowWork))
  );
}

function sameRowOptions(
  left: ThreadRowOptions,
  right: ThreadRowOptions,
): boolean {
  if (left === right) return true;

  if (
    left.depth !== right.depth ||
    left.isChild !== right.isChild ||
    left.isCompact !== right.isCompact ||
    left.consumeClickSuppression !== right.consumeClickSuppression ||
    left.dragBindings !== right.dragBindings ||
    left.nestDrop !== right.nestDrop
  )
    return false;

  if (left.kind === "default" || right.kind === "default")
    return left.kind === right.kind;

  return (
    left.childCount === right.childCount &&
    left.stickyLevel === right.stickyLevel &&
    sameChildActivity(left.childActivity, right.childActivity)
  );
}

export function areThreadRowPropsEqual(
  previous: ThreadRowProps,
  next: ThreadRowProps,
): boolean {
  return (
    previous.thread === next.thread &&
    previous.crossProjectId === next.crossProjectId &&
    previous.isActive === next.isActive &&
    previous.onProjectSelect === next.onProjectSelect &&
    sameRowOptions(previous.options, next.options)
  );
}

export const ThreadRow = memo(ThreadRowComponent, areThreadRowPropsEqual);
