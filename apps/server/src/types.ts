import type { ServerCommandMetadata } from "./services/skills/command-metadata.js";
import type { ProjectCommandCatalogs } from "./services/threads/project-command-catalogs.js";
import type { CustomProviderModel } from "@omnyo/config/managed-app-config";
import type { DbConnection } from "@omnyo/db";
import type { SecretVault } from "@omnyo/secret-storage";
import type { FeatureFlags, ProviderNativeSkillRoots } from "@omnyo/domain";
import type { Logger } from "@omnyo/logger";
import type { PendingInteractionLifecycle } from "./services/interactions/pending-interactions.js";
import type { MachineAuthService } from "./services/machine-auth.js";
import type { AppUpdateService } from "./services/system/app-update.js";
import type { AppVersionService } from "./services/system/app-version.js";
import type { OmnyoAppManagedConfigReloader } from "./services/system/managed-app-config.js";
import type { TelemetryService } from "./services/system/telemetry.js";
import type { TerminalSessionLifecycle } from "./services/terminals/terminal-session-lifecycle.js";
import type { LifecycleDedupers } from "./lifecycle-dedupers.js";
import type { NotificationHub } from "./ws/hub.js";
import type { WatchInterestCoordinator } from "./ws/watch-interests.js";
import type { WorkspaceReadCaches } from "./services/environments/workspace-read-cache.js";
import type { HostSharedPortCoordinator } from "./ws/host-shared-ports.js";
import type { SkillTreeRegistry } from "./services/skills/injected-skills.js";
import type { ProviderRegistryService } from "./services/providers/provider-registry.js";
import type { AiServiceRegistry } from "./services/ai/ai-service-registry.js";
import type { PluginHostArtifactRegistry } from "./services/plugins/plugin-host-artifact-registry.js";
import type { ProviderNativeRootsCache } from "./services/providers/native-roots.js";

export type ServerLogger = Pick<Logger, "debug" | "error" | "info" | "warn">;

export interface ServerRuntimeConfig {
  appAliasOrigins: string[];
  appVersion: string;
  builtinSkillsRootPath: string;
  customModels: CustomProviderModel[];
  dataDir: string;
  featureFlags: FeatureFlags;
  hostDaemonPort: number;
  inheritedSkillsRootPaths: string[];
  isDevelopment: boolean;
  performanceDiagnosticsAvailable: boolean;
  serverPort: number;
  sharedSkillRoots: ProviderNativeSkillRoots;
  appUrl?: string;
  devAppPort?: number;
  errorReportingDsn?: string;
  launchId?: string;
}

export interface AppDeps {
  commandCatalogs: ProjectCommandCatalogs;
  commandMetadata: ServerCommandMetadata;
  config: ServerRuntimeConfig;
  db: DbConnection;
  hub: NotificationHub;
  lifecycleDedupers: LifecycleDedupers;
  logger: ServerLogger;
  machineAuth: MachineAuthService;
  pendingInteractions: PendingInteractionLifecycle;
  providerRegistry: ProviderRegistryService;
  pluginHostArtifacts: PluginHostArtifactRegistry;
  providerNativeRoots: ProviderNativeRootsCache;
  aiServices: AiServiceRegistry;
  skillTreeRegistry: SkillTreeRegistry;
  telemetry: TelemetryService;
  terminalSessions: TerminalSessionLifecycle;
  vault: SecretVault;
  watchInterests: WatchInterestCoordinator;
  sharedPorts: HostSharedPortCoordinator;
  workspaceReadCaches: WorkspaceReadCaches;
}

export interface ServerAppDeps extends AppDeps {
  appUpdate: AppUpdateService;
  appVersion: AppVersionService;
  managedAppConfig: OmnyoAppManagedConfigReloader;
}

export type WorkSessionDeps = Pick<
  AppDeps,
  | "config"
  | "db"
  | "hub"
  | "logger"
  | "lifecycleDedupers"
  | "machineAuth"
  | "providerRegistry"
  | "pluginHostArtifacts"
  | "aiServices"
  | "skillTreeRegistry"
  | "telemetry"
  | "vault"
>;

export type LoggedWorkSessionDeps = WorkSessionDeps & Pick<AppDeps, "logger">;

export type LoggedPendingInteractionWorkSessionDeps = WorkSessionDeps &
  Pick<AppDeps, "logger" | "pendingInteractions" | "terminalSessions">;
