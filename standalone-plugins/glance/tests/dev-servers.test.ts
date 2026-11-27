import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  type FakePluginHost,
} from "@omnyo/plugin-sdk/testing";
import type { PluginApi } from "@omnyo/plugin-sdk";
import { devServerShelfSchema, type DevServerRow } from "../contract.ts";
import { DevServersService } from "../lib/dev-servers.ts";
import plugin from "../server.ts";

type Preview = DevServerRow["preview"];

type Status = DevServerRow["status"];

const hosts: FakePluginHost[] = [];

function preview(id: string, createdAt: number, threadId = "thread-1"): Preview {
  return {
    id,
    threadId,
    projectId: "project-1",
    environmentId: "environment-1",
    hostId: "host-1",
    hostName: "Server computer",
    url: `http://localhost:4310/${id}?fixture=1#ready`,
    remoteUrl: `/preview/${id}/${id}?fixture=1#ready`,
    createdAt,
  };
}

function fixture(previews: Preview[]) {
  const states = new Map<string, Status["state"]>();
  const failing = new Set<string>();

  const list = vi.fn(async () => ({
    previews,
    sourceHost: { id: "host-1", name: "Server computer" },
  }));

  const status = vi.fn(async ({ previewId }: { previewId: string }): Promise<Status> => {
    if (failing.has(previewId)) throw new Error("Machine unavailable");

    return {
      state: states.get(previewId) ?? "stopped",
      checkedAt: Date.now(),
      detail: null,
      runId: null,
    };
  });

  const restart = vi.fn(
    async ({
      previewId,
    }: Parameters<PluginApi["sdk"]["previews"]["restart"]>[0]): Promise<Status> => {
      states.set(previewId, "online");

      return { state: "online", checkedAt: Date.now(), detail: null, runId: "run-1" };
    },
  );

  const host = createFakePluginHost({
    pluginId: "glance",
    sdk: { previews: { list, status, restart } },
  });

  hosts.push(host);
  plugin(host.api);
  const service = new DevServersService(host.api);

  return { host, service, states, failing, list, status, restart };
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.dispose();
  vi.restoreAllMocks();
});

