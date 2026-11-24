import type { PluginAppBundleSnapshot } from "./app-bundle.js";
import {
  threadDispatchReadinessSchema,
  type ThreadDispatchReadinessInput,
  type ThreadWithIncludesResponse,
} from "@omnyo/server-contract";
import { getHost } from "@omnyo/db";
import type { Thread } from "@omnyo/domain";
import type { AppDeps } from "../../types.js";
import { threadTargetHostId } from "../threads/dispatch-attempt.js";
import type { PluginApiHandle } from "./plugin-api.js";
import type { LoadedPlugin } from "./plugin-service-internal.js";
import type { PluginService } from "./plugin-service.js";

export async function readPluginThreadBootstrap(
  deps: Pick<AppDeps, "db">,
  plugins: Iterable<readonly [string, LoadedPlugin]>,
  thread: Thread,
  invoke: PluginService["invokeRpcHandler"],
  signal?: AbortSignal,
): Promise<NonNullable<ThreadWithIncludesResponse["experimental_pluginData"]>> {
  return Promise.all(
    [...plugins].flatMap(([pluginId, plugin]) =>
      [...plugin.handle.rpcHandlers.entries()].flatMap(([method, handler]) =>
        handler.threadBootstrap
          ? [
              invoke(
                plugin,
                method,
                handler,
                handler.dispatchReadiness
                  ? dispatchReadinessInput(deps, thread)
                  : { threadId: thread.id },
                { kind: "client" },
                signal ?? null,
              ).then((outcome) => {
                if (!handler.dispatchReadiness)
                  return { pluginId, method, outcome };

                if (!outcome.ok)
                  return {
                    pluginId,
                    method,
                    dispatchReadiness: true as const,
                    outcome,
                  };

                const readiness = threadDispatchReadinessSchema.safeParse(
                  outcome.result,
                );

                return {
                  pluginId,
                  method,
                  dispatchReadiness: true as const,
                  outcome: readiness.success
                    ? { ok: true as const, result: readiness.data }
                    : {
                        ok: false as const,
                        error: {
                          code: "invalid_output" as const,
                          message:
                            "Dispatch readiness must return a valid proceed or wait decision.",
                        },
                      },
                };
              }),
            ]
          : [],
      ),
    ),
  );
}

function dispatchReadinessInput(
  deps: Pick<AppDeps, "db">,
  thread: Thread,
): ThreadDispatchReadinessInput {
  const hostId = threadTargetHostId(deps, thread);
  const host = hostId === null ? null : getHost(deps.db, hostId);

  return {
    thread: { id: thread.id, status: thread.status },
    host: host === null ? null : { id: host.id, name: host.name },
  };
}

export function getPluginThreadBootstrapAssetUrls(
  plugins: Iterable<
    readonly [string, { handle: Pick<PluginApiHandle, "rpcHandlers"> }]
  >,
  bundles: ReadonlyMap<string, PluginAppBundleSnapshot>,
): string[] {
  const urls = new Set<string>();

  for (const [id, plugin] of plugins) {
    if (
      ![...plugin.handle.rpcHandlers.values()].some(
        (handler) => handler.threadBootstrap && !handler.dispatchReadiness,
      )
    )
      continue;
    const snapshot = bundles.get(id);
    const bundle = snapshot?.state.bundle;

    if (snapshot?.assets && bundle?.compatible) urls.add(bundle.jsUrl);
  }

  return [...urls];
}
