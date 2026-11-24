import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Link, useNavigate } from "react-router-dom";
import type { ExperimentalSidebarFooterCommandKind } from "@omnyo/plugin-sdk/internal/plugin-app-collector";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { useIsCompactViewport } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { Icon } from "@omnyo/shared-ui/icon";
import {
  getDisclosureRevealClass,
  MOTION_DURATION_MS,
  TRANSITION_FALLBACK_SLACK_MS,
} from "@omnyo/shared-ui/motion";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar.js";
import { PluginItemIcon, pluginIconName } from "@/components/plugin/PluginIcon";
import { PluginSlotMount } from "@/components/plugin/PluginSlotMount";
import {
  usePluginSlots,
  type PluginSidebarFooterItemSlot,
} from "@/lib/plugin-slots";
import { getPluginConfigurationRoutePath } from "@/lib/route-paths";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@omnyo/shared-ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@omnyo/shared-ui/dropdown-menu";
import {
  useSidebarFooterPreferences,
  useMeasureSidebarFooterCapacity,
  SIDEBAR_FOOTER_MORE_ID,
  type FooterItem,
  type BuiltinFooterId,
} from "@/components/sidebar/sidebarFooterPreferences";
import { SIDEBAR_FOOTER_ACTION_CLASS } from "@omnyo/shared-ui/sidebar-row-classes";

export type SidebarFooterItemsPlacement = "sidebar" | "footer";

export const APP_FOOTER_ACTION_CLASS = cn(
  SIDEBAR_FOOTER_ACTION_CLASS,
  "h-6 w-6 rounded-md outline-none focus-visible:bg-state-hover focus-visible:text-sidebar-foreground [&>[data-icon-root]]:size-3.5",
);

function footerItemKey(item: PluginSidebarFooterItemSlot): string {
  return `${item.pluginId}/${item.id}/${item.generation}`;
}

function footerDisclosureId(item: PluginSidebarFooterItemSlot): string {
  return `plugin-sidebar-footer-disclosure-${item.pluginId}-${item.id}-${item.generation}`;
}

function footerTriggerId(item: PluginSidebarFooterItemSlot): string {
  return `plugin-sidebar-footer-trigger-${item.pluginId}-${item.id}-${item.generation}`;
}

export function usePluginSidebarFooterDisclosure() {
  const { sidebarFooterItems } = usePluginSlots();

  const disclosures = useMemo(
    () => sidebarFooterItems.filter((item) => item.kind === "disclosure"),
    [sidebarFooterItems],
  );

  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [restoreFocusKey, setRestoreFocusKey] = useState<string | null>(null);
  const lastProgrammaticCommand = useRef(0);

  const activeItem = useMemo(
    () => disclosures.find((item) => footerItemKey(item) === activeKey) ?? null,
    [activeKey, disclosures],
  );

  const restoreFocusItem = useMemo(
    () =>
      disclosures.find((item) => footerItemKey(item) === restoreFocusKey) ??
      null,
    [disclosures, restoreFocusKey],
  );

  const handleCommand = useCallback(
    (
      itemKey: string,
      command: ExperimentalSidebarFooterCommandKind,
      sequence?: number,
    ) => {
      if (sequence !== undefined) {
        if (sequence <= lastProgrammaticCommand.current) return;
        lastProgrammaticCommand.current = sequence;
      }

      const isClosing =
        (command === "close" && activeKey === itemKey) ||
        (command === "toggle" && activeKey === itemKey);

      setRestoreFocusKey(isClosing ? itemKey : null);
      setActiveKey((current) => {
        if (command === "open") return itemKey;

        if (command === "close") return current === itemKey ? null : current;

        return current === itemKey ? null : itemKey;
      });
    },
    [activeKey],
  );

  const dismiss = useCallback(() => {
    if (activeItem !== null) {
      setRestoreFocusKey(footerItemKey(activeItem));
    }

    setActiveKey(null);
  }, [activeItem]);

  const close = useCallback(() => {
    setRestoreFocusKey(null);
    setActiveKey(null);
  }, []);

  useLayoutEffect(() => {
    if (restoreFocusItem === null || activeItem !== null) return;
    (
      document.getElementById(footerTriggerId(restoreFocusItem)) ??
      document.getElementById(SIDEBAR_FOOTER_MORE_ID)
    )?.focus({ preventScroll: true });
  }, [activeItem, restoreFocusItem]);

  useEffect(() => {
    if (activeItem === null) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      dismiss();
    };

    window.addEventListener("keydown", onKeyDown);

    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeItem, dismiss]);

  return {
    activeItem,
    activeKey: activeItem === null ? null : activeKey,
    close,
    dismiss,
    handleCommand,
  };
}

