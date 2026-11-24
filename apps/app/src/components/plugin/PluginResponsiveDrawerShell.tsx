import type { ExperimentalResponsiveDrawerShellProps } from "@omnyo/plugin-sdk/app";
import { ResponsiveDrawerShell } from "@omnyo/shared-ui/responsive-overlay";
import { usePluginId } from "./plugin-context";

export function PluginResponsiveDrawerShell(
  props: ExperimentalResponsiveDrawerShellProps,
) {
  const pluginId = usePluginId();

  return <ResponsiveDrawerShell {...props} portalPluginId={pluginId} />;
}
