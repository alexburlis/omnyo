import {
  isStandaloneBuiltinClearCommand,
  isStandaloneBuiltinCompactCommand,
  type Thread,
} from "@omnyo/domain";
import type {
  SendMessageRequest,
  SendMessageResponse,
} from "@omnyo/server-contract";
import { ApiError } from "../../errors.js";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { attemptDispatch } from "./dispatch-attempt.js";
import { requireThreadCommandEnvironment } from "./thread-command-environment.js";
import { assertThreadHostAcceptsWork } from "./thread-host-admission.js";
import { runWithTurnTrace } from "../system/turn-trace.js";
import { INBOX_WAIT_MARKER_PATTERN } from "@omnyo/domain";
import { inboxRootOf } from "../inbox/family.js";
import { dispatchWake, routeMarkerDelivery } from "../inbox/waits.js";

interface AcceptThreadSendRequestArgs {
  payload: SendMessageRequest;
  thread: Thread;
}

export async function acceptThreadSendRequest(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: AcceptThreadSendRequestArgs,
): Promise<SendMessageResponse> {
  assertThreadHostAcceptsWork(deps.db, args.thread);
  const { compactFirst, ...request } = args.payload;

  if (isStandaloneBuiltinClearCommand(request.input)) {
    if (compactFirst) throwInvalidCompactFirst("cannot clear the context");

    const environment = await requireThreadCommandEnvironment(deps, {
      thread: args.thread,
    });

    await attemptDispatch(deps, {
      thread: args.thread,
      payload: request,
      source: { kind: "operation", environment },
      queuePayload: { kind: "inline" },
      pluginSubmission: null,
      systemNotice: null,
      origin: null,
      originPluginId: null,
      startedOnBehalfOf: null,
      trigger: "user",
    });

    return { ok: true, delivery: "sent" };
  }

  if (compactFirst) {
    if (isStandaloneBuiltinCompactCommand(request.input)) {
      throwInvalidCompactFirst("needs a message to send after compacting");
    }

    if (request.sendAt !== undefined) {
      throwInvalidCompactFirst("cannot be scheduled with sendAt");
    }

    if (request.mode === "steer") {
      throwInvalidCompactFirst("cannot steer a turn");
    }
  }

  const payload: SendMessageRequest = compactFirst
    ? { ...request, mode: "queue-if-active", compactFirst }
    : request;

  const delivered = await routeWaitResultDelivery(deps, args.thread, payload);

  if (delivered !== null) return delivered;

  const outcome = await runWithTurnTrace(
    deps,
    { threadId: args.thread.id },
    () =>
      attemptDispatch(deps, {
        thread: args.thread,
        payload,
        source: { kind: "inline" },
        queuePayload: { kind: "inline" },
        pluginSubmission: payload.pluginSubmission ?? null,
        origin: null,
        originPluginId: null,
        systemNotice: null,
        startedOnBehalfOf: null,
        trigger: "user",
      }),
  );

  if (outcome.kind === "dispatched") {
    return { ok: true, delivery: "sent" };
  }

  return {
    ok: true,
    delivery: "queued",
    queuedMessage: outcome.entry,
  };
}

function throwInvalidCompactFirst(reason: string): never {
  throw new ApiError(400, "invalid_request", `compactFirst ${reason}`);
}

async function routeWaitResultDelivery(
  deps: LoggedPendingInteractionWorkSessionDeps,
  thread: Thread,
  payload: SendMessageRequest,
): Promise<SendMessageResponse | null> {
  const text = payload.input
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");

  if (!INBOX_WAIT_MARKER_PATTERN.test(text)) return null;

  if (payload.senderThreadId === undefined || payload.senderThreadId === null)
    throw new ApiError(
      400,
      "invalid_request",
      "Deliver a wait result with omnyo thread tell from the source chat.",
    );

  const now = Date.now();

  const routed = routeMarkerDelivery(deps.db, {
    targetThreadId: thread.id,
    senderThreadId: payload.senderThreadId,
    text,
    now,
  });

  for (const waitId of routed.readyWaitIds)
    await dispatchWake(deps, { waitId, phase: "resume", now });

  deps.hub.notifyThread(inboxRootOf(deps.db, thread.id)?.id ?? thread.id, [
    "work-changed",
  ]);

  return { ok: true, delivery: "stored", late: routed.lateWaitId !== null };
}
