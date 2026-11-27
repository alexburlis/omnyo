import { afterEach, expect, it } from "vitest";
import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import { z } from "zod";
import { ProjectBatches } from "../src/batches";
import { SentryRunner, missingProjectReason } from "../src/runner";
import { incident, route } from "./fixtures";

const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const connection = async () => ({
  apiOrigin: "https://de.sentry.io",
  apiToken: "fixture-non-secret",
});

function setup() {
  let spawned = 0;
  const notices: string[] = [];

  const host = createFakePluginHost({
    pluginId: "sentry",
    sdk: {
      projects: { list: () => [{ id: "proj_other", name: "Other", sources: [] }] },
      hosts: { get: () => ({ id: "host_mac", name: "Mac", status: "connected" }) },
      providers: {
        models: () => ({
          models: [{ id: "gpt-6.1-sol", supportedReasoningEfforts: [{ reasoningEffort: "max" }] }],
        }),
      },
      threads: {
        spawn: () => {
          spawned++;

          return { id: "thr_worker", environmentId: "env_worker" };
        },
      },
      plugins: {
        callRpc: (args) => {
          notices.push(z.object({ body: z.string() }).parse(args.input).body);

          return {
            id: "notice",
            status: "queued",
            duplicate: false,
            durable: true,
            acceptedTargetCount: 1,
          };
        },
      },
    },
  });

  const runner = new SentryRunner(host.api, connection);
  const batches = new ProjectBatches(runner, connection);
  runner.store.saveRoute(route());
  disposers.push(async () => {
    await batches.dispose();
    await runner.dispose();
    await host.harness.lifecycle.dispose();
  });

  return { host, runner, batches, notices, spawned: () => spawned };
}

it("reports a route whose Omnyo project was deleted as not ready", async () => {
  const { runner } = setup();
  const report = await runner.doctor("client");
  expect(report.ready).toBe(false);
  expect(report.checks).toContainEqual({
    name: "Client Omnyo project",
    ok: false,
    detail: missingProjectReason,
  });
});

it("fails a queued run for a deleted Omnyo project without spawning a worker", async () => {
  const { runner, notices, spawned } = setup();
  const queued = runner.store.enqueue(incident(), route(), false, true);
  await runner.dispatch();
  const failed = runner.store.getRun(queued.id);
  expect(failed.state).toBe("failed");
  expect(failed.reason).toContain(missingProjectReason);
  expect(failed.spawnRequestedAt ?? null).toBeNull();
  expect(spawned()).toBe(0);
  expect(notices).toEqual(["Client: its Omnyo project no longer exists"]);
  expect(runner.store.claimNext()).toBeNull();
});

it("fails Solve all for a deleted Omnyo project with the same guidance", async () => {
  const { batches, runner, spawned } = setup();
  const batch = batches.start("proj_app");
  await expect.poll(() => runner.store.getBatch(batch.id).state).toBe("failed");
  expect(runner.store.getBatch(batch.id).reason).toBe(missingProjectReason);
  expect(spawned()).toBe(0);
});

it("names the deleted Omnyo project when auto solve is refused", async () => {
  const { runner } = setup();
  await expect(
    runner.savePolicy({ projectId: "proj_app", autoSolve: true, dailyLimit: 10 }),
  ).rejects.toThrow(missingProjectReason);
});

it("names a missing model instead of a generic host/model failure", async () => {
  const { host, runner } = setup();
  host.harness.inspection.sdk.stub("providers.models", () => ({ models: [] }));
  const report = await runner.doctor("client");
  expect(report.checks).toContainEqual({
    name: "Client host/model",
    ok: false,
    detail: "This machine doesn't offer the default solver model gpt-6.1-sol right now",
  });
});
