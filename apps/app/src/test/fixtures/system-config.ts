import {
  defaultAppSettings,
  defaultAppTheme,
  defaultExperiments,
  defaultFeatureFlags,
} from "@omnyo/domain";
import type { SystemConfigResponse } from "@omnyo/server-contract";

export function makeSystemConfig(
  overrides: Partial<SystemConfigResponse> = {},
): SystemConfigResponse {
  return {
    commandDefaultsByProvider: {},
    serverAccess: {
      providers: [],
      defaultProviderId: "direct",
      effectiveUrl: null,
      urlSource: null,
    },
    generalSettings: defaultAppSettings,
    keybindings: [],
    defaultKeybindings: [],
    keybindingOverrides: [],
    experiments: defaultExperiments,
    performanceDiagnosticsAvailable: false,
    appearance: defaultAppTheme,
    customThemes: [],
    pluginThemes: [],
    featureFlags: defaultFeatureFlags,
    hostDaemonPort: null,
    localHelperPorts: [],
    serverUrl: "http://localhost:38886",
    primaryHostId: null,
    primaryHostPlatform: null,
    voiceTranscriptionEnabled: false,
    dataDir: "/tmp/omnyo-test",
    ...overrides,
  };
}
