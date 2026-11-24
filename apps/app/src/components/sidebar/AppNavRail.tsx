import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react";
import { RAIL_JUMP_APP_COMMAND_IDS } from "@omnyo/domain";
import { DndContext, type DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "@omnyo/shared-ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@omnyo/shared-ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@omnyo/shared-ui/dropdown-menu";
import { Icon } from "@omnyo/shared-ui/icon";
import { useIsCompactViewport } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@omnyo/shared-ui/popover";
import { useSidebarSortable } from "@omnyo/shared-ui/sortable-motion";
import { useSidebarReorderDnd } from "@omnyo/shared-ui/use-sidebar-reorder-dnd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@omnyo/shared-ui/tooltip";
import {
  useCloseMobileSidebar,
  useIsSidebarFramed,
  useSidebar,
} from "@/components/ui/sidebar.js";
import { useNeedsYouRoute } from "@/components/plugin/PluginSidebarEntry";
import { usePluginFrontendsSettled } from "@/lib/plugin-frontend-boot-state";
import { useRouteState } from "@/hooks/useRouteState";
import { AppCommandShortcutPill } from "@/components/commands/AppCommandShortcutHint";
import {
  useAppCommandShortcut,
  useIndexedAppCommandHandlers,
} from "@/components/commands/AppCommandProvider";
import {
  CHROME_ROW_HEIGHT_CLASS,
  getOmnyoDesktopInfo,
  MACOS_CHROME_CONTROL_AXIS_CLASS,
  MACOS_WINDOW_DRAG_CLASS,
  shouldUseMacosDesktopChrome,
} from "@/lib/omnyo-desktop";
import {
  getPluginPanelRoutePluginId,
  getRootComposeRoutePath,
} from "@/lib/route-paths";
import { useProjectSidebarItems } from "@/lib/plugin-project-sidebar-items";
import { NAV_RAIL_WIDTH_CLASS } from "./navRailWidth";
import { InboxRailTile, ProjectRailTiles } from "./ProjectRail";
import { useProjectRailCatalog } from "./project-rail-catalog";
import {
  SIDEBAR_SCOPE_KEEPING_NAVIGATION_STATE,
  useLocationProject,
  useSetSidebarScope,
  useSidebarScope,
  type SidebarScope,
} from "./sidebarScope";
import { SidebarNavigationCustomize } from "./SidebarNavigationCustomize";
import {
  SidebarNavigationIcon,
  useSidebarNavigation,
  useSidebarNavigationModel,
  useSidebarNavigationSplit,
} from "./SidebarNavigationModel";
import { SidebarTouchSensor } from "./sidebarTouchSensor";
import {
  NEW_THREAD_NAVIGATION_ITEM_ID,
  CANVAS_NAVIGATION_ITEM_ID,
  isCustomizableSidebarNavigationItem,
  sidebarNavigationItemCommandProps,
  type SidebarNavigationItem,
} from "./sidebarNavigationItems";
import { appCommandTarget } from "@/lib/app-command-targets";
import {
  RAIL_SEPARATOR_CLASS,
  railFadeMaskStyle,
  useRailScrollFades,
} from "./useRailOverflow";
import { PROJECT_LIST_ACTION_BUTTON_CLASS } from "@omnyo/shared-ui/sidebar-row-classes";
import { getSettingsRouteIntent } from "@/views/settings-view-split";

export interface NavRailCustomizeState {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
}

const RAIL_ICON_CLASS = "size-(--omnyo-sidebar-control-icon-size)";

const RAIL_SCROLL_CLASS =
  "min-h-0 w-full overflow-y-auto overscroll-y-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

const RAIL_MENU_SIDE_OFFSET = 12;

const RAIL_BUTTON_CLASS = cn(
  "size-(--omnyo-sidebar-control-size) shrink-0 rounded-[10px] p-0 text-muted-foreground ring-sidebar-ring",
  "hover:bg-state-hover hover:text-sidebar-foreground focus-visible:ring-2",
  "aria-[current=page]:bg-state-active aria-[current=page]:text-sidebar-foreground",
  "data-[state=open]:bg-state-active data-[state=open]:text-sidebar-foreground",
  "[&_[data-icon-root]]:size-(--omnyo-sidebar-control-icon-size)",
);

interface RailButtonProps extends Omit<
  ComponentProps<typeof Button>,
  "aria-label" | "aria-current"
> {
  label: string;
  active?: boolean;
  children: ReactNode;
}

const RailButton = forwardRef<HTMLButtonElement, RailButtonProps>(
  ({ label, active = false, className, children, ...props }, ref) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          ref={ref}
          type="button"
          variant="ghost"
          size="icon"
          aria-label={label}
          aria-current={active ? "page" : undefined}
          className={cn(RAIL_BUTTON_CLASS, className)}
          {...props}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  ),
);

