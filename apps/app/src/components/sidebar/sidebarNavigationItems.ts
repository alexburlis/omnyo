import { appCommandTarget } from "@/lib/app-command-targets";
import type { PluginNavPanelChromeEntry } from "@/lib/plugin-nav-panel-chrome";
import {
  AUTOMATIONS_PLUGIN_ID,
  getPluginPanelRoutePath,
  getPluginsRoutePath,
  getSkillsRoutePath,
  SKILLS_PANEL,
  isToolsRoutePath,
} from "@/lib/route-paths";
import {
  hasWorkflowsPanel,
  isStateMachinesPanel,
} from "@/lib/workflow-panel-routes";
import type { PaneContent } from "@/lib/split-layout";
import {
  BUILT_IN_SIDEBAR_NAVIGATION_KEYS,
  DEFAULT_BUILT_IN_SIDEBAR_NAVIGATION_ORDER,
  getPluginNavPanelKey,
} from "@/components/plugin/pluginNavSidebarOrder";

export function sidebarNavigationItemCommandProps(
  item: Pick<SidebarNavigationItem, "action">,
): ReturnType<typeof appCommandTarget> | Record<string, never> {
  switch (item.action.kind) {
    case "new-thread":
      return appCommandTarget("thread.new");
    case "search-threads":
      return appCommandTarget("thread.search");
    default:
      return {};
  }
}

export interface SidebarNavigationShortcut {
  label: string;
  ariaKeyShortcuts: string;
}

export type SidebarNavigationAction =
  | { kind: "new-thread" }
  | { kind: "search-threads" }
  | { kind: "open-extensions" }
  | { kind: "open-skills" }
  | {
      kind: "open-plugin-panel";
      pluginId: string;
      panelId: string;
    };

export type SidebarNavigationItemIcon =
  | { kind: "host"; name: "new-thread" | "search" | "extensions" | "skills" }
  | { kind: "plugin"; pluginId: string; icon: string | null };

export interface SidebarNavigationItem {
  id: string;
  label: string;
  icon: SidebarNavigationItemIcon;
  action: SidebarNavigationAction;
  isDisabled: boolean;
  isVisible: boolean;
  isLoading: boolean;
  pluginId: string | null;
  shortcut: SidebarNavigationShortcut | null;
}

export interface SidebarNavigationActions {
  activate(itemId: string, options: { openInSplit: boolean }): void;
  setVisible(itemId: string, isVisible: boolean): void;
  openDetails(itemId: string): void;
  disablePlugin(itemId: string): Promise<void>;
}

export interface SidebarNavigationState {
  items: readonly SidebarNavigationItem[];
  activeItemId: string | null;
  isShortcutModifierHeld: boolean;
  actions: SidebarNavigationActions;
}

export const NEW_THREAD_NAVIGATION_ITEM_ID =
  BUILT_IN_SIDEBAR_NAVIGATION_KEYS.newThread;

export const CANVAS_NAVIGATION_ITEM_ID = "canvas/project-canvas";

export function isCustomizableSidebarNavigationItem(
  item: SidebarNavigationItem,
): boolean {
  return (
    item.action.kind !== "new-thread" && item.id !== CANVAS_NAVIGATION_ITEM_ID
  );
}

export const SEARCH_THREADS_NAVIGATION_ITEM_ID =
  BUILT_IN_SIDEBAR_NAVIGATION_KEYS.searchThreads;

export const PLUGINS_NAVIGATION_ITEM_ID =
  BUILT_IN_SIDEBAR_NAVIGATION_KEYS.extensions;

export const SKILLS_NAVIGATION_ITEM_ID =
  BUILT_IN_SIDEBAR_NAVIGATION_KEYS.skills;

export const SIDEBAR_NAVIGATION_LEADING_KEYS =
  DEFAULT_BUILT_IN_SIDEBAR_NAVIGATION_ORDER;

export interface SidebarNavigationRow {
  pluginId: string;
  id: string;
  label: string;
  icon: SidebarNavigationItemIcon;
  action: SidebarNavigationAction;
  ownerPluginId: string | null;
  panelEntry: PluginNavPanelChromeEntry | null;
}

const NEW_THREAD_CONTENT = { kind: "new-thread" } as const;

function hostRow(
  key: string,
  label: string,
  icon: Extract<SidebarNavigationItemIcon, { kind: "host" }>["name"],
  action: SidebarNavigationAction,
): SidebarNavigationRow {
  const [pluginId = "", id = ""] = key.split("/");

  return {
    pluginId,
    id,
    label,
    icon: { kind: "host", name: icon },
    action,
    ownerPluginId: null,
    panelEntry: null,
  };
}

const HOST_ROWS: readonly SidebarNavigationRow[] = [
  hostRow(NEW_THREAD_NAVIGATION_ITEM_ID, "New thread", "new-thread", {
    kind: "new-thread",
  }),
  hostRow(SEARCH_THREADS_NAVIGATION_ITEM_ID, "Search threads", "search", {
    kind: "search-threads",
  }),
  hostRow(PLUGINS_NAVIGATION_ITEM_ID, "Plugins", "extensions", {
    kind: "open-extensions",
  }),
  hostRow(SKILLS_NAVIGATION_ITEM_ID, "Skills", "skills", {
    kind: "open-skills",
  }),
];