describe("Dev server shelf", () => {
  it("lists every active server and only the latest saved inactive server in the exact chat through RPC and CLI", async () => {
    vi.spyOn(Date, "now").mockReturnValue(100000);

    const test = fixture([
      preview("online", 1),
      preview("starting", 2),
      preview("old", 3),
      preview("saved", 4),
      preview("foreign", 5, "other-chat"),
    ]);

    test.states.set("online", "online");
    test.states.set("starting", "starting");

    const result = devServerShelfSchema.parse(
      await test.host.harness.callRpc("servers.read", { threadId: "thread-1" }),
    );

    expect(result.active.map((row) => row.preview.id)).toEqual(["online", "starting"]);
    expect(result.recent).toMatchObject({ preview: { id: "saved" }, lastObservedOnlineAt: null });
    expect(test.status.mock.calls.map(([input]) => input.previewId)).not.toContain("foreign");
    const cli = await test.host.harness.runCli(["servers", "thread-1", "--json"]);
    expect(cli.exitCode).toBe(0);
    expect(devServerShelfSchema.parse(JSON.parse(cli.stdout))).toEqual(result);
  });

  it("remembers and restarts a reused workspace recipe without changing its original chat", async () => {
    vi.spyOn(Date, "now").mockReturnValue(100000);
    const shared = preview("shared", 1, "other-chat");
    const test = fixture([shared, preview("owned", 2), preview("unrelated", 3, "third-chat")]);
    const before = await test.service.read("thread-1");
    expect(before.recent?.preview.id).toBe("owned");

    const remembered = devServerShelfSchema.parse(
      await test.host.harness.callRpc("servers.remember", {
        threadId: "thread-1",
        previewId: "shared",
      }),
    );

    expect(remembered.recent).toMatchObject({
      preview: { id: "shared", threadId: "other-chat" },
      lastObservedOnlineAt: null,
    });
    expect(shared.threadId).toBe("other-chat");
    expect(test.status.mock.calls.map(([input]) => input.previewId)).not.toContain("unrelated");

    const reloaded = new DevServersService(test.host.api);

    const started = await reloaded.restart({
      threadId: "thread-1",
      previewId: "shared",
      requestId: "shared-request",
    });

    expect(started.active).toMatchObject([{ preview: { id: "shared", threadId: "other-chat" } }]);
    expect(test.restart).toHaveBeenCalledWith({ previewId: "shared", requestId: "shared-request" });
  });

  it("remembers via CLI and preserves online history when the saved recipe is remembered again", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(100000);
    const test = fixture([preview("shared", 1, "other-chat")]);
    test.states.set("shared", "online");

    const cli = await test.host.harness.runCli([
      "servers",
      "thread-1",
      "--remember",
      "shared",
      "--json",
    ]);

    expect(cli.exitCode).toBe(0);
    expect(devServerShelfSchema.parse(JSON.parse(cli.stdout)).active[0]).toMatchObject({
      preview: { id: "shared" },
      lastObservedOnlineAt: 100000,
    });

    now.mockReturnValue(200000);
    test.states.set("shared", "stopped");
    const remembered = await test.service.remember({ threadId: "thread-1", previewId: "shared" });
    expect(remembered.recent).toMatchObject({
      preview: { id: "shared" },
      lastObservedOnlineAt: 100000,
    });
  });

  it("rejects remembering or restarting a recipe outside the selected workspace", async () => {
    const test = fixture([preview("owned", 1)]);
    await expect(
      test.service.remember({ threadId: "thread-1", previewId: "foreign-workspace" }),
    ).rejects.toThrow("does not belong to this chat's workspace");
    await expect(
      test.service.restart({
        threadId: "thread-1",
        previewId: "foreign-workspace",
        requestId: "foreign-request",
      }),
    ).rejects.toThrow("does not belong to this chat");
    expect(test.restart).not.toHaveBeenCalled();
    expect(
      test.host.api.storage
        .database()
        .prepare("SELECT count(*) AS count FROM dev_server_activity WHERE thread_id = ?")
        .get("thread-1"),
    ).toEqual({ count: 0 });
  });

  it("retains an older recipe most recently online after service reconstruction and stopping", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(100000);
    const test = fixture([preview("older", 1), preview("newer", 2)]);
    test.states.set("newer", "online");
    await test.service.read("thread-1");
    now.mockReturnValue(200000);
    test.states.set("newer", "stopped");
    test.states.set("older", "online");
    await test.service.read("thread-1");
    test.states.set("older", "stopped");
    const reloaded = new DevServersService(test.host.api);
    expect((await reloaded.read("thread-1")).recent).toMatchObject({
      preview: { id: "older" },
      status: { state: "stopped" },
      lastObservedOnlineAt: 200000,
    });
  });

  it("uses one observation time and stable creation order rather than probe latency", async () => {
    let now = 100000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const test = fixture([preview("older", 1), preview("newer", 2)]);
    test.status.mockImplementation(async () => {
      now += 100;

      return { state: "online", checkedAt: now, detail: null, runId: null };
    });
    const result = await test.service.read("thread-1");
    expect(result.active.map((row) => [row.preview.id, row.lastObservedOnlineAt])).toEqual([
      ["newer", 100000],
      ["older", 100000],
    ]);
  });

  it("validates restart ownership and forwards the idempotency key while preserving URL suffixes", async () => {
    const test = fixture([preview("owned", 1), preview("foreign", 2, "other-chat")]);
    await expect(
      test.service.restart({ threadId: "thread-1", previewId: "foreign", requestId: "request-1" }),
    ).rejects.toThrow("does not belong to this chat");
    expect(test.restart).not.toHaveBeenCalled();

    const result = devServerShelfSchema.parse(
      await test.host.harness.callRpc("servers.restart", {
        threadId: "thread-1",
        previewId: "owned",
        requestId: "request-1",
      }),
    );

    expect(test.restart).toHaveBeenCalledWith({ previewId: "owned", requestId: "request-1" });
    expect(result.active[0]).toMatchObject({
      preview: {
        url: "http://localhost:4310/owned?fixture=1#ready",
        remoteUrl: "/preview/owned/owned?fixture=1#ready",
      },
      status: { state: "online" },
    });
  });

  it.each(["host-offline", "conflict", "unknown", "error"] as const)(
    "preserves the remembered row with its real %s state",
    async (state) => {
      const test = fixture([preview("owned", 1)]);
      test.states.set("owned", "online");
      await test.service.read("thread-1");
      test.states.set("owned", state);
      const result = await test.service.read("thread-1");
      expect(result.active).toEqual([]);
      expect(result.recent).toMatchObject({
        preview: { id: "owned" },
        status: { state },
        lastObservedOnlineAt: expect.any(Number),
      });
    },
  );

  it("shares concurrent reads and replaces a failed readiness probe with unknown", async () => {
    const test = fixture([preview("owned", 1)]);
    test.failing.add("owned");

    const [first, second] = await Promise.all([
      test.service.read("thread-1"),
      test.service.read("thread-1"),
    ]);

    expect(test.list).toHaveBeenCalledTimes(1);
    expect(test.status).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.recent).toMatchObject({
      status: { state: "unknown", detail: "Could not check this server" },
      lastObservedOnlineAt: null,
    });
  });

  it("rejects stale online evidence without recording it as active", async () => {
    const test = fixture([preview("owned", 1)]);
    test.status.mockImplementation(async () => ({
      state: "online",
      checkedAt: Date.now() - 16000,
      detail: null,
      runId: null,
    }));
    const result = await test.service.read("thread-1");
    expect(result.active).toEqual([]);
    expect(result.recent).toMatchObject({
      status: { state: "unknown" },
      lastObservedOnlineAt: null,
    });
  });

  it("clears activity on chat deletion and rejects its in-flight observations", async () => {
    const test = fixture([preview("owned", 1)]);
    test.states.set("owned", "online");
    await test.service.read("thread-1");
    let finish: (status: Status) => void = () => {};

    test.status.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = test.service.read("thread-1");
    await vi.waitFor(() => expect(test.status).toHaveBeenCalledTimes(2));
    await test.host.harness.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({ id: "thread-1" }),
    });
    finish({ state: "online", checkedAt: Date.now(), detail: null, runId: null });
    await expect(pending).rejects.toThrow("This chat was deleted");
    expect(
      test.host.api.storage
        .database()
        .prepare("SELECT count(*) AS count FROM dev_server_activity WHERE thread_id = ?")
        .get("thread-1"),
    ).toEqual({ count: 0 });
  });
});
