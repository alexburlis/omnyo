import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
} from "@omnyo/server-contract";
import type { Hono } from "hono";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import { lookupCommandProofs } from "../../services/threads/command-proofs.js";

export function registerThreadCommandProofRoutes(
  app: Hono,
  deps: Pick<AppDeps, "db">,
): void {
  const { post } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (message) =>
      new ApiError(400, "invalid_request", message),
  });

  post(publicApiRoutes.threads.commandProofs, (context, input) =>
    context.json(lookupCommandProofs(deps.db, context.req.param("id"), input)),
  );
}
