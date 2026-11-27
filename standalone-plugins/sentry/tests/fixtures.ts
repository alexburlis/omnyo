import { routeSchema, incidentSchema } from "../contract";

export function route() {
  return routeSchema.parse({
    id: "client",
    name: "Client",
    enabled: true,
    organization: "acme",
    sentryProjectId: "100",
    environment: "production",
    projectId: "proj_app",
    hostId: "host_mac",
    repositoryPath: "/projects/umbrella/client",
    baseRef: "main",
    checks: [{ name: "Tests", command: "node", args: ["--test"], timeoutMs: 30000 }],
  });
}

export function incident(id = "101") {
  return incidentSchema.parse({
    key: "acme:" + id,
    id,
    shortId: "CLIENT-" + id,
    organization: "acme",
    projectId: "100",
    url: "https://acme.sentry.io/issues/" + id + "/",
    level: "error",
    exceptionType: "TypeError",
    firstSeen: "2026-10-18T10:00:00Z",
    lastSeen: "2026-10-18T10:01:00Z",
    status: "unresolved",
    substatus: "new",
    release: null,
    environment: "production",
    matchedRouteIds: ["client"],
  });
}

export function sentryIssue(id = "101") {
  return {
    id,
    shortId: "CLIENT-" + id,
    project: { id: "100" },
    level: "error",
    status: "unresolved",
    substatus: "new",
    metadata: { type: "TypeError" },
    firstSeen: "2026-10-18T10:00:00Z",
    lastSeen: "2026-10-18T10:01:00Z",
    title: "PRIVATE_CONTENT_SENTINEL",
    assignedTo: { email: "private@example.test" },
  };
}

export const projects = {
  list: () => [
    { id: "proj_app", name: "App", sources: [] },
    { id: "proj_other", name: "Other", sources: [] },
  ],
};
