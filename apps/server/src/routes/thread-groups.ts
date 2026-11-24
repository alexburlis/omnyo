import {
  createThreadGroup,
  deleteThreadGroup,
  listThreadGroups,
  normalizeThreadGroupName,
  renameThreadGroup,
} from "@omnyo/db";
import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
} from "@omnyo/server-contract";
import type { Hono } from "hono";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";

function requireGroupName(name: string): string {
  const normalized = normalizeThreadGroupName(name);

  if (!normalized) {
    throw new ApiError(400, "invalid_request", "Group name cannot be empty");
  }

  return normalized;
}

function throwGroupNotFound(): never {
  throw new ApiError(404, "group_not_found", "Group not found");
}

export function registerThreadGroupRoutes(app: Hono, deps: AppDeps): void {
  const { del, get, patch, post } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  const routes = publicApiRoutes.threadGroups;

  get(routes.list, (context, query) =>
    context.json(
      listThreadGroups(
        deps.db,
        query.projectId ? { projectId: query.projectId } : {},
      ),
    ),
  );

  post(routes.create, (context, payload) => {
    const result = createThreadGroup(deps.db, deps.hub, {
      name: requireGroupName(payload.name),
      threadIds: payload.threadIds,
    });

    if (result.status === "thread_not_found") {
      throw new ApiError(
        404,
        "thread_not_found",
        `Thread ${result.threadId} not found`,
      );
    }

    if (result.status === "project_mismatch") {
      throw new ApiError(
        400,
        "group_project_mismatch",
        "A group can only hold chats from one project",
      );
    }

    return context.json(
      { group: result.group, threadIds: result.threadIds },
      201,
    );
  });

  patch(routes.update, (context, payload) => {
    const result = renameThreadGroup(deps.db, deps.hub, {
      id: payload.id,
      name: requireGroupName(payload.name),
    });

    if (!result) throwGroupNotFound();

    return context.json(result);
  });

  del(routes.delete, (context, payload) => {
    const result = deleteThreadGroup(deps.db, deps.hub, { id: payload.id });

    if (!result) throwGroupNotFound();

    return context.json(result);
  });
}
