import type { Hono } from "hono";
import { listQueuedThreadMessagesForApi } from "@omnyo/db";
import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
} from "@omnyo/server-contract";
import { ApiError } from "../errors.js";
import type { AppDeps } from "../types.js";
import { toThreadQueuedMessage } from "../services/threads/thread-queued-messages.js";

export function registerQueueRoutes(app: Hono, deps: AppDeps): void {
  const { get } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  get(publicApiRoutes.queue.list, (context, query) => {
    return context.json(
      listQueuedThreadMessagesForApi(deps.db, {
        ...(query.threadId !== undefined ? { threadId: query.threadId } : {}),
        ...(query.waitHolder !== undefined
          ? { waitHolder: query.waitHolder }
          : {}),
      }).map(toThreadQueuedMessage),
    );
  });
}
