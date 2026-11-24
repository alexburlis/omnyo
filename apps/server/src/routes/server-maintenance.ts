import { z } from "zod";
import type { Hono } from "hono";
import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
} from "@omnyo/server-contract";
import { ApiError } from "../errors.js";
import { getGateAuthKind } from "../request-context.js";
import type { ServerMaintenance } from "../services/maintenance/server-maintenance.js";

export function registerServerMaintenanceRoutes(
  app: Hono,
  maintenance: ServerMaintenance,
): void {
  app.use("/server/maintenance", async (context, next) => {
    if (
      getGateAuthKind(context) === "machine" ||
      context.req.header("authorization") !== undefined
    )
      throw new ApiError(
        403,
        "machine_host_management_forbidden",
        "Machine credentials cannot control server maintenance",
      );
    await next();
  });
  app.use("/server/maintenance/*", async (context, next) => {
    if (
      getGateAuthKind(context) === "machine" ||
      context.req.header("authorization") !== undefined
    )
      throw new ApiError(
        403,
        "machine_host_management_forbidden",
        "Machine credentials cannot control server maintenance",
      );
    await next();
  });

  async function body(
    context: Parameters<typeof getGateAuthKind>[0] & {
      req: { json(): Promise<unknown> };
    },
  ) {
    if (
      context.req
        .header("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase() !== "application/json"
    )
      throw new ApiError(
        415,
        "invalid_request",
        "Origin adoption requires application/json",
      );

    try {
      return await context.req.json();
    } catch {
      throw new ApiError(
        400,
        "invalid_request",
        "Origin adoption request is invalid",
      );
    }
  }

  app.post(
    "/server/maintenance/origin-adoption-v1/prepare",
    async (context) => {
      const input = await body(context);

      try {
        return context.json(await maintenance.originAdoption.prepare(input));
      } catch (error) {
        if (error instanceof z.ZodError)
          throw new ApiError(
            400,
            "invalid_request",
            "Origin adoption request is invalid",
          );
        throw error;
      }
    },
  );
  app.post("/server/maintenance/origin-adoption-v1/check", async (context) => {
    const origin = context.req.header("origin");

    if (origin === undefined)
      throw new ApiError(
        403,
        "origin_adoption_origin",
        "Origin adoption requires its selected browser origin",
      );
    const input = await body(context);

    try {
      return context.json(
        await maintenance.originAdoption.control(input, origin),
      );
    } catch (error) {
      if (error instanceof z.ZodError)
        throw new ApiError(
          400,
          "invalid_request",
          "Origin adoption request is invalid",
        );
      throw error;
    }
  });

  const { get, post } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (message) =>
      new ApiError(400, "invalid_request", message),
  });

  get(publicApiRoutes.server.maintenanceStatus, (context) =>
    context.json(maintenance.status()),
  );
  get(publicApiRoutes.server.runtimeIdentity, (context) =>
    context.json({ runtimeId: maintenance.getRuntimeId() }),
  );
  post(publicApiRoutes.server.maintenanceAcquire, async (context, input) =>
    context.json(await maintenance.acquire(input)),
  );
  post(publicApiRoutes.server.maintenancePrepare, async (context, input) =>
    context.json(await maintenance.prepare(input)),
  );
  post(publicApiRoutes.server.maintenanceRelease, async (context, input) =>
    context.json(await maintenance.release(input)),
  );
}
