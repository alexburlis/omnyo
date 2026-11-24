import { captureActionableProviderFailures } from "../services/threads/provider-error-reporting.js";
import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
} from "@omnyo/server-contract";
import type { Hono } from "hono";
import { ApiError } from "../errors.js";
import type { AppDeps } from "../types.js";
import { requirePublicThread } from "../services/lib/entity-lookup.js";
import { actOnInbox, undoInboxMove } from "../services/inbox/actions.js";
import {
  inboxActorFromHeaders,
  type InboxActor,
} from "../services/inbox/actor.js";
import { collectInboxSnapshot } from "../services/inbox/collect.js";
import {
  acknowledgeOwnerMessage,
  declineRetry,
  settleProducer,
  startProducer,
} from "../services/inbox/engine.js";
import { inboxRootOf } from "../services/inbox/family.js";
import { createSharedInboxSnapshot } from "../services/inbox/shared-snapshot.js";
import {
  getWait,
  listThreadFailures,
  listConditions,
  listOpenWaits,
  type ProducerRow,
} from "../services/inbox/store.js";
import {
  agentEndWait,
  dispatchWake,
  listPendingEventKeys,
  metWaitCondition,
  rearmWait,
  registerWait,
  reportEvent,
  toWaitView,
  waitersOnSource,
} from "../services/inbox/waits.js";
import {
  checkEventKey,
  listEventSourceViews,
} from "../services/inbox/event-source-runner.js";
import { requireEventReporter } from "../services/inbox/event-sources.js";
import { buildThreadStatusChangeMetadata } from "../services/threads/thread-runtime-display.js";

import {
  acknowledgeFailure,
  requireFailureActor,
  toFailureView,
} from "../services/inbox/failure-acknowledgment.js";

export function requestInboxActor(context: {
  req: { header(name: string): string | undefined };
}): InboxActor {
  return inboxActorFromHeaders((name) => context.req.header(name));
}

export function acknowledgeOwnerMessageNow(
  deps: AppDeps,
  threadId: string,
): void {
  const handled = deps.db.transaction(
    (tx) => acknowledgeOwnerMessage(tx, { threadId, now: Date.now() }),
    { behavior: "immediate" },
  );

  if (handled.length > 0) notifyRoot(deps, threadId);
}

function toProducerView(producer: ProducerRow) {
  return {
    id: producer.id,
    threadId: producer.threadId,
    kind: producer.kind,
    label: producer.label,
    status: producer.status,
    heldUntil: producer.heldUntil,
    endedReason: producer.endedReason,
  };
}

function requirePluginActor(actor: InboxActor, what: string): string {
  if (actor.kind !== "plugin")
    throw new ApiError(403, "plugin_required", `Only a plugin can ${what}.`);

  return actor.pluginId;
}

function notifyRoot(deps: AppDeps, threadId: string): void {
  const rootId = inboxRootOf(deps.db, threadId)?.id ?? threadId;

  for (const id of new Set([threadId, rootId]))
    deps.hub.notifyThread(id, ["work-changed"]);
}

