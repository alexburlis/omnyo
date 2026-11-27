interface PortalScopeProps {
  "data-omnyo-portaled-overlay": "";
  "data-omnyo-plugin-root": "";
  "data-omnyo-plugin"?: string;
}

export function usePortalScopeProps(): PortalScopeProps {
  return {
    "data-omnyo-portaled-overlay": "",
    "data-omnyo-plugin-root": "",
    "data-omnyo-plugin": "workspace-github",
  };
}
