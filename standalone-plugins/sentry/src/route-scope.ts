import type { Route } from "../contract";

export const allEnvironments = "*";

export function scanScope(route: Route) {
  const { organization, sentryProjectId, environment, levels, service, channel, releases, query } =
    route;

  return { organization, sentryProjectId, environment, levels, service, channel, releases, query };
}

export function routeOverlaps(left: Route, right: Route) {
  const a = scanScope(left);
  const b = scanScope(right);

  return (
    a.organization === b.organization &&
    a.sentryProjectId === b.sentryProjectId &&
    (a.environment === b.environment ||
      a.environment === allEnvironments ||
      b.environment === allEnvironments) &&
    (!a.service || !b.service || a.service === b.service) &&
    (!a.channel || !b.channel || a.channel === b.channel) &&
    (!a.releases.length ||
      !b.releases.length ||
      a.releases.some((release) => b.releases.includes(release)))
  );
}
