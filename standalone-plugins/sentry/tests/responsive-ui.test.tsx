import { cleanup, act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@omnyo/plugin-sdk/testing/app";
import { statusSchema } from "../contract";
import { route, incident } from "./fixtures";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;

  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });

  return { promise, resolve, reject };
}

const status = statusSchema.parse({
  connected: true,
  apiOrigin: "https://de.sentry.io",
  lastError: null,
  routes: [{ ...route(), enabled: false }],
  incidents: [incident(), incident("102")],
  runs: [],
  syncs: [],
  syncing: false,
  badge: { count: 2, watchedRoutes: 1, freshness: "live", lastSyncedAt: "2026-10-18T10:05:00Z" },
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
  notificationLimit: "Uses Omnyo notification preferences",
});

afterEach(cleanup);

it("waits for complete discovery, responds per action, rolls back failures and instantly reopens a warm inbox", async () => {
  const targets = deferred<{ projects: Array<{ id: string; name: string }>; hosts: [] }>();
  const start = deferred<never>();
  const watch = deferred<never>();
  let statusResult: Promise<unknown> = Promise.resolve(status);

  const options = {
    resourceScope: {},
    rpc: {
      status: () => statusResult,
      targets: () => targets.promise,
      investigate: () => start.promise,
      "routes.enable": () => watch.promise,
    },
  };

  const app = await loadPluginApp(() => import("../app"));
  const page = app.navPanels[0];

  if (!page) throw new Error("Sentry page was not registered");
  const slot = renderSlot(page, { subPath: "" }, options);
  await act(async () => {});
  expect(screen.queryByRole("button", { name: "Start solver for CLIENT-101" })).toBeNull();
  expect(screen.getByText("Loading Sentry…")).toBeTruthy();
  await act(async () =>
    targets.resolve({ projects: [{ id: "proj_app", name: "App" }], hosts: [] }),
  );
  expect(screen.queryByRole("button", { name: "Start solver for CLIENT-101" })).not.toBeNull();
  const button = screen.getByRole("button", { name: "Start solver for CLIENT-101" });
  fireEvent.click(button);
  expect(button.textContent).toContain("Starting");
  expect(button.hasAttribute("disabled")).toBe(true);
  expect(
    screen.getByRole("button", { name: "Start solver for CLIENT-102" }).hasAttribute("disabled"),
  ).toBe(false);
  expect(screen.getByRole("button", { name: "Sync now" }).hasAttribute("disabled")).toBe(false);
  fireEvent.click(button);
  expect(slot.inspection.rpcCalls.filter(({ method }) => method === "investigate")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Projects" }));
  fireEvent.click(screen.getByRole("button", { name: "Watch Client" }));
  expect(screen.getByRole("button", { name: "Pause Client" })).toBeTruthy();
  expect(within(screen.getByRole("region", { name: "App" })).getByText("Watching")).toBeTruthy();
  // A stale refresh must not replace an in-flight optimistic setting.
  await slot.behavior.emitRealtime("changed", {});
  expect(screen.getByRole("button", { name: "Pause Client" })).toBeTruthy();
  await act(async () => {
    watch.reject(new Error("denied"));
  });
  expect(screen.getByRole("button", { name: "Watch Client" })).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("could not");
  await act(async () => {
    start.reject(new Error("offline"));
    targets.resolve({ projects: [{ id: "proj_app", name: "App" }], hosts: [] });
  });
  cleanup();
  statusResult = new Promise(() => {});
  renderSlot(page, { subPath: "" }, options);
  expect(screen.queryByText("Loading Sentry…")).toBeNull();
  expect(screen.getByRole("button", { name: "Start solver for CLIENT-102" })).toBeTruthy();
  expect(screen.getByRole("status", { name: "Inbox refresh" })).toHaveProperty(
    "textContent",
    "Refreshing…",
  );
  cleanup();
  renderSlot(page, { subPath: "" }, { ...options, resourceScope: {} });
  await act(async () => {});
  expect(screen.getByText("Loading Sentry…")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Start solver for CLIENT-102" })).toBeNull();
});
