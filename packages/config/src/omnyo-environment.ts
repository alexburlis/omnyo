const legacyConfigEnvironmentV1 = [
  ["BB_ACCOUNT_POOL_PARENT_TOKEN", "OMNYO_ACCOUNT_POOL_PARENT_TOKEN"],
  ["BB_ACCOUNT_POOL_PARENT_URL", "OMNYO_ACCOUNT_POOL_PARENT_URL"],
  ["BB_ACP_DYNAMIC_TOOLS", "OMNYO_ACP_DYNAMIC_TOOLS"],
  ["BB_ACP_DYNAMIC_TOOL_HOST", "OMNYO_ACP_DYNAMIC_TOOL_HOST"],
  ["BB_ACP_DYNAMIC_TOOL_PORT", "OMNYO_ACP_DYNAMIC_TOOL_PORT"],
  [
    "BB_ACP_DYNAMIC_TOOL_PROGRESS_INTERVAL_MS",
    "OMNYO_ACP_DYNAMIC_TOOL_PROGRESS_INTERVAL_MS",
  ],
  ["BB_ACP_DYNAMIC_TOOL_THREAD_ID", "OMNYO_ACP_DYNAMIC_TOOL_THREAD_ID"],
  ["BB_ACP_DYNAMIC_TOOL_TOKEN", "OMNYO_ACP_DYNAMIC_TOOL_TOKEN"],
  ["BB_AGENT_MEMORY_LIMIT_MIB", "OMNYO_AGENT_MEMORY_LIMIT_MIB"],
  ["BB_APP_INSTALL_KIND", "OMNYO_APP_INSTALL_KIND"],
  ["BB_APP_NPM_PREFIX", "OMNYO_APP_NPM_PREFIX"],
  ["BB_APP_SOURCE_COMMIT", "OMNYO_APP_SOURCE_COMMIT"],
  ["BB_APP_SOURCE_ORIGIN", "OMNYO_APP_SOURCE_ORIGIN"],
  ["BB_APP_SURFACE", "OMNYO_APP_SURFACE"],
  ["BB_APP_UPDATE_MODE", "OMNYO_APP_UPDATE_MODE"],
  ["BB_APP_UPDATE_SHIM_PROTOCOL", "OMNYO_APP_UPDATE_SHIM_PROTOCOL"],
  ["BB_APP_URL", "OMNYO_APP_URL"],
  ["BB_APP_VERSION", "OMNYO_APP_VERSION"],
  ["BB_AUTOMATION_ID", "OMNYO_AUTOMATION_ID"],
  ["BB_AUTOMATION_RUN_ID", "OMNYO_AUTOMATION_RUN_ID"],
  ["BB_AUTOMATION_TEST_TOKEN", "OMNYO_AUTOMATION_TEST_TOKEN"],
  ["BB_BRIDGE_DIR", "OMNYO_BRIDGE_DIR"],
  ["BB_CLAUDE_CODE_EXECUTABLE", "OMNYO_CLAUDE_CODE_EXECUTABLE"],
  ["BB_CLI", "OMNYO_CLI"],
  ["BB_CLI_DIR", "OMNYO_CLI_DIR"],
  ["BB_CLI_ERROR_LOG", "OMNYO_CLI_ERROR_LOG"],
  ["BB_CLI_REEXEC", "OMNYO_CLI_REEXEC"],
  ["BB_CODEX_BRIDGE_APP_SERVER_ARGS", "OMNYO_CODEX_BRIDGE_APP_SERVER_ARGS"],
  [
    "BB_CODEX_BRIDGE_APP_SERVER_COMMAND",
    "OMNYO_CODEX_BRIDGE_APP_SERVER_COMMAND",
  ],
  ["BB_CONNECT_MACHINE_CREDENTIAL", "OMNYO_CONNECT_MACHINE_CREDENTIAL"],
  ["BB_CONNECT_MACHINE_ID", "OMNYO_CONNECT_MACHINE_ID"],
  ["BB_DATA_DIR", "OMNYO_DATA_DIR"],
  [
    "BB_DESKTOP_APPIMAGE_BRIDGE_RELATIVE_PATH",
    "OMNYO_DESKTOP_APPIMAGE_BRIDGE_RELATIVE_PATH",
  ],
  ["BB_DESKTOP_APP_URL", "OMNYO_DESKTOP_APP_URL"],
  ["BB_DESKTOP_ATTACH_WITHOUT_PROMPT", "OMNYO_DESKTOP_ATTACH_WITHOUT_PROMPT"],
  ["BB_DESKTOP_AUTO_UPDATE", "OMNYO_DESKTOP_AUTO_UPDATE"],
  ["BB_DESKTOP_BUILD_DATE", "OMNYO_DESKTOP_BUILD_DATE"],
  ["BB_DESKTOP_COMMIT", "OMNYO_DESKTOP_COMMIT"],
  ["BB_DESKTOP_ELECTRON_ARGS", "OMNYO_DESKTOP_ELECTRON_ARGS"],
  ["BB_DESKTOP_NODE_EXEC_PATH", "OMNYO_DESKTOP_NODE_EXEC_PATH"],
  ["BB_DESKTOP_OPEN_DEVTOOLS", "OMNYO_DESKTOP_OPEN_DEVTOOLS"],
  ["BB_DESKTOP_PLUGIN_SDK_VERSION", "OMNYO_DESKTOP_PLUGIN_SDK_VERSION"],
  ["BB_DESKTOP_RELEASE_CHANNEL", "OMNYO_DESKTOP_RELEASE_CHANNEL"],
  ["BB_DESKTOP_USER_DATA_DIR", "OMNYO_DESKTOP_USER_DATA_DIR"],
  ["BB_DESKTOP_VERSION", "OMNYO_DESKTOP_VERSION"],
  ["BB_ECHO_AGENT_EXECUTABLE", "OMNYO_ECHO_AGENT_EXECUTABLE"],
  ["BB_ECHO_PROVIDER_GREETING", "OMNYO_ECHO_PROVIDER_GREETING"],
  ["BB_ENROLLMENT", "OMNYO_ENROLLMENT"],
  ["BB_ENVIRONMENT_ID", "OMNYO_ENVIRONMENT_ID"],
  ["BB_EXTERNAL_URL", "OMNYO_EXTERNAL_URL"],
  ["BB_FF_PLACEHOLDER", "OMNYO_FF_PLACEHOLDER"],
  [
    "BB_FF_TIMELINE_WINDOW_EVENT_BUDGET",
    "OMNYO_FF_TIMELINE_WINDOW_EVENT_BUDGET",
  ],
  ["BB_HOST_DAEMON_AUTO_UPDATE", "OMNYO_HOST_DAEMON_AUTO_UPDATE"],
  ["BB_HOST_DAEMON_PORT", "OMNYO_HOST_DAEMON_PORT"],
  ["BB_HOST_DAEMON_SUPERVISED", "OMNYO_HOST_DAEMON_SUPERVISED"],
  ["BB_HOST_ENROLL_KEY", "OMNYO_HOST_ENROLL_KEY"],
  ["BB_HOST_ID", "OMNYO_HOST_ID"],
  ["BB_INHERITED_SKILLS_ROOTS", "OMNYO_INHERITED_SKILLS_ROOTS"],
  ["BB_LOG_LEVEL", "OMNYO_LOG_LEVEL"],
  ["BB_MACHINE_INSTALLER", "OMNYO_MACHINE_INSTALLER"],
  [
    "BB_MANAGED_DEV_BUILTIN_PLUGIN_HOT_RELOAD",
    "OMNYO_MANAGED_DEV_BUILTIN_PLUGIN_HOT_RELOAD",
  ],
  ["BB_MY_AGENT_EXECUTABLE", "OMNYO_MY_AGENT_EXECUTABLE"],
  ["BB_PI_BRIDGE_ARGS", "OMNYO_PI_BRIDGE_ARGS"],
  ["BB_PI_BRIDGE_COMMAND", "OMNYO_PI_BRIDGE_COMMAND"],
  ["BB_PI_BRIDGE_READINESS_TIMEOUT_MS", "OMNYO_PI_BRIDGE_READINESS_TIMEOUT_MS"],
  ["BB_PI_BRIDGE_SESSION_DIR", "OMNYO_PI_BRIDGE_SESSION_DIR"],
  ["BB_PI_CATALOG_IDLE_MS", "OMNYO_PI_CATALOG_IDLE_MS"],
  ["BB_PROCESS_PARENT_SECRET", "OMNYO_PROCESS_PARENT_SECRET"],
  ["BB_PROJECT_ID", "OMNYO_PROJECT_ID"],
  ["BB_QA_OPENAI_API_KEY", "OMNYO_QA_OPENAI_API_KEY"],
  ["BB_SERVER_BIND_HOST", "OMNYO_SERVER_BIND_HOST"],
  ["BB_SERVER_HEADERS", "OMNYO_SERVER_HEADERS"],
  ["BB_SERVER_LAUNCH_ID", "OMNYO_SERVER_LAUNCH_ID"],
  ["BB_SERVER_MOVE_ALLOW_LOOPBACK_URL", "OMNYO_SERVER_MOVE_ALLOW_LOOPBACK_URL"],
  ["BB_SERVER_MOVE_SERVICE_MANAGER", "OMNYO_SERVER_MOVE_SERVICE_MANAGER"],
  ["BB_SERVER_MOVE_TARGET_PORT", "OMNYO_SERVER_MOVE_TARGET_PORT"],
  ["BB_SERVER_PORT", "OMNYO_SERVER_PORT"],
  ["BB_SERVER_STARTUP_HOLD", "OMNYO_SERVER_STARTUP_HOLD"],
  ["BB_SERVER_URL", "OMNYO_SERVER_URL"],
  ["BB_STANDALONE_INSTANCE", "OMNYO_STANDALONE_INSTANCE"],
  ["BB_STANDALONE_PARENT_PID", "OMNYO_STANDALONE_PARENT_PID"],
  ["BB_TELEMETRY", "OMNYO_TELEMETRY"],
  ["BB_THREAD_ID", "OMNYO_THREAD_ID"],
  ["BB_THREAD_STORAGE", "OMNYO_THREAD_STORAGE"],
] as const;

