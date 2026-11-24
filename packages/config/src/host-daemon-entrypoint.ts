import {
  readOptionalEnvVar,
  resolveEnvLoader,
  type EnvLoaderArgs,
} from "./env.js";
import {
  OMNYO_SERVER_HEADERS_ENV,
  OMNYO_BRIDGE_DIR_ENV,
  OMNYO_CLI_DIR_ENV,
  OMNYO_CONNECT_MACHINE_CREDENTIAL_ENV,
  OMNYO_HOST_ENROLL_KEY_ENV,
  OMNYO_HOST_DAEMON_AUTO_UPDATE_ENV,
  OMNYO_HOST_DAEMON_SUPERVISED_ENV,
  OMNYO_HOST_ID_ENV,
  OMNYO_WINDOWS_SERVICE_INSTALL_ENV,
} from "./env-vars.js";
import { assignIfDefined } from "./objects.js";

export interface HostDaemonEntrypointConfig {
  OMNYO_BRIDGE_DIR?: string;
  OMNYO_CLI_DIR?: string;
  OMNYO_SERVER_HEADERS?: Record<string, string>;
  OMNYO_HOST_ENROLL_KEY?: string;
  OMNYO_HOST_DAEMON_AUTO_UPDATE?: boolean;
  OMNYO_HOST_DAEMON_SUPERVISED?: boolean;
  OMNYO_HOST_ID?: string;
  OMNYO_WINDOWS_SERVICE_INSTALL?: boolean;
}

type LoadHostDaemonEntrypointConfigArgs = EnvLoaderArgs;

export function loadHostDaemonEntrypointConfig(
  args: LoadHostDaemonEntrypointConfigArgs = {},
): HostDaemonEntrypointConfig {
  const loader = resolveEnvLoader(args);
  const config: HostDaemonEntrypointConfig = {};

  const bridgeDir = readOptionalEnvVar({
    context: loader.context,
    definition: OMNYO_BRIDGE_DIR_ENV,
    env: loader.env,
  });

  const cliDir = readOptionalEnvVar({
    context: loader.context,
    definition: OMNYO_CLI_DIR_ENV,
    env: loader.env,
  });

  const enrollKey = readOptionalEnvVar({
    context: loader.context,
    definition: OMNYO_HOST_ENROLL_KEY_ENV,
    env: loader.env,
  });

  const autoUpdate = readOptionalEnvVar({
    context: loader.context,
    definition: OMNYO_HOST_DAEMON_AUTO_UPDATE_ENV,
    env: loader.env,
  });

  const supervised = readOptionalEnvVar({
    context: loader.context,
    definition: OMNYO_HOST_DAEMON_SUPERVISED_ENV,
    env: loader.env,
  });

  const windowsServiceInstall = readOptionalEnvVar({
    context: loader.context,
    definition: OMNYO_WINDOWS_SERVICE_INSTALL_ENV,
    env: loader.env,
  });

  const machineCredential = readOptionalEnvVar({
    context: loader.context,
    definition: OMNYO_CONNECT_MACHINE_CREDENTIAL_ENV,
    env: loader.env,
  });

  const serverHeaders =
    readOptionalEnvVar({
      context: loader.context,
      definition: OMNYO_SERVER_HEADERS_ENV,
      env: loader.env,
    }) ??
    (machineCredential === undefined
      ? undefined
      : { "x-omnyo-connect-machine": machineCredential });

  const hostId = readOptionalEnvVar({
    context: loader.context,
    definition: OMNYO_HOST_ID_ENV,
    env: loader.env,
  });

  assignIfDefined({
    key: "OMNYO_BRIDGE_DIR",
    target: config,
    value: bridgeDir,
  });
  assignIfDefined({
    key: "OMNYO_CLI_DIR",
    target: config,
    value: cliDir,
  });
  assignIfDefined({
    key: "OMNYO_SERVER_HEADERS",
    target: config,
    value: serverHeaders,
  });
  assignIfDefined({
    key: "OMNYO_HOST_DAEMON_AUTO_UPDATE",
    target: config,
    value: autoUpdate,
  });
  assignIfDefined({
    key: "OMNYO_HOST_DAEMON_SUPERVISED",
    target: config,
    value: supervised,
  });
  assignIfDefined({
    key: "OMNYO_HOST_ENROLL_KEY",
    target: config,
    value: enrollKey,
  });
  assignIfDefined({
    key: "OMNYO_HOST_ID",
    target: config,
    value: hostId,
  });
  assignIfDefined({
    key: "OMNYO_WINDOWS_SERVICE_INSTALL",
    target: config,
    value: windowsServiceInstall,
  });

  return config;
}