RailButton.displayName = "RailButton";

interface RailItemProps {
  item: SidebarNavigationItem;
  onCustomize: () => void;
  onMenuCloseAutoFocus: (event: Event) => void;
  unread?: boolean;
}

function RailItem({
  item,
  onCustomize,
  onMenuCloseAutoFocus,
  unread = false,
}: RailItemProps) {
  const { activeItemId, actions } = useSidebarNavigation();
  const split = useSidebarNavigationSplit(item.id);
  const [disablePending, setDisablePending] = useState(false);
  const isPluginItem = item.pluginId !== null;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <span className="flex" data-nav-rail-item={item.id}>
          <RailButton
            label={
              item.shortcut
                ? `${item.label} (${item.shortcut.label})`
                : unread
                  ? `${item.label}, unseen changes`
                  : item.label
            }
            active={item.id === activeItemId}
            disabled={item.isDisabled}
            aria-busy={item.isLoading || undefined}
            aria-keyshortcuts={item.shortcut?.ariaKeyShortcuts}
            {...sidebarNavigationItemCommandProps(item)}
            className={cn(item.isLoading && "opacity-60", unread && "relative")}
            {...split.splitProps}
            onClick={(event) =>
              actions.activate(item.id, {
                openInSplit: event.metaKey || event.ctrlKey,
              })
            }
          >
            <SidebarNavigationIcon
              icon={item.icon}
              className={RAIL_ICON_CLASS}
            />
            {unread ? (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute top-0.75 right-0.75 size-1.5 rounded-full bg-success"
              />
            ) : null}
          </RailButton>
        </span>
      </ContextMenuTrigger>
      <ContextMenuContent
        aria-label={
          isPluginItem ? `${item.label} panel options` : `${item.label} options`
        }
        onCloseAutoFocus={onMenuCloseAutoFocus}
      >
        {isPluginItem ? (
          <>
            {split.isAvailable ? (
              <ContextMenuItem
                onSelect={() =>
                  actions.activate(item.id, { openInSplit: true })
                }
              >
                <Icon name="Columns2" aria-hidden="true" />
                Open in split
              </ContextMenuItem>
            ) : null}
            <ContextMenuItem onSelect={() => actions.openDetails(item.id)}>
              <Icon name="Info" aria-hidden="true" />
              View details
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        ) : null}
        {isCustomizableSidebarNavigationItem(item) ? (
          <ContextMenuItem onSelect={() => actions.setVisible(item.id, false)}>
            <Icon name="EyeOff" aria-hidden="true" />
            Hide from rail
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem onSelect={onCustomize}>
          <Icon name="SlidersHorizontal" aria-hidden="true" />
          Customize rail
        </ContextMenuItem>
        {isPluginItem ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              disabled={disablePending}
              onSelect={() => {
                setDisablePending(true);
                actions
                  .disablePlugin(item.id)
                  .catch(() => {})
                  .finally(() => setDisablePending(false));
              }}
            >
              <Icon name="Unavailable" aria-hidden="true" />
              Disable
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function CanvasRailItem(props: RailItemProps) {
  const unread = useProjectSidebarItems().some(
    (group) =>
      group.key?.startsWith(`${CANVAS_NAVIGATION_ITEM_ID}/`) &&
      group.items.some((item) => item.unread),
  );

  return <RailItem {...props} unread={unread} />;
}

const RAIL_WIGGLE_PHASES_MS = [0, -90, -40, -130] as const;

const RAIL_REORDER_KEY_SHORTCUTS = "Alt+ArrowUp Alt+ArrowDown";

function ArrangeableRailItem({
  item,
  index,
  onMove,
}: {
  item: SidebarNavigationItem;
  index: number;
  onMove: (direction: -1 | 1) => void;
}) {
  const { dragBindings, setNodeRef, style } = useSidebarSortable({
    id: item.id,
    disabled: false,
  });

  const pointerListeners = Object.fromEntries(
    Object.entries(dragBindings.listeners ?? {}).filter(
      ([name]) => name !== "onKeyDown",
    ),
  );

  return (
    <span
      ref={setNodeRef}
      style={style}
      className="flex"
      data-nav-rail-item={item.id}
      data-nav-rail-arranging="true"
    >
      <Button
        ref={dragBindings.setActivatorNodeRef}
        type="button"
        variant="ghost"
        size="icon"
        {...pointerListeners}
        aria-label={item.label}
        aria-keyshortcuts={RAIL_REORDER_KEY_SHORTCUTS}
        onKeyDown={(event) => {
          if (!event.altKey) return;

          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            onMove(event.key === "ArrowUp" ? -1 : 1);
          }
        }}
        data-dragging={dragBindings.isDragging || undefined}
        className={cn(
          RAIL_BUTTON_CLASS,
          "omnyo-rail-wiggle cursor-grab touch-none text-sidebar-foreground active:cursor-grabbing data-dragging:bg-state-active",
        )}
        style={{
          animationDelay: `${RAIL_WIGGLE_PHASES_MS[index % RAIL_WIGGLE_PHASES_MS.length]}ms`,
        }}
      >
        <SidebarNavigationIcon icon={item.icon} className={RAIL_ICON_CLASS} />
      </Button>
    </span>
  );
}

function ArrangeableRailItems({
  items,
}: {
  items: readonly SidebarNavigationItem[];
}) {
  const { arrangement } = useSidebarNavigationModel();
  const railOrder = [...items].reverse();

  const { dndContextProps } = useSidebarReorderDnd({
    onDragEnd: (event: DragEndEvent) => {
      if (
        typeof event.active.id !== "string" ||
        typeof event.over?.id !== "string"
      )
        return;
      arrangement.moveAny(event.active.id, event.over.id);
    },
    touchSensor: SidebarTouchSensor,
  });

  return (
    <DndContext {...dndContextProps}>
      <SortableContext
        items={railOrder.map((item) => item.id)}
        strategy={verticalListSortingStrategy}
      >
        {railOrder.map((item, index) => (
          <ArrangeableRailItem
            key={item.id}
            item={item}
            index={index}
            onMove={(direction) => {
              const neighbor = railOrder[index + direction];

              if (neighbor) arrangement.moveAny(item.id, neighbor.id);
            }}
          />
        ))}
      </SortableContext>
    </DndContext>
  );
}

function RailMoreMenu({
  buttonRef,
  hidden,
  onCustomize,
  onMenuCloseAutoFocus,
}: {
  buttonRef: RefObject<HTMLButtonElement | null>;
  hidden: readonly SidebarNavigationItem[];
  onCustomize: () => void;
  onMenuCloseAutoFocus: (event: Event) => void;
}) {
  const { actions } = useSidebarNavigation();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <RailButton ref={buttonRef} label="More">
          <Icon name="MoreHorizontal" aria-hidden="true" />
        </RailButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="right"
        align="start"
        sideOffset={RAIL_MENU_SIDE_OFFSET}
        data-testid="nav-rail-more-menu"
        onCloseAutoFocus={onMenuCloseAutoFocus}
      >
        {hidden.map((item) => (
          <DropdownMenuItem
            key={item.id}
            disabled={item.isDisabled || item.isLoading}
            onSelect={() => actions.activate(item.id, { openInSplit: false })}
            {...sidebarNavigationItemCommandProps(item)}
          >
            <SidebarNavigationIcon icon={item.icon} />
            {item.label}
          </DropdownMenuItem>
        ))}
        {hidden.length > 0 ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem onSelect={onCustomize}>
          <Icon name="SlidersHorizontal" aria-hidden="true" />
          Customize rail
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppNavRail({
  isAppMode,
  customize,
}: {
  isAppMode: boolean;
  customize: NavRailCustomizeState;
}) {
  const { items, activeItemId } = useSidebarNavigation();
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const customizeAfterMenuCloseRef = useRef(false);
  const projectScrollRef = useRef<HTMLDivElement>(null);
  const projectListRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const destinationsRef = useRef<HTMLDivElement>(null);
  const destinationScrollRef = useRef<HTMLDivElement>(null);
  const destinationListRef = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const { isThreadView } = useRouteState();
  const needsYouRoute = useNeedsYouRoute();
  const pluginFrontendsSettled = usePluginFrontendsSettled();

  const [pendingInbox, setPendingInbox] = useState<{
    locationKey: string;
    fallbackPath: string;
  } | null>(null);

  const closeOnMobile = useCloseMobileSidebar();
  const [desktopInfo] = useState(getOmnyoDesktopInfo);
  const isFramed = useIsSidebarFramed();
  const isCompactViewport = useIsCompactViewport();

  const { open: isSidebarOpen, setOpen: setSidebarOpen } = useSidebar();

  const catalog = useProjectRailCatalog();
  const sidebarScope = useSidebarScope();
  const setSidebarScope = useSetSidebarScope();
  const locationProject = useLocationProject();
  const projectFades = useRailScrollFades(projectScrollRef, projectListRef);

  const destinationFades = useRailScrollFades(
    destinationScrollRef,
    destinationListRef,
  );

  const isHomeActive =
    isAppMode &&
    getPluginPanelRoutePluginId(location.pathname) === null &&
    (activeItemId === null || activeItemId === NEW_THREAD_NAVIGATION_ITEM_ID);

  const currentRoutePath = `${location.pathname}${location.search}${location.hash}`;

  const home = useRef({
    path: isHomeActive ? currentRoutePath : getRootComposeRoutePath(),
    isThread: isHomeActive && isThreadView,
  });

  useEffect(() => {
    if (isHomeActive)
      home.current = { path: currentRoutePath, isThread: isThreadView };
  }, [currentRoutePath, isHomeActive, isThreadView]);

  const canvas = items.find((item) => item.id === CANVAS_NAVIGATION_ITEM_ID);
  const destinations = items.filter(isCustomizableSidebarNavigationItem);

  const visible = destinations.filter((item) => item.isVisible);
  const hidden = destinations.filter((item) => !item.isVisible);

  const isArranging = customize.isOpen && !isCompactViewport;

  const reservesChromeRow =
    !isFramed && shouldUseMacosDesktopChrome(desktopInfo);

  const isThreadListShowing = isCompactViewport || isSidebarOpen;

  useEffect(() => {
    if (pendingInbox === null) return;

    if (
      pendingInbox.locationKey !== location.key ||
      sidebarScope.kind !== "inbox"
    ) {
      setPendingInbox(null);

      return;
    }

    if (needsYouRoute === null && !pluginFrontendsSettled) return;

    setPendingInbox(null);
    const path = needsYouRoute ?? pendingInbox.fallbackPath;

    if (path === currentRoutePath) return;

    if (needsYouRoute !== null) closeOnMobile();
    void navigate(path, { state: SIDEBAR_SCOPE_KEEPING_NAVIGATION_STATE });
  }, [
    closeOnMobile,
    currentRoutePath,
    location.key,
    navigate,
    needsYouRoute,
    pendingInbox,
    pluginFrontendsSettled,
    sidebarScope.kind,
  ]);

  const selectScope = (scope: SidebarScope) => {
    setPendingInbox(null);
    setSidebarScope(scope);

    if (!isThreadListShowing) setSidebarOpen(true);

    const previous = isHomeActive
      ? { path: currentRoutePath, isThread: isThreadView }
      : home.current;

    if (
      scope.kind === "inbox" &&
      !previous.isThread &&
      needsYouRoute === null &&
      !pluginFrontendsSettled
    ) {
      setPendingInbox({
        locationKey: location.key,
        fallbackPath: previous.path,
      });

      return;
    }

    const openNeedsYou =
      scope.kind === "inbox" && !previous.isThread && needsYouRoute !== null;

    const path = openNeedsYou ? needsYouRoute : previous.path;

    if (path === currentRoutePath) return;

    if (openNeedsYou) closeOnMobile();
    void navigate(path, { state: SIDEBAR_SCOPE_KEEPING_NAVIGATION_STATE });
  };

  useIndexedAppCommandHandlers(RAIL_JUMP_APP_COMMAND_IDS, (index) => {
    const target = railRef.current?.querySelectorAll<HTMLButtonElement>(
      "button[data-rail-scope-target]",
    )[index];

    if (!target || target.disabled) return false;
    target.click();
    target.scrollIntoView?.({ block: "nearest" });

    return true;
  });

  const requestCustomize = () => {
    customizeAfterMenuCloseRef.current = true;
  };

  const handleMenuCloseAutoFocus = (event: Event) => {
    if (!customizeAfterMenuCloseRef.current) return;
    customizeAfterMenuCloseRef.current = false;
    event.preventDefault();
    customize.onOpenChange(true);
  };

  return (
    <div
      ref={railRef}
      data-testid="app-nav-rail"
      className={cn(
        "relative z-10 flex min-h-0 flex-1 flex-col",
        NAV_RAIL_WIDTH_CLASS,
        "[--omnyo-rail-surface:var(--canvas)]",
        !isFramed &&
          "-mt-[env(safe-area-inset-top)] pt-[env(safe-area-inset-top)] shadow-[inset_-0.5px_0_0_var(--material-line)] group-data-[collapsible=rail]:shadow-none",
      )}
    >
      {reservesChromeRow ? (
        <div
          aria-hidden="true"
          className={cn(
            CHROME_ROW_HEIGHT_CLASS,
            "shrink-0",
            MACOS_WINDOW_DRAG_CLASS,
          )}
        />
      ) : null}
      <nav
        aria-label="Primary navigation"
        className={cn(
          "flex min-h-0 flex-1 flex-col items-center pb-2 md:pb-1.75",
          !reservesChromeRow && !isFramed && "pt-2",
        )}
      >
        <Popover open={customize.isOpen} onOpenChange={customize.onOpenChange}>
          <div
            className={cn(
              "flex shrink-0 flex-col items-center gap-1 pb-1.5",
              isFramed ? "-mt-0.75" : "pt-1",
            )}
          >
            <InboxRailTile
              counts={catalog.inbox}
              attentionRoots={catalog.attentionRoots}
              triage={catalog.triage}
              scope={sidebarScope}
              onSelectScope={selectScope}
            />
            {canvas ? (
              <CanvasRailItem
                item={canvas}
                onCustomize={requestCustomize}
                onMenuCloseAutoFocus={handleMenuCloseAutoFocus}
              />
            ) : null}
          </div>
          {projectFades.overflows ? (
            <div aria-hidden="true" className={RAIL_SEPARATOR_CLASS} />
          ) : null}
          <div
            ref={projectScrollRef}
            data-testid="nav-rail-projects"
            data-overflowing={projectFades.overflows || undefined}
            data-fade-top={projectFades.fadeTop || undefined}
            data-fade-bottom={projectFades.fadeBottom || undefined}
            className={cn(RAIL_SCROLL_CLASS, "max-h-max flex-1")}
            style={railFadeMaskStyle(projectFades)}
          >
            <ProjectRailTiles
              ref={projectListRef}
              entries={catalog.entries}
              scope={sidebarScope}
              currentProjectId={locationProject?.projectId ?? null}
              onSelectScope={selectScope}
            />
          </div>
          {projectFades.overflows ? (
            <div
              aria-hidden="true"
              data-testid="nav-rail-separator"
              className={RAIL_SEPARATOR_CLASS}
            />
          ) : null}
          <PopoverAnchor asChild>
            <div
              ref={destinationsRef}
              data-testid="nav-rail-destinations"
              data-arranging={isArranging || undefined}
              className="mt-auto flex max-h-max min-h-[calc(var(--omnyo-sidebar-control-size)+1.5*var(--spacing))] w-full flex-1 flex-col items-center pt-1.5"
            >
              <RailMoreMenu
                buttonRef={moreButtonRef}
                hidden={hidden}
                onCustomize={
                  isCompactViewport
                    ? () => customize.onOpenChange(true)
                    : requestCustomize
                }
                onMenuCloseAutoFocus={handleMenuCloseAutoFocus}
              />
              <div
                ref={destinationScrollRef}
                data-testid="nav-rail-destination-scroll"
                data-overflowing={destinationFades.overflows || undefined}
                data-fade-top={destinationFades.fadeTop || undefined}
                data-fade-bottom={destinationFades.fadeBottom || undefined}
                className={RAIL_SCROLL_CLASS}
                style={railFadeMaskStyle(destinationFades)}
              >
                <div
                  ref={destinationListRef}
                  className="flex flex-col items-center gap-2 not-empty:pt-2"
                >
                  {isArranging ? (
                    <ArrangeableRailItems items={visible} />
                  ) : (
                    [...visible]
                      .reverse()
                      .map((item) => (
                        <RailItem
                          key={item.id}
                          item={item}
                          onCustomize={requestCustomize}
                          onMenuCloseAutoFocus={handleMenuCloseAutoFocus}
                        />
                      ))
                  )}
                </div>
              </div>
            </div>
          </PopoverAnchor>
          <PopoverContent
            side="right"
            align="end"
            sideOffset={RAIL_MENU_SIDE_OFFSET}
            aria-label="Customize rail"
            mobileTitle="Customize rail"
            data-testid="nav-rail-customize"
            className="flex max-h-(--radix-popover-content-available-height) flex-col p-1.5 md:w-60"
            onInteractOutside={(event) => {
              if (
                event.target instanceof Node &&
                destinationsRef.current?.contains(event.target)
              )
                event.preventDefault();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              moreButtonRef.current?.focus();
            }}
          >
            <SidebarNavigationCustomize
              reorderInList={isCompactViewport}
              onClose={() => customize.onOpenChange(false)}
            />
          </PopoverContent>
        </Popover>
      </nav>
    </div>
  );
}

export function NavRailSettingsButton({
  isSettingsActive,
  settingsToggleRoutePath,
}: {
  isSettingsActive: boolean;
  settingsToggleRoutePath: string;
}) {
  const navigate = useNavigate();
  const settingsShortcut = useAppCommandShortcut("settings.open");

  return (
    <RailButton
      label={
        settingsShortcut ? `Settings (${settingsShortcut.label})` : "Settings"
      }
      active={isSettingsActive}
      aria-pressed={isSettingsActive}
      className="h-8 max-md:pointer-coarse:h-9"
      {...appCommandTarget("settings.open")}
      aria-keyshortcuts={settingsShortcut?.ariaKeyshortcuts}
      {...getSettingsRouteIntent(settingsToggleRoutePath)}
      onClick={() => void navigate(settingsToggleRoutePath)}
    >
      <Icon name="Settings" aria-hidden="true" />
    </RailButton>
  );
}

export function NavRailNewThreadButton() {
  const { items, actions, isShortcutModifierHeld } = useSidebarNavigation();
  const split = useSidebarNavigationSplit(NEW_THREAD_NAVIGATION_ITEM_ID);
  const [desktopInfo] = useState(getOmnyoDesktopInfo);

  const item = items.find(
    (candidate) => candidate.action.kind === "new-thread",
  );

  if (item === undefined) return null;
  const shortcut = isShortcutModifierHeld ? item.shortcut : null;

  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className={cn(
        PROJECT_LIST_ACTION_BUTTON_CLASS,
        "w-auto flex-1",
        shouldUseMacosDesktopChrome(desktopInfo) &&
          MACOS_CHROME_CONTROL_AXIS_CLASS,
      )}
      disabled={item.isDisabled}
      {...appCommandTarget("thread.new")}
      aria-keyshortcuts={item.shortcut?.ariaKeyShortcuts}
      aria-label={
        item.shortcut ? `${item.label} (${item.shortcut.label})` : undefined
      }
      {...split.splitProps}
      onClick={(event) =>
        actions.activate(item.id, {
          openInSplit: event.metaKey || event.ctrlKey,
        })
      }
    >
      <SidebarNavigationIcon icon={item.icon} />
      <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
      {shortcut ? <AppCommandShortcutPill shortcut={shortcut} /> : null}
    </Button>
  );
}
