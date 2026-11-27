declare const __OMNYO_PLUGIN_ID__: string | undefined;

interface PortalScopeProps {
  "data-omnyo-portaled-overlay": "";
  "data-omnyo-plugin-root": "";
  "data-omnyo-plugin"?: string;
}

export function usePortalScopeProps(): PortalScopeProps {
  const props: PortalScopeProps = {
    "data-omnyo-portaled-overlay": "",
    "data-omnyo-plugin-root": "",
  };

  if (__OMNYO_PLUGIN_ID__ !== undefined) props["data-omnyo-plugin"] = __OMNYO_PLUGIN_ID__;

  return props;
}
