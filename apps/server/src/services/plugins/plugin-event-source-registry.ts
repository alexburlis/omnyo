import type { PluginEventSourceDeclaration } from "@omnyo/plugin-sdk";
import type { PluginHookInvocation } from "./plugin-hook-registry.js";

export interface PluginEventSourceRecord {
  pluginId: string;
  source: PluginEventSourceDeclaration;
}

export interface PluginEventSourceBridge {
  list(): PluginEventSourceRecord[];
  invoke<T>(
    record: PluginEventSourceRecord,
    label: string,
    run: () => Promise<T>,
  ): Promise<PluginHookInvocation<T>>;
}

let bridge: PluginEventSourceBridge | undefined;

export function setPluginEventSourceBridge(
  value: PluginEventSourceBridge | undefined,
): void {
  bridge = value;
}

export function listPluginEventSources(): PluginEventSourceRecord[] {
  return bridge?.list() ?? [];
}

export async function invokePluginEventSource<T>(
  record: PluginEventSourceRecord,
  label: string,
  run: () => Promise<T>,
): Promise<PluginHookInvocation<T>> {
  if (bridge === undefined)
    return { ok: false, error: "plugin runtime is not available" };

  return bridge.invoke(record, label, run);
}