function normalizeKey(key: string): string {
  return process.platform === "win32" ? key.toUpperCase() : key;
}

function readExactEnvironmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  let result: string | undefined;

  for (const [key, value] of Object.entries(env)) {
    if (normalizeKey(key) !== name || value === undefined) continue;

    if (result !== undefined && result !== value) {
      throw new Error(`Conflicting environment values for ${name}`);
    }

    result = value;
  }

  return result;
}

export function readEnvironmentValue(args: {
  env: NodeJS.ProcessEnv;
  name: string;
}): string | undefined {
  return readExactEnvironmentValue(args.env, args.name);
}

function readLegacyConfigPairValueV1(
  env: NodeJS.ProcessEnv,
  legacyName: string,
  canonicalName: string,
): string | undefined {
  const legacy = readExactEnvironmentValue(env, legacyName);
  const canonical = readExactEnvironmentValue(env, canonicalName);

  if (legacy !== undefined && canonical !== undefined && legacy !== canonical) {
    throw new Error(
      `Conflicting environment values for ${legacyName} and ${canonicalName}`,
    );
  }

  return canonical ?? legacy;
}

export function importLegacyConfigEnvironmentV1(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result = { ...env };

  for (const [legacyName, canonicalName] of legacyConfigEnvironmentV1) {
    const value = readLegacyConfigPairValueV1(env, legacyName, canonicalName);

    for (const key of Object.keys(result)) {
      if (
        normalizeKey(key) === legacyName ||
        normalizeKey(key) === canonicalName
      )
        delete result[key];
    }

    if (value !== undefined) result[canonicalName] = value;
  }

  for (const key of Object.keys(result)) {
    if (
      ["BB_POSTHOG_API_KEY", "OMNYO_POSTHOG_API_KEY"].includes(
        normalizeKey(key),
      )
    ) {
      if (result[key] === "") result.OMNYO_TELEMETRY = "false";
      delete result[key];
    }
  }

  return result;
}
