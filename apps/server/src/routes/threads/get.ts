import { getEnvironment, getHost } from "@omnyo/db";
import type { Environment, Thread } from "@omnyo/domain";
import {
  publicApiRoutes,
  typedRoutes,
  threadIncludeOptionSchema,
  type PublicApiSchema,
  type ThreadGetQuery,
  type ThreadIncludeOption,
  type ThreadWithIncludesResponse,
} from "@omnyo/server-contract";
import type { Hono } from "hono";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import type { PluginService } from "../../services/plugins/plugin-service.js";
import { toEnvironmentResponse } from "../../services/environments/environment-response.js";
import {
  getNonDestroyedHostWithStatus,
  requirePublicThread,
} from "../../services/lib/entity-lookup.js";
import { toThreadResponseFromThread } from "../../services/threads/thread-runtime-display.js";

type ThreadGetDeps = Pick<AppDeps, "db" | "hub">;

function parseThreadIncludes(query: ThreadGetQuery): Set<ThreadIncludeOption> {
  const includes = new Set<ThreadIncludeOption>();

  if (!query.include) {
    return includes;
  }

  for (const value of query.include.split(",")) {
    includes.add(threadIncludeOptionSchema.parse(value));
  }

  return includes;
}

interface BuildThreadResponseArgs {
  includes: Set<ThreadIncludeOption>;
  thread: Thread;
}

function resolveIncludedThreadEnvironment(
  deps: Pick<AppDeps, "db">,
  thread: Thread,
): Environment | null {
  if (thread.environmentId === null) {
    return null;
  }

  const environment = getEnvironment(deps.db, thread.environmentId);

  return environment === null
    ? null
    : toEnvironmentResponse(deps.db, environment);
}

function buildThreadResponse(
  deps: ThreadGetDeps,
  args: BuildThreadResponseArgs,
): ThreadWithIncludesResponse {
  const response: ThreadWithIncludesResponse = toThreadResponseFromThread(
    deps,
    {
      thread: args.thread,
    },
  );

  const shouldResolveEnvironment =
    args.includes.has("environment") || args.includes.has("host");

  const environment = shouldResolveEnvironment
    ? resolveIncludedThreadEnvironment(deps, args.thread)
    : null;

  if (args.includes.has("environment")) {
    response.environment = environment;
  }

  if (args.includes.has("host")) {
    response.host = environment
      ? getNonDestroyedHostWithStatus(deps, environment.hostId)
      : null;
    response.environmentHostName = environment
      ? (getHost(deps.db, environment.hostId)?.name ?? null)
      : null;
  }

  return response;
}

export function registerThreadGetRoute(
  app: Hono,
  deps: ThreadGetDeps,
  plugins?: Pick<PluginService, "readThreadBootstrap">,
): void {
  const { get } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  const routes = publicApiRoutes.threads;
  get(routes.get, async (context, query) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    const includes = parseThreadIncludes(query);
    const response = buildThreadResponse(deps, { includes, thread });

    if (includes.has("experimental_pluginData")) {
      response.experimental_pluginData = plugins
        ? await plugins.readThreadBootstrap(thread, context.req.raw.signal)
        : [];
    }

    return context.json(response);
  });
}