export function createSidebarNavigationRows(
  panelEntries: readonly PluginNavPanelChromeEntry[],
): SidebarNavigationRow[] {
  const hasWorkflows = hasWorkflowsPanel(
    panelEntries.map(({ chrome }) => chrome),
  );

  const hasSkills = panelEntries.some(
    ({ chrome }) =>
      chrome.pluginId === SKILLS_PANEL.pluginId &&
      chrome.path === SKILLS_PANEL.path,
  );

  return [
    ...HOST_ROWS.filter(
      (row) => !hasSkills || row.action.kind !== "open-skills",
    ),
    ...panelEntries
      .filter(
        ({ chrome }) =>
          chrome.sidebarEntry !== true &&
          !(hasWorkflows && isStateMachinesPanel(chrome)) &&
          !(
            chrome.pluginId === SKILLS_PANEL.pluginId &&
            chrome.path === "marketplace"
          ),
      )
      .map((entry): SidebarNavigationRow => {
        const { chrome } = entry;
        const isAutomations = chrome.pluginId === AUTOMATIONS_PLUGIN_ID;

        const isSkills =
          chrome.pluginId === SKILLS_PANEL.pluginId &&
          chrome.path === SKILLS_PANEL.path;

        return {
          pluginId: isAutomations || isSkills ? "__core__" : chrome.pluginId,
          id: isAutomations ? "automations" : isSkills ? "skills" : chrome.id,
          label: isSkills ? "Skills" : chrome.title,
          icon: {
            kind: "plugin",
            pluginId: chrome.pluginId,
            icon: chrome.icon,
          },
          action: {
            kind: "open-plugin-panel",
            pluginId: chrome.pluginId,
            panelId: chrome.id,
          },
          ownerPluginId: chrome.pluginId,
          panelEntry: entry,
        };
      }),
  ];
}

export function getSidebarNavigationRowContent(
  row: SidebarNavigationRow,
): PaneContent | null {
  if (row.action.kind === "new-thread") return NEW_THREAD_CONTENT;

  if (row.action.kind !== "open-plugin-panel") return null;
  const chrome = row.panelEntry?.chrome;

  return chrome
    ? {
        kind: "plugin-panel",
        pluginId: chrome.pluginId,
        panelPath: chrome.path,
        subPath: "",
      }
    : null;
}

export interface SidebarNavigationItemState {
  isDisabled: boolean;
  isVisible: boolean;
  shortcut: SidebarNavigationShortcut | null;
}

export function toSidebarNavigationItem(
  row: SidebarNavigationRow,
  state: SidebarNavigationItemState,
): SidebarNavigationItem {
  const id = getPluginNavPanelKey(row);

  return {
    id,
    label: row.label,
    icon: row.icon,
    action: row.action,
    isDisabled: state.isDisabled,
    isVisible: id === CANVAS_NAVIGATION_ITEM_ID || state.isVisible,
    isLoading: row.panelEntry !== null && row.panelEntry.panel === null,
    pluginId: row.ownerPluginId,
    shortcut: state.shortcut,
  };
}

function sameIcon(
  left: SidebarNavigationItemIcon,
  right: SidebarNavigationItemIcon,
): boolean {
  if (left.kind === "host" || right.kind === "host") {
    return (
      left.kind === right.kind &&
      left.kind === "host" &&
      right.kind === "host" &&
      left.name === right.name
    );
  }

  return left.pluginId === right.pluginId && left.icon === right.icon;
}

function sameAction(
  left: SidebarNavigationAction,
  right: SidebarNavigationAction,
): boolean {
  if (left.kind !== right.kind) return false;

  if (left.kind !== "open-plugin-panel" || right.kind !== "open-plugin-panel") {
    return true;
  }

  return left.pluginId === right.pluginId && left.panelId === right.panelId;
}

export function isSameSidebarNavigationItem(
  left: SidebarNavigationItem,
  right: SidebarNavigationItem,
): boolean {
  return (
    left.id === right.id &&
    left.label === right.label &&
    sameIcon(left.icon, right.icon) &&
    sameAction(left.action, right.action) &&
    left.isDisabled === right.isDisabled &&
    left.isVisible === right.isVisible &&
    left.isLoading === right.isLoading &&
    left.pluginId === right.pluginId &&
    left.shortcut?.label === right.shortcut?.label &&
    left.shortcut?.ariaKeyShortcuts === right.shortcut?.ariaKeyShortcuts
  );
}

export function resolveActiveSidebarNavigationItemId({
  rows,
  pathname,
}: {
  rows: readonly SidebarNavigationRow[];
  pathname: string;
}): string | null {
  if (pathname === "/") return NEW_THREAD_NAVIGATION_ITEM_ID;

  if (isToolsRoutePath(pathname)) {
    return pathname === getSkillsRoutePath() ||
      pathname.startsWith(`${getSkillsRoutePath()}/`)
      ? SKILLS_NAVIGATION_ITEM_ID
      : PLUGINS_NAVIGATION_ITEM_ID;
  }

  for (const row of rows) {
    const chrome = row.panelEntry?.chrome;

    if (!chrome) continue;

    const path = getPluginPanelRoutePath({
      pluginId: chrome.pluginId,
      path: chrome.path,
    });

    if (pathname === path || pathname.startsWith(`${path}/`)) {
      return getPluginNavPanelKey(row);
    }
  }

  return null;
}

export function getResourceNavigationRoutePath(
  action: SidebarNavigationAction,
): string | null {
  if (action.kind === "open-extensions") return getPluginsRoutePath();

  if (action.kind === "open-skills") return getSkillsRoutePath();

  return null;
}