export function PluginSidebarFooterDisclosure({
  item,
  onDismiss,
  placement = "sidebar",
}: {
  item: PluginSidebarFooterItemSlot | null;
  onDismiss: () => void;
  placement?: SidebarFooterItemsPlacement;
}) {
  const active = item !== null && item.kind === "disclosure" ? item : null;

  if (placement === "footer") {
    return active === null ? null : (
      <PluginSidebarFooterDisclosureSection
        item={active}
        onDismiss={onDismiss}
        placement={placement}
      />
    );
  }

  return <RetainedFooterDisclosure active={active} onDismiss={onDismiss} />;
}

function RetainedFooterDisclosure({
  active,
  onDismiss,
}: {
  active: PluginSidebarFooterItemSlot | null;
  onDismiss: () => void;
}) {
  const [retained, setRetained] = useState(active);
  const [entered, setEntered] = useState(false);

  if (active !== null && active !== retained) setRetained(active);

  useEffect(() => {
    if (active !== null) {
      const frame = window.requestAnimationFrame(() => setEntered(true));

      return () => window.cancelAnimationFrame(frame);
    }

    const timer = window.setTimeout(() => {
      setRetained(null);
      setEntered(false);
    }, MOTION_DURATION_MS.base + TRANSITION_FALLBACK_SLACK_MS);

    return () => window.clearTimeout(timer);
  }, [active]);

  if (retained === null) return null;

  return (
    <div
      data-sidebar-footer-disclosure=""
      aria-hidden={active === null}
      inert={active === null}
      className={getDisclosureRevealClass(active !== null && entered)}
    >
      <div className="min-h-0 overflow-hidden">
        <div className="pt-2">
          <PluginSidebarFooterDisclosureSection
            item={retained}
            onDismiss={onDismiss}
            placement="sidebar"
          />
        </div>
      </div>
    </div>
  );
}

function PluginSidebarFooterDisclosureSection({
  item,
  onDismiss,
  placement,
}: {
  item: PluginSidebarFooterItemSlot;
  onDismiss: () => void;
  placement: SidebarFooterItemsPlacement;
}) {
  if (item.kind !== "disclosure") return null;
  const Component = item.component;

  return (
    <section
      id={footerDisclosureId(item)}
      aria-label={item.label}
      data-testid={`plugin-sidebar-footer-disclosure-${item.pluginId}-${item.id}`}
      className={cn(
        "overflow-hidden",
        placement === "sidebar" &&
          "rounded-lg border border-sidebar-border bg-sidebar-accent/50",
      )}
    >
      <div className="max-h-80 overflow-auto">
        <PluginSlotMount
          pluginId={item.pluginId}
          slotKind="experimental_sidebarFooter"
          slotId={item.id}
        >
          <Component dismiss={onDismiss} />
        </PluginSlotMount>
      </div>
    </section>
  );
}

export interface BuiltinFooterAction {
  id: BuiltinFooterId;
  onActivate(): void;
  href?: string;
  ariaLabel?: string;
  ariaKeyShortcuts?: string;
}

export interface FooterActionsOptions {
  onDisclosureCommand: (
    itemKey: string,
    command: ExperimentalSidebarFooterCommandKind,
    sequence?: number,
  ) => void;
  onNavigate?: () => void;
  onCustomize: () => void;
  builtInActions?: readonly BuiltinFooterAction[];
  placement?: SidebarFooterItemsPlacement;
  collapsed?: boolean;
}

