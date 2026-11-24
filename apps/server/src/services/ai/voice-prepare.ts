import { getAiServiceSelections } from "@omnyo/db";
import type { LoggedWorkSessionDeps } from "../../types.js";
import { resolvePrimaryHostId } from "../hosts/primary-host.js";
import { runtimeErrorLogFields } from "../lib/error-log-fields.js";
import type { AiServiceRegistration } from "./ai-service-registry.js";
import {
  abortable,
  AI_TASK_TIMEOUT_MS,
  aiTaskServices,
  linkedSignal,
} from "./ai-tasks.js";

type VoicePrepareDeps = Pick<
  LoggedWorkSessionDeps,
  "aiServices" | "config" | "db" | "logger"
>;

type VoicePrewarmDeps = VoicePrepareDeps & Pick<LoggedWorkSessionDeps, "hub">;

export type VoicePrepareReason = "requested" | "host-connected";

interface PrepareVoiceInputArgs {
  reason: VoicePrepareReason;
  signal?: AbortSignal;
}

const inFlightPrepares = new WeakMap<AiServiceRegistration, Promise<void>>();

export function prepareVoiceInput(
  deps: VoicePrepareDeps,
  args: PrepareVoiceInputArgs,
): void {
  if (args.signal?.aborted) return;

  const [service] = aiTaskServices(
    deps,
    "voice",
    getAiServiceSelections(deps.db).voice,
  );

  if (service === undefined || inFlightPrepares.has(service)) return;
  const prepare = service.experimental_prepare;

  if (prepare === null) return;
  const timeoutMs = AI_TASK_TIMEOUT_MS.voice;
  const link = linkedSignal(timeoutMs, args.signal);
  const startedAt = Date.now();
  const call = Promise.resolve().then(() => prepare({ signal: link.signal }));

  const settled = call.then(
    () => undefined,
    () => undefined,
  );

  inFlightPrepares.set(service, settled);
  void settled.then(() => {
    if (inFlightPrepares.get(service) === settled) {
      inFlightPrepares.delete(service);
    }
  });

  const fields = {
    task: "voice",
    pluginId: service.pluginId,
    serviceId: service.id,
    reason: args.reason,
  };

  void abortable(call, link.signal)
    .then(
      () => {
        deps.logger.info(
          { ...fields, durationMs: Date.now() - startedAt },
          "Voice input prepared",
        );
      },
      (error: unknown) => {
        if (link.timedOut()) {
          deps.logger.info(
            { ...fields, timeoutMs },
            "Voice input prepare timed out",
          );
        } else if (args.signal?.aborted) {
          deps.logger.info(fields, "Voice input prepare was cancelled");
        } else {
          deps.logger.warn(
            {
              ...fields,
              durationMs: Date.now() - startedAt,
              ...runtimeErrorLogFields(deps.config, error),
            },
            "Voice input prepare failed",
          );
        }
      },
    )
    .finally(() => link.dispose());
}

export function installVoiceInputPrewarm(deps: VoicePrewarmDeps): {
  stop(): void;
} {
  const controller = new AbortController();
  let preparedSessionId: string | null = null;

  const prepareNewPrimarySession = (): void => {
    const primaryHostId = resolvePrimaryHostId(deps);

    const sessionId =
      primaryHostId === null
        ? null
        : deps.hub.getDaemonSessionIdForHost(primaryHostId);

    if (sessionId === null || sessionId === preparedSessionId) return;
    preparedSessionId = sessionId;
    prepareVoiceInput(deps, {
      reason: "host-connected",
      signal: controller.signal,
    });
  };

  prepareNewPrimarySession();

  const unsubscribe = deps.hub.onChangedMessage((message) => {
    if (
      message.entity === "host" &&
      message.changes.includes("host-connected")
    ) {
      prepareNewPrimarySession();
    }
  });

  return {
    stop() {
      unsubscribe();
      controller.abort();
    },
  };
}
