import {
  createStartHandler,
  defaultStreamHandler,
} from "@tanstack/react-start/server";
import { parseUsageCollectorOrigin } from "@omnyo/config/usage-collector-url";

import { handleAnalyticsRoute } from "./analytics/server";
import { reportFatalServerError } from "./analytics/server-errors";

const startFetch = createStartHandler(defaultStreamHandler);

const analyticsRouteOptions = {
  fetch: globalThis.fetch,
  collectorOrigin: parseUsageCollectorOrigin(
    process.env.OMNYO_USAGE_COLLECTOR_URL,
  ),
};

async function fetch(
  request: Request,
  ...rest: Parameters<typeof startFetch> extends [Request, ...infer Tail]
    ? Tail
    : never
): Promise<Response> {
  const analytics = await handleAnalyticsRoute(request, analyticsRouteOptions);

  return analytics ?? startFetch(request, ...rest);
}

export default { fetch, reportFatalServerError };
