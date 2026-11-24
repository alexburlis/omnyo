import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export type PluginProcessDataKind = "host-data" | "bridge-data";

export const PLUGIN_PROCESS_DATA_KINDS: readonly PluginProcessDataKind[] = [
  "host-data",
  "bridge-data",
];

export function safePluginSegment(pluginId: string): string {
  return encodeURIComponent(pluginId);
}

export async function ensurePluginProcessDataDir(args: {
  daemonDataDir: string;
  pluginId: string;
  kind: PluginProcessDataKind;
}): Promise<string> {
  const directory = join(
    args.daemonDataDir,
    "plugins",
    safePluginSegment(args.pluginId),
    args.kind,
  );

  await mkdir(directory, { recursive: true });

  return directory;
}
