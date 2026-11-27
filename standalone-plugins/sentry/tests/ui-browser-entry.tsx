import { LoadingFixture } from "./ui-loading-fixture";
import { installTestPluginResourceRuntime } from "@omnyo/plugin-sdk/testing/app";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SentryRailBadge } from "../src/ui/badge";
import { SentryView } from "../src/ui/view";
import { route, incident } from "./fixtures";
import { inboxViewProps } from "./inbox-view-fixture";
import { statusSchema, runSchema } from "../contract";

installTestPluginResourceRuntime();

const configured = { ...route(), enabled: false };

const run = runSchema.parse({
  id: "run_browser",
  incident: incident(),
  route: configured,
  state: "investigating",
  manual: true,
  threadId: "thr_browser",
  environmentId: "env_browser",
  worktreePath: null,
  branch: null,
  baseSha: null,
  result: null,
  verification: null,
  publication: null,
  reason: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  reportRequests: 0,
});

const portfolio = new URLSearchParams(window.location.search).has("portfolio");

const portfolioProjects = ["Orbit", "Nimbus", "Vega", "Atlas", "Lumen Labs"].map((name, index) => ({
  id: "proj_portfolio_" + index,
  name,
}));

const portfolioRoutes = portfolioProjects.flatMap((project) =>
  Array.from({ length: 6 }, (_, index) => ({
    ...configured,
    id: project.id + "_" + index,
    name: ["Web", "iOS", "API", "Desktop", "Worker", "Docs"][index],
    projectId: project.id,
    enabled: true,
    repositoryPath:
      "/Users/me/projects/" +
      project.name.toLowerCase().replaceAll(" ", "") +
      "/" +
      ["web", "ios", "api", "desktop", "worker", "docs"][index],
  })),
);

function BrowserFixture() {
  const [status, setStatus] = useState(
    statusSchema.parse({
      connected: true,
      apiOrigin: "https://de.sentry.io",
      lastError: null,
      routes: portfolio ? portfolioRoutes : [configured],
      incidents: portfolio
        ? portfolioRoutes.map((mapping, index) => ({
            ...incident(String(300 + index)),
            matchedRouteIds: [mapping.id],
            exceptionType: ["TypeError", "NetworkError", "InvalidStateError", "TimeoutError"][
              index % 4
            ],
            level: index % 5 === 0 ? "fatal" : "error",
            lastSeen: "2026-10-18T10:" + String(59 - index).padStart(2, "0") + ":00Z",
          }))
        : [
            incident(),
            incident("102"),
            {
              ...incident("103"),
              exceptionType: "NetworkError",
              level: "fatal",
              substatus: "regressed",
            },
          ],
      runs: portfolio ? [] : [run],
      syncs: [],
      badge: {
        count: portfolio ? 30 : 3,
        watchedRoutes: portfolio ? 30 : 1,
        freshness: "live",
        lastSyncedAt: new Date().toISOString(),
      },
      projectPolicies: portfolio
        ? portfolioProjects.map((project) => ({
            projectId: project.id,
            autoSolve: false,
            dailyLimit: 10,
            day: "2026-10-18",
            started: 0,
            remaining: 10,
          }))
        : [
            {
              projectId: "proj_app",
              autoSolve: false,
              dailyLimit: 10,
              day: "2026-10-18",
              started: 0,
              remaining: 10,
            },
          ],
      notificationLimit: "Component fixture: notification delivery is not exercised here.",
    }),
  );

  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  return (
    <>
      <aside>
        <span data-nav-rail-item="sentry/sentry">
          <button aria-label="Sentry">◉</button>
        </span>
      </aside>
      <SentryRailBadge count={status.badge.count} freshness={status.badge.freshness} />
      <SentryView
        {...inboxViewProps(status, {
          snapshot: {
            refreshing,
            error,
            targets: {
              projects: portfolio
                ? portfolioProjects
                : [
                    { id: "proj_app", name: "Fixture project" },
                    { id: "proj_orbit", name: "Orbit" },
                  ],
              hosts: [{ id: "host_mac", name: "Fixture Mac" }],
            },
          },
          client: {
            catalog: async () => [{ id: "200", slug: "orbit", name: "Orbit" }],
            repositories: async () => [
              {
                hostId: "host_mac",
                name: "mobile",
                path: "/projects/orbit/mobile",
                baseRef: "main",
                githubRepository: "fixture/orbit",
                checks: [],
                instructionPaths: [],
              },
            ],
            addProject: async (route) => {
              setStatus((value) => ({
                ...value,
                routes: [...value.routes, { ...route, enabled: true }],
                projectPolicies: [
                  ...value.projectPolicies,
                  {
                    projectId: route.projectId,
                    autoSolve: false,
                    dailyLimit: 10,
                    day: "2026-10-18",
                    started: 0,
                    remaining: 10,
                  },
                ],
              }));

              return true;
            },
            solveAll: async (projectId) => {
              window.location.hash = "solve-all-" + projectId;

              return true;
            },
            sync: async () => {
              setError(null);
              setRefreshing((value) => !value);

              return true;
            },
            toggleRoute: async (id, enabled) => {
              setStatus((value) => ({
                ...value,
                routes: value.routes.map((route) =>
                  route.id === id ? { ...route, enabled } : route,
                ),
              }));

              return true;
            },
            investigate: async () => {
              setError("Fixture transport failure. Existing source and run are retained.");

              return false;
            },
            stop: async (id) => {
              setStatus((value) => ({
                ...value,
                runs: value.runs.map((run) =>
                  run.id === id ? { ...run, state: "cancelled" } : run,
                ),
              }));

              return true;
            },
            retry: async (id) => {
              setStatus((value) => ({
                ...value,
                runs: value.runs.map((run) =>
                  run.id === id ? { ...run, state: "investigating" } : run,
                ),
              }));

              return true;
            },
            savePolicy: async (policy) => {
              setStatus((value) => ({
                ...value,
                projectPolicies: [
                  { ...policy, day: "2026-10-18", started: 0, remaining: policy.dailyLimit },
                ],
              }));

              return true;
            },
            saveRoute: async (route) => {
              setStatus((value) => ({ ...value, routes: [{ ...route, enabled: false }] }));

              return true;
            },
          },
          onOpenThread: () => {
            window.location.hash = "thread-opened";
          },
        })}
      />
    </>
  );
}

const element = document.getElementById("root");

if (!element) throw new Error("Missing fixture root");

createRoot(element).render(
  new URLSearchParams(window.location.search).has("loading") ? (
    <LoadingFixture />
  ) : (
    <BrowserFixture />
  ),
);
