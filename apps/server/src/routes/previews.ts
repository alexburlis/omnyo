import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
} from "@omnyo/server-contract";
import { INBOX_CALLER_THREAD_HEADER } from "@omnyo/domain";
import type { Hono } from "hono";
import { ApiError } from "../errors.js";
import type { AppDeps } from "../types.js";
import {
  registerPreview,
  listPreviews,
  publicPreview,
  requirePreview,
  previewStatus,
  removePreview,
  restartPreview,
} from "../services/previews/managed-previews.js";

export function registerPreviewRoutes(app: Hono, deps: AppDeps): void {
  const { get, post, del } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (message) =>
      new ApiError(400, "invalid_request", message),
  });

  const routes = publicApiRoutes.previews;
  post(routes.register, (context, payload) =>
    context.json(registerPreview(deps, payload), 201),
  );
  get(routes.list, (context, query) =>
    context.json(listPreviews(deps, query.threadId)),
  );
  get(routes.get, (context) =>
    context.json(
      publicPreview(deps, requirePreview(deps, context.req.param("previewId"))),
    ),
  );
  get(routes.status, async (context) =>
    context.json(await previewStatus(deps, context.req.param("previewId"))),
  );
  post(routes.restart, async (context, payload) =>
    context.json(
      await restartPreview(
        deps,
        context.req.param("previewId"),
        payload.requestId,
        context.req.header(INBOX_CALLER_THREAD_HEADER)?.trim() || null,
      ),
    ),
  );
  del(routes.remove, async (context) =>
    context.json(await removePreview(deps, context.req.param("previewId"))),
  );
}
