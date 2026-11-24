import { eq, inArray, or } from "drizzle-orm";
import {
  threadCallbacks,
  threads,
  listThreadQuestions,
  listThreadCallbacks,
  toThreadCallback,
} from "@omnyo/db";
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
  let notifying = false;
  const forwardedSourceStates = new Map<string, string>();
  deps.hub.onThreadChanged((id) => {
    if (notifying) return;
    notifying = true;

    try {
      const changed = deps.db
        .select({
          lifecycleOwnerThreadId: threads.lifecycleOwnerThreadId,
          originPluginId: threads.originPluginId,
        })
        .from(threads)
        .where(eq(threads.id, id))
        .get();

      const sources =
        changed?.originPluginId === "workflows" &&
        changed.lifecycleOwnerThreadId !== null
          ? [id, changed.lifecycleOwnerThreadId]
          : [id];

      const waits = deps.db
        .select()
        .from(threadCallbacks)
        .where(
          or(
            eq(threadCallbacks.threadId, id),
            inArray(threadCallbacks.sourceThreadId, sources),
          ),
        )
        .all();

      const own = new Set(
        waits
          .filter((wait) => wait.threadId === id)
          .map((wait) => `${id}:${wait.id}`),
      );

      if (own.size > 0) reconcileThreadCallbacks(deps, id);

      for (const key of forwardedSourceStates.keys())
        if (key.startsWith(`${id}:`) && !own.has(key))
          forwardedSourceStates.delete(key);

      for (const wait of waits) {
        if (wait.threadId === id) continue;
        const callback = toThreadCallback(deps.db, wait);
        const key = `${wait.threadId}:${wait.id}`;
        const state = `${callback.sourceState}\0${callback.sourceTitle}`;

        if (forwardedSourceStates.get(key) === state) continue;
        forwardedSourceStates.set(key, state);
        notifyThreadAttentionChanged(deps, wait.threadId);
      }
    } catch (cause) {
      deps.logger.error(
        { err: cause, threadId: id },
        "Native callback reconciliation failed",
      );
    } finally {
      notifying = false;
    }
  });
  reconcileThreadCallbacks(deps);
}
