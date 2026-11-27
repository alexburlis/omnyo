declare const __OMNYO_PLUGIN_ID__: string | undefined;

type PortalScopeProps = {
  "data-omnyo-portaled-overlay": "";
  "data-omnyo-plugin-root"?: "";
  "data-omnyo-plugin"?: string;
};

export function usePortalScopeProps(): PortalScopeProps {
  const pluginId =
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The bundler constant can be undeclared in standalone rendering; typeof avoids a ReferenceError.
    typeof __OMNYO_PLUGIN_ID__ === "string" ? __OMNYO_PLUGIN_ID__ : undefined;

  const props: PortalScopeProps = {
    "data-omnyo-portaled-overlay": "",
    "data-omnyo-plugin-root": "",
  };

  if (pluginId !== undefined) props["data-omnyo-plugin"] = pluginId;

  return props;
}
