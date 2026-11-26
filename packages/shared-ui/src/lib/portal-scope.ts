import {
  createContext,
  useContext,
  useSyncExternalStore,
  type Context,
} from "react";

export const PluginPortalRetentionContext = createContext<readonly string[]>(
  [],
);

const hiddenScopes = new Set<string>();

const visibilityListeners = new Set<() => void>();

export const pluginPortalVisibility = {
  subscribe(listener: () => void) {
    visibilityListeners.add(listener);

    return () => {
      visibilityListeners.delete(listener);
    };
  },
  isVisible(scopes: readonly string[]) {
    return !scopes.some((scope) => hiddenScopes.has(scope));
  },
  forget(scope: string) {
    hiddenScopes.delete(scope);
  },
  setVisible(scope: string, visible: boolean) {
    if (visible) hiddenScopes.delete(scope);
    else hiddenScopes.add(scope);

    for (const listener of visibilityListeners) listener();
  },
};

declare const __OMNYO_PLUGIN_ID__: string | undefined;

export function usePortalScopeProps(ownerPluginId?: string): {
  "data-omnyo-portaled-overlay": "";
  "data-omnyo-plugin-root"?: "";
  "data-omnyo-plugin"?: string;
  "data-omnyo-retention-scope"?: string;
  "data-omnyo-retention-hidden"?: "";
} {
  "use no memo";

  const host = globalThis as typeof globalThis & {
    __omnyoPluginRuntime?: {
      pluginPortalRetentionContext?: Context<readonly string[]>;
      pluginPortalVisibility?: typeof pluginPortalVisibility;
    };
  };

  const scopes = useContext(
    host.__omnyoPluginRuntime?.pluginPortalRetentionContext ??
      PluginPortalRetentionContext,
  );

  const retentionScope = scopes.length ? scopes.join(" ") : undefined;

  const visibility =
    host.__omnyoPluginRuntime?.pluginPortalVisibility ?? pluginPortalVisibility;

  const getVisible = () => visibility.isVisible(scopes);

  const visible = useSyncExternalStore(
    visibility.subscribe,
    getVisible,
    getVisible,
  );

  const pluginId =
    ownerPluginId ??
    (typeof __OMNYO_PLUGIN_ID__ === "string" ? __OMNYO_PLUGIN_ID__ : undefined);

  return {
    "data-omnyo-retention-scope": retentionScope,
    "data-omnyo-retention-hidden": visible ? undefined : "",
    "data-omnyo-portaled-overlay": "",
    "data-omnyo-plugin-root": "",
    ...(pluginId !== undefined ? { "data-omnyo-plugin": pluginId } : {}),
  };
}