export function useFooterActions({
  onDisclosureCommand,
  onNavigate,
  onCustomize,
  builtInActions = [],
  placement = "sidebar",
  collapsed = false,
}: FooterActionsOptions) {
  const navigate = useNavigate();
  const preferences = useSidebarFooterPreferences(placement);
  const isCompactViewport = useIsCompactViewport();
  const customizeAfterClose = useRef(false);

  const isAvailable = (item: FooterItem) =>
    item.kind === "plugin" ||
    builtInActions.some((action) => action.id === item.id);

  const items = preferences.items.filter(isAvailable);
  const visible = collapsed ? [] : preferences.footer.filter(isAvailable);

  const hidden = items.filter(
    (item) =>
      !visible.includes(item) &&
      !(
        placement === "footer" &&
        item.kind === "builtin" &&
        item.id === "mobile"
      ),
  );

  const toggleable = preferences.items.filter(
    (item) => !preferences.isFoldedByDefault(item),
  );

  function customize() {
    customizeAfterClose.current = true;
  }

  function handleCloseAutoFocus(event: Event) {
    if (!customizeAfterClose.current) return;
    event.preventDefault();
    customizeAfterClose.current = false;
    onCustomize();
  }

  function activate(item: FooterItem) {
    if (item.kind === "builtin") {
      builtInActions.find((action) => action.id === item.id)?.onActivate();

      return;
    }

    const slot = item.slot;

    if (slot.kind === "disclosure") {
      onDisclosureCommand(footerItemKey(slot), "toggle");

      return;
    }

    onNavigate?.();
    runContainedFooterCallback(
      slot.pluginId,
      slot.source === "sidebarFooterAction"
        ? `sidebarFooterAction "${slot.id}"`
        : `experimental_sidebarFooter item "${slot.id}"`,
      () =>
        slot.onActivate({
          openPluginDetails: () => {
            void navigate(
              getPluginConfigurationRoutePath({ pluginId: slot.pluginId }),
            );
          },
        }),
    );
  }

  return {
    preferences,
    isCompactViewport,
    items,
    visible,
    hidden,
    canToggleFooter: items.some((item) => !preferences.isFoldedByDefault(item)),
    footerHidden: toggleable.every((item) =>
      preferences.hidden.includes(item.key),
    ),
    customize,
    handleCloseAutoFocus,
    activate,
    onCustomize,
  };
}

type FooterActions = ReturnType<typeof useFooterActions>;

export function FooterActionMenuItems({ actions }: { actions: FooterActions }) {
  const { hidden, isCompactViewport, onCustomize, customize } = actions;

  return (
    <>
      {hidden.map((item) => (
        <DropdownMenuItem
          key={item.key}
          onSelect={() => actions.activate(item)}
        >
          <FooterItemIcon item={item} />
          {item.label}
        </DropdownMenuItem>
      ))}
      {hidden.length > 0 && <DropdownMenuSeparator />}
      <DropdownMenuItem onSelect={isCompactViewport ? onCustomize : customize}>
        <Icon name="SlidersHorizontal" />
        Customize footer
      </DropdownMenuItem>
      {actions.canToggleFooter && (
        <DropdownMenuItem
          onSelect={() =>
            actions.preferences.setFooterShown(actions.footerHidden)
          }
        >
          <Icon name={actions.footerHidden ? "Eye" : "EyeOff"} />
          {actions.footerHidden ? "Show footer" : "Hide footer"}
        </DropdownMenuItem>
      )}
    </>
  );
}

