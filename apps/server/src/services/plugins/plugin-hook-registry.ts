import type { PluginHookHandler, PluginHookName } from "@omnyo/plugin-sdk";
import { errorMessage } from "../lib/error-log-fields.js";

export interface PluginHookRegistration<K extends PluginHookName> {
  pluginId: string;
  handler: PluginHookHandler<K>;
}

export type PluginHookInvocation<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export async function invokePluginInline<T>(
  run: () => Promise<T>,
): Promise<PluginHookInvocation<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export const DEFAULT_PLUGIN_HOOK_TIMEOUT_MS = 10_000;

export async function invokeBridgedProvider<Record, T>(
  bridge:
    | {
        invokeProvider<U>(
          record: Record,
          label: string,
          run: () => Promise<U>,
        ): Promise<PluginHookInvocation<U>>;
      }
    | undefined,
  record: Record,
  label: string,
  run: () => Promise<T>,
): Promise<PluginHookInvocation<T>> {
  if (bridge === undefined) {
    return { ok: false, error: "plugin runtime is not available" };
  }

  return bridge.invokeProvider(record, label, run);
}

export interface PluginHookProvider {
  listHooks<K extends PluginHookName>(hook: K): PluginHookRegistration<K>[];

  invokeHook<T>(
    registration: PluginHookRegistration<PluginHookName>,
    label: string,
    run: () => Promise<T>,
  ): Promise<PluginHookInvocation<T>>;

  readonly decisionTimeoutMs: number;
}

let provider: PluginHookProvider | undefined;

export function setPluginHookProvider(
  next: PluginHookProvider | undefined,
): void {
  provider = next;
}

export function pluginHookProvider(): PluginHookProvider | undefined {
  return provider;
}
