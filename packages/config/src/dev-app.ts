import {
  readEnvVarWithDefault,
  readOptionalEnvVar,
  resolveEnvLoader,
  type EnvLoaderArgs,
} from "./env.js";
import {
  OMNYO_DEV_APP_HOST_ENV,
  OMNYO_DEV_APP_PORT_ENV,
  DEFAULT_OMNYO_DEV_APP_HOST,
} from "./env-vars.js";
import { assignIfDefined } from "./objects.js";

interface DevAppConfig {
  OMNYO_DEV_APP_HOST: string;
  OMNYO_DEV_APP_PORT?: number;
}

type LoadDevAppConfigArgs = EnvLoaderArgs;

export function loadDevAppConfig(
  args: LoadDevAppConfigArgs = {},
): DevAppConfig {
  const loader = resolveEnvLoader(args);

  const config: DevAppConfig = {
    OMNYO_DEV_APP_HOST: readEnvVarWithDefault({
      context: loader.context,
      defaultValue: DEFAULT_OMNYO_DEV_APP_HOST,
      definition: OMNYO_DEV_APP_HOST_ENV,
      env: loader.env,
    }),
  };

  const appPort = readOptionalEnvVar({
    context: loader.context,
    definition: OMNYO_DEV_APP_PORT_ENV,
    env: loader.env,
  });

  assignIfDefined({
    key: "OMNYO_DEV_APP_PORT",
    target: config,
    value: appPort,
  });

  return config;
}
