import { installTestPluginResourceRuntime } from "@omnyo/plugin-sdk/testing/app";
import { beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { SentryView } from "../src/ui/view";
import { ProjectSetup } from "../src/ui/project-setup";
import { route, incident } from "./fixtures";
import { inboxViewProps } from "./inbox-view-fixture";
import type { Route } from "../contract";

const noop = () => {};

const status = {
  connected: true,
  apiOrigin: "https://de.sentry.io",
  lastError: null,
  routes: [route()],
  incidents: [incident()],
  runs: [],
  syncs: [],
  batches: [],
  projectIssueCounts: [],
  badge: {
    count: 1,
    watchedRoutes: 1,
    freshness: "live" as const,
    lastSyncedAt: "2026-10-18T10:00:00Z",
  },
  projectPolicies: [
    {
      projectId: "proj_app",
      autoSolve: false,
      dailyLimit: 10,
      day: "2026-10-18",
      started: 0,
      remaining: 10,
    },
  ],
  notificationLimit: "",
};

afterEach(cleanup);

it("saves the selected repository's machine when two machines use the same path", async () => {
  const saved: Route[] = [];
  render(
    <ProjectSetup
      organization="acme"
      projects={[{ id: "proj_app", name: "App" }]}
      onCatalog={async () => [{ id: "200", name: "App", slug: "app" }]}
      onRepositories={async () =>
        ["host_first", "host_second"].map((hostId) => ({
          name: hostId,
          path: "/projects/app",
          hostId,
          baseRef: "main",
          githubRepository: null,
          checks: [{ name: "Tests", command: "pnpm", args: ["test"], timeoutMs: 30000 }],
          instructionPaths: [],
        }))
      }
      onSave={async (value) => {
        saved.push(value);

        return true;
      }}
      onClose={noop}
      onInteractOutside={noop}
      targetsError={null}
      onRetryTargets={noop}
    />,
  );
  await act(async () => {});
  fireEvent.change(screen.getByLabelText("Sentry project"), { target: { value: "200" } });
  fireEvent.change(screen.getByLabelText("Omnyo project"), { target: { value: "proj_app" } });
  await act(async () => {});
  const repository = screen.getByRole<HTMLSelectElement>("combobox", { name: "Repository" });

  const second = Array.from(repository.options).find((option) =>
    option.textContent?.includes("host_second"),
  );

  expect(second).toBeDefined();
  fireEvent.change(repository, { target: { value: second?.value } });
  fireEvent.click(screen.getByRole("button", { name: "Save and watch" }));
  await act(async () => {});
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ hostId: "host_second", repositoryPath: "/projects/app" });
});

it("adds another project through stable discovery without losing its draft and sends Solve all the Omnyo project rather than a route", async () => {
  let resolve!: (value: Array<{ id: string; slug: string; name: string }>) => void;

  const catalog = new Promise<Array<{ id: string; slug: string; name: string }>>((r) => {
    resolve = r;
  });

  const saved: Route[] = [];
  const solved: string[] = [];

  const props = inboxViewProps(status, {
    snapshot: {
      targets: {
        projects: [
          { id: "proj_app", name: "Nimbus" },
          { id: "proj_orbit", name: "Orbit" },
        ],
        hosts: [],
      },
    },
    client: {
      catalog: () => catalog,
      repositories: async () => [
        {
          name: "orbit-app",
          path: "/projects/orbit/orbit-app",
          hostId: "host_mac",
          baseRef: "main",
          githubRepository: "owner/orbit",
          checks: [{ name: "Unit tests", command: "pnpm", args: ["test"], timeoutMs: 30000 }],
          instructionPaths: [],
        },
      ],
      addProject: async (route) => {
        saved.push(route);

        return true;
      },
      solveAll: async (id) => {
        solved.push(id);

        return true;
      },
    },
  });

  const page = render(<SentryView {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Add project" }));
  expect(screen.getByRole("dialog", { name: "Add project" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Omnyo project"), { target: { value: "proj_orbit" } });
  await act(async () => {});
  page.rerender(<SentryView {...props} snapshot={{ ...props.snapshot, refreshing: true }} />);
  expect(screen.getByLabelText("Sentry organization").getAttribute("value")).toBe("acme");
  await act(async () => {
    resolve([{ id: "200", slug: "orbit", name: "Orbit" }]);
  });
  fireEvent.change(screen.getByLabelText("Sentry project"), { target: { value: "200" } });

  const repositoryOption = screen.getByRole<HTMLOptionElement>("option", {
    name: "orbit-app · main",
  });

  fireEvent.change(screen.getByLabelText("Repository"), {
    target: { value: repositoryOption.value },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save and watch" }));
  await act(async () => {});
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({
    projectId: "proj_orbit",
    sentryProjectId: "200",
    repositoryPath: "/projects/orbit/orbit-app",
    enabled: false,
    delivery: "local",
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Solve all for Nimbus" }));
  expect(solved).toEqual(["proj_app"]);
});

beforeEach(() => {
  const runtime = installTestPluginResourceRuntime();

  return () => {
    cleanup();
    runtime.dispose();
  };
});
