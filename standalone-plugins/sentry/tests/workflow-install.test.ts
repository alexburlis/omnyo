import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import { WorkflowInstall } from "../src/workflow-install";
import { hostContract } from "../contract";

const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const commit = "a".repeat(40);

const snapshotDigest = "d".repeat(64);

const source = "path:/owned/plugin-runtimes/sentry/" + snapshotDigest;

const target = { pluginId: "sentry", source, version: "0.2.2", snapshotDigest };

const input = { runId: "run_one", planPath: "/owned/plan.json", planDigest: "b".repeat(64) };

function fixture() {
  let installed = false;
  let lost = false;
  let absent = false;
  let calls = 0;
  let providers: string[] = [];

  const job = {
    id: "core-install-one",
    state: "running",
    target: { kind: "source", source, selection: { kind: "root" } },
  };

  const host = createFakePluginHost({
    pluginId: "sentry",
    sdk: {
      plugins: {
        list: async () => ({
          plugins: [
            {
              id: "sentry",
              status: "running",
              version: "0.2.2",
              source: installed ? source : "path:/previous",
              providerIds: providers,
            },
          ],
        }),
        getSource: async () => ({
          requested: source,
          resolved: source,
        }),
        startInstall: async (request) => {
          expect(request).toEqual({ source });
          calls++;

          if (lost) throw new Error("response lost");

          return job;
        },
        installJobs: { list: async () => (calls && !absent ? [job] : []) },
      },
    },
  });

  disposers.push(() => host.harness.lifecycle.dispose());

  const targets = {
    call: async () =>
      hostContract.workflowPluginTargets.output.parse({
        sourceCommit: commit,
        planDigest: input.planDigest,
        targets: [target],
      }),
  };

  return {
    api: host.api,
    targets,
    installer: new WorkflowInstall(host.api),
    calls: () => calls,
    install: () => {
      installed = true;
    },
    lose: () => {
      lost = true;
    },
    loseEvidence: () => {
      absent = true;
    },
    provider: () => {
      providers = ["model"];
    },
  };
}

describe("Core-owned plugin workflow installation", () => {
  it("retains one install across caller reload, then proves the exact active source", async () => {
    const f = fixture();
    expect((await f.installer.run(input, f.targets, "host_one")).status).toBe("pending");
    const reloaded = new WorkflowInstall(f.api);
    expect((await reloaded.run(input, f.targets, "host_one")).status).toBe("pending");
    expect(f.calls()).toBe(1);
    f.install();
    expect((await reloaded.run(input, f.targets, "host_one")).status).toBe("complete");
    expect((await reloaded.verifyInstalled(input, f.targets, "host_one")).status).toBe("verified");
    expect(f.calls()).toBe(1);
  });

  it("recovers a lost start response from the exact core job", async () => {
    const f = fixture();
    f.lose();
    expect((await f.installer.run(input, f.targets, "host_one")).status).toBe("pending");
    expect((await new WorkflowInstall(f.api).run(input, f.targets, "host_one")).status).toBe(
      "pending",
    );
    expect(f.calls()).toBe(1);
  });

  it("never repeats an unknown mutation after core loses its job", async () => {
    const f = fixture();
    f.lose();
    f.loseEvidence();
    expect((await f.installer.run(input, f.targets, "host_one")).status).toBe("blocked");
    expect((await new WorkflowInstall(f.api).run(input, f.targets, "host_one")).status).toBe(
      "blocked",
    );
    expect(f.calls()).toBe(1);
  });

  it("requires the pinned installed source even after publication", async () => {
    const f = fixture();
    await f.installer.run(input, f.targets, "host_one");
    expect((await f.installer.verifyInstalled(input, f.targets, "host_one")).status).toBe(
      "pending",
    );
    await expect(
      f.installer.run({ ...input, planDigest: "c".repeat(64) }, f.targets, "host_one"),
    ).rejects.toThrow("input changed");
  });

  it("leaves model-serving plugins to their independent idle owner", async () => {
    const f = fixture();
    f.provider();
    expect((await f.installer.run(input, f.targets, "host_one")).status).toBe("pending");
    expect(f.calls()).toBe(0);
  });

  it("serializes concurrent requests into one core install", async () => {
    const f = fixture();

    const outcomes = await Promise.all([
      f.installer.run(input, f.targets, "host_one"),
      f.installer.run(input, f.targets, "host_one"),
    ]);

    expect(outcomes.map((value) => value.status)).toEqual(["pending", "pending"]);
    expect(f.calls()).toBe(1);
  });
});
