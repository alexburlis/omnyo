import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { PluginSidebarEntry } from "@/components/plugin/PluginSidebarEntry";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { isThreadRead } from "@omnyo/client-core";
import {
  THREAD_JUMP_APP_COMMAND_IDS,
  type ThreadListEntry,
} from "@omnyo/domain";
import { useNavigate } from "react-router-dom";
import { OverflowFade } from "@/components/ui/overflow-fade.js";
import {
  Sidebar,
  SidebarCollapsibleBody,
  SidebarContent,
  SidebarMenu,
  useCloseMobileSidebar,
  useSidebar,
} from "@/components/ui/sidebar.js";
import { ThreadActionSurfaceVisibility } from "@/lib/thread-actions/thread-action-registry";
import { PluginThreadList } from "./PluginThreadList";
import { SidebarUnreadNavigation } from "./SidebarUnreadNavigation";
import { useSidebarNavigationThreadSelection } from "@/hooks/queries/sidebar-navigation-query";
import { useThreadListReplacement } from "./threadListProvider";
import {
  PluginSidebarFooterDisclosure,
  PluginSidebarFooterItems,
} from "@/components/plugin/PluginSidebarFooterItems";
import { SidebarPluginAttentionGlyph } from "./SidebarPluginAttentionGlyph";
import { SidebarUpdatesBadge } from "./SidebarUpdatesBadge";
import { MobileBottomRail } from "./MobileBottomRail";
import { SidebarResizeHandle, SidebarTopReserveRow } from "./SidebarChrome";
import { SIDEBAR_FOOTER_ACTION_CLASS } from "@omnyo/shared-ui/sidebar-row-classes";
import { getThreadRoutePath } from "@/lib/route-paths";
import {
  EMPTY_SIDEBAR_THREAD_SHORTCUT_KEYS,
  getSidebarThreadNavigationTargets,
  getSidebarThreadShortcutTargets,
  SidebarThreadShortcutKeysContext,
  type SidebarThreadShortcutPresentation,
  type SidebarThreadShortcutTarget,
} from "./sidebarThreadShortcuts";
import {
  useAppCommandHandler,
  useAppCommandRunner,
  useAppCommandShortcuts,
  useIsAppCommandModifierHeld,
  useIndexedAppCommandHandlers,
} from "@/components/commands/AppCommandProvider";
import { useRouteState } from "@/hooks/useRouteState";
import { SidebarNavigationModelProvider } from "./SidebarNavigationModel";
import {
  useSidebarScope,
  useSidebarScopeFollowsLocation,
} from "./sidebarScope";
import {
  useSidebarFooterBuiltInActions,
  useSidebarFooterState,
} from "./SidebarFooterState";
import { PluginSidebarFooterCards } from "@/components/plugin/PluginSidebarFooterCards";
import { LazySidebarFooterCustomize } from "./LazySidebarFooterCustomize";
import {
  NavRailNewThreadButton,
  type NavRailCustomizeState,
} from "./AppNavRail";

const EMPTY_UNREAD_IDS: ReadonlySet<string> = new Set();

function unreadThreadIds(threads: ThreadListEntry[]): ReadonlySet<string> {
  const ids = new Set<string>();

  for (const thread of threads) {
    if (thread.archivedAt !== null || thread.visibility === "hidden") continue;

    if (!isThreadRead(thread)) ids.add(thread.id);
  }

  return ids;
}

interface AppSidebarProps {
  onResizeMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void;
  isResizing: boolean;
  isBodyHidden: boolean;
  renderRail: (customize: NavRailCustomizeState) => ReactNode;
  alternateBody: ReactNode;
  railFooter: ReactNode;
}

