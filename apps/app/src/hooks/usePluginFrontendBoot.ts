import { useEffect } from "react";
import { matchPath } from "react-router-dom";
import {
  PLUGIN_FRONTEND_BOOT_TIMEOUT_MS,
  requestBrowserIdle,
  scheduleDeferredPluginFrontendBoot,
} from "../lib/plugin-frontend-boot-schedule";
import { markPluginFrontendSettleFloorReached } from "../lib/plugin-frontend-boot-state";
import { bootPluginFrontends } from "../lib/plugin-frontend-lazy";
import { whenRouteContentPainted } from "../lib/route-content-paint";
import {
  getPluginPanelRoutePluginId,
  PROJECTLESS_THREAD_DETAIL_ROUTE_PATH,
  THREAD_DETAIL_ROUTE_PATH,
} from "../lib/route-paths";
import { useSystemConfig } from "./queries/system-queries";

export const PLUGIN_FRONTEND_SETTLE_FLOOR_MS = 15_000;

export function usePluginFrontendBoot(): void {
  const systemConfig = useSystemConfig();
  const resolved = systemConfig.data !== undefined;
  useEffect(() => {
    if (!resolved) return;
    const routePluginId = getPluginPanelRoutePluginId(window.location.pathname);

    const pathname = window.location.pathname;

    const isThreadRoute =
      matchPath(THREAD_DETAIL_ROUTE_PATH, pathname) !== null ||
      matchPath(PROJECTLESS_THREAD_DETAIL_ROUTE_PATH, pathname) !== null;

    if (routePluginId !== null || isThreadRoute) {
      void bootPluginFrontends();

      return;
    }

    return scheduleDeferredPluginFrontendBoot(
      () => void bootPluginFrontends(),
      {
        whenRoutePainted: whenRouteContentPainted,
        requestIdle: requestBrowserIdle,
        setTimeout: (callback, ms) => window.setTimeout(callback, ms),
        clearTimeout: (id) => window.clearTimeout(id),
        timeoutMs: PLUGIN_FRONTEND_BOOT_TIMEOUT_MS,
      },
    );
  }, [resolved]);
  useEffect(() => {
    const timeout = window.setTimeout(
      markPluginFrontendSettleFloorReached,
      PLUGIN_FRONTEND_SETTLE_FLOOR_MS,
    );

    return () => window.clearTimeout(timeout);
  }, []);
}
