import {
  readRetryDiagnostic,
  retryDiagnosticContract,
  type RetryAvailabilityLookup,
} from "./src/diagnostics.js";
import {
  retryAvailabilityMethod,
  retryAvailabilitySchema,
} from "./src/retry-contract.js";
import type { PluginApi, PluginTurnFailedEvent } from "@omnyo/plugin-sdk";
import { registerProviderRetryCli } from "./src/cli.js";
import {
  DEFAULT_MAXIMUM_WAIT_MS,
  decideRetry,
  isRateLimitFailure,
  verifiedResetAtMs,
} from "./src/retry-policy.js";

const MAXIMUM_WAIT_OPTIONS = ["6 hours", "24 hours", "No limit"] as const;

function maximumWaitMs(value: string): number | null {
  switch (value) {
    case "6 hours":
      return DEFAULT_MAXIMUM_WAIT_MS;
    case "24 hours":
      return 24 * 60 * 60 * 1_000;
    case "No limit":
      return null;
    default:
      throw new Error(
        `Unsupported maximum provider retry wait: ${String(value)}`,
      );
  }
}

export default async function plugin(api: PluginApi) {
  async function incidentOf(
    event: PluginTurnFailedEvent,
    availability: RetryAvailabilityLookup,
    reason: string,
  ) {
    const thread = await api.sdk.threads.get({ threadId: event.threadId });
    const providerId = event.rateLimits?.providerId ?? thread.providerId;

    const account =
      availability.kind === "not-routed"
        ? thread.environmentId === null
          ? null
          : `host:${(await api.sdk.environments.get({ environmentId: thread.environmentId })).hostId}`
        : "account-pool";

    if (account === null) return null;

    return {
      key: `${providerId}:${event.errorInfo?.category ?? "rate-limit"}:${account}`,
      label: `${providerId} usage limit`.slice(0, 60),
      resetAt:
        reason === "beyond-maximum-wait"
          ? verifiedResetAtMs(event, availability)
          : null,
    };
  }

  const settings = api.settings.define({
    maximumWait: {
      type: "select",
      label: "Maximum automatic wait",
      description:
        "Longest wait for a subscription limit to reset, and roughly how long to keep retrying a model at capacity every 15 minutes.",
      options: [...MAXIMUM_WAIT_OPTIONS],
      default: "No limit",
    },
  });

  const initialSettings = await settings.get();
  let maximumWait = maximumWaitMs(initialSettings.maximumWait);
  settings.onChange((next) => {
    maximumWait = maximumWaitMs(next.maximumWait);
  });

  api.rpc.register(retryDiagnosticContract, {
    "decision.get": ({ threadId }) => readRetryDiagnostic(api, threadId),
  });
  api.events.on("turn.failed", async (event) => {
    let availability: RetryAvailabilityLookup = { kind: "not-routed" };

    if (isRateLimitFailure(event)) {
      const sources = await api.sdk.plugins.experimental_discoverRpc({
        method: retryAvailabilityMethod,
      });

      for (const source of sources) {
        try {
          const result = await api.sdk.plugins.callRpc({
            pluginId: source.pluginId,
            method: retryAvailabilityMethod,
            input: { threadId: event.threadId, requestId: event.requestId },
            outputSchema: retryAvailabilitySchema,
            signal: AbortSignal.timeout(5_000),
          });

          if (result.kind !== "not-routed") {
            availability = result;
            break;
          }
        } catch (error) {
          api.log.warn(
            `Retry availability failed for ${event.threadId}: ${String(error)}`,
          );
          availability = { kind: "lookup-failed" };
        }
      }
    }

    const decision = decideRetry({
      availability,
      failure: event,
      maximumWaitMs: maximumWait,
      now: Date.now(),
      random: Math.random(),
    });

    const recordDecision = () =>
      api.storage.kv.set(`decision:${event.threadId}`, {
        requestId: event.requestId,
        observedAt: Date.now(),
        availability,
        decision,
      });

    if (decision.kind === "decline") {
      await recordDecision();
      api.log.info(
        `Automatic retry skipped for ${event.threadId}: ${decision.reason}${availability.kind === "unavailable" ? ` (${availability.reason})` : ""}.`,
      );

      try {
        await api.sdk.experimental_inbox.declineRetry({
          threadId: event.threadId,
          turnRequestId: event.requestId,
          reason: decision.reason,
          incident: isRateLimitFailure(event)
            ? await incidentOf(event, availability, decision.reason)
            : null,
        });
      } catch (error) {
        api.log.warn(
          `Retry decline not recorded for ${event.threadId}; Omnyo decides after its window: ${String(error)}`,
        );
      }

      return;
    }

    await api.sdk.threads.retry({
      threadId: event.threadId,
      turnRequestId: event.requestId,
      sendAt: decision.sendAt,
      reason: decision.reason,
    });
    await recordDecision();
  });

  registerProviderRetryCli(api);
}