export function registerInboxRoutes(app: Hono, deps: AppDeps): void {
  const { get, post } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (message) =>
      new ApiError(400, "invalid_request", message),
  });

  const routes = publicApiRoutes.inbox;

  const sharedSnapshot = createSharedInboxSnapshot({
    hub: deps.hub,
    collect: (now) => collectInboxSnapshot(deps, now),
  });

  get(routes.snapshot, (context) => context.json(sharedSnapshot()));

  post(routes.act, async (context, input) =>
    context.json(await actOnInbox(deps, input, requestInboxActor(context))),
  );

  get(routes.pendingEvents, (context, input) => {
    requirePluginActor(requestInboxActor(context), "list pending events");

    return context.json({
      keys: listPendingEventKeys(deps.db, input.prefix),
    });
  });

  post(routes.reportEvent, async (context, input) => {
    requireEventReporter(
      requirePluginActor(requestInboxActor(context), "report an event"),
      input.key,
    );

    return context.json({
      resumed: await reportEvent(deps, {
        key: input.key,
        result: input.result,
        now: Date.now(),
      }),
    });
  });

  get(routes.eventSources, (context) =>
    context.json({ sources: listEventSourceViews(deps.db) }),
  );

  post(routes.checkEvent, async (context, input) =>
    context.json(
      await checkEventKey(deps, {
        key: input.key,
        owner: requestInboxActor(context).kind === "owner",
      }),
    ),
  );

  post(routes.undo, (context, input) =>
    context.json(
      undoInboxMove(deps, {
        moveId: input.moveId,
        actor: requestInboxActor(context),
        now: Date.now(),
      }),
    ),
  );

  get(routes.failures, (context) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    requireFailureActor(deps.db, thread.id, requestInboxActor(context));

    return context.json({
      failures: listThreadFailures(deps.db, thread.id).map(toFailureView),
    });
  });

  post(routes.acknowledgeFailure, (context, input) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));

    const { response, settledThread } = acknowledgeFailure(deps, {
      ...input,
      threadId: thread.id,
      failureId: context.req.param("failureId"),
      actor: requestInboxActor(context),
      now: Date.now(),
    });

    if (settledThread !== null)
      deps.hub.notifyThread(
        settledThread.id,
        ["status-changed"],
        buildThreadStatusChangeMetadata(deps, settledThread),
      );

    if (response.acknowledged) notifyRoot(deps, thread.id);

    return context.json(response);
  });

  get(routes.waits, (context) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    const waits = listOpenWaits(deps.db, [thread.id]);

    const conditions = listConditions(
      deps.db,
      waits.map((wait) => wait.id),
    );

    return context.json({
      waitingChatIds: [
        ...new Set(
          waitersOnSource(deps.db, thread.id)
            .filter(
              (wait) => wait.status === "live" || wait.status === "evaluating",
            )
            .map((wait) => wait.threadId),
        ),
      ],
      waits: waits.map((wait) => toWaitView(wait, conditions)),
    });
  });

  get(routes.wait, (context) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    const wait = getWait(deps.db, context.req.param("waitId"));

    if (wait === null || wait.threadId !== thread.id)
      throw new ApiError(404, "wait_not_found", "Wait not found");

    return context.json({
      wait: toWaitView(wait, listConditions(deps.db, [wait.id])),
      closedReason: wait.closedReason,
    });
  });

  post(routes.startProducer, (context, input) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));

    const pluginId = requirePluginActor(
      requestInboxActor(context),
      "own a producer",
    );

    const producer = deps.db.transaction(
      (tx) =>
        startProducer(tx, {
          threadId: thread.id,
          kind: input.kind,
          pluginId,
          label: input.label,
          now: Date.now(),
        }),
      { behavior: "immediate" },
    );

    notifyRoot(deps, thread.id);

    return context.json({
      producer: toProducerView(producer),
      receiptId: null,
    });
  });

  post(routes.declineRetry, (context, input) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    requirePluginActor(requestInboxActor(context), "decline a retry");

    const state = deps.db.transaction(
      (tx) =>
        declineRetry(tx, {
          threadId: thread.id,
          turnRequestId: input.turnRequestId,
          reason: input.reason,
          incident: input.incident,
          now: Date.now(),
        }),
      { behavior: "immediate" },
    );

    notifyRoot(deps, thread.id);
    captureActionableProviderFailures(deps.db, [thread.id]);

    return context.json({ state });
  });

  post(routes.settleProducer, (context, input) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));

    const pluginId = requirePluginActor(
      requestInboxActor(context),
      "own a producer",
    );

    const result = deps.db.transaction(
      (tx) =>
        settleProducer(tx, {
          threadId: thread.id,
          producerId: context.req.param("producerId"),
          pluginId,
          verdict: input.verdict,
          summary: input.summary,
          now: Date.now(),
        }),
      { behavior: "immediate" },
    );

    notifyRoot(deps, thread.id);

    return context.json({
      producer: toProducerView(result.producer),
      receiptId: result.receiptId,
    });
  });

  post(routes.registerWait, async (context, input) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    const now = Date.now();

    const result = registerWait(
      deps.db,
      {
        threadId: thread.id,
        key: input.key,
        forText: input.for,
        chats: input.chats,
        events: input.events,
        check: input.check,
        report: input.report,
        readiness: input.readiness,
        by: input.by,
        resume: input.resume,
        after: input.after,
      },
      requestInboxActor(context),
      now,
    );

    if (result.readyNow)
      await dispatchWake(deps, {
        waitId: result.wait.id,
        phase: "resume",
        now,
      });

    notifyRoot(deps, thread.id);

    return context.json({
      wait: toWaitView(result.wait, listConditions(deps.db, [result.wait.id])),
      existing: result.existing,
    });
  });

  post(routes.rearmWait, (context) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));

    const wait = rearmWait(
      deps.db,
      { threadId: thread.id, waitId: context.req.param("waitId") },
      Date.now(),
    );

    notifyRoot(deps, thread.id);

    return context.json({
      wait: toWaitView(wait, listConditions(deps.db, [wait.id])),
      proposed: false,
    });
  });

  post(routes.metWait, async (context, input) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    const now = Date.now();

    const { wait, readyNow } = metWaitCondition(
      deps.db,
      {
        threadId: thread.id,
        waitId: context.req.param("waitId"),
        condition: input.condition,
        result: input.result,
      },
      now,
    );

    if (readyNow)
      await dispatchWake(deps, { waitId: wait.id, phase: "resume", now });

    notifyRoot(deps, thread.id);

    return context.json({
      wait: toWaitView(wait, listConditions(deps.db, [wait.id])),
      proposed: false,
    });
  });

  for (const [route, how] of [
    [routes.doneWait, "done"],
    [routes.cancelWait, "cancel"],
  ] as const)
    post(route, (context) => {
      const thread = requirePublicThread(deps.db, context.req.param("id"));

      const { wait, proposed } = agentEndWait(
        deps.db,
        { threadId: thread.id, waitId: context.req.param("waitId"), how },
        requestInboxActor(context),
        Date.now(),
      );

      notifyRoot(deps, thread.id);

      return context.json({
        wait: toWaitView(wait, listConditions(deps.db, [wait.id])),
        proposed,
      });
    });
}
