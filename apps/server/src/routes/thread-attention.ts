import { eq } from "drizzle-orm";
import {
  threadCallbacks,
  threads,
  listCallbackWaiterIds,
  listThreadQuestions,
  listThreadCallbacks,
  listThreadCallbacksByThread,
} from "@omnyo/db";
import type { ThreadCallback, ThreadChangeKind } from "@omnyo/domain";
import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
} from "@omnyo/server-contract";
import type { Hono } from "hono";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import { requirePublicThread } from "../services/lib/entity-lookup.js";
import {
  executeAttentionCommand,
  notifyThreadAttentionChanged,
  reconcileThreadCallbacks,
  threadAttentionSnapshot,
} from "../services/interactions/thread-attention.js";
import { inboxActorFromHeaders } from "../services/inbox/actor.js";
import { familyIdsOf } from "../services/inbox/family.js";
import { adoptLegacyAttention } from "../services/interactions/thread-attention-adoption.js";

export function registerThreadAttentionRoutes(app: Hono, deps: AppDeps): void {
  const { get, post } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (message) =>
      new ApiError(400, "invalid_request", message),
  });

  get(publicApiRoutes.attention.snapshot, (context) =>
    context.json(threadAttentionSnapshot(deps)),
  );
  get(publicApiRoutes.attention.thread, (context) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    reconcileThreadCallbacks(deps, thread.id);

    return context.json({
      questions: listThreadQuestions(deps.db, thread.id, true),
      callbacks: listThreadCallbacks(deps.db, thread.id),
    });
  });
  post(publicApiRoutes.attention.command, async (context, command) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));

    return context.json(
      await executeAttentionCommand(
        deps,
        thread.id,
        command,
        inboxActorFromHeaders((name) => context.req.header(name)),
      ),
    );
  });
  post(publicApiRoutes.attention.adopt, (context, payload) =>
    context.json({ imported: adoptLegacyAttention(deps, payload.pluginId) }),
  );
  forwardCallbackSourceChanges(deps);
  reconcileThreadCallbacks(deps);
}

const CALLBACK_STATE_CHANGES: ReadonlySet<ThreadChangeKind> = new Set([
  "thread-created",
  "thread-deleted",
  "interactions-changed",
  "status-changed",
  "title-changed",
  "execution-changed",
  "queue-changed",
  "work-changed",
  "archived-changed",
  "parent-changed",
]);

const fingerprint = (callbacks: readonly ThreadCallback[]): string =>
  callbacks
    .map(
      (callback) =>
        `${callback.id}\0${callback.sourceState}\0${callback.sourceTitle}`,
    )
    .join("\n");

function forwardCallbackSourceChanges(deps: AppDeps): void {
  let notifying = false;
  const forwarded = new Map<string, string>();

  deps.hub.onThreadChanged((id, changes, metadata) => {
    if (notifying) return;
    notifying = true;

    try {
      if (
        deps.db
          .select({ id: threadCallbacks.id })
          .from(threadCallbacks)
          .where(eq(threadCallbacks.threadId, id))
          .get() !== undefined
      )
        reconcileThreadCallbacks(deps, id);

      if (
        !changes.some((change) => CALLBACK_STATE_CHANGES.has(change)) &&
        metadata?.backgroundActivityChanged !== true
      )
        return;

      const pushed = metadata?.attentionItems?.callbacks;

      if (changes.includes("interactions-changed") && pushed !== undefined) {
        const own = pushed.filter((callback) => callback.threadId === id);

        if (own.length > 0) forwarded.set(id, fingerprint(own));
        else forwarded.delete(id);
      }

      const changed = deps.db
        .select({
          lifecycleOwnerThreadId: threads.lifecycleOwnerThreadId,
          originPluginId: threads.originPluginId,
        })
        .from(threads)
        .where(eq(threads.id, id))
        .get();

      const family = changes.includes("work-changed")
        ? familyIdsOf(deps.db, id)
        : [id];

      const sources =
        changed?.originPluginId === "workflows" &&
        changed.lifecycleOwnerThreadId !== null
          ? [...family, changed.lifecycleOwnerThreadId]
          : family;

      const waiters = new Set([
        ...family,
        ...listCallbackWaiterIds(deps.db, sources),
      ]);

      for (const [waiterId, callbacks] of listThreadCallbacksByThread(deps.db, [
        ...waiters,
      ])) {
        const next = fingerprint(callbacks);

        if ((forwarded.get(waiterId) ?? "") === next) continue;

        if (next === "") forwarded.delete(waiterId);
        else forwarded.set(waiterId, next);
        notifyThreadAttentionChanged(deps, waiterId);
      }
    } catch (cause) {
      deps.logger.error(
        { err: cause, threadId: id },
        "Native callback forwarding failed",
      );
    } finally {
      notifying = false;
    }
  });
}
