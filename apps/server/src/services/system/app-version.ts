import type { AppInstallKind } from "@omnyo/config/app-install";
import type { SystemVersionResponse } from "@omnyo/server-contract";
import type { ServerRuntimeConfig } from "../../types.js";

export interface AppVersionService {
  getSystemVersion(
    args?: AppVersionGetSystemVersionArgs,
  ): Promise<SystemVersionResponse>;
}

interface AppVersionGetSystemVersionArgs {
  forceRefresh?: boolean;
}

interface CreateAppVersionServiceArgs {
  installKind: AppInstallKind | null;
  sourceCommit: string | null;
  config: Pick<ServerRuntimeConfig, "appVersion" | "isDevelopment">;
}

export function createAppVersionService(
  args: CreateAppVersionServiceArgs,
): AppVersionService {
  return {
    async getSystemVersion(): Promise<SystemVersionResponse> {
      return {
        currentCommit: args.installKind === "source" ? args.sourceCommit : null,
        installKind: args.installKind,
        currentVersion: args.config.appVersion,
        latestVersion: null,
        source: "private",
        updateAvailable: false,
        isDevelopment: args.config.isDevelopment,
        upgradeCommand: "Use the verified private release installer",
      };
    },
  };
}
