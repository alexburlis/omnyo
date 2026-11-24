import {
  typedRoutes,
  publicApiRoutes,
  type PublicApiSchema,
} from "@omnyo/server-contract";
import type { Hono } from "hono";
import { getGateAuthKind } from "../request-context.js";
import { ApiError } from "../errors.js";
import type { WebUpdateService } from "../services/system/web-update.js";

export function registerWebUpdateRoutes(app: Hono, service: WebUpdateService) {
  const { get, post } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (message) =>
      new ApiError(400, "invalid_request", message),
  });

  const routes = publicApiRoutes.system;

  const authorize = (context: Parameters<typeof getGateAuthKind>[0]) => {
    if (getGateAuthKind(context) === "machine")
      throw new ApiError(
        403,
        "forbidden",
        "Machine credentials cannot publish the web interface",
      );
  };

  get(routes.webAssets, async (context) => {
    const manifest = await service.assetManifest();

    if (manifest === null)
      throw new ApiError(
        404,
        "not_found",
        "This server is not serving a built web interface.",
      );

    const etag = `"${manifest.generation}"`;
    context.header("cache-control", "no-cache");
    context.header("etag", etag);

    if (context.req.header("if-none-match") === etag)
      return context.body(null, 304);

    return context.json(manifest);
  });

  get(routes.webUpdateStatus, async (context) => {
    authorize(context);

    return context.json(await service.status());
  });
  post(routes.webUpdateBegin, async (context, input) => {
    authorize(context);

    return context.json(await service.begin(input, context.req.raw.signal));
  });
  post(routes.webUpdateUpload, async (context, input) => {
    authorize(context);

    return context.json(await service.upload(input));
  });
  post(routes.webUpdateApply, async (context, input) => {
    authorize(context);

    return context.json(await service.apply(input));
  });
  post(routes.webUpdateAbort, async (context, input) => {
    authorize(context);

    return context.json(await service.abort(input.uploadId));
  });
  post(routes.webUpdateRollback, async (context, input) => {
    authorize(context);

    return context.json(await service.rollback(input));
  });
}
