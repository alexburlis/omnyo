import {
  useContext,
  useId,
  useRef,
  useLayoutEffect,
  useSyncExternalStore,
  useState,
  createElement,
  type ComponentType,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import {
  pluginPortalVisibility,
  PluginPortalRetentionContext as PortalRetentionContext,
} from "@omnyo/shared-ui/lib/portal-scope";

export interface PluginPortalRetention {
  canRetain(): boolean;
}

export function createPluginPortalRetention(): PluginPortalRetention {
  return { canRetain: () => true };
}

export function usePluginPortalScope(): string | undefined {
  const scopes = useContext(PortalRetentionContext);

  return scopes.length ? scopes.join(" ") : undefined;
}

function isOpenPortal(element: Element): boolean {
  if (!element.isConnected) return false;

  if (element instanceof HTMLTemplateElement) return true;

  if (element.closest('[data-state="closed"], [hidden]')) return false;

  const style = getComputedStyle(element);

  return style.display !== "none" && style.visibility !== "hidden";
}

export function PluginPortalRetentionBoundary({
  retention,
  children,
}: {
  retention: PluginPortalRetention;
  children: ReactNode;
}) {
  const parentScopes = useContext(PortalRetentionContext);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = root.current;
    pluginPortalVisibility.setVisible(id, true);

    for (const node of document.querySelectorAll(
      "[data-omnyo-retention-hidden]",
    )) {
      const ids =
        node.getAttribute("data-omnyo-retention-scope")?.split(" ") ?? [];

      if (pluginPortalVisibility.isVisible(ids))
        node.removeAttribute("data-omnyo-retention-hidden");
    }

    return () => {
      pluginPortalVisibility.setVisible(id, false);
      queueMicrotask(() => {
        if (element && !element.isConnected) pluginPortalVisibility.forget(id);
      });

      for (const node of document.querySelectorAll(
        "[data-omnyo-retention-scope]",
      )) {
        if (
          node
            .getAttribute("data-omnyo-retention-scope")
            ?.split(" ")
            .includes(id)
        )
          node.setAttribute("data-omnyo-retention-hidden", "");
      }
    };
  }, [id]);
  retention.canRetain = () =>
    ![...document.querySelectorAll("[data-omnyo-retention-scope]")].some(
      (element) =>
        element
          .getAttribute("data-omnyo-retention-scope")
          ?.split(" ")
          .includes(id) &&
        !root.current?.contains(element) &&
        isOpenPortal(element),
    );

  return (
    <PortalRetentionContext.Provider value={[...parentScopes, id]}>
      <div ref={root} className="contents" data-omnyo-retention-owner={id}>
        {children}
      </div>
    </PortalRetentionContext.Provider>
  );
}

function PortalMarker({ children }: { children: ReactNode }) {
  "use no memo";
  const scope = usePluginPortalScope();

  const visible = useSyncExternalStore(pluginPortalVisibility.subscribe, () =>
    pluginPortalVisibility.isVisible(scope?.split(" ") ?? []),
  );

  if (!visible) return null;

  return (
    <>
      {children}
      <template data-omnyo-retention-scope={scope} />
    </>
  );
}

export const createPluginPortal: typeof createPortal = (
  children,
  container,
  key,
) =>
  createPortal(
    children == null || children === false ? (
      children
    ) : (
      <PortalMarker>{children}</PortalMarker>
    ),
    container,
    key,
  );

export function PluginChromePortalContent({
  children,
}: {
  children: ReactNode;
}) {
  "use no memo";
  const root = useRef<HTMLSpanElement>(null);
  const [retention] = useState(createPluginPortalRetention);
  const parents = useContext(PortalRetentionContext);

  const visible = useSyncExternalStore(pluginPortalVisibility.subscribe, () =>
    pluginPortalVisibility.isVisible(parents),
  );

  useLayoutEffect(() => {
    const element = root.current;

    if (!element) return;
    element.style.display = "contents";

    return () => {
      element.style.display = "none";
    };
  }, []);

  if (!visible) return null;

  return (
    <PortalRetentionContext.Provider value={[]}>
      <PluginPortalRetentionBoundary retention={retention}>
        <span ref={root} style={{ display: "contents" }}>
          {children}
        </span>
      </PluginPortalRetentionBoundary>
    </PortalRetentionContext.Provider>
  );
}

export function scopePluginPortalComponents<T extends object>(module: T): T {
  const scoped = Object.fromEntries(
    Object.entries(module).map(([name, component]) => {
      if (!/(Content|Overlay)$/.test(name)) return [name, component];

      if (
        typeof component !== "function" &&
        (typeof component !== "object" ||
          component === null ||
          !("$$typeof" in component))
      )
        return [name, component];

      function ScopedPortalContent(props: Record<string, unknown>) {
        "use no memo";
        const scope = usePluginPortalScope();

        const visible = useSyncExternalStore(
          pluginPortalVisibility.subscribe,
          () => pluginPortalVisibility.isVisible(scope?.split(" ") ?? []),
        );

        if (!visible) return null;

        return createElement(
          component as ComponentType<Record<string, unknown>>,
          { ...props, "data-omnyo-retention-scope": scope },
        );
      }

      return [name, ScopedPortalContent];
    }),
  );

  return scoped as T;
}