export function AppSidebar({
  onResizeMouseDown,
  isResizing,
  isBodyHidden,
  renderRail,
  alternateBody,
  railFooter,
}: AppSidebarProps) {
  const threadListReplacement = useThreadListReplacement();
  const scope = useSidebarScope();
  const { threadId: activeThreadId } = useRouteState();
  const navigate = useNavigate();
  const closeOnMobile = useCloseMobileSidebar();
  const { isCompactViewport, open, openMobile } = useSidebar();

  const isThreadListVisible =
    !isBodyHidden && (isCompactViewport ? openMobile : open);

  const footer = useSidebarFooterState();

  const {
    disclosure: pluginSidebarFooter,
    isCustomizing: isFooterCustomizing,
    isNavigationCustomizing,
    setNavigationCustomizing,
    closeCustomizing: closeFooterCustomizing,
  } = footer;

  const builtInFooterActions = useSidebarFooterBuiltInActions(closeOnMobile);

  const [threadShortcutKeysById, setThreadShortcutKeysById] = useState<
    ReadonlyMap<string, SidebarThreadShortcutPresentation>
  >(EMPTY_SIDEBAR_THREAD_SHORTCUT_KEYS);

  const sidebarRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const { data: unreadIds = EMPTY_UNREAD_IDS } =
    useSidebarNavigationThreadSelection(unreadThreadIds);

  const threadShortcutTargetsRef = useRef<
    readonly SidebarThreadShortcutTarget[]
  >([]);

  const threadJumpShortcuts = useAppCommandShortcuts(
    THREAD_JUMP_APP_COMMAND_IDS,
  );

  const isAppCommandModifierHeld = useIsAppCommandModifierHeld();
  const commandRunner = useAppCommandRunner();

  useSidebarScopeFollowsLocation();

  const handleNewChat = useCallback(() => {
    closeOnMobile();
    commandRunner.dispatch("thread.new", null);
  }, [closeOnMobile, commandRunner]);

  const showThreadShortcuts = useCallback(() => {
    const targets = getSidebarThreadShortcutTargets(sidebarRef.current);
    threadShortcutTargetsRef.current = targets;
    setThreadShortcutKeysById(
      new Map(
        targets.flatMap((target, index) => {
          const command = THREAD_JUMP_APP_COMMAND_IDS[index];

          const shortcut = command
            ? threadJumpShortcuts.get(command)
            : undefined;

          return shortcut ? [[target.threadId, shortcut] as const] : [];
        }),
      ),
    );
  }, [threadJumpShortcuts]);

  const hideThreadShortcuts = useCallback(() => {
    threadShortcutTargetsRef.current = [];
    setThreadShortcutKeysById(EMPTY_SIDEBAR_THREAD_SHORTCUT_KEYS);
  }, []);

  const activateThreadShortcut = useCallback((index: number): boolean => {
    const targets = threadShortcutTargetsRef.current;

    const target =
      targets[index] ??
      getSidebarThreadShortcutTargets(sidebarRef.current)[index];

    if (!target?.element) return false;
    target.element.click();

    return true;
  }, []);

  const activateAdjacentThread = useCallback(
    (offset: -1 | 1): boolean => {
      const targets = getSidebarThreadNavigationTargets(sidebarRef.current);

      if (targets.length === 0) return false;

      const activeIndex = targets.findIndex(
        (target) => target.threadId === activeThreadId,
      );

      const nextIndex =
        activeIndex === -1
          ? offset === 1
            ? 0
            : targets.length - 1
          : (activeIndex + offset + targets.length) % targets.length;

      const target = targets[nextIndex];

      if (!target) return false;

      if (target.element) {
        target.element.click();

        return true;
      }

      if (!target.projectId) return false;
      closeOnMobile();
      void navigate(
        getThreadRoutePath({
          projectId: target.projectId,
          threadId: target.threadId,
        }),
      );

      return true;
    },
    [activeThreadId, closeOnMobile, navigate],
  );

  useEffect(() => {
    if (!isCompactViewport) return;

    if (!openMobile || isBodyHidden) closeFooterCustomizing();

    if (!openMobile) setNavigationCustomizing(false);
  }, [
    closeFooterCustomizing,
    isBodyHidden,
    isCompactViewport,
    openMobile,
    setNavigationCustomizing,
  ]);

  const activateVisibleThreadShortcut = useCallback(
    (index: number) => (isBodyHidden ? false : activateThreadShortcut(index)),
    [activateThreadShortcut, isBodyHidden],
  );

  useIndexedAppCommandHandlers(
    THREAD_JUMP_APP_COMMAND_IDS,
    activateVisibleThreadShortcut,
  );
  useAppCommandHandler("thread.previous", () =>
    isBodyHidden ? false : activateAdjacentThread(-1),
  );
  useAppCommandHandler("thread.next", () =>
    isBodyHidden ? false : activateAdjacentThread(1),
  );

  useEffect(() => {
    if (isAppCommandModifierHeld) {
      showThreadShortcuts();

      return;
    }

    hideThreadShortcuts();
  }, [hideThreadShortcuts, isAppCommandModifierHeld, showThreadShortcuts]);

  const body = (
    <>
      <SidebarTopReserveRow
        testId="app-sidebar-top-reserve-row"
        headerSlot={
          <div
            data-testid="nav-rail-header"
            data-sidebar-header-slot=""
            className="flex h-full min-w-0 flex-1 items-center"
          >
            <NavRailNewThreadButton />
          </div>
        }
      />
      <PluginSidebarEntry scope={scope.kind} />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <SidebarContent ref={scrollRef}>
          <ThreadActionSurfaceVisibility visible={isThreadListVisible}>
            <PluginThreadList
              replacement={threadListReplacement}
              onNavigate={closeOnMobile}
            />
          </ThreadActionSurfaceVisibility>
        </SidebarContent>
        <SidebarUnreadNavigation
          scrollRef={scrollRef}
          unreadIds={unreadIds}
          enabled={isThreadListVisible}
        />
      </div>
      {isCompactViewport ? (
        <div
          className={cn(
            "relative flex flex-col gap-2 has-[[data-sidebar-footer-disclosure]]:px-2",
            isFooterCustomizing && "px-2 pt-2",
          )}
        >
          <OverflowFade placement="above" tone="sidebar" size="sm" />
          <div className="px-2 empty:hidden">
            <PluginSidebarFooterCards />
          </div>
          {isFooterCustomizing ? (
            <div className="max-h-[50svh] overflow-y-auto">
              <LazySidebarFooterCustomize onDone={footer.finishCustomizing} />
            </div>
          ) : (
            <PluginSidebarFooterDisclosure
              item={pluginSidebarFooter.activeItem}
              onDismiss={pluginSidebarFooter.dismiss}
            />
          )}
        </div>
      ) : null}
      <SidebarResizeHandle
        testId="app-sidebar-resize-handle"
        isResizing={isResizing}
        onMouseDown={onResizeMouseDown}
      />
    </>
  );

  return (
    <SidebarThreadShortcutKeysContext.Provider value={threadShortcutKeysById}>
      <SidebarNavigationModelProvider
        onNavigate={closeOnMobile}
        onNewChat={handleNewChat}
        onSearchThreads={closeOnMobile}
        splitEnabled
      >
        <Sidebar ref={sidebarRef}>
          <div
            className={cn(
              "grid min-h-0 flex-1 grid-cols-[auto_minmax(0,1fr)]",
              isCompactViewport
                ? "grid-rows-[minmax(0,1fr)_auto]"
                : "grid-rows-[minmax(0,1fr)]",
            )}
          >
            <div className="flex min-h-0 flex-col">
              {renderRail({
                isOpen: isNavigationCustomizing,
                onOpenChange: setNavigationCustomizing,
              })}
            </div>
            <SidebarCollapsibleBody data-testid="nav-rail-sidebar-body">
              <div
                data-testid="app-sidebar-body"
                hidden={isBodyHidden}
                className="flex min-h-0 min-w-0 flex-1 flex-col"
              >
                {body}
              </div>
              {alternateBody}
            </SidebarCollapsibleBody>
            {isCompactViewport ? (
              <MobileBottomRail settings={railFooter}>
                <SidebarMenu
                  aria-label="Footer actions"
                  className={cn(
                    "w-auto shrink-0 flex-row items-center gap-0.5",
                    isFooterCustomizing && "hidden",
                  )}
                >
                  <PluginSidebarFooterItems
                    onCustomize={footer.startCustomizing}
                    activeDisclosureKey={pluginSidebarFooter.activeKey}
                    onDisclosureCommand={pluginSidebarFooter.handleCommand}
                    onNavigate={closeOnMobile}
                    builtInActions={builtInFooterActions}
                    collapsed
                  />
                  <SidebarPluginAttentionGlyph
                    className={SIDEBAR_FOOTER_ACTION_CLASS}
                    onNavigate={closeOnMobile}
                  />
                  <SidebarUpdatesBadge onNavigate={closeOnMobile} />
                </SidebarMenu>
              </MobileBottomRail>
            ) : null}
          </div>
        </Sidebar>
      </SidebarNavigationModelProvider>
    </SidebarThreadShortcutKeysContext.Provider>
  );
}
