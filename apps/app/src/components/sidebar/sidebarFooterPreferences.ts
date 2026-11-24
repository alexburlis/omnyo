import { type RefObject, useLayoutEffect } from "react";
import { atom, useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  usePluginSlots,
  type PluginSidebarFooterItemSlot,
} from "@/lib/plugin-slots";
import { createSyncedPreferenceAtom } from "@/lib/ui-preferences/synced-preference-atom";
import { arrangeByStoredOrder, reorderStoredOrder } from "@/lib/stored-order";

export const sidebarFooterOrderAtom = createSyncedPreferenceAtom(
  "sidebar.footerOrder",
);

export const sidebarFooterHiddenAtom = createSyncedPreferenceAtom(
  "sidebar.hiddenFooterItems",
);

export const SIDEBAR_FOOTER_MORE_ID = "sidebar-footer-more";

export const sidebarFooterCapacityAtom = atom<number | null>(null);

export function useMeasureSidebarFooterCapacity(
  rowRef: RefObject<HTMLElement | null>,
  moreRef: RefObject<HTMLElement | null>,
  enabled = true,
) {
  const setCapacity = useSetAtom(sidebarFooterCapacityAtom);
  useLayoutEffect(() => {
    const row = rowRef.current;
    const more = moreRef.current;

    if (!enabled || !row || !more) return;

    const measure = () => {
      const width = row.getBoundingClientRect().width;
      const controlWidth = more.getBoundingClientRect().width;

      if (width === 0 || controlWidth === 0) return;
      const gap = Number.parseFloat(getComputedStyle(row).columnGap) || 0;
      setCapacity(
        Math.max(0, Math.floor((width + gap) / (controlWidth + gap)) - 1),
      );
    };

    measure();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    observer.observe(more);

    return () => observer.disconnect();
  }, [enabled, rowRef, moreRef, setCapacity]);
}

const BUILTIN_KEY_PREFIX = "builtin:";

function withoutPin(entries: readonly string[], key: string): string[] {
  return entries.filter((entry) => entry !== pinnedFooterEntry(key));
}

export type BuiltinFooterId = "mobile" | "report-bug";

export type FooterItem = { key: string; label: string; icon: string } & (
  | { kind: "builtin"; id: BuiltinFooterId }
  | { kind: "plugin"; slot: PluginSidebarFooterItemSlot }
);

export function footerPreferenceKey(item: {
  pluginId: string;
  id: string;
}): string {
  return `plugin:${encodeURIComponent(item.pluginId)}/${encodeURIComponent(item.id)}`;
}

export function pinnedFooterEntry(key: string): string {
  return `pinned:${key}`;
}

export type SidebarFooterPlacement = "sidebar" | "footer";

export function useSidebarFooterPreferences(
  placement: SidebarFooterPlacement = "sidebar",
) {
  const { sidebarFooterItems } = usePluginSlots();
  const [order, setOrder] = useAtom(sidebarFooterOrderAtom);
  const [hidden, setHidden] = useAtom(sidebarFooterHiddenAtom);
  const capacity = useAtomValue(sidebarFooterCapacityAtom);

  const items: FooterItem[] = [
    {
      kind: "builtin",
      id: "mobile",
      key: "builtin:mobile",
      label: "Mobile apps",
      icon: "Smartphone",
    },
    ...sidebarFooterItems.map((slot): FooterItem => ({
      kind: "plugin",
      key: footerPreferenceKey(slot),
      label: slot.label,
      icon: slot.icon,
      slot,
    })),
    {
      kind: "builtin",
      id: "report-bug",
      key: "builtin:report-bug",
      label: "Report a bug",
      icon: "Bug",
    },
  ];

  const { ordered, normalizedOrder } = arrangeByStoredOrder({
    items,
    storedOrder: order,
    getId: (item) => item.key,
  });

  const isAppFooter = placement === "footer";

  const isFoldedByDefault = (item: FooterItem) =>
    isAppFooter &&
    item.kind === "builtin" &&
    !hidden.includes(pinnedFooterEntry(item.key));

  const footer = ordered
    .filter((item) => !hidden.includes(item.key) && !isFoldedByDefault(item))
    .slice(0, isAppFooter ? undefined : (capacity ?? undefined));

  const more = ordered.filter((item) => !footer.includes(item));
  const isFull = !isAppFooter && capacity !== null && footer.length >= capacity;

  return {
    items: ordered,
    hidden,
    footer,
    more,
    capacity,
    isFull,
    isFoldedByDefault,
    hideFromFooter(key: string) {
      setHidden((previous) => [
        ...new Set([...withoutPin(previous, key), key]),
      ]);
    },
    removeFromFooter(key: string) {
      const overflow = more
        .filter((item) => !isFoldedByDefault(item))
        .map((item) => item.key);

      setHidden((previous) => [
        ...new Set([...withoutPin(previous, key), ...overflow, key]),
      ]);
    },
    addToFooter(key: string) {
      if (isFull) return;
      const last = footer.at(-1)?.key;
      const rest = normalizedOrder.filter((id) => id !== key);
      const index = last === undefined ? 0 : rest.indexOf(last) + 1;
      setOrder([...rest.slice(0, index), key, ...rest.slice(index)]);

      const pin = key.startsWith(BUILTIN_KEY_PREFIX) && isAppFooter;

      setHidden((previous) => {
        const remaining = previous.filter((id) => id !== key);

        return pin
          ? [...new Set([...remaining, pinnedFooterEntry(key)])]
          : remaining;
      });
    },
    setFooterShown(shown: boolean) {
      setHidden((previous) => {
        const keys = ordered.map((item) => item.key);
        const others = previous.filter((id) => !keys.includes(id));

        return shown ? others : [...others, ...keys];
      });
    },
    move(activeId: string, overId: string) {
      const zone =
        [footer, more].find((items) =>
          [activeId, overId].every((id) =>
            items.some((item) => item.key === id),
          ),
        ) ?? ordered;

      const next = reorderStoredOrder({
        activeId,
        overId,
        order: normalizedOrder,
        visibleIds: zone.map((item) => item.key),
      });

      if (next) setOrder(next);
    },
  };
}
