import {
  derivePluginId,
  PLUGIN_SDK_MAJOR,
  PLUGIN_SDK_PACKAGE_NAME,
  PLUGIN_RUNTIME_ABI,
  PLUGIN_SDK_VERSION,
} from "@omnyo/domain";

export function createPluginArtifactMeta(args: {
  packageName: string;
  pluginVersion: string;
  coreVersion: string;
}) {
  return {
    sdkMajor: PLUGIN_SDK_MAJOR,
    sdkVersion: PLUGIN_SDK_VERSION,
    artifactFormatVersion: 2,
    sdkPackage: PLUGIN_SDK_PACKAGE_NAME,
    runtimeAbi: PLUGIN_RUNTIME_ABI,
    pluginId: derivePluginId(args.packageName),
    pluginVersion: args.pluginVersion,
    builtWith: {
      coreVersion: args.coreVersion,
      pluginSdkVersion: PLUGIN_SDK_VERSION,
    },
  } as const;
}