export function PluginSidebarFooterItems({
  activeDisclosureKey,
  onDisclosureCommand,
  onNavigate,
  onCustomize,
  builtInActions = [],
  placement = "sidebar",
  collapsed = false,
}: FooterActionsOptions & {
  activeDisclosureKey: string | null;
}) {
  const isAppFooter = placement === "footer";

  const actionClass = isAppFooter
    ? APP_FOOTER_ACTION_CLASS
    : SIDEBAR_FOOTER_ACTION_CLASS;

  const actions = useFooterActions({
    onDisclosureCommand,
    onNavigate,
    onCustomize,
    builtInActions,
    placement,
    collapsed,
  });

  const {
    preferences,
    items,
    visible,
    customize,
    handleCloseAutoFocus,
    activate,
  } = actions;

  const previousHidden = useRef(preferences.hidden);
  const menuRef = useRef<HTMLUListElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  useMeasureSidebarFooterCapacity(menuRef, moreRef, !collapsed && !isAppFooter);

  useEffect(() => {
    for (const item of items) {
      if (
        item.kind === "plugin" &&
        item.slot.kind === "disclosure" &&
        preferences.hidden.includes(item.key) &&
        !previousHidden.current.includes(item.key)
      ) {
        onDisclosureCommand(footerItemKey(item.slot), "close");
      }
    }

    previousHidden.current = preferences.hidden;
  }, [items, preferences.hidden, onDisclosureCommand]);

  return (
    <>
      {items.map((item) =>
        item.kind === "plugin" ? (
          <FooterCommandObserver
            key={footerItemKey(item.slot)}
            item={item.slot}
            onDisclosureCommand={onDisclosureCommand}
          />
        ) : null,
      )}
      <SidebarMenuItem
        className={cn(
          isAppFooter
            ? "min-w-6 flex-1"
            : "min-w-8 flex-1 max-md:pointer-coarse:min-w-9",
          collapsed && "flex-none",
        )}
      >
        <SidebarMenu
          ref={menuRef}
          className={cn(
            "flex-row items-center gap-1",
            isAppFooter && "justify-end",
          )}
        >
          {visible.map((item) => {
            const builtin =
              item.kind === "builtin"
                ? builtInActions.find((action) => action.id === item.id)
                : undefined;

            const active =
              item.kind === "plugin" &&
              footerItemKey(item.slot) === activeDisclosureKey;

            const label = builtin?.ariaLabel ?? item.label;

            return (
              <ContextMenu key={item.key}>
                <ContextMenuTrigger asChild>
                  <SidebarMenuItem
                    className="min-w-0 shrink-0"
                    data-footer-item={item.key}
                  >
                    <SidebarMenuButton
                      asChild={builtin?.href !== undefined}
                      id={
                        item.kind === "plugin"
                          ? footerTriggerId(item.slot)
                          : `sidebar-footer-${item.id}`
                      }
                      aria-label={label}
                      aria-keyshortcuts={builtin?.ariaKeyShortcuts}
                      tooltip={{
                        children: label,
                        hidden: false,
                        side: "top",
                      }}
                      className={cn(
                        actionClass,
                        active &&
                          "bg-sidebar-accent text-sidebar-accent-foreground [&>[data-icon-root]]:opacity-100",
                      )}
                      data-testid={
                        item.kind === "plugin"
                          ? item.slot.source === "sidebarFooterAction"
                            ? `plugin-sidebar-footer-action-${item.slot.pluginId}-${item.slot.id}`
                            : `plugin-sidebar-footer-item-${item.slot.pluginId}-${item.slot.id}`
                          : undefined
                      }
                      {...(item.kind === "plugin" &&
                      item.slot.kind === "disclosure"
                        ? {
                            "aria-expanded": active,
                            "aria-controls": footerDisclosureId(item.slot),
                          }
                        : {})}
                      onClick={
                        builtin?.href === undefined
                          ? () => activate(item)
                          : undefined
                      }
                    >
                      {builtin?.href !== undefined ? (
                        <Link to={builtin.href} onClick={onNavigate}>
                          <FooterItemIcon item={item} />
                          <span className="sr-only">{item.label}</span>
                        </Link>
                      ) : (
                        <>
                          <FooterItemIcon item={item} />
                          <span className="sr-only">{item.label}</span>
                        </>
                      )}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </ContextMenuTrigger>
                <ContextMenuContent onCloseAutoFocus={handleCloseAutoFocus}>
                  <ContextMenuItem
                    onSelect={() => preferences.hideFromFooter(item.key)}
                  >
                    <Icon name="EyeOff" />
                    Hide from footer
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={customize}>
                    <Icon name="SlidersHorizontal" />
                    Customize footer
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
          <SidebarMenuItem className="min-w-0 shrink-0">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  ref={moreRef}
                  id={SIDEBAR_FOOTER_MORE_ID}
                  aria-label="More footer actions"
                  tooltip={{ children: "More", hidden: false, side: "top" }}
                  className={actionClass}
                >
                  <Icon name="MoreHorizontal" />
                  <span className="sr-only">More</span>
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="top"
                align="start"
                mobileTitle="More footer actions"
                onCloseAutoFocus={handleCloseAutoFocus}
              >
                <FooterActionMenuItems actions={actions} />
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarMenuItem>
    </>
  );
}

function FooterCommandObserver({
  item,
  onDisclosureCommand,
}: {
  item: PluginSidebarFooterItemSlot;
  onDisclosureCommand: (
    key: string,
    command: ExperimentalSidebarFooterCommandKind,
    sequence?: number,
  ) => void;
}) {
  const snapshot = useSyncExternalStore(
    item.runtime.subscribe,
    item.runtime.getSnapshot,
    item.runtime.getSnapshot,
  );

  const command = snapshot.command;
  useEffect(() => {
    if (command === null || item.kind !== "disclosure") return;
    onDisclosureCommand(footerItemKey(item), command.kind, command.sequence);
    item.runtime.acknowledgeCommand(command.sequence);
  }, [command, item, onDisclosureCommand]);

  return null;
}

export function FooterItemIcon({ item }: { item: FooterItem }) {
  return item.kind === "plugin" &&
    item.slot.source === "sidebarFooterAction" ? (
    <PluginItemIcon pluginId={item.slot.pluginId} icon={item.icon} />
  ) : (
    <Icon
      name={pluginIconName(item.icon)}
      className="size-4 shrink-0"
      aria-hidden="true"
    />
  );
}

function runContainedFooterCallback(
  pluginId: string,
  label: string,
  callback: () => void | Promise<void>,
): void {
  const warn = (error: unknown) => {
    console.warn(
      `[plugin:${pluginId}] ${label} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  };

  try {
    const result = callback();

    if (result instanceof Promise) result.catch(warn);
  } catch (error) {
    warn(error);
  }
}
