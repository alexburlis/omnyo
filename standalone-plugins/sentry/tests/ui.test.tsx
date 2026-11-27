import { Activity } from "react";
import { installTestPluginResourceRuntime } from "@omnyo/plugin-sdk/testing/app";
import { beforeEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginRpcClient } from "@omnyo/plugin-sdk/app";
import { InboxClient } from "../src/ui/client";
import { SentryView } from "../src/ui/view";
import { route, incident } from "./fixtures";
import { inboxViewProps } from "./inbox-view-fixture";
import {
  builtinModelDefaults,
  runSchema,
  type ModelDefaults,
  type ModelSelection,
  type Route,
  type rpcContract,
} from "../contract";

type Started = { routeId?: string; model?: ModelSelection | null };

const claude = { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" };

const noop = () => {};

const run = (id: string, mapping: Route) =>
  runSchema.parse({
    id,
    incident: { ...incident(id), matchedRouteIds: [mapping.id] },
    route: mapping,
    state: "investigating",
    manual: true,
    threadId: null,
    environmentId: null,
    worktreePath: null,
    branch: null,
    baseSha: null,
    result: null,
    verification: null,
    publication: null,
    reason: null,
    reportRequests: 0,
    createdAt: "2026-10-18T10:00:00Z",
    updatedAt: "2026-10-18T10:00:00Z",
  });

const status = {
  connected: true,
  apiOrigin: "https://de.sentry.io",
  lastError: null,
  routes: [{ ...route(), enabled: false }],
  incidents: [incident()],
  runs: [],
  syncs: [],
  batches: [],
  projectIssueCounts: [],
  badge: {
    count: 1,
    watchedRoutes: 1,
    freshness: "live" as const,
    lastSyncedAt: "2026-10-18T10:05:00Z",
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
  notificationLimit: "Uses existing Omnyo notification preferences",
};

afterEach(cleanup);

describe("Sentry inbox and project controls", () => {
  it("shows every issue counted for a project outside the workspace preview", async () => {
    const app = route();
    const lumen = { ...app, id: "lumen", projectId: "proj_lumen", name: "Lumen Labs" };

    const lumenIssues = [1, 2, 3].map((id) => ({
      ...incident(String(id)),
      shortId: "LUMENLABS-" + id,
      matchedRouteIds: [lumen.id],
    }));

    const requests: unknown[] = [];

    render(
      <SentryView
        {...inboxViewProps(
          {
            ...status,
            routes: [app, lumen],
            incidents: [
              ...Array.from({ length: 199 }, (_, index) => incident(String(index + 100))),
              lumenIssues[0],
            ],
            badge: { ...status.badge, count: 202 },
            projectIssueCounts: [{ projectId: lumen.projectId, count: 3 }],
          },
          {
            client: {
              listInbox: async (query) => {
                requests.push(query);

                return { incidents: lumenIssues, total: lumenIssues.length };
              },
            },
          },
        )}
      />,
    );
    fireEvent.change(screen.getByLabelText("Filter Omnyo project"), {
      target: { value: lumen.projectId },
    });

    expect(await screen.findByText("3 issues in this view")).toBeTruthy();
    expect(requests).toEqual([expect.objectContaining({ projectId: lumen.projectId, offset: 0 })]);

    for (const issue of lumenIssues) expect(screen.getByText(issue.shortId)).toBeTruthy();
    expect(screen.queryByText("CLIENT-100")).toBeNull();
    expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
  });

  it("retains a previously viewed project while fresh rows load and ignores a late other project", async () => {
    const app = route();
    const other = { ...app, id: "other", projectId: "proj_other", name: "Other" };
    const issue = { ...incident("501"), matchedRouteIds: [app.id] };
    let finish: (page: { incidents: (typeof issue)[]; total: number }) => void = () => {};

    let refresh: (page: { incidents: (typeof issue)[]; total: number }) => void = () => {};

    let calls = 0;

    const props = inboxViewProps(
      {
        ...status,
        routes: [app, other],
        incidents: [],
        badge: { ...status.badge, count: 202 },
      },
      {
        snapshot: {
          targetsLoaded: true,
          targets: {
            projects: [
              { id: app.projectId, name: "App" },
              { id: other.projectId, name: "Other" },
            ],
            hosts: [],
          },
        },
        client: {
          listInbox: async (query) => {
            calls++;

            if (calls === 1) return { incidents: [issue], total: 1 };

            if (query.projectId === other.projectId)
              return new Promise((resolve) => {
                finish = resolve;
              });

            return new Promise((resolve) => {
              refresh = resolve;
            });
          },
        },
      },
    );

    render(<SentryView {...props} />);
    const project = screen.getByLabelText("Filter Omnyo project");
    fireEvent.change(project, { target: { value: app.projectId } });
    expect(await screen.findByText(issue.shortId)).toBeTruthy();
    fireEvent.change(project, { target: { value: other.projectId } });
    fireEvent.change(project, { target: { value: app.projectId } });
    expect(screen.getByText(issue.shortId)).toBeTruthy();
    expect(screen.getByText("1 issue in this view")).toBeTruthy();
    await act(async () => finish({ incidents: [], total: 0 }));
    expect(screen.getByText(issue.shortId)).toBeTruthy();
    const freshIssue = { ...issue, shortId: "CLIENT-502" };
    await act(async () => refresh({ incidents: [freshIssue], total: 2 }));
    expect(await screen.findByText(freshIssue.shortId)).toBeTruthy();
    expect(screen.queryByText(issue.shortId)).toBeNull();
    expect(screen.getByText("2 issues in this view")).toBeTruthy();
  });

  it.each(["add", "edit"])(
    "shows failed project choices and retries from the %s dialog",
    (mode) => {
      let loads = 0;

      const props = inboxViewProps(status, {
        snapshot: {
          targetsError: "Project choices could not load. Reopen the route editor to retry.",
        },
        client: {
          loadTargets: () => {
            loads++;
          },
        },
      });

      const page = render(<SentryView {...props} />);

      if (mode === "add") fireEvent.click(screen.getByRole("button", { name: "Add project" }));
      else {
        fireEvent.click(screen.getByRole("button", { name: "Projects" }));
        fireEvent.click(screen.getByRole("button", { name: "Edit" }));
      }

      const dialog = within(screen.getByRole("dialog"));
      expect(dialog.getByRole("alert").textContent).toBe(props.snapshot.targetsError);
      expect(loads).toBe(1);
      fireEvent.click(dialog.getByRole("button", { name: "Retry project choices" }));
      expect(loads).toBe(2);
      page.rerender(<SentryView {...props} snapshot={{ ...props.snapshot, targetsError: null }} />);
      expect(dialog.queryByRole("alert")).toBeNull();
    },
  );

  it("preserves the route's unedited watch and severity scope when saving its name", async () => {
    const mapping = { ...route(), enabled: false, watch: false, levels: ["fatal" as const] };
    const saved: Route[] = [];
    let finishSave: (saved: boolean) => void = noop;
    render(
      <SentryView
        {...inboxViewProps(
          { ...status, routes: [mapping] },
          {
            snapshot: {
              targets: {
                projects: [{ id: mapping.projectId, name: "App" }],
                hosts: [{ id: mapping.hostId, name: "Mac" }],
              },
            },
            client: {
              saveRoute: async (value) => {
                saved.push(value);

                return new Promise<boolean>((resolve) => {
                  finishSave = resolve;
                });
              },
            },
          },
        )}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed client" } });
    fireEvent.click(screen.getByRole("button", { name: "Save route" }));
    expect(screen.getByRole("button", { name: "Saving…" }).matches(":disabled")).toBe(true);
    await act(async () => finishSave(false));
    expect(screen.getByLabelText("Name")).toHaveProperty("value", "Renamed client");
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ name: "Renamed client", watch: false, levels: ["fatal"] });
    fireEvent.click(screen.getByRole("button", { name: "Save route" }));
    await act(async () => finishSave(true));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps replacement project setup open when an earlier route save finishes", async () => {
    const mapping = status.routes[0];
    let finishSave: (saved: boolean) => void = noop;
    render(
      <SentryView
        {...inboxViewProps(status, {
          snapshot: {
            targets: {
              projects: [{ id: mapping.projectId, name: "App" }],
              hosts: [{ id: mapping.hostId, name: "Mac" }],
            },
          },
          client: {
            saveRoute: () =>
              new Promise<boolean>((resolve) => {
                finishSave = resolve;
              }),
          },
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Save route" }));
    expect(screen.getByRole("button", { name: "Saving…" }).matches(":disabled")).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add project" }));
    expect(screen.getByRole("dialog", { name: "Add project" })).toBeTruthy();
    await act(async () => finishSave(true));
    expect(screen.getByRole("dialog", { name: "Add project" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText("Sentry organization"));
  });

  it("starts an issue only from the explicit solver action and scopes watch and auto controls independently", () => {
    const effects: unknown[] = [];
    render(
      <SentryView
        {...inboxViewProps(status, {
          client: {
            investigate: async (id, url) => {
              effects.push([id, url]);

              return true;
            },
            toggleRoute: async (id, enabled) => {
              effects.push([id, enabled]);

              return true;
            },
            savePolicy: async (policy) => {
              effects.push(policy);

              return true;
            },
          },
        })}
      />,
    );
    expect(effects).toEqual([]);
    expect(screen.getByText("Watch a repository in Projects to use Solve all.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start solver for CLIENT-101" }));
    expect(effects).toEqual([["client", incident().url]]);
    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    expect(screen.getByText("/projects/umbrella/client")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Watch Client" }));
    expect(effects[1]).toEqual(["client", true]);
    expect(
      screen.getByRole("switch", { name: "Auto solve for proj_app" }).getAttribute("aria-checked"),
    ).toBe("false");
    fireEvent.change(screen.getByLabelText("Daily automatic starts for proj_app"), {
      target: { value: "7" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save limit for proj_app" }));
    expect(effects[2]).toEqual({ projectId: "proj_app", autoSolve: false, dailyLimit: 7 });
  });

  it("names a deleted Omnyo project only after project choices load and blocks Solve all", () => {
    const paused = { ...status, routes: [{ ...route(), enabled: false }] };
    const view = render(<SentryView {...inboxViewProps(paused)} />);
    expect(screen.queryByText(/Deleted project/)).toBeNull();
    expect(screen.queryByText(/no longer exists/)).toBeNull();

    view.rerender(
      <SentryView
        {...inboxViewProps(paused, {
          snapshot: {
            targetsLoaded: true,
            targets: { projects: [{ id: "proj_other", name: "Other" }], hosts: [] },
          },
        })}
      />,
    );
    expect(screen.getByText(/Move its repositories in Projects/)).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Solve all for Deleted project (proj_app)" })
        .hasAttribute("disabled"),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    expect(screen.getByRole("heading", { name: "Deleted project (proj_app)" })).toBeTruthy();
    expect(screen.getByText(/This Omnyo project no longer exists/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Omnyo project" }).value).toBe(
      "",
    );
  });

  it("shows the last saved inbox at once, then replaces it with the refreshed one", async () => {
    let saved = JSON.stringify({
      version: 1,
      status: { ...status, incidents: [incident("201")] },
      targets: { projects: [{ id: "proj_app", name: "App" }], hosts: [] },
    });

    let answer = () => {};

    const gate = new Promise<void>((resolve) => {
      answer = resolve;
    });

    // SAFETY: InboxClient calls only status here and the branch returns that method's shape.
    const call = (async (method: string) => {
      if (method === "targets") return { projects: [{ id: "proj_app", name: "App" }], hosts: [] };
      await gate;

      return { ...status, incidents: [incident("202")] };
    }) as PluginRpcClient<typeof rpcContract>["call"];

    const client = new InboxClient(
      { call },
      {
        read: () => saved,
        write: (value) => {
          saved = value;
        },
      },
    );

    const first = client.getSnapshot();
    expect(first.status?.incidents.map((issue) => issue.key)).toEqual([incident("201").key]);
    expect(first.badge?.count).toBe(1);
    expect(first.targets.projects).toEqual([{ id: "proj_app", name: "App" }]);

    const refreshed = client.refresh();
    expect(client.getSnapshot().refreshing).toBe(true);
    expect(client.getSnapshot().status?.incidents).toHaveLength(1);
    answer();
    await refreshed;
    expect(client.getSnapshot().status?.incidents.map((issue) => issue.key)).toEqual([
      incident("202").key,
    ]);
    expect(saved).toContain(incident("202").key);
    expect(saved).not.toContain(incident("201").key);
  });

  it("does not queue a speculative warm read behind an existing screen read", async () => {
    let finish = () => {};

    let reads = 0;

    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });

    // SAFETY: this fixture implements the two screen RPCs and returns their exact shapes.
    const call = (async (method: string) => {
      if (method === "targets") return { projects: [], hosts: [] };
      reads++;
      await gate;

      return status;
    }) as PluginRpcClient<typeof rpcContract>["call"];

    const client = new InboxClient({ call });
    const loading = client.refresh();
    client.warm();
    finish();
    await loading;
    await Promise.resolve();
    expect(reads).toBe(1);
    client.warm();
    expect(reads).toBe(1);
  });

  it("reconnects a retained project with exactly one fresh page read", async () => {
    let reads = 0;

    let finish: (page: {
      incidents: ReturnType<typeof incident>[];
      total: number;
    }) => void = () => {};

    const props = inboxViewProps(
      { ...status, incidents: [], badge: { ...status.badge, count: 202 } },
      {
        client: {
          listInbox: async () => {
            reads++;

            if (reads === 1) return { incidents: [incident()], total: 1 };

            return new Promise((resolve) => {
              finish = resolve;
            });
          },
        },
      },
    );

    const page = render(
      <Activity mode="visible">
        <SentryView {...props} />
      </Activity>,
    );

    fireEvent.change(screen.getByLabelText("Filter Omnyo project"), {
      target: { value: "proj_app" },
    });
    expect(await screen.findByText("CLIENT-101")).toBeTruthy();
    page.rerender(
      <Activity mode="hidden">
        <SentryView {...props} />
      </Activity>,
    );
    page.rerender(
      <Activity mode="visible">
        <SentryView {...props} />
      </Activity>,
    );
    expect(screen.getByText("CLIENT-101")).toBeTruthy();
    await expect.poll(() => reads).toBe(2);
    await act(async () => finish({ incidents: [incident("102")], total: 1 }));
    expect(await screen.findByText("CLIENT-102")).toBeTruthy();
    expect(reads).toBe(2);
  });

  it("starts empty on an unreadable saved inbox", () => {
    // SAFETY: no RPC is called before the first refresh.
    const call = (async () => status) as PluginRpcClient<typeof rpcContract>["call"];

    const client = new InboxClient({ call }, { read: () => "{not json", write: noop });
    expect(client.getSnapshot().status).toBeNull();
  });

  it("saves a picked default model and sends it with the next solver start", async () => {
    const calls: Array<[string, Started | null | undefined]> = [];
    let models: ModelDefaults = builtinModelDefaults;

    // SAFETY: each branch returns the shape of the method this test calls.
    const call = (async (method: string, input?: Started | null) => {
      calls.push([method, input]);

      if (method === "targets") return { projects: [], hosts: [] };

      if (method === "models.save") {
        models = { ...models, solver: claude };

        return models;
      }

      if (method === "investigate") return run("404", route());

      return { ...status, models };
    }) as PluginRpcClient<typeof rpcContract>["call"];

    const client = new InboxClient({ call });
    await client.refresh();

    const saved: unknown[] = [];

    render(
      <SentryView
        {...inboxViewProps(client.getSnapshot().status, {
          ModelPicker: ({ value, onChange }) => (
            <button onClick={() => onChange(claude)}>{"pick " + value.model}</button>
          ),
          client: {
            saveModel: async (role, selection) => {
              saved.push([role, selection]);

              return true;
            },
          },
        })}
      />,
    );
    const solve = screen.getByRole("group", { name: "Solve" });
    expect(screen.getByRole("group", { name: "Solve all" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Review" })).toBeTruthy();
    fireEvent.click(within(solve).getByRole("button"));
    expect(saved).toEqual([["solver", claude]]);

    await client.saveModel("solver", claude);
    await client.investigate("client", incident().url);
    expect(calls.find(([method]) => method === "investigate")?.[1]).toMatchObject({
      routeId: "client",
      model: { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" },
    });
  });

  it("publishes status and project names together and retains the full screen during refresh", async () => {
    let routes = [route()];
    let projects = [{ id: "proj_app", name: "App" }];
    let targetCalls = 0;
    let gate = Promise.resolve();

    // SAFETY: each branch returns the shape of the RPC method used here.
    const call = (async (method: string) => {
      if (method === "status") return { ...status, routes };
      targetCalls++;
      const answer = { projects, hosts: [] };
      await gate;

      return answer;
    }) as PluginRpcClient<typeof rpcContract>["call"];

    const client = new InboxClient({ call });
    let open = () => {};

    gate = new Promise((resolve) => {
      open = resolve;
    });
    const cold = client.refresh();
    await Promise.resolve();
    expect(client.getSnapshot().status).toBeNull();
    open();
    await cold;
    expect(client.getSnapshot().targetsLoaded).toBe(true);
    expect(targetCalls).toBe(1);

    routes = [route(), { ...route(), id: "mobile", projectId: "proj_new" }];
    projects = [...projects, { id: "proj_new", name: "New" }];
    gate = new Promise((resolve) => {
      open = resolve;
    });
    const warm = client.refresh();
    await Promise.resolve();
    expect(client.getSnapshot().status?.routes).toHaveLength(1);
    expect(client.getSnapshot().targets.projects).toEqual([{ id: "proj_app", name: "App" }]);
    open();
    await warm;
    expect(client.getSnapshot().status?.routes).toHaveLength(2);
    expect(client.getSnapshot().targets.projects).toEqual(projects);
    expect(targetCalls).toBe(2);
  });

  it("shows a failed scan without claiming an empty healthy inbox", () => {
    render(
      <SentryView {...inboxViewProps(null, { snapshot: { error: "Sentry access is denied" } })} />,
    );
    expect(screen.getByRole("alert").textContent).toContain("Sentry access is denied");
    expect(screen.queryByText("No open issues")).toBeNull();
  });

  it("keeps repositories and investigations inside the chosen project and describes filtered emptiness", () => {
    const other = { ...route(), id: "mobile", name: "Mobile", projectId: "proj_orbit" };

    render(
      <SentryView
        {...inboxViewProps(
          { ...status, routes: [route(), other], runs: [run("201", route()), run("202", other)] },
          {
            snapshot: {
              targets: {
                projects: [
                  { id: "proj_app", name: "Nimbus" },
                  { id: "proj_orbit", name: "Orbit" },
                ],
                hosts: [],
              },
            },
          },
        )}
      />,
    );
    fireEvent.change(screen.getByLabelText("Filter Omnyo project"), {
      target: { value: "proj_orbit" },
    });
    expect(
      within(screen.getByLabelText("Filter route")).queryByRole("option", { name: "Client" }),
    ).toBeNull();
    expect(screen.getByText("No matching issues")).toBeTruthy();
    fireEvent.click(screen.getByText("Start from a Sentry issue link"));
    expect(
      within(screen.getByLabelText("Route")).queryByRole("option", { name: "Client" }),
    ).toBeNull();
    expect(screen.getByLabelText("Route")).toHaveProperty("value", "mobile");
    fireEvent.click(screen.getByRole("button", { name: "Investigations" }));
    expect(screen.queryByText("CLIENT-201")).toBeNull();
    expect(screen.getByText("CLIENT-202")).toBeTruthy();
  });

  it("filters severity, sorts issue recency, clears filters and opens safe issue details in place", () => {
    const fatal = { ...incident("102"), level: "fatal" as const, lastSeen: "2026-10-18T11:00:00Z" };
    render(<SentryView {...inboxViewProps({ ...status, incidents: [incident(), fatal] })} />);
    fireEvent.change(screen.getByLabelText("Severity"), { target: { value: "fatal" } });
    expect(screen.queryByRole("button", { name: "Start solver for CLIENT-101" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("button", { name: "Start solver for CLIENT-101" })).toBeTruthy();
    expect(screen.getAllByRole("article")[0].textContent).toContain("CLIENT-102");
    fireEvent.click(screen.getByText("CLIENT-102").closest("summary")!);
    expect(
      screen.getByRole("link", { name: "Open CLIENT-102 in Sentry" }).getAttribute("href"),
    ).toBe(fatal.url);
    expect(screen.getAllByText("Not reported").length).toBeGreaterThan(0);
  });

  it("labels a stopped investigation as interrupted and keeps Retry on a failed one", () => {
    const pausedReason = "Interrupted by a stop. Open the chat to continue it, or stop this run.";
    const retried: string[] = [];

    const paused = runSchema.parse({
      ...run("301", route()),
      threadId: "thr_paused",
      reason: pausedReason,
      interruptedAt: "2026-10-19T13:36:00Z",
    });

    const failed = runSchema.parse({
      ...run("302", route()),
      state: "failed",
      threadId: "thr_failed",
      reason:
        "Its machine was removed, so this run ended and released the execution slot. Update the route's machine before starting this issue again.",
      interruptedAt: "2026-10-19T13:36:00Z",
    });

    const workingReason = "Worker state is unavailable; ownership and source are preserved.";

    const working = runSchema.parse({
      ...run("303", route()),
      threadId: "thr_working",
      reason: workingReason,
    });

    render(
      <SentryView
        {...inboxViewProps(
          { ...status, runs: [paused, failed, working] },
          {
            client: {
              retry: async (id) => {
                retried.push(id);

                return true;
              },
            },
          },
        )}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Investigations" }));

    const pausedCard = within(screen.getByText("CLIENT-301").closest("article")!);
    expect(pausedCard.getByText("interrupted")).toBeTruthy();
    expect(pausedCard.getByText(pausedReason)).toBeTruthy();
    expect(pausedCard.getByRole("button", { name: "Open chat ↗" })).toBeTruthy();
    expect(pausedCard.getByRole("button", { name: "Stop run" })).toBeTruthy();
    expect(pausedCard.queryByRole("button", { name: "Retry" })).toBeNull();

    const failedCard = within(screen.getByText("CLIENT-302").closest("article")!);
    expect(failedCard.queryByText("interrupted")).toBeNull();
    fireEvent.click(failedCard.getByRole("button", { name: "Retry" }));
    expect(retried).toEqual(["302"]);

    const workingCard = within(screen.getByText("CLIENT-303").closest("article")!);
    expect(workingCard.getByText(workingReason)).toBeTruthy();
    expect(workingCard.queryByText("interrupted")).toBeNull();
  });
});

describe("Sentry inbox header", () => {
  const badge = (freshness: "live" | "stale" | "partial" | "unconfigured", at: string | null) => ({
    ...status,
    badge: { ...status.badge, freshness, lastSyncedAt: at },
  });

  it("states sync freshness once and keeps the issue count on the tab", () => {
    const { rerender } = render(
      <SentryView {...inboxViewProps(badge("live", "2026-10-18T10:05:00Z"))} />,
    );

    expect(screen.getByText(/^Synced /u)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Inbox" }).textContent).toBe("Inbox1");
    expect(screen.queryByText("Open issues")).toBeNull();

    rerender(<SentryView {...inboxViewProps(badge("stale", "2026-10-18T10:05:00Z"))} />);
    expect(screen.getByText(/^Sync is behind · last synced /u).className).toContain(
      "sentry-health-stale",
    );

    rerender(<SentryView {...inboxViewProps(badge("partial", null))} />);
    expect(screen.getByText("Not synced yet")).toBeTruthy();

    rerender(<SentryView {...inboxViewProps(badge("unconfigured", null))} />);
    expect(screen.queryByText(/synced/iu)).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Sentry issues" })).toBeTruthy();
  });
});

beforeEach(() => {
  const runtime = installTestPluginResourceRuntime();

  return () => {
    cleanup();
    runtime.dispose();
  };
});
