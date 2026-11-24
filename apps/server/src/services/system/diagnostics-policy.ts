import { getAppSettings } from "@omnyo/db";
import type { AppDeps } from "../../types.js";

export function effectiveCrashReportsEnabled(
  deps: Pick<AppDeps, "config" | "db">,
): boolean {
  return (
    !deps.config.isDevelopment &&
    Boolean(deps.config.errorReportingDsn?.trim()) &&
    getAppSettings(deps.db).crashReportsEnabled
  );
}
