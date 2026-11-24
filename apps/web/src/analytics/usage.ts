import {
  siteUsageEventSchema,
  type SiteUsageEvent,
} from "@omnyo/domain/site-usage";

import { SITE_USAGE_PATH } from "./config";
import { analyticsAllowedNow } from "./consent";

const requests = new Set<AbortController>();

let generation = 0;

export function stopSiteUsage(): void {
  generation += 1;

  for (const controller of requests) controller.abort();
  requests.clear();
}

export function sendSiteUsage(event: SiteUsageEvent): void {
  if (typeof window === "undefined" || !analyticsAllowedNow()) return;
  const parsed = siteUsageEventSchema.safeParse(event);

  if (!parsed.success) return;
  const permission = generation;
  const controller = new AbortController();
  requests.add(controller);

  if (permission !== generation || !analyticsAllowedNow()) {
    requests.delete(controller);

    return;
  }

  void window
    .fetch(SITE_USAGE_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: parsed.data }),
      credentials: "same-origin",
      mode: "same-origin",
      referrerPolicy: "no-referrer",
      redirect: "error",
      keepalive: false,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
    })
    .catch(() => undefined)
    .finally(() => requests.delete(controller));
}

export function siteRoute(
  pathname: string,
): Extract<SiteUsageEvent, { name: "route_view" }>["route"] {
  if (pathname === "/") return "home";

  if (pathname === "/features") return "features";

  if (pathname.startsWith("/features/")) return "feature";

  if (pathname === "/guides") return "guides";

  if (pathname.startsWith("/guides/")) return "guide";

  if (pathname.startsWith("/compare/")) return "compare";

  if (pathname === "/explore" || pathname === "/explore/skills")
    return "marketplace";

  if (pathname.startsWith("/explore/")) return "listing";

  if (pathname === "/workflows") return "workflows";

  if (pathname.startsWith("/workflows/")) return "workflow";

  if (pathname === "/privacy") return "privacy";

  if (pathname === "/cookies") return "cookies";

  if (pathname === "/terms") return "terms";

  if (pathname === "/imprint") return "imprint";

  if (pathname === "/abuse") return "abuse";

  if (pathname === "/plugin-guide") return "plugin_guide";

  return "other";
}

export function resultCountBucket(
  count: number,
): Extract<SiteUsageEvent, { name: "marketplace_results" }>["count"] {
  if (count === 0) return "0";

  if (count <= 5) return "1-5";

  if (count <= 20) return "6-20";

  if (count <= 100) return "21-100";

  return "101+";
}
